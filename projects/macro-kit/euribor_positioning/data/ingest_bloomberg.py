"""
Bloomberg EOD ingestor for Euribor (and €STR) futures.

Replaces the ICE flat-file ingestor (ingest_ice_eod.py) when Bloomberg Terminal
data is the primary source.  Fetches settlement, OI, volume, VWAP and open price
via bbg.bdh() and upserts into daily_obs with the same §4.8 checks.

Bloomberg ticker format (configurable via params.yaml bloomberg section):
  {bbg_root}{IMM_code}{2-digit-year} {yellow_key}
  e.g.  ERH25 Comdty   = Euribor March 2025

Knowledge-date discipline: knowledge_date = next_business_day(trade_date),
identical to the ICE ingestor — Bloomberg data is only available T+1.

Usage (CLI):
    euribor-positioning ingest-bloomberg --trade-date 2025-06-30

Usage (Python):
    from euribor_positioning.data.ingest_bloomberg import ingest_bloomberg_eod
    stats = ingest_bloomberg_eod(datetime.date(2025, 6, 30))
"""

from __future__ import annotations

import datetime
import sys
import warnings
from pathlib import Path
from typing import Optional

import pandas as pd

# ── Path setup: reuse bbg.py from macro-kit backend ─────────────────────────
# Same pattern as euribor_positioning_router.py
_BACKEND = Path(__file__).parent.parent.parent / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from .db import connect, next_business_day, get_db_path, load_params
from .contract_calendar import make_contract_id, CODE_TO_MONTH

# Bloomberg fields requested in every BDH call
_BBG_FIELDS = ["PX_LAST", "OPEN_INT", "PX_VOLUME", "PX_VWAP", "PX_OPEN"]


# ---------------------------------------------------------------------------
# Ticker conversion helpers
# ---------------------------------------------------------------------------

def bbg_ticker(contract_id: str, params: dict) -> str:
    """
    Convert internal contract_id to Bloomberg ticker.

    "FEI_2025H"  →  "ERH25 Comdty"
    "FSO_2025H"  →  "SR3H25 Comdty"

    Looks up params["instruments"] registry first; falls back to params["bloomberg"]
    legacy keys for Euribor/ESTR.
    """
    bbg_cfg    = params.get("bloomberg", {})
    yellow_key = bbg_cfg.get("bbg_yellow_key", "Comdty")

    # Build root → bbg_root map from instrument registry
    root_to_bbg: dict[str, str] = {}
    for cfg in params.get("instruments", {}).values():
        bbg_r = cfg.get("bbg_root", "")
        for r in cfg.get("roots", []):
            root_to_bbg[r] = bbg_r

    # Legacy fallback (Euribor / ESTR)
    if not root_to_bbg:
        int_euribor = params["contracts"].get("euribor_root", "FEI")
        int_estr    = params["contracts"].get("estr_root",    "FEF")
        root_to_bbg[int_euribor] = bbg_cfg.get("euribor_bbg_root", "ER")
        root_to_bbg[int_estr]    = bbg_cfg.get("estr_bbg_root",    "ERS")

    # Parse "FEI_2025H"
    try:
        root_part, year_code = contract_id.split("_", 1)  # "FEI", "2025H"
        full_year = int(year_code[:4])                     # 2025
        imm_code  = year_code[4]                           # "H"
    except (ValueError, IndexError) as exc:
        raise ValueError(f"Cannot parse contract_id {contract_id!r}: {exc}") from exc

    bbg_root = root_to_bbg.get(root_part)
    if bbg_root is None:
        raise ValueError(
            f"Unknown contract root {root_part!r} in {contract_id!r}. "
            f"Known roots: {list(root_to_bbg.keys())}"
        )

    year_2d = str(full_year)[-2:]          # "25"
    return f"{bbg_root}{imm_code}{year_2d} {yellow_key}"


