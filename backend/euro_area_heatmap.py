"""
Euro Area macro heatmap — two-block model.

Architecture
------------
Block 1 — Macro DFM (macro data only, no yields):
  Monthly macro indicators → Kalman smoother → daily factor estimates.
  Factors: Growth, Inflation, Employment, Wages (K=4).

Block 2 — Yield curve (daily, separate pipeline):
  Daily Bund yields → PCA → daily PC scores.
  PC1/PC2 regressed on Block 1 daily factors (no intercept).
  10y Bund fair value reconstructed via PCA inversion.

No yields enter Block 1. This eliminates the circularity of using yields
to identify factors and then using those factors to predict yields.

Simulated data
--------------
All series are synthetic until the Haver/Bloomberg pipeline is wired up.
Replace `_simulate_*` functions with live data pulls.
"""

from __future__ import annotations

import os
import warnings
import numpy as np
import pandas as pd
from dataclasses import dataclass
from scipy.optimize import linear_sum_assignment

from dfm import (
    kalman_filter,
    kalman_smoother,
    estimate_ar1_daily,
    estimate_loadings_ols,
)
from macro_data_loader import load_macro_data, MacroData
from data_fetcher import get_fetcher

# ---------------------------------------------------------------------------
# Date grid
# ---------------------------------------------------------------------------

DAILY_DATES: pd.DatetimeIndex = pd.bdate_range("2023-06-01", "2025-06-30")
T_DAILY = len(DAILY_DATES)

# Last business day of each month
MONTHLY_DATES: pd.DatetimeIndex = (
    pd.Series(DAILY_DATES).groupby(DAILY_DATES.to_period("M")).last().values
)
MONTHLY_DATES = pd.DatetimeIndex(MONTHLY_DATES)
T_MONTHLY = len(MONTHLY_DATES)

# Index into DAILY_DATES for each month-end day
MONTH_END_IDX: np.ndarray = np.array(
    [np.searchsorted(DAILY_DATES, d) for d in MONTHLY_DATES]
)

YIELD_TENORS = ["2y", "3y", "5y", "7y", "10y", "15y", "20y", "30y"]
FACTOR_NAMES = ["Growth", "Inflation", "Employment", "Wages"]
K = len(FACTOR_NAMES)
N_TENORS = len(YIELD_TENORS)
BUND_10Y_IDX = YIELD_TENORS.index("10y")

# Primary series for each factor (col_index from macro_series.csv).
# Used to sign-normalise PCA factors so each factor is interpretable:
#   Growth ↑ = higher PMI,  Inflation ↑ = higher HICP,
#   Employment ↑ = lower unemployment (sign=-1),  Wages ↑ = higher neg. wages
_FACTOR_PRIMARY_COL  = [0, 1, 2, 3]   # PMI=0, HICP=1, Unemployment=2, Neg.wages=3
_FACTOR_PRIMARY_SIGN = [1, 1, -1, 1]  # -1: higher unemployment = weaker employment

# Series catalogue IDs for the 8 DFM inputs — must match macro_series.csv col_index order.
_MACRO_SERIES_IDS = [
    "ea_composite_pmi",            # col 0
    "ea_core_hicp_yoy",            # col 1
    "ea_unemployment_rate",        # col 2
    "ea_negotiated_wages_yoy",     # col 3
    "ea_industrial_production_yoy",# col 4
    "ea_services_pmi",             # col 5
    "ea_ces_inflation_exp_1y",     # col 6
    "ea_job_vacancy_rate",         # col 7
]

# ---------------------------------------------------------------------------
# Block 1 — Macro DFM
# ---------------------------------------------------------------------------

MACRO_INDICATOR_NAMES = [
    "EA Composite PMI",
    "EA Core HICP (y/y)",
    "EA Unemployment Rate",
    "EA Negotiated Wages (y/y)",
    "EA Industrial Production (y/y)",
    "EA Services PMI",
    "EA CES 1y Inflation Expectations",
    "EA Job Vacancy Rate",
]
M_MACRO = len(MACRO_INDICATOR_NAMES)


