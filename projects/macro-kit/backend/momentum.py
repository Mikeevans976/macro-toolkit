"""
momentum.py — Multi-lookback, volatility-scaled CTA signal engine.

No external dependencies beyond numpy, pandas, scipy.
Bloomberg fetch is attempted; falls back to deterministic simulation when
blpapi is not importable or Bloomberg is not connected.
"""
from __future__ import annotations

import hashlib
import math
from typing import Any

import numpy as np
import pandas as pd
from scipy.stats import percentileofscore

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

LOOKBACKS: dict[str, int] = {"1M": 21, "3M": 63, "6M": 126, "12M": 252}
VOL_WINDOW = 63       # trailing vol days
VOL_TARGET = 0.10     # 10 % annual vol target for position sizing

# Minimum history required before we produce any signals
MIN_HISTORY = max(LOOKBACKS.values()) + VOL_WINDOW  # 252 + 63 = 315 days


# ---------------------------------------------------------------------------
# Simulation helpers
# ---------------------------------------------------------------------------

def _ticker_seed(ticker: str) -> int:
    """Deterministic integer seed derived from ticker string."""
    return int(hashlib.md5(ticker.encode()).hexdigest(), 16) % (2**31)


def _simulate_series(ticker: str, start: str = "2010-01-01") -> pd.Series:
    """
    Regime-switching random walk seeded by ticker name.
    Alternates trending and choppy regimes, ~40–160 days each.
    Returns a daily price series indexed by business dates.
    """
    rng = np.random.default_rng(_ticker_seed(ticker))
    dates = pd.bdate_range(start=start, end=pd.Timestamp.today())
    n = len(dates)

    prices: list[float] = [100.0]
    i = 0
    while i < n - 1:
        # Regime length: uniform 40–160 days
        regime_len = int(rng.integers(40, 161))
        # Trending or choppy?
        is_trending = rng.random() < 0.5
        if is_trending:
            drift = rng.choice([-1, 1]) * rng.uniform(0.03, 0.12) / 252
            vol = rng.uniform(0.06, 0.14) / math.sqrt(252)
        else:
            drift = 0.0
            vol = rng.uniform(0.01, 0.05) / math.sqrt(252)

        for _ in range(min(regime_len, n - 1 - i)):
            ret = drift + vol * rng.standard_normal()
            prices.append(prices[-1] * (1.0 + ret))
            i += 1

    series = pd.Series(prices[:n], index=dates, name=ticker)
    return series


# ---------------------------------------------------------------------------
# Bloomberg fetch (optional)
# ---------------------------------------------------------------------------

def _fetch_bloomberg(ticker: str, start: str) -> pd.Series | None:
    """
    Attempt to fetch via blpapi.  Returns None on any failure.
    """
    try:
        from bbg import blp  # type: ignore
        today = pd.Timestamp.today().strftime("%Y-%m-%d")
        raw = blp.bdh(
            tickers=[ticker],
            flds=["PX_LAST"],
            start_date=start,
            end_date=today,
        )
        if raw is None or raw.empty:
            return None
        # Handle MultiIndex columns (ticker, field)
        if isinstance(raw.columns, pd.MultiIndex):
            raw.columns = raw.columns.droplevel(0)
        col = "PX_LAST" if "PX_LAST" in raw.columns else raw.columns[0]
        s = raw[col].dropna()
        if len(s) < MIN_HISTORY:
            return None
        return s
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Signal computation
# ---------------------------------------------------------------------------

def _trailing_ann_vol(series: pd.Series) -> pd.Series:
    """Rolling 63-day annualised volatility of level changes."""
    return series.diff().rolling(VOL_WINDOW).std() * math.sqrt(252)


def _compute_signal(series: pd.Series, L: int) -> pd.Series:
    """
    signal_L(t) = diff(series, L)(t) / (trailing_ann_vol(t) * sqrt(L/252))

    Both numerator and denominator are in the same units (level changes),
    so the result is dimensionless regardless of whether the input is a
    price series or a yield series.
    Individual signals are capped at ±5 to prevent outliers.
    """
    level_diff = series.diff(L)
    vol = _trailing_ann_vol(series)
    denom = vol * math.sqrt(L / 252)
    with np.errstate(invalid="ignore", divide="ignore"):
        sig = level_diff / denom
    return sig.replace([np.inf, -np.inf], np.nan).clip(-5, 5)


