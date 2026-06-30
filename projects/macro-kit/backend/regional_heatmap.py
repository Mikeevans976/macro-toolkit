"""
regional_heatmap.py — shared engine for all regional macro heatmap modules.

All 10 regional heatmaps (Euro Area, UK, US, Japan, Canada, Sweden, Norway,
Switzerland, Australia, New Zealand) delegate their computation here.  Each
region defines a HeatmapConfig dataclass and instantiates a RegionalHeatmap
object; the 4 API getter functions are then re-exported from the thin wrapper.

Architecture (two-block model)
-------------------------------
Block 1 — Macro DFM (macro data only, no yields):
  Monthly macro indicators → Kalman smoother → daily factor estimates.
  Factors: Global Macro, Growth, Inflation, Employment, Wages (K=5).

Block 2 — Yield curve (daily, separate pipeline):
  Daily government bond yields → PCA → daily PC scores.
  PC1/PC2 regressed on Block 1 daily factors (no intercept).
  10y bond fair value reconstructed via PCA inversion.

No yields enter Block 1 — this eliminates the circularity of using yields
to identify factors and then using those factors to predict yields.
"""

from __future__ import annotations

import os
import warnings
import numpy as np
import pandas as pd
from dataclasses import dataclass
from pathlib import Path
from typing import Optional
from dfm import (
    kalman_filter,
    kalman_smoother,
    estimate_ar1_daily,
    estimate_loadings_ols,
)
from macro_data_loader import load_macro_data, MacroData, _load_dfm_meta
from data_fetcher import get_fetcher

# ---------------------------------------------------------------------------
# Shared date grid (identical for all regions)
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
# Shared factor constants (identical for all regions)
# ---------------------------------------------------------------------------

FACTOR_NAMES = ["Global Macro", "Growth", "Inflation", "Employment", "Wages"]
_NAMED_FACTORS = FACTOR_NAMES[1:]  # the four group factors
K = len(FACTOR_NAMES)  # 5


# ---------------------------------------------------------------------------
# Response dataclasses (identical across all modules)
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
# HeatmapConfig
# ---------------------------------------------------------------------------

@dataclass
class HeatmapConfig:
    region: str                          # slug for log messages, e.g. "uk", "euro_area"
    bond_name: str                       # e.g. "Gilt", "Bund", "UST"
    m_macro: int                         # number of macro series in DFM catalogue
    catalogue_path: Optional[str]        # None = default EA catalogue (no catalogue_path kwarg)
    gm_primary_series_id: str           # series ID used to anchor Global Macro sign (e.g. "ea_esi")
    yield_series_ids: list[str]          # series IDs for bond yields, must match yield_tenors order
    yield_tenors: list[str]              # e.g. ["2y","5y","10y","20y","30y"]
    yield_means: np.ndarray              # [N_tenors] approximate yield means (%)
    yield_factor_loadings: np.ndarray    # [N_tenors, K] factor → yield loadings for simulation
    yield_noise_factor: float            # std of idiosyncratic noise in simulated yields
    pca_pc1_pivot: int                   # tenor index for PC1 sign anchor (typically 10y index)
    pca_pc2_pivot: int                   # tenor index for PC2 sign anchor (typically longest tenor)
    pca_pc3_pivot: int                   # tenor index for PC3 sign anchor (typically 5y or 7y index)
    random_seed: int                     # RNG seed for reproducible simulation


# ---------------------------------------------------------------------------
# Shared helper functions
# ---------------------------------------------------------------------------

