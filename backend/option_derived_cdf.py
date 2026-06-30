"""
option_derived_cdf.py — Swaption market parameters for the Option-Implied CDF tool.

The Gram-Charlier math lives entirely in the frontend.  This module's only job is
to provide live forward swap rates and ATM normal implied vols so the controls
pre-populate with current market levels instead of the hardcoded mid-2025 table.

Data sources
------------
bloomberg (live)
  • Par swap rates:      BDH PX_LAST on spot swap tickers (proxy for ATM forward)
  • Swaption ATM vol:   BDH PX_LAST on swaption vol matrix tickers (bp/yr from BBG)

simulation (fallback — mirrors frontend FWD_RATE / ANNUAL_VOL tables exactly)
  • Forward: static table keyed by (ccy, tail)
  • Vol at expiry T: annualVol × √T

Bloomberg tickers (verify in terminal: SWVOL <Go> or VCUB <Go>)
---------------------------------------------------------------
Par swap rates:
  USD   USSW{n} Curncy       e.g. USSW10 Curncy
  EUR   EUSA{n} Curncy       e.g. EUSA10 Curncy
  GBP   BPSWS{n} Curncy      e.g. BPSWS10 Curncy

Swaption ATM normal vol (bp/yr; divide by 100 → %/yr):
  USD   USSN{exp}{tail} Curncy   e.g. USSN6M10Y Curncy
  EUR   EUSN{exp}{tail} Curncy   e.g. EUSN1Y5Y Curncy
  GBP   BPSN{exp}{tail} Curncy   e.g. BPSN3M10Y Curncy

Output units
------------
forward  — %   (e.g. 4.52)
vol      — % at expiry T, i.e. annualVol × √T   (e.g. 0.53 for 6m at 1.05 %/yr)
skew     — Gram-Charlier γ₁, dimensionless, negative for left-skew
"""
from __future__ import annotations

import math
import os
from typing import Optional

import pandas as pd

DATA_SOURCE = os.environ.get("ANALYTICS_DATA_SOURCE", "simulation").lower()

# ---------------------------------------------------------------------------
# Dimensions
# ---------------------------------------------------------------------------

CURRENCIES = ["USD", "EUR", "GBP"]
EXPIRIES   = ["1m", "3m", "6m", "1y", "2y", "3y", "5y", "7y", "10y"]
TAILS      = ["1y", "2y", "5y", "10y", "15y", "20y", "30y"]

EXPIRY_YEARS: dict[str, float] = {
    "1m": 1 / 12, "3m": 0.25, "6m": 0.5,
    "1y": 1.0, "2y": 2.0, "3y": 3.0, "5y": 5.0, "7y": 7.0, "10y": 10.0,
}

# ---------------------------------------------------------------------------
# Static calibration — mirrors frontend constants exactly (mid-2025 levels)
# ---------------------------------------------------------------------------

_FWD_RATE: dict[str, dict[str, float]] = {
    "USD": {"1y": 4.65, "2y": 4.45, "5y": 4.35, "10y": 4.50, "15y": 4.60, "20y": 4.65, "30y": 4.70},
    "EUR": {"1y": 2.20, "2y": 2.25, "5y": 2.45, "10y": 2.60, "15y": 2.70, "20y": 2.75, "30y": 2.80},
    "GBP": {"1y": 3.90, "2y": 3.95, "5y": 4.05, "10y": 4.20, "15y": 4.30, "20y": 4.35, "30y": 4.40},
}

_ANNUAL_VOL: dict[str, dict[str, float]] = {
    "USD": {"1y": 1.20, "2y": 1.00, "5y": 0.85, "10y": 0.75, "15y": 0.70, "20y": 0.67, "30y": 0.65},
    "EUR": {"1y": 0.85, "2y": 0.75, "5y": 0.65, "10y": 0.60, "15y": 0.57, "20y": 0.55, "30y": 0.52},
    "GBP": {"1y": 1.05, "2y": 0.90, "5y": 0.78, "10y": 0.70, "15y": 0.65, "20y": 0.62, "30y": 0.60},
}

# Skew base (same heuristic as frontend BASE_SKEW + √T decay)
_BASE_SKEW: dict[str, float] = {"USD": -0.45, "EUR": -0.30, "GBP": -0.40}

# ---------------------------------------------------------------------------
# Bloomberg ticker builders
# ---------------------------------------------------------------------------

# Par swap rate tickers — PX_LAST gives the spot par swap rate (proxy for ATM fwd)
_SWAP_TICKERS: dict[str, dict[str, str]] = {
    "USD": {t: f"USSW{t.rstrip('y')} Curncy"  for t in TAILS},   # USSW10 Curncy
    "EUR": {t: f"EUSA{t.rstrip('y')} Curncy"  for t in TAILS},   # EUSA10 Curncy
    "GBP": {t: f"BPSWS{t.rstrip('y')} Curncy" for t in TAILS},   # BPSWS10 Curncy
}

_VOL_CCY_PREFIX: dict[str, str] = {"USD": "USS", "EUR": "EUS", "GBP": "BPS"}


def _vol_ticker(ccy: str, expiry: str, tail: str) -> str:
    """
    ATM normal swaption vol ticker.
    Bloomberg returns the value in bp/yr; convert → %/yr by dividing by 100.
    Examples: USSN6M10Y Curncy, EUSN1Y5Y Curncy, BPSN3M10Y Curncy
    """
    prefix = _VOL_CCY_PREFIX[ccy]
    return f"{prefix}N{expiry.upper()}{tail.upper()} Curncy"


