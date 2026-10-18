"""
Bond and volatility maths shared across the RV tools.

Implements the building blocks of Huggins & Schaller, "Fixed Income Relative
Value Analysis" (2024), Ch 5 and Ch 19:

  - Yield-based measures: YTM, Macaulay / modified duration, convexity, all at
    compounding frequency c (H&S p.94-97).
  - Curve-based measures: Fisher–Weil duration and convexity, BPV and
    key-rate durations, which discount each cash flow on the actual zero
    curve rather than at the bond's single YTM. H&S recommend Fisher–Weil.
  - Normal ↔ lognormal implied-vol conversion: exact (price with one model,
    invert the other) and the quick ATM rule σ_N ≈ σ_LN · F (H&S Ch 19).
  - Realised normal vol in bp/yr with EWMA weights; H&S Figs 19.14–19.16 show
    how a rolling window creates fake drop-offs when a large move leaves it.

Everything works on plain arrays: cash-flow times (years), cash-flow amounts
(per 100 nominal) and, for the curve measures, a discount function
`discount(t) -> DF(t)` (e.g. from fitted_bond_curves or swaps_rv). Curve bumps
are parallel (or triangular, for key rates) shifts of the continuously
compounded zero curve: DF'(t) = DF(t) · exp(−Δ(t) · t).

Units: yields are decimal (0.025 = 2.5%). In the vol functions, forwards,
strikes and shifts are in percent, lognormal vols are decimal (0.25 = 25%)
and normal vols are bp per year.
"""

from __future__ import annotations

from typing import Callable

import numpy as np
import pandas as pd
from scipy.optimize import brentq
from scipy.stats import norm

DiscountFn = Callable[[np.ndarray], np.ndarray]

BP = 1e-4

# Default key-rate tenors (years)
KEY_TENORS = [2.0, 5.0, 10.0, 20.0, 30.0]


# ── Yield-based measures ───────────────────────────────────────────────────────

def _as_arrays(times, amounts) -> tuple[np.ndarray, np.ndarray]:
    t = np.asarray(times, dtype=float)
    a = np.asarray(amounts, dtype=float)
    if t.shape != a.shape:
        raise ValueError("times and amounts must have the same shape")
    return t, a


def price_from_yield(times, amounts, y: float, freq: int = 1) -> float:
    """Dirty price: Σ X_i · (1 + y/c)^(−c·T_i)."""
    t, a = _as_arrays(times, amounts)
    return float(np.sum(a * (1.0 + y / freq) ** (-freq * t)))


def ytm(times, amounts, dirty: float, freq: int = 1) -> float:
    """Yield to maturity (decimal) at compounding frequency `freq` from a dirty price."""
    t, a = _as_arrays(times, amounts)

    def f(y):
        return float(np.sum(a * (1.0 + y / freq) ** (-freq * t))) - dirty
    return brentq(f, -0.5 * freq + 1e-6, 1.0, xtol=1e-12)


def macaulay_duration(times, amounts, y: float, freq: int = 1) -> float:
    """PV-weighted average time to cash flow, every flow discounted at the single YTM."""
    t, a = _as_arrays(times, amounts)
    pv = a * (1.0 + y / freq) ** (-freq * t)
    return float(np.sum(t * pv) / np.sum(pv))


def modified_duration(times, amounts, y: float, freq: int = 1) -> float:
    """−(1/P) dP/dy = Macaulay / (1 + y/c)."""
    return macaulay_duration(times, amounts, y, freq) / (1.0 + y / freq)


def yield_convexity(times, amounts, y: float, freq: int = 1) -> float:
    """(1/P) d²P/dy² = Σ X_i · T_i · (T_i + 1/c) · (1 + y/c)^(−c·T_i − 2) / P."""
    t, a = _as_arrays(times, amounts)
    base = 1.0 + y / freq
    p = np.sum(a * base ** (-freq * t))
    return float(np.sum(a * t * (t + 1.0 / freq) * base ** (-freq * t - 2)) / p)


