"""
PCA Analysis — Yield-Curve Factor Decomposition and OU Mean-Reversion Model.

Based on Huggins & Schaller, Fixed Income Relative Value Analysis (2024),
Chapter 3, Box 3.1: "PCA of the Yield Curve".

Framework overview
------------------
The yield curve at time t is represented as a vector y(t) = [y_1(t), ..., y_N(t)]
of N par yields (or generic yields) at fixed tenors. PCA decomposes the covariance
matrix of yield LEVELS (not changes — the book is explicit) into orthogonal
eigenvectors that explain the dominant modes of curve variation:

  Factor 1 — Level:      all loadings same sign, ~parallel shift
  Factor 2 — Slope:      one sign change from short to long end, twist
  Factor 3 — Curvature:  belly opposes wings (two sign changes), butterfly

Each factor score f_k(t) = e_k' * y(t) behaves as a mean-reverting
Ornstein-Uhlenbeck process:

  df_k = theta_k * (mu_k - f_k) dt + sigma_k dW_k

Estimated via discrete AR(1) OLS on weekly observations (dt = 1 week):

  f_k(t) = a + b * f_k(t-1) + eps,  theta = -log(b),  mu = a/(1-b)

The k-factor residual for tenor i is:

  r_i(t) = y_i(t) - sum_{k=1}^{K} f_k(t) * e_{ki}

A large residual in tenor i with z-score > 2 indicates the bond is cheap/rich
relative to the factor model — a potential relative-value trade signal.

Trade builder context
---------------------
default_bpvs gives approximate BPV per 100mn notional for each tenor.
A PCA-neutral butterfly (wing1, belly, wing2) has weights (wL, -1, wR)
chosen so that wL * e1[wing1] - e1[belly] + wR * e1[wing2] = 0  (level neutral)
and the same for e2 (slope neutral). The residual measures the curvature
richness/cheapness of the belly relative to the wings.
"""
from __future__ import annotations

import json
import math
import os
import warnings
from datetime import date, timedelta
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd


# ─── Catalogue ────────────────────────────────────────────────────────────────

_CATALOGUE_PATH = Path(__file__).parent / "data" / "series_catalogue_pca_analysis.json"

_CATALOGUE: dict | None = None


def _load_catalogue() -> dict:
    global _CATALOGUE
    if _CATALOGUE is None:
        with open(_CATALOGUE_PATH, "r") as fh:
            _CATALOGUE = json.load(fh)
    return _CATALOGUE


def _get_curve_config(curve_id: str) -> dict:
    cat = _load_catalogue()
    for curve in cat["curves"]:
        if curve["curve_id"] == curve_id:
            return curve
    valid = [c["curve_id"] for c in cat["curves"]]
    raise ValueError(f"Unknown curve_id {curve_id!r}. Valid ids: {valid}")


def _get_default_bpvs() -> dict[str, float]:
    cat = _load_catalogue()
    return {str(k): float(v) for k, v in cat["default_bpvs"]["values"].items()}


# ─── External variable defaults ───────────────────────────────────────────────

_EXTERNAL_VARS_META = [
    {"ticker": "SPX Index",     "label": "S&P 500"},
    {"ticker": "VIX Index",     "label": "VIX"},
    {"ticker": "EURUSD Curncy", "label": "EUR/USD"},
    {"ticker": "CO1 Comdty",    "label": "Oil (Brent)"},
    {"ticker": "XAU Curncy",    "label": "Gold"},
    {"ticker": "DXY Curncy",    "label": "USD Index"},
]

# ─── Bloomberg data fetch ──────────────────────────────────────────────────────


def _bloomberg_yields(
    tickers: list[str],
    start: str,
    end: str,
) -> Optional[pd.DataFrame]:
    """
    Fetch weekly generic government yields via Bloomberg bdh.

    Parameters
    ----------
    tickers : list of Bloomberg Index tickers, e.g. ["GDBR2 Index", "GDBR10 Index"]
    start   : ISO date string "YYYY-MM-DD"
    end     : ISO date string "YYYY-MM-DD"

    Returns
    -------
    pd.DataFrame with DatetimeIndex (weekly Fridays) and one column per ticker,
    or None if Bloomberg is unavailable or the request fails.
    """
    try:
        from bbg import blp  # type: ignore
    except ImportError:
        return None

    try:
        df = blp.bdh(
            tickers,
            "PX_LAST",
            start,
            end,
            Per="W",       # weekly periodicity
        )
        if df is None or df.empty:
            return None

        # Flatten MultiIndex columns if present
        if isinstance(df.columns, pd.MultiIndex):
            df = df.xs("PX_LAST", axis=1, level=1)

        # Ensure all requested tickers are present
        missing = [t for t in tickers if t not in df.columns]
        if missing:
            warnings.warn(
                f"[pca_analysis] Bloomberg missing tickers: {missing}", stacklevel=2
            )
            return None

        df = df[tickers].ffill().bfill().dropna()
        if len(df) < 20:
            return None
        return df

    except Exception as exc:
        warnings.warn(f"[pca_analysis] Bloomberg bdh failed: {exc}", stacklevel=2)
        return None


