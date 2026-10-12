"""
Stage 2 — Contract calendar and fixed-contract ΔOI (§6.1).

Provides:
  - compute_doi          : fixed-contract ΔOI query layer (§6.1.2)
  - assign_pack          : desk-facing pack labels (§6.1.3)
  - assign_ttm_bucket    : TTM bucket for regression/z-scoring (§6.1.3)
  - imm_roll_dates       : list of IMM roll dates in a date range
  - build_daily_summary  : per-contract enriched snapshot for a trade_date
  - complex_dv01_total   : scalar total DV01 for a trade_date

Serials (§6.1.4):
  - Serials are assigned a TTM bucket based on their expiry_date.
  - They do NOT count toward pack rank (pack=None for serials).

All numeric constants come from params; no magic numbers in this module.
"""

from __future__ import annotations

import datetime
from typing import Any

from ..data.db import connect
from ..data.contract_calendar import generate_contracts  # noqa: F401 (re-export for tests)


# ---------------------------------------------------------------------------
# §6.1.3 — Tenor bucketing helpers
# ---------------------------------------------------------------------------

def assign_pack(rank: int) -> str:
    """
    Map quarterly generic rank → pack label.
    rank 1-4   → "whites"
    rank 5-8   → "reds"
    rank 9-12  → "greens"
    rank 13-16 → "blues"
    rank 17+   → "ultra"
    """
    if rank <= 4:
        return "whites"
    if rank <= 8:
        return "reds"
    if rank <= 12:
        return "greens"
    if rank <= 16:
        return "blues"
    return "ultra"


def assign_ttm_bucket(days_to_expiry: int) -> str:
    """
    Map calendar days-to-expiry → TTM bucket string.
    [0,   365) → "0-1y"
    [365, 730) → "1-2y"
    [730,1095) → "2-3y"
    1095+      → "3y+"
    """
    if days_to_expiry < 365:
        return "0-1y"
    if days_to_expiry < 730:
        return "1-2y"
    if days_to_expiry < 1095:
        return "2-3y"
    return "3y+"


# ---------------------------------------------------------------------------
# §6.1.1 — Expiry drain detection
# ---------------------------------------------------------------------------

def _get_trailing_peak_oi(
    conn,
    contract_id: str,
    trade_date: datetime.date,
    lookback_business_days: int,
    as_of_date: datetime.date,
) -> int | None:
    """
    Return the maximum open_interest for contract_id over the past
    `lookback_business_days` business days ending on (but not including) trade_date.
    Only rows with knowledge_date <= as_of_date are considered.

    Returns None if there is no data in the lookback window.
    """
    row = conn.execute(
        """
        SELECT MAX(open_interest) AS peak_oi
        FROM (
            SELECT open_interest
            FROM daily_obs
            WHERE contract_id = ?
              AND trade_date < ?
              AND knowledge_date <= ?
              AND open_interest IS NOT NULL
            ORDER BY trade_date DESC
            LIMIT ?
        )
        """,
        (
            contract_id,
            trade_date.isoformat(),
            as_of_date.isoformat(),
            lookback_business_days,
        ),
    ).fetchone()
    return row[0] if row and row[0] is not None else None


def _flag_expiry_drain(
    conn,
    contract_id: str,
    trade_date: datetime.date,
    current_oi: int,
    params: dict,
    as_of_date: datetime.date,
) -> bool:
    """
    Return True if this contract is draining toward expiry.

    A contract is draining when:
      current_oi < fraction_of_3m_peak × trailing_peak_OI

    The lookback window is params["expiry_drain"]["lookback_business_days"].
    """
    drain_params = params["expiry_drain"]
    lookback = drain_params["lookback_business_days"]
    fraction = drain_params["fraction_of_3m_peak"]

    peak_oi = _get_trailing_peak_oi(
        conn, contract_id, trade_date, lookback, as_of_date
    )
    if peak_oi is None or peak_oi == 0:
        return False
    return current_oi < fraction * peak_oi


# ---------------------------------------------------------------------------
# §6.1.2 — Fixed-contract ΔOI query layer
# ---------------------------------------------------------------------------

def compute_doi(
    conn,
    trade_date: datetime.date,
    as_of_date: datetime.date,
    params: dict,
) -> list[dict]:
    """
    Return per-contract ΔOI rows for trade_date, filtered by knowledge_date <= as_of_date.

    ΔOI (doi) = open_interest − LAG(open_interest) over the same contract_id,
    ordered by trade_date.  The LAG is computed in SQL so we NEVER join across
    different contract_ids (§6.1.2 — no generic stitching).

    Returns:
        list of dicts with keys:
            contract_id, trade_date, knowledge_date, open_interest,
            prev_oi, doi, settlement_price, volume
    """
    sql = """
        WITH lagged AS (
            SELECT
                contract_id,
                trade_date,
                knowledge_date,
                open_interest,
                settlement_price,
                volume,
                LAG(open_interest)
                    OVER (PARTITION BY contract_id ORDER BY trade_date)
                    AS prev_oi
            FROM daily_obs
            WHERE knowledge_date <= ?
        )
        SELECT
            contract_id,
            trade_date,
            knowledge_date,
            open_interest,
            prev_oi,
            CASE WHEN prev_oi IS NOT NULL
                 THEN open_interest - prev_oi
                 ELSE NULL
            END AS doi,
            settlement_price,
            volume
        FROM lagged
        WHERE trade_date = ?
        ORDER BY contract_id
    """
    rows = conn.execute(sql, (as_of_date.isoformat(), trade_date.isoformat())).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# §6.1 — IMM roll dates
