"""
Stage 6 — DV01 normalisation and tenor bucketing (§6.3).

Provides:
  - compute_dv01_snapshot     : single-date DV01 report at three levels
  - build_dv01_timeseries     : time series of DV01 snapshots with normalisation
  - compute_cog_lead_correlation : diagnostic — cross-correlation of CoG vs level

Three reporting levels (§6.3):
  Level 1 — Total net/gross DV01 across the complex (EUR)
  Level 2 — Net/gross DV01 by tenor bucket (whites/reds/greens/blues)
  Level 3 — OI-weighted centre of gravity in years

Normalisation:
  - OI-share per bucket: gross_dv01_{bucket} / total_gross_dv01
  - Trailing z-score per bucket: rolling mean/std over zscore_trailing_window days
  - Vol-scaled DV01 per bucket: scales net DV01 by realised vol / reference vol

All numeric constants come from params; no magic numbers in this module.
"""

from __future__ import annotations

import math
from datetime import date, timedelta
from typing import Optional

import numpy as np
import pandas as pd

# Try to import Stage 5 spread-adjusted signal; fall back to raw DOI from Stage 2.
try:
    from .spreads import spread_adjusted_quadrant_signal
    _HAS_SPREADS = True
except ImportError:
    _HAS_SPREADS = False

from .rolls import assign_pack, imm_roll_dates

DV01_PER_CONTRACT = 25.0  # EUR per bp — reference only; always read from params

_BUCKETS = ("whites", "reds", "greens", "blues")


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _business_days_range(start: date, end: date) -> list[date]:
    """Return all Mon–Fri dates in [start, end]."""
    days = []
    d = start
    while d <= end:
        if d.weekday() < 5:
            days.append(d)
        d += timedelta(days=1)
    return days


def _fetch_oi_table(conn, start_date: date, end_date: date, as_of_date: date) -> pd.DataFrame:
    """
    Pull open_interest, expiry_date, contract_type, and is_draining (via trailing
    peak OI logic) for all quarterly contracts over [start_date, end_date].

    Returns a DataFrame with columns:
        contract_id, trade_date, open_interest, expiry_date,
        days_to_expiry, pack, is_draining

    Draining flag is computed using the same rolling-peak logic as base_signal.py
    (vectorised, not per-row DB calls).
    """
    sql = """
        SELECT
            d.contract_id,
            d.trade_date,
            d.open_interest,
            c.expiry_date,
            c.contract_type
        FROM daily_obs d
        JOIN contracts c ON c.contract_id = d.contract_id
        WHERE d.knowledge_date <= ?
          AND d.trade_date >= ?
          AND d.trade_date <= ?
          AND c.contract_type = 'quarterly'
        ORDER BY c.expiry_date, d.trade_date
    """
    rows = conn.execute(
        sql,
        (as_of_date.isoformat(), start_date.isoformat(), end_date.isoformat()),
    ).fetchall()

    if not rows:
        return pd.DataFrame()

    df = pd.DataFrame([dict(r) for r in rows])
    df["trade_date"] = pd.to_datetime(df["trade_date"]).dt.date
    df["expiry_date"] = pd.to_datetime(df["expiry_date"]).dt.date
    df["days_to_expiry"] = df.apply(lambda r: (r["expiry_date"] - r["trade_date"]).days, axis=1)

    return df


def _assign_generic_rank_and_pack(oi_df: pd.DataFrame) -> pd.DataFrame:
    """
    Assign generic_rank (1 = nearest expiry quarterly) and pack label per trade_date.
    Mutates and returns oi_df.
    """
    rank_lookup: dict[tuple, int] = {}
    for td, grp in oi_df.groupby("trade_date"):
        sorted_ids = grp.sort_values("expiry_date")["contract_id"].tolist()
        for i, cid in enumerate(sorted_ids):
            rank_lookup[(cid, td)] = i + 1

    oi_df["generic_rank"] = oi_df.apply(
        lambda r: rank_lookup.get((r["contract_id"], r["trade_date"])), axis=1
    )
    oi_df["pack"] = oi_df["generic_rank"].apply(
        lambda r: assign_pack(int(r)) if pd.notna(r) else None
    )
    return oi_df


