"""
Stage 4 — Quadrant classifier with deadband and soft assignment (§5.1–§5.5).

Provides:
  - classify_row           : single-row classifier returning all quadrant fields
  - short_covering_confidence : multiplier for the short-covering signature
  - build_quadrant_signal  : full pipeline extending build_base_signal
  - aggregate_quadrant_signal : daily aggregated view with bucket-level stats
  - calibrate_deadband_k   : grid-search k vs COT correlation

Quadrant labels (§5.1) in *rate* space:
  long_build      : Δr < 0, ΔOI > 0  (fresh receiving / dovish risk)
  short_build     : Δr > 0, ΔOI > 0  (fresh paying / hawkish risk)
  short_covering  : Δr < 0, ΔOI < 0  (hawkish risk cut under duress)
  long_liquidation: Δr > 0, ΔOI < 0  (dovish risk cut)
"""

from __future__ import annotations

import math
from datetime import date

import numpy as np
import pandas as pd

from .base_signal import build_base_signal


# ---------------------------------------------------------------------------
# Soft assignment helpers
# ---------------------------------------------------------------------------

def _sigmoid(x: float) -> float:
    """Numerically-stable sigmoid: 1 / (1 + exp(x))."""
    if x >= 0:
        return 1.0 / (1.0 + math.exp(-(-x)))  # = 1/(1+exp(x))
    # for very negative x, exp(-x) is huge but we want sigmoid(x) near 1
    # Re-write: sigmoid(x) = exp(-x)/(1+exp(-x)) when x < 0 avoids overflow
    ex = math.exp(-x)
    return ex / (1.0 + ex)


def _p_dir_long(dr: float, sigma: float) -> float:
    """
    Logistic probability that direction is 'long' (rates fell).
    p_dir_long = sigmoid(−Δr / σ) = 1 / (1 + exp(Δr / σ))

    Special cases:
      - sigma = 0  → 0.5 (maximum uncertainty)
      - dr   = 0   → 0.5
    """
    if sigma == 0.0 or (math.isnan(sigma) if isinstance(sigma, float) else False):
        return 0.5
    if sigma != sigma:  # NaN check
        return 0.5
    ratio = dr / sigma
    # sigmoid(−ratio) = 1/(1+exp(ratio))
    try:
        return 1.0 / (1.0 + math.exp(ratio))
    except OverflowError:
        return 0.0 if ratio > 0 else 1.0


def _p_oi_up(doi: int) -> float:
    """Probability that ΔOI > 0: 1.0, 0.0, or 0.5 on the boundary."""
    if doi > 0:
        return 1.0
    if doi < 0:
        return 0.0
    return 0.5


# ---------------------------------------------------------------------------
# Short covering confidence
# ---------------------------------------------------------------------------

def short_covering_confidence(
    dr: float,
    doi: int,
    volume: float,
    avg_volume_20d: float,
    price_impact: float,
    avg_impact_20d: float,
    params: dict,
) -> float:
    """
    Returns multiplier ≥ 1.0 if the short-covering signature is present.

    Signature (all four conditions must hold):
      1. doi < 0
      2. dr  < 0
      3. volume > vol_threshold × avg_volume_20d
      4. price_impact > impact_threshold × avg_impact_20d

    When the signature is present the multiplier equals
    params["quadrant"]["short_covering_multiplier_max"]; otherwise 1.0.
    """
    qp = params.get("quadrant", {})
    vol_threshold    = qp.get("short_covering_volume_threshold", 1.5)
    impact_threshold = qp.get("short_covering_impact_threshold", 1.5)
    multiplier_max   = qp.get("short_covering_multiplier_max", 2.0)

    if (
        doi < 0
        and dr < 0
        and avg_volume_20d > 0
        and volume > vol_threshold * avg_volume_20d
        and not math.isnan(price_impact)
        and not math.isnan(avg_impact_20d)
        and avg_impact_20d > 0
        and price_impact > impact_threshold * avg_impact_20d
    ):
        return float(multiplier_max)

    return 1.0


# ---------------------------------------------------------------------------
# Single-row classifier
# ---------------------------------------------------------------------------