def _simulate_macro_block(rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray]:
    """
    Simulate K daily latent factors and M monthly macro observations.

    Returns
    -------
    true_factors   : [T_DAILY, K]   ground-truth daily factors
    macro_monthly  : [T_MONTHLY, M] monthly macro observations (at month-end)
    """
    # AR(1) daily factors with mild cross-correlation
    ar = np.array([0.92, 0.88, 0.95, 0.90])
    innov_std = np.array([0.15, 0.12, 0.10, 0.12])

    # Slight cross-correlation in innovations (Growth <-> Employment)
    L_chol = np.eye(K)
    L_chol[2, 0] = 0.25  # Employment slightly correlated with Growth

    factors = np.zeros((T_DAILY, K))
    factors[0] = rng.standard_normal(K) * innov_std
    for t in range(1, T_DAILY):
        eta = L_chol @ (rng.standard_normal(K) * innov_std * np.sqrt(1 - ar**2))
        factors[t] = ar * factors[t - 1] + eta

    # Observation loadings: [M_MACRO, K]
    # Each indicator loads primarily on one factor
    Lambda_macro = np.array([
        [1.0,  0.2,  0.1,  0.0],   # Composite PMI   → Growth
        [0.1,  1.0,  0.0,  0.2],   # Core HICP        → Inflation
        [0.2,  0.1,  1.0,  0.3],   # Unemployment     → Employment
        [0.0,  0.3,  0.2,  1.0],   # Negotiated wages → Wages
        [0.8,  0.1,  0.1,  0.0],   # Industrial prod  → Growth
        [0.7,  0.2,  0.1,  0.0],   # Services PMI     → Growth
        [0.1,  0.8,  0.0,  0.1],   # Inflation expec  → Inflation
        [0.1,  0.0,  0.8,  0.1],   # Job vacancy rate → Employment
    ])

    noise_std = np.array([0.3, 0.2, 0.15, 0.2, 0.4, 0.3, 0.2, 0.2])

    # Observe at month-end only
    macro_monthly = (
        factors[MONTH_END_IDX] @ Lambda_macro.T
        + rng.standard_normal((T_MONTHLY, M_MACRO)) * noise_std
    )

    return factors, Lambda_macro, macro_monthly


def _build_macro_dfm(
    Lambda_macro: np.ndarray,   # [M_MACRO, K]
    macro_monthly: np.ndarray,  # [T_MONTHLY, M_MACRO]
    factors_monthly: np.ndarray, # [T_MONTHLY, K] ground truth at month ends
) -> tuple[np.ndarray, np.ndarray]:
    """
    Fit DFM parameters from monthly data, run Kalman smoother at daily frequency.

    In production: replace OLS parameter init with EM algorithm.

    Returns
    -------
    factors_smooth : [T_DAILY, K]   smoothed daily factor estimates
    factors_filt   : [T_DAILY, K]   filtered daily factor estimates
    """
    # ── Parameter estimation (simplified: OLS loadings, AR(1) transition) ──
    Lambda_est = estimate_loadings_ols(factors_monthly, macro_monthly)
    ar_est = estimate_ar1_daily(factors_monthly)
    A_est = np.diag(ar_est)

    # State noise (daily): Q = diag(σ²(1-ρ²))
    innov_var = np.var(factors_monthly[1:] - (factors_monthly[:-1] * ar_est[None, :]), axis=0)
    Q_est = np.diag(np.maximum(innov_var, 1e-6))

    # Observation noise: residual variance from OLS fit
    resid = macro_monthly - factors_monthly @ Lambda_est.T
    R_est = np.diag(np.maximum(np.var(resid, axis=0), 1e-6))

    # ── Build daily observation matrix: NaN everywhere except month-end ──
    Y_daily = np.full((T_DAILY, M_MACRO), np.nan)
    Y_daily[MONTH_END_IDX] = macro_monthly

    # ── Kalman filter + RTS smoother ──
    f_filt, P_filt, f_pred, P_pred, _ = kalman_filter(
        Y=Y_daily,
        Lambda=Lambda_est,
        A=A_est,
        Q=Q_est,
        R=R_est,
    )
    f_smooth, _ = kalman_smoother(f_filt, P_filt, f_pred, P_pred, A_est)

    return f_smooth, f_filt


# ---------------------------------------------------------------------------
# Block 2 — Yield PCA
# ---------------------------------------------------------------------------