# ─── Simulation ───────────────────────────────────────────────────────────────

# Nelson-Siegel-inspired loading seeds (per-factor scalar amplitudes per tenor)
# These are intentional starting shapes; orthonormalization in _simulate_yields
# ensures the final loadings are orthonormal.

def _ns_raw_loadings(tenors: list[int]) -> np.ndarray:
    """
    Return raw (pre-orthonormalization) loading matrix [n_tenors × 3].

    Factor shapes (Nelson-Siegel inspired):
      e1 (level):      all positive, peaks at medium tenor
      e2 (slope):      negative short, positive long (sign change in middle)
      e3 (curvature):  belly negative, wings positive (two sign changes)
    """
    n = len(tenors)
    t_arr = np.array(tenors, dtype=float)
    t_max = float(max(tenors))

    # Level: positive hump peaking around 7-10y
    lam = 0.4
    e1 = 1.0 - np.exp(-lam * t_arr)  # monotone increasing, always positive

    # Slope: monotone from negative (short) to positive (long)
    e2 = -1.0 + 2.0 * (t_arr / t_max)

    # Curvature: middle negative, wings positive → cos shape
    e3 = np.cos(np.pi * t_arr / t_max)  # +1 at 0, -1 at t_max/2, +1 at t_max

    raw = np.column_stack([e1, e2, e3])  # [n × 3]
    return raw


def _gram_schmidt(raw: np.ndarray) -> np.ndarray:
    """
    Orthonormalize columns of raw [n × 3] via Gram-Schmidt.
    Returns orthonormal matrix [n × 3].
    """
    n, k = raw.shape
    Q = np.zeros((n, k))
    for j in range(k):
        v = raw[:, j].copy()
        for i in range(j):
            v -= np.dot(Q[:, i], raw[:, j]) * Q[:, i]
        norm = np.linalg.norm(v)
        if norm < 1e-12:
            # degenerate column — use a unit vector
            v = np.zeros(n)
            v[j % n] = 1.0
            norm = 1.0
        Q[:, j] = v / norm
    return Q


def _simulate_yields(
    tenors: list[int],
    n_weeks: int,
    curve_id: str,
    seed: int = 42,
) -> pd.DataFrame:
    """
    Generate realistic synthetic yield curves via 3-factor OU process.

    The three factors correspond to Level, Slope, and Curvature.
    Factor loadings are Nelson-Siegel-inspired and orthonormalized.
    Each factor follows an independent Ornstein-Uhlenbeck process
    calibrated so that:
      - Factor 1 (level) is slow/persistent (half-life ~35 weeks)
      - Factor 2 (slope) is medium speed (half-life ~6 weeks)
      - Factor 3 (curvature) is fast mean-reverting (half-life ~1.7 weeks)

    Returns
    -------
    pd.DataFrame with columns = [str(t) for t in tenors],
    index = weekly dates (Fridays) ending today, length = n_weeks.
    """
    rng = np.random.default_rng(seed + hash(curve_id) % (2**31))

    # ── OU parameters per factor (dt = 1 week) ───────────────────────────────
    # F1: level — slow, trend-like
    # F2: slope — medium speed
    # F3: curvature — fast mean-reverting
    ou_params = [
        {"mu": 2.0,  "theta": 0.02, "sigma": 0.18, "x0": 1.8},   # F1 level
        {"mu": 0.0,  "theta": 0.12, "sigma": 0.09, "x0": -0.25},  # F2 slope
        {"mu": 0.0,  "theta": 0.40, "sigma": 0.04, "x0": 0.08},   # F3 curvature
    ]
    n_factors = len(ou_params)

    # Simulate factor paths
    factors = np.zeros((n_weeks, n_factors))
    for k, p in enumerate(ou_params):
        x = p["x0"]
        dt = 1.0
        for t in range(n_weeks):
            dW = rng.standard_normal()
            x = x + p["theta"] * (p["mu"] - x) * dt + p["sigma"] * math.sqrt(dt) * dW
            factors[t, k] = x

    # Compute orthonormal loadings [n_tenors × 3]
    raw = _ns_raw_loadings(tenors)
    loadings = _gram_schmidt(raw)  # [n_tenors × 3]

    # Base yield levels (upward-sloping curve, country-specific shift)
    _base_shifts = {
        "bund": 0.0, "oat": 0.60, "btp": 1.60, "bonos": 1.10,
        "ust": 0.30, "gilt": 0.50,
    }
    base_shift = _base_shifts.get(curve_id, 0.0)
    t_arr = np.array(tenors, dtype=float)
    base_curve = 1.5 + base_shift + 0.06 * t_arr  # upward sloping in %

    # Scale loadings by factor amplitudes to give reasonable BPS contributions
    # F1 (level) dominates: amplitude ~1.0 → contributes ~100bp shift across curve
    # F2 (slope): amplitude ~0.5 → ±50bp slope change
    # F3 (curvature): amplitude ~0.1 → ±10bp curvature
    amplitudes = np.array([1.0, 0.5, 0.1])

    # Yield matrix: y(t,i) = base_i + sum_k factor_k(t) * loading_ki * amplitude_k
    # loadings.T is [3 × n_tenors]; factors is [n_weeks × 3]
    # yields = base + factors @ diag(amplitudes) @ loadings.T
    scaled_load = loadings * amplitudes[np.newaxis, :]  # [n_tenors × 3]
    yields = base_curve[np.newaxis, :] + factors @ scaled_load.T  # [n_weeks × n_tenors]

    # Add small idiosyncratic noise
    noise = rng.standard_normal((n_weeks, len(tenors))) * 0.01
    yields += noise

    # Weekly dates ending today
    today = pd.Timestamp.today().normalize()
    # Last Friday on or before today
    offset = (today.weekday() - 4) % 7
    last_friday = today - pd.Timedelta(days=int(offset))
    dates = pd.date_range(end=last_friday, periods=n_weeks, freq="W-FRI")

    col_names = [str(t) for t in tenors]
    return pd.DataFrame(yields, index=dates, columns=col_names)