def classify_row(
    dr: float,
    doi: int,
    sigma: float,
    volume: float,
    prev_oi: int,
    doi_abs_median: float,
    avg_volume_20d: float,
    price_impact: float,
    avg_impact_20d: float,
    params: dict,
) -> dict:
    """
    Classify a single contract-day observation.

    Returns dict with fields:
      p_long_build, p_short_build, p_short_covering, p_long_liquidation,
      p_oi_up, p_dir_long, hard_label, in_deadband, sc_multiplier,
      flow_quadrant  (net direction probability — caller scales by |doi| × w_adjusted)
    """
    qp = params.get("quadrant", {})
    k               = float(qp.get("deadband_k", 0.30))
    oi_fraction     = float(qp.get("deadband_oi_fraction", 0.005))

    # ------------------------------------------------------------------
    # 1. Deadband checks
    # ------------------------------------------------------------------
    # Price deadband: |Δr| < k × σ_EW
    price_db_threshold = k * (sigma if (sigma == sigma and sigma > 0) else 0.0)
    price_in_db = abs(dr) < price_db_threshold

    # OI deadband: |ΔOI| < max(oi_fraction × OI_{t-1}, rolling_median|ΔOI|)
    oi_db_threshold = max(
        oi_fraction * abs(prev_oi) if prev_oi is not None else 0.0,
        doi_abs_median if (doi_abs_median == doi_abs_median) else 0.0,
    )
    oi_in_db = abs(doi) < oi_db_threshold

    in_deadband = price_in_db or oi_in_db

    # ------------------------------------------------------------------
    # 2. Soft probabilities (always computed, even in deadband)
    # ------------------------------------------------------------------
    p_up   = _p_oi_up(doi)
    p_long = _p_dir_long(dr, sigma)

    p_lb = p_up * p_long           # long_build
    p_sb = p_up * (1.0 - p_long)   # short_build
    p_sc = (1.0 - p_up) * p_long   # short_covering
    p_ll = (1.0 - p_up) * (1.0 - p_long)  # long_liquidation

    # ------------------------------------------------------------------
    # 3. Short covering confidence multiplier + renormalise
    # ------------------------------------------------------------------
    sc_multiplier = short_covering_confidence(
        dr, doi, volume, avg_volume_20d,
        price_impact, avg_impact_20d,
        params,
    )

    if sc_multiplier > 1.0:
        p_sc_boosted = p_sc * sc_multiplier
        total = p_lb + p_sb + p_sc_boosted + p_ll
        if total > 0:
            p_lb /= total
            p_sb /= total
            p_sc  = p_sc_boosted / total
            p_ll /= total
        # sc_multiplier already stored; recompute for bookkeeping
    else:
        p_sc = p_sc  # no change

    # ------------------------------------------------------------------
    # 4. Hard label: argmax; "unclassified" in deadband
    # ------------------------------------------------------------------
    if in_deadband:
        hard_label = "unclassified"
    else:
        labels = ["long_build", "short_build", "short_covering", "long_liquidation"]
        probs  = [p_lb, p_sb, p_sc, p_ll]
        hard_label = labels[int(np.argmax(probs))]

    # ------------------------------------------------------------------
    # 5. Net direction probability for quadrant-adjusted flow
    # ------------------------------------------------------------------
    # Positive when long-oriented dominates
    net_dir_prob = p_lb - p_sb - p_ll + p_sc

    # flow_quadrant = net_dir_prob (caller multiplies by |doi| × w_adjusted)
    # Deadband rows get 0 contribution
    flow_quadrant = net_dir_prob if not in_deadband else 0.0

    return {
        "p_long_build":       p_lb,
        "p_short_build":      p_sb,
        "p_short_covering":   p_sc,
        "p_long_liquidation": p_ll,
        "p_oi_up":            p_up,
        "p_dir_long":         p_long,
        "hard_label":         hard_label,
        "in_deadband":        in_deadband,
        "sc_multiplier":      sc_multiplier,
        "flow_quadrant":      flow_quadrant,
    }


# ---------------------------------------------------------------------------
# Full pipeline
# ---------------------------------------------------------------------------

