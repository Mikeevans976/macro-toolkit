"""
UK macro heatmap — two-block model.

Architecture
------------
Block 1 — Macro DFM (macro data only, no yields):
  Monthly macro indicators → Kalman smoother → daily factor estimates.
  Factors: Global Macro, Growth, Inflation, Employment, Wages (K=5).

Block 2 — Gilt curve (daily, separate pipeline):
  Daily Gilt yields → PCA → daily PC scores.
  PC1/PC2 regressed on Block 1 daily factors (no intercept).
  10y Gilt fair value reconstructed via PCA inversion.

No yields enter Block 1. This eliminates the circularity of using yields
to identify factors and then using those factors to predict yields.

Series metadata is read from data/series_catalogue_uk.json via
macro_data_loader._load_dfm_meta(m_macro=48, catalogue_path=...).

Simulated data
--------------
All series are synthetic until the Haver/Bloomberg pipeline is wired up.
When ANALYTICS_DATA_SOURCE is set to "bloomberg" or "haver" the module
will attempt a live data pull and fall back to simulation on failure.
"""

from __future__ import annotations

import os
import warnings
import numpy as np
import pandas as pd
from dataclasses import dataclass
from pathlib import Path
from dfm import (
    kalman_filter,
    kalman_smoother,
    estimate_ar1_daily,
    estimate_loadings_ols,
)
from macro_data_loader import load_macro_data, MacroData, _load_dfm_meta
from data_fetcher import get_fetcher

# ---------------------------------------------------------------------------
# UK catalogue path
# ---------------------------------------------------------------------------

_UK_CATALOGUE_PATH = Path(__file__).parent / "data" / "series_catalogue_uk.json"

# ---------------------------------------------------------------------------
# DFM series metadata — single source of truth: series_catalogue_uk.json
# ---------------------------------------------------------------------------

_dfm_meta = _load_dfm_meta(m_macro=48, catalogue_path=_UK_CATALOGUE_PATH)

_MACRO_SERIES_IDS     = [e["id"]   for e in _dfm_meta]
MACRO_INDICATOR_NAMES = [e["name"] for e in _dfm_meta]

# Primary series per named factor (from catalogue dfm_primary=True entries).
_primary_by_factor = {e["dfm_factor"]: e for e in _dfm_meta if e.get("dfm_primary")}

# ---------------------------------------------------------------------------
# Constants and model dimensions
# ---------------------------------------------------------------------------

# Five factors: four named group factors + one Global Macro that spans all series.
# Named factors are extracted via within-group PCA; Global Macro via full-panel PCA.
FACTOR_NAMES   = ["Global Macro", "Growth", "Inflation", "Employment", "Wages"]
_NAMED_FACTORS = FACTOR_NAMES[1:]   # the four group factors

K          = len(FACTOR_NAMES)       # 5
M_MACRO_UK = len(_MACRO_SERIES_IDS)  # 48

GILT_TENORS  = ["2y", "5y", "10y", "20y", "30y"]
N_TENORS     = len(GILT_TENORS)       # 5
UK_10Y_IDX   = GILT_TENORS.index("10y")  # 2

# Column indices in Y_daily for each named factor's group, sorted.
_GROUP_COLS: dict[str, list[int]] = {
    fname: sorted(e["dfm_col_index"] for e in _dfm_meta if e["dfm_factor"] == fname)
    for fname in _NAMED_FACTORS
}

# Primary series col and sign for each named factor (in _NAMED_FACTORS order).
_NAMED_PRIMARY_COL  = [_primary_by_factor[f]["dfm_col_index"] for f in _NAMED_FACTORS]
_NAMED_PRIMARY_SIGN = [int(_primary_by_factor[f]["dfm_sign"])  for f in _NAMED_FACTORS]

# Global Macro sign anchor: Composite PMI is a broad composite covering all sectors.
# Sign convention: Global Macro ↑ = better overall conditions → Composite PMI ↑.
_GM_PRIMARY_COL  = next(e["dfm_col_index"] for e in _dfm_meta if e["id"] == "uk_composite_pmi")
_GM_PRIMARY_SIGN = 1

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