# Approximate Bund yield means over the sample (%)
BUND_YIELD_MEANS = np.array([2.45, 2.35, 2.28, 2.38, 2.44, 2.50, 2.56, 2.62])

# How each macro factor drives each tenor (level + slope structure)
# PC1 (level) is mainly Inflation-driven; PC2 (slope) mainly Growth-driven
_YIELD_FACTOR_LOADINGS = np.array([
    # Growth  Inflation  Employment  Wages
    [  0.15,    0.40,      0.05,     0.08],  # 2y  — front end, rate-sensitive
    [  0.15,    0.40,      0.05,     0.08],  # 3y
    [  0.15,    0.38,      0.06,     0.09],  # 5y
    [  0.16,    0.35,      0.06,     0.09],  # 7y
    [  0.18,    0.32,      0.07,     0.09],  # 10y
    [  0.20,    0.28,      0.07,     0.09],  # 15y — long end, term-premium driven
    [  0.22,    0.25,      0.07,     0.09],  # 20y
    [  0.24,    0.22,      0.08,     0.09],  # 30y
])


def _simulate_yield_block(
    true_factors: np.ndarray,  # [T_DAILY, K]
    rng: np.random.Generator,
) -> np.ndarray:
    """
    Simulate daily Bund yields from latent factors.
    Returns [T_DAILY, N_TENORS].
    """
    noise = rng.standard_normal((T_DAILY, N_TENORS)) * 0.025
    return BUND_YIELD_MEANS[None, :] + true_factors @ _YIELD_FACTOR_LOADINGS.T + noise