def build_quadrant_signal(
    conn,
    start_date: date,
    end_date: date,
    as_of_date: date,
    params: dict,
    instrument_roots: list[str] | None = None,
) -> pd.DataFrame:
    """
    Full pipeline: base signal + quadrant classification + quadrant-adjusted position.

    Extends build_base_signal() output with quadrant columns.
    Returns DataFrame (same MultiIndex) with all Stage 3 columns plus:
      p_long_build, p_short_build, p_short_covering, p_long_liquidation,
      p_oi_up, p_dir_long, hard_label, in_deadband, sc_multiplier,
      flow_quadrant, dv01_flow_quadrant,
      position_quadrant, dv01_position_quadrant
    """
    sig = build_base_signal(conn, start_date, end_date, as_of_date, params, instrument_roots=instrument_roots)
    if sig.empty:
        return sig

    dv01_per_contract = params["dv01"]["eur_per_bp_per_contract"]
    sig_params        = params["signal"]
    span              = sig_params["ewma_vol_span"]

    df = sig.reset_index()  # contract_id, trade_date as columns

    # ------------------------------------------------------------------
    # Per-contract enrichment: rolling medians for OI deadband,
    # rolling 20-day averages for volume and price impact
    # ------------------------------------------------------------------
    quadrant_rows = []

    for cid, grp in df.groupby("contract_id", sort=False):
        grp = grp.sort_values("trade_date").copy()

        doi_abs = grp["doi"].abs()

        # Rolling median of |ΔOI| over ewma_vol_span window
        doi_abs_median = doi_abs.rolling(window=span, min_periods=5).median()
        # Shift to avoid look-ahead: use preceding window's median
        doi_abs_median_shifted = doi_abs_median.shift(1).fillna(0.0)

        # 20-session rolling average of volume and price impact
        avg_volume_20d = grp["volume"].rolling(window=20, min_periods=5).mean().shift(1).fillna(0.0)
        avg_impact_20d = grp["impact"].rolling(window=20, min_periods=5).mean().shift(1)
        # NaN avg_impact means no history — treat as 0 (no multiplier)
        avg_impact_20d = avg_impact_20d.fillna(0.0)

        grp["_doi_abs_median"] = doi_abs_median_shifted.values
        grp["_avg_volume_20d"] = avg_volume_20d.values
        grp["_avg_impact_20d"] = avg_impact_20d.values

        quadrant_rows.append(grp)

    df = pd.concat(quadrant_rows, ignore_index=True)
    df = df.sort_values(["contract_id", "trade_date"]).reset_index(drop=True)

    # ------------------------------------------------------------------
    # Row-by-row classification
    # ------------------------------------------------------------------
    records = []
    for _, row in df.iterrows():
        dr    = row["dr"]   if not pd.isna(row["dr"])  else 0.0
        doi_v = int(row["doi"]) if not pd.isna(row["doi"]) else 0
        sigma = row["sigma"] if not pd.isna(row["sigma"]) else 0.0
        vol   = row["volume"] if not pd.isna(row["volume"]) else 0.0
        prev_oi_v = int(row["prev_oi"]) if not pd.isna(row["prev_oi"]) else 0
        doi_median = float(row["_doi_abs_median"])
        avg_vol    = float(row["_avg_volume_20d"])
        impact_v   = row["impact"] if not pd.isna(row["impact"]) else float("nan")
        avg_imp    = float(row["_avg_impact_20d"])

        res = classify_row(
            dr=dr,
            doi=doi_v,
            sigma=sigma,
            volume=vol,
            prev_oi=prev_oi_v,
            doi_abs_median=doi_median,
            avg_volume_20d=avg_vol,
            price_impact=impact_v,
            avg_impact_20d=avg_imp,
            params=params,
        )
        records.append(res)

    quad_df = pd.DataFrame(records)

    for col in quad_df.columns:
        df[col] = quad_df[col].values

    # ------------------------------------------------------------------
    # Quadrant-adjusted flow and DV01
    # ------------------------------------------------------------------
    # flow_quadrant_i(t) = |doi| × net_dir_probability × w_adjusted
    # Deadband rows already have flow_quadrant = 0 (from classify_row)
    # Also exclude draining contracts from the scaled flow
    doi_abs_arr   = df["doi"].abs().fillna(0.0).values
    w_adj_arr     = df["w_adjusted"].fillna(0.0).values
    is_drain_arr  = df["is_draining"].values
    fq_arr        = df["flow_quadrant"].values   # net_dir_prob (0 when deadband)

    # Draining contracts excluded from quadrant flow
    scaled_flow = doi_abs_arr * fq_arr * w_adj_arr * (~is_drain_arr).astype(float)
    df["flow_quadrant"]      = scaled_flow
    df["dv01_flow_quadrant"] = scaled_flow * dv01_per_contract

    # ------------------------------------------------------------------
    # Position accumulation using flow_quadrant (same decay as base)
    # ------------------------------------------------------------------
    pos_q_list = []
    for cid, grp in df.groupby("contract_id", sort=False):
        grp_s = grp.sort_values("trade_date").copy()
        lam   = grp_s["decay_lambda"].iloc[0]

        flow_vals = grp_s["flow_quadrant"].values
        pos_arr   = np.zeros(len(flow_vals))
        p = 0.0
        for i, f in enumerate(flow_vals):
            if np.isnan(f):
                p = lam * p
            else:
                p = lam * p + f
            pos_arr[i] = p

        pos_q_list.append(pd.Series(pos_arr, index=grp_s.index))

    df["position_quadrant"]      = pd.concat(pos_q_list).reindex(df.index)
    df["dv01_position_quadrant"] = df["position_quadrant"] * dv01_per_contract

    # ------------------------------------------------------------------
    # Clean up helper columns and restore MultiIndex
    # ------------------------------------------------------------------
    df.drop(columns=["_doi_abs_median", "_avg_volume_20d", "_avg_impact_20d"], inplace=True)
    df = df.set_index(["contract_id", "trade_date"])

    return df


