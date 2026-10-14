"""
Stage 8 — Diagnostics (§9.2).

Three diagnostic functions deliberately kept separate from dashboard panels.
"Conflating a positioning measure with a return-prediction claim is how these
tools lose credibility on a desk."
"""

from __future__ import annotations

import math
from datetime import date, timedelta

import numpy as np
import pandas as pd

from ..core.dv01 import build_dv01_timeseries
from ..core.spreads import spread_adjusted_quadrant_signal, build_spread_signal


def _safe_float(x) -> float:
    """Convert to Python float, replacing NaN/Inf with 0.0."""
    try:
        v = float(x)
        if math.isnan(v) or math.isinf(v):
            return 0.0
        return round(v, 6)
    except (TypeError, ValueError):
        return 0.0


# ---------------------------------------------------------------------------
# Diagnostic 1 — Estimator quality log
# ---------------------------------------------------------------------------

def diagnostic_estimator_quality(
    conn,
    start_date: date,
    end_date: date,
    as_of_date: date,
    params: dict,
) -> dict:
    """
    Audit trail of direction estimator usage and deadband filtering.

    Returns:
    {
      "period": {"start": str, "end": str},
      "total_observations": int,
      "direction_estimator": {
        "vwap": {"count": int, "share": float},
        "open": {"count": int, "share": float},
        "fallback_close_to_close": {"count": int, "share": float},
      },
      "deadband": {
        "total_unclassified": int,
        "share_unclassified": float,
        "price_deadband_triggered": int,
        "oi_deadband_triggered": int,
      },
      "spreads": {
        "total_doi": int,
        "spread_attributed_doi": int,
        "spread_share": float,
        "by_type": {
          "bundle": {"count": int, "doi": int},
          "pack": {"count": int, "doi": int},
          "calendar": {"count": int, "doi": int},
          "outright": {"count": int, "doi": int},
        }
      }
    }
    """
    # Fetch raw observations including vwap/open_price for estimator audit
    sql = """
        WITH lagged AS (
            SELECT
                d.contract_id,
                d.trade_date,
                d.settlement_price,
                d.vwap,
                d.open_price,
                d.open_interest,
                d.volume,
                LAG(d.settlement_price) OVER (PARTITION BY d.contract_id ORDER BY d.trade_date) AS prev_price,
                LAG(d.open_interest)    OVER (PARTITION BY d.contract_id ORDER BY d.trade_date) AS prev_oi,
                c.contract_type
            FROM daily_obs d
            JOIN contracts c ON c.contract_id = d.contract_id
            WHERE d.knowledge_date <= ?
              AND c.contract_type = 'quarterly'
        )
        SELECT
            contract_id, trade_date,
            settlement_price, prev_price,
            vwap, open_price,
            open_interest, prev_oi, volume
        FROM lagged
        WHERE trade_date >= ?
          AND trade_date <= ?
          AND prev_price IS NOT NULL
        ORDER BY contract_id, trade_date
    """
    rows = conn.execute(
        sql,
        (as_of_date.isoformat(), start_date.isoformat(), end_date.isoformat()),
    ).fetchall()

    if not rows:
        return {
            "period": {"start": start_date.isoformat(), "end": end_date.isoformat()},
            "total_observations": 0,
            "direction_estimator": {
                "vwap": {"count": 0, "share": 0.0},
                "open": {"count": 0, "share": 0.0},
                "fallback_close_to_close": {"count": 0, "share": 0.0},
            },
            "deadband": {
                "total_unclassified": 0,
                "share_unclassified": 0.0,
                "price_deadband_triggered": 0,
                "oi_deadband_triggered": 0,
            },
            "spreads": {
                "total_doi": 0,
                "spread_attributed_doi": 0,
                "spread_share": 0.0,
                "by_type": {
                    "bundle": {"count": 0, "doi": 0},
                    "pack": {"count": 0, "doi": 0},
                    "calendar": {"count": 0, "doi": 0},
                    "outright": {"count": 0, "doi": 0},
                },
            },
        }

    # Count estimator usage
    count_vwap = 0
    count_open = 0
    count_fallback = 0
    total = len(rows)

    for r in rows:
        vwap = r["vwap"]
        open_p = r["open_price"]
        if vwap is not None:
            count_vwap += 1
        elif open_p is not None:
            count_open += 1
        else:
            count_fallback += 1

    # Deadband: get spread-adjusted signal to inspect deadband flags
    try:
        adj_df, _curve_df = spread_adjusted_quadrant_signal(
            conn, start_date, end_date, as_of_date, params
        )
    except Exception:
        adj_df = pd.DataFrame()

    total_unclassified = 0
    price_db_triggered = 0
    oi_db_triggered = 0

    if not adj_df.empty and "hard_label" in adj_df.columns:
        total_unclassified = int((adj_df["hard_label"] == "unclassified").sum())
        # We approximate deadband breakdown from the quadrant signal
        # in_deadband = price_db OR oi_db; count those rows
        if "in_deadband" in adj_df.columns:
            db_rows = adj_df[adj_df["in_deadband"]]
            # Approximate: use separate deadband checks
            qp = params.get("quadrant", {})
            k = float(qp.get("deadband_k", 0.30))
            oi_fraction = float(qp.get("deadband_oi_fraction", 0.005))

            for row_dict in db_rows.itertuples():
                dr = getattr(row_dict, "dr", 0.0) or 0.0
                sigma = getattr(row_dict, "sigma", 0.0) or 0.0
                doi = getattr(row_dict, "doi", 0) or 0
                prev_oi = getattr(row_dict, "prev_oi", 0) or 0

                price_db_threshold = k * sigma if sigma > 0 else 0.0
                price_in_db = abs(dr) < price_db_threshold if price_db_threshold > 0 else False

                oi_db_threshold = oi_fraction * abs(prev_oi) if prev_oi else 0.0
                oi_in_db = abs(doi) < oi_db_threshold if oi_db_threshold > 0 else False

                if price_in_db:
                    price_db_triggered += 1
                elif oi_in_db:
                    oi_db_triggered += 1
                else:
                    # Both could apply, default to price
                    price_db_triggered += 1

    total_rows_adj = len(adj_df) if not adj_df.empty else 0
    share_unclassified = round(total_unclassified / total_rows_adj, 6) if total_rows_adj > 0 else 0.0

    # Spread attribution audit
    try:
        detail_df, _curve_df = build_spread_signal(conn, start_date, end_date, as_of_date, params)
    except Exception:
        detail_df = pd.DataFrame()

    spread_total_doi = 0
    spread_attributed_doi = 0
    by_type_counts: dict[str, dict] = {
        "bundle": {"count": 0, "doi": 0},
        "pack": {"count": 0, "doi": 0},
        "calendar": {"count": 0, "doi": 0},
        "outright": {"count": 0, "doi": 0},
    }

    if not detail_df.empty:
        detail_reset = detail_df.reset_index()
        spread_total_doi = int(detail_reset["doi"].abs().sum())
        spread_attributed_doi = int(detail_reset["doi_spread_attributed"].abs().sum())
        for stype in by_type_counts:
            mask = detail_reset["spread_type"] == stype
            by_type_counts[stype]["count"] = int(mask.sum())
            by_type_counts[stype]["doi"] = int(detail_reset.loc[mask, "doi_spread_attributed"].abs().sum())

    spread_share_val = round(spread_attributed_doi / spread_total_doi, 6) if spread_total_doi > 0 else 0.0

    return {
        "period": {"start": start_date.isoformat(), "end": end_date.isoformat()},
        "total_observations": total,
        "direction_estimator": {
            "vwap": {"count": count_vwap, "share": round(count_vwap / total, 6) if total > 0 else 0.0},
            "open": {"count": count_open, "share": round(count_open / total, 6) if total > 0 else 0.0},
            "fallback_close_to_close": {"count": count_fallback, "share": round(count_fallback / total, 6) if total > 0 else 0.0},
        },
        "deadband": {
            "total_unclassified": total_unclassified,
            "share_unclassified": share_unclassified,
            "price_deadband_triggered": price_db_triggered,
            "oi_deadband_triggered": oi_db_triggered,
        },
        "spreads": {
            "total_doi": spread_total_doi,
            "spread_attributed_doi": spread_attributed_doi,
            "spread_share": spread_share_val,
            "by_type": by_type_counts,
        },
    }


