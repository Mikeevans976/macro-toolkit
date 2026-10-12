"""
Stage 8 — Dashboard panels (§9.1).

Six panels assembled into a single JSON-serialisable response for the frontend.
All history lists are sorted ascending by date.
All floats use round(float(x), 6) to avoid numpy scalar serialisation issues.
"""

from __future__ import annotations

import math
from datetime import date, datetime, timedelta
from typing import Optional

import numpy as np
import pandas as pd

from ..core.dv01 import build_dv01_timeseries
from ..core.anchor import build_anchor
from ..core.spreads import spread_adjusted_quadrant_signal, build_spread_signal
from ..core.quadrants import build_quadrant_signal

_BUCKETS = ("whites", "reds", "greens", "blues")


# ---------------------------------------------------------------------------
# Instrument resolution helper
# ---------------------------------------------------------------------------

def _resolve_instrument(params: dict, instrument: str) -> tuple[list[str], float]:
    """
    Look up an instrument in params["instruments"] and return (roots, dv01_per_contract).
    Falls back to euribor defaults if the instrument is not found.
    """
    instruments = params.get("instruments", {})
    cfg = instruments.get(instrument, {})
    roots = cfg.get("roots", [params["contracts"].get("euribor_root", "FEI")])
    dv01 = float(cfg.get("dv01_per_contract", params["dv01"]["eur_per_bp_per_contract"]))
    return roots, dv01


def _patch_params_dv01(params: dict, dv01: float) -> dict:
    """Return a shallow copy of params with dv01 overridden."""
    return {**params, "dv01": {**params["dv01"], "eur_per_bp_per_contract": dv01}}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _safe_float(x) -> float:
    """Convert to Python float, replacing NaN/Inf with 0.0."""
    try:
        v = float(x)
        if math.isnan(v) or math.isinf(v):
            return 0.0
        return round(v, 6)
    except (TypeError, ValueError):
        return 0.0