def _compute_pca(
    data: np.ndarray,  # [T, M]
    n_components: int = 3,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    PCA via eigendecomposition of the sample covariance matrix.

    Returns
    -------
    scores        : [T, n_components]
    loadings      : [n_components, M]   eigenvectors (rows)
    explained_var : [n_components]      fraction of variance
    means         : [M]                 column means
    """
    means = data.mean(axis=0)
    centered = data - means
    cov = centered.T @ centered / (len(data) - 1)
    eigenvalues, eigenvectors = np.linalg.eigh(cov)
    # Sort descending
    idx = np.argsort(eigenvalues)[::-1]
    eigenvalues = eigenvalues[idx]
    eigenvectors = eigenvectors[:, idx]

    loadings = eigenvectors[:, :n_components].T   # [n_comp, M]

    # Sign conventions: PC1 → 10y positive; PC2 → 30y positive; PC3 → 7y positive
    for k, pivot_col in enumerate([BUND_10Y_IDX, N_TENORS - 1, 3]):
        if k < n_components and loadings[k, pivot_col] < 0:
            loadings[k] *= -1

    scores = centered @ loadings.T
    explained_var = eigenvalues[:n_components] / eigenvalues.sum()
    return scores, loadings, explained_var, means


# ---------------------------------------------------------------------------
# OLS (no intercept)
# ---------------------------------------------------------------------------

def _ols(y: np.ndarray, X: np.ndarray) -> dict:
    """OLS without intercept. y: [N], X: [N, K]."""
    N, K = X.shape
    XtX = X.T @ X
    beta = np.linalg.solve(XtX, X.T @ y)
    fitted = X @ beta
    resid = y - fitted
    sigma2 = (resid ** 2).sum() / (N - K)
    se = np.sqrt(sigma2 * np.diag(np.linalg.inv(XtX)))
    tstat = beta / se
    TSS = ((y - y.mean()) ** 2).sum()
    r2 = 1 - (resid ** 2).sum() / TSS
    adj_r2 = 1 - (1 - r2) * (N - 1) / (N - K)
    return dict(beta=beta, tstat=tstat, r2=r2, adj_r2=adj_r2, fitted=fitted, resid=resid)


# ---------------------------------------------------------------------------
# Block 1 (real data path) — PCA init → Kalman smoother
# ---------------------------------------------------------------------------

def _build_macro_dfm_from_data(
    Y_daily: np.ndarray,           # [T_DAILY, M_MACRO] — NaN except on release dates
    primary_cols: list[int],       # col_index of primary series per factor
    primary_signs: list[int],      # +1/-1 per factor
) -> tuple[np.ndarray, np.ndarray]:
    """
    Fit the DFM to real macro data without ground-truth factors.

    Pipeline
    --------
    1. Forward-fill Y_daily (LOCF) → complete matrix for PCA.
    2. Standardise columns using statistics from actual observations.
    3. PCA on forward-filled data → K=4 components.
    4. Assign PCA components to named factors via the Hungarian algorithm
       (maximise absolute loading on each factor's primary series).
    5. Sign-normalise factors (factor ↑ ↔ primary series ↑).
    6. Convert PCA loadings back to original units → Lambda_est [M, K].
    7. Estimate AR(1) transition and noise matrices from PCA scores.
    8. Run Kalman filter + RTS smoother on raw Y_daily (with NaNs).
    """
    T, M = Y_daily.shape

    # ── Step 1: forward-fill for PCA initialisation ───────────────────────────
    df = pd.DataFrame(Y_daily)
    Y_ffill = df.ffill().bfill().values   # [T, M], no NaNs

    # ── Step 2: standardise using statistics from actual observations ─────────
    col_means = np.nanmean(Y_daily, axis=0)                      # [M]
    col_stds  = np.nanstd(Y_daily, axis=0)                       # [M]
    col_stds  = np.where(col_stds < 1e-8, 1.0, col_stds)        # guard zero-std

    Y_std = (Y_ffill - col_means[None, :]) / col_stds[None, :]  # [T, M]

    # ── Step 3: PCA → K components ────────────────────────────────────────────
    cov = Y_std.T @ Y_std / (T - 1)                             # [M, M]
    eigenvalues, eigenvectors = np.linalg.eigh(cov)
    idx = np.argsort(eigenvalues)[::-1]
    eigenvectors = eigenvectors[:, idx[:K]]                      # [M, K]
    scores_pca   = Y_std @ eigenvectors                          # [T, K]
    loadings_pca = eigenvectors.T                                # [K, M]

    # ── Step 4: assign PCA components to named factors (Hungarian) ───────────
    # Maximise total absolute loading on each factor's primary series.
    abs_loading = np.abs(loadings_pca[:, primary_cols])          # [K, K]
    _, col_ind  = linear_sum_assignment(-abs_loading)            # col_ind[k] → factor k
    scores_assigned   = scores_pca[:, col_ind]                   # [T, K]
    loadings_assigned = loadings_pca[col_ind, :]                 # [K, M]

    # Fallback: if best-matched loading is too weak, keep PCA order
    for k in range(K):
        if abs_loading[col_ind[k], k] < 0.05:
            scores_assigned   = scores_pca                        # [T, K]
            loadings_assigned = loadings_pca                      # [K, M]
            break

    # ── Step 5: sign-normalise ────────────────────────────────────────────────
    for k in range(K):
        if loadings_assigned[k, primary_cols[k]] * primary_signs[k] < 0:
            loadings_assigned[k]   *= -1
            scores_assigned[:, k]  *= -1

    # ── Step 6: convert loadings to original units ────────────────────────────
    # Y_std = (Y - mean) / std ≈ scores @ loadings_assigned
    # Y     ≈ scores @ loadings_assigned * std + mean
    # ⟹ Lambda_est[m, k] = loadings_assigned[k, m] * col_stds[m]
    Lambda_est = (loadings_assigned * col_stds[None, :]).T       # [M, K]

    # ── Step 7: AR(1) transition + noise matrices ─────────────────────────────
    ar_est   = estimate_ar1_daily(scores_assigned)               # [K]
    A_est    = np.diag(ar_est)

    resid_ar = scores_assigned[1:] - scores_assigned[:-1] * ar_est[None, :]
    Q_est    = np.diag(np.maximum(np.var(resid_ar, axis=0), 1e-6))

    Y_fitted = scores_assigned @ Lambda_est.T + col_means[None, :]  # [T, M]
    resid_obs = Y_ffill - Y_fitted
    R_est = np.diag(np.maximum(np.var(resid_obs, axis=0), 1e-6))

    # ── Step 8: Kalman filter + RTS smoother on raw data ─────────────────────
    # Demean Y_daily (NaN propagates correctly through subtraction)
    Y_kalman = Y_daily - col_means[None, :]

    f_filt, P_filt, f_pred, P_pred, _ = kalman_filter(
        Y=Y_kalman,
        Lambda=Lambda_est,
        A=A_est,
        Q=Q_est,
        R=R_est,
        f0=scores_assigned[0],
        P0=np.eye(K),
    )
    f_smooth, _ = kalman_smoother(f_filt, P_filt, f_pred, P_pred, A_est)

    return f_smooth, f_filt


# ---------------------------------------------------------------------------
# Live data fetcher helper
# ---------------------------------------------------------------------------

def _fetch_macro_data(start: str, end: str) -> dict[str, pd.Series] | None:
    """
    Attempt to pull macro series from Bloomberg or Haver.

    Controlled by the ANALYTICS_DATA_SOURCE environment variable:
      "bloomberg"  — fetch via Bloomberg Desktop API (requires xbbg + Terminal)
      "haver"      — fetch via Haver DLX (requires Haver pkg + HAVER_PATH)
      "csv"        — skip fetcher; read from data/macro_releases.csv  (default)
      "simulation" — skip all data loading; use synthetic data

    Returns dict[series_id, pd.Series] on success, or None to trigger CSV fallback.
    """
    source = os.environ.get("ANALYTICS_DATA_SOURCE", "csv").lower()

    if source in ("csv", "simulation"):
        return None

    kwargs: dict = {}
    if source == "haver":
        haver_path = os.environ.get("HAVER_PATH")
        if haver_path:
            kwargs["path"] = haver_path

    try:
        fetcher = get_fetcher(source, **kwargs)   # type: ignore[arg-type]
        data = fetcher.fetch(_MACRO_SERIES_IDS, start=start, end=end)
        if not data:
            warnings.warn(
                "[euro_area_heatmap] Fetcher returned no data; falling back to CSV.",
                stacklevel=1,
            )
            return None
        return data
    except Exception as exc:
        warnings.warn(
            f"[euro_area_heatmap] Data fetcher failed ({exc}); falling back to CSV.",
            stacklevel=1,
        )
        return None


# ---------------------------------------------------------------------------
# Main computation — run once at import
# ---------------------------------------------------------------------------

_rng = np.random.default_rng(42)

# ── Block 1: try real data, fall back to simulation ───────────────────────────
# Fetch window: 2 years before the grid start → grid end, to capture quarterly lags.
_fetch_start = (DAILY_DATES[0] - pd.DateOffset(years=2)).strftime("%Y-%m-%d")
_fetch_end   = DAILY_DATES[-1].strftime("%Y-%m-%d")
_live_data   = _fetch_macro_data(_fetch_start, _fetch_end)

_macro_data: MacroData = load_macro_data(
    daily_dates=DAILY_DATES,
    m_macro=M_MACRO,
    data=_live_data,   # None → reads macro_releases.csv; if that's empty → simulation
)

for _w in _macro_data.warnings:
    warnings.warn(f"[euro_area_heatmap] {_w}", stacklevel=1)

_min_obs = 3  # minimum observations per series required to use real data
_sufficient = (
    os.environ.get("ANALYTICS_DATA_SOURCE", "csv").lower() != "simulation"
    and _macro_data.has_data
    and all(v >= _min_obs for v in _macro_data.n_obs_per_series.values())
)

if _sufficient:
    FACTORS_SMOOTH, FACTORS_FILT = _build_macro_dfm_from_data(
        _macro_data.Y_daily,
        primary_cols=_FACTOR_PRIMARY_COL,
        primary_signs=_FACTOR_PRIMARY_SIGN,
    )
    # Yield block still simulated from smoothed factors until live yield data wired up
    BUND_YIELDS = _simulate_yield_block(FACTORS_SMOOTH, _rng)
else:
    _true_factors, _Lambda_macro, _macro_monthly = _simulate_macro_block(_rng)
    FACTORS_SMOOTH, FACTORS_FILT = _build_macro_dfm(
        _Lambda_macro,
        _macro_monthly,
        _true_factors[MONTH_END_IDX],
    )
    BUND_YIELDS = _simulate_yield_block(_true_factors, _rng)
PC_SCORES, PC_LOADINGS, PC_EXPLAINED_VAR, YIELD_MEANS = _compute_pca(BUND_YIELDS)

# Regressions: PC1/PC2 ~ macro factors (no intercept)
PC1_REG = _ols(PC_SCORES[:, 0], FACTORS_SMOOTH)
PC2_REG = _ols(PC_SCORES[:, 1], FACTORS_SMOOTH)

# Fair value
BUND_PCA_FITTED = (
    YIELD_MEANS[BUND_10Y_IDX]
    + PC_SCORES[:, 0] * PC_LOADINGS[0, BUND_10Y_IDX]
    + PC_SCORES[:, 1] * PC_LOADINGS[1, BUND_10Y_IDX]
)
BUND_MACRO_FV = (
    YIELD_MEANS[BUND_10Y_IDX]
    + PC1_REG["fitted"] * PC_LOADINGS[0, BUND_10Y_IDX]
    + PC2_REG["fitted"] * PC_LOADINGS[1, BUND_10Y_IDX]
)
BUND_RICH_CHEAP_BPS = (BUND_YIELDS[:, BUND_10Y_IDX] - BUND_MACRO_FV) * 100


# ---------------------------------------------------------------------------
# API response builders
# ---------------------------------------------------------------------------

@dataclass
class DailyFactorsResponse:
    dates: list[str]
    factors: dict[str, list[float]]   # factor_name → daily series
    smoothed: bool = True


@dataclass
class FairValueResponse:
    dates: list[str]
    actual: list[float]
    pca_fitted: list[float]
    macro_fair_value: list[float]
    rich_cheap_bps: list[float]


@dataclass
class YieldPCAResponse:
    dates: list[str]
    pc_scores: dict[str, list[float]]        # "PC1"/"PC2"/"PC3" → series
    loadings: dict[str, list[float]]         # "PC1"/"PC2"/"PC3" → per-tenor loadings
    explained_var: dict[str, float]
    tenor_names: list[str]


@dataclass
class PCRegressionResponse:
    factor_names: list[str]
    pc1: dict                                # beta, tstat, r2, adj_r2
    pc2: dict


def get_daily_factors() -> DailyFactorsResponse:
    dates = [d.strftime("%Y-%m-%d") for d in DAILY_DATES]
    factors = {
        name: FACTORS_SMOOTH[:, k].round(4).tolist()
        for k, name in enumerate(FACTOR_NAMES)
    }
    return DailyFactorsResponse(dates=dates, factors=factors)


def get_fair_value() -> FairValueResponse:
    dates = [d.strftime("%Y-%m-%d") for d in DAILY_DATES]
    return FairValueResponse(
        dates=dates,
        actual=BUND_YIELDS[:, BUND_10Y_IDX].round(4).tolist(),
        pca_fitted=BUND_PCA_FITTED.round(4).tolist(),
        macro_fair_value=BUND_MACRO_FV.round(4).tolist(),
        rich_cheap_bps=BUND_RICH_CHEAP_BPS.round(2).tolist(),
    )


def get_yield_pca() -> YieldPCAResponse:
    dates = [d.strftime("%Y-%m-%d") for d in DAILY_DATES]
    pc_labels = ["PC1", "PC2", "PC3"]
    return YieldPCAResponse(
        dates=dates,
        pc_scores={
            label: PC_SCORES[:, k].round(4).tolist()
            for k, label in enumerate(pc_labels)
        },
        loadings={
            label: PC_LOADINGS[k].round(4).tolist()
            for k, label in enumerate(pc_labels)
        },
        explained_var={
            label: round(float(PC_EXPLAINED_VAR[k]), 4)
            for k, label in enumerate(pc_labels)
        },
        tenor_names=YIELD_TENORS,
    )


def get_pc_regressions() -> PCRegressionResponse:
    def _fmt(reg: dict) -> dict:
        return dict(
            beta=reg["beta"].round(4).tolist(),
            tstat=reg["tstat"].round(3).tolist(),
            r2=round(float(reg["r2"]), 4),
            adj_r2=round(float(reg["adj_r2"]), 4),
        )
    return PCRegressionResponse(
        factor_names=FACTOR_NAMES,
        pc1=_fmt(PC1_REG),
        pc2=_fmt(PC2_REG),
    )
