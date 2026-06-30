# Analytics Hub — Technical Documentation

**Last updated:** June 2026
**Stack:** Python 3.12 · FastAPI · React 18 · TypeScript · NumPy / Pandas / SciPy

---

## Table of Contents

1. Project Overview
2. Repository Layout
3. Architecture
4. Authentication
5. Data Infrastructure
   - 5.1 Series Catalogues
   - 5.2 Data Fetcher
   - 5.3 Macro Data Loader
6. Tools — Backend
   - 6.1 Regional Heatmaps (all regions)
   - 6.2 Global Yields Factor Model
   - 6.3 Fair Value Models (HICPxT)
   - 6.4 Swaps RV Monitor
   - 6.5 Seasonality Backtester
   - 6.6 Print Analysis
   - 6.7 Momentum (CTA Signals)
   - 6.8 Inflation PCA
   - 6.9 Option-Implied CDF
7. Mathematical Foundations
   - 7.1 Mixed-Frequency Dynamic Factor Model
   - 7.2 Kalman Filter and RTS Smoother
   - 7.3 Block-PCA Initialisation
   - 7.4 Par Curve Bootstrap
   - 7.5 Elastic Net Fair Value
   - 7.6 Gram-Charlier Option CDF
   - 7.7 CTA Signal and Position Sizing
   - 7.8 Seasonality Statistics
8. API Reference
9. Frontend
10. Dashboard Configuration
11. Running Locally
12. Extending the Hub

---

## 1. Project Overview

The Analytics Hub is a private, authentication-gated web application for quantitative macro and rates analysis. It exposes a set of quantitative tools as interactive dashboards, each backed by a Python computation module served via FastAPI and rendered by a React frontend.

**Live tools table:**

| Tool | Category | Backend module | Data status |
|---|---|---|---|
| Euro Area Heatmap | Macro Fundamentals | euro_area_heatmap.py | ⚠️ Live (32 tickers unconfirmed) |
| UK Heatmap | Macro Fundamentals | uk_heatmap.py | ✅ Live |
| US Heatmap | Macro Fundamentals | us_heatmap.py | ✅ Live |
| Japan Heatmap | Macro Fundamentals | japan_heatmap.py | ✅ Live |
| Canada Heatmap | Macro Fundamentals | canada_heatmap.py | ✅ Live |
| Sweden Heatmap | Macro Fundamentals | sweden_heatmap.py | ✅ Live |
| Norway Heatmap | Macro Fundamentals | norway_heatmap.py | ✅ Live |
| Switzerland Heatmap | Macro Fundamentals | switzerland_heatmap.py | ✅ Live |
| Australia Heatmap | Macro Fundamentals | australia_heatmap.py | ✅ Live |
| New Zealand Heatmap | Macro Fundamentals | new_zealand_heatmap.py | ✅ Live |
| Global Yields Factor Model | Macro Fundamentals | global_yields.py | ✅ Live |
| Fair Value Models (HICPxT) | Inflation Markets | fair_value_models.py | ✅ Live (BBG only) |
| Inflation PCA | Inflation Markets | inflation_pca.py | ⚠️ Live (BBG tickers to verify) |
| Swap RV Monitor | Futures / Swaps / Vol | swaps_rv.py | ✅ Live (BBG only) |
| Seasonality Backtester | Backtesters | seasonality_backtester.py | ✅ Live (BBG only) |
| Print Analysis | Macro Fundamentals | print_analysis.py | ✅ Live (BBG only) |
| Momentum (CTA Signals) | Futures / Swaps / Vol | momentum.py | ✅ Live (BBG optional) |
| Option-Implied CDF | Macro Fundamentals | option_derived_cdf.py | ⚠️ Live (BBG tickers to verify) |

| Positioning | Macro Fundamentals | (frontend-only) | ❌ Simulated |
| Inflation Fixings Monitor | Inflation Markets | (frontend-only) | ❌ Simulated |

For the full data pipeline reference (tickers, env vars, fallback chains), see `BBG_HAVER_SETUP.md`.

---

## 2. Repository Layout

```
Team-Massimo-Marzeglia-Analytics/
│
├── backend/
│   ├── main.py                       # FastAPI app, all route definitions
│   ├── auth.py                       # JWT authentication, user store
│   ├── create_user.py                # CLI to create users
│   ├── bbg.py                        # Thin blpapi wrapper (blp.bdh)
│   │
│   ├── ── Shared infrastructure ──
│   ├── dfm.py                        # Kalman filter / RTS smoother
│   ├── macro_data_loader.py          # Macro obs matrix builder for DFM
│   ├── data_fetcher.py               # Pluggable Bloomberg / Haver connector
│   │
│   ├── ── Regional heatmaps ──
│   ├── euro_area_heatmap.py
│   ├── uk_heatmap.py
│   ├── us_heatmap.py
│   ├── japan_heatmap.py
│   ├── canada_heatmap.py
│   ├── sweden_heatmap.py
│   ├── norway_heatmap.py
│   ├── switzerland_heatmap.py
│   ├── australia_heatmap.py
│   ├── new_zealand_heatmap.py
│   │
│   ├── ── Other tools ──
│   ├── global_yields.py
│   ├── fair_value_models.py
│   ├── swaps_rv.py
│   ├── curves_flies_config.py
│   ├── seasonality_backtester.py
│   ├── print_analysis.py
│   ├── momentum.py
│   ├── inflation_pca.py
│   ├── option_derived_cdf.py
│   │
│   ├── data/
│   │   ├── series_catalogue.json     # EA / global / FV / swaps series
│   │   ├── series_catalogue_uk.json
│   │   ├── series_catalogue_us.json
│   │   ├── series_catalogue_jp.json
│   │   ├── series_catalogue_ca.json
│   │   ├── series_catalogue_se.json
│   │   ├── series_catalogue_no.json
│   │   ├── series_catalogue_ch.json
│   │   ├── series_catalogue_au.json
│   │   └── series_catalogue_nz.json
│   │
│   └── tests/
│       └── test_analytics.py
│
├── frontend/
│   └── src/
│       ├── App.tsx
│       ├── components/
│       │   ├── Dashboard.tsx
│       │   └── Login.tsx
│       └── pages/
│           ├── EuroAreaHeatmap.tsx
│           ├── UKHeatmap.tsx
│           ├── [other regional heatmap pages]
│           ├── GlobalYields.tsx
│           ├── FairValueModels.tsx
│           ├── InflationPCA.tsx
│           ├── OptionDerivedCDF.tsx
│           ├── SwapsRV.tsx
│           ├── SeasonalityBacktester.tsx
│           ├── PrintAnalysis.tsx
│           ├── Momentum.tsx
│           └── Positioning.tsx
│
├── dashboard_config.yaml
├── DOCUMENTATION.md                  # This file
└── BBG_HAVER_SETUP.md                # Data pipeline guide: BBG/Haver setup, tickers, status
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
  ├─► /api/auth/*                    → auth.py
  ├─► /api/dashboard                 → dashboard_config.yaml
  │
  ├─► /api/tools/euro-area-heatmap/* → euro_area_heatmap.py
  ├─► /api/tools/uk-heatmap/*        → uk_heatmap.py
  ├─► /api/tools/[other regions]/*   → [region]_heatmap.py
  │       (all share: data_fetcher.py, macro_data_loader.py, dfm.py)
  │
  ├─► /api/tools/global-yields       → global_yields.py
  ├─► /api/tools/fair-value-models   → fair_value_models.py
  ├─► /api/tools/swaps-rv            → swaps_rv.py
  ├─► /api/tools/seasonality/*       → seasonality_backtester.py
  ├─► /api/tools/print-analysis/*    → print_analysis.py
  ├─► /api/tools/momentum/*          → momentum.py
  ├─► /api/tools/inflation-pca/{curve_id} → inflation_pca.py
  ├─► /api/tools/option-cdf/{ccy}/{tail}  → option_derived_cdf.py
  │
  └─► /* (static)                    → frontend/dist/
```

**Key design principle — precomputation at startup:**
All heatmap modules execute their Kalman smoother, PCA, and OLS regressions at **import time**, storing results in module-level globals. API route handlers are fast serialisations of already-computed arrays. Restart the server to pick up new data.

