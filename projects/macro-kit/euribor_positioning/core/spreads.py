"""
Stage 5 — Spread detection and routing (§6.2).

Provides:
  - build_doi_matrix               : wide ΔOI matrix (date × contract)
  - compute_rolling_pair_corr      : rolling pairwise Pearson correlation
  - detect_spreads_day             : single-day three-level spread detector (pure function)
  - build_spread_signal            : full pipeline over a date range
  - compute_weekly_spread_validation : align estimated spread share with COT spreading
  - spread_adjusted_quadrant_signal  : Stage 5 output — quadrant signal corrected for spreads

Detection hierarchy (§6.2, method 2):
  Level 1 — Bundle (8-leg):  8 consecutive quarterly contracts with low CV of |ΔOI|
  Level 2 — Pack (4-leg):    4 consecutive quarterly contracts with low CV of |ΔOI|
  Level 3 — Calendar (2-leg): rolling correlation identifies habitually spread-traded pairs

Spread-attributed flow is NOT discarded — it is routed to the curve_positioning series.
"""

from __future__ import annotations

import math
from datetime import date
from typing import Optional

import numpy as np
import pandas as pd

from .quadrants import build_quadrant_signal


# ---------------------------------------------------------------------------
# DOI matrix builder
# ---------------------------------------------------------------------------

def build_doi_matrix(
    conn,
    start_date: date,
    end_date: date,
    as_of_date: date,
    params: dict,
    instrument_roots: list[str] | None = None,
) -> pd.DataFrame:
    """
    Build wide DataFrame: index=trade_date, columns=contract_id, values=doi (signed ΔOI).
    Quarterly contracts only. Filtered by knowledge_date <= as_of_date.
    Only contracts active on each date (OI > 0 or adjacent to active contracts).
    """
    roots_clause = ""
    roots_params: list = []
    if instrument_roots:
        placeholders = ",".join("?" * len(instrument_roots))
        roots_clause = f"AND c.root IN ({placeholders})"
        roots_params = list(instrument_roots)

    sql = f"""
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
              {roots_clause}
        )
        SELECT
            contract_id,
            trade_date,
            CASE WHEN prev_oi IS NOT NULL
                 THEN open_interest - prev_oi
                 ELSE NULL
            END AS doi
        FROM lagged
        WHERE trade_date >= ?
          AND trade_date <= ?
          AND prev_oi IS NOT NULL
        ORDER BY contract_id, trade_date
    """
    rows = conn.execute(
        sql,
        [as_of_date.isoformat()] + roots_params + [start_date.isoformat(), end_date.isoformat()],
    ).fetchall()

    if not rows:
        return pd.DataFrame()

    df = pd.DataFrame([dict(r) for r in rows])
    df["trade_date"] = pd.to_datetime(df["trade_date"]).dt.date

    # Pivot to wide format: rows = trade_date, cols = contract_id
    matrix = df.pivot(index="trade_date", columns="contract_id", values="doi")
    matrix = matrix.sort_index()
    return matrix


# ---------------------------------------------------------------------------
# Rolling pairwise correlation
# ---------------------------------------------------------------------------

def compute_rolling_pair_corr(
    doi_matrix: pd.DataFrame,
    params: dict,
) -> pd.DataFrame:
    """
    Compute rolling pairwise Pearson correlation of ΔOI for all contract pairs
    within 4 ranks of each other.

    Returns DataFrame indexed by trade_date with MultiIndex columns (contract_i, contract_j).
    Only compute for adjacent and near-adjacent pairs (within 4 ranks of each other).
    """
    sp = params.get("spreads", {})
    window = int(sp.get("rolling_corr_window", 60))
    min_periods = int(sp.get("rolling_corr_min_periods", 20))

    if doi_matrix.empty:
        return pd.DataFrame()

    contracts = list(doi_matrix.columns)
    n = len(contracts)

    if n == 0:
        return pd.DataFrame()

    # Only compute for pairs within rank distance 4
    pair_results = {}
    for i in range(n):
        for j in range(i + 1, min(i + 5, n)):  # j in [i+1, i+4]
            ci = contracts[i]
            cj = contracts[j]
            s_i = doi_matrix[ci].fillna(0.0)
            s_j = doi_matrix[cj].fillna(0.0)
            roll_corr = s_i.rolling(window=window, min_periods=min_periods).corr(s_j)
            pair_results[(ci, cj)] = roll_corr

    if not pair_results:
        return pd.DataFrame()

    result = pd.DataFrame(pair_results, index=doi_matrix.index)
    result.columns = pd.MultiIndex.from_tuples(result.columns)
    return result


