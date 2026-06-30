"""
Japan macro heatmap — two-block model.

Architecture
------------
Block 1 — Macro DFM (macro data only, no yields):
  Monthly/quarterly macro indicators → Kalman smoother → daily factor estimates.
  Factors: Global Macro, Growth, Inflation, Employment, Wages (K=5).

Block 2 — JGB curve (daily, separate pipeline):
  Daily JGB yields → PCA → daily PC scores.
  PC1/PC2 regressed on Block 1 daily factors (no intercept).
  10y JGB fair value reconstructed via PCA inversion.

No yields enter Block 1. This eliminates the circularity of using yields
to identify factors and then using those factors to predict yields.

Series metadata is read from data/series_catalogue_jp.json via
macro_data_loader._load_dfm_meta(m_macro=44, catalogue_path=...).

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
# Japan catalogue path
# ---------------------------------------------------------------------------

_JP_CATALOGUE_PATH = Path(__file__).parent / "data" / "series_catalogue_jp.json"

# ---------------------------------------------------------------------------
# DFM series metadata — single source of truth: series_catalogue_jp.json
# ---------------------------------------------------------------------------

_dfm_meta = _load_dfm_meta(m_macro=44, catalogue_path=_JP_CATALOGUE_PATH)

_MACRO_SERIES_IDS     = [e["id"]   for e in _dfm_meta]
MACRO_INDICATOR_NAMES = [e["name"] for e in _dfm_meta]

# Primary series per named factor (from catalogue dfm_primary=True entries).
_primary_by_factor = {e["dfm_factor"]: e for e in _dfm_meta if e.get("dfm_primary")}

# ---------------------------------------------------------------------------
# Constants and model dimensions
# ---------------------------------------------------------------------------

FACTOR_NAMES   = ["Global Macro", "Growth", "Inflation", "Employment", "Wages"]
_NAMED_FACTORS = FACTOR_NAMES[1:]

K          = len(FACTOR_NAMES)       # 5
M_MACRO_JP = len(_MACRO_SERIES_IDS)  # 44

JGB_TENORS  = ["2y", "5y", "10y", "20y", "30y"]
N_TENORS    = len(JGB_TENORS)        # 5
JP_10Y_IDX  = JGB_TENORS.index("10y")  # 2

_GROUP_COLS: dict[str, list[int]] = {
    fname: sorted(e["dfm_col_index"] for e in _dfm_meta if e["dfm_factor"] == fname)
    for fname in _NAMED_FACTORS
}

_NAMED_PRIMARY_COL  = [_primary_by_factor[f]["dfm_col_index"] for f in _NAMED_FACTORS]
_NAMED_PRIMARY_SIGN = [int(_primary_by_factor[f]["dfm_sign"])  for f in _NAMED_FACTORS]

# Global Macro anchor: Jibun Bank Composite PMI (mfg + services).
_GM_PRIMARY_COL  = next(e["dfm_col_index"] for e in _dfm_meta if e["id"] == "jp_jibun_composite_pmi")
_GM_PRIMARY_SIGN = 1

# ---------------------------------------------------------------------------
# Date grid
# ---------------------------------------------------------------------------

DAILY_DATES: pd.DatetimeIndex = pd.bdate_range("2023-06-01", "2025-06-30")
T_DAILY = len(DAILY_DATES)

MONTHLY_DATES: pd.DatetimeIndex = (
    pd.Series(DAILY_DATES).groupby(DAILY_DATES.to_period("M")).last().values
)
MONTHLY_DATES = pd.DatetimeIndex(MONTHLY_DATES)
T_MONTHLY = len(MONTHLY_DATES)

MONTH_END_IDX: np.ndarray = np.array(
    [np.searchsorted(DAILY_DATES, d) for d in MONTHLY_DATES]
)

# ---------------------------------------------------------------------------
# Block 2 yield parameters — JGB curve
# ---------------------------------------------------------------------------

# Approximate JGB yield means (%, approx Jun 2025, post-BoJ normalisation)
JGB_YIELD_MEANS = np.array([0.70, 1.10, 1.55, 2.30, 2.75])

# How each macro factor drives each JGB tenor (simulation only).
# Japan short end is very BoJ-policy/inflation driven; long end more term premium.
_JP_YIELD_FACTOR_LOADINGS = np.array([
    # GlobalMacro  Growth  Inflation  Employment  Wages
    [   0.08,       0.10,    0.35,      0.05,     0.12],  # 2y  (BoJ policy / inflation)
    [   0.10,       0.12,    0.28,      0.05,     0.10],  # 5y
    [   0.12,       0.15,    0.22,      0.05,     0.10],  # 10y
    [   0.13,       0.18,    0.16,      0.04,     0.08],  # 20y
    [   0.14,       0.20,    0.12,      0.04,     0.08],  # 30y (term premium)
])

# ---------------------------------------------------------------------------
# Block 1 — Macro DFM
# ---------------------------------------------------------------------------


def _simulate_macro_block(rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    ar        = np.array([0.95, 0.92, 0.90, 0.93, 0.88])
    innov_std = np.array([0.10, 0.15, 0.12, 0.10, 0.12])

    factors = np.zeros((T_DAILY, K))
    factors[0] = rng.standard_normal(K) * innov_std
    for t in range(1, T_DAILY):
        eta = rng.standard_normal(K) * innov_std * np.sqrt(1 - ar ** 2)
        factors[t] = ar * factors[t - 1] + eta

    Lambda_sim = np.zeros((M_MACRO_JP, K))
    group_factor_col = {"Growth": 1, "Inflation": 2, "Employment": 3, "Wages": 4}
    for entry in _dfm_meta:
        m   = entry["dfm_col_index"]
        gfc = group_factor_col[entry["dfm_factor"]]
        Lambda_sim[m, 0]   = 0.5
        Lambda_sim[m, gfc] = 1.0 * int(entry["dfm_sign"])

    noise_std = np.full(M_MACRO_JP, 0.3)
    Y_monthly = (
        factors[MONTH_END_IDX] @ Lambda_sim.T
        + rng.standard_normal((T_MONTHLY, M_MACRO_JP)) * noise_std
    )
    return factors, Lambda_sim, Y_monthly


def _build_macro_dfm_sim(
    Lambda_sim: np.ndarray,
    Y_monthly:  np.ndarray,
    f_monthly:  np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    Lambda_est = estimate_loadings_ols(f_monthly, Y_monthly)
    ar_est     = estimate_ar1_daily(f_monthly)
    A_est      = np.diag(ar_est)

    innov_var = np.var(f_monthly[1:] - f_monthly[:-1] * ar_est[None, :], axis=0)
    Q_est     = np.diag(np.maximum(innov_var, 1e-6))

    resid = Y_monthly - f_monthly @ Lambda_est.T
    R_est = np.diag(np.maximum(np.var(resid, axis=0), 1e-6))

    Y_daily_sim = np.full((T_DAILY, M_MACRO_JP), np.nan)
    Y_daily_sim[MONTH_END_IDX] = Y_monthly

    f_filt, P_filt, f_pred, P_pred, _ = kalman_filter(
        Y=Y_daily_sim, Lambda=Lambda_est, A=A_est, Q=Q_est, R=R_est,
    )
    f_smooth, _ = kalman_smoother(f_filt, P_filt, f_pred, P_pred, A_est)
    return f_smooth, f_filt


# ---------------------------------------------------------------------------
# Block 2 — JGB yield simulation
# ---------------------------------------------------------------------------


def _simulate_yield_block(
    true_factors: np.ndarray,
    rng: np.random.Generator,
) -> np.ndarray:
    noise = rng.standard_normal((T_DAILY, N_TENORS)) * 0.015
    return JGB_YIELD_MEANS[None, :] + true_factors @ _JP_YIELD_FACTOR_LOADINGS.T + noise


# ---------------------------------------------------------------------------
# PCA helper
# ---------------------------------------------------------------------------


def _compute_pca(
    data: np.ndarray,
    n_components: int = 3,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    PCA via eigendecomposition of the sample covariance matrix.

    Sign conventions for JGB PCA:
      PC1 (Level)     : anchor on 10y (index 2) positive
      PC2 (Slope)     : anchor on 30y (index 4) positive
      PC3 (Curvature) : anchor on 5y  (index 1) positive
    """
    means = data.mean(axis=0)
    centered = data - means
    cov = centered.T @ centered / (len(data) - 1)
    eigenvalues, eigenvectors = np.linalg.eigh(cov)
    idx = np.argsort(eigenvalues)[::-1]
    eigenvalues = eigenvalues[idx]
    eigenvectors = eigenvectors[:, idx]

    loadings = eigenvectors[:, :n_components].T

    for k, pivot_col in enumerate([JP_10Y_IDX, N_TENORS - 1, 1]):
        if k < n_components and loadings[k, pivot_col] < 0:
            loadings[k] *= -1

    scores = centered @ loadings.T
    explained_var = eigenvalues[:n_components] / eigenvalues.sum()
    return scores, loadings, explained_var, means