def contract_id_from_bbg_ticker(ticker: str, params: dict) -> Optional[str]:
    """
    Reverse of bbg_ticker(): Bloomberg ticker → internal contract_id.

    "ERH25 Comdty"  →  "FEI_2025H"
    "SR3H25 Comdty" →  "FSO_2025H"

    Returns None if the ticker cannot be parsed.
    """
    bbg_cfg = params.get("bloomberg", {})

    # Build bbg_root → internal_root map from instrument registry
    # Sort longest prefix first so "ERS" matches before "ER"
    bbg_to_int: dict[str, str] = {}
    for cfg in params.get("instruments", {}).values():
        bbg_r = cfg.get("bbg_root", "").upper()
        roots = cfg.get("roots", [])
        if bbg_r and roots:
            bbg_to_int[bbg_r] = roots[0]  # first root is canonical

    # Legacy fallback
    if not bbg_to_int:
        bbg_to_int[bbg_cfg.get("euribor_bbg_root", "ER").upper()] = params["contracts"].get("euribor_root", "FEI")
        bbg_to_int[bbg_cfg.get("estr_bbg_root", "ERS").upper()]   = params["contracts"].get("estr_root",    "FEF")

    # Strip yellow key ("ERH25 Comdty" → "ERH25")
    ticker_clean = ticker.split()[0].upper()

    # Try longest prefix first
    int_root: Optional[str] = None
    suffix:   str            = ""
    for bbg_root in sorted(bbg_to_int.keys(), key=len, reverse=True):
        if ticker_clean.startswith(bbg_root):
            int_root = bbg_to_int[bbg_root]
            suffix   = ticker_clean[len(bbg_root):]
            break

    if int_root is None:
        return None

    if len(suffix) < 2:
        return None

    imm_code = suffix[0]      # "H"
    year_2d  = suffix[1:]     # "25"

    if not year_2d.isdigit():
        return None

    # Bloomberg 2-digit year convention: 00–99 → 2000–2099
    full_year = 2000 + int(year_2d)

    month_num = CODE_TO_MONTH.get(imm_code)
    if month_num is None:
        return None

    return make_contract_id(int_root, full_year, month_num)


# ---------------------------------------------------------------------------
# Active contract lookup
# ---------------------------------------------------------------------------

def _get_active_contracts(conn, trade_date: datetime.date) -> list[dict]:
    """
    Return contracts that are not expired as of trade_date and (if listing_date
    is set) have already been listed.
    """
    rows = conn.execute(
        """
        SELECT contract_id, root, expiry_date, contract_type
        FROM contracts
        WHERE expiry_date >= ?
          AND (listing_date IS NULL OR listing_date <= ?)
        ORDER BY expiry_date
        """,
        (trade_date.isoformat(), trade_date.isoformat()),
    ).fetchall()
    return [dict(r) for r in rows]


def _get_prev_oi(conn, contract_id: str, trade_date: datetime.date) -> Optional[int]:
    row = conn.execute(
        """SELECT open_interest FROM daily_obs
           WHERE contract_id=? AND trade_date < ?
           ORDER BY trade_date DESC LIMIT 1""",
        (contract_id, trade_date.isoformat()),
    ).fetchone()
    return row[0] if row else None


# ---------------------------------------------------------------------------
# Main ingest function
# ---------------------------------------------------------------------------

