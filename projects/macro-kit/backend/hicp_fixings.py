"""
HICP monthly fixings — Euro Area.

Bloomberg data convention
-------------------------
EUSWIF{n} / EUSWIT{n} Comdty — Bloomberg returns the *%YoY* rate via
PX_LAST (the implied annual change of the HICPxT index for that calendar
month vs the same month 12 months prior), NOT a raw index level.

    YoY(t) = 100 × [Index(t) / Index(t − 12mo) − 1]

To recover index levels we need the historical EUHICPXT Index (HICP
excluding tobacco — the index against which all HICPxT fixings settle).
That history is fetched via BDH.

Reconstruction
--------------
F-series (fixings 1–12, covering the 12 calendar months starting one year
ahead of today):

    Level_F(t) = EUHICPXT_hist(t − 12mo) × (1 + YoY_F(t) / 100)

T-series (fixings 13–24, the following 12-month cycle):

    Level_T(t) = Level_F(t − 12mo) × (1 + YoY_T(t) / 100)
    ← uses the already-reconstructed F-series level as the base

MoM NSA  = (Level(t) / Level(t−1) − 1) × 100
MoM SA   = MoM NSA − seasonal_factor[calendar_month]
           seasonal factors = per-month average MoM over trailing history

Simulation fallback
-------------------
When Bloomberg is unavailable, a deterministic simulation is used:
1. Fake EUHICPXT history is generated with realistic seasonal pattern.
2. Fake YoY rates are derived from that simulated history.
3. Level reconstruction then runs identically to the Bloomberg path.
"""

from __future__ import annotations

import json
import os
from datetime import date
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd

# ─── Catalogue (single source of truth) ───────────────────────────────────────

_CAT_PATH = Path(__file__).parent / "data" / "series_catalogue_hicp_fixings.json"

with open(_CAT_PATH) as _f:
    _CAT = json.load(_f)

_fix         = _CAT["fixings"]
_TEMPLATE_F  = _fix["f_series"]["ticker_template"]
_TEMPLATE_T  = _fix["t_series"]["ticker_template"]
_TICKERS_F   = [_TEMPLATE_F.replace("{n}", str(n)) for n in _fix["f_series"]["tenors"]]
_TICKERS_T   = [_TEMPLATE_T.replace("{n}", str(n)) for n in _fix["t_series"]["tenors"]]
_TICKER_HIST = next(s["ticker_bloomberg"] for s in _CAT["historical_series"] if s.get("base_for_reconstruction"))

# ─── Bloomberg fetch — YoY rates ──────────────────────────────────────────────

def _bloomberg_yoy_rates() -> Optional[dict[str, float]]:
    """
    Fetch YoY rates from all 24 fixing tickers via BDP snapshot.
    Returns {ticker: yoy_pct} or None on any failure.
    """
    try:
        from bbg import blp
        all_tickers = _TICKERS_F + _TICKERS_T
        df = blp.bdp(all_tickers, "PX_LAST")
        if df.empty:
            return None
        return {
            t: float(df.loc[t, "PX_LAST"])
            for t in all_tickers
            if t in df.index
        }
    except Exception:
        return None


# ─── Bloomberg fetch — EUHICPXT history ───────────────────────────────────────

def _bloomberg_hicp_xt_history(n_months: int = 48) -> Optional[pd.Series]:
    """
    Fetch monthly EUHICPXT Index history via BDH.
    Returns pd.Series indexed by pd.Timestamp (month-start), or None on failure.
    We fetch 48 months so there is always a valid 12-months-prior base for each
    F-series fixing and enough data to compute robust seasonal factors.
    """
    try:
        from bbg import blp
        start = (pd.Timestamp.today() - pd.DateOffset(months=n_months)).strftime("%Y%m%d")
        end   = pd.Timestamp.today().strftime("%Y%m%d")
        df = blp.bdh(_TICKER_HIST, ["PX_LAST"], start, end, periodicity="MONTHLY")
        if df is None or df.empty:
            return None
        s = df["PX_LAST"].copy()
        s.index = pd.to_datetime(s.index).to_period("M").to_timestamp()
        return s.sort_index().dropna()
    except Exception:
        return None


# ─── Seasonal factors ─────────────────────────────────────────────────────────

