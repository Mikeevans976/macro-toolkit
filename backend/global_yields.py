"""
Global yield factor model — PCA on 10y government bond yields.

Factor interpretation (sign-corrected):
  PC1 — Global   (all countries move together, ~level)
  PC2 — DM       (DM-specific divergence from global)
  PC3 — EM       (EM-idiosyncratic)

Per-country model:
  yield_i ≈ mean_i + (Z_hat_i × std_i)
  where Z_hat = scores @ loadings  [3-PC approximation]

Residual (rich/cheap): actual_i − fitted_i, in bps.
Z-Score: (current residual − 1y mean residual) / 1y std residual

Data pipeline
-------------
Live data is fetched via BloombergFetcher when xbbg is installed and a
Bloomberg Terminal is running.  Falls back to _simulate_yields() automatically
on any import or fetch failure — no code changes required to switch modes.

All 24 series are catalogued in backend/data/series_catalogue.json under
tools: ["global_yields"].  The COUNTRY_SERIES map below links each country
in ALL_COUNTRIES to its catalogue series_id.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

# ---------------------------------------------------------------------------
# Country universe
# ---------------------------------------------------------------------------

DM_COUNTRIES: list[str] = [
    "US", "UK", "Canada", "Japan", "Australia", "Switzerland",
    "Germany", "France", "Austria", "Netherlands", "Belgium",
    "Italy", "Greece", "Ireland", "Portugal", "Spain",
]
EM_COUNTRIES: list[str] = [
    "Brazil", "Mexico", "India", "South Korea",
    "Indonesia", "South Africa", "Poland", "Czech Republic",
]
ALL_COUNTRIES: list[str] = DM_COUNTRIES + EM_COUNTRIES
N_DM = len(DM_COUNTRIES)
N_EM = len(EM_COUNTRIES)
N = len(ALL_COUNTRIES)          # 24

# Countries highlighted in the residuals chart
CHART_COUNTRIES = ["US", "Japan", "UK", "Germany", "France"]

# ---------------------------------------------------------------------------
# Date grid
# ---------------------------------------------------------------------------

DAILY_DATES: pd.DatetimeIndex = pd.bdate_range("2022-01-03", "2025-06-27")
T = len(DAILY_DATES)

# ---------------------------------------------------------------------------
# Approximate long-run yield means (%)
# ---------------------------------------------------------------------------

_MEANS = np.array([
    # DM
    3.80,   # US
    3.70,   # UK
    3.40,   # Canada
    0.60,   # Japan
    3.90,   # Australia
    0.50,   # Switzerland
    2.20,   # Germany
    2.60,   # France
    2.70,   # Austria
    2.45,   # Netherlands
    2.65,   # Belgium
    3.50,   # Italy
    3.40,   # Greece
    2.55,   # Ireland
    2.95,   # Portugal
    2.90,   # Spain
    # EM
    12.80,  # Brazil
    9.40,   # Mexico
    7.20,   # India
    3.30,   # South Korea
    7.10,   # Indonesia
    10.50,  # South Africa
    5.50,   # Poland
    4.20,   # Czech Republic
], dtype=float)

# ---------------------------------------------------------------------------
# Simulation
# ---------------------------------------------------------------------------

def _simulate_yields(rng: np.random.Generator) -> np.ndarray:
    """
    Simulate [T, N] daily 10y bond yields using a 3-factor structure.

    The global factor embeds a realistic rate-hike cycle:
      2022: rapid rise (Fed/ECB hiking)
      2022–2023: plateau at elevated levels
      2023–2024: mild decline
      2024–2025: gradual normalisation
    """
    ar = np.array([0.997, 0.995, 0.993])
    innov_std = np.array([0.020, 0.012, 0.016])

    factors = np.zeros((T, 3))
    for t in range(1, T):
        shock = rng.standard_normal(3) * innov_std * np.sqrt(1 - ar ** 2)
        factors[t] = ar * factors[t - 1] + shock

    # Macro drift for global factor (rate-cycle shape)
    trend = np.zeros(T)
    for t in range(T):
        frac = t / T
        if frac < 0.30:                              # Jan 2022 – Oct 2022: fast rise
            trend[t] = frac / 0.30 * 2.0
        elif frac < 0.55:                            # Nov 2022 – mid 2023: plateau
            trend[t] = 2.0
        elif frac < 0.75:                            # mid 2023 – early 2024: decline
            trend[t] = 2.0 - (frac - 0.55) / 0.20 * 0.5
        else:                                        # 2024–2025: gradual descent
            trend[t] = 1.5 - (frac - 0.75) / 0.25 * 0.3
    factors[:, 0] += trend

    # DM factor: peaks around mid-2023, then fades
    dm_trend = np.zeros(T)
    for t in range(T):
        frac = t / T
        if frac < 0.35:
            dm_trend[t] = frac / 0.35 * 0.8
        elif frac < 0.60:
            dm_trend[t] = 0.8 - (frac - 0.35) / 0.25 * 0.4
        else:
            dm_trend[t] = 0.4 - (frac - 0.60) / 0.40 * 0.3
    factors[:, 1] += dm_trend

    # EM factor: mild cyclical swing
    factors[:, 2] += np.sin(np.linspace(0, 2 * np.pi, T)) * 0.3

    # Country loadings on [Global, DM, EM]
    loadings = np.array([
        # DM
        [0.85, 0.60, 0.05],   # US
        [0.80, 0.55, 0.04],   # UK
        [0.82, 0.58, 0.04],   # Canada
        [0.32, 0.16, 0.02],   # Japan       (BoJ yield control → low sensitivity)
        [0.80, 0.52, 0.05],   # Australia
        [0.28, 0.16, 0.02],   # Switzerland (safe-haven, low sensitivity)
        [0.75, 0.50, 0.03],   # Germany
        [0.76, 0.50, 0.03],   # France
        [0.76, 0.50, 0.03],   # Austria
        [0.75, 0.50, 0.03],   # Netherlands
        [0.76, 0.50, 0.03],   # Belgium
        [0.72, 0.42, 0.06],   # Italy      (spread-sensitive)
        [0.70, 0.40, 0.07],   # Greece     (spread-sensitive)
        [0.74, 0.48, 0.03],   # Ireland
        [0.73, 0.45, 0.05],   # Portugal
        [0.74, 0.46, 0.04],   # Spain
        # EM
        [0.80, 0.05, 0.75],   # Brazil
        [0.78, 0.05, 0.70],   # Mexico
        [0.70, 0.04, 0.65],   # India
        [0.72, 0.25, 0.45],   # South Korea (quasi-DM)
        [0.72, 0.03, 0.68],   # Indonesia
        [0.78, 0.04, 0.72],   # South Africa
        [0.74, 0.18, 0.58],   # Poland     (EU EM)
        [0.73, 0.20, 0.55],   # Czech Republic (EU EM)
    ], dtype=float)

    # Country-specific persistent AR(1) idiosyncratic component.
    # Using AR(0.992) with innovation std ~4-8bp/day gives unconditional std
    # of ~25-55bp — realistic rich/cheap magnitudes after removing factors.
    # Persistent country-specific idiosyncratic component (AR 0.992).
    # innov_idio IS the unconditional std (the sqrt(1-ar^2) scaling below
    # converts it to the correct daily innovation std).
    ar_idio = 0.992
    innov_idio = np.concatenate([
        np.full(N_DM, 0.22),    # DM: ~22bp unconditional std → ~±50bp range
        np.full(N_EM, 0.42),    # EM: ~42bp unconditional std → ~±90bp range
    ])
    idio = np.zeros((T, N))
    for t in range(1, T):
        shock = rng.standard_normal(N) * innov_idio * np.sqrt(1 - ar_idio ** 2)
        idio[t] = ar_idio * idio[t - 1] + shock

    yields = (
        _MEANS[None, :]
        + factors @ loadings.T
        + idio
    )
    return np.maximum(yields, 0.01)


# ---------------------------------------------------------------------------
# PCA
# ---------------------------------------------------------------------------

def _run_pca(yields: np.ndarray, n_components: int = 3) -> tuple:
    """
    Standardised PCA on the yield panel.

    Returns
    -------
    scores        : [T, K]    PC factor scores
    loadings      : [K, N]    PC loadings (rows = PCs)
    explained_var : [K]       fraction of variance explained
    means         : [N]       cross-sectional yield means
    stds          : [N]       cross-sectional yield stds
    fitted        : [T, N]    3-PC model reconstruction (%)
    residuals     : [T, N]    actual − fitted (bps)
    """
    means = yields.mean(axis=0)
    stds = yields.std(axis=0, ddof=1)
    stds = np.where(stds < 1e-10, 1.0, stds)
    Z = (yields - means) / stds    # [T, N]

    cov = Z.T @ Z / (T - 1)
    eigenvalues, eigenvectors = np.linalg.eigh(cov)
    idx = np.argsort(eigenvalues)[::-1]
    eigenvalues = eigenvalues[idx]
    eigenvectors = eigenvectors[:, idx]          # [N, N]
    loadings = eigenvectors[:, :n_components].T  # [K, N]

    # Sign conventions
    # PC1 (Global): avg DM loading positive → high score = high yields globally
    if loadings[0, :N_DM].mean() < 0:
        loadings[0] *= -1
    # PC2 (DM): DM avg loading > EM avg loading
    if loadings[1, :N_DM].mean() < loadings[1, N_DM:].mean():
        loadings[1] *= -1
    # PC3 (EM): EM avg loading > DM avg loading
    if loadings[2, N_DM:].mean() < loadings[2, :N_DM].mean():
        loadings[2] *= -1

    scores = Z @ loadings.T             # [T, K]
    Z_hat = scores @ loadings           # [T, N]  3-PC reconstruction
    fitted = means + Z_hat * stds       # back to yield space (%)
    residuals = (yields - fitted) * 100  # bps

    explained_var = eigenvalues[:n_components] / eigenvalues.sum()
    return scores, loadings, explained_var, means, stds, fitted, residuals


# ---------------------------------------------------------------------------
# Country → catalogue series_id mapping
# Order must match ALL_COUNTRIES exactly.
# ---------------------------------------------------------------------------

COUNTRY_SERIES: dict[str, str] = {
    # DM
    "US":             "gov10y_us",
    "UK":             "gov10y_uk",
    "Canada":         "gov10y_canada",
    "Japan":          "gov10y_japan",
    "Australia":      "gov10y_australia",
    "Switzerland":    "gov10y_switzerland",
    "Germany":        "bund_10y",
    "France":         "gov10y_france",
    "Austria":        "gov10y_austria",
    "Netherlands":    "gov10y_netherlands",
    "Belgium":        "gov10y_belgium",
    "Italy":          "gov10y_italy",
    "Greece":         "gov10y_greece",
    "Ireland":        "gov10y_ireland",
    "Portugal":       "gov10y_portugal",
    "Spain":          "gov10y_spain",
    # EM
    "Brazil":         "gov10y_brazil",
    "Mexico":         "gov10y_mexico",
    "India":          "gov10y_india",
    "South Korea":    "gov10y_south_korea",
    "Indonesia":      "gov10y_indonesia",
    "South Africa":   "gov10y_south_africa",
    "Poland":         "gov10y_poland",
    "Czech Republic": "gov10y_czech",
}

_SERIES_IDS = [COUNTRY_SERIES[c] for c in ALL_COUNTRIES]


# ---------------------------------------------------------------------------
# Live data fetch + matrix builder
# ---------------------------------------------------------------------------

def _fetch_yields(start: str, end: str) -> np.ndarray | None:
    """
    Fetch live 10y yields from Bloomberg and return a [T, N] daily matrix
    aligned to DAILY_DATES and ALL_COUNTRIES.

    Returns None on any failure (missing xbbg, Terminal not running, etc.)
    so the caller can fall back to simulation.
    """
    try:
        from data_fetcher import get_fetcher  # noqa: PLC0415
    except ImportError:
        warnings.warn("global_yields: data_fetcher not importable — using simulation.")
        return None

    try:
        fetcher = get_fetcher("bloomberg")
        raw: dict[str, pd.Series] = fetcher.fetch(
            series_ids=_SERIES_IDS,
            start=start,
            end=end,
        )
    except Exception as exc:
        warnings.warn(f"global_yields: Bloomberg fetch failed ({exc}) — using simulation.")
        return None

    if not raw:
        warnings.warn("global_yields: Bloomberg returned no data — using simulation.")
        return None

    # Align each series to DAILY_DATES; forward-fill up to 5 business days
    # to handle holiday gaps; countries with no data default to their long-run mean.
    matrix = np.full((len(DAILY_DATES), N), np.nan)
    date_index = pd.DatetimeIndex(DAILY_DATES)

    for col, country in enumerate(ALL_COUNTRIES):
        sid = COUNTRY_SERIES[country]
        series = raw.get(sid)
        if series is None or series.empty:
            warnings.warn(f"global_yields: no data for {country} ({sid}) — using mean fill.")
            matrix[:, col] = _MEANS[col]
            continue

        # Reindex to our date grid, forward-fill gaps up to 5 days
        aligned = (
            series
            .reindex(date_index, method="ffill", limit=5)
        )
        matrix[:, col] = aligned.values

    # For any remaining NaNs (e.g. series starts late) fill with long-run mean
    for col in range(N):
        mask = np.isnan(matrix[:, col])
        if mask.any():
            matrix[mask, col] = _MEANS[col]

    return matrix


# ---------------------------------------------------------------------------
# Run model at module import
# ---------------------------------------------------------------------------

_START = DAILY_DATES[0].strftime("%Y-%m-%d")
_END   = DAILY_DATES[-1].strftime("%Y-%m-%d")

_live = _fetch_yields(_START, _END)

if _live is not None:
    YIELDS = _live
    _source = "bloomberg"
else:
    _rng = np.random.default_rng(20240101)
    YIELDS = _simulate_yields(_rng)
    _source = "simulation"

(PC_SCORES, PC_LOADINGS, PC_EXPLAINED_VAR,
 YIELD_MEANS, YIELD_STDS, FITTED_YIELDS, RESIDUALS_BPS) = _run_pca(YIELDS)


# ---------------------------------------------------------------------------
# Summary table
# ---------------------------------------------------------------------------

def _build_table() -> list[dict]:
    """
    For each country, compute statistics of the intrinsic residual
    (Actual − Model, in bps) over a 1-year lookback (~252 business days).

    Columns
    -------
    actual   : current 10y yield (%)
    model    : current 3-PC model fair value (%)
    last     : residual at the last observation = actual − model (bps)
    avg      : 1y mean of the residual series (bps)
    stdev    : 1y standard deviation of the residual series (bps)
    z_score  : (last − avg) / stdev  [standardised richness/cheapness]
    """
    LOOKBACK = 252   # ~1 year of business days
    rows = []
    for i, country in enumerate(ALL_COUNTRIES):
        actual  = float(YIELDS[-1, i])
        model   = float(FITTED_YIELDS[-1, i])
        resid   = RESIDUALS_BPS[:, i]
        window  = resid[-LOOKBACK:]
        last    = float(resid[-1])
        avg     = float(window.mean())
        stdev   = float(window.std(ddof=1))
        z_score = (last - avg) / (stdev + 1e-8)
        rows.append(dict(
            country=country,
            is_dm=(i < N_DM),
            actual=round(actual, 2),
            model=round(model, 2),
            last=round(last, 1),
            avg=round(avg, 1),
            stdev=round(stdev, 1),
            z_score=round(z_score, 2),
        ))
    return rows


# ---------------------------------------------------------------------------
# Single combined API response
# ---------------------------------------------------------------------------

def get_global_yields_data() -> dict:
    """Return all data needed by the frontend in a single call."""
    dates = [d.strftime("%Y-%m-%d") for d in DAILY_DATES]

    factors = {
        "Global": PC_SCORES[:, 0].round(4).tolist(),
        "DM":     PC_SCORES[:, 1].round(4).tolist(),
        "EM":     PC_SCORES[:, 2].round(4).tolist(),
    }
    explained_var = {
        "Global": round(float(PC_EXPLAINED_VAR[0]), 4),
        "DM":     round(float(PC_EXPLAINED_VAR[1]), 4),
        "EM":     round(float(PC_EXPLAINED_VAR[2]), 4),
    }

    residuals: dict[str, list[float]] = {}
    for country in CHART_COUNTRIES:
        i = ALL_COUNTRIES.index(country)
        residuals[country] = RESIDUALS_BPS[:, i].round(2).tolist()

    return dict(
        dates=dates,
        factors=factors,
        explained_var=explained_var,
        residuals=residuals,
        table=_build_table(),
        data_source=_source,   # "bloomberg" | "simulation"
    )