def ingest_bloomberg_eod(
    trade_date: datetime.date | str,
    db_path=None,
    params: dict | None = None,
    contracts: list[dict] | None = None,
) -> dict:
    """
    Fetch EOD data from Bloomberg for all active Euribor (and €STR) contracts
    on trade_date and upsert into daily_obs.

    Args:
        trade_date : The session date to fetch (YYYY-MM-DD or datetime.date).
        db_path    : SQLite database path. Defaults to params.yaml setting.
        params     : Parameter dict. Loads from params.yaml if None.
        contracts  : Explicit list of contract dicts (from contracts table).
                     If None, queries the DB for all contracts not yet expired.

    Returns:
        dict with keys: inserted, updated, skipped, errors

    Raises:
        ImportError  : blpapi is not installed or Bloomberg Terminal is not running.
        ValueError   : §4.8 integrity violation (|ΔOI| > volume).
    """
    if params is None:
        params = load_params()
    if db_path is None:
        db_path = get_db_path(params)
    if isinstance(trade_date, str):
        trade_date = datetime.date.fromisoformat(trade_date)

    knowledge_date = next_business_day(trade_date)

    # Bloomberg Terminal access via backend/bbg.py
    try:
        from bbg import blp  # noqa: F401 — imported here to surface ImportError early
    except ImportError as exc:
        raise ImportError(
            "blpapi is not installed or Bloomberg Terminal is not running.\n"
            "Install the Bloomberg API Python SDK: pip install blpapi\n"
            "Bloomberg Terminal (or B-PIPE/SAPI) must be running on localhost:8194."
        ) from exc

    stats: dict = {"inserted": 0, "updated": 0, "skipped": 0, "errors": []}

    with connect(db_path) as conn:
        if contracts is None:
            contracts = _get_active_contracts(conn, trade_date)

        if not contracts:
            stats["errors"].append(f"No active contracts in DB for {trade_date}")
            return stats

        # Build ticker ↔ contract_id lookup
        ticker_to_cid: dict[str, str] = {}
        for c in contracts:
            try:
                ticker = bbg_ticker(c["contract_id"], params)
                ticker_to_cid[ticker] = c["contract_id"]
            except ValueError as exc:
                stats["errors"].append(str(exc))
                stats["skipped"] += 1

        if not ticker_to_cid:
            return stats

        date_str = trade_date.isoformat()

        # Single BDH call for all tickers
        try:
            df = blp.bdh(
                tickers=list(ticker_to_cid.keys()),
                flds=_BBG_FIELDS,
                start_date=date_str,
                end_date=date_str,
            )
        except Exception as exc:
            stats["errors"].append(f"Bloomberg BDH failed: {exc}")
            return stats

        if df.empty:
            stats["errors"].append(f"Bloomberg returned empty response for {trade_date}")
            return stats

        ts_index = pd.Timestamp(trade_date)

        for ticker, cid in ticker_to_cid.items():
            # ── Extract fields from multi-index DataFrame ──────────────────
            try:
                def _get(fld):
                    if isinstance(df.columns, pd.MultiIndex):
                        key = (ticker, fld)
                        if key not in df.columns:
                            return None
                        row = df.loc[ts_index, key] if ts_index in df.index else None
                    else:
                        if ticker not in df.columns:
                            return None
                        row = df.loc[ts_index, ticker] if ts_index in df.index else None
                    return None if (row is None or (isinstance(row, float) and pd.isna(row))) else row

                px_last   = _get("PX_LAST")
                open_int  = _get("OPEN_INT")
                px_vol    = _get("PX_VOLUME")
                px_vwap   = _get("PX_VWAP")
                px_open   = _get("PX_OPEN")

            except (KeyError, TypeError) as exc:
                stats["errors"].append(f"{cid}: field extraction error: {exc}")
                stats["skipped"] += 1
                continue

            if px_last is None:
                # Contract not traded today (no settlement) — skip silently
                stats["skipped"] += 1
                continue

            try:
                settlement_price = float(px_last)
                open_interest    = int(float(open_int or 0))
                volume           = int(float(px_vol   or 0))
                vwap             = float(px_vwap)  if px_vwap  is not None else None
                open_price       = float(px_open)  if px_open  is not None else None
            except (TypeError, ValueError) as exc:
                stats["errors"].append(f"{cid}: type conversion error: {exc}")
                stats["skipped"] += 1
                continue

            # ── §4.8 check 1: |ΔOI| ≤ volume ─────────────────────────────
            prev_oi = _get_prev_oi(conn, cid, trade_date)
            if prev_oi is not None:
                delta_oi = abs(open_interest - prev_oi)
                if delta_oi > volume:
                    raise ValueError(
                        f"Integrity violation §4.8: |ΔOI|={delta_oi} > volume={volume} "
                        f"for {cid} on {trade_date}. Check Bloomberg data quality."
                    )

            # ── §4.8 check 4: settlement present when OI > 0 ──────────────
            if open_interest > 0 and pd.isna(settlement_price):
                raise ValueError(
                    f"Integrity violation §4.8: settlement_price missing for "
                    f"{cid} on {trade_date} (OI={open_interest})"
                )

            # ── Upsert ────────────────────────────────────────────────────
            existing = conn.execute(
                "SELECT settlement_price FROM daily_obs "
                "WHERE contract_id=? AND trade_date=?",
                (cid, date_str),
            ).fetchone()

            if existing is None:
                conn.execute(
                    """INSERT INTO daily_obs
                       (contract_id, trade_date, knowledge_date, settlement_price,
                        open_interest, volume, vwap, open_price)
                       VALUES (?,?,?,?,?,?,?,?)""",
                    (cid, date_str, knowledge_date.isoformat(),
                     settlement_price, open_interest, volume, vwap, open_price),
                )
                stats["inserted"] += 1
            else:
                # Revision: log old values, update main table
                prev_row = conn.execute(
                    "SELECT * FROM daily_obs WHERE contract_id=? AND trade_date=?",
                    (cid, date_str),
                ).fetchone()
                max_seq = conn.execute(
                    "SELECT COALESCE(MAX(revision_seq),0) FROM daily_obs_revisions "
                    "WHERE contract_id=? AND trade_date=?",
                    (cid, date_str),
                ).fetchone()[0]
                conn.execute(
                    """INSERT INTO daily_obs_revisions
                       (contract_id, trade_date, knowledge_date, settlement_price,
                        open_interest, volume, vwap, open_price, revision_seq)
                       VALUES (?,?,?,?,?,?,?,?,?)""",
                    (cid, date_str, prev_row["knowledge_date"],
                     prev_row["settlement_price"], prev_row["open_interest"],
                     prev_row["volume"], prev_row["vwap"], prev_row["open_price"],
                     max_seq + 1),
                )
                conn.execute(
                    """UPDATE daily_obs SET
                       settlement_price=?, open_interest=?, volume=?,
                       vwap=?, open_price=?, revised_at=datetime('now')
                       WHERE contract_id=? AND trade_date=?""",
                    (settlement_price, open_interest, volume, vwap, open_price,
                     cid, date_str),
                )
                stats["updated"] += 1

    return stats
