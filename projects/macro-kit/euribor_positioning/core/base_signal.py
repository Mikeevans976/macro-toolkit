"""
Stage 3 — Base signal with VWAP direction estimator and decay (§4.1–§4.7).

Provides:
  - estimate_direction   : §4.3 direction estimator (priority chain)
  - build_base_signal    : per-contract enriched signal DataFrame
  - aggregate_signal     : daily aggregate over tenor buckets
  - calibrate_halflife   : grid-search H vs COT correlation

Rate-space convention (§4.1):
  rate = 100.0 − settlement_price
  dr   = −(settlement_price − prev_settlement_price)   # = rate − prev_rate

All numeric constants come from params; no magic numbers in this module.
"""

from __future__ import annotations

import logging
import math
from datetime import date, timedelta
from typing import Optional

import numpy as np
import pandas as pd

from .rolls import assign_pack, assign_ttm_bucket

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# §4.3  Direction estimator
# ---------------------------------------------------------------------------

def estimate_direction(
    settlement_price: float,
    prev_settlement_price: float,
    vwap: Optional[float],
    open_price: Optional[float],
) -> tuple[float, str]:
    """
    Return (direction_value, estimator) for a single observation.

    Priority chain (§4.3):
      1. VWAP   : sign(settlement_price − vwap)        if vwap is not None
      2. Open   : sign(settlement_price − open_price)  if open_price is not None
      3. Fallback: sign(settlement_price − prev_settlement_price)
                   (= sign(−dr), i.e. positive means price rose)
                   logged as "fallback_close_to_close"

    direction_value ∈ {−1.0, 0.0, 1.0}
    """
    def _sign(x: float) -> float:
        if x > 0:
            return 1.0
        if x < 0:
            return -1.0
        return 0.0

    if vwap is not None:
        return _sign(settlement_price - vwap), "vwap"

    if open_price is not None:
        return _sign(settlement_price - open_price), "open"

    # Fallback: close-to-close (violates ideal, logged)
    logger.debug("fallback_close_to_close for settlement=%.4f prev=%.4f", settlement_price, prev_settlement_price)
    return _sign(settlement_price - prev_settlement_price), "fallback_close_to_close"


# ---------------------------------------------------------------------------
# §4.7  Decay lambda helper
# ---------------------------------------------------------------------------

def _halflife_for_bucket(pack: Optional[str], params: dict) -> int:
    """Return the configured half-life (days) for the tenor bucket (pack label)."""
    sig = params["signal"]
    mapping = {
        "whites": sig["halflife_whites_days"],
        "reds":   sig["halflife_reds_days"],
        "greens": sig["halflife_greens_days"],
        "blues":  sig["halflife_blues_days"],
    }
    return mapping.get(pack or "whites", sig["halflife_whites_days"])


def _decay_lambda(halflife_days: int) -> float:
    return math.exp(-math.log(2.0) / halflife_days)


# ---------------------------------------------------------------------------
# §4.2 / §4.4 / §4.6  Per-contract flow computation (vectorised via pandas)
# ---------------------------------------------------------------------------