# ---------------------------------------------------------------------------
# Single-day spread detector (pure function — no DB access)
# ---------------------------------------------------------------------------

def detect_spreads_day(
    doi_day: pd.Series,
    quarterly_order: list[str],
    pair_corr_day: Optional[pd.Series],
    params: dict,
) -> pd.DataFrame:
    """
    Run the three-level spread detection for a single day.

    Args:
        doi_day        : contract_id → signed ΔOI for one trade_date
        quarterly_order: contract_ids sorted by expiry, active on this day
        pair_corr_day  : (contract_i, contract_j) → rolling_corr (or None)
        params         : full params dict

    Returns DataFrame with columns:
        contract_id, doi, doi_spread_attributed, doi_outright,
        spread_type, spread_partner, curve_flow
    """
    sp = params.get("spreads", {})
    bundle_cv_thresh = float(sp.get("bundle_cv_threshold", 0.35))
    pack_cv_thresh   = float(sp.get("pack_cv_threshold", 0.30))
    pair_corr_thresh = float(sp.get("pair_corr_threshold", 0.50))
    pair_ratio_max   = float(sp.get("pair_ratio_max", 1.50))
    min_doi_abs      = float(sp.get("min_doi_abs", 50))

    # Build per-contract record
    contracts_in_order = [c for c in quarterly_order if c in doi_day.index]

    # Initialize attribution tracking
    records = {
        c: {
            "contract_id":          c,
            "doi":                  int(doi_day.get(c, 0) or 0),
            "doi_spread_attributed": 0,
            "doi_outright":         int(doi_day.get(c, 0) or 0),
            "spread_type":          "outright",
            "spread_partner":       None,
            "curve_flow":           0.0,
        }
        for c in contracts_in_order
    }

    # Track which contracts have been attributed (to prevent double-counting)
    attributed = set()  # contracts already attributed to bundle or pack

    # ------------------------------------------------------------------
    # Level 1 — Bundle (8-leg)
    # ------------------------------------------------------------------
    n = len(contracts_in_order)
    for start_idx in range(n - 7):
        window = contracts_in_order[start_idx: start_idx + 8]
        doi_abs_vals = [abs(records[c]["doi"]) for c in window]
        mean_doi = float(np.mean(doi_abs_vals))
        if mean_doi < min_doi_abs:
            continue
        std_doi = float(np.std(doi_abs_vals))
        cv = std_doi / mean_doi if mean_doi > 0 else float("inf")
        if cv < bundle_cv_thresh:
            spread_amount = int(min(doi_abs_vals))
            for c in window:
                if c not in attributed:
                    doi_signed = records[c]["doi"]
                    records[c]["doi_spread_attributed"] += spread_amount
                    records[c]["doi_outright"] = doi_signed - int(np.sign(doi_signed)) * spread_amount
                    records[c]["spread_type"] = "bundle"
                    # curve_flow for pack/bundle: deviation from mean level
                    records[c]["curve_flow"] = float(doi_signed - np.sign(doi_signed) * mean_doi)
                    attributed.add(c)

    # ------------------------------------------------------------------
    # Level 2 — Pack (4-leg)
    # ------------------------------------------------------------------
    for start_idx in range(n - 3):
        window = contracts_in_order[start_idx: start_idx + 4]
        # Skip if all legs are already bundle-attributed
        if all(c in attributed for c in window):
            continue
        # Only run on legs not already attributed
        eligible = [c for c in window if c not in attributed]
        if len(eligible) < 4:
            continue
        doi_abs_vals = [abs(records[c]["doi"]) for c in eligible]
        mean_doi = float(np.mean(doi_abs_vals))
        if mean_doi < min_doi_abs:
            continue
        std_doi = float(np.std(doi_abs_vals))
        cv = std_doi / mean_doi if mean_doi > 0 else float("inf")
        if cv < pack_cv_thresh:
            spread_amount = int(min(doi_abs_vals))
            for c in eligible:
                doi_signed = records[c]["doi"]
                records[c]["doi_spread_attributed"] += spread_amount
                records[c]["doi_outright"] = doi_signed - int(np.sign(doi_signed)) * spread_amount
                records[c]["spread_type"] = "pack"
                records[c]["curve_flow"] = float(doi_signed - np.sign(doi_signed) * mean_doi)
                attributed.add(c)

    # ------------------------------------------------------------------
    # Level 3 — Calendar spread (2-leg), from rolling correlation
    # ------------------------------------------------------------------
    if pair_corr_day is not None:
        for i, ci in enumerate(contracts_in_order):
            if ci in attributed:
                continue
            for j in range(i + 1, min(i + 5, len(contracts_in_order))):
                cj = contracts_in_order[j]
                if cj in attributed:
                    continue

                # Look up correlation for this pair
                corr_val = None
                if (ci, cj) in pair_corr_day.index:
                    corr_val = pair_corr_day[(ci, cj)]
                elif (cj, ci) in pair_corr_day.index:
                    corr_val = pair_corr_day[(cj, ci)]

                if corr_val is None or math.isnan(corr_val):
                    continue

                # Check |corr| > threshold
                if abs(corr_val) < pair_corr_thresh:
                    continue

                doi_i = records[ci]["doi"]
                doi_j = records[cj]["doi"]

                # Both must exceed noise floor
                if abs(doi_i) < min_doi_abs or abs(doi_j) < min_doi_abs:
                    continue

                # Magnitude ratio check
                ratio = abs(doi_i) / abs(doi_j) if abs(doi_j) > 0 else float("inf")
                if not (1.0 / pair_ratio_max <= ratio <= pair_ratio_max):
                    continue

                # Attribute min magnitude to spread
                spread_amount = int(min(abs(doi_i), abs(doi_j)))
                sign_i = int(np.sign(doi_i)) if doi_i != 0 else 1
                sign_j = int(np.sign(doi_j)) if doi_j != 0 else 1

                records[ci]["doi_spread_attributed"] += spread_amount
                records[ci]["doi_outright"] = doi_i - sign_i * spread_amount
                records[ci]["spread_type"] = "calendar"
                records[ci]["spread_partner"] = cj
                # curve_flow: sign(ΔOI_i) × spread_amount
                records[ci]["curve_flow"] = float(sign_i * spread_amount)
                attributed.add(ci)

                records[cj]["doi_spread_attributed"] += spread_amount
                records[cj]["doi_outright"] = doi_j - sign_j * spread_amount
                records[cj]["spread_type"] = "calendar"
                records[cj]["spread_partner"] = ci
                records[cj]["curve_flow"] = float(sign_j * spread_amount)
                attributed.add(cj)
                break  # each contract can only be in one calendar pair per day

    return pd.DataFrame(list(records.values()))