def _flag_draining_vectorised(oi_df: pd.DataFrame, params: dict) -> pd.DataFrame:
    """
    Vectorised draining flag: current_oi < fraction_of_3m_peak × trailing_peak_OI.
    Mutates and returns oi_df with 'is_draining' bool column.
    """
    drain_frac = params["expiry_drain"]["fraction_of_3m_peak"]
    lookback = params["expiry_drain"]["lookback_business_days"]

    oi_df = oi_df.sort_values(["contract_id", "trade_date"]).copy()
    oi_df["_trail_peak"] = (
        oi_df.groupby("contract_id")["open_interest"]
        .transform(lambda s: s.shift(1).rolling(window=lookback, min_periods=1).max())
    )
    oi_df["is_draining"] = (
        oi_df["_trail_peak"].notna()
        & (oi_df["_trail_peak"] > 0)
        & (oi_df["open_interest"] < drain_frac * oi_df["_trail_peak"])
    )
    oi_df.drop(columns=["_trail_peak"], inplace=True)
    return oi_df


def _fetch_sigma_table(conn, start_date: date, end_date: date, as_of_date: date, params: dict) -> pd.DataFrame:
    """
    Pull settlement_price for quarterly contracts to compute per-contract EWMA vol.
    Returns DataFrame indexed by (contract_id, trade_date) with column 'sigma'.
    'sigma' is EWMA of |Δr| shifted by 1 day (no look-ahead, same as base_signal.py).
    """
    sql = """
        WITH lagged AS (
            SELECT
                d.contract_id,
                d.trade_date,
                d.settlement_price,
                LAG(d.settlement_price)
                    OVER (PARTITION BY d.contract_id ORDER BY d.trade_date)
                    AS prev_settlement_price,
                c.contract_type
            FROM daily_obs d
            JOIN contracts c ON c.contract_id = d.contract_id
            WHERE d.knowledge_date <= ?
              AND c.contract_type = 'quarterly'
        )
        SELECT contract_id, trade_date, settlement_price, prev_settlement_price
        FROM lagged
        WHERE trade_date >= ?
          AND trade_date <= ?
          AND prev_settlement_price IS NOT NULL
        ORDER BY contract_id, trade_date
    """
    rows = conn.execute(
        sql,
        (as_of_date.isoformat(), start_date.isoformat(), end_date.isoformat()),
    ).fetchall()

    if not rows:
        return pd.DataFrame()

    df = pd.DataFrame([dict(r) for r in rows])
    df["trade_date"] = pd.to_datetime(df["trade_date"]).dt.date
    df["dr_abs"] = (df["settlement_price"] - df["prev_settlement_price"]).abs()

    span = int(params["signal"]["ewma_vol_span"])
    sigma_parts = []
    for cid, grp in df.groupby("contract_id", sort=False):
        grp = grp.sort_values("trade_date").copy()
        ewma_vol = grp["dr_abs"].ewm(span=span, adjust=False).mean()
        grp["sigma"] = ewma_vol.shift(1).values
        sigma_parts.append(grp[["contract_id", "trade_date", "sigma"]])

    if not sigma_parts:
        return pd.DataFrame()

    sigma_df = pd.concat(sigma_parts, ignore_index=True)
    return sigma_df


# ---------------------------------------------------------------------------
# §6.3 — Single-date DV01 snapshot
# ---------------------------------------------------------------------------