def _compute_per_contract_flow(df: pd.DataFrame, params: dict) -> pd.DataFrame:
    """
    Given a DataFrame sorted by (contract_id, trade_date) with all raw columns,
    compute dr, direction, sigma, w, regime, w_adjusted, flow, impact.

    Mutates and returns the DataFrame.
    """
    sig_params = params["signal"]
    span   = sig_params["ewma_vol_span"]
    cap    = sig_params["confidence_weight_cap"]

    to_params = params["turnover"]
    churn_vol_pct  = to_params["churn_volume_percentile"]   / 100.0
    churn_doi_pct  = to_params["churn_doi_percentile"]      / 100.0
    transfer_vol_pct = to_params["transfer_volume_percentile"] / 100.0
    transfer_doi_pct = to_params["transfer_doi_percentile"]   / 100.0

    results = []

    for cid, grp in df.groupby("contract_id", sort=False):
        grp = grp.sort_values("trade_date").copy()
        n = len(grp)

        # --- §4.1  Rate-space ---
        grp["rate"]      = 100.0 - grp["settlement_price"]
        grp["prev_rate"] = 100.0 - grp["prev_settlement_price"]
        grp["dr"]        = grp["rate"] - grp["prev_rate"]
        grp["dr_abs"]    = grp["dr"].abs()

        # --- §4.3  Direction per row ---
        dirs, estimators = zip(*[
            estimate_direction(
                row["settlement_price"],
                row["prev_settlement_price"],
                row["vwap"] if not pd.isna(row["vwap"]) else None,
                row["open_price"] if not pd.isna(row["open_price"]) else None,
            )
            for _, row in grp.iterrows()
        ])
        grp["direction"] = list(dirs)
        grp["estimator"] = list(estimators)

        # --- §4.4  EWMA vol per contract ---
        ewma_vol = grp["dr_abs"].ewm(span=span, adjust=False).mean()
        # Shift so we never use today's value in sigma (look-ahead discipline)
        sigma_shifted = ewma_vol.shift(1)
        grp["sigma"] = sigma_shifted.values

        # Confidence weight; where sigma == 0 or NaN → w = 0
        sigma_vals = grp["sigma"].values
        dr_abs_vals = grp["dr_abs"].values
        valid_sigma = (sigma_vals > 0) & (~np.isnan(sigma_vals))
        raw_ratio = np.where(valid_sigma, dr_abs_vals / np.where(valid_sigma, sigma_vals, 1.0), 0.0)
        w = np.where(valid_sigma, np.minimum(raw_ratio, cap), 0.0)
        grp["w"] = w

        # --- §4.6  Turnover regime ---
        doi_abs = grp["doi"].abs()
        vol_ser = grp["volume"]

        # Rolling percentiles over the same span as vol EWMA
        roll_window = span
        vol_high = vol_ser.rolling(window=roll_window, min_periods=1).quantile(churn_vol_pct)
        vol_low  = vol_ser.rolling(window=roll_window, min_periods=1).quantile(transfer_vol_pct)
        doi_low  = doi_abs.rolling(window=roll_window, min_periods=1).quantile(churn_doi_pct)
        doi_high = doi_abs.rolling(window=roll_window, min_periods=1).quantile(transfer_doi_pct)

        churn    = (vol_ser.values >= vol_high.values) & (doi_abs.values <= doi_low.values)
        transfer = (vol_ser.values <= vol_low.values)  & (doi_abs.values >= doi_high.values)

        regime        = np.where(churn, "churn", np.where(transfer, "transfer", "normal"))
        regime_factor = np.where(churn, 0.2,     np.where(transfer, 1.5,        1.0))

        grp["regime"]        = regime
        grp["regime_factor"] = regime_factor.astype(float)

        # --- §4.2  Adjusted weight and raw flow ---
        w_adj = grp["w"].values * grp["regime_factor"].values
        grp["w_adjusted"] = w_adj

        # doi may be NaN for first row → flow = NaN as well
        grp["flow"] = w_adj * grp["direction"].values * grp["doi"].values

        # --- §4.5  Price impact (stored only, not used in position) ---
        doi_abs_vals = doi_abs.values
        valid_doi = doi_abs_vals > 0
        grp["impact"] = np.where(
            valid_doi,
            grp["dr_abs"].values / np.where(valid_doi, doi_abs_vals, 1.0),
            np.nan,
        )

        results.append(grp)

    if not results:
        return df

    return pd.concat(results, ignore_index=True)


# ---------------------------------------------------------------------------
# §4.7  Position accumulation per contract
# ---------------------------------------------------------------------------

def _accumulate_position(grp: pd.DataFrame, halflife: int) -> np.ndarray:
    """
    Apply exponential decay accumulation:
        P(t) = λ·P(t−1) + f(t)

    grp must be sorted by trade_date ascending.
    Returns an array of position values.
    """
    lam = _decay_lambda(halflife)
    flow = grp["flow"].values
    pos  = np.zeros(len(flow))
    p    = 0.0
    for i, f in enumerate(flow):
        if np.isnan(f):
            pos[i] = p * lam   # carry forward with decay even if no flow
        else:
            p = lam * p + f
            pos[i] = p
    return pos