def _seasonal_factors(hist: pd.Series) -> dict[int, float]:
    """
    Average MoM % change by calendar month over the full history provided.
    Used as additive seasonal correction: MoM SA ≈ MoM NSA − factor[month].
    """
    buckets: dict[int, list[float]] = {m: [] for m in range(1, 13)}
    vals = hist.sort_index()
    for i in range(1, len(vals)):
        m   = vals.index[i].month
        mom = (vals.iloc[i] / vals.iloc[i - 1] - 1.0) * 100.0
        buckets[m].append(mom)
    return {
        m: float(np.mean(v)) if v else 0.0
        for m, v in buckets.items()
    }


# ─── Simulation fallback ───────────────────────────────────────────────────────

# Approximate HICP-XT seasonal MoM pattern (%, Jan=index 0 … Dec=11).
# Calibrated to Euro Area observed seasonal pattern; normalised to zero mean.
_SEASONAL_MOM_PCT = [
    -0.55, -0.20, +0.55, +0.40, +0.10, +0.05,
    -0.30, -0.20, +0.15, -0.05, +0.00, +0.05,
]


def _sim_hicp_xt_history(
    first_month: pd.Timestamp,
    n_back: int = 48,
    annual_growth: float = 0.021,
    start_level: float = 130.0,
) -> pd.Series:
    """
    Simulated EUHICPXT history ending the month before first_month.
    Deterministic given the same arguments.
    """
    monthly_trend = (1.0 + annual_growth) ** (1.0 / 12) - 1.0
    level = start_level
    start = first_month - pd.DateOffset(months=n_back)
    idx:  list[pd.Timestamp] = []
    vals: list[float]        = []
    for i in range(n_back):
        cal      = start + pd.DateOffset(months=i)
        seasonal = _SEASONAL_MOM_PCT[cal.month - 1] / 100.0
        level   *= 1.0 + monthly_trend + seasonal
        idx.append(pd.Timestamp(cal.year, cal.month, 1))
        vals.append(round(level, 2))
    return pd.Series(vals, index=pd.DatetimeIndex(idx))


def _sim_yoy_rates(
    first_month: pd.Timestamp,
    hist: pd.Series,
) -> dict[str, float]:
    """
    Derive YoY rates consistent with the simulated history and a gentle
    2 % forward trend.  We walk the reconstructed forward levels back to
    YoY = 100 × (Level_sim(t) / hist(t−12mo) − 1).
    """
    annual_growth = 0.020
    monthly_trend = (1.0 + annual_growth) ** (1.0 / 12) - 1.0
    hist_idx = {ts.strftime("%Y-%m"): v for ts, v in hist.items()}

    f_levels: dict[str, float] = {}
    rates:    dict[str, float] = {}
    prev_level = float(hist.iloc[-1])

    for i in range(24):
        cal   = first_month + pd.DateOffset(months=i)
        is_t  = (i >= 12)
        ticker = _ticker(cal, is_t)

        seasonal    = _SEASONAL_MOM_PCT[cal.month - 1] / 100.0
        level_sim   = prev_level * (1.0 + monthly_trend + seasonal)
        prev_level  = level_sim

        base_month_str = (cal - pd.DateOffset(months=12)).strftime("%Y-%m")
        if not is_t:
            base_level = hist_idx.get(base_month_str)
        else:
            base_level = f_levels.get(base_month_str)

        if base_level:
            yoy = (level_sim / base_level - 1.0) * 100.0
        else:
            yoy = annual_growth * 100.0

        rates[ticker] = round(yoy, 4)
        if not is_t:
            f_levels[cal.strftime("%Y-%m")] = level_sim

    return rates


# ─── Ticker helper ─────────────────────────────────────────────────────────────

def _ticker(cal: pd.Timestamp, is_t_series: bool) -> str:
    template = _TEMPLATE_T if is_t_series else _TEMPLATE_F
    return template.replace("{n}", str(cal.month))


# ─── Level reconstruction ──────────────────────────────────────────────────────

def _reconstruct_levels(
    yoy_rates: dict[str, float],
    hist: pd.Series,
    first_month: pd.Timestamp,
) -> list[Optional[float]]:
    """
    Reconstruct 24 monthly index levels from YoY rates and EUHICPXT history.

    F-series (i < 12):
        Level(t) = hist[t − 12mo] × (1 + YoY/100)

    T-series (i >= 12):
        Level(t) = Level_F[t − 12mo] × (1 + YoY/100)

    Returns list of 24 float|None, ordered nearest → furthest.
    """
    hist_idx  = {ts.strftime("%Y-%m"): float(v) for ts, v in hist.items()}
    f_levels: dict[str, float] = {}
    out:      list[Optional[float]] = []

    for i in range(24):
        cal    = first_month + pd.DateOffset(months=i)
        is_t   = (i >= 12)
        ticker = _ticker(cal, is_t)
        yoy    = yoy_rates.get(ticker)

        base_key = (cal - pd.DateOffset(months=12)).strftime("%Y-%m")
        base_level: Optional[float] = (
            hist_idx.get(base_key) if not is_t else f_levels.get(base_key)
        )

        if yoy is not None and base_level is not None:
            level: Optional[float] = round(base_level * (1.0 + yoy / 100.0), 2)
        else:
            level = None

        if not is_t and level is not None:
            f_levels[cal.strftime("%Y-%m")] = level

        out.append(level)

    return out