# ---------------------------------------------------------------------------
# Bloomberg fetching
# ---------------------------------------------------------------------------

def _last_value(df: pd.DataFrame, ticker: str) -> Optional[float]:
    """Extract the most recent non-NaN PX_LAST for a ticker from a BDH result."""
    col = (ticker, "PX_LAST")
    if col not in df.columns:
        return None
    series = df[col].dropna()
    return float(series.iloc[-1]) if not series.empty else None


def _fetch_swap_rates(ccy: str) -> Optional[dict[str, float]]:
    """
    Fetch the most recent par swap rate for every tail in TAILS.
    Returns {tail: rate_%} or None on any failure.
    The spot par rate is a good proxy for the ATM forward swap rate;
    any convexity adjustment is well within the tool's rounding.
    """
    if DATA_SOURCE != "bloomberg":
        return None
    try:
        from bbg import blp
        ticker_map = _SWAP_TICKERS[ccy]  # {tail: ticker}
        tickers = list(ticker_map.values())
        today = pd.Timestamp.today().strftime("%Y%m%d")
        start = (pd.Timestamp.today() - pd.offsets.BDay(5)).strftime("%Y%m%d")
        df = blp.bdh(tickers, "PX_LAST", start, today)
        if df is None or df.empty:
            return None
        result: dict[str, float] = {}
        for tail, ticker in ticker_map.items():
            v = _last_value(df, ticker)
            if v is not None:
                result[tail] = round(v, 3)
        return result or None
    except Exception:
        return None


def _fetch_swaption_vols(ccy: str, tail: str) -> Optional[dict[str, float]]:
    """
    Fetch ATM normal swaption vol for every expiry at the given tail.
    Bloomberg returns bp/yr; this function converts to % at-expiry (vol × √T).
    Returns {expiry: vol_%_at_T} or None on any failure.
    """
    if DATA_SOURCE != "bloomberg":
        return None
    try:
        from bbg import blp
        ticker_map = {exp: _vol_ticker(ccy, exp, tail) for exp in EXPIRIES}
        tickers = list(ticker_map.values())
        today = pd.Timestamp.today().strftime("%Y%m%d")
        start = (pd.Timestamp.today() - pd.offsets.BDay(5)).strftime("%Y%m%d")
        df = blp.bdh(tickers, "PX_LAST", start, today)
        if df is None or df.empty:
            return None
        result: dict[str, float] = {}
        for exp, ticker in ticker_map.items():
            v = _last_value(df, ticker)
            if v is not None:
                # BBG value is bp/yr normal vol; convert: bp/100 = %/yr; then × √T
                ann_vol_pct = v / 100.0
                result[exp] = round(ann_vol_pct * math.sqrt(EXPIRY_YEARS[exp]), 2)
        return result or None
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Skew heuristic (same formula as frontend)
# ---------------------------------------------------------------------------

def _heuristic_skew(ccy: str, T: float) -> float:
    return round(_BASE_SKEW[ccy] - 0.08 * math.sqrt(T), 2)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def get_option_cdf_params(ccy: str, tail: str) -> dict:
    """
    Return forward rates, ATM normal vols, and skew for every expiry
    for the selected (ccy, tail) combination.

    Response shape::

        {
            "ccy":         "USD",
            "tail":        "10y",
            "data_source": "bloomberg" | "simulation",
            "params": {
                "1m": {"forward": 4.52, "vol": 0.22, "skew": -0.46},
                "3m": {"forward": 4.52, "vol": 0.38, "skew": -0.49},
                ...
            }
        }

    Notes
    -----
    forward  — current spot par swap rate at tail tenor (%)
    vol      — ATM normal implied vol scaled to expiry T: annVol × √T (%)
    skew     — Gram-Charlier γ₁ from BASE_SKEW heuristic (same as frontend)
    """
    ccy  = ccy.upper()
    tail = tail.lower()

    if ccy not in CURRENCIES:
        raise ValueError(f"Unknown currency '{ccy}'. Must be one of {CURRENCIES}")
    if tail not in TAILS:
        raise ValueError(f"Unknown tail '{tail}'. Must be one of {TAILS}")

    live_rates = _fetch_swap_rates(ccy)           # {tail: rate_%} or None
    live_vols  = _fetch_swaption_vols(ccy, tail)  # {expiry: vol_%_at_T} or None
    data_source = "bloomberg" if (live_rates or live_vols) else "simulation"

    params: dict[str, dict] = {}
    for exp in EXPIRIES:
        T = EXPIRY_YEARS[exp]

        forward = (
            live_rates[tail]
            if live_rates and tail in live_rates
            else _FWD_RATE[ccy][tail]
        )
        vol = (
            live_vols[exp]
            if live_vols and exp in live_vols
            else round(_ANNUAL_VOL[ccy][tail] * math.sqrt(T), 2)
        )
        params[exp] = {
            "forward": forward,
            "vol":     vol,
            "skew":    _heuristic_skew(ccy, T),
        }

    return {
        "ccy":         ccy,
        "tail":        tail,
        "data_source": data_source,
        "params":      params,
    }