def _safe_zscore(series: pd.Series, window: int) -> pd.Series:
    """Trailing z-score with min_periods = min(20, window//10)."""
    min_p = max(20, window // 10)
    roll_mean = series.rolling(window=window, min_periods=min_p).mean()
    roll_std = series.rolling(window=window, min_periods=min_p).std()
    return (series - roll_mean) / roll_std.replace(0, np.nan)


def _business_days_lookback(as_of_date: date, lookback_days: int) -> date:
    """Estimate a start_date that provides roughly lookback_days of business days."""
    # Approximate: calendar days = 1.4 × business days
    return as_of_date - timedelta(days=int(lookback_days * 1.4) + 30)


# ---------------------------------------------------------------------------
# Panel 1 — Net DV01 by tenor bucket, z-scored
# ---------------------------------------------------------------------------

def panel_dv01_by_bucket(
    conn,
    as_of_date: date,
    params: dict,
    lookback_days: int = 504,
    instrument: str = "euribor",
) -> dict:
    """
    Returns DV01 levels and z-scores by tenor bucket with history.
    """
    instrument_roots, dv01 = _resolve_instrument(params, instrument)
    params = _patch_params_dv01(params, dv01)

    zscore_1y_window = 252
    zscore_3y_window = 756

    start_date = _business_days_lookback(as_of_date, max(lookback_days, zscore_3y_window))

    ts = build_dv01_timeseries(conn, start_date, as_of_date, as_of_date, params, instrument_roots=instrument_roots)

    if ts.empty:
        return {
            "as_of_date": as_of_date.isoformat(),
            "buckets": {b: {"net_dv01_eur": 0.0, "zscore_1y": 0.0, "zscore_3y": 0.0, "history": []} for b in _BUCKETS},
            "total_net_dv01_eur": 0.0,
            "total_zscore_1y": 0.0,
            "total_zscore_3y": 0.0,
        }

    # Compute z-scores over full history, then trim to lookback_days for display
    result_buckets = {}
    for bucket in _BUCKETS:
        col = f"dv01_net_{bucket}"
        if col not in ts.columns:
            result_buckets[bucket] = {"net_dv01_eur": 0.0, "zscore_1y": 0.0, "zscore_3y": 0.0, "history": []}
            continue

        z1y = _safe_zscore(ts[col], zscore_1y_window)
        z3y = _safe_zscore(ts[col], zscore_3y_window)

        # Current values (latest row)
        cur_dv01 = _safe_float(ts[col].iloc[-1]) if len(ts) > 0 else 0.0
        cur_z1y = _safe_float(z1y.iloc[-1]) if len(z1y) > 0 else 0.0
        cur_z3y = _safe_float(z3y.iloc[-1]) if len(z3y) > 0 else 0.0

        # Build history (last lookback_days)
        hist_ts = ts.tail(lookback_days)
        hist_z1y = z1y.reindex(hist_ts.index)
        history = []
        for td in hist_ts.index:
            history.append({
                "date": td.isoformat() if hasattr(td, "isoformat") else str(td),
                "net_dv01_eur": _safe_float(hist_ts.loc[td, col]),
                "zscore_1y": _safe_float(hist_z1y.loc[td]),
            })

        result_buckets[bucket] = {
            "net_dv01_eur": cur_dv01,
            "zscore_1y": cur_z1y,
            "zscore_3y": cur_z3y,
            "history": history,
        }

    # Total
    total_col = "total_net_dv01"
    total_z1y = _safe_zscore(ts[total_col], zscore_1y_window) if total_col in ts.columns else pd.Series(dtype=float)
    total_z3y = _safe_zscore(ts[total_col], zscore_3y_window) if total_col in ts.columns else pd.Series(dtype=float)

    total_dv01 = _safe_float(ts[total_col].iloc[-1]) if total_col in ts.columns and len(ts) > 0 else 0.0
    tot_z1y = _safe_float(total_z1y.iloc[-1]) if len(total_z1y) > 0 else 0.0
    tot_z3y = _safe_float(total_z3y.iloc[-1]) if len(total_z3y) > 0 else 0.0

    return {
        "as_of_date": as_of_date.isoformat(),
        "buckets": result_buckets,
        "total_net_dv01_eur": total_dv01,
        "total_zscore_1y": tot_z1y,
        "total_zscore_3y": tot_z3y,
    }


# ---------------------------------------------------------------------------
# Panel 2 — Crowding
# ---------------------------------------------------------------------------

def panel_crowding(
    conn,
    as_of_date: date,
    params: dict,
    lookback_days: int = 504,
    _anchor_cache: Optional[dict] = None,
    instrument: str = "euribor",
) -> dict:
    """
    Crowding: percentile rank and recency of accumulation.
    Uses Kalman x_est for total position and dv01_net_{bucket} for per-bucket.
    """
    instrument_roots, dv01 = _resolve_instrument(params, instrument)
    params = _patch_params_dv01(params, dv01)

    zscore_1y_window = 252
    start_date = _business_days_lookback(as_of_date, max(lookback_days, zscore_1y_window))

    # Get Kalman x_est (total position level)
    anchor_result = _anchor_cache
    if anchor_result is None:
        try:
            anchor_result = build_anchor(conn, start_date, as_of_date, as_of_date, params,
                                         instrument_roots=instrument_roots)
        except Exception:
            anchor_result = {"filter_df": pd.DataFrame(), "params_fitted": {}, "r2": float("nan")}

    filter_df = anchor_result.get("filter_df", pd.DataFrame())

    # DV01 timeseries for bucket-level crowding
    ts = build_dv01_timeseries(conn, start_date, as_of_date, as_of_date, params, instrument_roots=instrument_roots)

    if filter_df.empty or ts.empty:
        empty_bucket = {"percentile_rank": 0.5, "recent_share_10d": 0.0, "zscore_1y": 0.0}
        return {
            "as_of_date": as_of_date.isoformat(),
            "total": {
                "percentile_rank": 0.5,
                "recent_share_10d": 0.0,
                "position_now": 0.0,
                "position_10d_ago": 0.0,
            },
            "by_bucket": {b: dict(empty_bucket) for b in _BUCKETS},
            "history": [],
        }

    # Align x_est to ts index
    x_est = filter_df["x_est"].reindex(ts.index)

    # Percentile rank and recent_share for total position
    def _percentile_rank_series(s: pd.Series, window: int) -> pd.Series:
        """Expanding (or rolling) percentile rank."""
        result = []
        for i, (idx, val) in enumerate(s.items()):
            hist_vals = s.iloc[max(0, i - window + 1): i + 1].dropna()
            if len(hist_vals) < 2 or pd.isna(val):
                result.append(0.5)
            else:
                rank = float((hist_vals < val).sum()) / (len(hist_vals) - 1)
                result.append(round(min(1.0, max(0.0, rank)), 6))
        return pd.Series(result, index=s.index)

    pct_rank_total = _percentile_rank_series(x_est.dropna(), lookback_days)

    recent_share = pd.Series(dtype=float)
    if len(x_est.dropna()) > 11:
        x_10d_ago = x_est.shift(10)
        num = x_est - x_10d_ago
        denom = x_est.abs().replace(0, np.nan)
        raw = (num / denom).clip(-1.0, 1.0)
        recent_share = raw.fillna(0.0)

    # Current values
    pos_now = _safe_float(x_est.iloc[-1]) if len(x_est.dropna()) > 0 else 0.0
    pos_10d_ago_val = _safe_float(x_est.iloc[-11]) if len(x_est.dropna()) > 10 else pos_now
    cur_pct = _safe_float(pct_rank_total.iloc[-1]) if len(pct_rank_total) > 0 else 0.5
    cur_share = _safe_float(recent_share.iloc[-1]) if len(recent_share) > 0 else 0.0

    # Per-bucket crowding
    by_bucket = {}
    for bucket in _BUCKETS:
        col = f"dv01_net_{bucket}"
        if col not in ts.columns:
            by_bucket[bucket] = {"percentile_rank": 0.5, "recent_share_10d": 0.0, "zscore_1y": 0.0}
            continue
        bkt_series = ts[col].dropna()
        bkt_pct = _percentile_rank_series(bkt_series, lookback_days)
        bkt_pct_cur = _safe_float(bkt_pct.iloc[-1]) if len(bkt_pct) > 0 else 0.5

        bkt_10d_ago = bkt_series.shift(10)
        bkt_num = bkt_series - bkt_10d_ago
        bkt_denom = bkt_series.abs().replace(0, np.nan)
        bkt_share_series = (bkt_num / bkt_denom).clip(-1.0, 1.0).fillna(0.0)
        bkt_share_cur = _safe_float(bkt_share_series.iloc[-1]) if len(bkt_share_series) > 0 else 0.0

        z1y_series = _safe_zscore(ts[col], zscore_1y_window)
        bkt_z1y = _safe_float(z1y_series.iloc[-1]) if len(z1y_series) > 0 else 0.0

        by_bucket[bucket] = {
            "percentile_rank": bkt_pct_cur,
            "recent_share_10d": bkt_share_cur,
            "zscore_1y": bkt_z1y,
        }

    # Build history (last lookback_days)
    hist_pct = pct_rank_total.tail(lookback_days)
    hist_share = recent_share.reindex(hist_pct.index).fillna(0.0) if len(recent_share) > 0 else pd.Series(0.0, index=hist_pct.index)

    history = []
    for td in hist_pct.index:
        history.append({
            "date": td.isoformat() if hasattr(td, "isoformat") else str(td),
            "percentile_rank": _safe_float(hist_pct.loc[td]),
            "recent_share_10d": _safe_float(hist_share.loc[td]) if td in hist_share.index else 0.0,
        })

    return {
        "as_of_date": as_of_date.isoformat(),
        "total": {
            "percentile_rank": cur_pct,
            "recent_share_10d": cur_share,
            "position_now": pos_now,
            "position_10d_ago": pos_10d_ago_val,
        },
        "by_bucket": by_bucket,
        "history": history,
    }


# ---------------------------------------------------------------------------
# Panel 3 — Centre of gravity
# ---------------------------------------------------------------------------

def panel_centre_of_gravity(
    conn,
    as_of_date: date,
    params: dict,
    lookback_days: int = 126,
    instrument: str = "euribor",
) -> dict:
    """
    OI-weighted centre of gravity in years, with trailing z-score.
    """
    instrument_roots, dv01 = _resolve_instrument(params, instrument)
    params = _patch_params_dv01(params, dv01)

    zscore_window = 252
    start_date = _business_days_lookback(as_of_date, max(lookback_days, zscore_window))

    ts = build_dv01_timeseries(conn, start_date, as_of_date, as_of_date, params, instrument_roots=instrument_roots)

    if ts.empty or "cog_years" not in ts.columns:
        return {
            "as_of_date": as_of_date.isoformat(),
            "cog_years": 0.0,
            "cog_zscore": 0.0,
            "history": [],
        }

    cog = ts["cog_years"]
    cog_z = _safe_zscore(cog, zscore_window)

    cur_cog = _safe_float(cog.iloc[-1]) if len(cog) > 0 else 0.0
    cur_cog_z = _safe_float(cog_z.iloc[-1]) if len(cog_z) > 0 else 0.0

    hist_cog = cog.tail(lookback_days)
    hist_z = cog_z.reindex(hist_cog.index)
    history = []
    for td in hist_cog.index:
        history.append({
            "date": td.isoformat() if hasattr(td, "isoformat") else str(td),
            "cog_years": _safe_float(hist_cog.loc[td]),
            "cog_zscore": _safe_float(hist_z.loc[td]),
        })

    return {
        "as_of_date": as_of_date.isoformat(),
        "cog_years": cur_cog,
        "cog_zscore": cur_cog_z,
        "history": history,
    }


# ---------------------------------------------------------------------------
# Panel 4 — Quadrant mix
# ---------------------------------------------------------------------------

def panel_quadrant_mix(
    conn,
    as_of_date: date,
    params: dict,
    lookback_days: int = 63,
    instrument: str = "euribor",
) -> dict:
    """
    Rolling 5- and 10-day quadrant mix as share of total DV01 flow.
    """
    instrument_roots, dv01 = _resolve_instrument(params, instrument)
    params = _patch_params_dv01(params, dv01)

    start_date = _business_days_lookback(as_of_date, lookback_days + 20)

    try:
        adj_df, _curve_df = spread_adjusted_quadrant_signal(
            conn, start_date, as_of_date, as_of_date, params, instrument_roots=instrument_roots
        )
    except Exception:
        adj_df = pd.DataFrame()

    if adj_df.empty:
        empty_window = {
            "share_long_build": 0.25,
            "share_short_build": 0.25,
            "share_short_covering": 0.25,
            "share_long_liquidation": 0.25,
            "share_build": 0.5,
            "share_liquidation": 0.5,
        }
        return {
            "as_of_date": as_of_date.isoformat(),
            "rolling_5d": dict(empty_window),
            "rolling_10d": dict(empty_window),
            "history": [],
        }

    df = adj_df.reset_index()
    active = df[~df["is_draining"]]

    # Build daily quadrant DV01 shares
    dates_sorted = sorted(active["trade_date"].unique())
    daily_rows = []
    for td in dates_sorted:
        day = active[active["trade_date"] == td]
        classified = day[day["hard_label"] != "unclassified"]
        doi_abs = classified["doi"].abs().fillna(0.0)
        total_doi = doi_abs.sum()
        if total_doi > 0:
            s_lb = float((doi_abs * classified["p_long_build"]).sum() / total_doi)
            s_sb = float((doi_abs * classified["p_short_build"]).sum() / total_doi)
            s_sc = float((doi_abs * classified["p_short_covering"]).sum() / total_doi)
            s_ll = float((doi_abs * classified["p_long_liquidation"]).sum() / total_doi)
        else:
            s_lb = s_sb = s_sc = s_ll = 0.25
        daily_rows.append({
            "date": td,
            "s_lb": s_lb, "s_sb": s_sb, "s_sc": s_sc, "s_ll": s_ll,
        })

    if not daily_rows:
        empty_window = {
            "share_long_build": 0.25, "share_short_build": 0.25,
            "share_short_covering": 0.25, "share_long_liquidation": 0.25,
            "share_build": 0.5, "share_liquidation": 0.5,
        }
        return {
            "as_of_date": as_of_date.isoformat(),
            "rolling_5d": dict(empty_window),
            "rolling_10d": dict(empty_window),
            "history": [],
        }

    daily_df = pd.DataFrame(daily_rows).set_index("date").sort_index()

    def _rolling_window(n: int) -> dict:
        tail = daily_df.tail(n)
        if len(tail) == 0:
            return {"share_long_build": 0.25, "share_short_build": 0.25,
                    "share_short_covering": 0.25, "share_long_liquidation": 0.25,
                    "share_build": 0.5, "share_liquidation": 0.5}
        s_lb = _safe_float(tail["s_lb"].mean())
        s_sb = _safe_float(tail["s_sb"].mean())
        s_sc = _safe_float(tail["s_sc"].mean())
        s_ll = _safe_float(tail["s_ll"].mean())
        total = s_lb + s_sb + s_sc + s_ll
        if total > 0:
            s_lb /= total; s_sb /= total; s_sc /= total; s_ll /= total
        return {
            "share_long_build": round(s_lb, 6),
            "share_short_build": round(s_sb, 6),
            "share_short_covering": round(s_sc, 6),
            "share_long_liquidation": round(s_ll, 6),
            "share_build": round(s_lb + s_sb, 6),
            "share_liquidation": round(s_sc + s_ll, 6),
        }

    rolling_5d = _rolling_window(5)
    rolling_10d = _rolling_window(10)

    # History — rolling 5d values per day over last lookback_days
    hist_df = daily_df.tail(lookback_days)
    history = []
    for td in hist_df.index:
        row = hist_df.loc[td]
        s_lb = _safe_float(row["s_lb"])
        s_sb = _safe_float(row["s_sb"])
        s_sc = _safe_float(row["s_sc"])
        s_ll = _safe_float(row["s_ll"])
        history.append({
            "date": td.isoformat() if hasattr(td, "isoformat") else str(td),
            "share_long_build_5d": s_lb,
            "share_short_build_5d": s_sb,
            "share_short_covering_5d": s_sc,
            "share_long_liquidation_5d": s_ll,
        })

    return {
        "as_of_date": as_of_date.isoformat(),
        "rolling_5d": rolling_5d,
        "rolling_10d": rolling_10d,
        "history": history,
    }


# ---------------------------------------------------------------------------
# Panel 5 — Curve positioning
# ---------------------------------------------------------------------------

def panel_curve_positioning(
    conn,
    as_of_date: date,
    params: dict,
    lookback_days: int = 252,
    instrument: str = "euribor",
) -> dict:
    """
    Spread-attributed curve positioning series.
    """
    instrument_roots, dv01 = _resolve_instrument(params, instrument)
    params = _patch_params_dv01(params, dv01)

    start_date = _business_days_lookback(as_of_date, lookback_days + 60)

    try:
        _detail_df, curve_df = build_spread_signal(
            conn, start_date, as_of_date, as_of_date, params, instrument_roots=instrument_roots
        )
    except Exception:
        curve_df = pd.DataFrame()

    if curve_df.empty:
        return {
            "as_of_date": as_of_date.isoformat(),
            "curve_zscore": 0.0,
            "curve_weekly_change": 0.0,
            "curve_dv01_flow_today": 0.0,
            "history": [],
        }

    cur_zscore = _safe_float(curve_df["curve_zscore"].iloc[-1]) if "curve_zscore" in curve_df.columns else 0.0
    cur_wkly = _safe_float(curve_df["curve_weekly_change"].iloc[-1]) if "curve_weekly_change" in curve_df.columns else 0.0
    cur_flow = _safe_float(curve_df["curve_dv01_flow"].iloc[-1]) if "curve_dv01_flow" in curve_df.columns else 0.0

    hist_df = curve_df.tail(lookback_days)
    history = []
    for td in hist_df.index:
        history.append({
            "date": td.isoformat() if hasattr(td, "isoformat") else str(td),
            "curve_zscore": _safe_float(hist_df.loc[td, "curve_zscore"]) if "curve_zscore" in hist_df.columns else 0.0,
            "curve_dv01_flow": _safe_float(hist_df.loc[td, "curve_dv01_flow"]) if "curve_dv01_flow" in hist_df.columns else 0.0,
        })

    return {
        "as_of_date": as_of_date.isoformat(),
        "curve_zscore": cur_zscore,
        "curve_weekly_change": cur_wkly,
        "curve_dv01_flow_today": cur_flow,
        "history": history,
    }


# ---------------------------------------------------------------------------
# Panel 6 — COT reconciliation
# ---------------------------------------------------------------------------

def panel_cot_reconciliation(
    conn,
    as_of_date: date,
    params: dict,
    category: str = "investment_firms",
    lookback_weeks: int = 52,
    _anchor_cache: Optional[dict] = None,
    instrument: str = "euribor",
) -> dict:
    """
    Nowcast vs reported COT with fitted R².
    """
    instrument_roots, dv01 = _resolve_instrument(params, instrument)
    params = _patch_params_dv01(params, dv01)

    lookback_days = lookback_weeks * 7
    start_date = as_of_date - timedelta(days=lookback_days)

    anchor_result = _anchor_cache
    if anchor_result is None:
        try:
            anchor_result = build_anchor(conn, start_date, as_of_date, as_of_date, params,
                                         category=category, instrument_roots=instrument_roots)
        except Exception:
            anchor_result = {"filter_df": pd.DataFrame(), "params_fitted": {}, "r2": float("nan")}

    filter_df = anchor_result.get("filter_df", pd.DataFrame())
    params_fitted = anchor_result.get("params_fitted", {})
    r2 = anchor_result.get("r2", float("nan"))

    # Fetch last COT report date
    cot_rows = conn.execute(
        """
        SELECT report_date, publication_date, long_positions, short_positions
        FROM cot_obs
        WHERE category = ?
        ORDER BY publication_date DESC
        LIMIT 1
        """,
        (category,),
    ).fetchall()

    last_cot_date = None
    last_cot_value = None
    if cot_rows:
        row = cot_rows[0]
        last_cot_date = row["report_date"]
        last_cot_value = int(row["long_positions"]) - int(row["short_positions"])

    days_since_cot = 0
    if last_cot_date:
        ref_date = date.fromisoformat(last_cot_date) if isinstance(last_cot_date, str) else last_cot_date
        days_since_cot = (as_of_date - ref_date).days

    nowcast_today = 0.0
    nowcast_uncertainty = 0.0
    if not filter_df.empty:
        nowcast_today = _safe_float(filter_df["x_est"].iloc[-1])
        p_est_last = float(filter_df["P_est"].iloc[-1])
        nowcast_uncertainty = _safe_float(math.sqrt(max(0.0, p_est_last)))

    # All COT obs for the history
    all_cot = conn.execute(
        """
        SELECT publication_date, long_positions, short_positions
        FROM cot_obs
        WHERE category = ?
        ORDER BY publication_date
        """,
        (category,),
    ).fetchall()
    cot_lookup: dict[str, float] = {}
    for r in all_cot:
        pd_str = r["publication_date"]
        cot_lookup[pd_str] = int(r["long_positions"]) - int(r["short_positions"])

    # Build history
    history = []
    if not filter_df.empty:
        hist_df = filter_df.tail(lookback_weeks * 5)  # ~5 bdays/week
        for td in hist_df.index:
            td_str = td.isoformat() if hasattr(td, "isoformat") else str(td)
            p_est = float(hist_df.loc[td, "P_est"])
            unc = _safe_float(math.sqrt(max(0.0, p_est)))
            xest = _safe_float(hist_df.loc[td, "x_est"])
            cot_val = cot_lookup.get(td_str)
            history.append({
                "date": td_str,
                "nowcast": xest,
                "cot_reported": float(cot_val) if cot_val is not None else None,
                "uncertainty_upper": round(xest + unc, 6),
                "uncertainty_lower": round(xest - unc, 6),
            })

    r2_val = 0.0 if math.isnan(r2) or math.isinf(r2) else round(float(r2), 6)
    r2_val = max(0.0, min(1.0, r2_val))  # clip to [0,1] for display

    return {
        "as_of_date": as_of_date.isoformat(),
        "category": category,
        "r2": r2_val,
        "fitted_lambda": _safe_float(params_fitted.get("lambda", 0.95)),
        "fitted_beta": _safe_float(params_fitted.get("beta", 1.0)),
        "nowcast_today": nowcast_today,
        "nowcast_uncertainty": nowcast_uncertainty,
        "last_cot_report_date": last_cot_date if last_cot_date else "",
        "last_cot_value": float(last_cot_value) if last_cot_value is not None else 0.0,
        "days_since_cot": max(0, days_since_cot),
        "history": history,
    }


# ---------------------------------------------------------------------------
# Panel 7 — Contract strip
# ---------------------------------------------------------------------------

def _contract_display_name(contract_id: str, params: dict) -> str:
    """
    Convert internal contract_id to Bloomberg-style 1-digit-year display name.
    "FEI_2025H" → "ERH5", "FEI_2026Z" → "ERZ6"

    Looks up the instrument registry (params["instruments"]) to find the correct
    BBG root for any instrument root code.
    """
    # Build root → bbg_root map from instrument registry
    root_to_bbg: dict[str, str] = {}
    for cfg in params.get("instruments", {}).values():
        bbg_r = cfg.get("bbg_root", "")
        for r in cfg.get("roots", []):
            root_to_bbg[r] = bbg_r

    # Fall back to bloomberg section for legacy Euribor/ESTR
    if not root_to_bbg:
        bbg_cfg = params.get("bloomberg", {})
        int_euribor = params["contracts"].get("euribor_root", "FEI")
        int_estr    = params["contracts"].get("estr_root",    "FEF")
        root_to_bbg[int_euribor] = bbg_cfg.get("euribor_bbg_root", "ER")
        root_to_bbg[int_estr]    = bbg_cfg.get("estr_bbg_root",    "ERS")

    try:
        root_part, year_code = contract_id.split("_", 1)
        full_year = int(year_code[:4])
        imm_code  = year_code[4]
        bbg_root  = root_to_bbg.get(root_part, root_part)
        return f"{bbg_root}{imm_code}{str(full_year)[-1]}"
    except Exception:
        return contract_id


def panel_contract_strip(
    conn,
    as_of_date: date,
    params: dict,
    lookback_days: int = 504,
    instrument: str = "euribor",
) -> dict:
    """
    Per-contract snapshot of the active strip for the selected instrument.

    Returns one row per non-draining and draining contract, sorted by generic rank.

    Fields per contract:
      contract_id, display_name, pack, generic_rank, days_to_expiry,
      is_draining, settlement_price, open_interest, doi, dr_bp,
      dv01_flow_eur, position_zscore (trailing 252d), hard_label,
      p_long_build, p_short_build, p_short_covering, p_long_liquidation,
      estimator, regime
    """
    instrument_roots, dv01 = _resolve_instrument(params, instrument)
    params = _patch_params_dv01(params, dv01)

    zscore_window = 252
    start_date = _business_days_lookback(as_of_date, max(lookback_days, zscore_window))

    try:
        qsig = build_quadrant_signal(conn, start_date, as_of_date, as_of_date, params,
                                     instrument_roots=instrument_roots)
    except Exception as exc:
        return {
            "as_of_date": as_of_date.isoformat(),
            "as_of_trade_date": None,
            "contracts": [],
            "error": str(exc),
        }

    if qsig.empty:
        return {"as_of_date": as_of_date.isoformat(), "as_of_trade_date": None, "contracts": []}

    df = qsig.reset_index()
    df["trade_date"] = pd.to_datetime(df["trade_date"]).dt.date

    latest_date = df["trade_date"].max()
    latest = df[df["trade_date"] == latest_date].copy()

    # Trailing z-score of position_quadrant per contract over the history window
    zscore_map: dict[str, Optional[float]] = {}
    for cid, grp in df.groupby("contract_id"):
        pos = grp.sort_values("trade_date")["position_quadrant"]
        if len(pos) >= 20:
            roll_mean = pos.rolling(window=zscore_window, min_periods=20).mean()
            roll_std  = pos.rolling(window=zscore_window, min_periods=20).std()
            cur       = float(pos.iloc[-1])
            m         = float(roll_mean.iloc[-1])
            s         = float(roll_std.iloc[-1]) if not math.isnan(float(roll_std.iloc[-1])) else 0.0
            zscore_map[cid] = round((cur - m) / s, 3) if s > 0 else 0.0
        else:
            zscore_map[cid] = None

    contracts_out = []
    for _, row in latest.iterrows():
        cid  = row["contract_id"]
        dr   = float(row["dr"]) if not pd.isna(row.get("dr")) else 0.0
        doi  = int(row["doi"])  if not pd.isna(row.get("doi"))  else 0
        oi   = int(row["open_interest"]) if not pd.isna(row.get("open_interest")) else 0
        grank = int(row["generic_rank"]) if pd.notna(row.get("generic_rank")) else None
        dte   = int(row["days_to_expiry"]) if pd.notna(row.get("days_to_expiry")) else None

        pz = zscore_map.get(cid)

        contracts_out.append({
            "contract_id":        cid,
            "display_name":       _contract_display_name(cid, params),
            "pack":               row.get("pack") or None,
            "generic_rank":       grank,
            "days_to_expiry":     dte,
            "is_draining":        bool(row.get("is_draining", False)),
            "settlement_price":   _safe_float(row.get("settlement_price")),
            "open_interest":      oi,
            "doi":                doi,
            "dr_bp":              round(dr * 100, 1),   # rate move in basis points
            "dv01_flow_eur":      _safe_float(row.get("dv01_flow_quadrant", 0)),
            "position_zscore":    round(float(pz), 3) if pz is not None else None,
            "hard_label":         str(row.get("hard_label", "unclassified")),
            "p_long_build":       _safe_float(row.get("p_long_build",       0)),
            "p_short_build":      _safe_float(row.get("p_short_build",      0)),
            "p_short_covering":   _safe_float(row.get("p_short_covering",   0)),
            "p_long_liquidation": _safe_float(row.get("p_long_liquidation", 0)),
            "estimator":          str(row.get("estimator", "")),
            "regime":             str(row.get("regime", "normal")),
        })

    # Sort by generic_rank (None → end), then by contract_id for serials
    contracts_out.sort(key=lambda x: (x["generic_rank"] is None, x["generic_rank"] or 999))

    return {
        "as_of_date":       as_of_date.isoformat(),
        "as_of_trade_date": latest_date.isoformat(),
        "contracts":        contracts_out,
    }


# ---------------------------------------------------------------------------
# Panel 8 — Single-contract history
# ---------------------------------------------------------------------------

def panel_contract_history(
    conn,
    as_of_date: date,
    params: dict,
    contract_id: str,
    lookback_days: int = 252,
    instrument: str = "euribor",
) -> dict:
    """
    Time-series history for a single contract: OI, ΔOI, rate, position z-score,
    quadrant probabilities.  Used by the frontend per-contract detail panel.

    Returns:
      contract_id, display_name, history (list of daily rows, ascending by date)
    """
    instrument_roots, dv01 = _resolve_instrument(params, instrument)
    params = _patch_params_dv01(params, dv01)

    zscore_window = 252
    start_date = _business_days_lookback(as_of_date, max(lookback_days, zscore_window))

    try:
        qsig = build_quadrant_signal(
            conn, start_date, as_of_date, as_of_date, params,
            instrument_roots=instrument_roots,
        )
    except Exception as exc:
        return {"contract_id": contract_id, "display_name": contract_id, "history": [], "error": str(exc)}

    if qsig.empty:
        return {"contract_id": contract_id, "display_name": contract_id, "history": []}

    df = qsig.reset_index()
    df["trade_date"] = pd.to_datetime(df["trade_date"]).dt.date
    df = df[df["contract_id"] == contract_id].sort_values("trade_date").copy()

    if df.empty:
        return {"contract_id": contract_id, "display_name": contract_id, "history": []}

    # Trailing z-score of position_quadrant over full history, then trim for display
    pos = df["position_quadrant"]
    roll_mean = pos.rolling(window=zscore_window, min_periods=20).mean()
    roll_std  = pos.rolling(window=zscore_window, min_periods=20).std()
    df["position_zscore"] = ((pos - roll_mean) / roll_std.replace(0, np.nan)).values

    # OI z-score for relative-size context
    oi_series = df["open_interest"].astype(float)
    oi_mean = oi_series.rolling(window=zscore_window, min_periods=20).mean()
    oi_std  = oi_series.rolling(window=zscore_window, min_periods=20).std()
    df["oi_zscore"] = ((oi_series - oi_mean) / oi_std.replace(0, np.nan)).values

    # Trim to display window
    df = df.tail(lookback_days)

    history = []
    for _, row in df.iterrows():
        td = row["trade_date"]
        history.append({
            "date":             td.isoformat() if hasattr(td, "isoformat") else str(td),
            "settlement_price": _safe_float(row.get("settlement_price")),
            "rate":             _safe_float(row.get("rate")),
            "open_interest":    int(row["open_interest"]) if pd.notna(row.get("open_interest")) else 0,
            "doi":              int(row["doi"]) if pd.notna(row.get("doi")) else 0,
            "dr_bp":            round(float(row["dr"]) * 100, 1) if pd.notna(row.get("dr")) else 0.0,
            "oi_zscore":        _safe_float(row.get("oi_zscore")),
            "position_zscore":  _safe_float(row.get("position_zscore")),
            "hard_label":       str(row.get("hard_label", "unclassified")),
            "p_long_build":     _safe_float(row.get("p_long_build",       0)),
            "p_short_build":    _safe_float(row.get("p_short_build",      0)),
            "p_short_covering": _safe_float(row.get("p_short_covering",   0)),
            "p_long_liquidation": _safe_float(row.get("p_long_liquidation", 0)),
            "dv01_flow_eur":    _safe_float(row.get("dv01_flow_quadrant",  0)),
            "estimator":        str(row.get("estimator", "")),
            "regime":           str(row.get("regime", "normal")),
            "is_draining":      bool(row.get("is_draining", False)),
        })

    return {
        "contract_id":  contract_id,
        "display_name": _contract_display_name(contract_id, params),
        "history":      history,
    }


# ---------------------------------------------------------------------------
# Master dashboard function
# ---------------------------------------------------------------------------

def build_dashboard(
    conn,
    as_of_date: date,
    params: dict,
    instrument: str = "euribor",
) -> dict:
    """
    Assemble all seven panels for the selected instrument.
    Each panel is independent; failures are caught.
    Calls build_anchor() once and reuses across panels that need it.
    """
    generated_at = datetime.now().isoformat()

    instrument_roots, dv01 = _resolve_instrument(params, instrument)
    p = _patch_params_dv01(params, dv01)

    # Pre-compute anchor once for panels 2 and 6 (graceful fallback if no COT)
    lookback_days = 504
    start_date = _business_days_lookback(as_of_date, max(lookback_days, 756))
    anchor_cache = None
    try:
        anchor_cache = build_anchor(conn, start_date, as_of_date, as_of_date, p,
                                    instrument_roots=instrument_roots)
    except Exception:
        anchor_cache = None

    panel_fns = {
        "dv01_by_bucket":    lambda: panel_dv01_by_bucket(conn, as_of_date, p, instrument=instrument),
        "crowding":          lambda: panel_crowding(conn, as_of_date, p, _anchor_cache=anchor_cache, instrument=instrument),
        "centre_of_gravity": lambda: panel_centre_of_gravity(conn, as_of_date, p, instrument=instrument),
        "quadrant_mix":      lambda: panel_quadrant_mix(conn, as_of_date, p, instrument=instrument),
        "curve_positioning": lambda: panel_curve_positioning(conn, as_of_date, p, instrument=instrument),
        "cot_reconciliation": lambda: panel_cot_reconciliation(conn, as_of_date, p, _anchor_cache=anchor_cache, instrument=instrument),
        "contract_strip":    lambda: panel_contract_strip(conn, as_of_date, p, instrument=instrument),
    }

    panels = {}
    for name, fn in panel_fns.items():
        try:
            panels[name] = fn()
        except Exception as exc:
            panels[name] = {"error": str(exc)}

    return {
        "as_of_date": as_of_date.isoformat(),
        "generated_at": generated_at,
        "panels": panels,
    }