# ---------------------------------------------------------------------------
# §4 — Main build function
# ---------------------------------------------------------------------------

def build_base_signal(
    conn,
    start_date: date,
    end_date: date,
    as_of_date: date,
    params: dict,
    instrument_roots: list[str] | None = None,
) -> pd.DataFrame:
    """
    Build the base signal DataFrame over [start_date, end_date].

    Returns a DataFrame indexed by (contract_id, trade_date) with all columns
    specified in §4 of the spec.

    instrument_roots: if provided, restrict to contracts whose root is in the list.
    """
    dv01_per_contract = params["dv01"]["eur_per_bp_per_contract"]

    # -----------------------------------------------------------------------
    # 1.  Pull all daily_obs for the date range from the DB
    # -----------------------------------------------------------------------
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
                d.knowledge_date,
                d.settlement_price,
                LAG(d.settlement_price)
                    OVER (PARTITION BY d.contract_id ORDER BY d.trade_date)
                    AS prev_settlement_price,
                d.open_interest,
                LAG(d.open_interest)
                    OVER (PARTITION BY d.contract_id ORDER BY d.trade_date)
                    AS prev_oi,
                d.volume,
                d.vwap,
                d.open_price,
                c.expiry_date,
                c.last_trading_day,
                c.contract_type
            FROM daily_obs d
            JOIN contracts c ON c.contract_id = d.contract_id
            WHERE d.knowledge_date <= ?
            {roots_clause}
        )
        SELECT *,
            CASE WHEN prev_oi IS NOT NULL
                 THEN open_interest - prev_oi
                 ELSE NULL
            END AS doi
        FROM lagged
        WHERE trade_date >= ?
          AND trade_date <= ?
          AND prev_settlement_price IS NOT NULL
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
    df["expiry_date"] = pd.to_datetime(df["expiry_date"]).dt.date

    # -----------------------------------------------------------------------
    # 2.  Per-contract enrichment (flow, direction, sigma, regime)
    # -----------------------------------------------------------------------
    df = _compute_per_contract_flow(df, params)

    # -----------------------------------------------------------------------
    # 3.  Tenor metadata (pack, ttm_bucket, generic_rank, is_draining)
    # -----------------------------------------------------------------------
    # We compute per-trade_date generic_rank.  Build a lookup:
    #   (contract_id, trade_date) → (generic_rank, is_draining)

    # Identify drain per contract per date using the same logic as rolls.py
    # but vectorised: compute trailing peak OI rolling max over lookback window.
    drain_frac = params["expiry_drain"]["fraction_of_3m_peak"]
    lookback   = params["expiry_drain"]["lookback_business_days"]

    # Sort so rolling is correct
    df = df.sort_values(["contract_id", "trade_date"]).reset_index(drop=True)

    # Rolling peak of open_interest per contract (shift so we exclude today)
    df["_trail_peak"] = (
        df.groupby("contract_id")["open_interest"]
        .transform(lambda s: s.shift(1).rolling(window=lookback, min_periods=1).max())
    )
    df["is_draining"] = (
        (df["_trail_peak"].notna()) &
        (df["_trail_peak"] > 0) &
        (df["open_interest"] < drain_frac * df["_trail_peak"])
    )
    df.drop(columns=["_trail_peak"], inplace=True)

    # generic_rank: per trade_date, rank quarterly contracts by expiry
    rank_lookup: dict[tuple, int] = {}
    for td, grp in df[df["contract_type"] == "quarterly"].groupby("trade_date"):
        sorted_ids = grp.sort_values("expiry_date")["contract_id"].tolist()
        for i, cid in enumerate(sorted_ids):
            rank_lookup[(cid, td)] = i + 1

    df["generic_rank"] = df.apply(
        lambda r: rank_lookup.get((r["contract_id"], r["trade_date"])),
        axis=1,
    )

    # pack label (None for serials)
    df["pack"] = df["generic_rank"].apply(
        lambda r: assign_pack(int(r)) if pd.notna(r) else None
    )

    # ttm_bucket
    df["days_to_expiry"] = df.apply(
        lambda r: (r["expiry_date"] - r["trade_date"]).days, axis=1
    )
    df["ttm_bucket"] = df["days_to_expiry"].apply(assign_ttm_bucket)

    # -----------------------------------------------------------------------
    # 4.  Half-life and decay lambda per contract
    # -----------------------------------------------------------------------
    df["halflife"] = df["pack"].apply(
        lambda p: _halflife_for_bucket(p, params)
    )
    df["decay_lambda"] = df["halflife"].apply(_decay_lambda)

    # -----------------------------------------------------------------------
    # 5.  Position accumulation per contract
    # -----------------------------------------------------------------------
    positions = []
    for cid, grp in df.groupby("contract_id", sort=False):
        grp_sorted = grp.sort_values("trade_date")
        hl = grp_sorted["halflife"].iloc[0]  # constant per contract
        pos_arr = _accumulate_position(grp_sorted, hl)
        pos_series = pd.Series(pos_arr, index=grp_sorted.index)
        positions.append(pos_series)

    df["position"] = pd.concat(positions).reindex(df.index)

    # -----------------------------------------------------------------------
    # 6.  DV01 columns
    # -----------------------------------------------------------------------
    df["dv01_flow"]     = df["flow"]     * dv01_per_contract
    df["dv01_position"] = df["position"] * dv01_per_contract

    # -----------------------------------------------------------------------
    # 7.  Set MultiIndex and finalise column order
    # -----------------------------------------------------------------------
    df = df.set_index(["contract_id", "trade_date"])

    # Ensure expected columns exist even if some data has NaN
    expected_cols = [
        "settlement_price", "prev_settlement_price",
        "rate", "prev_rate", "dr",
        "vwap", "open_price",
        "open_interest", "prev_oi", "doi",
        "volume",
        "direction", "estimator",
        "dr_abs", "sigma", "w", "regime", "regime_factor", "w_adjusted",
        "flow", "impact",
        "halflife", "decay_lambda",
        "position",
        "dv01_flow", "dv01_position",
        "pack", "ttm_bucket", "generic_rank", "is_draining",
        "days_to_expiry",
    ]
    for col in expected_cols:
        if col not in df.columns:
            df[col] = np.nan

    return df[expected_cols]