# ---------------------------------------------------------------------------
# Diagnostic 2 — Price impact history
# ---------------------------------------------------------------------------

def diagnostic_price_impact(
    conn,
    start_date: date,
    end_date: date,
    as_of_date: date,
    params: dict,
    bucket: str = "whites",
) -> dict:
    """
    Price impact per contract created: |Δr| / |ΔOI|.
    Exposes the impact history with trailing z-score.
    """
    # Fetch settlement prices, OI, and volume for the bucket's contracts
    sql = """
        WITH lagged AS (
            SELECT
                d.contract_id,
                d.trade_date,
                d.settlement_price,
                d.open_interest,
                d.volume,
                LAG(d.settlement_price) OVER (PARTITION BY d.contract_id ORDER BY d.trade_date) AS prev_price,
                LAG(d.open_interest)    OVER (PARTITION BY d.contract_id ORDER BY d.trade_date) AS prev_oi,
                c.expiry_date,
                c.contract_type
            FROM daily_obs d
            JOIN contracts c ON c.contract_id = d.contract_id
            WHERE d.knowledge_date <= ?
              AND c.contract_type = 'quarterly'
        )
        SELECT
            contract_id, trade_date,
            settlement_price, prev_price, open_interest, prev_oi, volume, expiry_date
        FROM lagged
        WHERE trade_date >= ?
          AND trade_date <= ?
          AND prev_price IS NOT NULL
          AND prev_oi IS NOT NULL
        ORDER BY contract_id, trade_date
    """
    rows = conn.execute(
        sql,
        (as_of_date.isoformat(), start_date.isoformat(), end_date.isoformat()),
    ).fetchall()

    if not rows:
        return {
            "bucket": bucket,
            "history": [],
            "current": {"impact_median": 0.0, "impact_90pct": 0.0},
            "zscore": 0.0,
        }

    from ..core.rolls import assign_pack

    # Build daily impact per date
    df = pd.DataFrame([dict(r) for r in rows])
    df["trade_date"] = pd.to_datetime(df["trade_date"]).dt.date
    df["expiry_date"] = pd.to_datetime(df["expiry_date"]).dt.date

    # Assign pack rank
    pack_lookup: dict[tuple, str] = {}
    for td, grp in df.groupby("trade_date"):
        sorted_ids = grp.sort_values("expiry_date")["contract_id"].tolist()
        for i, cid in enumerate(sorted_ids):
            pack_lookup[(cid, td)] = assign_pack(i + 1)

    df["pack"] = df.apply(lambda r: pack_lookup.get((r["contract_id"], r["trade_date"])), axis=1)

    # Filter to requested bucket
    bucket_df = df[df["pack"] == bucket].copy()

    if bucket_df.empty:
        return {
            "bucket": bucket,
            "history": [],
            "current": {"impact_median": 0.0, "impact_90pct": 0.0},
            "zscore": 0.0,
        }

    # Compute impact = |Δr| / |ΔOI| where |ΔOI| > 0
    # Δr = -(settlement - prev_price), ΔOI = open_interest - prev_oi
    bucket_df["dr"] = -(bucket_df["settlement_price"] - bucket_df["prev_price"])
    bucket_df["doi"] = bucket_df["open_interest"] - bucket_df["prev_oi"]
    bucket_df = bucket_df[bucket_df["doi"].abs() > 0].copy()
    bucket_df["impact"] = bucket_df["dr"].abs() / bucket_df["doi"].abs()

    # Daily aggregates
    daily_groups = []
    for td, grp in bucket_df.groupby("trade_date"):
        impacts = grp["impact"].dropna()
        impacts = impacts[impacts > 0]
        if len(impacts) == 0:
            continue
        daily_groups.append({
            "date": td,
            "impact_median": float(impacts.median()),
            "impact_90pct": float(impacts.quantile(0.90)),
            "n_contracts": int(len(grp)),
        })

    if not daily_groups:
        return {
            "bucket": bucket,
            "history": [],
            "current": {"impact_median": 0.0, "impact_90pct": 0.0},
            "zscore": 0.0,
        }

    daily_df = pd.DataFrame(daily_groups).set_index("date").sort_index()

    # Trailing z-score of median impact
    impact_med = daily_df["impact_median"]
    roll_mean = impact_med.rolling(window=252, min_periods=20).mean()
    roll_std = impact_med.rolling(window=252, min_periods=20).std()
    zscore_series = (impact_med - roll_mean) / roll_std.replace(0, np.nan)

    cur_median = _safe_float(impact_med.iloc[-1])
    cur_90pct = _safe_float(daily_df["impact_90pct"].iloc[-1])
    cur_zscore = _safe_float(zscore_series.iloc[-1])

    history = []
    for td in daily_df.index:
        history.append({
            "date": td.isoformat() if hasattr(td, "isoformat") else str(td),
            "impact_median": _safe_float(daily_df.loc[td, "impact_median"]),
            "impact_90pct": _safe_float(daily_df.loc[td, "impact_90pct"]),
            "n_contracts": int(daily_df.loc[td, "n_contracts"]),
        })

    return {
        "bucket": bucket,
        "history": history,
        "current": {"impact_median": cur_median, "impact_90pct": cur_90pct},
        "zscore": cur_zscore,
    }