# ── Curve-based measures ───────────────────────────────────────────────────────

def price_from_curve(times, amounts, discount: DiscountFn,
                     shift: Callable[[np.ndarray], np.ndarray] | float = 0.0) -> float:
    """PV on the zero curve, optionally with a zero-rate shift Δ(t) (decimal)."""
    t, a = _as_arrays(times, amounts)
    dfs = np.asarray(discount(t), dtype=float)
    d = shift(t) if callable(shift) else shift
    return float(np.sum(a * dfs * np.exp(-np.asarray(d) * t)))


def fisher_weil_duration(times, amounts, discount: DiscountFn) -> float:
    """D_FW = Σ T_i · X_i · DF(T_i) / P: sensitivity to a parallel zero-curve shift."""
    t, a = _as_arrays(times, amounts)
    pv = a * np.asarray(discount(t), dtype=float)
    return float(np.sum(t * pv) / np.sum(pv))


def fisher_weil_convexity(times, amounts, discount: DiscountFn) -> float:
    """C_FW = Σ T_i² · X_i · DF(T_i) / P (continuously compounded zero shifts)."""
    t, a = _as_arrays(times, amounts)
    pv = a * np.asarray(discount(t), dtype=float)
    return float(np.sum(t * t * pv) / np.sum(pv))


def curve_bpv(times, amounts, discount: DiscountFn,
              shift: Callable[[np.ndarray], np.ndarray] | None = None) -> float:
    """
    Price gain (per 100 nominal) for a 1bp fall in the zero curve, by central
    difference. With `shift` = a shape Δ(t) per unit bp, gives that shape's BPV.
    """
    shape = shift if shift is not None else (lambda t: np.ones_like(t))
    up = price_from_curve(times, amounts, discount, lambda t: BP * shape(t))
    dn = price_from_curve(times, amounts, discount, lambda t: -BP * shape(t))
    return (dn - up) / 2.0


def _key_rate_shape(key_tenors: list[float], k: int) -> Callable[[np.ndarray], np.ndarray]:
    """Triangular weight for key tenor k: 1 at the tenor, 0 at its neighbours, flat beyond the ends."""
    def shape(t: np.ndarray) -> np.ndarray:
        unit = np.zeros(len(key_tenors))
        unit[k] = 1.0
        return np.interp(t, key_tenors, unit)   # np.interp holds end values flat
    return shape


def key_rate_durations(times, amounts, discount: DiscountFn,
                       key_tenors: list[float] = KEY_TENORS) -> list[dict]:
    """
    Key-rate durations and BPVs. The triangular weights sum to one at every
    maturity, so the key-rate durations sum to the Fisher–Weil duration.
    """
    p = price_from_curve(times, amounts, discount)
    out = []
    for k, tenor in enumerate(key_tenors):
        bpv = curve_bpv(times, amounts, discount, _key_rate_shape(key_tenors, k))
        out.append({'tenor': tenor, 'bpv': bpv, 'duration': bpv / (p * BP)})
    return out


def risk_report(times, amounts, discount: DiscountFn, freq: int = 1,
                key_tenors: list[float] = KEY_TENORS) -> dict:
    """Yield-based and curve-based measures side by side for one bond."""
    p = price_from_curve(times, amounts, discount)
    y = ytm(times, amounts, p, freq)
    return {
        'dirty': p,
        'ytm': y,
        'macaulay_duration': macaulay_duration(times, amounts, y, freq),
        'modified_duration': modified_duration(times, amounts, y, freq),
        'yield_convexity': yield_convexity(times, amounts, y, freq),
        'fisher_weil_duration': fisher_weil_duration(times, amounts, discount),
        'fisher_weil_convexity': fisher_weil_convexity(times, amounts, discount),
        'bpv': curve_bpv(times, amounts, discount),
        'key_rates': key_rate_durations(times, amounts, discount, key_tenors),
    }


