"""
Ingest ICE end-of-day settlement files into daily_obs.

ICE publishes EOD data T+1 morning. knowledge_date = next business day
after trade_date. All downstream queries must filter on knowledge_date.

Rate-space convention: Delta_r(t) = -Delta_p(t).
settlement_price stored as price (100 - rate); rate = 100 - settlement_price.
"""

import csv
import datetime
import io
import sqlite3
from pathlib import Path

from .db import connect, next_business_day, get_db_path, load_params
from .contract_calendar import make_contract_id


# -- Column name aliases (case-insensitive) -----------------------------------

_COL_ALIASES = {
    "settlement": "settlement_price",
    "close":      "settlement_price",   # fallback if settlement absent
    "settlementprice": "settlement_price",
    "openinterest": "open_interest",
    "open_interest": "open_interest",
    "oi": "open_interest",
    "volume": "volume",
    "vol": "volume",
    "vwap": "vwap",
    "openprice": "open_price",
    "open": "open_price",
    "contract": "raw_contract",
    "strip": "raw_contract",
    "product": "root",
}


def _normalise_header(raw: list[str]) -> list[str]:
    return [_COL_ALIASES.get(h.strip().lower().replace(" ", ""), h.strip().lower()) for h in raw]


def _sniff_delimiter(sample: str) -> str:
    for delim in ("|", ",", "\t", ";"):
        if sample.count(delim) >= 3:
            return delim
    return ","


def _parse_ice_contract(raw: str, root: str) -> str | None:
    """
    Convert ICE raw contract label to canonical contract_id.
    Handles formats like:
      "Mar27", "MAR 2027", "2027H", "ERH27", "FEI Mar 2027"
    Returns None if unparseable.
    """
    raw = raw.strip().upper()
    # Already canonical
    if "_" in raw and len(raw) == 8:
        return raw

    month_abbr = {
        "JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
        "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12,
    }
    code_map = {"H": 3, "M": 6, "U": 9, "Z": 12,
                "F": 1, "G": 2, "J": 4, "K": 5,
                "N": 7, "Q": 8, "V": 10, "X": 11}

    # Pattern: "MAR2027" or "MAR 2027"
    import re
    m = re.match(r"([A-Z]{3})\s*(\d{2,4})", raw)
    if m:
        abbr, yr = m.group(1), m.group(2)
        if abbr in month_abbr:
            month = month_abbr[abbr]
            year = int(yr) if len(yr) == 4 else 2000 + int(yr)
            return make_contract_id(root, year, month)

    # Pattern: "2027H" or code at end like "ERH27"
    m = re.search(r"([FGHJKMNQUVXZ])(\d{2,4})$", raw)
    if m:
        code, yr = m.group(1), m.group(2)
        if code in code_map:
            year = int(yr) if len(yr) == 4 else 2000 + int(yr)
            return make_contract_id(root, year, code_map[code])

    return None