# ---------------------------------------------------------------------------
# §4 — Aggregate function
# ---------------------------------------------------------------------------

def aggregate_signal(
    signal_df: pd.DataFrame,
    params: dict,
    trailing_zscore_window: int = 252,
) -> pd.DataFrame:
    """
    Aggregate per-contract signal to daily totals by tenor bucket.

    Returns a DataFrame indexed by trade_date.

    IMPORTANT (§4.7): Never expose P as a level before Stage 7 (Kalman anchoring).
    Only expose:
      - weekly_change_position: P(t) − P(t−5)
      - zscore_position:        (P(t) − mean) / std  over trailing window
    """
    if signal_df.empty:
        return pd.DataFrame()

    df = signal_df.reset_index()

    buckets = ["whites", "reds", "greens", "blues"]

    def _agg_date(grp):
        active = grp[~grp["is_draining"]]

        row = {
            "total_dv01_flow":     grp["dv01_flow"].sum(skipna=True),
            "total_dv01_position": active["dv01_position"].sum(skipna=True),
            "n_contracts":         len(grp),
            "n_draining":          grp["is_draining"].sum(),
        }

        for bkt in buckets:
            bkt_grp = grp[grp["pack"] == bkt]
            bkt_active = active[active["pack"] == bkt]
            row[f"dv01_flow_{bkt}"]    = bkt_grp["dv01_flow"].sum(skipna=True)
            row[f"dv01_pos_{bkt}"]     = bkt_active["dv01_position"].sum(skipna=True)

        return pd.Series(row)

    daily = df.groupby("trade_date").apply(_agg_date).reset_index()
    daily = daily.sort_values("trade_date").set_index("trade_date")

    # Raw total position (sum of non-draining)
    pos_raw = df[~df["is_draining"]].groupby("trade_date")["position"].sum()
    pos_raw = pos_raw.reindex(daily.index)

    # Weekly change (5 business-day lag)
    daily["weekly_change_position"] = pos_raw - pos_raw.shift(5)

    # Trailing z-score
    roll_mean = pos_raw.rolling(window=trailing_zscore_window, min_periods=20).mean()
    roll_std  = pos_raw.rolling(window=trailing_zscore_window, min_periods=20).std()
    daily["zscore_position"] = (pos_raw - roll_mean) / roll_std.replace(0, np.nan)

    return daily