# ---------------------------------------------------------------------------
# Aggregate
# ---------------------------------------------------------------------------

def aggregate_quadrant_signal(
    qsignal_df: pd.DataFrame,
    params: dict,
    trailing_zscore_window: int = 252,
) -> pd.DataFrame:
    """
    Daily aggregated view over all contracts.

    Returns DataFrame indexed by trade_date.
    """
    if qsignal_df.empty:
        return pd.DataFrame()

    dv01_per = params["dv01"]["eur_per_bp_per_contract"]
    df = qsignal_df.reset_index()
    buckets = ["whites", "reds", "greens", "blues"]
    quad_labels = ["lb", "sb", "sc", "ll"]
    quad_cols   = ["p_long_build", "p_short_build", "p_short_covering", "p_long_liquidation"]

    rows = []
    dates = sorted(df["trade_date"].unique())

    for td in dates:
        day = df[df["trade_date"] == td]
        active = day[~day["is_draining"]]

        n_classified   = (day["hard_label"] != "unclassified").sum()
        n_unclassified = (day["hard_label"] == "unclassified").sum()
        n_draining     = day["is_draining"].sum()

        row: dict = {
            "total_dv01_flow_quadrant": active["dv01_flow_quadrant"].sum(),
            "n_classified":   int(n_classified),
            "n_unclassified": int(n_unclassified),
            "n_draining":     int(n_draining),
        }

        # Per-bucket per-quadrant soft DV01 allocations
        for bkt in buckets:
            bkt_rows = active[active["pack"] == bkt]
            doi_abs_vals  = bkt_rows["doi"].abs().fillna(0.0)
            for ql, qc in zip(quad_labels, quad_cols):
                col_name = f"dv01_{ql}_{bkt}s"  # e.g. dv01_lb_whites
                soft_flow = (doi_abs_vals * bkt_rows[qc].fillna(0.0) * dv01_per).sum()
                row[col_name] = float(soft_flow)

        # Daily shares of each quadrant (weighted by |doi|, classified rows only)
        classified = active[active["hard_label"] != "unclassified"]
        if len(classified) > 0:
            doi_abs_cl = classified["doi"].abs().fillna(0.0)
            total_doi_cl = doi_abs_cl.sum()
            if total_doi_cl > 0:
                row["share_long_build"]      = (doi_abs_cl * classified["p_long_build"]).sum()      / total_doi_cl
                row["share_short_build"]     = (doi_abs_cl * classified["p_short_build"]).sum()     / total_doi_cl
                row["share_short_covering"]  = (doi_abs_cl * classified["p_short_covering"]).sum()  / total_doi_cl
                row["share_long_liquidation"]= (doi_abs_cl * classified["p_long_liquidation"]).sum()/ total_doi_cl
            else:
                row["share_long_build"] = row["share_short_build"] = 0.5
                row["share_short_covering"] = row["share_long_liquidation"] = 0.0
        else:
            row["share_long_build"] = row["share_short_build"] = 0.25
            row["share_short_covering"] = row["share_long_liquidation"] = 0.25

        row["share_build"]       = row["share_long_build"] + row["share_short_build"]
        row["share_liquidation"] = row["share_short_covering"] + row["share_long_liquidation"]

        rows.append((td, row))

    daily = pd.DataFrame([r for _, r in rows], index=[td for td, _ in rows])
    daily.index.name = "trade_date"
    daily = daily.sort_index()

    # Rolling build share (5d and 10d): build days / classified days
    # A "build day" = hard_label in {long_build, short_build}
    day_n_classified  = daily["n_classified"]

    def _rolling_build_share(window: int) -> pd.Series:
        # Count of days with any "build" classified contract / days with any classified
        # Use rolling sum of classified count > 0 as denominator
        classified_positive = (day_n_classified > 0).astype(float)
        build_days = (
            pd.Series(
                {td: (
                    (df[df["trade_date"] == td]["hard_label"].isin(["long_build", "short_build"])).any()
                )
                for td in dates},
            )
            .astype(float)
            .reindex(daily.index)
        )
        roll_build = build_days.rolling(window=window, min_periods=1).sum()
        roll_class = classified_positive.rolling(window=window, min_periods=1).sum()
        share = roll_build / roll_class.replace(0, np.nan)
        return share.fillna(0.0).clip(0.0, 1.0)

    daily["rolling_build_share_5d"]  = _rolling_build_share(5)
    daily["rolling_build_share_10d"] = _rolling_build_share(10)

    # Weekly change and z-score of position_quadrant
    pos_q = df[~df["is_draining"]].groupby("trade_date")["position_quadrant"].sum()
    pos_q = pos_q.reindex(daily.index)

    daily["weekly_change_position_quadrant"] = pos_q - pos_q.shift(5)

    roll_mean = pos_q.rolling(window=trailing_zscore_window, min_periods=20).mean()
    roll_std  = pos_q.rolling(window=trailing_zscore_window, min_periods=20).std()
    daily["zscore_position_quadrant"] = (pos_q - roll_mean) / roll_std.replace(0, np.nan)

    return daily