def _simulate_yields_daily(
    tenors: list[int],
    n_bdays: int,
    curve_id: str,
    seed: int = 42,
) -> pd.DataFrame:
    """
    Generate daily (business day) synthetic yields via the same 3-factor OU
    process as _simulate_yields, but at dt = 1/5 week (one business day).

    Used exclusively for the Hedge Ratios trade-history chart so that P&L is
    displayed at business-day granularity.
    """
    rng = np.random.default_rng(seed + hash(curve_id) % (2**31))
    dt = 1.0 / 5.0  # one business day in weekly units

    ou_params_list = [
        {"mu": 2.0,  "theta": 0.02, "sigma": 0.18, "x0": 1.8},
        {"mu": 0.0,  "theta": 0.12, "sigma": 0.09, "x0": -0.25},
        {"mu": 0.0,  "theta": 0.40, "sigma": 0.04, "x0": 0.08},
    ]

    factors = np.zeros((n_bdays, 3))
    for k, p in enumerate(ou_params_list):
        x = float(p["x0"])
        for t in range(n_bdays):
            dW = rng.standard_normal()
            x = x + p["theta"] * (p["mu"] - x) * dt + p["sigma"] * math.sqrt(dt) * dW
            factors[t, k] = x

    raw = _ns_raw_loadings(tenors)
    loadings = _gram_schmidt(raw)

    _base_shifts = {
        "bund": 0.0, "oat": 0.60, "btp": 1.60, "bonos": 1.10,
        "ust": 0.30, "gilt": 0.50,
    }
    base_shift = _base_shifts.get(curve_id, 0.0)
    base_curve = 1.5 + base_shift + 0.06 * np.array(tenors, dtype=float)

    amplitudes = np.array([1.0, 0.5, 0.1])
    scaled_load = loadings * amplitudes[np.newaxis, :]
    yields = base_curve[np.newaxis, :] + factors @ scaled_load.T
    yields += rng.standard_normal((n_bdays, len(tenors))) * 0.005  # smaller daily noise

    today = pd.Timestamp.today().normalize()
    dates = pd.bdate_range(end=today, periods=n_bdays)

    return pd.DataFrame(yields, index=dates, columns=[str(t) for t in tenors])


def _bloomberg_yields_daily(
    tickers: list[str],
    start: str,
    end: str,
) -> Optional[pd.DataFrame]:
    """Fetch daily government yields via Bloomberg bdh (Per='D')."""
    try:
        from bbg import blp  # type: ignore
    except ImportError:
        return None

    try:
        df = blp.bdh(tickers, "PX_LAST", start, end, Per="D")
        if df is None or df.empty:
            return None
        if isinstance(df.columns, pd.MultiIndex):
            df = df.xs("PX_LAST", axis=1, level=1)
        missing = [t for t in tickers if t not in df.columns]
        if missing:
            return None
        df = df[tickers].ffill().bfill().dropna()
        # Keep business days only
        df = df[df.index.dayofweek < 5]
        return df if len(df) >= 20 else None
    except Exception as exc:
        warnings.warn(f"[pca_analysis] Bloomberg daily bdh failed: {exc}", stacklevel=2)
        return None


# ─── External variable simulation ─────────────────────────────────────────────


_SIM_PARAMS: dict[str, tuple[float, float]] = {
    "SPX Index":     (4500.0, 0.015),
    "VIX Index":     (18.0,   0.080),
    "EURUSD Curncy": (1.08,   0.004),
    "CO1 Comdty":    (80.0,   0.025),
    "XAU Curncy":    (1900.0, 0.010),
    "DXY Curncy":    (103.0,  0.006),
}