**Live data control:** `ANALYTICS_DATA_SOURCE` env var switches all tools simultaneously. Values: `bloomberg`, `haver`, `csv`/`simulation` (default). See `BBG_HAVER_SETUP.md`.

---

## 4. Authentication

**File:** `backend/auth.py`

- OAuth2 Password Flow via FastAPI's `OAuth2PasswordBearer`
- Passwords hashed with `bcrypt`
- Sessions issued as HS256 JWT tokens, 8-hour expiry
- User store: JSON file (`users.json`, gitignored). Create users with `create_user.py`
- All `/api/tools/*` and `/api/me` routes require a valid Bearer token via `get_current_user` dependency

```bash
python create_user.py <username> <password> "<Full Name>"
```

**Login flow:**
```
POST /api/auth/login  →  { access_token, token_type: "bearer" }
GET  /api/me          →  { username, full_name }
```

**Frontend auth pattern:**
```typescript
const token = localStorage.getItem('access_token')
const res = await fetch('/api/tools/...', {
  headers: { Authorization: `Bearer ${token}` },
})
```

---

## 5. Data Infrastructure

### 5.1 Series Catalogues

**Files:** `backend/data/series_catalogue*.json`

| Catalogue | Used by | Series |
|---|---|---|
| `series_catalogue.json` | Euro Area heatmap, Global Yields, Fair Value Models | 147 |
| `series_catalogue_uk.json` | UK heatmap | 53 |
| `series_catalogue_us.json` | US heatmap | 71 |
| `series_catalogue_jp.json` | Japan heatmap | 58 |
| `series_catalogue_ca.json` | Canada heatmap | 54 |
| `series_catalogue_se.json` | Sweden heatmap | 52 |
| `series_catalogue_no.json` | Norway heatmap | 52 |
| `series_catalogue_ch.json` | Switzerland heatmap | 52 |
| `series_catalogue_au.json` | Australia heatmap | 52 |
| `series_catalogue_nz.json` | New Zealand heatmap | 52 |

**Entry schema (key fields):**

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique slug — used as cross-reference key everywhere |
| `ticker_bloomberg` | string\|null | Bloomberg ticker (e.g. `"ECCPEXFE Index"`) |
| `ticker_haver` | string\|null | Haver mnemonic (`"SERIES@DATABASE"` format) |
| `source` | string | `"bloomberg"`, `"haver"`, `"derived"` |
| `frequency` | string | `"daily"`, `"monthly"`, `"quarterly"` |
| `typical_lag_days` | int\|null | Days from period-end to typical release date |
| `role` | string | `"dfm"`, `"market_data"`, `"fair_value"`, `"global_yields"` |
| `dfm_col_index` | int\|null | Column position in DFM Y matrix (0-indexed) |
| `dfm_factor` | string\|null | Named factor: `"Growth"`, `"Inflation"`, `"Employment"`, `"Wages"` |
| `dfm_sign` | int\|null | `+1` or `-1` sign convention |
| `dfm_primary` | bool\|null | Anchors sign-normalisation per factor |

Derived series (`source: "derived"`) have `ticker_bloomberg: null`. The fetcher skips them; they are computed in-house (ESTR forwards, HICP forward rates, etc.).

To update a ticker: edit the JSON entry. Changes take effect on next server restart — no code changes needed.

### 5.2 Data Fetcher

**File:** `backend/data_fetcher.py`

```python
from data_fetcher import get_fetcher

fetcher = get_fetcher("bloomberg")
# or:
fetcher = get_fetcher("haver", catalogue_path="data/series_catalogue_uk.json",
                                haver_path="/path/to/haver")

data: dict[str, pd.Series] = fetcher.fetch(
    series_ids=["ea_composite_pmi", "ea_core_hicp_yoy"],
    start="2015-01-01", end="2025-12-31",
    field="PX_LAST",
)
```

Output format:
- `"daily"` → `DatetimeIndex`
- `"monthly"` → `PeriodIndex("M")`, last observation per period
- `"quarterly"` → `PeriodIndex("Q")`, last observation per period

Bloomberg backend: `pip install xbbg`, Terminal must be running. Calls `blp.bdh(tickers, flds=["PX_LAST"], ...)`.

Haver backend: `pip install Haver` (Windows only). Mnemonics in `"SERIES@DATABASE"` format.

Every live-data function wraps calls in try/except, returns `None` on failure. No tool crashes if data is unavailable.

### 5.3 Macro Data Loader

**File:** `backend/macro_data_loader.py`

Converts `dict[series_id, pd.Series]` into the daily observation matrix `Y_daily[T, M]` consumed by the Kalman filter.

```python
macro_data = load_macro_data(
    daily_dates: pd.DatetimeIndex,
    m_macro: int,
    data: dict[str, pd.Series] | None,
    catalogue_path: str | None,
) -> MacroData
```

**Release date estimation:**
- `PeriodIndex` series → `release_date = period_end + typical_lag_days`, snapped to next business day
- `DatetimeIndex` series → dates used directly

**Output:**
```python
@dataclass
class MacroData:
    Y_daily: np.ndarray           # [T, M] — NaN everywhere except release dates
    series_ids: list[str]
    series_names: list[str]
    factor_assignments: list[str]
    primary_series_signs: list[int]
    has_data: bool
    n_obs_per_series: dict[str, int]
    warnings: list[str]
```

If `data=None` or no usable records: `has_data=False` → heatmap falls back to simulation.

---

## 6. Tools — Backend

### 6.1 Regional Heatmaps (all regions)

All 10 regional heatmaps share the same two-block architecture.

**Files:** `backend/{region}_heatmap.py`
**API routes:** `GET /api/tools/{region}-heatmap/{factors|yield-pca|pc-regressions|fair-value}`

#### Regions and yield markets

| Region | Module | Yield market | Tenors | DFM series (M) |
|---|---|---|---|---|
| Euro Area | euro_area_heatmap.py | Bunds | 2/3/5/7/10/15/20/30y (8) | 60 |
| UK | uk_heatmap.py | Gilts | 2/5/10/20/30y (5) | 48 |
| US | us_heatmap.py | Treasuries | 2/5/10/20/30y (5) | ~50 |
| Japan | japan_heatmap.py | JGBs | 2/5/10/20/30y (5) | ~50 |
| Canada | canada_heatmap.py | CanGov | 2/5/10/20/30y (5) | ~50 |
| Sweden | sweden_heatmap.py | SGBs | 2/5/10/20/30y (5) | ~50 |
| Norway | norway_heatmap.py | NGBs | 2/5/10/20/30y (5) | ~50 |
| Switzerland | switzerland_heatmap.py | Confederation bonds | 2/5/10/20/30y (5) | ~50 |
| Australia | australia_heatmap.py | ACGBs | 2/5/10/20/30y (5) | ~50 |
| New Zealand | new_zealand_heatmap.py | NZGBs | 2/5/10/20/30y (5) | ~50 |

#### Block 1 — Macro DFM

Each region runs a K=5 Kalman filter/smoother on M regional macro series. The 5 factors are: Global Macro, Growth, Inflation, Employment, Wages.

**Full pipeline:**

```
series_catalogue_{region}.json  (entries with dfm_col_index set)
  → get_fetcher(source, catalogue_path=...)
  → fetcher.fetch(series_ids, start, end, field="PX_LAST")
  → macro_data_loader.load_macro_data()
      → release dates = period_end + typical_lag_days, snapped to business day
      → Y_daily [T, M]  (NaN everywhere except release dates)
  → Block-PCA initialisation:
      → forward-fill Y_daily (LOCF) → Y_ffill
      → standardise each column by nanmean/nanstd of actual obs only → Y_std
      → within-group block-PCA for Growth, Inflation, Employment, Wages
          → first PC of each group's sub-matrix → sparse loading vector
          → sign-normalise via dfm_primary series
      → full-panel PCA on all M columns → Global Macro factor (dense loadings)
      → un-standardise loadings: Λ[m,k] = Λ_std[m,k] × col_std[m]
      → AR(1) persistence ρ_k from PCA scores, clipped to [0.5, 0.999]
      → Q = diag(σ²_k (1−ρ²_k)); R from PCA residuals
  → Kalman filter (forward pass) on raw Y_daily (NaN-aware)
  → RTS smoother (backward pass)
  → FACTORS_SMOOTH [T, 5]
```