# ── Normal ↔ lognormal vol ─────────────────────────────────────────────────────

def black_price(F: float, K: float, T: float, sigma_ln: float, shift: float = 0.0) -> float:
    """Undiscounted out-of-the-money (shifted) Black price, in percent. F, K, shift in %."""
    f, k = (F + shift) / 100.0, (K + shift) / 100.0
    if f <= 0 or k <= 0:
        raise ValueError("F + shift and K + shift must be positive for a lognormal model")
    s = sigma_ln * np.sqrt(T)
    d1 = (np.log(f / k) + 0.5 * s * s) / s
    d2 = d1 - s
    if K >= F:   # call
        price = f * norm.cdf(d1) - k * norm.cdf(d2)
    else:        # put
        price = k * norm.cdf(-d2) - f * norm.cdf(-d1)
    return float(price * 100.0)


def bachelier_price(F: float, K: float, T: float, sigma_n_bp: float) -> float:
    """Undiscounted out-of-the-money Bachelier price, in percent. σ_N in bp/yr."""
    s = sigma_n_bp / 100.0 * np.sqrt(T)            # in percent
    d = (F - K) / s
    if K >= F:   # call
        price = (F - K) * norm.cdf(d) + s * norm.pdf(d)
    else:        # put
        price = (K - F) * norm.cdf(-d) + s * norm.pdf(d)
    return float(price)


def normal_from_lognormal(F: float, K: float, T: float, sigma_ln: float,
                          shift: float = 0.0) -> float:
    """Exact conversion: price with (shifted) Black, invert Bachelier. Returns bp/yr."""
    target = black_price(F, K, T, sigma_ln, shift)
    return brentq(lambda s: bachelier_price(F, K, T, s) - target, 1e-6, 1e5, xtol=1e-10)


def lognormal_from_normal(F: float, K: float, T: float, sigma_n_bp: float,
                          shift: float = 0.0) -> float:
    """Exact conversion: price with Bachelier, invert (shifted) Black. Returns decimal vol."""
    target = bachelier_price(F, K, T, sigma_n_bp)
    return brentq(lambda s: black_price(F, K, T, s, shift) - target, 1e-6, 20.0, xtol=1e-12)


def normal_from_lognormal_approx(F: float, sigma_ln: float, shift: float = 0.0) -> float:
    """H&S quick rule for ATM options: σ_N ≈ σ_LN · F. F in %, returns bp/yr."""
    return sigma_ln * (F + shift) * 100.0


# ── Realised normal vol ────────────────────────────────────────────────────────

def ewma_normal_vol(levels: pd.Series, halflife: float = 21.0, scale: float = 100.0,
                    periods_per_year: int = 252, min_periods: int | None = None) -> pd.Series:
    """
    Annualised realised normal vol (bp/yr) from a level series, EWMA-weighted:
    σ²_t ∝ Σ_j w_j · Δx²_{t−j} with weights halving every `halflife` observations.
    Changes are taken around a zero mean (standard for daily rate changes).
    `scale` converts level units to bp (100 for yields in %, 1 for spreads in bp).
    """
    dx = levels.astype(float).diff().dropna() * scale
    mp = int(round(halflife)) if min_periods is None else min_periods
    var = (dx * dx).ewm(halflife=halflife, adjust=True, min_periods=mp).mean()
    return np.sqrt(var * periods_per_year)


def rolling_normal_vol(levels: pd.Series, window: int = 63, scale: float = 100.0,
                       periods_per_year: int = 252) -> pd.Series:
    """Equal-weight rolling realised normal vol (bp/yr), for comparison with the EWMA."""
    dx = levels.astype(float).diff().dropna() * scale
    var = (dx * dx).rolling(window).mean()
    return np.sqrt(var * periods_per_year)