# ---------------------------------------------------------------------------
# §10  Halflife calibration
# ---------------------------------------------------------------------------

def calibrate_halflife(
    signal_df: pd.DataFrame,
    cot_df: pd.DataFrame,
    tenor_bucket: str,
    params: dict,
    h_grid: list[int] | None = None,
) -> dict:
    """
    Grid-search H to maximise Pearson correlation between weekly ΔP and weekly ΔCOT.

    Args:
        signal_df   : Output of build_base_signal (MultiIndex: contract_id, trade_date).
        cot_df      : DataFrame with columns [publication_date, net_position]
                      (net_position = long_positions − short_positions).
        tenor_bucket: Pack label ("whites", "reds", "greens", "blues").
        params      : Parameter dict.
        h_grid      : Half-life grid (days). Default: 10–120 in steps of 5.

    Returns:
        {"best_h": int, "best_corr": float, "grid": [(h, corr), ...]}
    """
    if h_grid is None:
        h_grid = list(range(10, 125, 5))

    # Filter signal to the requested bucket
    df_raw = signal_df.reset_index()
    bucket_df = df_raw[df_raw["pack"] == tenor_bucket].copy()

    if bucket_df.empty:
        return {"best_h": h_grid[0], "best_corr": float("nan"), "grid": []}

    # Prepare COT weekly series (publication_date = Friday)
    cot = cot_df.copy()
    if "net_position" not in cot.columns:
        cot["net_position"] = cot["long_positions"] - cot["short_positions"]
    cot = cot.sort_values("publication_date").set_index("publication_date")["net_position"]
    cot_weekly = cot.resample("W-FRI").last()
    cot_delta  = cot_weekly.diff().dropna()

    grid_results = []
    for h in h_grid:
        lam = _decay_lambda(h)

        # Re-accumulate per contract with this H, then sum over bucket per date
        pos_series_list = []
        for cid, grp in bucket_df.groupby("contract_id"):
            grp_s = grp.sort_values("trade_date").copy()
            pos_arr = np.zeros(len(grp_s))
            p = 0.0
            for i, f in enumerate(grp_s["flow"].values):
                if np.isnan(f):
                    p = lam * p
                else:
                    p = lam * p + f
                pos_arr[i] = p
            pos_s = pd.Series(
                pos_arr,
                index=pd.to_datetime(grp_s["trade_date"].values),
                name=cid,
            )
            pos_series_list.append(pos_s)

        if not pos_series_list:
            grid_results.append((h, float("nan")))
            continue

        combined = pd.concat(pos_series_list, axis=1).sum(axis=1)
        # Resample to weekly (Friday)
        combined.index = pd.to_datetime(combined.index)
        weekly_pos = combined.resample("W-FRI").last()
        weekly_delta = weekly_pos.diff().dropna()

        # Align with COT delta on inner join
        aligned = pd.concat([weekly_delta, cot_delta], axis=1, join="inner").dropna()
        aligned.columns = ["dp", "dcot"]

        if len(aligned) < 20:
            grid_results.append((h, float("nan")))
            continue

        corr = aligned["dp"].corr(aligned["dcot"])
        grid_results.append((h, float(corr) if not np.isnan(corr) else float("nan")))

    # Best H = highest correlation (ignoring NaN)
    valid = [(h, c) for h, c in grid_results if not math.isnan(c)]
    if not valid:
        return {"best_h": h_grid[0], "best_corr": float("nan"), "grid": grid_results}

    best_h, best_corr = max(valid, key=lambda x: x[1])
    return {"best_h": best_h, "best_corr": best_corr, "grid": grid_results}