Fallback: if `has_data=False` → 5-factor deterministic AR(1) simulation, block-loading structure, seeded by region.

#### Block 2 — Yield PCA

Government bond yield tenors are fetched **independently** of Block 1. The two blocks are fully decoupled — each can fall back independently.

```python
# Pattern (UK example)
_YIELD_SERIES_IDS = ["gilt_2y", "gilt_5y", "gilt_10y", "gilt_20y", "gilt_30y"]

def _fetch_yield_data_uk(start, end):
    # source = os.environ.get("ANALYTICS_DATA_SOURCE", "csv")
    # if source in ("csv", "simulation"): return None
    # fetcher = get_fetcher(source, catalogue_path=_UK_CATALOGUE_PATH)
    # data = fetcher.fetch(_YIELD_SERIES_IDS, start, end, field="PX_LAST")
    # snap to DAILY_DATES grid via np.searchsorted
    # pd.DataFrame(yield_mat).ffill().bfill()  ← fill weekends/holidays
    # return np.ndarray [T_daily, N_tenors] or None
```

**PCA pipeline (on yield changes, not levels):**

```
YIELDS [T, N_tenors]  (in %, e.g. 2.54 = 2.54%)
  → dY = np.diff(YIELDS, axis=0)          # [T-1, N_tenors] daily changes
  → centre columns (subtract column means)
  → C = dY_centred.T @ dY_centred / (T-2) # [N, N] covariance matrix
  → eigendecomposition(C)
  → sort eigenvalues descending
  → sign conventions:
      PC1 (level):      mean loading positive  → all bonds move together
      PC2 (slope):      long-end loading positive → bear-steepener = positive
      PC3 (curvature):  no canonical sign
  → PC_SCORES [T, 3]  (daily factor scores)
  → PC_LOADINGS [N_tenors, 3]
```

**Macro linkage (OLS, no intercept):**
```
FACTORS_SMOOTH[:, :] → PC_SCORES[:, i]   i=0,1
β = (X'X)⁻¹ X'y   where X = FACTORS_SMOOTH, y = PC_score_i
PC_i_fitted = FACTORS_SMOOTH @ β_i
```

**Fair value reconstruction:**
```
10y_fair_value = yield_mean_10y
                + PC1_fitted × PC1_loading_10y
                + PC2_fitted × PC2_loading_10y
rich_cheap_bps = (actual_10y − fair_value_10y) × 100
```

Fallback: if `_fetch_yield_data_*()` returns `None` → synthetic yields simulated from Block 1 factors.

#### API endpoints (identical across all regions)

| Suffix | Returns |
|---|---|
| `/factors` | `dates`, dict of factor arrays (Global Macro / Growth / Inflation / Employment / Wages) |
| `/yield-pca` | `dates`, `pc_scores [T×3]`, `loadings [N×3]`, `explained_var [3]`, `tenor_names` |
| `/pc-regressions` | `factor_names`, for PC1 and PC2: `beta`, `tstat`, `r2`, `adj_r2` |
| `/fair-value` | `dates`, `actual`, `pca_fitted`, `macro_fair_value`, `rich_cheap_bps` |

---

### 6.2 Global Yields Factor Model

**File:** `backend/global_yields.py`
**API route:** `GET /api/tools/global-yields`

3-factor PCA across 24 countries' 10y government bond yields.

**Countries:** 16 DM (US, Germany, UK, Japan, France, Italy, Spain, Netherlands, Belgium, Austria, Switzerland, Sweden, Norway, Denmark, Canada, Australia) + 8 EM (Brazil, Mexico, India, Indonesia, South Africa, Turkey, Poland, Czech Republic).

**Methodology:**
1. Fetch 24 daily 10y yield series via `get_fetcher(source)` (series IDs in `series_catalogue.json`, `role: "global_yields"`)
2. Compute cross-country covariance matrix on daily yield changes
3. Eigendecomposition → PC1 (global level), PC2 (DM-specific divergence), PC3 (EM-idiosyncratic)
4. Per-country residual = actual − 3-factor fitted
5. Z-score residual over 1-year rolling window → rich/cheap signal

**Response:**
```json
{
  "factors": { "dates": [...], "PC1": [...], "PC2": [...], "PC3": [...] },
  "explained_variance": { "PC1": 0.72, "PC2": 0.14, "PC3": 0.06 },
  "table": [
    { "country": "Germany", "region": "DM", "actual": 2.44, "model": 2.38,
      "residual": 0.06, "zscore": 0.82, "significant": false }
  ],
  "residuals": { "dates": [...], "Germany": [...], ... }
}
```

---

### 6.3 Fair Value Models (HICPxT)

**File:** `backend/fair_value_models.py`
**API route:** `GET /api/tools/fair-value-models`
**Data:** Bloomberg only (`ANALYTICS_DATA_SOURCE=bloomberg`); deterministic simulation fallback

#### Model inventory

14 rolling Elastic Net regression models for EUR HICPxT inflation swap rates:

**Group 1 — Outright spot rates (7 models):** 1Y, 2Y, 5Y, 10Y, 15Y, 20Y, 30Y ZC HICPxT swaps

**Group 2 — Forward rates (7 models):** 1Y1Y, 2Y1Y, 2Y2Y, 2Y3Y, 5Y5Y, 10Y10Y, 20Y10Y

#### Predictor design

Each model uses a different predictor set, intentionally varying by tenor:

| Predictor | Short outrights (1Y, 2Y) | Medium outrights (5Y–30Y) | Short forwards (1Y1Y–2Y2Y) | Medium forwards (2Y3Y–5Y5Y) | Ultra-long forwards (10Y10Y, 20Y10Y) |
|---|---|---|---|---|---|
| Corresponding ESTR OIS rate | ✓ | ✓ | ✓ (ESTR fwd) | ✓ (ESTR fwd) | ✓ (ESTR fwd) |
| log(Brent) | ✓ | ✓ | ✓ | ✓ | ✓ |
| log(Gas) | ✓ | ✓ | ✓ | ✓ | ✓ |
| EURIBOR 3M | ✓ (policy anchor) | — | ✓ | — | — |
| log(BCOM) | ✓ | ✓ | ✓ | ✓ | ✓ |
| EUR TWI | ✓ | ✓ | ✓ | ✓ | ✓ |
| GS Euro Area FCI | ✓ | ✓ | ✓ | ✓ | ✓ |
| iTraxx Europe 5Y | ✓ | ✓ | ✓ | ✓ | ✓ |
| Citi ESI EUR | ✓ | ✓ | ✓ | ✓ | — (less relevant at ultra-long) |
| 3M10Y OIS slope | ✓ | ✓ | ✓ | ✓ | ✓ |
| 1M10Y swaption vol | — | — | — | — | ✓ (convexity demand) |

**Rationale:**
- **EURIBOR 3M** is included only for short-end instruments (1Y, 2Y outrights; short forwards) because policy rate expectations dominate breakeven pricing at the short end
- **Swaption vol** is included only for ultra-long forwards (10Y10Y, 20Y10Y) where convexity demand materially affects pricing
- **Citi ESI** is dropped for ultra-long forwards (macro newsflow has negligible impact on 20–30y expectations)
- **ESTR forward rate** is used as the real-rate anchor for forward inflation models; spot ESTR par rates are used for outright models

#### Data pipeline (live BBG path)