# ---------------------------------------------------------------------------

def imm_roll_dates(
    contracts: list[dict],
    start_date: datetime.date,
    end_date: datetime.date,
) -> list[datetime.date]:
    """
    Return a sorted list of last_trading_day values for all quarterly contracts
    whose last_trading_day falls in [start_date, end_date].

    These are the dates on which the front generic changes.
    """
    dates = []
    for c in contracts:
        if c["contract_type"] != "quarterly":
            continue
        ltd_str = c["last_trading_day"]
        ltd = datetime.date.fromisoformat(ltd_str) if isinstance(ltd_str, str) else ltd_str
        if start_date <= ltd <= end_date:
            dates.append(ltd)
    return sorted(set(dates))


# ---------------------------------------------------------------------------
# §6.1 — Active contracts for a trade_date
# ---------------------------------------------------------------------------

def _get_active_contracts(
    conn,
    trade_date: datetime.date,
    as_of_date: datetime.date,
) -> list[dict]:
    """
    Return all contracts that have at least one observation on trade_date
    with knowledge_date <= as_of_date, joined with their contract metadata.
    """
    sql = """
        SELECT
            c.contract_id,
            c.root,
            c.expiry_date,
            c.last_trading_day,
            c.contract_type,
            d.open_interest,
            d.settlement_price,
            d.volume
        FROM daily_obs d
        JOIN contracts c ON c.contract_id = d.contract_id
        WHERE d.trade_date = ?
          AND d.knowledge_date <= ?
        ORDER BY c.expiry_date
    """
    rows = conn.execute(sql, (trade_date.isoformat(), as_of_date.isoformat())).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# §6.1 — Main summary builder
# ---------------------------------------------------------------------------

def build_daily_summary(
    conn,
    trade_date: datetime.date,
    as_of_date: datetime.date,
    params: dict,
    include_draining: bool = False,
) -> list[dict]:
    """
    Return one enriched dict per active contract on trade_date.

    Each dict contains:
        contract_id, trade_date, open_interest, prev_oi, doi,
        settlement_price, volume,
        root, expiry_date, last_trading_day, contract_type,
        days_to_expiry,
        pack,           # "whites"/"reds"/… or None for serials
        ttm_bucket,     # "0-1y"/"1-2y"/"2-3y"/"3y+"
        generic_rank,   # 1 = front quarterly, 2 = second, etc. None for serials
        is_draining,    # bool
        dv01,           # open_interest × params["dv01"]["eur_per_bp_per_contract"]
    """
    dv01_per_contract = params["dv01"]["eur_per_bp_per_contract"]

    # Build DOI lookup for this trade_date
    doi_rows = {r["contract_id"]: r for r in compute_doi(conn, trade_date, as_of_date, params)}

    # Active contracts sorted by expiry_date
    active = _get_active_contracts(conn, trade_date, as_of_date)

    # Assign quarterly generic_rank (1 = nearest expiry among quarterlies)
    quarterly_sorted = [c for c in active if c["contract_type"] == "quarterly"]
    quarterly_rank = {c["contract_id"]: i + 1 for i, c in enumerate(quarterly_sorted)}

    results = []
    for c in active:
        cid = c["contract_id"]
        expiry = (
            datetime.date.fromisoformat(c["expiry_date"])
            if isinstance(c["expiry_date"], str)
            else c["expiry_date"]
        )
        days_to_exp = (expiry - trade_date).days

        oi = c["open_interest"]
        doi_data = doi_rows.get(cid, {})
        prev_oi = doi_data.get("prev_oi")
        doi_val = doi_data.get("doi")

        is_draining = _flag_expiry_drain(conn, cid, trade_date, oi, params, as_of_date)

        if not include_draining and is_draining:
            continue

        ctype = c["contract_type"]
        rank = quarterly_rank.get(cid)  # None for serials

        results.append({
            "contract_id":      cid,
            "trade_date":       trade_date,
            "open_interest":    oi,
            "prev_oi":          prev_oi,
            "doi":              doi_val,
            "settlement_price": c["settlement_price"],
            "volume":           c["volume"],
            "root":             c["root"],
            "expiry_date":      expiry,
            "last_trading_day": (
                datetime.date.fromisoformat(c["last_trading_day"])
                if isinstance(c["last_trading_day"], str)
                else c["last_trading_day"]
            ),
            "contract_type":    ctype,
            "days_to_expiry":   days_to_exp,
            "pack":             assign_pack(rank) if rank is not None else None,
            "ttm_bucket":       assign_ttm_bucket(days_to_exp),
            "generic_rank":     rank,
            "is_draining":      is_draining,
            "dv01":             oi * dv01_per_contract,
        })

    return results


# ---------------------------------------------------------------------------
# §6.1 — Complex DV01 total
# ---------------------------------------------------------------------------

def complex_dv01_total(
    conn,
    trade_date: datetime.date,
    as_of_date: datetime.date,
    params: dict,
    include_draining: bool = False,
) -> float:
    """
    Return total complex DV01 = SUM(open_interest × dv01_per_contract)
    across all non-draining (by default) active contracts on trade_date.
    """
    summary = build_daily_summary(
        conn, trade_date, as_of_date, params, include_draining=include_draining
    )
    return sum(row["dv01"] for row in summary)