def _simulate_external_vars(
    dates: list[str],
    tickers_meta: list[dict],
    curve_id: str,
    seed: int = 99,
) -> list[dict]:
    """
    Generate synthetic weekly external variable series on the given date grid.

    Works for any set of tickers: known ones use calibrated params, unknown
    ones fall back to a generic geometric random walk around 100.
    """
    rng = np.random.default_rng(seed + hash(curve_id) % (2**31))
    n = len(dates)
    results = []
    for meta in tickers_meta:
        x0, sig = _SIM_PARAMS.get(meta["ticker"], (100.0, 0.015))
        x = x0 * (0.95 + 0.10 * rng.random())
        vals: list[float] = []
        for _ in range(n):
            x = max(x * (1.0 + rng.standard_normal() * sig), 1e-3)
            vals.append(round(float(x), 4))
        results.append({
            "ticker": meta["ticker"],
            "label":  meta["label"],
            "dates":  dates,
            "values": vals,
        })
    return results


# ─── PCA ──────────────────────────────────────────────────────────────────────


def _run_pca(yield_df: pd.DataFrame) -> dict:
    """
    Run PCA on yield LEVELS (not changes) per Huggins & Schaller Ch.3 Box 3.1.

    Uses np.linalg.eigh for symmetric decomposition (numerically stable).
    Sign convention: the largest-magnitude entry of each eigenvector is
    forced positive, ensuring consistent factor interpretation across runs.

    Parameters
    ----------
    yield_df : pd.DataFrame [T × N], columns are tenor labels

    Returns
    -------
    dict with keys:
      eigenvalues  : np.ndarray [N], sorted descending
      eigenvectors : np.ndarray [N × N], columns = eigenvectors, sorted descending
      factors      : np.ndarray [T × N], factor scores f_k(t) = e_k' * y(t)
    """
    Y = yield_df.values.astype(float)  # [T × N]
    # Covariance matrix of levels
    Y_dm = Y - Y.mean(axis=0)
    T = Y_dm.shape[0]
    C = Y_dm.T @ Y_dm / max(T - 1, 1)  # [N × N]

    eigenvalues, eigenvectors = np.linalg.eigh(C)  # ascending order

    # Sort descending
    order = np.argsort(eigenvalues)[::-1]
    eigenvalues = eigenvalues[order]
    eigenvectors = eigenvectors[:, order]  # [N × N]

    # Sign convention: force dominant entry positive
    for k in range(eigenvectors.shape[1]):
        v = eigenvectors[:, k]
        idx = np.argmax(np.abs(v))
        if v[idx] < 0:
            eigenvectors[:, k] = -v

    # Factor time series: f_k(t) = e_k' * y(t)  [T × N]
    factors = Y @ eigenvectors  # [T × N]

    return {
        "eigenvalues": eigenvalues,
        "eigenvectors": eigenvectors,
        "factors": factors,
    }


# ─── Ornstein-Uhlenbeck fitting and forecasting ───────────────────────────────


def _fit_ou(series: np.ndarray) -> dict:
    """
    Fit OU process to a 1D time series via discrete AR(1) OLS.

    Model: x(t) = a + b*x(t-1) + eps

    Identification:
        theta  = -log(b)            [per week, dt=1]
        mu     = a / (1 - b)
        sigma  = sigma_eps * sqrt(2*theta / (1 - exp(-2*theta)))
        half_life_weeks = log(2) / theta

    b is clamped to (1e-6, 1-1e-6) for numerical stability.

    Returns
    -------
    dict: {mu, theta, sigma, sigma_eps, half_life_weeks}
    """
    x = np.asarray(series, dtype=float)
    x_lag = x[:-1]
    x_cur = x[1:]

    # OLS: x_cur = a + b * x_lag
    X = np.column_stack([np.ones(len(x_lag)), x_lag])
    try:
        coeffs, residuals_ss, _, _ = np.linalg.lstsq(X, x_cur, rcond=None)
    except np.linalg.LinAlgError:
        return {"mu": float(x.mean()), "theta": 0.1, "sigma": float(x.std()),
                "sigma_eps": float(x.std()), "half_life_weeks": 6.93}

    a, b = float(coeffs[0]), float(coeffs[1])

    # Clamp b for stability
    b = max(1e-6, min(1.0 - 1e-6, b))

    resid = x_cur - (a + b * x_lag)
    sigma_eps = float(np.std(resid, ddof=1)) if len(resid) > 1 else 1e-4

    theta = -math.log(b)
    mu = a / (1.0 - b)

    # Recover diffusion coefficient from discrete sigma_eps
    denom = 1.0 - math.exp(-2.0 * theta)
    if denom < 1e-12:
        sigma = sigma_eps  # theta near zero — approximate
    else:
        sigma = sigma_eps * math.sqrt(2.0 * theta / denom)

    half_life = math.log(2.0) / theta if theta > 0 else 1e6

    return {
        "mu": round(mu, 6),
        "theta": round(theta, 6),
        "sigma": round(sigma, 6),
        "sigma_eps": round(sigma_eps, 6),
        "half_life_weeks": round(half_life, 3),
    }