# ---------------------------------------------------------------------------
# OLS (no intercept)
# ---------------------------------------------------------------------------


def _ols(y: np.ndarray, X: np.ndarray) -> dict:
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
    T, M = Y_std.shape
    block = Y_std[:, cols]
    cov   = block.T @ block / (T - 1)
    _, evecs = np.linalg.eigh(cov)
    pc1 = evecs[:, -1]

    block_pos = cols.index(primary_col)
    if pc1[block_pos] * primary_sign < 0:
        pc1 = -pc1

    score           = block @ pc1
    loading_full    = np.zeros(M)
    loading_full[cols] = pc1
    return score, loading_full


def _build_macro_dfm_from_data(
    Y_daily: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    T, M = Y_daily.shape

    Y_ffill = pd.DataFrame(Y_daily).ffill().bfill().values

    col_means = np.nanmean(Y_daily, axis=0)
    col_stds  = np.nanstd(Y_daily,  axis=0)
    col_stds  = np.where(col_stds < 1e-8, 1.0, col_stds)

    Y_std = (Y_ffill - col_means[None, :]) / col_stds[None, :]

    F_init    = np.zeros((T, K))
    Lambda_std = np.zeros((M, K))

    for k, fname in enumerate(_NAMED_FACTORS):
        cols         = _GROUP_COLS[fname]
        primary_col  = _NAMED_PRIMARY_COL[k]
        primary_sign = _NAMED_PRIMARY_SIGN[k]
        score, loading = _block_pca_1(Y_std, cols, primary_col, primary_sign)
        F_init[:, k + 1]      = score
        Lambda_std[:, k + 1]  = loading

    all_cols = list(range(M))
    gm_score, gm_loading = _block_pca_1(Y_std, all_cols, _GM_PRIMARY_COL, _GM_PRIMARY_SIGN)
    F_init[:, 0]     = gm_score
    Lambda_std[:, 0] = gm_loading

    Lambda_est = Lambda_std * col_stds[:, None]

    ar_est   = estimate_ar1_daily(F_init)
    A_est    = np.diag(ar_est)

    resid_ar = F_init[1:] - F_init[:-1] * ar_est[None, :]
    Q_est    = np.diag(np.maximum(np.var(resid_ar, axis=0), 1e-6))

    Y_fitted  = F_init @ Lambda_est.T + col_means[None, :]
    resid_obs = Y_ffill - Y_fitted
    R_est     = np.diag(np.maximum(np.var(resid_obs, axis=0), 1e-6))

    Y_kalman = Y_daily - col_means[None, :]

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

def _fetch_macro_data_jp(start: str, end: str) -> dict[str, pd.Series] | None:
    """
    Attempt to pull Japan macro series from Bloomberg or Haver.

    Controlled by the ANALYTICS_DATA_SOURCE environment variable:
      "bloomberg"  — fetch via Bloomberg Desktop API (requires blpapi + Terminal)
      "haver"      — fetch via Haver DLX (requires Haver pkg + HAVER_PATH)
      "csv"        — skip fetcher (default)
      "simulation" — use synthetic data

    Returns dict[series_id, pd.Series] on success, or None for simulation fallback.
    """
    source = os.environ.get("ANALYTICS_DATA_SOURCE", "csv").lower()

    if source in ("csv", "simulation"):
        return None

    kwargs: dict = {}
    if source == "haver":
        haver_path = os.environ.get("HAVER_PATH")
        if haver_path:
            kwargs["path"] = haver_path

    kwargs["catalogue_path"] = _JP_CATALOGUE_PATH

    try:
        fetcher = get_fetcher(source, **kwargs)   # type: ignore[arg-type]
        data = fetcher.fetch(_MACRO_SERIES_IDS, start=start, end=end)
        if not data:
            warnings.warn(
                "[japan_heatmap] Fetcher returned no data; falling back to simulation.",
                stacklevel=1,
            )
            return None
        return data
    except Exception as exc:
        warnings.warn(
            f"[japan_heatmap] Data fetcher failed ({exc}); falling back to simulation.",
            stacklevel=1,
        )
        return None



# Series IDs for government bond yields (must match YIELD_TENORS order)
_YIELD_SERIES_IDS_JP = ['jp_jgb_2y', 'jp_jgb_5y', 'jp_jgb_10y', 'jp_jgb_20y', 'jp_jgb_30y']


def _fetch_yield_data_jp(start: str, end: str) -> "np.ndarray | None":
    """
    Fetch daily government bond yields from Bloomberg or Haver.
    Returns [T_DAILY, N_TENORS] array aligned to DAILY_DATES, or None to simulate.
    """
    source = os.environ.get("ANALYTICS_DATA_SOURCE", "csv").lower()
    if source in ("csv", "simulation"):
        return None

    kwargs: dict = {"catalogue_path": _JP_CATALOGUE_PATH}
    if source == "haver":
        haver_path = os.environ.get("HAVER_PATH")
        if haver_path:
            kwargs["path"] = haver_path

    try:
        fetcher = get_fetcher(source, **kwargs)   # type: ignore[arg-type]
        data = fetcher.fetch(_YIELD_SERIES_IDS_JP, start=start, end=end)
        if not data:
            warnings.warn("[jp_heatmap] No yield data from fetcher; simulating yields.", stacklevel=1)
            return None

        daily_arr = np.array(DAILY_DATES, dtype="datetime64[D]")
        yield_mat = np.full((T_DAILY, N_TENORS), np.nan)

        for k, sid in enumerate(_YIELD_SERIES_IDS_JP):
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
            warnings.warn("[jp_heatmap] Yield matrix still has NaNs after fill; simulating.", stacklevel=1)
            return None

        return yield_mat

    except Exception as exc:
        warnings.warn(f"[jp_heatmap] Yield fetch failed ({exc}); simulating yields.", stacklevel=1)
        return None

# ---------------------------------------------------------------------------
# Main computation — run once at import
# ---------------------------------------------------------------------------

_rng = np.random.default_rng(77)

_fetch_start = (DAILY_DATES[0] - pd.DateOffset(years=2)).strftime("%Y-%m-%d")
_fetch_end   = DAILY_DATES[-1].strftime("%Y-%m-%d")
_live_data   = _fetch_macro_data_jp(_fetch_start, _fetch_end)

_macro_data: MacroData = load_macro_data(
    daily_dates=DAILY_DATES,
    m_macro=M_MACRO_JP,
    data=_live_data,
    catalogue_path=_JP_CATALOGUE_PATH,
)

for _w in _macro_data.warnings:
    warnings.warn(f"[japan_heatmap] {_w}", stacklevel=1)

_min_obs = 3
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
_live_yields = _fetch_yield_data_jp(_fetch_start, _fetch_end)

if _live_yields is not None:
    JGB_YIELDS = _live_yields
else:
    _sim_src = _true_factors if not _sufficient else FACTORS_SMOOTH
    JGB_YIELDS = _simulate_yield_block(_sim_src, _rng)

PC_SCORES, PC_LOADINGS, PC_EXPLAINED_VAR, YIELD_MEANS = _compute_pca(JGB_YIELDS)

PC1_REG = _ols(PC_SCORES[:, 0], FACTORS_SMOOTH)
PC2_REG = _ols(PC_SCORES[:, 1], FACTORS_SMOOTH)

JGB_PCA_FITTED = (
    YIELD_MEANS[JP_10Y_IDX]
    + PC_SCORES[:, 0] * PC_LOADINGS[0, JP_10Y_IDX]
    + PC_SCORES[:, 1] * PC_LOADINGS[1, JP_10Y_IDX]
)
JGB_MACRO_FV = (
    YIELD_MEANS[JP_10Y_IDX]
    + PC1_REG["fitted"] * PC_LOADINGS[0, JP_10Y_IDX]
    + PC2_REG["fitted"] * PC_LOADINGS[1, JP_10Y_IDX]
)
JGB_RICH_CHEAP_BPS = (JGB_YIELDS[:, JP_10Y_IDX] - JGB_MACRO_FV) * 100


# ---------------------------------------------------------------------------
# API response dataclasses
# ---------------------------------------------------------------------------


@dataclass
class DailyFactorsResponse:
    dates: list[str]
    factors: dict[str, list[float]]
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
    pc_scores: dict[str, list[float]]
    loadings: dict[str, list[float]]
    explained_var: dict[str, float]
    tenor_names: list[str]


@dataclass
class PCRegressionResponse:
    factor_names: list[str]
    pc1: dict
    pc2: dict


# ---------------------------------------------------------------------------
# API functions
# ---------------------------------------------------------------------------


def get_jp_daily_factors() -> DailyFactorsResponse:
    dates = [d.strftime("%Y-%m-%d") for d in DAILY_DATES]
    factors = {
        name: FACTORS_SMOOTH[:, k].round(4).tolist()
        for k, name in enumerate(FACTOR_NAMES)
    }
    return DailyFactorsResponse(dates=dates, factors=factors)


def get_jp_fair_value() -> FairValueResponse:
    dates = [d.strftime("%Y-%m-%d") for d in DAILY_DATES]
    return FairValueResponse(
        dates=dates,
        actual=JGB_YIELDS[:, JP_10Y_IDX].round(4).tolist(),
        pca_fitted=JGB_PCA_FITTED.round(4).tolist(),
        macro_fair_value=JGB_MACRO_FV.round(4).tolist(),
        rich_cheap_bps=JGB_RICH_CHEAP_BPS.round(2).tolist(),
    )


def get_jp_yield_pca() -> YieldPCAResponse:
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
        tenor_names=JGB_TENORS,
    )


def get_jp_pc_regressions() -> PCRegressionResponse:
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