def _label_from_composite(z: float | None) -> str:
    if z is None or math.isnan(z):
        return "Neutral"
    if z > 1.5:
        return "Strong Long"
    if z > 0.5:
        return "Long"
    if z > -0.5:
        return "Neutral"
    if z > -1.5:
        return "Short"
    return "Strong Short"


def _safe(val: Any) -> float | None:
    """Convert numpy scalar to Python float, returning None for NaN/inf."""
    if val is None:
        return None
    try:
        f = float(val)
        return None if (math.isnan(f) or math.isinf(f)) else f
    except (TypeError, ValueError):
        return None


def _to_list(series: pd.Series) -> list[float | None]:
    return [_safe(v) for v in series]


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def compute_cta_signals(ticker: str, start: str = "2010-01-01") -> dict:
    """
    Compute multi-lookback CTA signals for *ticker*.

    Falls back to deterministic simulation when Bloomberg is unavailable.
    """
    simulated = False
    series = _fetch_bloomberg(ticker, start)
    if series is None:
        series = _simulate_series(ticker, start)
        simulated = True

    display_ticker = f"{ticker} [simulated]" if simulated else ticker

    # ── compute per-lookback signals ─────────────────────────────────────────
    signals: dict[str, pd.Series] = {}
    for name, L in LOOKBACKS.items():
        signals[name] = _compute_signal(series, L)

    # ── composite: equal-weight mean ─────────────────────────────────────────
    signal_df = pd.DataFrame(signals)
    composite = signal_df.mean(axis=1, skipna=False)  # NaN if ANY lookback is NaN

    # ── annualised vol for position sizing (return-based so price level doesn't
    #    distort sizing — level-change vol makes positions ~0 for high-priced series)
    with np.errstate(invalid="ignore", divide="ignore"):
        ann_vol_ret = series.pct_change().rolling(VOL_WINDOW).std() * math.sqrt(252)
    ann_vol_ret = ann_vol_ret.replace([np.inf, -np.inf], np.nan)

    # ── position ─────────────────────────────────────────────────────────────
    with np.errstate(invalid="ignore", divide="ignore"):
        position = (VOL_TARGET * composite / ann_vol_ret).clip(-8, 8)
    position = position.replace([np.inf, -np.inf], np.nan)

    # ── drop the first MIN_HISTORY rows ──────────────────────────────────────
    drop_n = MIN_HISTORY
    series    = series.iloc[drop_n:]
    composite = composite.iloc[drop_n:]
    position  = position.iloc[drop_n:]
    for name in signals:
        signals[name] = signals[name].iloc[drop_n:]

    # ── subsample to every 5th point, always keeping last row ────────────────
    idx_all = np.arange(len(series))
    keep = set(idx_all[::5])
    keep.add(len(series) - 1)
    keep_sorted = sorted(keep)

    def sub(s: pd.Series) -> pd.Series:
        return s.iloc[keep_sorted]

    series_sub    = sub(series)
    composite_sub = sub(composite)
    position_sub  = sub(position)
    signals_sub   = {name: sub(signals[name]) for name in signals}

    dates_out = [d.strftime("%Y-%m-%d") for d in series_sub.index]

    # ── current state ─────────────────────────────────────────────────────────
    cur_composite = _safe(composite.iloc[-1])
    cur_position  = _safe(position.iloc[-1])

    # Percentile of composite over the full (non-subsampled) history
    hist_composite = composite.dropna().values
    if cur_composite is not None and len(hist_composite) > 0:
        pctile = float(percentileofscore(hist_composite, cur_composite, kind="rank"))
    else:
        pctile = 50.0

    cur_signals = {name: _safe(signals[name].iloc[-1]) for name in LOOKBACKS}

    current = {
        "date":             series.index[-1].strftime("%Y-%m-%d"),
        "series_value":     _safe(series.iloc[-1]),
        "composite":        cur_composite,
        "composite_pctile": pctile,
        "label":            _label_from_composite(cur_composite),
        "signals":          cur_signals,
        "position":         cur_position,
    }

    return {
        "ticker":    display_ticker,
        "dates":     dates_out,
        "series":    _to_list(series_sub),
        "composite": _to_list(composite_sub),
        "position":  _to_list(position_sub),
        "signals":   {name: _to_list(signals_sub[name]) for name in LOOKBACKS},
        "current":   current,
    }