def _ou_forecast(
    ou: dict,
    current_value: float,
    horizon_weeks: int = 52,
) -> list[dict]:
    """
    Analytical OU mean-reversion forecast.

    E[x(t+s)]   = mu + (current - mu) * exp(-theta * s)
    Var[x(t+s)] = sigma^2 / (2*theta) * (1 - exp(-2*theta*s))

    Returns list of dicts for s = 0 .. horizon_weeks:
        {week, mean, upper_1s, lower_1s, upper_2s, lower_2s}
    """
    mu = ou["mu"]
    theta = ou["theta"]
    sigma = ou["sigma"]

    result = []
    for s in range(horizon_weeks + 1):
        mean = mu + (current_value - mu) * math.exp(-theta * s)
        var_inf = (sigma ** 2) / max(2.0 * theta, 1e-12)
        variance = var_inf * (1.0 - math.exp(-2.0 * theta * s)) if s > 0 else 0.0
        std = math.sqrt(max(variance, 0.0))
        result.append({
            "week":      s,
            "mean":      round(mean, 5),
            "upper_1s":  round(mean + std, 5),
            "lower_1s":  round(mean - std, 5),
            "upper_2s":  round(mean + 2.0 * std, 5),
            "lower_2s":  round(mean - 2.0 * std, 5),
        })
    return result


# ─── Factor label detection ───────────────────────────────────────────────────

_FACTOR_NAMES = ["Level", "Slope", "Curvature"]


def _label_factor(eigenvector: np.ndarray, factor_idx: int) -> str:
    """
    Auto-detect factor label from sign-change pattern of eigenvector entries.

    Rules (Huggins & Schaller interpretation):
      0 sign changes → "Level"   (parallel shift)
      1 sign change  → "Slope"   (curve twist)
      2 sign changes → "Curvature" (butterfly / belly vs wings)
      3+             → "F{n}"
    """
    v = np.asarray(eigenvector)
    # Count sign changes across consecutive entries
    signs = np.sign(v[v != 0.0])
    n_changes = int(np.sum(np.diff(signs) != 0))

    if n_changes == 0:
        return "Level"
    elif n_changes == 1:
        return "Slope"
    elif n_changes == 2:
        return "Curvature"
    else:
        return f"F{factor_idx + 1}"


# ─── Public entry point ───────────────────────────────────────────────────────