# ---------------------------------------------------------------------------
# Full pipeline
# ---------------------------------------------------------------------------

def build_spread_signal(
    conn,
    start_date: date,
    end_date: date,
    as_of_date: date,
    params: dict,
    instrument_roots: list[str] | None = None,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """
    Full pipeline over the date range.

    Returns (spread_detail_df, curve_df):

    spread_detail_df — indexed by (contract_id, trade_date):
        doi, doi_spread_attributed, doi_outright,
        spread_type ("bundle"|"pack"|"calendar"|"outright"),
        spread_partner (str or None),
        curve_flow,
        spread_share_daily  # doi_spread_attributed / |doi| per contract

    curve_df — indexed by trade_date:
        curve_dv01_flow,      # SUM(curve_flow × 25) across contracts
        curve_position,       # accumulated with decay
        curve_zscore,         # trailing 252-day z-score
        curve_weekly_change,  # curve_position(t) - curve_position(t-5)
        spread_share,         # SUM(doi_spread_attributed) / SUM(|doi|) for the day
    """
    sp = params.get("spreads", {})
    dv01_per = float(params["dv01"]["eur_per_bp_per_contract"])

    # Halflife for curve position — use blues halflife (longest bucket)
    hl_blues = int(params["signal"]["halflife_blues_days"])
    lam_curve = math.exp(-math.log(2.0) / hl_blues)

    # Build DOI matrix
    doi_matrix = build_doi_matrix(conn, start_date, end_date, as_of_date, params, instrument_roots=instrument_roots)
    if doi_matrix.empty:
        return pd.DataFrame(), pd.DataFrame()

    # Rolling pair correlations
    pair_corr_df = compute_rolling_pair_corr(doi_matrix, params)

    # Get quarterly contract order from DB (sorted by expiry)
    contract_order_sql = """
        SELECT contract_id, expiry_date
        FROM contracts
        WHERE contract_type = 'quarterly'
        ORDER BY expiry_date
    """
    contract_rows = conn.execute(contract_order_sql).fetchall()
    global_quarterly_order = [r[0] for r in contract_rows]

    all_detail_rows = []
    dates = sorted(doi_matrix.index)

    for td in dates:
        doi_day = doi_matrix.loc[td].dropna()

        # Active quarterly contracts for this day (present in doi_matrix and non-NaN)
        active_contracts = [c for c in global_quarterly_order if c in doi_day.index]

        # Rolling correlation for this day
        pair_corr_day = None
        if not pair_corr_df.empty and td in pair_corr_df.index:
            row = pair_corr_df.loc[td]
            if isinstance(row, pd.DataFrame):
                row = row.iloc[0]
            pair_corr_day = row.dropna()

        day_df = detect_spreads_day(
            doi_day=doi_day,
            quarterly_order=active_contracts,
            pair_corr_day=pair_corr_day,
            params=params,
        )
        day_df["trade_date"] = td
        all_detail_rows.append(day_df)

    if not all_detail_rows:
        return pd.DataFrame(), pd.DataFrame()

    detail_df = pd.concat(all_detail_rows, ignore_index=True)

    # Compute spread_share_daily per contract-day
    doi_abs = detail_df["doi"].abs()
    detail_df["spread_share_daily"] = np.where(
        doi_abs > 0,
        detail_df["doi_spread_attributed"] / doi_abs,
        0.0,
    ).clip(0.0, 1.0)

    # Set MultiIndex
    detail_df = detail_df.set_index(["contract_id", "trade_date"])

    # ------------------------------------------------------------------
    # Curve DataFrame — daily aggregates
    # ------------------------------------------------------------------
    curve_rows = []
    detail_reset = detail_df.reset_index()

    for td in dates:
        day = detail_reset[detail_reset["trade_date"] == td]
        curve_flow_sum = day["curve_flow"].sum()
        doi_spread_total = day["doi_spread_attributed"].abs().sum()
        doi_abs_total = day["doi"].abs().sum()
        spread_share = doi_spread_total / doi_abs_total if doi_abs_total > 0 else 0.0

        curve_rows.append({
            "trade_date":       td,
            "curve_dv01_flow":  curve_flow_sum * dv01_per,
            "_curve_flow_raw":  curve_flow_sum,
            "spread_share":     float(spread_share),
        })

    curve_df = pd.DataFrame(curve_rows).set_index("trade_date").sort_index()

    # Accumulate curve position with exponential decay
    curve_flow_arr = curve_df["_curve_flow_raw"].values
    curve_pos_arr  = np.zeros(len(curve_flow_arr))
    p_curve = 0.0
    for i, cf in enumerate(curve_flow_arr):
        if math.isnan(cf):
            p_curve = lam_curve * p_curve
        else:
            p_curve = lam_curve * p_curve + cf
        curve_pos_arr[i] = p_curve

    curve_df["curve_position"] = curve_pos_arr

    # Z-score (trailing 252-day)
    pos_series = curve_df["curve_position"]
    roll_mean = pos_series.rolling(window=252, min_periods=20).mean()
    roll_std  = pos_series.rolling(window=252, min_periods=20).std()
    curve_df["curve_zscore"] = (pos_series - roll_mean) / roll_std.replace(0, np.nan)

    # Weekly change
    curve_df["curve_weekly_change"] = pos_series - pos_series.shift(5)

    # Drop internal helper column
    curve_df.drop(columns=["_curve_flow_raw"], inplace=True)

    return detail_df, curve_df


# ---------------------------------------------------------------------------
# Weekly spread validation (acceptance test helper)
# ---------------------------------------------------------------------------

def compute_weekly_spread_validation(
    curve_df: pd.DataFrame,
    conn,
    params: dict,
) -> pd.DataFrame:
    """
    Align weekly spread_share estimate with COT spreading category.

    Weekly spread_share: resample curve_df["spread_share"] to Friday (last value of week).
    COT spreading: from cot_obs, join on publication_date (Friday).
    COT spreading share: cot_obs.spreading / (long_positions + short_positions + spreading)
      for all categories combined.

    Returns DataFrame with columns:
        friday_date, spread_share_estimated, cot_spreading_share,
        corr_rolling_12w  # rolling 12-week correlation
    """
    if curve_df.empty:
        return pd.DataFrame()

    # Weekly spread_share estimate — use weekly mean of daily spread_share.
    # Daily spread_share is 0 on non-spread days and elevated on detected spread days;
    # taking the weekly mean correctly captures the fraction of activity that was
    # spread-attributed across all days of the week.
    ss = curve_df["spread_share"].copy()
    ss.index = pd.to_datetime(ss.index)
    weekly_est = ss.resample("W-FRI").mean().dropna()

    # COT spreading
    cot_rows = conn.execute(
        """
        SELECT publication_date,
               SUM(long_positions)  AS total_long,
               SUM(short_positions) AS total_short,
               SUM(spreading)       AS total_spreading
        FROM cot_obs
        GROUP BY publication_date
        ORDER BY publication_date
        """
    ).fetchall()

    if not cot_rows:
        return pd.DataFrame()

    cot_df = pd.DataFrame([dict(r) for r in cot_rows])
    cot_df["publication_date"] = pd.to_datetime(cot_df["publication_date"])
    cot_df = cot_df.set_index("publication_date")

    total = cot_df["total_long"] + cot_df["total_short"] + cot_df["total_spreading"]
    cot_df["cot_spreading_share"] = cot_df["total_spreading"] / total.replace(0, np.nan)
    cot_weekly = cot_df["cot_spreading_share"].resample("W-FRI").last().dropna()

    # Align on inner join
    aligned = pd.concat(
        [weekly_est.rename("spread_share_estimated"), cot_weekly.rename("cot_spreading_share")],
        axis=1,
        join="inner",
    ).dropna()

    if aligned.empty:
        return pd.DataFrame()

    # Rolling 12-week correlation
    if len(aligned) >= 4:
        corr_rolling = (
            aligned["spread_share_estimated"]
            .rolling(window=12, min_periods=4)
            .corr(aligned["cot_spreading_share"])
        )
    else:
        corr_rolling = pd.Series(np.nan, index=aligned.index)

    aligned["corr_rolling_12w"] = corr_rolling
    aligned.index.name = "friday_date"
    aligned = aligned.reset_index()

    return aligned


# ---------------------------------------------------------------------------
# Stage 5 output: spread-adjusted quadrant signal
# ---------------------------------------------------------------------------

def spread_adjusted_quadrant_signal(
    conn,
    start_date: date,
    end_date: date,
    as_of_date: date,
    params: dict,
    instrument_roots: list[str] | None = None,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """
    Build the full Stage 5 output: quadrant signal corrected for spreads.

    1. Calls build_quadrant_signal() (Stage 4) to get the base signal.
    2. Calls build_spread_signal() to get doi_outright per contract-day.
    3. Replaces doi in the quadrant signal with doi_outright.
    4. Recomputes flow_quadrant and position_quadrant using doi_outright.

    Returns (corrected_outright_df, curve_df) where:
      corrected_outright_df has the same columns as build_quadrant_signal() output,
      but doi and flow_quadrant/position_quadrant are spread-corrected.
      curve_df is the curve positioning DataFrame from build_spread_signal().
    """
    from .base_signal import _decay_lambda

    # Stage 4 signal
    qsig = build_quadrant_signal(conn, start_date, end_date, as_of_date, params, instrument_roots=instrument_roots)
    if qsig.empty:
        return qsig, pd.DataFrame()

    # Spread detection
    spread_detail, curve_df = build_spread_signal(
        conn, start_date, end_date, as_of_date, params, instrument_roots=instrument_roots
    )

    if spread_detail.empty:
        return qsig, curve_df

    dv01_per = float(params["dv01"]["eur_per_bp_per_contract"])

    # Merge doi_outright into the quadrant signal
    spread_reset = spread_detail.reset_index()[
        ["contract_id", "trade_date", "doi_outright"]
    ]

    df = qsig.reset_index()
    df = df.merge(spread_reset, on=["contract_id", "trade_date"], how="left")

    # Replace doi with doi_outright where available
    df["doi"] = df["doi_outright"].combine_first(df["doi"])
    df.drop(columns=["doi_outright"], inplace=True)

    # Recompute flow_quadrant using outright doi (preserve flow_quadrant direction probability)
    # flow_quadrant_i(t) = |doi_outright| × net_dir_prob × w_adjusted × (not draining)
    # net_dir_prob is already stored in the column "flow_quadrant" as the scaled value;
    # we need to re-derive net_dir_prob = flow_quadrant / (|doi_original| × w_adjusted)
    # but that risks division issues. Instead, recompute from the probability columns directly:
    # net_dir_prob = p_lb - p_sb - p_ll + p_sc
    net_dir_prob = (
        df["p_long_build"]
        - df["p_short_build"]
        - df["p_long_liquidation"]
        + df["p_short_covering"]
    ).fillna(0.0)

    doi_abs_outright = df["doi"].abs().fillna(0.0)
    w_adj = df["w_adjusted"].fillna(0.0)
    is_drain = df["is_draining"].values
    in_db = df["in_deadband"].values

    # Deadband rows contribute 0
    scaled_flow = (
        doi_abs_outright.values
        * net_dir_prob.values
        * w_adj.values
        * (~is_drain).astype(float)
        * (~in_db).astype(float)
    )
    df["flow_quadrant"] = scaled_flow
    df["dv01_flow_quadrant"] = scaled_flow * dv01_per

    # Recompute position_quadrant per contract
    pos_q_list = []
    for cid, grp in df.groupby("contract_id", sort=False):
        grp_s = grp.sort_values("trade_date").copy()
        hl = int(grp_s["halflife"].iloc[0])
        lam = math.exp(-math.log(2.0) / hl)

        flow_vals = grp_s["flow_quadrant"].values
        pos_arr = np.zeros(len(flow_vals))
        p = 0.0
        for i, f in enumerate(flow_vals):
            if np.isnan(f):
                p = lam * p
            else:
                p = lam * p + f
            pos_arr[i] = p
        pos_q_list.append(pd.Series(pos_arr, index=grp_s.index))

    df["position_quadrant"] = pd.concat(pos_q_list).reindex(df.index)
    df["dv01_position_quadrant"] = df["position_quadrant"] * dv01_per

    df = df.set_index(["contract_id", "trade_date"])
    return df, curve_df
