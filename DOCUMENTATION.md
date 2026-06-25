# Analytics Hub — Technical Documentation

**Last updated:** June 2026  
**Stack:** Python 3.12 · FastAPI · React 18 · TypeScript · NumPy / Pandas / SciPy

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Repository Layout](#2-repository-layout)
3. [Architecture](#3-architecture)
4. [Authentication](#4-authentication)
5. [Data Infrastructure](#5-data-infrastructure)
   - 5.1 [Series Catalogue](#51-series-catalogue)
   - 5.2 [Data Fetcher](#52-data-fetcher)
   - 5.3 [Macro Data Loader](#53-macro-data-loader)
6. [Tools — Backend](#6-tools--backend)
   - 6.1 [Euro Area Heatmap](#61-euro-area-heatmap)
   - 6.2 [Global Yields Factor Model](#62-global-yields-factor-model)
   - 6.3 [Fair Value Models (HICPxT)](#63-fair-value-models-hicpxt)
   - 6.4 [Swaps RV Monitor](#64-swaps-rv-monitor)
   - 6.5 [Option-Implied CDF](#65-option-implied-cdf)
7. [Mathematical Foundations](#7-mathematical-foundations)
   - 7.1 [Mixed-Frequency Dynamic Factor Model](#71-mixed-frequency-dynamic-factor-model)
   - 7.2 [Kalman Filter and RTS Smoother](#72-kalman-filter-and-rts-smoother)
   - 7.3 [PCA Initialisation and Hungarian Assignment](#73-pca-initialisation-and-hungarian-assignment)
   - 7.4 [Par Curve Bootstrap](#74-par-curve-bootstrap)
   - 7.5 [Elastic Net Fair Value](#75-elastic-net-fair-value)
   - 7.6 [Gram-Charlier Option CDF](#76-gram-charlier-option-cdf)
8. [API Reference](#8-api-reference)
9. [Frontend](#9-frontend)
10. [Dashboard Configuration](#10-dashboard-configuration)
11. [Running Locally](#11-running-locally)
12. [Extending the Hub](#12-extending-the-hub)

---

## 1. Project Overview

The Analytics Hub is a private, authentication-gated web application for quantitative macro and rates analysis. It exposes a set of quantitative tools as interactive dashboards, each backed by a Python computation module served via FastAPI and rendered by a React frontend.

**Live tools:**

| Tool | Category | Backend module |
|---|---|---|
| Euro Area Heatmap | Macro Fundamentals | `euro_area_heatmap.py` |
| Global Yields Factor Model | Macro Fundamentals | `global_yields.py` |
| Option-Implied Macro Scenarios | Macro Fundamentals | *(frontend-only, no API call)* |
| Fair Value Models (HICPxT) | Inflation Markets | `fair_value_models.py` |
| Swap RV Monitor | Futures / Swaps / Vol | `swaps_rv.py` |

**Placeholder categories** (no tools yet): Supply, Funding, Backtesters, Global.

---

## 2. Repository Layout

```
Team-Massimo-Marzeglia-Analytics/
│
├── backend/
│   ├── main.py                    # FastAPI app, all route definitions
│   ├── auth.py                    # JWT authentication, user store
│   ├── create_user.py             # CLI to create users
│   │
│   ├── euro_area_heatmap.py       # Tool: Euro Area Heatmap
│   ├── dfm.py                     # Shared: Kalman filter / RTS smoother
│   ├── macro_data_loader.py       # Shared: macro obs matrix builder
│   ├── data_fetcher.py            # Shared: Bloomberg / Haver connector
│   │
│   ├── global_yields.py           # Tool: Global Yields Factor Model
│   ├── fair_value_models.py       # Tool: HICPxT Fair Value Models
│   ├── swaps_rv.py                # Tool: Swap RV Monitor
│   ├── curves_flies_config.py     # Config: forward curve / fly definitions
│   │
│   ├── data/
│   │   └── series_catalogue.json  # Master series registry (single source of truth)
│   │
│   ├── scripts/                   # Simulation / validation scripts
│   └── tests/                     # Unit and validation tests
│
├── frontend/
│   └── src/
│       ├── App.tsx                # React router, protected routes
│       ├── components/
│       │   ├── Dashboard.tsx      # Landing page / tool grid
│       │   └── Login.tsx          # Auth form
│       └── pages/
│           ├── EuroAreaHeatmap.tsx
│           ├── GlobalYields.tsx
│           ├── FairValueModels.tsx
│           ├── OptionDerivedCDF.tsx
│           └── SwapsRV.tsx        (existing tool)
│
├── dashboard_config.yaml          # Category and tool registry
└── DOCUMENTATION.md               # This file
```

---

## 3. Architecture

```
Browser
  │  JWT in Authorization header
  ▼
FastAPI (main.py)
  │  OAuth2 + bcrypt auth (auth.py)
  │
  ├─► /api/dashboard              → dashboard_config.yaml
  │
  ├─► /api/tools/euro-area-heatmap/*
  │       └─ euro_area_heatmap.py
  │             ├─ data_fetcher.py  ←── Bloomberg / Haver
  │             ├─ macro_data_loader.py
  │             └─ dfm.py
  │
  ├─► /api/tools/global-yields    → global_yields.py
  ├─► /api/tools/fair-value-models → fair_value_models.py
  ├─► /api/tools/swaps-rv         → swaps_rv.py
  │
  └─► /* (static)                 → frontend/dist/ (React build)
```

All computation modules run their heavy work **at import time** (module-level), then expose lightweight getter functions that the API routes call. This means the FastAPI process does all heavy lifting at startup; API responses are fast serialisations of already-computed arrays.

---

## 4. Authentication

**File:** `backend/auth.py`

- OAuth2 Password Flow via FastAPI's `OAuth2PasswordBearer`.
- Passwords hashed with `bcrypt`.
- Sessions issued as HS256 JWT tokens, expiry configured via `ACCESS_TOKEN_EXPIRE_HOURS`.
- User store is a plain Python dict in `auth.py` (suitable for a small, private deployment; replace with a database for multi-user scale).
- All `/api/tools/*` and `/api/me` routes require a valid Bearer token via the `get_current_user` dependency.

**Creating a user:**
```bash
cd backend
python create_user.py
```

**Login flow:**
```
POST /api/auth/login
  form: username, password
  → { access_token, token_type: "bearer" }

GET /api/me
  Authorization: Bearer <token>
  → { username, full_name }
```

---

## 5. Data Infrastructure

### 5.1 Series Catalogue

**File:** `backend/data/series_catalogue.json`

The single source of truth for all time series used across the hub. No CSV files or per-tool hardcoded ticker lists exist — everything is resolved through this catalogue.

**Top-level structure:**
```json
{
  "_meta": { "description": "...", "field_reference": { ... } },
  "series": [ { ... }, { ... } ]
}
```

**Key fields per entry:**

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique slug, used as the cross-reference key everywhere |
| `name` | string | Human-readable display name |
| `description` | string | Full description including release notes |
| `source` | string | `"bloomberg"`, `"haver"`, `"ecb"`, `"eurostat"`, `"derived"` |
| `ticker_bloomberg` | string\|null | Bloomberg ticker (e.g. `"EUSA2 Curncy"`) |
| `ticker_haver` | string\|null | Haver mnemonic (e.g. `"CPIEZXFE@EUDATA"`) |
| `frequency` | string | `"daily"`, `"monthly"`, `"quarterly"` |
| `units` | string | `"pct"`, `"yoy_pct"`, `"index"`, `"bps"`, etc. |
| `typical_lag_days` | int\|null | Calendar days from period-end to typical release |
| `asset_class` | string | `"rates_govts"`, `"macro_inflation"`, `"inflation_swaps"`, etc. |
| `geography` | string | `"euro_area"`, `"us"`, `"global"`, etc. |
| `tools` | list[string] | Which hub tools use this series |
| `role` | string | `"factor_input"`, `"target"`, `"predictor"`, `"market_data"` |
| `dfm_col_index` | int\|null | Column position in the DFM Y_daily matrix (DFM series only) |
| `dfm_factor` | string\|null | Named factor this series loads on (`"Growth"`, `"Inflation"`, etc.) |
| `dfm_sign` | int\|null | `+1` or `-1` sign convention for the DFM factor |
| `dfm_primary` | bool\|null | True for the one series that anchors sign-normalisation per factor |
| `internal_key` | string\|null | Internal variable name in backend code |
| `notes` | string\|null | Free-text caveats |

**Derived series** (`source: "derived"`) have `ticker_bloomberg: null` and `ticker_haver: null`. The data fetcher skips them automatically; they are constructed in-house from pulled par tenors. Examples: all `estr_fwd_*` and `hicp_swap_*y*y` entries.

**Data sourcing philosophy for rates/yields:**
- Only **par tenor rates** are pulled from Bloomberg or Haver.
  - EUR ESTR IRS: `eur_swap_{1y..30y}` — full set of tenors matching `_SWAP_TENORS` in `swaps_rv.py`.
  - HICPxT ZC inflation swaps: `hicp_swap_{1y..30y}`.
- All **forwards, curves, and flies** are constructed in-house via cubic spline interpolation of the par curve (same methodology as `swaps_rv.py`). This ensures internal consistency and avoids relying on cross-vendor forward rate availability.

### 5.2 Data Fetcher

**File:** `backend/data_fetcher.py`

Provides a unified interface for pulling time series data from Bloomberg or Haver, resolving series IDs through the catalogue.

**Usage:**
```python
from data_fetcher import get_fetcher

fetcher = get_fetcher("bloomberg")          # or "haver", path="/mnt/haver"
data = fetcher.fetch(
    series_ids=["ea_composite_pmi", "eur_swap_2y"],
    start="2020-01-01",
    end="2025-12-31",
)
# Returns dict[series_id, pd.Series]
```

**Output format:**
- `"daily"` series → `DatetimeIndex`
- `"monthly"` series → `PeriodIndex("M")` — resampled from raw daily data via `.resample("ME").last()`
- `"quarterly"` series → `PeriodIndex("Q")` — via `.resample("QE").last()`

Monthly/quarterly PeriodIndex output is consumed directly by `load_macro_data()`, which then estimates release dates from `typical_lag_days`.

**Catalogue resolver (`_CatalogueResolver`):**
- Loads `series_catalogue.json` once at module level.
- `resolve(series_ids, source)` returns `(ticker_map, freq_map, skipped)`.
- Derived series (no ticker) are silently dropped from `ticker_map` and added to `skipped`.

**Bloomberg backend (`BloombergFetcher`):**
- Requires `pip install xbbg` and a running Bloomberg Terminal.
- Calls `blp.bdh(tickers, flds=["PX_LAST"], start_date, end_date)`.
- Default field is `PX_LAST`; override with `get_fetcher("bloomberg", fld="LAST_PRICE")`.

**Haver backend (`HaverFetcher`):**
- Requires `pip install Haver` and Haver DLX installed.
- Haver mnemonics in the catalogue use `"SERIES@DATABASE"` format (e.g. `"CPIEZXFE@EUDATA"`).
- Database path set via `get_fetcher("haver", path="/...")` or `HAVER_PATH` environment variable.

**Dependencies are optional** — an `ImportError` with a clear message is raised if `xbbg` or `Haver` is not installed.

### 5.3 Macro Data Loader

**File:** `backend/macro_data_loader.py`

Converts a `dict[series_id, pd.Series]` of macro observations into the daily observation matrix `Y_daily[T, M]` consumed by the Kalman filter.

**Key function:**
```python
macro_data = load_macro_data(
    daily_dates: pd.DatetimeIndex,   # business-day grid
    m_macro: int,                    # number of DFM series
    data: dict[str, pd.Series] | None,
) -> MacroData
```

**Series metadata** is loaded from `series_catalogue.json` (not from any CSV). Entries with `dfm_col_index` defined are the DFM inputs, sorted by that index. Required catalogue fields per entry: `id`, `name`, `dfm_factor`, `dfm_sign`, `frequency`, `typical_lag_days`.

**Release date estimation:**
- If the Series has a `PeriodIndex` → `release_date = period_end + typical_lag_days` (calendar days), snapped to the next business day on the daily grid via `np.searchsorted`.
- If the Series has a `DatetimeIndex` → dates used directly as release dates (forward-compatible path for when actual release calendars become available).

**Collision handling:** If two observations for the same series map to the same business day, the one with the later reference period is kept.

**Output (`MacroData` dataclass):**
```python
@dataclass
class MacroData:
    Y_daily: np.ndarray              # [T_DAILY, M_MACRO] — NaN except on release dates
    series_ids: list[str]            # in col_index order
    series_names: list[str]
    factor_assignments: list[str]    # dfm_factor per series
    primary_series_signs: list[int]  # dfm_sign per series
    has_data: bool
    n_obs_per_series: dict[str, int]
    warnings: list[str]
```

If `data=None` or no usable records are found, `has_data=False` is returned and the heatmap falls back to simulation.

---

## 6. Tools — Backend

### 6.1 Euro Area Heatmap

**File:** `backend/euro_area_heatmap.py`  
**API routes:** `/api/tools/euro-area-heatmap/{factors,yield-pca,pc-regressions,fair-value}`

A two-block model linking Euro Area macro conditions to the Bund yield curve.

#### Data source configuration

Controlled by the `ANALYTICS_DATA_SOURCE` environment variable:

| Value | Behaviour |
|---|---|
| `"bloomberg"` | Fetch via Bloomberg Terminal (`xbbg`) |
| `"haver"` | Fetch via Haver DLX (`Haver` package + `HAVER_PATH`) |
| `"csv"` | *(default)* Read from `data/macro_releases.csv` |
| `"simulation"` | Skip data loading; use fully synthetic factors |

Fallback chain: **live fetcher → simulation** (on any fetcher error, falls back gracefully).

Fetch window: 2 years before the grid start to the grid end, to ensure quarterly series have enough history.

#### DFM series (Block 1 inputs)

The 8 macro series, in `dfm_col_index` order, all defined in `series_catalogue.json`:

| col | Series ID | Factor | Sign | Lag (days) | Freq |
|---|---|---|---|---|---|
| 0 | `ea_composite_pmi` | Growth | +1 | 23 | monthly |
| 1 | `ea_core_hicp_yoy` | Inflation | +1 | 30 | monthly |
| 2 | `ea_unemployment_rate` | Employment | −1 | 30 | monthly |
| 3 | `ea_negotiated_wages_yoy` | Wages | +1 | 50 | quarterly |
| 4 | `ea_industrial_production_yoy` | Growth | +1 | 45 | monthly |
| 5 | `ea_services_pmi` | Growth | +1 | 23 | monthly |
| 6 | `ea_ces_inflation_exp_1y` | Inflation | +1 | 40 | monthly |
| 7 | `ea_job_vacancy_rate` | Employment | +1 | 70 | quarterly |

Series metadata (`_MACRO_SERIES_IDS`, `MACRO_INDICATOR_NAMES`, `M_MACRO`, `_FACTOR_PRIMARY_COL`, `_FACTOR_PRIMARY_SIGN`) are derived at import time from the catalogue — no hardcoding in the Python file.

#### Block 1 — Macro DFM

**Real data path** (`_build_macro_dfm_from_data`):

1. **Forward-fill** `Y_daily` (LOCF) to produce a complete matrix for PCA initialisation.
2. **Standardise** columns using `nanmean` / `nanstd` of actual observations only.
3. **PCA** via `np.linalg.eigh` on the sample covariance matrix → K=4 leading components.
4. **Hungarian assignment** (`scipy.optimize.linear_sum_assignment`) maps PCA components to named factors (Growth, Inflation, Employment, Wages) by maximising absolute loading on each factor's primary series (`dfm_primary=True` in catalogue).
5. **Sign normalisation**: for each factor k, if `loading[k, primary_col] × primary_sign < 0`, flip the component sign.
6. **Un-standardise loadings**: `Λ[m,k] = loading_standardised[k,m] × col_std[m]` to recover original-unit loadings.
7. **AR(1) transition** estimated from PCA scores; state noise `Q = diag(var(residuals))`.
8. **Kalman filter + RTS smoother** on raw `Y_daily` (with NaNs), producing `FACTORS_SMOOTH[T, 4]`.

**Simulation fallback** (`_simulate_macro_block` + `_build_macro_dfm`): used when `has_data=False` or `ANALYTICS_DATA_SOURCE=simulation`. Generates synthetic AR(1) factors with prescribed loadings and runs the OLS-initialised Kalman path.

#### Block 2 — Yield PCA

Daily Bund yields for 8 tenors (2y, 3y, 5y, 7y, 10y, 15y, 20y, 30y) are decomposed via PCA (currently simulated from Block 1 factors until live yield data is wired).

- 3 principal components extracted.
- Sign conventions: PC1 positive at 10y (level), PC2 positive at 30y (slope), PC3 positive at 7y (curvature).
- PC1 and PC2 are regressed on `FACTORS_SMOOTH` (no intercept OLS) to link the yield curve to macro conditions.
- **10y Bund fair value** = `yield_mean_10y + PC1_fitted × PC1_loading_10y + PC2_fitted × PC2_loading_10y`.
- **Rich/cheap** = `(actual_10y − fair_value) × 100` in bps.

#### API responses

| Endpoint | Response |
|---|---|
| `/factors` | `dates`, `factors` dict (Growth / Inflation / Employment / Wages daily series) |
| `/yield-pca` | `dates`, `pc_scores`, `loadings`, `explained_var`, `tenor_names` |
| `/pc-regressions` | `factor_names`, `pc1` and `pc2` each with `beta`, `tstat`, `r2`, `adj_r2` |
| `/fair-value` | `dates`, `actual`, `pca_fitted`, `macro_fair_value`, `rich_cheap_bps` |

---

### 6.2 Global Yields Factor Model

**File:** `backend/global_yields.py`  
**API route:** `GET /api/tools/global-yields`

A 3-factor PCA model across a panel of 24 countries' 10-year government bond yields.

**Countries:**
- 16 DM: US, Germany, UK, Japan, France, Italy, Spain, Netherlands, Belgium, Austria, Switzerland, Sweden, Norway, Denmark, Canada, Australia
- 8 EM: Brazil, Mexico, India, Indonesia, South Africa, Turkey, Poland, Czech Republic

**Methodology:**
1. Simulate a realistic daily yield panel over 2022–2025 capturing the global rate-hiking cycle (currently synthetic; same data pipeline as heatmap will be applied here).
2. Run PCA on the cross-country covariance matrix → 3 factors (global level, DM/EM spread, EM idiosyncratic).
3. Compute per-country residuals from the 3-factor model.
4. Z-score residuals over a 1-year rolling window for rich/cheap assessment.

**Response structure:**
```json
{
  "factors": { "dates": [...], "PC1": [...], "PC2": [...], "PC3": [...] },
  "explained_variance": { "PC1": 0.72, "PC2": 0.14, "PC3": 0.06 },
  "table": [
    {
      "country": "Germany", "region": "DM",
      "actual": 2.44, "model": 2.38, "residual": 0.06,
      "zscore": 0.82, "significant": false
    }, ...
  ],
  "residuals": { "dates": [...], "Germany": [...], ... }
}
```

---

### 6.3 Fair Value Models (HICPxT)

**File:** `backend/fair_value_models.py`  
**API route:** `GET /api/tools/fair-value-models`

Rolling Elastic Net regression models for EUR HICPxT inflation swap rates and forward rates.

**Target variables** (7 models):
- Outright: 1y, 2y, 5y, 10y ZC HICPxT swaps
- Forwards: 1y1y, 2y1y, 5y5y HICPxT swap forwards

**Predictors** (currently simulated; wired to catalogue series once live):
- EUR ESTR IRS curve (level, slope via 2s5s, 2s10s, 5s10s)
- ESTR forward rates (1y1y, 2y3y, 5y5y, 10y10y)
- Brent crude (log)
- TTF natural gas (log)
- 1-month ESTR swaption implied vol (for long-end forward models only)

**Methodology:**
- Rolling Elastic Net (α=0.5, L1 ratio 0.5) with 2-year training window, refitted daily.
- Produces: fitted values, residuals, rolling R², rolling coefficients, ±1σ / ±2σ bands.
- Scatter analysis plots residual vs predictor for mean-reversion signals.

**Response includes:** per-model history of actuals, fitted values, residuals, sigma bands, coefficients, and R².

---

### 6.4 Swaps RV Monitor

**File:** `backend/swaps_rv.py`  
**Config:** `backend/curves_flies_config.py`  
**API route:** `GET /api/tools/swaps-rv?date=YYYY-MM-DD`

Relative value monitor for EUR ESTR IRS forward par rates and butterfly structures.

#### Par curve bootstrap

Given a row of par swap rates at `_SWAP_TENORS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30]` years:

1. **Cubic spline interpolation** (`CubicSpline`, not-a-knot) for integer years 1–30; flat extrapolation beyond 30y.
2. **Iterative discount factor bootstrap**:
   ```
   D[0] = 1
   D[n] = (1 − r_n × annuity_{n−1}) / (1 + r_n)
   ```
3. **Forward par rate** `f(s,t)` = par rate of a swap starting in `s` years, tenor `t`:
   ```
   f(s,t) = (D[s] − D[s+t]) / Σ_{k=1}^{t} D[s+k]  × 100
   ```
4. **1-year carry** = `f_now(s,t) − f_rolled(s−1,t)` in bps (receiver convention).

#### Curves and flies

Defined in `curves_flies_config.py`:
- **25 curves** (forward spreads): e.g. `"2y1y - 1y1y"`, `"5y5y - 2y3y"`, `"10y10y - 5y5y"`.
- **20 flies** (convexity structures): e.g. `"2×(2y3y) − 1y1y − 5y5y"`.

#### RV metrics (per structure, per date)

| Metric | Description |
|---|---|
| `level` | Current value in bps |
| `zscore_1y` | Z-score vs 1-year history |
| `pctile_1y` | Percentile in 1-year history |
| `vol_1y` | Annualised daily vol (bps) |
| `carry_bps` | 1-year carry for the structure |
| `carry_vol_ratio` | Carry / vol (Sharpe-like, carry-adjusted) |
| `beta` | Regression beta of structure on a vol factor |
| `beta_tstat` | t-statistic of that beta |

**Response:** snapshot date, `curves` and `flies` arrays each with the above metrics, plus 1y historical data for detail views.

---

### 6.5 Option-Implied CDF

**Frontend page:** `frontend/src/pages/OptionDerivedCDF.tsx`  
*(No backend API call — computed entirely in the browser)*

Constructs an option-implied probability distribution for a macro variable (e.g. 12-month EUR CPI) using the Gram-Charlier expansion, calibrated to user-specified ATM vol, skew, and excess kurtosis.

**Scenarios:**
- Hard Landing: CPI significantly undershoots
- Soft Landing: CPI moderately below target
- No Landing: CPI near target, rates stay higher
- Re-acceleration: CPI re-accelerates above target

Breakpoints between scenarios are set by the user via sliders; probabilities are read off the calibrated CDF at those breakpoints. A dual-horizon comparison view is also available.

---

## 7. Mathematical Foundations

### 7.1 Mixed-Frequency Dynamic Factor Model

The state space form operates at **daily frequency** throughout:

```
Transition:   f_t = A f_{t-1} + η_t,    η_t ~ N(0, Q)    [K × K]
Observation:  y_t = Λ f_t    + ε_t,    ε_t ~ N(0, R)    [M × K]
```

- **State** `f_t ∈ ℝ^K`: K=4 daily latent factors (Growth, Inflation, Employment, Wages).
- **Observations** `y_t ∈ ℝ^M`: M=8 macro series. `y_t` is NaN on all days except the estimated release date of each series. The Kalman filter handles this natively: when `y_t` is entirely NaN, the update step is skipped and the filter propagates on the transition equation alone.
- **Transition** `A = diag(ρ_1, ..., ρ_K)`: diagonal AR(1) matrix, one persistence coefficient per factor. Estimated from PCA scores via `ar[k] = (x[:-1] · x[1:]) / (x[:-1] · x[:-1])`, clipped to [0.5, 0.999].
- **Loadings** `Λ ∈ ℝ^{M×K}`: each macro series loads on all K factors, but primarily on one. Estimated via PCA initialisation (see §7.3).
- **State noise** `Q = diag(σ²_k (1 − ρ²_k))`: stationary variance of the AR(1) innovations.
- **Observation noise** `R = diag(σ²_ε1, ..., σ²_εM)`: residual variance from PCA fit.

Mixed frequency is handled implicitly: monthly series have exactly one non-NaN entry per month (at the estimated release date), quarterly series have one entry per quarter. The Kalman filter interpolates daily factor values between releases using the AR(1) transition dynamics.

### 7.2 Kalman Filter and RTS Smoother

**File:** `backend/dfm.py`

**Forward pass (Kalman filter):**

```
Prediction:
  f_{t|t-1} = A f_{t-1|t-1}
  P_{t|t-1} = A P_{t-1|t-1} A' + Q

Update (only where y_t is not NaN):
  S_t    = Λ_obs P_{t|t-1} Λ_obs' + R_obs
  K_t    = P_{t|t-1} Λ_obs' S_t⁻¹
  f_{t|t} = f_{t|t-1} + K_t (y_t_obs − Λ_obs f_{t|t-1})
  P_{t|t} = (I − K_t Λ_obs) P_{t|t-1}
```

where subscript `obs` denotes the rows corresponding to non-NaN observations at time t. When all observations are NaN: `f_{t|t} = f_{t|t-1}`, `P_{t|t} = P_{t|t-1}`.

The Gaussian log-likelihood is accumulated: `loglik += -½ (d log 2π + log|S_t| + v_t' S_t⁻¹ v_t)`.

**Backward pass (RTS smoother):**

```
G_t      = P_{t|t} A' P_{t+1|t}⁻¹           (smoother gain)
f_{t|T}  = f_{t|t} + G_t (f_{t+1|T} − f_{t+1|t})
P_{t|T}  = P_{t|t} + G_t (P_{t+1|T} − P_{t+1|t}) G_t'
```

Initialised from the terminal filtered state: `f_{T|T}`, `P_{T|T}`. The smoother uses all future information to revise past factor estimates — essential for a two-sided macro factor that should respond both to incoming and subsequently revised data.

Initial state: `f_0 = 0`, `P_0 = 10I` (diffuse prior).

### 7.3 PCA Initialisation and Hungarian Assignment

Before running the Kalman filter, factor loadings and initial AR coefficients are estimated from data:

1. **Forward-fill** Y_daily (last observation carried forward) to create a complete matrix — this removes NaNs while preserving the approximate level of each series between releases.
2. **Standardise** each column by its empirical mean and standard deviation computed over actual (non-NaN) observations only.
3. **PCA** on the standardised complete matrix: eigen-decompose the sample covariance matrix, take the top K eigenvectors.
4. **Hungarian algorithm** (`scipy.optimize.linear_sum_assignment`): form the K×K absolute-loading matrix `|loadings[:, primary_cols]|` where `primary_cols` is the catalogue-defined primary series for each factor. Solve the assignment problem to maximise total absolute loading — this bijects PCA components to named factors.
5. **Fallback**: if the best-matched loading for any factor is < 0.05 (near-zero), skip re-ordering and keep PCA components in variance-descending order.
6. **Sign normalisation**: for each factor k, if `loadings[k, primary_col] × primary_sign < 0`, multiply the component (scores and loadings) by −1. This ensures consistent directional interpretation (e.g. Growth ↑ = higher PMI, Employment ↑ = lower unemployment rate).
7. **Un-standardise loadings**: `Λ[m,k] = loading_standardised[k,m] × std[m]` to recover loadings in the original series' units.

### 7.4 Par Curve Bootstrap

Used in `swaps_rv.py` for EUR ESTR IRS; same methodology will be applied for HICPxT forwards.

Given par swap rates at integer tenors 1–30y (via cubic spline from `_SWAP_TENORS`):

```
D[0] = 1
annuity[0] = 0
For n = 1, 2, ..., 30:
    r_n = par_rate[n] / 100
    D[n] = (1 − r_n × annuity[n−1]) / (1 + r_n)
    annuity[n] = annuity[n−1] + D[n]
```

Forward par rate for a swap starting in `s` years with tenor `t`:
```
f(s,t) = (D[s] − D[s+t]) / Σ_{k=1}^{t} D[s+k]  × 100
```

1-year carry (receiver convention):
```
carry(s,t) = f(s, t) − f(s−1, t)   [in bps × 100]
```
Positive carry = the receiver gains as the forward rolls down a normal (upward-sloping) curve.

### 7.5 Elastic Net Fair Value

Models in `fair_value_models.py` fit:
```
y_t = β_0 + Σ_j β_j x_{j,t} + ε_t
```

where `y_t` is an HICPxT swap rate and `x_j` are the predictor set. Elastic Net regularisation:
```
min_β  ||y − Xβ||² + λ [α ||β||₁ + (1−α)/2 ||β||²]
```

with `α = 0.5` (equal L1/L2 mix). The regularisation path is refitted in a rolling window of 2 years. This avoids over-fitting to the predictor set and automatically performs variable selection — coefficients for predictors with little explanatory power are shrunk to zero.

### 7.6 Gram-Charlier Option CDF

The option-implied CDF tool uses the Gram-Charlier Type A expansion to construct a distribution with prescribed skewness `γ₁` and excess kurtosis `γ₂`:

```
f(x) = φ(x) [1 + (γ₁/6) H₃(x) + (γ₂/24) H₄(x)]
```

where φ(x) is the standard normal PDF and H₃, H₄ are Hermite polynomials. The corresponding CDF is obtained by integration. The ATM-implied vol is used as the distributional width, and skew/kurtosis are estimated from the options market or set manually.

Scenario probabilities are read off this CDF at user-specified breakpoints.

---

## 8. API Reference

All routes require `Authorization: Bearer <JWT>` except `/api/auth/login`.

### Auth

| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/login` | Exchange credentials for JWT |
| GET | `/api/me` | Current user info |

### Dashboard

| Method | Path | Description |
|---|---|---|
| GET | `/api/dashboard` | Full dashboard config from `dashboard_config.yaml` |

### Euro Area Heatmap

| Method | Path | Description |
|---|---|---|
| GET | `/api/tools/euro-area-heatmap/factors` | Daily factor time series (Growth, Inflation, Employment, Wages) |
| GET | `/api/tools/euro-area-heatmap/yield-pca` | Bund yield PC scores, loadings, explained variance |
| GET | `/api/tools/euro-area-heatmap/pc-regressions` | OLS regression of yield PCs on macro factors |
| GET | `/api/tools/euro-area-heatmap/fair-value` | 10y Bund: actual, PCA fit, macro FV, rich/cheap bps |

### Other Tools

| Method | Path | Description |
|---|---|---|
| GET | `/api/tools/global-yields` | Global 10y yield PCA: factors, table, residuals |
| GET | `/api/tools/fair-value-models` | HICPxT inflation swap fair value models |
| GET | `/api/tools/swaps-rv` | EUR ESTR IRS RV snapshot. Optional `?date=YYYY-MM-DD` |

---

## 9. Frontend

**Framework:** React 18 + TypeScript + Vite  
**Router:** React Router v6  
**Charting:** Recharts  
**Styling:** Tailwind CSS (dark theme throughout)

### Route structure

```
/                       → redirect to /dashboard
/login                  → Login.tsx
/dashboard              → Dashboard.tsx  (protected)
/tools/euro-area-heatmap → EuroAreaHeatmap.tsx  (protected)
/tools/global-yields     → GlobalYields.tsx  (protected)
/tools/fair-value-models → FairValueModels.tsx  (protected)
/tools/option-derived-cdf → OptionDerivedCDF.tsx  (protected)
/tools/swaps-rv          → SwapsRV.tsx  (protected)
```

Protected routes are wrapped in a `ProtectedRoute` HOC that reads the JWT from `localStorage` and redirects to `/login` if absent.

### Dashboard (`Dashboard.tsx`)

On mount, calls `GET /api/dashboard` and `GET /api/me`. Renders a grid of category cards, each containing links to the tools listed in `dashboard_config.yaml`. Categories with `tools: []` show the heading but no tool cards.

### Euro Area Heatmap (`EuroAreaHeatmap.tsx`)

The most complex frontend page (~2500 lines). Calls all four heatmap API endpoints in parallel, then renders:

- **Macro factor chart**: smoothed daily Growth / Inflation / Employment / Wages factors over the sample.
- **Yield PCA panel**: PC scores time series + loading bar charts + explained variance badges.
- **PC regression panel**: beta table and R² for PC1/PC2 on macro factors.
- **10y Bund fair value chart**: actual vs macro FV with rich/cheap shading.
- **Heatmap table**: colour-coded z-score table for ~100 macro indicators across 6 groups, updated monthly. Resizable indicator name column, hover tooltips, z-score legend.

---

## 10. Dashboard Configuration

**File:** `dashboard_config.yaml`

Controls the dashboard landing page entirely. Changes here take effect on the next API request — no server restart needed.

```yaml
categories:
  - id: macro-fundamentals
    name: Macro Fundamentals
    color: "#EF4444"
    tools:
      - id: euro-area-heatmap
        name: Euro Area Heatmap
        icon: "🇪🇺"
        url: /tools/euro-area-heatmap
```

To add a tool: add an entry under the relevant category's `tools` list, with a corresponding route in `App.tsx` and a page component in `frontend/src/pages/`.

To add a new category: add a new top-level entry in `categories`. If no tools exist yet, use `tools: []` — the heading will appear on the dashboard without cards.

---

## 11. Running Locally

**Prerequisites:** Python 3.12+, Node 20+, (optionally) Bloomberg Terminal or Haver DLX.

### Backend

```bash
cd backend
pip install -r requirements.txt

# Create a user
python create_user.py

# Run with simulated data (default)
python main.py

# Run with Bloomberg
ANALYTICS_DATA_SOURCE=bloomberg python main.py

# Run with Haver
ANALYTICS_DATA_SOURCE=haver HAVER_PATH=/path/to/haver python main.py
```

The API starts on `http://localhost:8000`.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

The dev server starts on `http://localhost:5173` with HMR. In development the Vite config should proxy `/api/*` to `http://localhost:8000`.

### Production build

```bash
cd frontend
npm run build            # outputs to frontend/dist/
cd ../backend
python main.py           # serves React build as static files
```

The FastAPI server mounts `frontend/dist/` at `/` and serves it as a static site with `html=True` (handles client-side routing). All `/api/*` routes take priority over the static mount.

---

## 12. Extending the Hub

### Adding a new data series

1. Add an entry to `backend/data/series_catalogue.json` with all required fields.
2. For DFM inputs: add `dfm_col_index`, `dfm_factor`, `dfm_sign`, `dfm_primary`, `typical_lag_days`.
3. No code changes needed for the fetcher — it resolves from the catalogue automatically.

### Adding a new tool

1. **Backend:** create `backend/my_tool.py` with computation logic and a getter function.
2. **API:** import the getter in `main.py` and add a route under `/api/tools/my-tool`.
3. **Frontend:** create `frontend/src/pages/MyTool.tsx` and add a route in `App.tsx`.
4. **Dashboard:** add an entry to `dashboard_config.yaml` under the appropriate category.

### Adding a new DFM factor

1. Add the new series to `series_catalogue.json` with the next available `dfm_col_index`.
2. Update `m_macro=8` to `m_macro=9` (or N) wherever it appears.
3. If it requires a new named factor: add the name to `FACTOR_NAMES` in `euro_area_heatmap.py` and set `dfm_primary=True` on its primary series in the catalogue.
4. Update `_primary_by_factor` lookup — it is derived automatically from the catalogue, so no manual change is needed there.