def compute_dv01_snapshot(
    conn,
    trade_date: date,
    as_of_date: date,
    params: dict,
    include_draining: bool = False,
) -> dict:
    """
    Single-date DV01 report at three levels.

    Level 1 — Total net DV01 across the complex (EUR):
        total_net_dv01  = SUM(doi_outright_i × dv01_per_contract)  [signed: long positive]
        total_gross_dv01 = SUM(OI_i × dv01_per_contract)           [all active OI]

    Level 2 — Net DV01 by tenor bucket (whites/reds/greens/blues):
        dv01_net_{bucket}   = SUM(doi_outright_i × dv01_per_contract) for i in bucket
        dv01_gross_{bucket} = SUM(OI_i × dv01_per_contract) for i in bucket

    Level 3 — OI-weighted centre of gravity in years:
        cog_years = SUM(|OI_i| × years_to_expiry_i) / SUM(|OI_i|)

    Returns dict with keys:
        trade_date, total_net_dv01, total_gross_dv01,
        dv01_net_whites, dv01_net_reds, dv01_net_greens, dv01_net_blues,
        dv01_gross_whites, dv01_gross_reds, dv01_gross_greens, dv01_gross_blues,
        cog_years,
        n_active_contracts, n_draining_contracts
    """
    dv01_per = float(params["dv01"]["eur_per_bp_per_contract"])
    cog_use_abs = params.get("normalisation", {}).get("cog_use_abs_dv01", True)

    # -----------------------------------------------------------------------
    # 1.  OI levels from daily_obs (for gross DV01 and CoG)
    # -----------------------------------------------------------------------
    oi_sql = """
        SELECT
            d.contract_id,
            d.open_interest,
            c.expiry_date,
            c.contract_type
        FROM daily_obs d
        JOIN contracts c ON c.contract_id = d.contract_id
        WHERE d.trade_date = ?
          AND d.knowledge_date <= ?
          AND c.contract_type = 'quarterly'
        ORDER BY c.expiry_date
    """
    oi_rows = conn.execute(
        oi_sql, (trade_date.isoformat(), as_of_date.isoformat())
    ).fetchall()

    if not oi_rows:
        return _empty_snapshot(trade_date)

    # Build per-contract record
    oi_data: dict[str, dict] = {}
    quarterly_by_expiry: list[tuple[date, str]] = []

    for r in oi_rows:
        cid = r["contract_id"]
        expiry = (
            date.fromisoformat(r["expiry_date"])
            if isinstance(r["expiry_date"], str)
            else r["expiry_date"]
        )
        oi_data[cid] = {
            "open_interest": int(r["open_interest"]) if r["open_interest"] else 0,
            "expiry_date": expiry,
            "days_to_expiry": (expiry - trade_date).days,
        }
        quarterly_by_expiry.append((expiry, cid))

    quarterly_by_expiry.sort()

    # Assign generic_rank and pack
    for i, (_, cid) in enumerate(quarterly_by_expiry):
        rank = i + 1
        oi_data[cid]["generic_rank"] = rank
        oi_data[cid]["pack"] = assign_pack(rank)

    # -----------------------------------------------------------------------
    # 2.  Draining flags (per-contract, from DB lookback)
    # -----------------------------------------------------------------------
    drain_frac = params["expiry_drain"]["fraction_of_3m_peak"]
    lookback = params["expiry_drain"]["lookback_business_days"]

    for cid in oi_data:
        peak_row = conn.execute(
            """
            SELECT MAX(open_interest)
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
            (cid, trade_date.isoformat(), as_of_date.isoformat(), lookback),
        ).fetchone()
        peak_oi = peak_row[0] if peak_row and peak_row[0] is not None else None
        cur_oi = oi_data[cid]["open_interest"]
        if peak_oi and peak_oi > 0:
            oi_data[cid]["is_draining"] = cur_oi < drain_frac * peak_oi
        else:
            oi_data[cid]["is_draining"] = False

    n_draining = sum(1 for v in oi_data.values() if v["is_draining"])

    # -----------------------------------------------------------------------
    # 3.  Net DV01 flow: doi_outright from Stage 5 (spread-adjusted)
    # -----------------------------------------------------------------------
    # Get doi_outright from Stage 5.
    # We need the previous day's data to build the spread signal properly.
    # Use a 2-day lookback window for the spread pipeline.
    _prev_date = trade_date
    doi_outright: dict[str, float] = {}

    if _HAS_SPREADS:
        # Determine a start_date for the spread signal — need enough history for
        # rolling correlation (min_periods=20), so look back 30 days.
        lookback_days = 30
        _start_td = trade_date - timedelta(days=lookback_days * 2)
        try:
            corr_df, _ = spread_adjusted_quadrant_signal(
                conn, _start_td, trade_date, as_of_date, params
            )
            if not corr_df.empty:
                # Filter to trade_date only, extract doi (spread-corrected) per contract
                idx = corr_df.index
                for cid in oi_data:
                    key = (cid, trade_date)
                    if key in idx:
                        doi_outright[cid] = float(corr_df.loc[key, "doi"])
        except Exception:
            doi_outright = {}

    if not doi_outright:
        # Fall back to raw doi from Stage 2
        raw_doi_rows = conn.execute(
            """
            WITH lagged AS (
                SELECT
                    contract_id,
                    trade_date,
                    open_interest,
                    LAG(open_interest) OVER (PARTITION BY contract_id ORDER BY trade_date) AS prev_oi
                FROM daily_obs
                WHERE knowledge_date <= ?
            )
            SELECT contract_id,
                   CASE WHEN prev_oi IS NOT NULL THEN open_interest - prev_oi ELSE NULL END AS doi
            FROM lagged
            WHERE trade_date = ?
            """,
            (as_of_date.isoformat(), trade_date.isoformat()),
        ).fetchall()
        for r in raw_doi_rows:
            if r["doi"] is not None:
                doi_outright[r["contract_id"]] = float(r["doi"])

    # -----------------------------------------------------------------------
    # 4.  Aggregate at three levels
    # -----------------------------------------------------------------------
    total_net_dv01 = 0.0
    total_gross_dv01 = 0.0
    bucket_net: dict[str, float] = {b: 0.0 for b in _BUCKETS}
    bucket_gross: dict[str, float] = {b: 0.0 for b in _BUCKETS}
    cog_numerator = 0.0
    cog_denominator = 0.0
    n_active = 0

    for cid, info in oi_data.items():
        oi = info["open_interest"]
        pack = info["pack"]
        days_exp = info["days_to_expiry"]
        is_drain = info["is_draining"]
        years_exp = days_exp / 365.25

        # Gross DV01 always includes all active contracts (draining included per spec)
        gross_dv01_i = oi * dv01_per
        total_gross_dv01 += gross_dv01_i
        if pack in bucket_gross:
            bucket_gross[pack] += gross_dv01_i

        # CoG: always uses all active OI
        weight = abs(oi) if cog_use_abs else oi
        cog_numerator += weight * years_exp
        cog_denominator += abs(oi) if cog_use_abs else max(weight, 0.0)

        n_active += 1

        # Net DV01: exclude draining contracts (their flow doesn't count)
        if not is_drain or include_draining:
            doi_val = doi_outright.get(cid, 0.0)
            net_dv01_i = doi_val * dv01_per
            total_net_dv01 += net_dv01_i
            if pack in bucket_net:
                bucket_net[pack] += net_dv01_i

    cog_years = cog_numerator / cog_denominator if cog_denominator > 0 else 0.0

    return {
        "trade_date":          trade_date,
        "total_net_dv01":      total_net_dv01,
        "total_gross_dv01":    total_gross_dv01,
        "dv01_net_whites":     bucket_net["whites"],
        "dv01_net_reds":       bucket_net["reds"],
        "dv01_net_greens":     bucket_net["greens"],
        "dv01_net_blues":      bucket_net["blues"],
        "dv01_gross_whites":   bucket_gross["whites"],
        "dv01_gross_reds":     bucket_gross["reds"],
        "dv01_gross_greens":   bucket_gross["greens"],
        "dv01_gross_blues":    bucket_gross["blues"],
        "cog_years":           cog_years,
        "n_active_contracts":  n_active,
        "n_draining_contracts": n_draining,
    }


def _empty_snapshot(trade_date: date) -> dict:
    return {
        "trade_date":          trade_date,
        "total_net_dv01":      0.0,
        "total_gross_dv01":    0.0,
        "dv01_net_whites":     0.0,
        "dv01_net_reds":       0.0,
        "dv01_net_greens":     0.0,
        "dv01_net_blues":      0.0,
        "dv01_gross_whites":   0.0,
        "dv01_gross_reds":     0.0,
        "dv01_gross_greens":   0.0,
        "dv01_gross_blues":    0.0,
        "cog_years":           0.0,
        "n_active_contracts":  0,
        "n_draining_contracts": 0,
    }


# ---------------------------------------------------------------------------
# §6.3 — DV01 time series with normalisation
# ---------------------------------------------------------------------------

def build_dv01_timeseries(
    conn,
    start_date: date,
    end_date: date,
    as_of_date: date,
    params: dict,
    instrument_roots: list[str] | None = None,
) -> pd.DataFrame:
    """
    Compute DV01 snapshot for every business day in [start_date, end_date].

    Batches data fetch to avoid N database round-trips.

    Returns DataFrame indexed by trade_date with all snapshot columns plus:
      - regime normalisation columns (oi_share, zscore)
      - vol-scaled DV01 columns
    """
    dv01_per = float(params["dv01"]["eur_per_bp_per_contract"])
    norm_p = params.get("normalisation", {})
    zscore_window = int(norm_p.get("zscore_trailing_window", 252))
    vol_ref_bp = float(norm_p.get("vol_reference_annualised_bp", 50.0))
    vol_ann_factor = int(norm_p.get("vol_annualisation_factor", 252))
    cog_use_abs = bool(norm_p.get("cog_use_abs_dv01", True))

    # -----------------------------------------------------------------------
    # 1.  Batch fetch OI data for the full range
    # -----------------------------------------------------------------------
    # We need slightly earlier data for draining flag (trailing peak lookback)
    lookback_drain = int(params["expiry_drain"]["lookback_business_days"])
    drain_frac = float(params["expiry_drain"]["fraction_of_3m_peak"])
    extended_start = start_date - timedelta(days=lookback_drain * 2)

    oi_df = _fetch_oi_table(conn, extended_start, end_date, as_of_date)
    if oi_df.empty:
        return pd.DataFrame()

    oi_df = _flag_draining_vectorised(oi_df, params)
    oi_df = _assign_generic_rank_and_pack(oi_df)

    # -----------------------------------------------------------------------
    # 2.  Batch fetch spread-adjusted doi_outright from Stage 5
    # -----------------------------------------------------------------------
    doi_outright_map: dict[tuple[str, date], float] = {}  # (contract_id, trade_date) → doi

    if _HAS_SPREADS:
        try:
            spread_df, _ = spread_adjusted_quadrant_signal(
                conn, start_date, end_date, as_of_date, params, instrument_roots=instrument_roots
            )
            if not spread_df.empty:
                for (cid, td), row in spread_df.iterrows():
                    doi_outright_map[(cid, td)] = float(row["doi"])
        except Exception:
            doi_outright_map = {}

    if not doi_outright_map:
        # Fall back to raw doi from Stage 2
        _roots_clause = ""
        _roots_params: list = []
        if instrument_roots:
            _placeholders = ",".join("?" * len(instrument_roots))
            _roots_clause = f"AND c.root IN ({_placeholders})"
            _roots_params = list(instrument_roots)

        raw_doi_sql = f"""
            WITH lagged AS (
                SELECT
                    d.contract_id,
                    d.trade_date,
                    d.open_interest,
                    LAG(d.open_interest)
                        OVER (PARTITION BY d.contract_id ORDER BY d.trade_date)
                        AS prev_oi,
                    c.contract_type
                FROM daily_obs d
                JOIN contracts c ON c.contract_id = d.contract_id
                WHERE d.knowledge_date <= ?
                  AND c.contract_type = 'quarterly'
                  {_roots_clause}
            )
            SELECT contract_id, trade_date,
                   CASE WHEN prev_oi IS NOT NULL THEN open_interest - prev_oi ELSE NULL END AS doi
            FROM lagged
            WHERE trade_date >= ?
              AND trade_date <= ?
              AND prev_oi IS NOT NULL
            ORDER BY contract_id, trade_date
        """
        raw_rows = conn.execute(
            raw_doi_sql,
            [as_of_date.isoformat()] + _roots_params + [start_date.isoformat(), end_date.isoformat()],
        ).fetchall()
        for r in raw_rows:
            td = date.fromisoformat(r["trade_date"]) if isinstance(r["trade_date"], str) else r["trade_date"]
            if r["doi"] is not None:
                doi_outright_map[(r["contract_id"], td)] = float(r["doi"])

    # -----------------------------------------------------------------------
    # 3.  Batch fetch sigma (EWMA vol) for vol-scaling
    # -----------------------------------------------------------------------
    sigma_df = _fetch_sigma_table(conn, start_date, end_date, as_of_date, params)
    sigma_map: dict[tuple[str, date], float] = {}
    if not sigma_df.empty:
        for _, row in sigma_df.iterrows():
            td = row["trade_date"]
            if isinstance(td, str):
                td = date.fromisoformat(td)
            sigma_map[(row["contract_id"], td)] = float(row["sigma"]) if pd.notna(row["sigma"]) else 0.0

    # -----------------------------------------------------------------------
    # 4.  Compute snapshots for each business day in [start_date, end_date]
    # -----------------------------------------------------------------------
    bdays = _business_days_range(start_date, end_date)

    # Group oi_df by trade_date for fast lookup
    oi_by_date: dict[date, pd.DataFrame] = {}
    for td, grp in oi_df[oi_df["trade_date"] >= start_date].groupby("trade_date"):
        oi_by_date[td] = grp

    snapshot_rows = []

    for td in bdays:
        if td not in oi_by_date:
            snapshot_rows.append(_empty_snapshot(td))
            continue

        day_oi = oi_by_date[td]

        total_net_dv01 = 0.0
        total_gross_dv01 = 0.0
        bucket_net: dict[str, float] = {b: 0.0 for b in _BUCKETS}
        bucket_gross: dict[str, float] = {b: 0.0 for b in _BUCKETS}
        cog_numerator = 0.0
        cog_denominator = 0.0
        n_active = 0
        n_draining = 0

        # Vol per bucket (OI-weighted average sigma, annualised)
        bucket_sigma_sum: dict[str, float] = {b: 0.0 for b in _BUCKETS}
        bucket_oi_sum: dict[str, float] = {b: 0.0 for b in _BUCKETS}

        for _, row in day_oi.iterrows():
            cid = row["contract_id"]
            oi = int(row["open_interest"]) if pd.notna(row["open_interest"]) else 0
            pack = row["pack"]
            days_exp = int(row["days_to_expiry"]) if pd.notna(row["days_to_expiry"]) else 0
            is_drain = bool(row["is_draining"])
            years_exp = days_exp / 365.25

            if is_drain:
                n_draining += 1

            # Gross DV01 (all active contracts including draining)
            gross_dv01_i = oi * dv01_per
            total_gross_dv01 += gross_dv01_i
            if pack in bucket_gross:
                bucket_gross[pack] += gross_dv01_i

            # CoG uses all active OI
            weight = abs(oi) if cog_use_abs else oi
            cog_numerator += weight * years_exp
            cog_denominator += abs(oi) if cog_use_abs else max(weight, 0.0)

            n_active += 1

            # Vol accumulation per bucket
            sig = sigma_map.get((cid, td), 0.0)
            if pack in bucket_sigma_sum:
                bucket_sigma_sum[pack] += sig * abs(oi)
                bucket_oi_sum[pack] += abs(oi)

            # Net DV01: exclude draining contracts
            if not is_drain:
                doi_val = doi_outright_map.get((cid, td), 0.0)
                net_dv01_i = doi_val * dv01_per
                total_net_dv01 += net_dv01_i
                if pack in bucket_net:
                    bucket_net[pack] += net_dv01_i

        cog_years = cog_numerator / cog_denominator if cog_denominator > 0 else 0.0

        # OI-weighted average sigma per bucket (daily price change in price units)
        bucket_vol_daily: dict[str, float] = {}
        for b in _BUCKETS:
            if bucket_oi_sum[b] > 0:
                bucket_vol_daily[b] = bucket_sigma_sum[b] / bucket_oi_sum[b]
            else:
                bucket_vol_daily[b] = 0.0

        row_dict = {
            "trade_date":           td,
            "total_net_dv01":       total_net_dv01,
            "total_gross_dv01":     total_gross_dv01,
            "dv01_net_whites":      bucket_net["whites"],
            "dv01_net_reds":        bucket_net["reds"],
            "dv01_net_greens":      bucket_net["greens"],
            "dv01_net_blues":       bucket_net["blues"],
            "dv01_gross_whites":    bucket_gross["whites"],
            "dv01_gross_reds":      bucket_gross["reds"],
            "dv01_gross_greens":    bucket_gross["greens"],
            "dv01_gross_blues":     bucket_gross["blues"],
            "cog_years":            cog_years,
            "n_active_contracts":   n_active,
            "n_draining_contracts": n_draining,
            "_vol_daily_whites":    bucket_vol_daily["whites"],
            "_vol_daily_reds":      bucket_vol_daily["reds"],
            "_vol_daily_greens":    bucket_vol_daily["greens"],
            "_vol_daily_blues":     bucket_vol_daily["blues"],
        }
        snapshot_rows.append(row_dict)

    if not snapshot_rows:
        return pd.DataFrame()

    ts = pd.DataFrame(snapshot_rows).set_index("trade_date").sort_index()

    # -----------------------------------------------------------------------
    # 5.  OI-share normalisation (dimensionless, bucket crowdedness)
    # -----------------------------------------------------------------------
    for b in _BUCKETS:
        denom = ts["total_gross_dv01"].replace(0, np.nan)
        ts[f"oi_share_{b}"] = ts[f"dv01_gross_{b}"] / denom

    # -----------------------------------------------------------------------
    # 6.  Trailing z-score normalisation
    # -----------------------------------------------------------------------
    roll_kwargs = dict(window=zscore_window, min_periods=max(20, zscore_window // 10))

    for b in _BUCKETS:
        col = f"dv01_net_{b}"
        roll_mean = ts[col].rolling(**roll_kwargs).mean()
        roll_std = ts[col].rolling(**roll_kwargs).std()
        ts[f"zscore_{b}"] = (ts[col] - roll_mean) / roll_std.replace(0, np.nan)

    # Total z-score
    col_total = "total_net_dv01"
    roll_mean_t = ts[col_total].rolling(**roll_kwargs).mean()
    roll_std_t = ts[col_total].rolling(**roll_kwargs).std()
    ts["zscore_total"] = (ts[col_total] - roll_mean_t) / roll_std_t.replace(0, np.nan)

    # CoG z-score (leading indicator)
    roll_mean_c = ts["cog_years"].rolling(**roll_kwargs).mean()
    roll_std_c = ts["cog_years"].rolling(**roll_kwargs).std()
    ts["cog_zscore"] = (ts["cog_years"] - roll_mean_c) / roll_std_c.replace(0, np.nan)

    # -----------------------------------------------------------------------
    # 7.  Volatility scaling
    # -----------------------------------------------------------------------
    # vol_reference in price units: 50 bp annualised = 0.50 price pts annualised
    # settlement_price = 100 - rate, so Δprice = -Δrate.
    # 1 bp rate = 0.01 price point.
    # 50 bp annualised → vol_reference_price_annual = 50 × 0.01 = 0.50 pts/year
    vol_ref_price_annual = vol_ref_bp * 0.01
    # Vol reference per day (annualised → daily)
    vol_ref_daily = vol_ref_price_annual / math.sqrt(vol_ann_factor)

    for b in _BUCKETS:
        # OI-weighted average EWMA sigma (daily price units), rolled 60-day EWMA for stability
        daily_vol_col = f"_vol_daily_{b}"
        # Smooth with a short EWMA to reduce noise in sparse buckets
        vol_smooth = ts[daily_vol_col].ewm(span=60, adjust=False, min_periods=1).mean()
        vol_ann = vol_smooth * math.sqrt(vol_ann_factor)
        ts[f"vol_annualised_{b}"] = vol_ann

        # vol_ratio: realised / reference (both annualised, same units)
        # Use vol_ref_price_annual as reference in price-point units
        vol_ratio = vol_ann / vol_ref_price_annual
        # Safe: where vol is 0 or NaN, risk_dv01 = 0
        ts[f"risk_dv01_{b}"] = np.where(
            (vol_smooth > 0) & vol_smooth.notna(),
            ts[f"dv01_net_{b}"] * vol_ratio,
            0.0,
        )

    # Total risk DV01 (sum of bucket risk DV01s)
    ts["risk_dv01_total"] = sum(ts[f"risk_dv01_{b}"] for b in _BUCKETS)

    # Drop internal helper columns
    for b in _BUCKETS:
        ts.drop(columns=[f"_vol_daily_{b}"], inplace=True)

    return ts


# ---------------------------------------------------------------------------
# §6.3 — CoG as leading indicator: cross-correlation diagnostic
# ---------------------------------------------------------------------------

def compute_cog_lead_correlation(
    dv01_ts: pd.DataFrame,
    max_lead: int = 10,
) -> dict:
    """
    Compute cross-correlation between weekly change in CoG and weekly change in
    total_net_dv01, for leads 0 to max_lead days.

    Returns {"lead_days": int, "max_corr": float} — the lead where correlation
    is highest. A positive lead_days means CoG leads the level series.

    This is a diagnostic function — not required for the pipeline.
    """
    if dv01_ts.empty or "cog_years" not in dv01_ts.columns:
        return {"lead_days": 0, "max_corr": float("nan")}

    # Weekly changes (5-day)
    dcog = dv01_ts["cog_years"].diff(5).dropna()
    dlevel = dv01_ts["total_net_dv01"].diff(5).dropna()

    # Align
    common_idx = dcog.index.intersection(dlevel.index)
    dcog = dcog.loc[common_idx]
    dlevel = dlevel.loc[common_idx]

    if len(dcog) < max_lead + 10:
        return {"lead_days": 0, "max_corr": float("nan")}

    best_lead = 0
    best_corr = float("-inf")

    for lead in range(0, max_lead + 1):
        # dcog at t+lead vs dlevel at t
        # CoG leads: shift dlevel forward by `lead` days (or equivalently lag dcog)
        dcog_aligned = dcog.iloc[: len(dcog) - lead] if lead > 0 else dcog
        dlevel_aligned = dlevel.iloc[lead:] if lead > 0 else dlevel

        if len(dcog_aligned) < 10:
            continue

        # Align by position
        n = min(len(dcog_aligned), len(dlevel_aligned))
        if n < 10:
            continue

        corr = float(np.corrcoef(dcog_aligned.values[:n], dlevel_aligned.values[:n])[0, 1])
        if not math.isnan(corr) and corr > best_corr:
            best_corr = corr
            best_lead = lead

    return {"lead_days": best_lead, "max_corr": best_corr}