# ---------------------------------------------------------------------------
# Diagnostic 3 — Conditional forward returns (structure only)
# ---------------------------------------------------------------------------

def diagnostic_conditional_returns(
    conn,
    as_of_date: date,
    params: dict,
    percentile_thresholds: list = None,
) -> dict:
    """
    Conditional forward return analysis at positioning extremes.

    NOTE: Forward returns are deliberately left as None — supply externally.
    This function computes the STRUCTURE only (extreme episodes, dates, levels).

    Returns the structure with forward_return fields set to None.
    """
    if percentile_thresholds is None:
        percentile_thresholds = [0.10, 0.25, 0.75, 0.90]

    # Build DV01 timeseries for zscore_total
    lookback_days = 756
    start_date = as_of_date - timedelta(days=int(lookback_days * 1.4) + 30)

    ts = build_dv01_timeseries(conn, start_date, as_of_date, as_of_date, params)

    if ts.empty or "zscore_total" not in ts.columns:
        return {
            "note": "Forward returns must be supplied externally — see spec §9.2",
            "extreme_long_episodes": [],
            "extreme_short_episodes": [],
            "percentile_thresholds": percentile_thresholds,
            "current_percentile": 0.5,
        }

    zscore = ts["zscore_total"].dropna()
    total_dv01 = ts["total_net_dv01"].reindex(zscore.index)

    if len(zscore) < 20:
        return {
            "note": "Forward returns must be supplied externally — see spec §9.2",
            "extreme_long_episodes": [],
            "extreme_short_episodes": [],
            "percentile_thresholds": percentile_thresholds,
            "current_percentile": 0.5,
        }

    # Compute percentile thresholds on the zscore series
    pct_values = {p: float(zscore.quantile(p)) for p in percentile_thresholds}

    long_threshold = pct_values.get(max(percentile_thresholds), 1.5)
    short_threshold = pct_values.get(min(percentile_thresholds), -1.5)

    def _find_episodes(series: pd.Series, dv01_series: pd.Series, threshold: float, above: bool, min_days: int = 3) -> list:
        """Identify contiguous episodes where z-score is above/below threshold for ≥ min_days."""
        if above:
            flag = series >= threshold
        else:
            flag = series <= threshold

        episodes = []
        in_episode = False
        ep_dates = []

        for td in series.index:
            if flag.loc[td]:
                if not in_episode:
                    in_episode = True
                    ep_dates = [td]
                else:
                    ep_dates.append(td)
            else:
                if in_episode:
                    if len(ep_dates) >= min_days:
                        peak_idx = series.loc[ep_dates].abs().idxmax()
                        peak_zscore = float(series.loc[peak_idx])
                        peak_dv01 = float(dv01_series.loc[peak_idx]) if peak_idx in dv01_series.index else 0.0
                        episodes.append({
                            "start_date": ep_dates[0].isoformat() if hasattr(ep_dates[0], "isoformat") else str(ep_dates[0]),
                            "end_date": ep_dates[-1].isoformat() if hasattr(ep_dates[-1], "isoformat") else str(ep_dates[-1]),
                            "peak_zscore": round(peak_zscore, 6),
                            "peak_dv01_eur": round(peak_dv01, 6),
                            "forward_return_1m": None,
                        })
                    in_episode = False
                    ep_dates = []

        # Close out final episode
        if in_episode and len(ep_dates) >= min_days:
            peak_idx = series.loc[ep_dates].abs().idxmax()
            peak_zscore = float(series.loc[peak_idx])
            peak_dv01 = float(dv01_series.loc[peak_idx]) if peak_idx in dv01_series.index else 0.0
            episodes.append({
                "start_date": ep_dates[0].isoformat() if hasattr(ep_dates[0], "isoformat") else str(ep_dates[0]),
                "end_date": ep_dates[-1].isoformat() if hasattr(ep_dates[-1], "isoformat") else str(ep_dates[-1]),
                "peak_zscore": round(peak_zscore, 6),
                "peak_dv01_eur": round(peak_dv01, 6),
                "forward_return_1m": None,
            })

        return episodes

    extreme_long_episodes = _find_episodes(zscore, total_dv01, long_threshold, above=True)
    extreme_short_episodes = _find_episodes(zscore, total_dv01, short_threshold, above=False)

    # Current percentile rank
    cur_z = float(zscore.iloc[-1])
    current_percentile = round(float((zscore < cur_z).sum()) / len(zscore), 6)

    return {
        "note": "Forward returns must be supplied externally — see spec §9.2",
        "extreme_long_episodes": extreme_long_episodes,
        "extreme_short_episodes": extreme_short_episodes,
        "percentile_thresholds": list(percentile_thresholds),
        "current_percentile": current_percentile,
    }