def ingest_eod_file(
    filepath: str | Path,
    trade_date: datetime.date | str,
    root: str | None = None,
    db_path: str | Path | None = None,
    params: dict | None = None,
) -> dict:
    """
    Parse an ICE EOD file and insert rows into daily_obs.

    Args:
        filepath:   Path to ICE EOD CSV/pipe-delimited file.
        trade_date: The session date the file describes.
        root:       Contract root override (e.g. "FEI"). Auto-detected if None.
        db_path:    SQLite database path. Uses params.yaml default if None.

    Returns:
        dict with keys: inserted, updated, skipped, errors
    """
    if params is None:
        params = load_params()
    if db_path is None:
        db_path = get_db_path(params)
    if isinstance(trade_date, str):
        trade_date = datetime.date.fromisoformat(trade_date)

    knowledge_date = next_business_day(trade_date)
    if root is None:
        root = params["contracts"]["euribor_root"]

    text = Path(filepath).read_text()
    delim = _sniff_delimiter(text.splitlines()[0] if text else ",")
    reader = csv.DictReader(io.StringIO(text), delimiter=delim)
    raw_headers = reader.fieldnames or []
    # Build remapped reader
    norm_headers = _normalise_header(raw_headers)

    stats = {"inserted": 0, "updated": 0, "skipped": 0, "errors": []}

    with connect(db_path) as conn:
        for raw_row in reader:
            # Remap keys
            row = {norm_headers[i]: v for i, v in enumerate(raw_row.values())}

            # Identify contract
            raw_contract = row.get("raw_contract", "")
            if not raw_contract:
                stats["skipped"] += 1
                continue

            contract_id = _parse_ice_contract(raw_contract, root)
            if contract_id is None:
                stats["errors"].append(f"Cannot parse contract: {raw_contract!r}")
                stats["skipped"] += 1
                continue

            try:
                settlement_price = float(row["settlement_price"])
                open_interest = int(float(row.get("open_interest", 0) or 0))
                volume = int(float(row.get("volume", 0) or 0))
                vwap = float(row["vwap"]) if row.get("vwap") else None
                open_price = float(row["open_price"]) if row.get("open_price") else None
            except (KeyError, ValueError) as e:
                stats["errors"].append(f"{contract_id}: {e}")
                stats["skipped"] += 1
                continue

            # §4.8 check 1 -- fail loudly at ingestion
            doi_prev = _get_prev_oi(conn, contract_id, trade_date)
            if doi_prev is not None:
                delta_oi = abs(open_interest - doi_prev)
                if delta_oi > volume:
                    raise ValueError(
                        f"Integrity violation §4.8: |DeltaOI|={delta_oi} > volume={volume} "
                        f"for {contract_id} on {trade_date}. "
                        "Vendor error or mis-stitched roll data."
                    )

            # §4.8 check 4 -- settlement must be present when OI > 0
            if open_interest > 0 and settlement_price is None:
                raise ValueError(
                    f"Integrity violation §4.8: settlement_price missing for {contract_id} "
                    f"on {trade_date} (OI={open_interest})"
                )

            # Upsert
            existing = conn.execute(
                "SELECT settlement_price FROM daily_obs WHERE contract_id=? AND trade_date=?",
                (contract_id, trade_date.isoformat()),
            ).fetchone()

            if existing is None:
                conn.execute(
                    """INSERT INTO daily_obs
                       (contract_id, trade_date, knowledge_date, settlement_price,
                        open_interest, volume, vwap, open_price)
                       VALUES (?,?,?,?,?,?,?,?)""",
                    (contract_id, trade_date.isoformat(), knowledge_date.isoformat(),
                     settlement_price, open_interest, volume, vwap, open_price),
                )
                stats["inserted"] += 1
            else:
                # Revision: log old value, update main table
                prev = conn.execute(
                    "SELECT * FROM daily_obs WHERE contract_id=? AND trade_date=?",
                    (contract_id, trade_date.isoformat()),
                ).fetchone()
                max_seq = conn.execute(
                    "SELECT COALESCE(MAX(revision_seq),0) FROM daily_obs_revisions "
                    "WHERE contract_id=? AND trade_date=?",
                    (contract_id, trade_date.isoformat()),
                ).fetchone()[0]
                conn.execute(
                    """INSERT INTO daily_obs_revisions
                       (contract_id, trade_date, knowledge_date, settlement_price,
                        open_interest, volume, vwap, open_price, revision_seq)
                       VALUES (?,?,?,?,?,?,?,?,?)""",
                    (contract_id, trade_date.isoformat(), prev["knowledge_date"],
                     prev["settlement_price"], prev["open_interest"], prev["volume"],
                     prev["vwap"], prev["open_price"], max_seq + 1),
                )
                conn.execute(
                    """UPDATE daily_obs SET
                       settlement_price=?, open_interest=?, volume=?,
                       vwap=?, open_price=?, revised_at=datetime('now')
                       WHERE contract_id=? AND trade_date=?""",
                    (settlement_price, open_interest, volume, vwap, open_price,
                     contract_id, trade_date.isoformat()),
                )
                stats["updated"] += 1

    return stats