# ─── Public entry point ────────────────────────────────────────────────────────

def get_hicp_fixings(as_of_date: Optional[str] = None) -> dict:
    """
    Return 24 HICP-XT monthly fixings ordered nearest → furthest.

    Bloomberg returns YoY rates via PX_LAST.  Levels are reconstructed from
    EUHICPXT historical data.

    Response shape
    --------------
    {
        "data_source"        : "bloomberg" | "simulation",
        "as_of_date"         : "YYYY-MM-DD",
        "last_known_hicp_xt" : <float>,          # last historical EUHICPXT level
        "hicp_xt_history"    : [                 # last 24 months, for chart continuity
            {"month": "YYYY-MM", "level": float},
            ...
        ],
        "fixings" : [
            {
                "month_num"      : 8,
                "ticker"         : "EUSWIF8 Comdty",
                "calendar_month" : "2026-08",
                "yoy_implied"    : 2.15,          # raw BBG YoY rate (%)
                "level"          : 140.21,         # reconstructed index level
                "mom_nsa"        : 0.183,          # MoM not seasonally adjusted (%)
                "mom_sa"         : -0.117,         # MoM seasonally adjusted (%)
            },
            ...
        ]
    }
    """
    today       = as_of_date or date.today().isoformat()
    ref         = pd.Timestamp(today)
    first_month = pd.Timestamp(ref.year + 1, ref.month, 1)

    source  = os.environ.get("ANALYTICS_DATA_SOURCE", "csv").lower()
    use_bbg = source == "bloomberg"

    # ── History ───────────────────────────────────────────────────────────────
    hist: Optional[pd.Series] = _bloomberg_hicp_xt_history() if use_bbg else None
    if hist is None or hist.empty:
        hist        = _sim_hicp_xt_history(first_month, n_back=48)
        data_source = "simulation"
    else:
        data_source = "bloomberg"

    # ── Seasonal factors from history ─────────────────────────────────────────
    sea_factors = _seasonal_factors(hist)

    # ── YoY rates ─────────────────────────────────────────────────────────────
    yoy_rates: Optional[dict[str, float]] = _bloomberg_yoy_rates() if use_bbg else None
    if yoy_rates is None:
        yoy_rates   = _sim_yoy_rates(first_month, hist)
        data_source = "simulation"   # mark simulation if either path failed

    # ── Reconstruct levels ────────────────────────────────────────────────────
    levels = _reconstruct_levels(yoy_rates, hist, first_month)

    # ── Build fixings list ────────────────────────────────────────────────────
    last_known_xt = round(float(hist.iloc[-1]), 2)
    prev_level    = last_known_xt
    fixings:  list[dict] = []

    for i in range(24):
        cal    = first_month + pd.DateOffset(months=i)
        is_t   = (i >= 12)
        ticker = _ticker(cal, is_t)
        yoy    = yoy_rates.get(ticker)
        level  = levels[i]

        if level is not None:
            mom_nsa: Optional[float] = round((level / prev_level - 1.0) * 100.0, 3)
            sf  = sea_factors.get(cal.month, 0.0)
            mom_sa: Optional[float] = round(mom_nsa - sf, 3)
            prev_level = level
        else:
            mom_nsa = None
            mom_sa  = None

        fixings.append({
            "month_num":      int(cal.month),
            "ticker":         ticker,
            "calendar_month": cal.strftime("%Y-%m"),
            "yoy_implied":    round(yoy, 3) if yoy is not None else None,
            "level":          level,
            "mom_nsa":        mom_nsa,
            "mom_sa":         mom_sa,
        })

    # ── History tail for chart ────────────────────────────────────────────────
    hicp_xt_history = [
        {"month": ts.strftime("%Y-%m"), "level": round(float(v), 2)}
        for ts, v in hist.tail(24).items()
    ]

    return {
        "data_source":        data_source,
        "as_of_date":         today,
        "last_known_hicp_xt": last_known_xt,
        "hicp_xt_history":    hicp_xt_history,
        "fixings":            fixings,
    }
