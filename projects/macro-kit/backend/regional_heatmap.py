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
  Factors: Global Macro plus one per catalogue group (default Growth,
  Inflation, Employment, Wages; see HeatmapConfig.factors).

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
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Optional
from dfm import (
    kalman_filter,
    kalman_smoother,
    estimate_ar1_daily,
    estimate_loadings_ols,
)
from macro_data_loader import load_macro_data, MacroData, _load_dfm_meta
from data_fetcher import get_fetcher

# ---------------------------------------------------------------------------
# Date grid
# ---------------------------------------------------------------------------

# Simulated data (csv/simulation source) uses a fixed window so snapshots and
# the frontend fixture are stable; live data uses the last LIVE_YEARS years.
SIM_START, SIM_END = "2023-06-01", "2025-06-30"
LIVE_YEARS = 5


def _data_source() -> str:
    return os.environ.get("ANALYTICS_DATA_SOURCE", "csv").lower()


@dataclass(frozen=True)
class DateGrid:
    daily: pd.DatetimeIndex          # business days
    monthly: pd.DatetimeIndex        # last business day of each month
    month_end_idx: np.ndarray        # position of each monthly date in `daily`

    @classmethod
    def between(cls, start, end) -> "DateGrid":
        daily = pd.bdate_range(start, end)
        monthly = pd.DatetimeIndex(pd.Series(daily).groupby(daily.to_period("M")).last().values)
        return cls(daily, monthly, np.searchsorted(daily, monthly))


def date_grid(source: str | None = None) -> DateGrid:
    """Fixed simulation window, or the last LIVE_YEARS years up to the previous business day."""
    if (source or _data_source()) in ("csv", "simulation"):
        return DateGrid.between(SIM_START, SIM_END)
    end = pd.Timestamp.today().normalize() - pd.offsets.BDay(1)
    return DateGrid.between(end - pd.DateOffset(years=LIVE_YEARS), end)


# ---------------------------------------------------------------------------
# Factors
# ---------------------------------------------------------------------------

# Global Macro (full-panel PC) always comes first; the others are catalogue
# groups (dfm_factor). Regions may drop or add groups via HeatmapConfig.factors.
FACTOR_NAMES = ["Global Macro", "Growth", "Inflation", "Employment", "Wages"]
# Daily AR(1) persistence of each simulated factor (half-lives of ~3-12 months).
_SIM_AR = {"Global Macro": 0.997, "Growth": 0.995, "Inflation": 0.994,
           "Employment": 0.996, "Wages": 0.993}
_SIM_AR_DEFAULT = 0.995
# Live DFM needs every factor's primary series plus this share of all series
# to have at least _MIN_OBS observations; the rest are dropped and reported.
LIVE_MIN_COVERAGE = 0.75
_MIN_OBS = 3


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
    display_name: str = ""               # e.g. "United Kingdom"
    breakeven_mean: float = 2.2          # simulated 10y breakeven level (%)
    real_yield_10y_series_id: Optional[str] = None   # catalogue id of the 10y real (linker) yield, if any
    breakeven_10y_series_id: Optional[str] = None    # catalogue id of a quoted 10y breakeven (used as is)
    # Factor set: "Global Macro" then one per catalogue dfm_factor group.
    factors: list[str] = field(default_factory=lambda: list(FACTOR_NAMES))
    # Curve legs for the regime sections and fair-value table (long = fair-value tenor).
    short_tenor: str = "2y"
    long_tenor: str = "10y"
    ultra_tenor: Optional[str] = "30y"
    curve_instrument: Literal["govt", "swap"] = "govt"
    # False: no breakeven section (no inflation-linked market); scenarios use the curve only.
    # True: live breakeven if real_yield_10y_series_id resolves, otherwise simulated.
    breakeven: bool = True
    bloc: Literal["dm", "em"] = "dm"

    def __post_init__(self) -> None:
        if self.factors[0] != "Global Macro":
            raise ValueError(f"[{self.region}] factors must start with 'Global Macro'")
        n_tenors = len(self.yield_tenors)
        if self.yield_factor_loadings.shape != (n_tenors, len(self.factors)):
            raise ValueError(f"[{self.region}] yield_factor_loadings must be "
                             f"[{n_tenors} tenors, {len(self.factors)} factors]")
        legs = [self.short_tenor, self.long_tenor] + ([self.ultra_tenor] if self.ultra_tenor else [])
        missing = [t for t in legs if t not in self.yield_tenors]
        if missing:
            raise ValueError(f"[{self.region}] curve legs {missing} not in yield_tenors")
        if self.yield_tenors[self.pca_pc1_pivot] != self.long_tenor:
            raise ValueError(f"[{self.region}] pca_pc1_pivot must point at long_tenor ({self.long_tenor})")


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