def get_pca_data(
    curve_id: str = "bund",
    tenors: Optional[list[int]] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    n_factors: int = 3,
    extra_tickers: Optional[list[dict]] = None,
    use_changes: bool = False,
    roll_window_weeks: Optional[int] = None,
    custom_tickers: Optional[list[dict]] = None,
) -> dict:
    """
    Compute PCA decomposition, OU factor models, and k-factor residuals.

    Supports two modes:
    - Preset curve mode (default): curve_id + tenors as before.
    - Custom tickers mode: custom_tickers=[{"ticker": "...", "label": "..."}, ...].
      In this mode curve_id/tenors are ignored; sequential indices [0..N-1] are
      used as tenor keys; ticker_labels maps each index to the user label.
    """
    ticker_labels: dict[str, str] = {}  # populated in custom mode

    if custom_tickers:
        # ── Custom tickers mode ───────────────────────────────────────────────
        n_vars = len(custom_tickers)
        if n_vars < 2:
            raise ValueError("custom_tickers must have at least 2 entries")
        tenors = list(range(n_vars))
        tickers_list = [ct["ticker"] for ct in custom_tickers]
        ticker_labels = {str(i): ct["label"] for i, ct in enumerate(custom_tickers)}
        ticker_map = {str(i): ct["ticker"] for i, ct in enumerate(custom_tickers)}
        bpvs_subset = {str(i): 0.0 for i in range(n_vars)}
        curve_id = "custom"
        cfg = {"label": "Custom", "curve_id": "custom"}
    else:
        # ── Preset curve mode ─────────────────────────────────────────────────
        cfg = _get_curve_config(curve_id)
        default_bpvs = _get_default_bpvs()

        if tenors is None or len(tenors) == 0:
            tenors = list(cfg["default_tenors"])
        tenors = sorted(set(int(t) for t in tenors))

        available = [int(t) for t in cfg["tickers"].keys()]
        invalid = [t for t in tenors if t not in available]
        if invalid:
            raise ValueError(
                f"Tenors {invalid} not available for {curve_id!r}. "
                f"Available: {sorted(available)}"
            )

        ticker_map = {str(t): cfg["tickers"][str(t)] for t in tenors}
        tickers_list = [ticker_map[str(t)] for t in tenors]
        bpvs_subset = {str(t): default_bpvs.get(str(t), 0.0) for t in tenors}

    # ── Resolve date range ────────────────────────────────────────────────────
    today = pd.Timestamp.today().normalize()
    # Snap end to last Friday on or before the requested date
    as_of = pd.Timestamp(end_date) if end_date else today
    end_friday_offset = (as_of.weekday() - 4) % 7
    end_ts = as_of - pd.Timedelta(days=int(end_friday_offset))

    # Snap start to the Friday on or after the requested date
    if start_date:
        start_ts = pd.Timestamp(start_date)
        start_friday_offset = (4 - start_ts.weekday()) % 7
        start_ts = start_ts + pd.Timedelta(days=int(start_friday_offset))
    else:
        start_ts = end_ts - pd.Timedelta(weeks=104)  # default: 2 years

    if start_ts >= end_ts:
        raise ValueError(
            f"start_date {start_ts.date()} must be before end_date {end_ts.date()}"
        )

    start_str = start_ts.strftime("%Y-%m-%d")
    end_str = end_ts.strftime("%Y-%m-%d")

    # Approximate number of weekly observations in window (for simulation)
    lookback_weeks = max(int((end_ts - start_ts).days / 7), 10)

    # ── Data: Bloomberg or simulation ────────────────────────────────────────
    data_source = "simulation"
    yield_df: pd.DataFrame | None = None

    source_env = os.environ.get("ANALYTICS_DATA_SOURCE", "csv").lower()
    if source_env == "bloomberg":
        bbg_df = _bloomberg_yields(tickers_list, start_str, end_str)
        if bbg_df is not None and len(bbg_df) >= 20:
            # Rename columns from tickers to tenor strings
            rename = {ticker_map[str(t)]: str(t) for t in tenors}
            bbg_df = bbg_df.rename(columns=rename)
            # Keep only the requested tenors in order
            bbg_df = bbg_df[[str(t) for t in tenors]]
            # Trim to window
            yield_df = bbg_df.loc[start_str:end_str].copy()
            data_source = "bloomberg"

    if yield_df is None:
        yield_df = _simulate_yields(tenors, lookback_weeks, curve_id)
        data_source = "simulation"

    # ── Levels vs changes ─────────────────────────────────────────────────────
    if use_changes:
        yield_df = yield_df.diff().dropna()
        data_source += " (changes)"

    n_obs = len(yield_df)
    n_tenors = len(tenors)
    n_factors = min(n_factors, n_tenors)  # cannot exceed number of tenors

    # ── PCA ───────────────────────────────────────────────────────────────────
    pca = _run_pca(yield_df)
    eigenvalues_raw = pca["eigenvalues"]   # [n_tenors], descending
    eigenvectors = pca["eigenvectors"]     # [n_tenors × n_tenors]
    factors_all = pca["factors"]           # [n_obs × n_tenors]

    total_var = max(float(np.maximum(eigenvalues_raw, 0.0).sum()), 1e-12)
    var_pct = (np.maximum(eigenvalues_raw, 0.0) / total_var * 100.0).tolist()
    var_cum = list(np.cumsum(var_pct))

    # ── Correlation matrix ────────────────────────────────────────────────────
    Y_dm = yield_df.values - yield_df.values.mean(axis=0)
    T_obs = Y_dm.shape[0]
    cov_mat = Y_dm.T @ Y_dm / max(T_obs - 1, 1)
    std_devs = np.sqrt(np.maximum(np.diag(cov_mat), 1e-12))
    corr_mat = cov_mat / np.outer(std_devs, std_devs)
    corr_mat = np.clip(corr_mat, -1.0, 1.0)
    correlation_matrix = {
        str(tenors[i]): {str(tenors[j]): round(float(corr_mat[i, j]), 4) for j in range(n_tenors)}
        for i in range(n_tenors)
    }

    # ── Eigenvector dicts (first n_factors) ───────────────────────────────────
    eigenvector_dicts = []
    for k in range(n_factors):
        v = eigenvectors[:, k]
        label = _label_factor(v, k)
        eigenvector_dicts.append({
            "factor":   k + 1,
            "label":    label,
            "loadings": {str(tenors[i]): round(float(v[i]), 6) for i in range(n_tenors)},
        })

    # ── Factor history (first n_factors columns) ──────────────────────────────
    factors_used = factors_all[:, :n_factors]   # [n_obs × n_factors]
    dates_list = [d.strftime("%Y-%m-%d") for d in yield_df.index]

    # Subsample to every 2nd week if > 100 obs (to reduce payload)
    if n_obs > 100:
        step = 2
        idx_sub = list(range(0, n_obs, step))
        dates_sub = [dates_list[i] for i in idx_sub]
        factors_sub = factors_used[idx_sub, :]
        yields_sub_idx = idx_sub
    else:
        dates_sub = dates_list
        factors_sub = factors_used
        yields_sub_idx = list(range(n_obs))

    factor_history = []
    fk_names = [f"f{k+1}" for k in range(n_factors)]
    for i, ds in enumerate(dates_sub):
        row: dict = {"date": ds}
        for k in range(n_factors):
            row[f"f{k+1}"] = round(float(factors_sub[i, k]), 5)
        factor_history.append(row)

    # ── OU fit per factor ─────────────────────────────────────────────────────
    ou_params_dict: dict[str, dict] = {}
    ou_forecasts_dict: dict[str, list[dict]] = {}

    for k in range(n_factors):
        fk = f"f{k+1}"
        series = factors_used[:, k]
        ou = _fit_ou(series)

        current_val = float(series[-1])
        # Z-score: (current - mu) / (sigma / sqrt(2*theta)) i.e. relative to stationary std
        stationary_std = ou["sigma"] / math.sqrt(max(2.0 * ou["theta"], 1e-12))
        zscore = (current_val - ou["mu"]) / max(stationary_std, 1e-12)

        ou_params_dict[fk] = {
            "mu":              ou["mu"],
            "theta":           ou["theta"],
            "sigma":           ou["sigma"],
            "half_life_weeks": ou["half_life_weeks"],
            "current":         round(current_val, 5),
            "zscore":          round(zscore, 3),
        }
        ou_forecasts_dict[fk] = _ou_forecast(ou, current_val, horizon_weeks=52)

    # ── k-factor residuals (use n_factors-1 = 2 factors, consistent with book) ─
    n_resid_factors = max(1, n_factors - 1)  # typically 2 for butterfly analysis
    Y_mat = yield_df.values  # [n_obs × n_tenors]
    evecs_k = eigenvectors[:, :n_resid_factors]    # [n_tenors × k]
    fk_scores = factors_all[:, :n_resid_factors]   # [n_obs × k]
    # Reconstruction from k factors: Y_hat = F_k @ E_k.T
    Y_hat = fk_scores @ evecs_k.T                  # [n_obs × n_tenors]
    resid_mat = (Y_mat - Y_hat) * 100.0            # in basis points

    # Current residuals
    current_resid_bp = {
        str(tenors[i]): round(float(resid_mat[-1, i]), 3)
        for i in range(n_tenors)
    }

    # Residual history (subsampled)
    resid_history = []
    for i, ds in enumerate(dates_sub):
        orig_i = yields_sub_idx[i]
        row_r: dict = {"date": ds, "residuals": {
            str(tenors[j]): round(float(resid_mat[orig_i, j]), 3)
            for j in range(n_tenors)
        }}
        resid_history.append(row_r)

    # ── Yield history (subsampled) ────────────────────────────────────────────
    yield_history = []
    for i, ds in enumerate(dates_sub):
        orig_i = yields_sub_idx[i]
        row_y: dict = {"date": ds, "yields": {
            str(tenors[j]): round(float(Y_mat[orig_i, j]), 5)
            for j in range(n_tenors)
        }}
        yield_history.append(row_y)

    # ── Daily yield history (for trade history chart at business-day granularity) ─
    daily_yield_history: list[dict] = []
    if source_env == "bloomberg":
        bbg_daily = _bloomberg_yields_daily(tickers_list, start_str, end_str)
        if bbg_daily is not None:
            rename = {ticker_map[str(t)]: str(t) for t in tenors}
            bbg_daily = bbg_daily.rename(columns=rename)
            bbg_daily = bbg_daily[[str(t) for t in tenors]]
            for d, row in bbg_daily.iterrows():
                daily_yield_history.append({
                    "date": d.strftime("%Y-%m-%d"),
                    "yields": {str(tenors[j]): round(float(row.iloc[j]), 5) for j in range(n_tenors)},
                })

    if not daily_yield_history:
        n_bdays = max(int(lookback_weeks * 5), 50)
        daily_df = _simulate_yields_daily(tenors, n_bdays, curve_id)
        daily_df = daily_df.loc[start_str:end_str]
        if use_changes:
            daily_df = daily_df.diff().dropna()
        for d, row in daily_df.iterrows():
            daily_yield_history.append({
                "date": d.strftime("%Y-%m-%d"),
                "yields": {str(tenors[j]): round(float(row.iloc[j]), 5) for j in range(n_tenors)},
            })

    # ── External variables ────────────────────────────────────────────────────
    # Merge defaults with any caller-supplied extra tickers (dedup by ticker)
    seen_tickers: set[str] = set()
    all_ext_meta: list[dict] = []
    for m in list(_EXTERNAL_VARS_META) + list(extra_tickers or []):
        if m["ticker"] not in seen_tickers:
            all_ext_meta.append(m)
            seen_tickers.add(m["ticker"])

    ext_vars: list[dict] = []
    if source_env == "bloomberg":
        ext_tickers_list = [v["ticker"] for v in all_ext_meta]
        ext_df = _bloomberg_yields(ext_tickers_list, start_str, end_str)
        if ext_df is not None:
            ext_label_map = {v["ticker"]: v["label"] for v in all_ext_meta}
            for ticker in ext_tickers_list:
                if ticker in ext_df.columns:
                    aligned_vals: list[float | None] = []
                    for ds in dates_sub:
                        try:
                            val: float | None = float(ext_df.loc[ds, ticker])
                        except (KeyError, TypeError):
                            val = None
                        aligned_vals.append(round(val, 4) if val is not None else None)
                    ext_vars.append({
                        "ticker": ticker,
                        "label":  ext_label_map[ticker],
                        "dates":  dates_sub,
                        "values": aligned_vals,
                    })

    if not ext_vars:
        ext_vars = _simulate_external_vars(dates_sub, all_ext_meta, curve_id)

    # ── Stability diagnostics ─────────────────────────────────────────────────
    # Condition number: ratio of largest to smallest eigenvalue of covariance matrix
    eigs_pos = np.maximum(eigenvalues_raw[:n_tenors], 1e-12)
    condition_number = float(eigs_pos[0] / eigs_pos[-1])

    # Rolling cosine similarity: for each rolling window, recompute PCA and measure
    # alignment of each eigenvector against the full-sample eigenvector.
    auto_window = min(52, max(n_obs // 3, 20))
    roll_window = int(roll_window_weeks) if roll_window_weeks and roll_window_weeks > 0 else auto_window
    roll_window = min(roll_window, n_obs - 1)  # cannot exceed available data
    stability_history: list[dict] = []
    Y_mat_full = yield_df.values.astype(float)
    for i in range(roll_window, n_obs):
        Y_roll = Y_mat_full[i - roll_window : i]
        Y_roll_dm = Y_roll - Y_roll.mean(axis=0)
        C_roll = Y_roll_dm.T @ Y_roll_dm / max(len(Y_roll) - 1, 1)
        _, evs_roll = np.linalg.eigh(C_roll)          # ascending order
        evs_roll = evs_roll[:, ::-1]                   # descending
        # Fix signs: align dominant entry with full-sample eigenvector sign
        for k in range(min(n_factors, evs_roll.shape[1])):
            if np.dot(evs_roll[:, k], eigenvectors[:, k]) < 0:
                evs_roll[:, k] = -evs_roll[:, k]
        row: dict = {"date": dates_list[i]}
        for k in range(n_factors):
            cos_sim = float(np.clip(abs(np.dot(evs_roll[:, k], eigenvectors[:, k])), 0.0, 1.0))
            row[f"pc{k + 1}"] = round(cos_sim, 4)
            # Per-tenor rolling eigenvector loadings
            for ti, tenor in enumerate(tenors):
                row[f"pc{k + 1}_t{tenor}"] = round(float(evs_roll[ti, k]), 5)
        stability_history.append(row)

    # ── Assemble response ─────────────────────────────────────────────────────
    return {
        "curve_id":     curve_id,
        "curve_label":  cfg["label"],
        "ticker_labels": ticker_labels,   # {} in preset mode; {"0": label, ...} in custom mode
        "input_mode":   "changes" if use_changes else "levels",
        "tenors":       tenors,
        "ticker_map":   ticker_map,
        "default_bpvs": bpvs_subset,
        "data_source":  data_source,
        "start_date":   start_ts.strftime("%Y-%m-%d"),
        "end_date":     end_ts.strftime("%Y-%m-%d"),
        "n_obs":        n_obs,

        # Yield history (biweekly, for PCA/residuals display)
        "yield_history": yield_history,

        # Daily yield history (business days, for Hedge Ratios trade history)
        "daily_yield_history": daily_yield_history,

        # Eigenvalues
        "eigenvalues": {
            "values":     [round(v, 4) for v in var_pct],
            "cumulative": [round(v, 4) for v in var_cum],
        },

        # Correlation matrix [n_tenors × n_tenors]
        "correlation_matrix": correlation_matrix,

        # Eigenvectors (first n_factors)
        "eigenvectors": eigenvector_dicts,

        # Factor time series
        "factor_history": factor_history,

        # OU parameters per factor
        "ou_params": ou_params_dict,

        # OU forecasts per factor
        "ou_forecasts": ou_forecasts_dict,

        # k-factor residuals
        "residuals": {
            "n_factors_used": n_resid_factors,
            "current_bp":     current_resid_bp,
            "history":        resid_history,
        },

        # External variables (for Factor Correlations tab)
        "external_vars": ext_vars,

        # Stability diagnostics
        "stability": {
            "condition_number":  round(condition_number, 2),
            "roll_window_weeks": roll_window,
            "history":           stability_history,   # [{date, pc1, pc2, pc3}]
        },
    }