def _get_prev_oi(conn: sqlite3.Connection, contract_id: str, trade_date: datetime.date) -> int | None:
    """Return OI for contract_id on the most recent trade_date before given date."""
    row = conn.execute(
        """SELECT open_interest FROM daily_obs
           WHERE contract_id=? AND trade_date < ?
           ORDER BY trade_date DESC LIMIT 1""",
        (contract_id, trade_date.isoformat()),
    ).fetchone()
    return row[0] if row else None


def simulate_eod_data(
    start_date: datetime.date,
    end_date: datetime.date,
    contracts: list[dict],
    params: dict,
    db_path: str | Path | None = None,
    seed: int = 42,
) -> None:
    """
    Generate and insert realistic synthetic Euribor EOD data for testing.
    Simulates 8 quarterly contracts (whites through greens) with realistic
    OI build profiles and price dynamics.
    """
    import numpy as np

    rng = np.random.default_rng(seed)
    if db_path is None:
        db_path = get_db_path(params)

    # Filter to quarterly contracts only, sort by expiry
    quarterly = sorted(
        [c for c in contracts if c["contract_type"] == "quarterly"],
        key=lambda c: c["expiry_date"],
    )[:12]  # up to 12 contracts active at once

    # Simulate an underlying short-rate process
    n_days = (end_date - start_date).days + 1
    dates = [start_date + datetime.timedelta(days=i) for i in range(n_days)]
    dates = [d for d in dates if d.weekday() < 5]  # business days only

    # Base rate level (Euribor, starting ~3.5%, mean-reverting)
    base_rate = 3.50
    rate_path = [base_rate]
    for _ in range(len(dates) - 1):
        shock = rng.normal(0, 0.04)
        mr = -0.02 * (rate_path[-1] - base_rate)
        rate_path.append(max(0.0, rate_path[-1] + mr + shock))

    with connect(db_path) as conn:
        for ci, contract in enumerate(quarterly):
            exp = datetime.date.fromisoformat(contract["expiry_date"])

            # Track cumulative OI for this contract so ΔOI is always bounded by volume
            prev_oi = 0

            for di, d in enumerate(dates):
                if d > exp:
                    break

                days_to_exp = (exp - d).days
                oi_scale = min(1.0, days_to_exp / 180) * (1 - ci * 0.08)
                base_oi = int(max(0, 200_000 * oi_scale * (1 + 0.3 * rng.standard_normal())))

                # price = 100 - rate + tenor spread
                tenor_spread = ci * 0.05
                price = 100.0 - rate_path[di] - tenor_spread + rng.normal(0, 0.005)
                price = round(price, 3)

                # Volume must be at least as large as |ΔOI|
                # First compute a target OI, then set volume >= |ΔOI|
                target_doi = int(rng.normal(0, max(1, base_oi * 0.05)))
                target_oi = max(0, prev_oi + target_doi)
                actual_doi = target_oi - prev_oi

                # Volume must cover |ΔOI| and be realistic
                min_vol = abs(actual_doi) + 100
                vol = int(max(min_vol, abs(rng.normal(max(base_oi * 0.15, 1000), max(base_oi * 0.05, 200)))))

                vwap = price + rng.normal(0, 0.002)
                knowledge_date = next_business_day(d)

                conn.execute(
                    """INSERT OR REPLACE INTO daily_obs
                       (contract_id, trade_date, knowledge_date, settlement_price,
                        open_interest, volume, vwap, open_price)
                       VALUES (?,?,?,?,?,?,?,?)""",
                    (contract["contract_id"], d.isoformat(), knowledge_date.isoformat(),
                     price, target_oi, vol, round(vwap, 3), None),
                )
                prev_oi = target_oi