```
28 Bloomberg tickers → blp.bdh(tickers, "PX_LAST", start, end)
  │
  ├── Swap rates (EUSWI*, EESWE*, EUR003M) → divide by 100 → decimal
  ├── Commodities: log(Brent), log(Gas), log(BCOM)
  ├── Optional macro: EUR_TWI, GSEAFCI, ITRX5Y, CESIEUR, SMOVEU1M
  │   (if absent → zeros; ElasticNet shrinks coefficients to zero)
  │
  ├── Derived: slope_3m10y = EESWE10 − EUR003M
  │
  ├── ESTR forward bootstrap (per row):
  │     available tenors: 1,2,3,4,5,10,15,20,30y
  │     CubicSpline(tenors, par_rates) → interpolate to all 1..30y
  │     bootstrap discount factors D[0..30]:
  │       D[0] = 1
  │       D[n] = (1 − r_n × Σ D[k], k=1..n-1) / (1 + r_n)
  │     forward rate f(s,t) = (D[s] − D[s+t]) / Σ D[s+k], k=1..t
  │     → ESTR_1Y1Y, ESTR_2Y1Y, ESTR_2Y2Y, ESTR_2Y3Y, ESTR_5Y5Y, ESTR_10Y10Y, ESTR_20Y10Y
  │
  └── HICPxT forward derivation (ZC algebra, per row):
        hicp_fwd(s,t) = ((1 + r_{s+t})^{s+t} / (1 + r_s)^s)^{1/t} − 1
        → HICP_1Y1Y  from EUSWI1, EUSWI2
        → HICP_2Y1Y  from EUSWI2, EUSWI3
        → HICP_2Y2Y  from EUSWI2, EUSWI4
        → HICP_2Y3Y  from EUSWI2, EUSWI5
        → HICP_5Y5Y  from EUSWI5, EUSWI10
        → HICP_10Y10Y from EUSWI10, EUSWI20
        → HICP_20Y10Y from EUSWI20, EUSWI30
```

If **any required series** (EUSWI1/2/5/10/20/30, EESWE1..30, Brent, Gas, BCOM, EUR003M) is missing → entire live pipeline falls back to simulation.

#### Rolling Elastic Net (the estimation engine)

Constants: `ROLL_WINDOW = 500` days (~2 calendar years), `MIN_WINDOW = 252` days (minimum obs before first fit), `FIT_STEP = 1` (refit every day).

**For each model, at each time step t ≥ MIN_WINDOW:**

```
Training window: X[t-500 : t-1],  y[t-500 : t-1]
  → StandardScaler: fit on training window, transform training window
  → ElasticNet(alpha=0.01, l1_ratio=0.5, max_iter=2000).fit(X_scaled, y)
  → OOS prediction at t:
      x_curr_scaled = scaler.transform(X[t : t+1])
      fitted[t] = model.predict(x_curr_scaled)
      residual[t] = y[t] − fitted[t]
  → In-sample R² on training window (IS R²)
  → Store coefficients coef_full[t, :]
```

Note: the ElasticNet is fitted on `[t-500, t-1]` and evaluated OOS at `t`. This is a genuine out-of-sample test — no lookahead bias.

**Post-processing:**
- `fitted`, `residuals`, `coef_full` are forward-filled over non-fit days
- **Rolling sigma bands:** 252-day rolling mean and std of OOS residuals → ±1σ, ±2σ bands
- **Rolling IS R²:** in-sample fit quality on the training window, forward-filled
- **Rolling OOS R²:** computed as `1 − SS_res_oos / SS_tot` over 252-day window, benchmarked against a random-walk forecast (predict today = yesterday)
- **Scatter analysis:** OOS residual at t vs forward return of y at horizons 5d, 10d, 20d, 100d — tests mean-reversion in the residual; OLS trend line fitted

**DATES/T override:** When live data loads successfully, the module-level `DATES` and `T` are overridden to the live date range before `_rolling_elastic_net()` is called. This ensures date labels in the response match the actual live data.

#### Simulation fallback

When Bloomberg is unavailable, all variables are generated from three latent factors:

- **F_rates:** slow AR(0.999) rates/inflation supercycle with deterministic overlay capturing: post-GFC disinflation (2010–2020), COVID-era zero rates, 2021–2023 inflation surge, 2024 easing
- **F_energy:** AR(0.975) with deterministic Gaussian bumps calibrated to: 2008 oil spike+crash, 2012 recovery, 2016 trough, COVID crash, 2022 energy crisis, 2023 normalisation
- **F_risk:** AR(0.978) with stress bumps at GFC (2008), EA debt crisis (2011), COVID (2020), Ukraine (2022)

ESTR/HICP rates, commodity prices, and macro variables are constructed from linear combinations of these factors plus AR(1) idiosyncratic noise, with parameters calibrated to realistic level, vol, and cross-correlations. Commodity series use a blend (60/55% deterministic price shape + 40/45% stochastic component) to capture the major regime changes while preserving randomness.

---

### 6.4 Swaps RV Monitor

**File:** `backend/swaps_rv.py`
**Config:** `backend/curves_flies_config.py`
**API route:** `GET /api/tools/swaps-rv?currency=EUR&date=YYYY-MM-DD`
**Data:** Bloomberg (`_fetch_from_bbg(ccy, start, end)`); CSV fallback per currency

Relative value monitor for EUR (ESTR), GBP (SONIA), and USD (SOFR) OIS forward par rates and butterfly structures.

#### Bloomberg tickers

```python
_OIS_TICKERS = {
    "EUR": {n: f"EUSWF{n} Curncy"  for n in [1..30]},   # ESTR par OIS rates
    "GBP": {n: f"BPSWS{n} Curncy"  for n in [1..30]},   # SONIA par rates
    "USD": {n: f"USOSFR{n} Curncy" for n in [1..30]},   # SOFR par rates
}
_VOL_TICKERS = {
    "EUR": {"1m10y": "EUSV0001 Index", "1y10y": "EUSV0110 Index"},
    "GBP": {"1m10y": "BPSV0001 Index", "1y10y": "BPSV0110 Index"},
    "USD": {"1m10y": "USSV0001 Index", "1y10y": "USSV0110 Index"},
}
```

All fetched with `PX_LAST`. OIS rates are in %; vol is in bps normal vol.

#### Par curve bootstrap

See §7.4 for full mathematics. The bootstrap produces discount factors D[0..30] from par rates at available tenors (cubic-spline interpolated to all 1..30 integers), then derives all forward par rates f(s,t) and 1-year carry values.

**46 forward labels per currency** (all combinations where s+t ≤ 30):
1Y1Y, 2Y1Y, 2Y2Y, 2Y3Y, 3Y2Y, 3Y7Y, 5Y5Y, 5Y10Y, 10Y10Y, 20Y10Y, etc.

#### Structures

Defined in `curves_flies_config.py`:
- **25 forward spread curves:** e.g. `"5y5y - 2y3y"`, `"10y10y - 5y5y"`, `"2y1y - 1y1y"` — each is a difference of two forward rates
- **20 butterfly structures:** e.g. `"2×(2y3y) − 1y1y − 5y5y"` — weighted sums with zero-sum constraint

#### RV metrics per structure

| Metric | Description |
|---|---|
| `level` | Current value in bps |
| `zscore_1y` | (current − 1y mean) / 1y std |
| `pctile_1y` | Percentile in 1-year history |
| `vol_1y` | Annualised daily vol (bps) |
| `carry_bps` | 1-year carry for the structure (receiver convention) |
| `carry_vol_ratio` | carry / vol — Sharpe-like carry efficiency |
| `beta` | Regression beta of structure on a vol factor |
| `beta_tstat` | t-statistic of beta |

**Entry point:** `compute_rv(currency="EUR", as_of_date=None)` → snapshot dict + 1y historical data arrays.

---

### 6.5 Seasonality Backtester

**File:** `backend/seasonality_backtester.py`
**API routes:**
- `GET /api/tools/seasonality/data?expression=...&start=...`
- `POST /api/tools/seasonality/stats` (body: `{dates[], values[]}`)
- `POST /api/tools/seasonality/heatmap` (body: `{dates[], values[]}`)
- `POST /api/tools/seasonality/backtest` (body: `{dates[], values[], rule}`)

#### Bloomberg expression fetcher

`fetch_bbg_expression(expression, start)` accepts any arithmetic expression over Bloomberg tickers, e.g.:
- `"GDBR10 Index"` — single series
- `"GDBR10 Index - GDBR2 Index"` — 2s10s spread
- `"GDBR30 Index - 2 * GDBR10 Index + GDBR2 Index"` — butterfly