def _apply_transforms(data: dict[str, pd.Series], meta: list[dict]) -> dict[str, pd.Series]:
    """
    Apply each catalogue entry's optional ``transform`` to its fetched series:
    ``yoy`` (% change on a year earlier, for NSA levels), ``diff_yoy``
    (change on a year earlier, for rates) or ``sum12`` (trailing-year sum, for
    monthly flows such as net job creation). Periods are monthly or quarterly.
    """
    out = dict(data)
    for e in meta:
        how, s = e.get("transform"), out.get(e["id"])
        if not how or how == "none" or s is None:
            continue
        lag = 4 if e.get("frequency") == "quarterly" else 12
        s = s.sort_index()
        if isinstance(s.index, pd.PeriodIndex):
            s = s.reindex(pd.period_range(s.index[0], s.index[-1], freq=s.index.freq))
        if how == "yoy":
            s = (s / s.shift(lag) - 1) * 100
        elif how == "diff_yoy":
            s = s - s.shift(lag)
        elif how == "sum12":
            s = s.rolling(lag).sum()
        else:
            raise ValueError(f"unknown transform '{how}' for {e['id']}")
        out[e["id"]] = s.dropna()
    return out


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

        self.grid = date_grid()
        self.factor_names = list(cfg.factors)
        self._named_factors = self.factor_names[1:]
        self.K = len(self.factor_names)
        self.T, self.T_monthly = len(self.grid.daily), len(self.grid.monthly)

        _fetch_start = (self.grid.daily[0] - pd.DateOffset(years=2)).strftime("%Y-%m-%d")
        _fetch_end = self.grid.daily[-1].strftime("%Y-%m-%d")

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
            for fname in self._named_factors
        }
        unknown = {e["dfm_factor"] for e in self._dfm_meta} - set(self._named_factors)
        if unknown:
            raise ValueError(f"[{cfg.region}] catalogue factors {sorted(unknown)} are not in "
                             f"HeatmapConfig.factors {self.factor_names}")
        for fname in self._named_factors:
            if fname not in self._primary_by_factor:
                raise ValueError(f"[{cfg.region}] factor '{fname}' has no dfm_primary series in the catalogue")
        self._named_primary_col = [
            self._primary_by_factor[f]["dfm_col_index"] for f in self._named_factors
        ]
        self._named_primary_sign = [
            int(self._primary_by_factor[f]["dfm_sign"]) for f in self._named_factors
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
            daily_dates=self.grid.daily,
            m_macro=cfg.m_macro,
            data=live_data,
        )
        if catalogue_path_resolved is not None:
            load_kwargs["catalogue_path"] = catalogue_path_resolved

        macro_data: MacroData = load_macro_data(**load_kwargs)

        for w in macro_data.warnings:
            warnings.warn(f"[{cfg.region}] {w}", stacklevel=1)

        # Live if every primary series and LIVE_MIN_COVERAGE of all series have
        # data; series below _MIN_OBS are dropped from the DFM and reported.
        n_obs = macro_data.n_obs_per_series
        keep = np.array([n_obs.get(sid, 0) >= _MIN_OBS for sid in self._macro_series_ids])
        anchors = self._named_primary_col + [self._gm_primary_col]
        _sufficient = (
            _data_source() != "simulation"
            and macro_data.has_data
            and bool(keep[anchors].all())
            and keep.mean() >= LIVE_MIN_COVERAGE
        )
        if macro_data.has_data and not _sufficient:
            warnings.warn(
                f"[{cfg.region}] live macro data too sparse ({int(keep.sum())}/{cfg.m_macro} series, "
                f"primaries {'ok' if keep[anchors].all() else 'missing'}); falling back to simulation.",
                stacklevel=1,
            )

        if _sufficient:
            self.missing_series = [sid for sid, k in zip(self._macro_series_ids, keep) if not k]
            if self.missing_series:
                warnings.warn(f"[{cfg.region}] no live data for {self.missing_series}; "
                              "dropped from the DFM.", stacklevel=1)
            self.FACTORS_SMOOTH, self.FACTORS_FILT = self._build_macro_dfm_from_data(
                macro_data.Y_daily, keep
            )
            _true_factors = None
            self.macro_source = "live"
            # Latest known value of each indicator at each month end (raw units).
            self._indicator_monthly = (
                pd.DataFrame(macro_data.Y_daily).ffill().values[self.grid.month_end_idx]
            )
            self._indicator_raw = True
            observed = ~np.isnan(macro_data.Y_daily)
            self._indicator_last_obs = [
                self.grid.daily[np.flatnonzero(observed[:, m])[-1]].strftime("%Y-%m-%d")
                if observed[:, m].any() else None
                for m in range(cfg.m_macro)
            ]
        else:
            self.missing_series = []
            _true_factors, _Lambda_sim, _Y_monthly = self._simulate_macro_block()
            self.FACTORS_SMOOTH, self.FACTORS_FILT = self._build_macro_dfm_sim(
                _Lambda_sim, _Y_monthly, _true_factors[self.grid.month_end_idx]
            )
            self.macro_source = "simulation"
            self._indicator_monthly = _Y_monthly      # standardised units only
            self._indicator_raw = False
            self._indicator_last_obs = [None] * cfg.m_macro

        # ── Block 2: yield PCA ────────────────────────────────────────────────
        live_yields = self._fetch_yield_data(_fetch_start, _fetch_end)

        self.yield_source = "live" if live_yields is not None else "simulation"
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
        Simulate K daily factors and M=m_macro macro observations.

        Returns
        -------
        factors    : [T, K]
        Lambda_sim : [m_macro, K]
        Y_monthly  : [T_monthly, m_macro]  observations at month-end
        """
        cfg = self.cfg
        rng = self._rng
        m_macro = cfg.m_macro

        # Daily persistence: half-lives of roughly 3-12 months, as for macro
        # cycles (the previous 0.88-0.95 gave half-lives of a few days).
        ar = np.array([_SIM_AR.get(f, _SIM_AR_DEFAULT) for f in self.factor_names])
        # Stationary std of each factor (σ units, as plotted). At 0.10-0.15 the
        # simulated yields moved only a few bp over two years.
        innov_std = np.ones(self.K)

        factors = np.zeros((self.T, self.K))
        factors[0] = rng.standard_normal(self.K) * innov_std
        for t in range(1, self.T):
            eta = rng.standard_normal(self.K) * innov_std * np.sqrt(1 - ar ** 2)
            factors[t] = ar * factors[t - 1] + eta

        Lambda_sim = np.zeros((m_macro, self.K))
        group_factor_col = {f: k for k, f in enumerate(self.factor_names) if k}
        for entry in self._dfm_meta:
            m = entry["dfm_col_index"]
            gfc = group_factor_col[entry["dfm_factor"]]
            Lambda_sim[m, 0] = 0.5
            Lambda_sim[m, gfc] = 1.0 * int(entry["dfm_sign"])

        noise_std = np.full(m_macro, 0.3)
        Y_monthly = (
            factors[self.grid.month_end_idx] @ Lambda_sim.T
            + rng.standard_normal((self.T_monthly, m_macro)) * noise_std
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
        ar_monthly = estimate_ar1_daily(f_monthly)     # estimated month-to-month
        innov_var_m = np.var(f_monthly[1:] - f_monthly[:-1] * ar_monthly[None, :], axis=0)

        # The filter steps daily, so convert the monthly AR(1) to its daily
        # equivalent (a_d = a_m^(1/h), h business days per month) and rescale
        # the innovation variance to keep the stationary variance unchanged.
        # Using the monthly coefficient per day made the state decay to ~0
        # between month-end observations (spiky factors).
        h = self.T / self.T_monthly
        ar_est = ar_monthly ** (1.0 / h)
        A_est = np.diag(ar_est)
        Q_est = np.diag(np.maximum(innov_var_m * (1 - ar_est ** 2) / np.maximum(1 - ar_monthly ** 2, 1e-6), 1e-8))

        resid = Y_monthly - f_monthly @ Lambda_est.T
        R_est = np.diag(np.maximum(np.var(resid, axis=0), 1e-6))

        Y_daily_sim = np.full((self.T, cfg.m_macro), np.nan)
        Y_daily_sim[self.grid.month_end_idx] = Y_monthly

        f_filt, P_filt, f_pred, P_pred, _ = kalman_filter(
            Y=Y_daily_sim, Lambda=Lambda_est, A=A_est, Q=Q_est, R=R_est,
        )
        f_smooth, _ = kalman_smoother(f_filt, P_filt, f_pred, P_pred, A_est)
        return f_smooth, f_filt

    def _build_macro_dfm_from_data(
        self,
        Y_daily: np.ndarray,
        keep: np.ndarray,
    ) -> tuple[np.ndarray, np.ndarray]:
        """
        Block-PCA initialisation + Kalman smoother for the K-factor model.

        Only the columns flagged in ``keep`` enter the model (the caller has
        checked that every factor's primary series is among them).

        Pipeline
        --------
        1.  Forward-fill Y_daily (LOCF) → Y_ffill [T, M], no NaNs.
        2.  Standardise each column using statistics from actual observations only.
        3.  Within-group PCA for each named factor → score [T] + sparse loading [M].
        4.  Full-panel PCA for Global Macro → score [T] + dense loading [M].
        5.  Assemble F_init [T, K] and Λ_std [M, K].
        6.  Un-standardise Λ to original units.
        7.  Estimate AR(1) coefficients and noise matrices from F_init scores.
        8.  Run Kalman filter + RTS smoother on raw Y_daily (with NaNs).
        """
        kept = np.flatnonzero(keep)
        pos = {int(c): i for i, c in enumerate(kept)}          # original column → model column
        Y_daily = Y_daily[:, kept]
        T, M = Y_daily.shape

        # ── 1. Forward-fill ───────────────────────────────────────────────────
        Y_ffill = pd.DataFrame(Y_daily).ffill().bfill().values       # [T, M]

        # ── 2. Standardise (stats from actual observations only) ──────────────
        col_means = np.nanmean(Y_daily, axis=0)
        col_stds  = np.nanstd(Y_daily,  axis=0)
        col_stds  = np.where(col_stds < 1e-8, 1.0, col_stds)

        Y_std = (Y_ffill - col_means[None, :]) / col_stds[None, :]

        # ── 3. Within-group PCA for each named factor ─────────────────────────
        F_init    = np.zeros((T, self.K))
        Lambda_std = np.zeros((M, self.K))

        for k, fname in enumerate(self._named_factors):
            cols         = [pos[c] for c in self._group_cols[fname] if c in pos]
            primary_col  = pos[self._named_primary_col[k]]
            primary_sign = self._named_primary_sign[k]
            score, loading = _block_pca_1(Y_std, cols, primary_col, primary_sign)
            F_init[:, k + 1]     = score
            Lambda_std[:, k + 1] = loading

        # ── 4. Full-panel PCA for Global Macro ────────────────────────────────
        all_cols = list(range(M))
        gm_score, gm_loading = _block_pca_1(
            Y_std, all_cols, pos[self._gm_primary_col], self._gm_primary_sign
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
            P0=np.eye(self.K),
        )
        f_smooth, _ = kalman_smoother(f_filt, P_filt, f_pred, P_pred, A_est)
        return f_smooth, f_filt

    # ------------------------------------------------------------------
    # Block 2 helpers
    # ------------------------------------------------------------------

    def _simulate_yields(self, true_factors: np.ndarray) -> np.ndarray:
        """
        Simulate daily bond yields from latent factors.
        Returns [T, N_TENORS].
        """
        cfg = self.cfg
        n_tenors = len(cfg.yield_tenors)
        shocks = self._rng.standard_normal((self.T, n_tenors)) * cfg.yield_noise_factor
        # Persistent (AR(1)) idiosyncratic deviations with the same marginal
        # std as before: i.i.d. daily noise made the curve PCs mostly noise.
        phi = 0.97
        noise = np.empty_like(shocks)
        noise[0] = shocks[0]
        for t in range(1, self.T):
            noise[t] = phi * noise[t - 1] + np.sqrt(1 - phi ** 2) * shocks[t]
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
        source = _data_source()

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
            return _apply_transforms(data, self._dfm_meta)
        except Exception as exc:
            warnings.warn(
                f"[{cfg.region}] Data fetcher failed ({exc}); falling back to simulation.",
                stacklevel=1,
            )
            return None

    def _fetch_yield_data(self, start: str, end: str) -> np.ndarray | None:
        """
        Fetch daily bond yields from Bloomberg or Haver.

        Returns [T, N_TENORS] array aligned to self.grid.daily, or None to simulate.
        """
        return self._fetch_daily_matrix(self.cfg.yield_series_ids, start, end)

    def _fetch_daily_matrix(self, series_ids: list[str], start: str, end: str) -> np.ndarray | None:
        """
        Fetch daily series from Bloomberg or Haver, aligned to self.grid.daily and
        forward/back-filled. Returns [T, len(series_ids)], or None (the
        caller then simulates) when the source is csv/simulation or data is missing.
        """
        cfg = self.cfg
        n_tenors = len(series_ids)
        source = _data_source()
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
            data = fetcher.fetch(series_ids, start=start, end=end)
            if not data:
                warnings.warn(
                    f"[{cfg.region}] No yield data from fetcher; simulating yields.",
                    stacklevel=1,
                )
                return None

            daily_arr = np.array(self.grid.daily, dtype="datetime64[D]")
            yield_mat = np.full((self.T, n_tenors), np.nan)

            for k, sid in enumerate(series_ids):
                series = data.get(sid)
                if series is None or series.empty:
                    continue
                for ts, val in series.items():
                    if pd.isna(val):
                        continue
                    d = np.datetime64(pd.Timestamp(ts).date(), "D")
                    idx = int(np.searchsorted(daily_arr, d, side="left"))
                    if 0 <= idx < self.T:
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
        dates = [d.strftime("%Y-%m-%d") for d in self.grid.daily]
        factors = {
            name: self.FACTORS_SMOOTH[:, k].round(4).tolist()
            for k, name in enumerate(self.factor_names)
        }
        return DailyFactorsResponse(dates=dates, factors=factors)

    def get_fair_value(self) -> FairValueResponse:
        cfg = self.cfg
        pc1_idx = cfg.pca_pc1_pivot
        dates = [d.strftime("%Y-%m-%d") for d in self.grid.daily]
        return FairValueResponse(
            dates=dates,
            actual=self.YIELDS[:, pc1_idx].round(4).tolist(),
            pca_fitted=self.PCA_FITTED.round(4).tolist(),
            macro_fair_value=self.MACRO_FV.round(4).tolist(),
            rich_cheap_bps=self.RICH_CHEAP_BPS.round(2).tolist(),
        )

    def get_yield_pca(self) -> YieldPCAResponse:
        dates = [d.strftime("%Y-%m-%d") for d in self.grid.daily]
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
            factor_names=self.factor_names,
            pc1=_fmt(self.PC1_REG),
            pc2=_fmt(self.PC2_REG),
        )

    # ------------------------------------------------------------------
    # Full dashboard (everything the regional heatmap page renders)
    # ------------------------------------------------------------------

    def _breakeven_10y(self) -> tuple[np.ndarray, str]:
        """Daily long-tenor breakeven (%): nominal − real when a live real yield
        is available, otherwise a seeded simulation tied to the Inflation factor."""
        cfg = self.cfg
        i10 = cfg.yield_tenors.index(cfg.long_tenor)
        start = (self.grid.daily[0] - pd.DateOffset(years=2)).strftime("%Y-%m-%d")
        end = self.grid.daily[-1].strftime("%Y-%m-%d")
        if cfg.breakeven_10y_series_id:
            quoted = self._fetch_daily_matrix([cfg.breakeven_10y_series_id], start, end)
            if quoted is not None:
                return quoted[:, 0], "live"
        if cfg.real_yield_10y_series_id:
            real = self._fetch_daily_matrix([cfg.real_yield_10y_series_id], start, end)
            if real is not None:
                return self.YIELDS[:, i10] - real[:, 0], "live"
        # Own RNG stream, so adding this series leaves every other output unchanged.
        rng = np.random.default_rng([cfg.random_seed, 10])
        infl = self.FACTORS_SMOOTH[:, self.factor_names.index("Inflation")]
        infl = (infl - infl.mean()) / (infl.std() or 1.0)
        noise = np.zeros(self.T)
        for t in range(1, self.T):
            noise[t] = 0.97 * noise[t - 1] + rng.standard_normal() * 0.012
        return cfg.breakeven_mean + 0.12 * infl + noise, "simulation"

    def _indicator_table(self) -> dict:
        """Indicators grouped by catalogue heatmap_group with monthly z-scores."""
        X = self._indicator_monthly                     # [T_monthly, M]
        with warnings.catch_warnings():                 # all-NaN columns: series with no live data
            warnings.simplefilter("ignore", RuntimeWarning)
            mu = np.nanmean(X, axis=0)
            sd = np.nanstd(X, axis=0)
        sd = np.where(np.isnan(sd) | (sd < 1e-12), 1.0, sd)
        Z = (X - mu) / sd
        groups: dict[str, list[dict]] = {}
        for e in self._dfm_meta:
            m = e["dfm_col_index"]
            groups.setdefault(e.get("heatmap_group") or e["dfm_factor"], []).append({
                "id": e["id"],
                "name": e["name"],
                "units": e.get("units", ""),
                "factor": e["dfm_factor"],
                "zscores": [None if np.isnan(z) else round(float(z), 3) for z in Z[:, m]],
                "latest": (round(float(X[-1, m]), 4)
                           if self._indicator_raw and not np.isnan(X[-1, m]) else None),
                "last_obs": self._indicator_last_obs[m],
            })
        return {
            "months": [d.strftime("%Y-%m-%d") for d in self.grid.monthly],
            "raw_values": self._indicator_raw,
            "groups": [{"name": g, "indicators": rows} for g, rows in groups.items()],
        }

    def get_dashboard(self) -> dict:
        """Every section of the regional heatmap page in one payload."""
        from dataclasses import asdict

        import heatmap_analytics as ha

        cfg = self.cfg
        if getattr(self, "_dashboard", None) is not None:
            return self._dashboard

        dates = [d.strftime("%Y-%m-%d") for d in self.grid.daily]
        tenors = list(cfg.yield_tenors)
        short, long, ultra = cfg.short_tenor, cfg.long_tenor, cfg.ultra_tenor
        i_s, i_l = tenors.index(short), tenors.index(long)

        def leg(a: str, b: str) -> str:              # "2y", "10y" → "2s10s"
            return f"{a[:-1]}s{b[:-1]}s"

        # Macro fair value for every tenor: μ + L1·PC1_fitted + L2·PC2_fitted
        fair = (self._yield_means[None, :]
                + np.outer(self.PC1_REG["fitted"], self.PC_LOADINGS[0])
                + np.outer(self.PC2_REG["fitted"], self.PC_LOADINGS[1]))

        curve = [ha.curve_regime_section(dates, self.YIELDS[:, i_l], self.YIELDS[:, i_s], leg(short, long))]
        if ultra:
            curve.append(ha.curve_regime_section(dates, self.YIELDS[:, tenors.index(ultra)],
                                                 self.YIELDS[:, i_s], leg(short, ultra)))
        if cfg.breakeven:
            be, be_source = self._breakeven_10y()
            breakeven = ha.breakeven_section(dates, self.YIELDS[:, i_l], be, be_source)
        else:
            breakeven, be_source = None, "none"
        outrights = tuple(t for t in (short, "5y", long, ultra) if t)
        spreads = ((short, long),) + (((("5y", ultra),) if ultra else ()))

        regressions = asdict(self.get_pc_regressions())
        regressions["pc1"]["fitted"] = self.PC1_REG["fitted"].round(4).tolist()
        regressions["pc2"]["fitted"] = self.PC2_REG["fitted"].round(4).tolist()

        self._dashboard = {
            "display_name": cfg.display_name,
            "bond_name": cfg.bond_name,
            "curve_instrument": cfg.curve_instrument,
            "bloc": cfg.bloc,
            "tenors": tenors,
            "fv_tenor": long,
            "period": {"start": dates[0], "end": dates[-1]},
            "data_source": {"macro": self.macro_source, "yields": self.yield_source, "breakeven": be_source,
                            "missing_series": self.missing_series},
            "factors": {
                **asdict(self.get_daily_factors()),
                "summary": {name: ha.factor_summary(self.FACTORS_SMOOTH[:, k])
                            for k, name in enumerate(self.factor_names)},
            },
            "yield_pca": asdict(self.get_yield_pca()),
            "regressions": regressions,
            "fair_value": {
                **asdict(self.get_fair_value()),
                "curve_table": ha.curve_fair_value_table(tenors, self.YIELDS, fair, outrights, spreads),
            },
            "curve_regimes": curve,
            "breakeven": breakeven,
            "scenarios": ha.scenario_section(curve[0], breakeven),
            "indicators": self._indicator_table(),
        }
        return self._dashboard