# ---------------------------------------------------------------------------
# Block 2 yield parameters — Gilt curve
# ---------------------------------------------------------------------------

# Approximate Gilt yield means (%, approx Jun 2025)
GILT_YIELD_MEANS = np.array([4.20, 4.10, 4.50, 5.05, 5.20])

# How each macro factor drives each Gilt tenor (simulation only).
# Columns: GlobalMacro, Growth, Inflation, Employment, Wages
# Short end: inflation + employment driven; long end: growth / term premium.
_UK_YIELD_FACTOR_LOADINGS = np.array([
    # GlobalMacro  Growth  Inflation  Employment  Wages
    [   0.12,       0.15,    0.45,      0.06,     0.08],  # 2y  (inflation+employment driven)
    [   0.12,       0.14,    0.38,      0.05,     0.07],  # 5y
    [   0.13,       0.16,    0.30,      0.06,     0.08],  # 10y
    [   0.14,       0.20,    0.22,      0.05,     0.07],  # 20y
    [   0.15,       0.22,    0.18,      0.05,     0.06],  # 30y (growth/term premium)
])

# ---------------------------------------------------------------------------
# Block 1 — Macro DFM
# ---------------------------------------------------------------------------


def _simulate_macro_block(rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Simulate K=5 daily factors and M=48 UK macro observations (simulation fallback).

    Factor structure mirrors the real model:
      col 0  (Global Macro) : loads on all series
      col 1  (Growth)       : loads on Growth group (cols 0-14) + Housing (cols 40-47)
      col 2  (Inflation)    : loads on Inflation group (cols 15-24)
      col 3  (Employment)   : loads on Employment group (cols 25-32)
      col 4  (Wages)        : loads on Wages group (cols 33-39)

    Returns
    -------
    factors    : [T_DAILY, K]
    Lambda_sim : [M_MACRO_UK, K]
    Y_monthly  : [T_MONTHLY, M_MACRO_UK]  observations at month-end
    """
    ar        = np.array([0.95, 0.92, 0.90, 0.93, 0.88])
    innov_std = np.array([0.10, 0.15, 0.12, 0.10, 0.12])

    factors = np.zeros((T_DAILY, K))
    factors[0] = rng.standard_normal(K) * innov_std
    for t in range(1, T_DAILY):
        eta = rng.standard_normal(K) * innov_std * np.sqrt(1 - ar ** 2)
        factors[t] = ar * factors[t - 1] + eta

    # Block-structured loadings: each series loads on Global Macro + its group factor.
    Lambda_sim = np.zeros((M_MACRO_UK, K))
    group_factor_col = {"Growth": 1, "Inflation": 2, "Employment": 3, "Wages": 4}
    for entry in _dfm_meta:
        m   = entry["dfm_col_index"]
        gfc = group_factor_col[entry["dfm_factor"]]
        Lambda_sim[m, 0]   = 0.5                           # Global Macro loading
        Lambda_sim[m, gfc] = 1.0 * int(entry["dfm_sign"])  # Group factor loading

    noise_std = np.full(M_MACRO_UK, 0.3)
    Y_monthly = (
        factors[MONTH_END_IDX] @ Lambda_sim.T
        + rng.standard_normal((T_MONTHLY, M_MACRO_UK)) * noise_std
    )
    return factors, Lambda_sim, Y_monthly


def _build_macro_dfm_sim(
    Lambda_sim: np.ndarray,    # [M_MACRO_UK, K]
    Y_monthly:  np.ndarray,    # [T_MONTHLY, M_MACRO_UK]
    f_monthly:  np.ndarray,    # [T_MONTHLY, K]
) -> tuple[np.ndarray, np.ndarray]:
    """Simulation fallback: OLS init → Kalman smoother."""
    Lambda_est = estimate_loadings_ols(f_monthly, Y_monthly)
    ar_est     = estimate_ar1_daily(f_monthly)
    A_est      = np.diag(ar_est)

    innov_var = np.var(f_monthly[1:] - f_monthly[:-1] * ar_est[None, :], axis=0)
    Q_est     = np.diag(np.maximum(innov_var, 1e-6))

    resid = Y_monthly - f_monthly @ Lambda_est.T
    R_est = np.diag(np.maximum(np.var(resid, axis=0), 1e-6))

    Y_daily_sim = np.full((T_DAILY, M_MACRO_UK), np.nan)
    Y_daily_sim[MONTH_END_IDX] = Y_monthly

    f_filt, P_filt, f_pred, P_pred, _ = kalman_filter(
        Y=Y_daily_sim, Lambda=Lambda_est, A=A_est, Q=Q_est, R=R_est,
    )
    f_smooth, _ = kalman_smoother(f_filt, P_filt, f_pred, P_pred, A_est)
    return f_smooth, f_filt


# ---------------------------------------------------------------------------
# Block 2 — Gilt yield simulation
# ---------------------------------------------------------------------------


def _simulate_yield_block(
    true_factors: np.ndarray,  # [T_DAILY, K]
    rng: np.random.Generator,
) -> np.ndarray:
    """
    Simulate daily Gilt yields from latent factors.
    Returns [T_DAILY, N_TENORS].
    """
    noise = rng.standard_normal((T_DAILY, N_TENORS)) * 0.025
    return GILT_YIELD_MEANS[None, :] + true_factors @ _UK_YIELD_FACTOR_LOADINGS.T + noise


# ---------------------------------------------------------------------------
# PCA helper
# ---------------------------------------------------------------------------


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

    Sign conventions for Gilt PCA:
      PC1 (Level)     : anchor on 10y (index 2) positive
      PC2 (Slope)     : anchor on 30y (index 4) positive
      PC3 (Curvature) : anchor on 5y  (index 1) positive
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

    # Sign conventions: PC1 → 10y (idx 2) positive; PC2 → 30y (idx 4) positive;
    #                   PC3 → 5y (idx 1) positive
    for k, pivot_col in enumerate([UK_10Y_IDX, N_TENORS - 1, 1]):
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

def _block_pca_1(Y_std: np.ndarray, cols: list[int], primary_col: int, primary_sign: int) -> tuple[np.ndarray, np.ndarray]:
    """
    Extract the first principal component from a subset of standardised columns.

    Returns
    -------
    score    : [T]          factor score time series
    loadings : [M_MACRO_UK] sparse loading vector (zeros outside `cols`)
    """
    T, M = Y_std.shape
    block = Y_std[:, cols]                                       # [T, n_block]
    cov   = block.T @ block / (T - 1)                           # [n_block, n_block]
    _, evecs = np.linalg.eigh(cov)
    pc1 = evecs[:, -1]                                          # highest eigenvalue

    # Sign normalise against primary series
    block_pos = cols.index(primary_col)
    if pc1[block_pos] * primary_sign < 0:
        pc1 = -pc1

    score           = block @ pc1                               # [T]
    loading_full    = np.zeros(M)
    loading_full[cols] = pc1
    return score, loading_full


def _build_macro_dfm_from_data(
    Y_daily: np.ndarray,  # [T_DAILY, M_MACRO_UK] — NaN except on (estimated) release dates
) -> tuple[np.ndarray, np.ndarray]:
    """
    Block-PCA initialisation + Kalman smoother for the 5-factor UK model.

    Factor structure
    ----------------
    Factor 0 — Global Macro : first PC of ALL 48 series (sign: Composite PMI ↑)
    Factor 1 — Growth       : first PC of Growth group  (cols 0-14 + 40-47, sign: Composite PMI ↑)
    Factor 2 — Inflation    : first PC of Inflation group (cols 15-24, sign: Services CPI ↑)
    Factor 3 — Employment   : first PC of Employment group (cols 25-32, sign: Unemployment ↓)
    Factor 4 — Wages        : first PC of Wages group   (cols 33-39, sign: AWE Regular ↑)

    Loading matrix Λ [48, 5] is block-structured:
      - Each named factor (cols 1-4) has non-zero loadings only for its group.
      - Global Macro (col 0) has non-zero loadings for all 48 series.
    The zero restrictions are enforced by construction and held fixed throughout
    the Kalman pass (no EM update of Λ in this implementation).

    Pipeline
    --------
    1.  Forward-fill Y_daily (LOCF) → Y_ffill [T, 48], no NaNs.
    2.  Standardise each column using statistics from actual observations only.
    3.  Within-group PCA for each named factor → score [T] + sparse loading [48].
    4.  Full-panel PCA for Global Macro → score [T] + dense loading [48].
    5.  Assemble F_init [T, 5] and Λ_std [48, 5].
    6.  Un-standardise Λ to original units.
    7.  Estimate AR(1) coefficients and noise matrices from F_init scores.
    8.  Run Kalman filter + RTS smoother on raw Y_daily (with NaNs).
    """
    T, M = Y_daily.shape

    # ── 1. Forward-fill ───────────────────────────────────────────────────────
    Y_ffill = pd.DataFrame(Y_daily).ffill().bfill().values       # [T, M]

    # ── 2. Standardise (stats from actual observations only) ──────────────────
    col_means = np.nanmean(Y_daily, axis=0)                      # [M]
    col_stds  = np.nanstd(Y_daily,  axis=0)                      # [M]
    col_stds  = np.where(col_stds < 1e-8, 1.0, col_stds)

    Y_std = (Y_ffill - col_means[None, :]) / col_stds[None, :]   # [T, M]

    # ── 3. Within-group PCA for each named factor ─────────────────────────────
    F_init    = np.zeros((T, K))                                  # [T, 5]
    Lambda_std = np.zeros((M, K))                                 # [M, 5]

    for k, fname in enumerate(_NAMED_FACTORS):
        cols         = _GROUP_COLS[fname]
        primary_col  = _NAMED_PRIMARY_COL[k]
        primary_sign = _NAMED_PRIMARY_SIGN[k]
        score, loading = _block_pca_1(Y_std, cols, primary_col, primary_sign)
        F_init[:, k + 1]      = score      # factors 1-4 are named group factors
        Lambda_std[:, k + 1]  = loading

    # ── 4. Full-panel PCA for Global Macro ────────────────────────────────────
    all_cols = list(range(M))
    gm_score, gm_loading = _block_pca_1(Y_std, all_cols, _GM_PRIMARY_COL, _GM_PRIMARY_SIGN)
    F_init[:, 0]     = gm_score           # factor 0 = Global Macro
    Lambda_std[:, 0] = gm_loading

    # ── 5. Un-standardise loadings → original units ───────────────────────────
    # y = Λ f + ε  in original units  →  Λ[m,k] = λ_std[m,k] × std[m]
    Lambda_est = Lambda_std * col_stds[:, None]                   # [M, K]

    # ── 6. AR(1) transition + noise matrices ──────────────────────────────────
    ar_est   = estimate_ar1_daily(F_init)                         # [K]
    A_est    = np.diag(ar_est)

    resid_ar = F_init[1:] - F_init[:-1] * ar_est[None, :]
    Q_est    = np.diag(np.maximum(np.var(resid_ar, axis=0), 1e-6))

    Y_fitted  = F_init @ Lambda_est.T + col_means[None, :]
    resid_obs = Y_ffill - Y_fitted
    R_est     = np.diag(np.maximum(np.var(resid_obs, axis=0), 1e-6))

    # ── 7. Kalman filter + RTS smoother on raw Y_daily ────────────────────────
    Y_kalman = Y_daily - col_means[None, :]                       # NaN rows propagate

    f_filt, P_filt, f_pred, P_pred, _ = kalman_filter(
        Y=Y_kalman,
        Lambda=Lambda_est,
        A=A_est,
        Q=Q_est,
        R=R_est,
        f0=F_init[0],
        P0=np.eye(K),
    )
    f_smooth, _ = kalman_smoother(f_filt, P_filt, f_pred, P_pred, A_est)

    return f_smooth, f_filt


# ---------------------------------------------------------------------------
# Live data fetcher helper
# ---------------------------------------------------------------------------

def _fetch_macro_data_uk(start: str, end: str) -> dict[str, pd.Series] | None:
    """
    Attempt to pull UK macro series from Bloomberg or Haver.

    Controlled by the ANALYTICS_DATA_SOURCE environment variable:
      "bloomberg"  — fetch via Bloomberg Desktop API (requires blpapi + Terminal)
      "haver"      — fetch via Haver DLX (requires Haver pkg + HAVER_PATH)
      "csv"        — skip fetcher; read from data/macro_releases.csv  (default)
      "simulation" — skip all data loading; use synthetic data

    Returns dict[series_id, pd.Series] on success, or None to trigger simulation fallback.
    """
    source = os.environ.get("ANALYTICS_DATA_SOURCE", "csv").lower()

    if source in ("csv", "simulation"):
        return None

    kwargs: dict = {}
    if source == "haver":
        haver_path = os.environ.get("HAVER_PATH")
        if haver_path:
            kwargs["path"] = haver_path

    kwargs["catalogue_path"] = _UK_CATALOGUE_PATH

    try:
        fetcher = get_fetcher(source, **kwargs)   # type: ignore[arg-type]
        data = fetcher.fetch(_MACRO_SERIES_IDS, start=start, end=end)
        if not data:
            warnings.warn(
                "[uk_heatmap] Fetcher returned no data; falling back to simulation.",
                stacklevel=1,
            )
            return None
        return data
    except Exception as exc:
        warnings.warn(
            f"[uk_heatmap] Data fetcher failed ({exc}); falling back to simulation.",
            stacklevel=1,
        )
        return None


# Series IDs for Gilt yields (must match GILT_TENORS order)
_YIELD_SERIES_IDS = ["gilt_2y", "gilt_5y", "gilt_10y", "gilt_20y", "gilt_30y"]


def _fetch_yield_data_uk(start: str, end: str) -> "np.ndarray | None":
    """
    Fetch daily Gilt yields from Bloomberg or Haver.
    Returns [T_DAILY, N_TENORS] array aligned to DAILY_DATES, or None to simulate.
    """
    source = os.environ.get("ANALYTICS_DATA_SOURCE", "csv").lower()
    if source in ("csv", "simulation"):
        return None

    kwargs: dict = {"catalogue_path": _UK_CATALOGUE_PATH}
    if source == "haver":
        haver_path = os.environ.get("HAVER_PATH")
        if haver_path:
            kwargs["path"] = haver_path

    try:
        fetcher = get_fetcher(source, **kwargs)   # type: ignore[arg-type]
        data = fetcher.fetch(_YIELD_SERIES_IDS, start=start, end=end)
        if not data:
            warnings.warn("[uk_heatmap] No yield data from fetcher; simulating yields.", stacklevel=1)
            return None

        daily_arr = np.array(DAILY_DATES, dtype="datetime64[D]")
        yield_mat = np.full((T_DAILY, N_TENORS), np.nan)

        for k, sid in enumerate(_YIELD_SERIES_IDS):
            series = data.get(sid)
            if series is None or series.empty:
                continue
            for ts, val in series.items():
                if pd.isna(val):
                    continue
                d = np.datetime64(pd.Timestamp(ts).date(), "D")
                idx = int(np.searchsorted(daily_arr, d, side="left"))
                if 0 <= idx < T_DAILY:
                    yield_mat[idx, k] = val

        yield_mat = pd.DataFrame(yield_mat).ffill().bfill().values

        if np.isnan(yield_mat).any():
            warnings.warn("[uk_heatmap] Yield matrix still has NaNs after fill; simulating.", stacklevel=1)
            return None

        return yield_mat

    except Exception as exc:
        warnings.warn(f"[uk_heatmap] Yield fetch failed ({exc}); simulating yields.", stacklevel=1)
        return None


# ---------------------------------------------------------------------------
# Main computation — run once at import
# ---------------------------------------------------------------------------

_rng = np.random.default_rng(99)

_fetch_start = (DAILY_DATES[0] - pd.DateOffset(years=2)).strftime("%Y-%m-%d")
_fetch_end   = DAILY_DATES[-1].strftime("%Y-%m-%d")

# ── Block 1: macro DFM ────────────────────────────────────────────────────────
_live_data = _fetch_macro_data_uk(_fetch_start, _fetch_end)

_macro_data: MacroData = load_macro_data(
    daily_dates=DAILY_DATES,
    m_macro=M_MACRO_UK,
    data=_live_data,   # None → uses simulation
    catalogue_path=_UK_CATALOGUE_PATH,
)

for _w in _macro_data.warnings:
    warnings.warn(f"[uk_heatmap] {_w}", stacklevel=1)

_min_obs = 3  # minimum observations per series required to use real data
_sufficient = (
    os.environ.get("ANALYTICS_DATA_SOURCE", "csv").lower() != "simulation"
    and _macro_data.has_data
    and all(v >= _min_obs for v in _macro_data.n_obs_per_series.values())
)

if _sufficient:
    FACTORS_SMOOTH, FACTORS_FILT = _build_macro_dfm_from_data(_macro_data.Y_daily)
else:
    _true_factors, _Lambda_sim, _Y_monthly = _simulate_macro_block(_rng)
    FACTORS_SMOOTH, FACTORS_FILT = _build_macro_dfm_sim(
        _Lambda_sim, _Y_monthly, _true_factors[MONTH_END_IDX],
    )

# ── Block 2: yield PCA ────────────────────────────────────────────────────────
_live_yields = _fetch_yield_data_uk(_fetch_start, _fetch_end)

if _live_yields is not None:
    GILT_YIELDS = _live_yields
else:
    _sim_src = _true_factors if not _sufficient else FACTORS_SMOOTH
    GILT_YIELDS = _simulate_yield_block(_sim_src, _rng)

PC_SCORES, PC_LOADINGS, PC_EXPLAINED_VAR, YIELD_MEANS = _compute_pca(GILT_YIELDS)

# Regressions: PC1/PC2 ~ macro factors (no intercept)
PC1_REG = _ols(PC_SCORES[:, 0], FACTORS_SMOOTH)
PC2_REG = _ols(PC_SCORES[:, 1], FACTORS_SMOOTH)

# Fair value for 10y Gilt
GILT_PCA_FITTED = (
    YIELD_MEANS[UK_10Y_IDX]
    + PC_SCORES[:, 0] * PC_LOADINGS[0, UK_10Y_IDX]
    + PC_SCORES[:, 1] * PC_LOADINGS[1, UK_10Y_IDX]
)
GILT_MACRO_FV = (
    YIELD_MEANS[UK_10Y_IDX]
    + PC1_REG["fitted"] * PC_LOADINGS[0, UK_10Y_IDX]
    + PC2_REG["fitted"] * PC_LOADINGS[1, UK_10Y_IDX]
)
GILT_RICH_CHEAP_BPS = (GILT_YIELDS[:, UK_10Y_IDX] - GILT_MACRO_FV) * 100


# ---------------------------------------------------------------------------
# API response dataclasses
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


# ---------------------------------------------------------------------------
# API functions
# ---------------------------------------------------------------------------


def get_uk_daily_factors() -> DailyFactorsResponse:
    dates = [d.strftime("%Y-%m-%d") for d in DAILY_DATES]
    factors = {
        name: FACTORS_SMOOTH[:, k].round(4).tolist()
        for k, name in enumerate(FACTOR_NAMES)
    }
    return DailyFactorsResponse(dates=dates, factors=factors)


def get_uk_fair_value() -> FairValueResponse:
    dates = [d.strftime("%Y-%m-%d") for d in DAILY_DATES]
    return FairValueResponse(
        dates=dates,
        actual=GILT_YIELDS[:, UK_10Y_IDX].round(4).tolist(),
        pca_fitted=GILT_PCA_FITTED.round(4).tolist(),
        macro_fair_value=GILT_MACRO_FV.round(4).tolist(),
        rich_cheap_bps=GILT_RICH_CHEAP_BPS.round(2).tolist(),
    )


def get_uk_yield_pca() -> YieldPCAResponse:
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
        tenor_names=GILT_TENORS,
    )


def get_uk_pc_regressions() -> PCRegressionResponse:
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