# ---------------------------------------------------------------------------
# Calibration
# ---------------------------------------------------------------------------

def calibrate_deadband_k(
    conn,
    start_date: date,
    end_date: date,
    as_of_date: date,
    cot_df: pd.DataFrame,
    params: dict,
    k_grid: list[float] | None = None,
) -> dict:
    """
    Grid search over k values for the price deadband.

    For each k: build quadrant signal, compute weekly ΔP_quadrant vs weekly ΔCOT,
    measure Pearson correlation.

    Returns {"best_k": float, "best_corr": float, "grid": [(k, corr), ...]}.

    Calibration rule: prefer smallest k that improves correlation (don't widen beyond usefulness).
    """
    if k_grid is None:
        k_grid = [0.20, 0.25, 0.30, 0.35, 0.40]

    # Prepare COT weekly series
    cot = cot_df.copy()
    if "net_position" not in cot.columns:
        cot["net_position"] = cot["long_positions"] - cot["short_positions"]
    cot = cot.sort_values("publication_date").set_index("publication_date")["net_position"]
    if not pd.api.types.is_datetime64_any_dtype(cot.index):
        cot.index = pd.to_datetime(cot.index)
    cot_weekly = cot.resample("W-FRI").last()
    cot_delta  = cot_weekly.diff().dropna()

    grid_results: list[tuple[float, float]] = []

    for k in k_grid:
        test_params = {**params, "quadrant": {**params.get("quadrant", {}), "deadband_k": k}}
        try:
            qsig = build_quadrant_signal(conn, start_date, end_date, as_of_date, test_params)
        except Exception:
            grid_results.append((k, float("nan")))
            continue

        if qsig.empty:
            grid_results.append((k, float("nan")))
            continue

        df_q = qsig.reset_index()
        pos_q = df_q[~df_q["is_draining"]].groupby("trade_date")["position_quadrant"].sum()
        pos_q.index = pd.to_datetime(pos_q.index)
        weekly_pos = pos_q.resample("W-FRI").last()
        weekly_delta = weekly_pos.diff().dropna()

        aligned = pd.concat([weekly_delta, cot_delta], axis=1, join="inner").dropna()
        aligned.columns = ["dp", "dcot"]

        if len(aligned) < 20:
            grid_results.append((k, float("nan")))
            continue

        corr = float(aligned["dp"].corr(aligned["dcot"]))
        grid_results.append((k, corr if not math.isnan(corr) else float("nan")))

    # Select best: smallest k that achieves the highest correlation
    # (rule: "widen deadband only while it improves correlation")
    valid = [(k, c) for k, c in grid_results if not math.isnan(c)]
    if not valid:
        return {"best_k": k_grid[0], "best_corr": float("nan"), "grid": grid_results}

    best_corr = max(c for _, c in valid)
    # Among all k achieving ≥ best_corr, pick smallest k (don't widen unnecessarily)
    best_k = min(k for k, c in valid if c >= best_corr - 1e-9)

    return {"best_k": best_k, "best_corr": best_corr, "grid": grid_results}