**Parser:**
1. Regex `_BBG_RE` identifies Bloomberg tickers by their yellow key suffix (`Index`, `Equity`, `Comdty`, `Corp`, `Govt`, `Curncy`, `Mtge`, `Muni`, `Pfd`)
2. Unique tickers extracted and sorted longest-first (prevents substring replacement errors)
3. `blp.bdh(tickers, ["PX_LAST"], start, end)` — all tickers in one call
4. Rows with any NaN dropped (intersection of all series' history)
5. Each ticker replaced by safe variable name `__v0__`, `__v1__`, …; expression evaluated with `eval()` in a restricted namespace (no builtins)

**Returns:** `{expression, dates[], values[], n_obs}`

#### Seasonal annotation

`_build_day_df(dates, values)` computes daily returns (`series.diff()`) and annotates each row with:

| Column | Description |
|---|---|
| `dow` | Day of week: 0=Mon, 4=Fri |
| `month` | Month: 1–12 |
| `dom` | Day of month: 1–31 |
| `domQ` | DOM quintile: 1=days 1–6, 2=7–12, 3=13–18, 4=19–23, 5=24–31 |
| `tomOffset` | Turn-of-month offset: −3/−2/−1/+1/+2/+3 (last 3 / first 3 bdays of month); NaN otherwise |
| `qeOffset` | Quarter-end offset: −5..−1/+1..+5 (last 5 / first 5 bdays of quarter); NaN otherwise |

#### Seasonality statistics

`get_seasonality_stats(dates, values)` computes `_bin_stats()` for each bin across 5 dimensions:

**`_bin_stats(vals, label, bin_val)`:**
- `mean` — arithmetic mean of daily returns in the bin
- `std` — sample std dev (ddof=1)
- `t_stat` — mean / (std / √n): standard t-test of mean ≠ 0
- `p_value` — two-sided p-value: `2 × t.sf(|t|, df=n-1)`
- `win_rate` — fraction of days with positive return
- `n` — observation count

Returns stats across: 5 DOW bins, 12 month bins, 5 DOM-quintile bins, 6 TOM bins (±3 days around month-end), 10 QE bins (±5 days around quarter-end).

#### Seasonality heatmap

`get_seasonality_heatmap(dates, values)` builds a 12×5 matrix (month × DOW) of mean daily returns. Returns `{rows: [{month, Mon, Tue, Wed, Thu, Fri}, ...], vmin, vmax}`.

#### Backtest engine

`run_seasonality_backtest(dates, values, rule)` simulates a rule-based strategy:

**Rule structure:**
```json
{
  "type": "dow" | "month" | "dom_quintile" | "tom" | "quarter_end",
  "bins": [0, 1],     ← which bins to be active in
  "direction": 1      ← 1 = long, -1 = short
}
```

**Execution:**
- On each day: if the day falls in any of `rule.bins` for the given `rule.type`, position = `direction × 1`; else position = 0
- Strategy daily P&L = `position × daily_return`
- Strategy is applied to the raw daily returns of the fetched expression (not return-normalised)

**Output metrics:**
- `total_return` — cumulative sum of strategy P&L
- `ann_return` — `mean(strat) × 252`
- `sharpe` — `ann_return / (active_std × √252)` where active_std = std of strategy P&L on in-market days only
- `max_drawdown` — minimum of (cumulative P&L − running maximum)
- `win_rate` — fraction of in-market days with positive P&L
- `days_in_market` — count of active trading days
- `pct_in_market` — fraction of total days active

Annual breakdown (per calendar year): strategy total, buy-and-hold total, Sharpe, win rate, trade count.

---

### 6.6 Print Analysis

**File:** `backend/print_analysis.py`
**API routes:**
- `GET /api/tools/print-analysis/print-vs-consensus?ticker=...&start=...`
- `POST /api/tools/print-analysis/market-reaction` (body: `{market_ticker, releases[]}`)

#### Print vs Consensus

`fetch_print_vs_consensus(ticker, start)` fetches economic release history alongside Bloomberg consensus data.

**Bloomberg fields requested:**
| BBG field | Internal name | Description |
|---|---|---|
| `PX_LAST` | `actual` | Realised release value |
| `ECO_SURVEY_AVG` | `avg` | Mean of pre-release survey estimates |
| `ECO_SURVEY_MEDIAN` | `median` | Median of survey estimates |
| `ECO_SURVEY_HIGH` | `high` | Highest individual estimate |
| `ECO_SURVEY_LOW` | `low` | Lowest individual estimate |
| `BN_SURVEY_NUMBER` | `n` | Number of survey respondents |
| `ECO_RELEASE_DT` | `release_date` | Actual publication date |

**Derived per release:**
- `surprise = actual − avg` (NaN if no consensus available)
- `z_score = (surprise − full-sample mean) / full-sample std` (NaN if < 3 releases available)

**Summary statistics** across all releases:
- `mean_surprise`, `std_surprise`, `pct_beats` (surprise > 0), `pct_misses` (surprise < 0), `pct_inline` (surprise = 0)

Rows are returned reverse-chronological. Any field with unavailable data returns `null`.

**Fallback:** If `blpapi` not importable or Terminal not running → synthetic releases via `_simulate_releases(ticker, start)`: AR(0.92) mean-reverting level series, Gaussian consensus noise, realistic release lag randomisation. Seeded by ticker hash for reproducibility.

#### Market Reaction

`fetch_market_reaction(market_ticker, releases)` computes the market instrument's day-of-release move for each release.

**Method:** For each `release_date`:
1. Find the first trading day ≥ `release_date` (accounts for weekend/holiday releases)
2. Find the prior trading day
3. `market_move = price[release_date] − price[prior_day]`

**Input:** list of `{release_date, period, surprise}` dicts (typically from a prior `print-vs-consensus` call).

**Use case:** Scatter plot of surprise vs market move reveals the market's typical sensitivity to that indicator — useful for pre-release positioning.

**Fallback:** If Bloomberg unavailable → synthetic market moves linearly correlated with surprises (`slope × surprise + noise`), seeded by market ticker.

---

### 6.7 Momentum (CTA Signals)

**File:** `backend/momentum.py`
**API route:** `GET /api/tools/momentum/cta-signals?ticker=...&start=...`
**Data:** Bloomberg `PX_LAST` (optional); deterministic simulation fallback always available

Computes multi-lookback, volatility-scaled CTA momentum signals for any price or yield series.

#### Signal formula

For each lookback window L (in trading days):

```
level_diff(t)  = series[t] − series[t − L]
ann_vol(t)     = rolling_std(daily_diffs, window=63) × √252
denom(t)       = ann_vol(t) × √(L / 252)

signal_L(t)    = level_diff(t) / denom(t)
```

Both numerator and denominator are in the same units (level changes, not returns), so the signal is dimensionless regardless of whether the input is a price index or a yield series. Individual signals are clipped to [−5, +5] to prevent outliers from dominating.

**Lookback windows:**

| Label | L (trading days) | Approximate horizon |
|---|---|---|
| 1M | 21 | ~1 month |
| 3M | 63 | ~3 months |
| 6M | 126 | ~6 months |
| 12M | 252 | ~1 year |

**Composite signal:** equal-weight mean of the 4 lookback signals:
```
composite(t) = mean(signal_1M, signal_3M, signal_6M, signal_12M)
```
`composite` is NaN if any of the 4 individual signals is NaN (conservative: requires full history across all lookbacks).

**Minimum history:** `MIN_HISTORY = 252 + 63 = 315` trading days before any signal is produced.

#### Position sizing

```
ann_vol_ret(t) = rolling_std(pct_change, window=63) × √252   ← return-based vol
position(t)    = (VOL_TARGET × composite(t)) / ann_vol_ret(t)
```

- `VOL_TARGET = 0.10` (10% annualised vol target)
- Return-based vol is used for sizing (not level-change vol) so position size is not distorted by the absolute price level
- Position is clipped to [−8, +8] leverage

**Signal labels:**

| Composite range | Label |
|---|---|
| > 1.5 | Strong Long |
| 0.5 – 1.5 | Long |
| −0.5 – 0.5 | Neutral |
| −1.5 – −0.5 | Short |
| < −1.5 | Strong Short |

**Percentile:** composite z-score is ranked against the full non-NaN history using `scipy.stats.percentileofscore` (rank method).

#### Simulation fallback

When Bloomberg is unavailable (or as default): `_simulate_series(ticker, start)` generates a regime-switching random walk seeded by `hashlib.md5(ticker)`:

- Alternates **trending** regimes (drift ±3–12% annualised, vol 6–14% ann) and **choppy** regimes (zero drift, vol 1–5% ann)
- Each regime lasts uniformly 40–160 trading days
- Starts at price = 100

This produces realistic momentum signal variation — some periods the signals strongly agree, others they diverge — allowing the tool to be fully functional and visually meaningful without Bloomberg.

**Output:** `{ticker, dates[], series[], composite[], position[], signals: {1M, 3M, 6M, 12M}[], current: {date, value, composite, composite_pctile, label, signals, position}}`

Series subsampled every 5 days for payload size.

---

### 6.8 Inflation PCA

**Files:** `backend/inflation_pca.py`, `frontend/src/pages/InflationPCA.tsx`
**API route:** `GET /api/tools/inflation-pca/{curve_id}`
**Data:** Bloomberg; independent per-yield-type fallback to simulation

PCA decomposition and PCA-neutral butterfly analysis for EUR and GBP inflation-linked bond curves.

#### Curves

| Curve | Bonds | CCY |
|---|---|---|
| BTPei | 7 bonds (2028, 2030, 2032, 2035, 2038, 2041, 2051) | EUR |
| OATei | 6 bonds (2027, 2029, 2032, 2036, 2040, 2047) | EUR |
| DBRei | 5 bonds (2026, 2030, 2033, 2040, 2046) | EUR |
| UKi | 7 bonds (2027, 2030, 2032, 2035, 2040, 2047, 2055) | GBP |

#### Yield types and Bloomberg data pipeline

| Type | Definition | BBG field | BBG tickers |
|---|---|---|---|
| Real yield | YTM of the ILB | `YLD_YTM_MID` | `ITIL28 Index`, `FROB27I Index`, `DBIBL26 Index`, `UKTIIL27 Index`, … (per bond) |
| Breakeven | Inflation swap interpolated at bond maturity | `PX_LAST` | EUR: `EUSWI{n} Curncy`; GBP: `BPSWIS{n} Curncy` (n=1–30) |
| IOTA | real_yield + infl_swap(mat) − OIS(mat) | `PX_LAST` | EUR OIS: `EUSWF{n} Curncy`; GBP: `BPSWS{n} Curncy` (n=1–30) |

Breakeven and IOTA are computed by linear-interpolating the relevant swap curve at each bond's maturity (YTM approximated as `maturity_year − current_year`, clamped to [1, 30]).

**Independent fallback:** each of the three yield types (real / breakeven / IOTA) falls back to simulation independently. If the OIS fetch fails but real yields and inflation swaps succeed, IOTA uses simulation while real and breakeven use live data. The frontend header badge shows green "Live (Bloomberg)" or amber "Simulated data" based on the `data_source` field in the API response.

#### Data flow

```
Bloomberg BDH
  ├── YLD_YTM_MID on bond tickers  → real_df  [T, N_bonds]
  ├── PX_LAST on infl swap tickers → infl_df  [T, 30]   (tenors 1–30)
  └── PX_LAST on OIS tickers       → ois_df   [T, 30]

inflation_pca.py
  ├── _build_breakeven_matrix(real_df, infl_df, bonds)
  │     → linear interpolate infl_swap to each bond's maturity per date
  ├── _build_iota_matrix(real_df, infl_df, ois_df, bonds)
  │     → IOTA = real_yield + infl_swap(mat) − OIS(mat)
  │
  └── For each yield type → _pack(levels [T, N_bonds], bonds)
        → _compute_pca(levels): eigh on covariance of daily changes
        → _compute_flies(levels, loadings, bonds): Cramér's rule + z-scores
        → returns {levels, loadings, var_explained, flies}
```

**Entry point:** `get_inflation_pca_data(curve_id)` → JSON dict with `real`, `breakeven`, `iota` blocks plus `dates` and `data_source`.

#### PCA algorithm

Runs on up to 252 days of daily data (or full live history when Bloomberg is connected):

1. First-difference levels → `dY [T-1, N_bonds]`
2. Centre columns
3. Covariance `C = dY_centred.T @ dY_centred / (T-2)`
4. `np.linalg.eigh(C)` — exact symmetric eigendecomposition (Python backend); Jacobi iteration (TypeScript frontend)
5. Sign conventions: PC1 mean-loading positive; PC2 last-bond loading positive

#### PCA-neutral butterflies

For each triplet (i=left, j=belly, k=right), solve 2×2 via Cramér's rule:

```
det  = pc1[i]×pc2[k] − pc1[k]×pc2[i]
wL   = (pc1[j]×pc2[k] − pc1[k]×pc2[j]) / det
wR   = (pc1[i]×pc2[j] − pc2[i]×pc1[j]) / det

spread_t = (wL×y_i[t] − y_j[t] + wR×y_k[t]) × 100   (bps)
z-score  = (current − 63d mean) / 63d std
```

Triplets where |det| < 1e-6 are skipped. Sorted by |z-score| descending.

**Net DV01** (per $1MM belly notional, par bond approximation):
```
dur_i = max(0.5, maturity_i − 2026) × 0.92
net_dv01 = (wL×dur_i − dur_belly + wR×dur_k) × $100
```

See `BBG_HAVER_SETUP.md §6.3` for the full ticker checklist.

---

### 6.9 Option-Implied CDF

**Files:** `backend/option_derived_cdf.py`, `frontend/src/pages/OptionDerivedCDF.tsx`
**API route:** `GET /api/tools/option-cdf/{ccy}/{tail}`
**Data:** Bloomberg; fallback to hardcoded mid-2025 calibration table

Constructs an option-implied probability distribution for a swaption underlying (forward swap rate) using the Gram-Charlier expansion (see §7.6). The backend provides live market parameters (forward rate and ATM normal vol) to pre-populate the controls; all Gram-Charlier math runs entirely in the browser on user-editable inputs.

#### Supported structure

**Currencies:** USD, EUR, GBP
**Expiries:** 1m, 3m, 6m, 1y, 2y, 3y, 5y, 7y, 10y
**Underlying swap tenors (tails):** 1y, 2y, 5y, 10y, 15y, 20y, 30y

#### Bloomberg data pipeline

`get_option_cdf_params(ccy, tail)` fetches data for all expiries in a single API call and returns a parameter table. The frontend fetches this on every (ccy, tail) change and uses the result to pre-populate horizon controls, falling back to the static calibration table on failure.

**Par swap rates (forward rate proxy):**

```python
_SWAP_TICKERS = {
    "USD": {t: f"USSW{t.rstrip('y')} Curncy"  for t in TAILS},   # e.g. USSW10 Curncy
    "EUR": {t: f"EUSA{t.rstrip('y')} Curncy"  for t in TAILS},   # e.g. EUSA10 Curncy
    "GBP": {t: f"BPSWS{t.rstrip('y')} Curncy" for t in TAILS},   # e.g. BPSWS10 Curncy
}
```

The spot par swap rate at the tail tenor is used as a proxy for the ATM forward swap rate. Any convexity adjustment is within the tool's rounding threshold.

**Swaption ATM normal vol (bp/yr from Bloomberg; converted to % at-expiry):**

```python
# Format: {prefix}N{expiry}{tail} Curncy
# e.g. USSN6M10Y Curncy, EUSN1Y5Y Curncy, BPSN3M10Y Curncy
# Verify in Bloomberg terminal: SWVOL <Go> or VCUB <Go>
```

Bloomberg returns vol in **bp/yr**. Conversion: `vol_%_at_T = (bbg_value / 100) × √T` where T = expiry in years.

**Skew (γ₁):** Not fetched from Bloomberg. Derived from the same heuristic as the frontend: `γ₁ = BASE_SKEW[ccy] − 0.08 × √T`. Fetching OTM swaption vols to extract the implied skew is a planned future enhancement.

#### API response shape

```json
{
  "ccy": "USD",
  "tail": "10y",
  "data_source": "bloomberg" | "simulation",
  "params": {
    "1m": {"forward": 4.52, "vol": 0.22, "skew": -0.46},
    "3m": {"forward": 4.52, "vol": 0.38, "skew": -0.49},
    "6m": {"forward": 4.52, "vol": 0.53, "skew": -0.51},
    "1y": {"forward": 4.52, "vol": 0.75, "skew": -0.53},
    ...
  }
}
```

When API data arrives, the frontend refreshes both horizon panels with live parameters (preserving expiry selection). The header badge shows green "Live (Bloomberg)" or amber "Simulated parameters".

#### Gram-Charlier CDF (all computation in-browser)

See §7.6 for the full expansion. The user can override every parameter manually. Scenario breakpoints (Hard Landing / Soft Landing / No Landing / Re-acceleration) are user-defined rate levels; probabilities are CDF values at those breakpoints. Dual-horizon comparison (two expiries simultaneously) is supported.

See `BBG_HAVER_SETUP.md §6.4` for the ticker checklist.

---

## 7. Mathematical Foundations

### 7.1 Mixed-Frequency Dynamic Factor Model

State space form operating at daily frequency:

```
Transition:   f_t = A f_{t-1} + η_t,    η_t ~ N(0, Q)
Observation:  y_t = Λ f_t    + ε_t,    ε_t ~ N(0, R)
```

- **State** `f_t ∈ ℝ^K`: K=5 factors — Global Macro, Growth, Inflation, Employment, Wages
- **Observations** `y_t ∈ ℝ^M`: M macro series. NaN on all days except estimated release date. Kalman filter skips the update step when all observations are NaN, propagating on transition alone
- **Transition** `A = diag(ρ_1, ..., ρ_K)`: diagonal AR(1). Each ρ_k estimated from PCA scores, clipped to [0.5, 0.999]
- **Loadings** `Λ ∈ ℝ^{M×K}`: block-sparse. Column 0 (Global Macro) dense. Columns 1–4 non-zero only within their group
- **State noise** `Q = diag(σ²_k (1 − ρ²_k))`: AR(1) innovation variance
- **Observation noise** `R = diag(σ²_ε1, ..., σ²_εM)`: residual from PCA fit

Mixed frequency handled implicitly: monthly series appear once per month at estimated release date; quarterly once per quarter. AR(1) dynamics interpolate daily factors between releases.

### 7.2 Kalman Filter and RTS Smoother

**File:** `backend/dfm.py`

**Forward pass:**
```
Prediction:
  f_{t|t-1} = A f_{t-1|t-1}
  P_{t|t-1} = A P_{t-1|t-1} A' + Q

Update (only non-NaN rows of y_t):
  S_t      = Λ_obs P_{t|t-1} Λ_obs' + R_obs
  K_t      = P_{t|t-1} Λ_obs' S_t⁻¹
  f_{t|t}  = f_{t|t-1} + K_t (y_obs − Λ_obs f_{t|t-1})
  P_{t|t}  = (I − K_t Λ_obs) P_{t|t-1}

All NaN: f_{t|t} = f_{t|t-1},  P_{t|t} = P_{t|t-1}
```

Log-likelihood accumulated: `loglik += −½ (d log 2π + log|S_t| + v_t' S_t⁻¹ v_t)`.

**Backward pass (RTS smoother):**
```
G_t      = P_{t|t} A' P_{t+1|t}⁻¹
f_{t|T}  = f_{t|t} + G_t (f_{t+1|T} − f_{t+1|t})
P_{t|T}  = P_{t|t} + G_t (P_{t+1|T} − P_{t+1|t}) G_t'
```

Initial state: `f_0 = 0`, `P_0 = 10I` (diffuse prior).

### 7.3 Block-PCA Initialisation

**Helper: `_block_pca_1(Y_std, cols, primary_col, primary_sign)`**
1. Compute within-group covariance; extract leading eigenvector
2. Sign-normalise: if `loading[primary_col] × primary_sign < 0`, flip
3. Return score `F[T]` and full-length loading vector (zeros outside `cols`)

**Pipeline:**
1. Forward-fill `Y_daily` (LOCF) → `Y_ffill`
2. Standardise by `nanmean`/`nanstd` of actual observations → `Y_std`
3. Block-PCA per named factor → sparse loadings, `F_init[:,1:5]`
4. Full-panel PCA on all M columns → dense loadings, `F_init[:,0]`
5. Un-standardise: `Λ[m,k] = Λ_std[m,k] × col_std[m]`
6. AR(1) per factor, clipped; set `Q = diag(σ²_k(1−ρ²_k))`, `R` from residuals

### 7.4 Par Curve Bootstrap

Used in `swaps_rv.py` (OIS rates) and `fair_value_models.py` (ESTR forwards).

Input: par swap rates at available tenors → cubic-spline interpolated to all integers 1..30.

```
D[0] = 1;  annuity[0] = 0
For n = 1, 2, ..., 30:
    r_n = par_rate[n] / 100
    D[n] = (1 − r_n × annuity[n−1]) / (1 + r_n)
    annuity[n] = annuity[n−1] + D[n]

Forward par rate (s-start, t-tenor):
    f(s,t) = (D[s] − D[s+t]) / Σ_{k=1}^{t} D[s+k]   × 100

1-year carry (receiver convention):
    carry(s,t) = f(s, t) − f(s−1, t)   [in bps]
```

Positive carry = receiver gains as the forward rolls down an upward-sloping curve.

**ZC HICPxT forwards** (same D[] from HICP spot outrights):
```
hicp_fwd(s, t) = ((1 + r_{s+t})^{s+t} / (1 + r_s)^s)^{1/t} − 1
```

### 7.5 Elastic Net Fair Value

```
y_t = β_0 + Σ_j β_j x_{j,t} + ε_t

min_β  ||y − Xβ||² + λ [α ||β||₁ + (1−α)/2 ||β||²]
```

`α = 0.5` (equal L1/L2). `lambda` chosen by ElasticNet's default regularisation path with `alpha=0.01` in sklearn. Features are standardised (zero mean, unit variance on training window) before fitting; raw coefficients stored after inverse-scaling.

Rolling window: 500 days. Refit daily. OOS prediction: train on [t-500, t-1], predict at t. No lookahead bias.

**Rolling OOS R² vs random walk benchmark:**
```
OOS_R²(t) = 1 − SS_res_oos(t) / SS_tot(t)        rolling 252-day window
RW_R²(t)  = 1 − SS_res_rw(t)  / SS_tot(t)        benchmark: predict y[t] = y[t-1]
```

A model with OOS R² > RW R² is beating a random walk in sample — a meaningful bar.

### 7.6 Gram-Charlier Option CDF

```
f(x) = φ(x) [1 + (γ₁/6) H₃(x) + (γ₂/24) H₄(x)]
```

`φ(x)` = standard normal PDF, `H₃(x) = x³ − 3x`, `H₄(x) = x⁴ − 6x² + 3`. `γ₁` = skewness, `γ₂` = excess kurtosis. CDF obtained by integration. ATM implied vol sets the distributional width.

### 7.7 CTA Signal and Position Sizing

Signal at lookback L:
```
signal_L(t) = [series(t) − series(t-L)] / [σ_ann(t) × √(L/252)]
```

where `σ_ann(t) = rolling_std(series.diff(), 63) × √252`. Result clipped to [−5, +5].

Composite: `z(t) = mean(signal_L for L in {21, 63, 126, 252})`.

Position: `p(t) = clip(VOL_TARGET × z(t) / σ_ret(t), −8, 8)` where `σ_ret(t) = rolling_std(pct_change, 63) × √252` and `VOL_TARGET = 0.10`.

### 7.8 Seasonality Statistics

For a bin containing n daily returns `{r_1, ..., r_n}`:

```
mean    = (1/n) Σ r_i
std     = √(Σ(r_i − mean)² / (n−1))
t_stat  = mean / (std / √n)
p_value = 2 × Pr(T_{n-1} > |t_stat|)   two-sided
win_rate = #{r_i > 0} / n
```

The t-test assumes returns within a bin are i.i.d. — an approximation given serial correlation in financial time series, so p-values should be treated as indicative.

---

## 8. API Reference

All routes require `Authorization: Bearer <JWT>` except `/api/auth/login`.

### Auth

| Method | Path | Description |
|---|---|---|
| POST | /api/auth/login | Exchange credentials for JWT |
| GET | /api/me | Current user info |
| GET | /api/dashboard | Dashboard config from dashboard_config.yaml |

### Regional Heatmaps

Replace `{region}` with: `euro-area`, `uk`, `us`, `japan`, `canada`, `sweden`, `norway`, `switzerland`, `australia`, `new-zealand`.

| Method | Path | Description |
|---|---|---|
| GET | /api/tools/{region}-heatmap/factors | Daily macro factor time series |
| GET | /api/tools/{region}-heatmap/yield-pca | Yield PCs, loadings, variance explained |
| GET | /api/tools/{region}-heatmap/pc-regressions | OLS betas: yield PCs on macro factors |
| GET | /api/tools/{region}-heatmap/fair-value | 10y yield: actual, PCA fit, macro FV, rich/cheap bps |

### Other Tools

| Method | Path | Params | Description |
|---|---|---|---|
| GET | /api/tools/global-yields | — | 24-country 10y PCA: factors, table, residuals |
| GET | /api/tools/fair-value-models | — | HICPxT FV models + data_source flag |
| GET | /api/tools/swaps-rv | currency, date | OIS RV snapshot |
| GET | /api/tools/seasonality/data | expression, start | Evaluate BBG expression → time series |
| POST | /api/tools/seasonality/stats | {dates[], values[]} | Seasonal statistics (all bins) |
| POST | /api/tools/seasonality/heatmap | {dates[], values[]} | Month × DOW mean return matrix |
| POST | /api/tools/seasonality/backtest | {dates[], values[], rule} | Rule-based backtest PnL + metrics |
| GET | /api/tools/print-analysis/print-vs-consensus | ticker, start | Release history vs consensus |
| POST | /api/tools/print-analysis/market-reaction | {market_ticker, releases[]} | Day-of-release market moves |
| GET | /api/tools/momentum/cta-signals | ticker, start | Multi-lookback CTA signals + position |
| GET | /api/tools/inflation-pca/{curve_id} | — | PCA + butterflies for ILB curve (btpei/oatei/dbrei/uki) |
| GET | /api/tools/option-cdf/{ccy}/{tail} | — | Swaption fwd rate + ATM vol table for all expiries |

---

## 9. Frontend

**Framework:** React 18 + TypeScript + Vite
**Router:** React Router v6
**Charting:** Recharts
**Styling:** Tailwind CSS (dark theme; `#080d1a` background)

### Route structure

```
/                              → redirect to /dashboard
/login                         → Login.tsx
/dashboard                     → Dashboard.tsx (protected)
/tools/euro-area-heatmap       → EuroAreaHeatmap.tsx
/tools/uk-heatmap              → UKHeatmap.tsx
/tools/us-heatmap              → USHeatmap.tsx
/tools/japan-heatmap           → JapanHeatmap.tsx
/tools/canada-heatmap          → CanadaHeatmap.tsx
/tools/sweden-heatmap          → SwedenHeatmap.tsx
/tools/norway-heatmap          → NorwayHeatmap.tsx
/tools/switzerland-heatmap     → SwitzerlandHeatmap.tsx
/tools/australia-heatmap       → AustraliaHeatmap.tsx
/tools/new-zealand-heatmap     → NewZealandHeatmap.tsx
/tools/global-yields           → GlobalYields.tsx
/tools/fair-value-models       → FairValueModels.tsx
/tools/inflation-pca           → InflationPCA.tsx
/tools/option-derived-cdf      → OptionDerivedCDF.tsx
/tools/swaps-rv                → SwapsRV.tsx
/tools/seasonality-backtester  → SeasonalityBacktester.tsx
/tools/print-analysis          → PrintAnalysis.tsx
/tools/momentum                → Momentum.tsx
/tools/positioning             → Positioning.tsx
```

Protected routes wrapped in `ProtectedRoute` HOC: reads JWT from `localStorage`, redirects to `/login` if absent.

### Synthetic vs live data

Most frontend pages are self-contained — they produce deterministic synthetic data in-browser (seeded mulberry32 RNG or sin/cos functions) and make no API calls. Pages that call the backend:

| Page | API call | On what trigger |
|---|---|---|
| All 10 heatmap pages | 4 endpoints each (`/factors`, `/yield-pca`, `/pc-regressions`, `/fair-value`) | On mount |
| `SwapsRV.tsx` | `/api/tools/swaps-rv` | On currency change |
| `SeasonalityBacktester.tsx` | `/api/tools/seasonality/*` | On user action |
| `PrintAnalysis.tsx` | `/api/tools/print-analysis/*` | On user action |
| `Momentum.tsx` | `/api/tools/momentum/cta-signals` | On ticker change |
| `InflationPCA.tsx` | `/api/tools/inflation-pca/{curve_id}` | On curve change |
| `OptionDerivedCDF.tsx` | `/api/tools/option-cdf/{ccy}/{tail}` | On ccy/tail change |

Pages that remain fully synthetic (no backend call): `Positioning.tsx`, `InflationFixingsMonitor.tsx`.

All API calls use `Authorization: Bearer <token>` from `localStorage.getItem('access_token')`. When the API call fails or returns no data, pages fall back gracefully to their in-browser synthetic data — the UI never shows an error state.

**TypeScript errors are only caught at build time:** always run `cd frontend && npm run build` after modifying any `.tsx` file.

### Heatmap page structure

Each regional heatmap page (~1,200 lines) is a single self-contained `.tsx` file. The page combines:
- In-browser Jacobi PCA on synthetic yield data (for the yield PCA section, used as placeholder until API data loads)
- API calls to the 4 heatmap endpoints for macro factor and fair value sections
- Static `GROUPS_META` array with indicator metadata and z-score display parameters
- Recharts charts (`LineChart` for time series, `BarChart` for PC loadings)

Key styling constants: `cardStyle`, `stickyBg = '#080d1a'`. Z-score colour thresholds: |z| > 2 dark, |z| > 1 medium, |z| ≤ 1 light.

---

## 10. Dashboard Configuration

**File:** `dashboard_config.yaml`

Controls the dashboard landing page. Read on every API request — changes take effect immediately.

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

To add a tool: add an entry under the relevant category. A route in `App.tsx` and a page in `frontend/src/pages/` must also exist. To add a category: new top-level entry; use `tools: []` for placeholders.

---

## 11. Running Locally

**Prerequisites:** Python 3.12+, Node 20+, optionally Bloomberg Terminal or Haver DLX.

```bash
# Backend
cd backend
pip install -r requirements.txt
python create_user.py <username> <password> "<Full Name>"

# Simulation (default)
uvicorn main:app --reload --port 8000

# Bloomberg
ANALYTICS_DATA_SOURCE=bloomberg uvicorn main:app --reload --port 8000

# Haver
ANALYTICS_DATA_SOURCE=haver HAVER_PATH=/path/to/haver uvicorn main:app --reload --port 8000
```

```bash
# Frontend
cd frontend
npm install
npm run dev        # http://localhost:5173, proxies /api → :8000
npm run build      # TypeScript compile + Vite build → frontend/dist/
```

```bash
# Production
cd frontend && npm run build
cd ../backend && python main.py   # API + static files at http://localhost:8000
```

```bash
# Tests
cd backend && pytest tests/test_analytics.py -v
```

---

## 12. Extending the Hub

### Adding a new tool

1. **Backend:** `backend/my_tool.py` — precompute at module level, expose via getter function
2. **API:** import getter in `main.py`, add route under `/api/tools/my-tool`
3. **Frontend:** `frontend/src/pages/MyTool.tsx`, add route in `App.tsx`
4. **Dashboard:** add entry in `dashboard_config.yaml`

### Adding a regional heatmap

The pattern is fully established. See `CLAUDE.md` for the step-by-step guide (series catalogue, heatmap module, 4 API routes, dashboard entry, frontend page using 4-chunk `cat >>` append approach, App.tsx route).

### Adding a series to an existing DFM factor

1. Add entry to `series_catalogue_{region}.json` with next available `dfm_col_index`
2. Set `dfm_factor`, `dfm_sign`, `dfm_primary` (false unless replacing anchor), `typical_lag_days`, `frequency`, tickers
3. Update `M_MACRO` constant in the heatmap module. `_GROUP_COLS` rebuilds automatically from catalogue.

### Adding a new DFM factor (changes K)

1. Add series with new `dfm_factor` name in catalogue
2. Increment `K`, add name to `FACTOR_NAMES` in heatmap module
3. Add to `_NAMED_FACTORS` list; update `_YIELD_FACTOR_LOADINGS` for the new column

### Adding a new catalogue series

Edit `series_catalogue_{region}.json`. No code changes — fetcher resolves from catalogue automatically at next restart.