def _block_pca_1(
    Y_std: np.ndarray,
    cols: list[int],
    primary_col: int,
    primary_sign: int,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Extract the first principal component from a subset of standardised columns.

    Returns
    -------
    score    : [T]   factor score time series
    loadings : [M]   sparse loading vector (zeros outside `cols`)
    """
    T, M = Y_std.shape
    block = Y_std[:, cols]                      # [T, n_block]
    cov = block.T @ block / (T - 1)             # [n_block, n_block]
    _, evecs = np.linalg.eigh(cov)
    pc1 = evecs[:, -1]                          # highest eigenvalue

    # Sign normalise against primary series
    block_pos = cols.index(primary_col)
    if pc1[block_pos] * primary_sign < 0:
        pc1 = -pc1

    score = block @ pc1                         # [T]
    loading_full = np.zeros(M)
    loading_full[cols] = pc1
    return score, loading_full


def _ols(y: np.ndarray, X: np.ndarray) -> dict:
    """OLS without intercept. y: [N], X: [N, K]."""
    N, Kx = X.shape
    XtX = X.T @ X
    beta = np.linalg.solve(XtX, X.T @ y)
    fitted = X @ beta
    resid = y - fitted
    sigma2 = (resid ** 2).sum() / (N - Kx)
    se = np.sqrt(sigma2 * np.diag(np.linalg.inv(XtX)))
    tstat = beta / se
    TSS = ((y - y.mean()) ** 2).sum()
    r2 = 1 - (resid ** 2).sum() / TSS
    adj_r2 = 1 - (1 - r2) * (N - 1) / (N - Kx)
    return dict(beta=beta, tstat=tstat, r2=r2, adj_r2=adj_r2, fitted=fitted, resid=resid)


def _fmt(reg: dict) -> dict:
    """Format OLS result for API response."""
    return dict(
        beta=reg["beta"].round(4).tolist(),
        tstat=reg["tstat"].round(3).tolist(),
        r2=round(float(reg["r2"]), 4),
        adj_r2=round(float(reg["adj_r2"]), 4),
    )


# ---------------------------------------------------------------------------
# RegionalHeatmap class
# ---------------------------------------------------------------------------

class RegionalHeatmap:
    """
    Encapsulates Block 1 (macro DFM) + Block 2 (yield PCA) computation for
    a single region.  All expensive computation runs once at instantiation
    (i.e. at module import time for each thin wrapper).
    """

    def __init__(self, cfg: HeatmapConfig) -> None:
        self.cfg = cfg
        self._precompute()

    # ------------------------------------------------------------------
    # Pre-computation
    # ------------------------------------------------------------------

    def _precompute(self) -> None:
        cfg = self.cfg
        self._rng = np.random.default_rng(cfg.random_seed)

        _fetch_start = (DAILY_DATES[0] - pd.DateOffset(years=2)).strftime("%Y-%m-%d")
        _fetch_end = DAILY_DATES[-1].strftime("%Y-%m-%d")

        # ── Load catalogue metadata ────────────────────────────────────────────
        catalogue_path_resolved: Optional[Path] = (
            None if cfg.catalogue_path is None
            else Path(__file__).parent / cfg.catalogue_path
        )
        self._dfm_meta = _load_dfm_meta(
            m_macro=cfg.m_macro,
            **({} if catalogue_path_resolved is None else {"catalogue_path": catalogue_path_resolved}),
        )
        self._macro_series_ids = [e["id"] for e in self._dfm_meta]

        # Group columns and primary series indices (derived from catalogue)
        self._primary_by_factor = {
            e["dfm_factor"]: e for e in self._dfm_meta if e.get("dfm_primary")
        }
        self._group_cols: dict[str, list[int]] = {
            fname: sorted(
                e["dfm_col_index"] for e in self._dfm_meta if e["dfm_factor"] == fname
            )
            for fname in _NAMED_FACTORS
        }
        self._named_primary_col = [
            self._primary_by_factor[f]["dfm_col_index"] for f in _NAMED_FACTORS
        ]
        self._named_primary_sign = [
            int(self._primary_by_factor[f]["dfm_sign"]) for f in _NAMED_FACTORS
        ]

        # Global Macro sign anchor
        self._gm_primary_col = next(
            e["dfm_col_index"]
            for e in self._dfm_meta
            if e["id"] == cfg.gm_primary_series_id
        )
        self._gm_primary_sign = 1

        # ── Block 1: macro DFM ────────────────────────────────────────────────
        live_data = self._fetch_macro_data(_fetch_start, _fetch_end)

        load_kwargs: dict = dict(
            daily_dates=DAILY_DATES,
            m_macro=cfg.m_macro,
            data=live_data,
        )
        if catalogue_path_resolved is not None:
            load_kwargs["catalogue_path"] = catalogue_path_resolved

        macro_data: MacroData = load_macro_data(**load_kwargs)

        for w in macro_data.warnings:
            warnings.warn(f"[{cfg.region}] {w}", stacklevel=1)

        _min_obs = 3
        _sufficient = (
            os.environ.get("ANALYTICS_DATA_SOURCE", "csv").lower() != "simulation"
            and macro_data.has_data
            and all(v >= _min_obs for v in macro_data.n_obs_per_series.values())
        )

        if _sufficient:
            self.FACTORS_SMOOTH, self.FACTORS_FILT = self._build_macro_dfm_from_data(
                macro_data.Y_daily
            )
            _true_factors = None
        else:
            _true_factors, _Lambda_sim, _Y_monthly = self._simulate_macro_block()
            self.FACTORS_SMOOTH, self.FACTORS_FILT = self._build_macro_dfm_sim(
                _Lambda_sim, _Y_monthly, _true_factors[MONTH_END_IDX]
            )

        # ── Block 2: yield PCA ────────────────────────────────────────────────
        live_yields = self._fetch_yield_data(_fetch_start, _fetch_end)

        if live_yields is not None:
            self.YIELDS = live_yields
        else:
            _sim_src = _true_factors if not _sufficient else self.FACTORS_SMOOTH
            self.YIELDS = self._simulate_yields(_sim_src)

        self.PC_SCORES, self.PC_LOADINGS, self.PC_EXPLAINED_VAR, self._yield_means = (
            self._compute_pca(self.YIELDS)
        )

        # ── Regressions: PC1/PC2 ~ macro factors (no intercept) ───────────────
        self.PC1_REG = _ols(self.PC_SCORES[:, 0], self.FACTORS_SMOOTH)
        self.PC2_REG = _ols(self.PC_SCORES[:, 1], self.FACTORS_SMOOTH)

        # ── Fair value for 10y bond ────────────────────────────────────────────
        pc1_idx = cfg.pca_pc1_pivot  # index of 10y tenor in yield_tenors
        self.MACRO_FV = (
            self._yield_means[pc1_idx]
            + self.PC1_REG["fitted"] * self.PC_LOADINGS[0, pc1_idx]
            + self.PC2_REG["fitted"] * self.PC_LOADINGS[1, pc1_idx]
        )
        self.PCA_FITTED = (
            self._yield_means[pc1_idx]
            + self.PC_SCORES[:, 0] * self.PC_LOADINGS[0, pc1_idx]
            + self.PC_SCORES[:, 1] * self.PC_LOADINGS[1, pc1_idx]
        )
        self.RICH_CHEAP_BPS = (self.YIELDS[:, pc1_idx] - self.MACRO_FV) * 100

    # ------------------------------------------------------------------
    # Block 1 helpers
    # ------------------------------------------------------------------

    def _simulate_macro_block(
        self,
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """
        Simulate K=5 daily factors and M=m_macro macro observations.

        Returns
        -------
        factors    : [T_DAILY, K]
        Lambda_sim : [m_macro, K]
        Y_monthly  : [T_MONTHLY, m_macro]  observations at month-end
        """
        cfg = self.cfg
        rng = self._rng
        m_macro = cfg.m_macro

        ar = np.array([0.95, 0.92, 0.90, 0.93, 0.88])
        innov_std = np.array([0.10, 0.15, 0.12, 0.10, 0.12])

        factors = np.zeros((T_DAILY, K))
        factors[0] = rng.standard_normal(K) * innov_std
        for t in range(1, T_DAILY):
            eta = rng.standard_normal(K) * innov_std * np.sqrt(1 - ar ** 2)
            factors[t] = ar * factors[t - 1] + eta

        Lambda_sim = np.zeros((m_macro, K))
        group_factor_col = {"Growth": 1, "Inflation": 2, "Employment": 3, "Wages": 4}
        for entry in self._dfm_meta:
            m = entry["dfm_col_index"]
            gfc = group_factor_col[entry["dfm_factor"]]
            Lambda_sim[m, 0] = 0.5
            Lambda_sim[m, gfc] = 1.0 * int(entry["dfm_sign"])

        noise_std = np.full(m_macro, 0.3)
        Y_monthly = (
            factors[MONTH_END_IDX] @ Lambda_sim.T
            + rng.standard_normal((T_MONTHLY, m_macro)) * noise_std
        )
        return factors, Lambda_sim, Y_monthly

    def _build_macro_dfm_sim(
        self,
        Lambda_sim: np.ndarray,
        Y_monthly: np.ndarray,
        f_monthly: np.ndarray,
    ) -> tuple[np.ndarray, np.ndarray]:
        """Simulation fallback: OLS init → Kalman smoother."""
        cfg = self.cfg
        Lambda_est = estimate_loadings_ols(f_monthly, Y_monthly)
        ar_est = estimate_ar1_daily(f_monthly)
        A_est = np.diag(ar_est)

        innov_var = np.var(f_monthly[1:] - f_monthly[:-1] * ar_est[None, :], axis=0)
        Q_est = np.diag(np.maximum(innov_var, 1e-6))

        resid = Y_monthly - f_monthly @ Lambda_est.T
        R_est = np.diag(np.maximum(np.var(resid, axis=0), 1e-6))

        Y_daily_sim = np.full((T_DAILY, cfg.m_macro), np.nan)
        Y_daily_sim[MONTH_END_IDX] = Y_monthly

        f_filt, P_filt, f_pred, P_pred, _ = kalman_filter(
            Y=Y_daily_sim, Lambda=Lambda_est, A=A_est, Q=Q_est, R=R_est,
        )
        f_smooth, _ = kalman_smoother(f_filt, P_filt, f_pred, P_pred, A_est)
        return f_smooth, f_filt

    def _build_macro_dfm_from_data(
        self,
        Y_daily: np.ndarray,
    ) -> tuple[np.ndarray, np.ndarray]:
        """
        Block-PCA initialisation + Kalman smoother for the 5-factor model.

        Pipeline
        --------
        1.  Forward-fill Y_daily (LOCF) → Y_ffill [T, M], no NaNs.
        2.  Standardise each column using statistics from actual observations only.
        3.  Within-group PCA for each named factor → score [T] + sparse loading [M].
        4.  Full-panel PCA for Global Macro → score [T] + dense loading [M].
        5.  Assemble F_init [T, 5] and Λ_std [M, 5].
        6.  Un-standardise Λ to original units.
        7.  Estimate AR(1) coefficients and noise matrices from F_init scores.
        8.  Run Kalman filter + RTS smoother on raw Y_daily (with NaNs).
        """
        T, M = Y_daily.shape

        # ── 1. Forward-fill ───────────────────────────────────────────────────
        Y_ffill = pd.DataFrame(Y_daily).ffill().bfill().values       # [T, M]

        # ── 2. Standardise (stats from actual observations only) ──────────────
        col_means = np.nanmean(Y_daily, axis=0)
        col_stds  = np.nanstd(Y_daily,  axis=0)
        col_stds  = np.where(col_stds < 1e-8, 1.0, col_stds)

        Y_std = (Y_ffill - col_means[None, :]) / col_stds[None, :]

        # ── 3. Within-group PCA for each named factor ─────────────────────────
        F_init    = np.zeros((T, K))
        Lambda_std = np.zeros((M, K))

        for k, fname in enumerate(_NAMED_FACTORS):
            cols         = self._group_cols[fname]
            primary_col  = self._named_primary_col[k]
            primary_sign = self._named_primary_sign[k]
            score, loading = _block_pca_1(Y_std, cols, primary_col, primary_sign)
            F_init[:, k + 1]     = score
            Lambda_std[:, k + 1] = loading

        # ── 4. Full-panel PCA for Global Macro ────────────────────────────────
        all_cols = list(range(M))
        gm_score, gm_loading = _block_pca_1(
            Y_std, all_cols, self._gm_primary_col, self._gm_primary_sign
        )
        F_init[:, 0]     = gm_score
        Lambda_std[:, 0] = gm_loading

        # ── 5. Un-standardise loadings → original units ───────────────────────
        Lambda_est = Lambda_std * col_stds[:, None]

        # ── 6. AR(1) transition + noise matrices ──────────────────────────────
        ar_est  = estimate_ar1_daily(F_init)
        A_est   = np.diag(ar_est)

        resid_ar = F_init[1:] - F_init[:-1] * ar_est[None, :]
        Q_est    = np.diag(np.maximum(np.var(resid_ar, axis=0), 1e-6))

        Y_fitted  = F_init @ Lambda_est.T + col_means[None, :]
        resid_obs = Y_ffill - Y_fitted
        R_est     = np.diag(np.maximum(np.var(resid_obs, axis=0), 1e-6))

        # ── 7. Kalman filter + RTS smoother on raw Y_daily ────────────────────
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

    # ------------------------------------------------------------------
    # Block 2 helpers
    # ------------------------------------------------------------------

    def _simulate_yields(self, true_factors: np.ndarray) -> np.ndarray:
        """
        Simulate daily bond yields from latent factors.
        Returns [T_DAILY, N_TENORS].
        """
        cfg = self.cfg
        n_tenors = len(cfg.yield_tenors)
        noise = self._rng.standard_normal((T_DAILY, n_tenors)) * cfg.yield_noise_factor
        return (
            cfg.yield_means[None, :]
            + true_factors @ cfg.yield_factor_loadings.T
            + noise
        )

    def _compute_pca(
        self,
        data: np.ndarray,
        n_components: int = 3,
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        """
        PCA via eigendecomposition of the sample covariance matrix.

        Sign conventions use cfg.pca_pc1_pivot / pca_pc2_pivot / pca_pc3_pivot.

        Returns
        -------
        scores        : [T, n_components]
        loadings      : [n_components, M]
        explained_var : [n_components]
        means         : [M]
        """
        cfg = self.cfg
        means = data.mean(axis=0)
        centered = data - means
        cov = centered.T @ centered / (len(data) - 1)
        eigenvalues, eigenvectors = np.linalg.eigh(cov)
        idx = np.argsort(eigenvalues)[::-1]
        eigenvalues = eigenvalues[idx]
        eigenvectors = eigenvectors[:, idx]

        loadings = eigenvectors[:, :n_components].T  # [n_comp, M]

        pivots = [cfg.pca_pc1_pivot, cfg.pca_pc2_pivot, cfg.pca_pc3_pivot]
        for k, pivot_col in enumerate(pivots):
            if k < n_components and loadings[k, pivot_col] < 0:
                loadings[k] *= -1

        scores = centered @ loadings.T
        explained_var = eigenvalues[:n_components] / eigenvalues.sum()
        return scores, loadings, explained_var, means

    # ------------------------------------------------------------------
    # Live data fetcher helpers
    # ------------------------------------------------------------------

    def _fetch_macro_data(self, start: str, end: str) -> dict[str, pd.Series] | None:
        """
        Attempt to pull macro series from Bloomberg or Haver.

        Returns dict[series_id, pd.Series] on success, or None to trigger fallback.
        """
        cfg = self.cfg
        source = os.environ.get("ANALYTICS_DATA_SOURCE", "csv").lower()

        if source in ("csv", "simulation"):
            return None

        kwargs: dict = {}
        if source == "haver":
            haver_path = os.environ.get("HAVER_PATH")
            if haver_path:
                kwargs["path"] = haver_path

        if cfg.catalogue_path is not None:
            kwargs["catalogue_path"] = Path(__file__).parent / cfg.catalogue_path

        try:
            fetcher = get_fetcher(source, **kwargs)   # type: ignore[arg-type]
            data = fetcher.fetch(self._macro_series_ids, start=start, end=end)
            if not data:
                warnings.warn(
                    f"[{cfg.region}] Fetcher returned no data; falling back to simulation.",
                    stacklevel=1,
                )
                return None
            return data
        except Exception as exc:
            warnings.warn(
                f"[{cfg.region}] Data fetcher failed ({exc}); falling back to simulation.",
                stacklevel=1,
            )
            return None

    def _fetch_yield_data(self, start: str, end: str) -> np.ndarray | None:
        """
        Fetch daily bond yields from Bloomberg or Haver.

        Returns [T_DAILY, N_TENORS] array aligned to DAILY_DATES, or None to simulate.
        """
        cfg = self.cfg
        n_tenors = len(cfg.yield_tenors)
        source = os.environ.get("ANALYTICS_DATA_SOURCE", "csv").lower()
        if source in ("csv", "simulation"):
            return None

        kwargs: dict = {}
        if cfg.catalogue_path is not None:
            kwargs["catalogue_path"] = Path(__file__).parent / cfg.catalogue_path
        if source == "haver":
            haver_path = os.environ.get("HAVER_PATH")
            if haver_path:
                kwargs["path"] = haver_path

        try:
            fetcher = get_fetcher(source, **kwargs)   # type: ignore[arg-type]
            data = fetcher.fetch(cfg.yield_series_ids, start=start, end=end)
            if not data:
                warnings.warn(
                    f"[{cfg.region}] No yield data from fetcher; simulating yields.",
                    stacklevel=1,
                )
                return None

            daily_arr = np.array(DAILY_DATES, dtype="datetime64[D]")
            yield_mat = np.full((T_DAILY, n_tenors), np.nan)

            for k, sid in enumerate(cfg.yield_series_ids):
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
                warnings.warn(
                    f"[{cfg.region}] Yield matrix still has NaNs after fill; simulating.",
                    stacklevel=1,
                )
                return None

            return yield_mat

        except Exception as exc:
            warnings.warn(
                f"[{cfg.region}] Yield fetch failed ({exc}); simulating yields.",
                stacklevel=1,
            )
            return None

    # ------------------------------------------------------------------
    # Public API getters
    # ------------------------------------------------------------------

    def get_daily_factors(self) -> DailyFactorsResponse:
        dates = [d.strftime("%Y-%m-%d") for d in DAILY_DATES]
        factors = {
            name: self.FACTORS_SMOOTH[:, k].round(4).tolist()
            for k, name in enumerate(FACTOR_NAMES)
        }
        return DailyFactorsResponse(dates=dates, factors=factors)

    def get_fair_value(self) -> FairValueResponse:
        cfg = self.cfg
        pc1_idx = cfg.pca_pc1_pivot
        dates = [d.strftime("%Y-%m-%d") for d in DAILY_DATES]
        return FairValueResponse(
            dates=dates,
            actual=self.YIELDS[:, pc1_idx].round(4).tolist(),
            pca_fitted=self.PCA_FITTED.round(4).tolist(),
            macro_fair_value=self.MACRO_FV.round(4).tolist(),
            rich_cheap_bps=self.RICH_CHEAP_BPS.round(2).tolist(),
        )

    def get_yield_pca(self) -> YieldPCAResponse:
        dates = [d.strftime("%Y-%m-%d") for d in DAILY_DATES]
        pc_labels = ["PC1", "PC2", "PC3"]
        return YieldPCAResponse(
            dates=dates,
            pc_scores={
                label: self.PC_SCORES[:, k].round(4).tolist()
                for k, label in enumerate(pc_labels)
            },
            loadings={
                label: self.PC_LOADINGS[k].round(4).tolist()
                for k, label in enumerate(pc_labels)
            },
            explained_var={
                label: round(float(self.PC_EXPLAINED_VAR[k]), 4)
                for k, label in enumerate(pc_labels)
            },
            tenor_names=self.cfg.yield_tenors,
        )

    def get_pc_regressions(self) -> PCRegressionResponse:
        return PCRegressionResponse(
            factor_names=FACTOR_NAMES,
            pc1=_fmt(self.PC1_REG),
            pc2=_fmt(self.PC2_REG),
        )
