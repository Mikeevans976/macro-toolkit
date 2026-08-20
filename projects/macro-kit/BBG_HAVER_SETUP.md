# Bloomberg / Haver Data Setup Guide

Complete reference for switching the analytics platform from simulated data to live Bloomberg or Haver feeds, understanding how each data pipeline works, and knowing what tickers need to be confirmed.

---

## How tickers are defined — read this first

There are **two distinct patterns** in this codebase. Knowing which applies to a tool tells you exactly where to look or edit.

### Pattern 1 — Series catalogue JSON (heatmap tools)

Used by: Euro Area, UK, US, Japan, Canada, Sweden, Norway, Switzerland, Australia, New Zealand heatmaps.

Tickers live in `backend/data/series_catalogue_<region>.json`. Each entry has a `bloomberg_ticker` and optionally a `haver_mnemonic`:

```json
{
  "id": "ea_gdp_yoy",
  "bloomberg_ticker": "EUGNEMUQ Index",
  "haver_mnemonic": "EUGDP@EUDATA",
  "dfm_col_index": 0
}
```

The shared `get_fetcher("bloomberg")` abstraction reads the catalogue, resolves tickers, and calls `blp.bdh()`. **To change a ticker for any heatmap series, edit the JSON — not the Python.**

### Pattern 2 — Hardcoded in the module (analytics tools)

Used by: Swaps RV, EGB RV, HICP Fixings Monitor, Fair Value Models, Global Yields, Inflation PCA, Option-Implied CDF.

Tickers are defined as constants directly inside the Python module and call `blp.bdh()` or `blp.bdp()` independently — no catalogue involved. **To change a ticker, edit the Python file.**

| Tool | File | Ticker location |
|------|------|----------------|
| Swaps RV | `backend/swaps_rv.py` | `_OIS_TICKERS`, `_VOL_TICKERS` |
| EGB RV | `backend/egb_rv.py` | `_YIELD_TICKERS`, `_ASW_TICKERS`, `_ESTR_TICKER`, `_VOL_TICKER` |
| HICP Fixings | `backend/hicp_fixings.py` | `EUSWIF{n}/EUSWIT{n} Comdty` constructed programmatically |
| Fair Value Models | `backend/fair_value_models.py` | inline ticker dict in `_fetch_live_data()` |
| Global Yields | `backend/global_yields.py` | inline ticker dict |
| Inflation PCA | `backend/inflation_pca.py` | inline ticker dicts per curve |
| Option-Implied CDF | `backend/option_derived_cdf.py` | inline ticker dicts |

### Which fetch method each pattern uses

| Method | What it does | Used by |
|--------|-------------|---------|
| `blp.bdh(tickers, field, start, end)` | Historical time series | Most tools |
| `blp.bdp(tickers, field)` | Point-in-time snapshot (no date range) | HICP Fixings only |

---

## Table of Contents

1. [Quick Start](#1-quick-start)
2. [Architecture Overview](#2-architecture-overview)
3. [Tool-by-Tool Status](#3-tool-by-tool-status)
4. [Data Pipeline Deep Dives](#4-data-pipeline-deep-dives)
5. [Series Catalogues](#5-series-catalogues)
6. [Ticker Checklists](#6-ticker-checklists)
7. [Troubleshooting](#7-troubleshooting)

---

## 1. Quick Start

### Switch to Bloomberg

Bloomberg Terminal must be open and logged in. `blpapi` (or `xbbg`) must be installed.

```bash
pip install xbbg          # if not already installed
cd backend
ANALYTICS_DATA_SOURCE=bloomberg uvicorn main:app --reload --port 8000
```

### Switch to Haver

Haver DLX must be installed. Works on Windows only (COM interface).

```bash
pip install Haver
cd backend
ANALYTICS_DATA_SOURCE=haver HAVER_PATH=/path/to/haver/databases uvicorn main:app --reload --port 8000
```

### Simulation (default)

No external data needed. All tools produce deterministic synthetic data.

```bash
cd backend
uvicorn main:app --reload --port 8000
# or equivalently:
ANALYTICS_DATA_SOURCE=csv uvicorn main:app --reload --port 8000
```

### Per-tool override

`ANALYTICS_DATA_SOURCE` is read at **module import time** by each backend module. A single env var controls all tools simultaneously. There is no per-tool override mechanism — to test one tool with live data, set the env var and restart.

---

## 2. Architecture Overview

### The pluggable fetcher (`backend/data_fetcher.py`)

All live data flows through a single abstraction:

```python
from data_fetcher import get_fetcher

fetcher = get_fetcher("bloomberg")          # or "haver"
fetcher = get_fetcher("haver", catalogue_path="data/series_catalogue_uk.json",
                                haver_path="/path/to/haver")
```

`get_fetcher()` returns a `BloombergFetcher` or `HaverFetcher`, both exposing:

```python
data: dict[str, pd.Series] = fetcher.fetch(
    series_ids=["ea_gdp_yoy", "ea_cpi_yoy"],   # internal IDs from catalogue
    start="2010-01-01",
    end="2025-06-30",
    field="PX_LAST",                             # Bloomberg field (ignored by Haver)
)
```

The fetcher resolves `series_ids` to vendor tickers via the **series catalogue** JSON. Series without a ticker for the requested source are silently skipped.

### The series catalogue

Each regional heatmap (and the EA model) has a JSON catalogue in `backend/data/`:

| File | Used by |
|------|---------|
| `series_catalogue.json` | Euro Area heatmap, Global Yields, Fair Value Models |
| `series_catalogue_uk.json` | UK heatmap |
| `series_catalogue_us.json` | US heatmap |
| `series_catalogue_jp.json` | Japan heatmap |
| `series_catalogue_ca.json` | Canada heatmap |
| `series_catalogue_se.json` | Sweden heatmap |
| `series_catalogue_no.json` | Norway heatmap |
| `series_catalogue_ch.json` | Switzerland heatmap |
| `series_catalogue_au.json` | Australia heatmap |
| `series_catalogue_nz.json` | New Zealand heatmap |

Each JSON entry looks like:

```json
{
  "id": "ea_core_hicp_yoy",
  "name": "Core HICP YoY (%)",
  "ticker_bloomberg": "ECCPEXFE Index",
  "ticker_haver": "ECCPEXFE@EUDATA",
  "source": "bloomberg",
  "frequency": "monthly",
  "typical_lag_days": 30,
  "dfm_col_index": 14,
  "dfm_factor": "Inflation",
  "dfm_sign": 1,
  "dfm_primary": false,
  "role": "dfm"
}
```

Key fields:
- `ticker_bloomberg` / `ticker_haver` — `null` means not available from that source; series is skipped
- `frequency` — `"daily"`, `"monthly"`, or `"quarterly"`
- `typical_lag_days` — used to estimate the release date for Kalman filter placement
- `dfm_col_index` — column position in the DFM `Y` matrix (0-indexed, up to M-1)
- `dfm_factor` — which macro factor this series loads on (`"Growth"`, `"Inflation"`, `"Employment"`, `"Wages"`)
- `role` — `"dfm"` (macro DFM input), `"market_data"` (yield tenors), `"fair_value"` (FV model inputs)

### Graceful degradation

Every live-data function follows this pattern:

```python
def _fetch_yield_data(start, end):
    source = os.environ.get("ANALYTICS_DATA_SOURCE", "csv").lower()
    if source in ("csv", "simulation"):
        return None
    try:
        fetcher = get_fetcher(source)
        data = fetcher.fetch(_YIELD_SERIES_IDS, start=start, end=end)
        # ... process ...
        return yield_matrix   # shape [T_daily, N_tenors]
    except Exception:
        return None
```

Callers check `if result is not None` and fall back to simulation. **No tool crashes if data is unavailable** — it degrades to synthetic output.

### Module-level precomputation

All heatmap modules precompute at **import time** (i.e., on server startup):

```
import euro_area_heatmap
  → tries to fetch macro data (Block 1)
  → runs Kalman smoother → FACTORS_SMOOTH, FACTORS_FILT
  → tries to fetch yield data (Block 2)
  → runs PCA → BUND_YIELDS, PC_LOADINGS, etc.
  → caches results in module-level globals
```

The API functions (`get_daily_factors()`, `get_yield_pca()`, …) simply serialize these cached globals. There is no per-request re-fetch. **Restart the server to pick up new data.**

---

## 3. Tool-by-Tool Status

### Status legend

| Symbol | Meaning |
|--------|---------|
| ✅ Live | Full live pipeline implemented; switch env var to activate |
| ⚠️ Partial | Some data blocks live, others still simulated |
| ❌ Simulated | No live pipeline; all data synthetic |
| 🔧 Needs tickers | Pipeline implemented but some tickers unconfirmed |

---

### 3.1 Euro Area Heatmap

**File:** `backend/euro_area_heatmap.py`  
**Catalogue:** `backend/data/series_catalogue.json`  
**Status:** ⚠️ Partial (Block 1 live ✅, 32 tickers missing 🔧)

**Block 1 — Macro DFM**

60 monthly macro series → Kalman smoother → 5 daily factors (Global Macro, Growth, Inflation, Employment, Wages).

```python
# Fetched via macro_data_loader.load_macro_data()
# Reads series where dfm_col_index is set (0..59)
# Controlled by ANALYTICS_DATA_SOURCE
```

Pipeline: `get_fetcher(source)` → `fetcher.fetch(series_ids)` → `macro_data_loader.load_macro_data()` → `dfm.kalman_smoother()` → `FACTORS_SMOOTH [T_daily, 5]`

Fallback: if `has_data=False` → 5-factor deterministic simulation.

**Block 2 — Bund Yield PCA**

8 Bund tenors (2/3/5/7/10/15/20/30y) fetched independently:

```python
_YIELD_SERIES_IDS = ["bund_2y", "bund_3y", "bund_5y", "bund_7y",
                     "bund_10y", "bund_15y", "bund_20y", "bund_30y"]

def _fetch_yield_data(start, end):
    # fetches via get_fetcher(source), snaps to DAILY_DATES grid, ffill/bfill
    # returns np.ndarray [T_daily, 8] or None
```

PCA on daily yield changes → PC1 (level), PC2 (slope), PC3 (curvature). Each PC is regressed on Block 1 macro factors (OLS, no intercept).

**Missing tickers (action required):** See Section 6.1.

---

### 3.2 UK Heatmap

**File:** `backend/uk_heatmap.py`  
**Catalogue:** `backend/data/series_catalogue_uk.json`  
**Status:** ✅ Live (all 53 series have BBG tickers; 46 have Haver)

**Block 1:** 48 macro series, K=5 factors.  
**Block 2:** 5 Gilt tenors (2/5/10/20/30y):

```python
_YIELD_SERIES_IDS = ["gilt_2y", "gilt_5y", "gilt_10y", "gilt_20y", "gilt_30y"]
```

Bloomberg tickers in catalogue: `GUKG2 Index`, `GUKG5 Index`, `GUKG10 Index`, `GUKG20 Index`, `GUKG30 Index`.

---

### 3.3 US Heatmap

**File:** `backend/us_heatmap.py`  
**Catalogue:** `backend/data/series_catalogue_us.json`  
**Status:** ✅ Live (69/71 series have BBG tickers; 51 have Haver)

**Block 2:** UST 2/5/10/20/30y:

```python
_YIELD_SERIES_IDS_US = ["us_ust_2y", "us_ust_5y", "us_ust_10y", "us_ust_20y", "us_ust_30y"]
```

---

### 3.4 Japan Heatmap

**File:** `backend/japan_heatmap.py`  
**Catalogue:** `backend/data/series_catalogue_jp.json`  
**Status:** ✅ Live (56/58 series have BBG tickers; 35 have Haver)

**Block 2:** JGB 2/5/10/20/30y:

```python
_YIELD_SERIES_IDS_JP = ["jp_jgb_2y", "jp_jgb_5y", "jp_jgb_10y", "jp_jgb_20y", "jp_jgb_30y"]
```

---

### 3.5 Canada Heatmap

**File:** `backend/canada_heatmap.py`  
**Catalogue:** `backend/data/series_catalogue_ca.json`  
**Status:** ✅ Live (52/54 series have BBG tickers; 34 have Haver)

**Block 2:** CanGov 2/5/10/20/30y:

```python
_YIELD_SERIES_IDS_CA = ["ca_cangov_2y", "ca_cangov_5y", "ca_cangov_10y", "ca_cangov_20y", "ca_cangov_30y"]
```

---

### 3.6 Sweden Heatmap

**File:** `backend/sweden_heatmap.py`  
**Catalogue:** `backend/data/series_catalogue_se.json`  
**Status:** ✅ Live (50/52 series have BBG tickers; 29 have Haver)

**Block 2:** SGB 2/5/10/20/30y:

```python
_YIELD_SERIES_IDS_SE = ["se_sgb_2y", "se_sgb_5y", "se_sgb_10y", "se_sgb_20y", "se_sgb_30y"]
```

---

### 3.7 Norway Heatmap

**File:** `backend/norway_heatmap.py`  
**Catalogue:** `backend/data/series_catalogue_no.json`  
**Status:** ✅ Live (50/52 series have BBG tickers; 30 have Haver)

**Block 2:** NGB 2/5/10/20/30y:

```python
_YIELD_SERIES_IDS_NO = ["no_ngb_2y", "no_ngb_5y", "no_ngb_10y", "no_ngb_20y", "no_ngb_30y"]
```

---

### 3.8 Switzerland Heatmap

**File:** `backend/switzerland_heatmap.py`  
**Catalogue:** `backend/data/series_catalogue_ch.json`  
**Status:** ✅ Live (51/52 series have BBG tickers; 26 have Haver)

**Block 2:** Confederation bond 2/5/10/20/30y:

```python
_YIELD_SERIES_IDS_CH = ["ch_conf_2y", "ch_conf_5y", "ch_conf_10y", "ch_conf_20y", "ch_conf_30y"]
```

---

### 3.9 Australia Heatmap

**File:** `backend/australia_heatmap.py`  
**Catalogue:** `backend/data/series_catalogue_au.json`  
**Status:** ✅ Live (51/52 series have BBG tickers; 28 have Haver)

**Block 2:** ACGB 2/5/10/20/30y:

```python
_YIELD_SERIES_IDS_AU = ["au_acgb_2y", "au_acgb_5y", "au_acgb_10y", "au_acgb_20y", "au_acgb_30y"]
```

---

### 3.10 New Zealand Heatmap

**File:** `backend/new_zealand_heatmap.py`  
**Catalogue:** `backend/data/series_catalogue_nz.json`  
**Status:** ✅ Live (51/52 series have BBG tickers; 16 have Haver)

**Block 2:** NZGB 2/5/10/20/30y:

```python
_YIELD_SERIES_IDS_NZ = ["nz_nzgb_2y", "nz_nzgb_5y", "nz_nzgb_10y", "nz_nzgb_20y", "nz_nzgb_30y"]
```

---

### 3.11 Swaps RV

**File:** `backend/swaps_rv.py`  
**Status:** ✅ Live (Bloomberg only; no Haver path)

Live pipeline implemented via `_fetch_from_bbg(ccy, start, end)`. Uses `blpapi` directly (not the catalogue-based fetcher).

**Supported currencies:** EUR (ESTR OIS), GBP (SONIA), USD (SOFR)

**Key tickers:**

```python
_OIS_TICKERS = {
    "EUR": {n: f"EUSWF{n} Curncy" for n in [1..30]},    # ESTR OIS par rates
    "GBP": {n: f"BPSWS{n} Curncy" for n in [1..30]},    # SONIA par rates
    "USD": {n: f"USOSFR{n} Curncy" for n in [1..30]},   # SOFR par rates
}
_VOL_TICKERS = {
    "EUR": {"1m10y": "EUSV0001 Index", "1y10y": "EUSV0110 Index"},
    "GBP": {"1m10y": "BPSV0001 Index", "1y10y": "BPSV0110 Index"},
    "USD": {"1m10y": "USSV0001 Index", "1y10y": "USSV0110 Index"},
}
```

**Field:** `PX_LAST` for all series (OIS rates in %, swaption vols in bps normal vol).

**Bootstrap logic:** Par rates → cubic-spline interpolation → discount factors → forward rates. This produces the 46 forward labels per currency (e.g., `1Y1Y`, `2Y1Y`, ..., `20Y10Y`).

**Fallback:** CSV files (`eur_estr_forwards.csv`, `gbp_sonia_forwards.csv`, `usd_sofr_forwards.csv`, etc.) in `backend/data/`.

**Entry point:** `compute_rv(currency="EUR", as_of_date=None)` — called by the API route.

---

### 3.12 Fair Value Models

**File:** `backend/fair_value_models.py`  
**Status:** ✅ Live (Bloomberg only; no Haver path)

Live pipeline implemented via `_fetch_live_data(start, end)`. Controlled by `ANALYTICS_DATA_SOURCE="bloomberg"`.

**All 28 Bloomberg tickers:**

| Internal key | Bloomberg ticker | Role |
|---|---|---|
| `EUSWI1`–`EUSWI30` | `EUSWI{n} Curncy` | HICPxT inflation swap spot outrights (1–30y) |
| `EESWE1`–`EESWE30` | `EUSWF{n} Curncy` | ESTR OIS par rates (1–30y) |
| `Brent` | `CO1 Comdty` | Brent crude front contract |
| `Gas` | `TTF1 Comdty` | TTF gas front contract |
| `BCOM_raw` | `BCOM Index` | Bloomberg Commodity Index |
| `EUR003M` | `EUR003M Index` | 3m Euribor |
| `EUR_TWI` | `EURR002W Index` | EUR trade-weighted index (optional) |
| `GSEAFCI` | `GSEAFCI Index` | GS Euro Area FCI (optional; needs GS subscription) |
| `ITRX5Y` | `ITRXEBE5 Index` | iTraxx Europe 5y CDS (optional) |
| `CESIEUR` | `CESIEUR Index` | Citi Economic Surprise Index EUR (optional) |
| `SMOVEU1M` | `EUSV0001 Index` | 1m10y EUR swaption vol (optional) |

**Required vs optional:**

- **Required** — if any of these are missing, the entire live pipeline falls back to simulation: `EUSWI1`, `EUSWI2`, `EUSWI5`, `EUSWI10`, `EUSWI20`, `EUSWI30`, `EESWE1`–`EESWE30`, `Brent`, `Gas`, `BCOM_raw`, `EUR003M`
- **Optional** — set to zero column if absent; model assigns near-zero coefficient: `EUR_TWI`, `GSEAFCI`, `ITRX5Y`, `CESIEUR`, `SMOVEU1M`

**Derived variables (computed in `_fetch_live_data`):**

```python
log_Brent = log(Brent)
log_Gas   = log(Gas)
log_BCOM  = log(BCOM_raw)
slope_3m10y = EESWE10 - EUR003M          # 3m10y OIS slope

# Bootstrap ESTR discount factors per row:
D[t]  = _estr_discount_factors({1: r1, 2: r2, 5: r5, 10: r10, ...})
# ESTR forward rates: 1Y1Y, 2Y1Y, ..., 20Y10Y
estr_fwd(s, t) = ((D[s] / D[s+t])^(1/t)) - 1

# HICPxT forwards from spot outrights (ZC algebra):
# hicp_fwd(s, t) = ((1+r_far)^(s+t) / (1+r_near)^s)^(1/t) - 1
HICP_2Y1Y = hicp_fwd(EUSWI2, EUSWI3, s=2, t=1)
HICP_2Y2Y = hicp_fwd(EUSWI2, EUSWI4, s=2, t=2)
```

**14 models** (7 outright, 7 forward): Each fitted with Rolling ElasticNet (500-day window, OOS prediction, z-score on residuals). When live data succeeds, the module-level `DATES` and `T` constants are overridden to the live date range.

---

### 3.13 Global Yields

**File:** `backend/global_yields.py`  
**Status:** ✅ Live (via catalogue-based fetcher)

24 10y government bond yields fetched via series IDs in `backend/data/series_catalogue.json` (look for `role: "global_yields"`).

**Pipeline:** `get_fetcher(source)` → `fetcher.fetch(24 series_ids)` → daily PCA → PC1 (global level), PC2 (DM-specific), PC3 (EM-idiosyncratic) + z-score residuals (rich/cheap vs global factor).

**Fallback:** Deterministic simulation.

---

### 3.14 Seasonality Backtester

**File:** `backend/seasonality_backtester.py`  
**Status:** ✅ Live (Bloomberg only; requires Terminal)

This tool is **Bloomberg-native** — it accepts arbitrary Bloomberg arithmetic expressions typed by the user (e.g., `GDBR10 Index - GDBR2 Index`) and evaluates them using `blpapi`.

```python
def fetch_bbg_expression(expression: str, start: str) -> dict:
    # parses expression → extracts tickers → fetches PX_LAST → evaluates arithmetic
    # returns {expression, dates[], values[], n_obs}
```

**No catalogue needed.** Any valid Bloomberg ticker expression works.

**Fallback:** Synthetic monthly releases seeded by expression hash (if `blpapi` not available).

**API routes:**
- `GET /api/tools/seasonality/data?expression=...&start=...` — fetch time series
- `POST /api/tools/seasonality/stats` — compute seasonal statistics
- `POST /api/tools/seasonality/heatmap` — return matrix
- `POST /api/tools/seasonality/backtest` — run rule-based backtest

---

### 3.15 Print Analysis

**File:** `backend/print_analysis.py`  
**Status:** ✅ Live (Bloomberg only)

Fetches economic release history and Bloomberg consensus for any ticker using `PX_LAST` + survey fields:

```python
fields = ["PX_LAST", "ECO_SURVEY_AVG", "ECO_SURVEY_MEDIAN",
          "ECO_SURVEY_HIGH", "ECO_SURVEY_LOW", "BN_SURVEY_NUMBER"]
```

```python
def fetch_print_vs_consensus(ticker: str, start: str) -> dict:
    # returns: dates[], actuals[], consensus[], surprises[], n_obs

def fetch_market_reaction(market_ticker: str, releases: list) -> dict:
    # fetches market_ticker price series → computes T+0/T+1/T+5 returns around each print
```

**Fallback:** Synthetic monthly releases seeded by ticker hash.

---

### 3.16 Momentum (CTA Signals)

**File:** `backend/momentum.py`  
**Status:** ✅ Live (Bloomberg optional; simulation always available)

```python
def compute_cta_signals(ticker: str, start: str) -> dict:
    # tries _fetch_bloomberg(ticker, start) → PX_LAST
    # falls back to deterministic regime-switching simulation seeded by ticker hash
```

Lookbacks: 1M (21d), 3M (63d), 6M (126d), 12M (252d). Vol window: 63d. Minimum history: 315d. All signals are volatility-scaled to 10% annualised target.

**Any Bloomberg price ticker works** — no catalogue needed.

---

### 3.17 Inflation PCA

**Files:** `backend/inflation_pca.py`, `frontend/src/pages/InflationPCA.tsx`  
**Status:** ⚠️ Backend wired, awaiting Bloomberg tickers

Backend module and API route are implemented. The frontend fetches `/api/tools/inflation-pca/{curve_id}` on curve change and uses live data when available, falling back independently per yield type.

**Data pipeline:**

| Yield type | Source | Tickers |
|---|---|---|
| Real yield | Bloomberg `YLD_YTM_MID` | `ITIL28 Index`, `FROB27I Index`, `DBIBL26 Index`, `UKTIIL27 Index`, … (per bond) |
| Breakeven | Inflation swap interpolated at bond maturity | EUR: `EUSWI{n} Curncy`; GBP: `BPSWIS{n} Curncy` (n = 1–30) |
| IOTA | real_yield + infl_swap(mat) − OIS(mat) | EUR OIS: `EUSWF{n} Curncy`; GBP: `BPSWS{n} Curncy` (n = 1–30) |

**Fallback logic:** each yield type (real / breakeven / IOTA) falls back to simulation independently. If OIS fetch fails but real and infl swap succeed, IOTA uses simulation while real and breakeven show live data. The header badge shows green "Live (Bloomberg)" or amber "Simulated data" based on the `data_source` field returned by the API.

---

### 3.18 Option-Implied CDF

**Files:** `backend/option_derived_cdf.py`, `frontend/src/pages/OptionDerivedCDF.tsx`  
**Status:** ⚠️ Backend wired, awaiting Bloomberg ticker verification

Backend module and API route are implemented. The frontend fetches `/api/tools/option-cdf/{ccy}/{tail}` on every currency or tail change, then uses the live parameters to pre-populate forward rate and vol controls. All Gram-Charlier math remains in-browser — the backend only provides the market calibration inputs.

**What the backend fetches:**

| Data | Source | Tickers | BBG field |
|---|---|---|---|
| Par swap rates (→ forward rate proxy) | Bloomberg | `USSW{n}`, `EUSA{n}`, `BPSWS{n}` Curncy | `PX_LAST` |
| Swaption ATM normal vol (bp/yr) | Bloomberg | `USSN{exp}{tail}`, `EUSN{exp}{tail}`, `BPSN{exp}{tail}` Curncy | `PX_LAST` |

Bloomberg returns swaption vol in **bp/yr**. The backend converts: `vol_%_at_T = (bbg_value / 100) × √T` where T = expiry in years. This is the σ used in the Gram-Charlier expansion (§7.6 of DOCUMENTATION.md).

**Skew (γ₁):** Remains as a heuristic (`BASE_SKEW[ccy] − 0.08 × √T`) in both live and simulation paths. Fetching OTM swaption vols to derive implied skew is a planned enhancement.

**Fallback:** If Bloomberg is unavailable, the static mid-2025 calibration table (hardcoded in the module, mirrors the frontend `FWD_RATE` and `ANNUAL_VOL` constants exactly) is used. The response still returns `data_source: "simulation"` and the frontend falls back transparently.

See **Section 6.4** for the full ticker checklist.

---

### 3.19 Positioning

**File:** `frontend/src/pages/Positioning.tsx` (frontend-only)  
**Status:** ❌ Simulated (no backend)

Fully client-side with synthetic data. No backend pipeline planned.

---

### 3.20 Inflation Fixings Monitor

**Files:** `backend/hicp_fixings.py`, `frontend/src/pages/InflationFixingsMonitor.tsx`  
**API endpoint:** `GET /api/tools/inflation-fixings/eur`  
**Status:** 🔧 Needs tickers verified (pipeline implemented; tickers are standard but unconfirmed in live Terminal)

Fetches 24 EUR HICP monthly fixing levels via **BDP snapshot** (not BDH historical).

**Ticker convention:**
```
EUSWIF{n} Comdty   — F-series: 12-month cycle starting one year ahead of today
EUSWIT{n} Comdty   — T-series: following 12-month cycle
```
where `n` is the **calendar month number** (1=Jan … 12=Dec), not a sequential position.

**Example (today = Aug 2026):**
```
EUSWIF8  = Aug 2027  (nearest)
EUSWIF9  = Sep 2027
...
EUSWIF7  = Jul 2028  (12th)
EUSWIT8  = Aug 2028  (13th)
...
EUSWIT7  = Jul 2029  (24th)
```

**Fetch pattern — BDP, not BDH:**
```python
from bbg import blp
tickers = ["EUSWIF8 Comdty", "EUSWIF9 Comdty", ...]   # 24 tickers
df = blp.bdp(tickers, "PX_LAST")   # snapshot, no date range
```

This module does **not** use `get_fetcher()` or the series catalogue — it calls `blp.bdp()` directly.

Fallback: deterministic simulation based on current date and tenor position.

**To verify in Terminal:** type `EUSWIF8 Comdty <GO>` and check `PX_LAST` field.

---

### 3.21 EGB RV Monitor

**Files:** `backend/egb_rv.py`, `backend/egb_expressions_config.py`, `frontend/src/pages/EGBRV.tsx`  
**API endpoint:** `GET /api/tools/egb-rv`  
**Status:** 🔧 Needs tickers verified (yield and ESTR tickers reliable; ASW tickers unconfirmed)

Fetches ~60 days of daily data via **BDH** across three data blocks:

**Block 1 — Sovereign yields (9 countries × multiple tenors)**

| Country | Ticker format | Example |
|---------|--------------|---------|
| Bund | `GDBR{t} Index` | `GDBR10 Index` |
| OAT | `GFRN{t} Index` | `GFRN10 Index` |
| BTP | `GBTPGR{t} Index` | `GBTPGR10 Index` |
| Bonos | `GSPG{t}YR Index` | `GSPG10YR Index` |
| Belgium | `GBGB{t}YR Index` | `GBGB10YR Index` |
| Portugal | `GPTIT{t}YR Index` | `GPTIT10YR Index` |
| Netherlands | `GNETH{t}YR Index` | `GNETH10YR Index` |
| Austria | `GAGB{t}YR Index` | `GAGB10YR Index` |
| Finland | `GFINGB{t} Index` | `GFINGB10 Index` |

where `{t}` is tenor in years (2, 5, 10, 30 etc. per country).

**Block 2 — ESTR fixing**

```
ESTRON Index    field: PX_LAST
```

**Block 3 — Asset swap spreads ⚠️ UNVERIFIED — confirm before live use**

| Country | Ticker format | Tenors available |
|---------|--------------|-----------------|
| Bund | `DASW{t} Index` | 2, 5, 10, 30y |
| OAT | `FOASW{t} Index` | 2, 5, 10, 30y |
| BTP | `ITASW{t} Index` | 5, 10, 30y |
| Bonos | `SPASW{t} Index` | 5, 10y |
| Belgium | `BEASW{t} Index` | 10y |
| Netherlands | `NLASW{t} Index` | 10y |

**Block 4 — Vol (for carry normalisation)**

```
EUSV0001 Index   # EUR 1m10y swaption normal vol (bps)
```

This module does **not** use `get_fetcher()` or the series catalogue — it calls `blp.bdh()` directly via an internal `_fetch_from_bbg()` function.

Fallback: full simulation of all four blocks.

**To verify ASW tickers in Terminal:** type e.g. `DASW10 Index <GO>` and confirm the field `PX_LAST` returns a live spread in bps.

---

## 4. Data Pipeline Deep Dives

### 4.1 Macro DFM pipeline (all regional heatmaps)

```
series_catalogue_{region}.json
        │
        ▼
macro_data_loader.load_macro_data(daily_dates, M, catalogue_path)
        │  ─ reads dfm_col_index (0..M-1), dfm_factor, dfm_sign, typical_lag_days
        │  ─ fetches via get_fetcher(source)
        │  ─ monthly/quarterly → PeriodIndex → release dates = period_end + lag_days
        │  ─ places observations on DAILY_DATES grid (NaN elsewhere)
        │
        ▼
Y_daily: np.ndarray [T_daily, M]   ← sparse (NaN except ~monthly release dates)
        │
        ▼
dfm.kalman_smoother(Y_daily, params)
        │  ─ 5-factor Kalman filter + RTS smoother
        │  ─ handles missing data natively (NaN → covariance propagation)
        │  ─ block-PCA initialisation
        │
        ▼
FACTORS_SMOOTH: np.ndarray [T_daily, 5]   ← daily, interpolated macro factors
```

### 4.2 Yield PCA pipeline (all regional heatmaps)

```
series_catalogue_{region}.json  (entries with role="market_data")
        │
        ▼
_fetch_yield_data_{region}(start, end)
        │  ─ get_fetcher(source, catalogue_path=...)
        │  ─ fetcher.fetch(_YIELD_SERIES_IDS, start, end, field="PX_LAST")
        │  ─ snaps to DAILY_DATES via searchsorted
        │  ─ ffill → bfill to fill weekends/holidays
        │
        ▼
YIELDS: np.ndarray [T_daily, N_tenors]    ← in %, e.g. 2.54 = 2.54%
        │
        ▼
dY = np.diff(YIELDS, axis=0)              ← [T-1, N_tenors] daily changes
C  = dY.T @ dY / (T-2)                   ← covariance matrix
eigendecomposition(C) → PC loadings + variance explained
        │
        ▼
PC_SCORES: [T_daily, 3]   ← daily PC1/PC2/PC3 scores
        │
        ▼  OLS regression (no intercept)
FACTORS_SMOOTH[:, :] → PC_SCORES[:,i]    ← maps macro factors to yield PCs
        │
        ▼
FAIR_VALUE = LOADINGS @ (MACRO_PREDICTED_PCS)  ← reconstruct yield curve from macro
rich_cheap_bps = (ACTUAL_10Y - FAIR_VALUE_10Y) * 100
```

### 4.3 Swaps RV bootstrap pipeline

```
_OIS_TICKERS[ccy]  →  blp.bdh(tickers, "PX_LAST", start, end)
        │
        ▼
par_rates[date][tenor] in decimal (÷100)
        │
        ▼
_estr_discount_factors(par_rates)
  ─ CubicSpline over available tenors (1,2,3,4,5,10,15,20,30y)
  ─ interpolate to all tenors 1..30
  ─ bootstrap: D[0]=1; D[n] = (1 - r_n*Σ D[k]) / (1 + r_n)
        │
        ▼
forward_rate(s, t) = (D[s]/D[s+t])^(1/t) - 1
        │
        ▼  46 forward labels per ccy (1Y1Y, 2Y1Y, ..., 20Y10Y)
compute_rv(): carry, roll, z-scores, PCA-neutral butterflies
```

### 4.4 Fair Value Models bootstrap pipeline

```
_BBG_RAW tickers  →  blp.bdh(all tickers, "PX_LAST", "2004-01-01", today)
        │
        ▼
Per row (date):
  ─ rates /= 100
  ─ log_Brent = log(Brent); log_Gas = log(Gas); log_BCOM = log(BCOM)
  ─ slope_3m10y = EESWE10 - EUR003M
  ─ _estr_discount_factors({1:r1, 2:r2, 3:r3, 4:r4, 5:r5, 10:r10, 20:r20, 30:r30})
  ─ bootstrap ESTR forward rates (1Y1Y..20Y10Y)
  ─ HICP forwards from ZC algebra: ((1+r_far)^(s+t)/(1+r_near)^s)^(1/t) - 1
        │
        ▼
_VARS: dict[str, np.ndarray]   ← ~30 explanatory variables, T rows
        │
        ▼  14 models (one per HICPxT maturity/forward)
Rolling ElasticNet (window=500 days, l1_ratio=0.5)
  ─ fit on window[-500:], predict for today
  ─ z-score of today's residual vs 63-day window
        │
        ▼
get_fair_value_models_data() → model outputs, z-scores, data_source flag
```

---

## 5. Series Catalogues

### 5.1 How to update a ticker

Open the relevant catalogue JSON and update the entry:

```json
{
  "id": "ea_building_permits_yoy",
  "ticker_bloomberg": "EUBPRMOM Index",
  "ticker_haver": "BPEZM@EUDATA",
  "source": "bloomberg"
}
```

To mark a series as unavailable from external sources:

```json
{
  "id": "ea_eurocoin",
  "source": "derived",
  "ticker_bloomberg": null,
  "ticker_haver": null
}
```

Changes take effect on the next backend restart — no code changes needed.

### 5.2 Ticker coverage summary

| Catalogue | Total series | With BBG ticker | With Haver ticker |
|-----------|-------------|-----------------|-------------------|
| `series_catalogue.json` (EA) | 147 | 115 (78%) | 49 (33%) |
| `series_catalogue_uk.json` | 53 | 53 (100%) | 46 (87%) |
| `series_catalogue_us.json` | 71 | 69 (97%) | 51 (72%) |
| `series_catalogue_jp.json` | 58 | 56 (97%) | 35 (60%) |
| `series_catalogue_ca.json` | 54 | 52 (96%) | 34 (63%) |
| `series_catalogue_se.json` | 52 | 50 (96%) | 29 (56%) |
| `series_catalogue_no.json` | 52 | 50 (96%) | 30 (58%) |
| `series_catalogue_ch.json` | 52 | 51 (98%) | 26 (50%) |
| `series_catalogue_au.json` | 52 | 51 (98%) | 28 (54%) |
| `series_catalogue_nz.json` | 52 | 51 (98%) | 16 (31%) |

The DFM is tolerant of missing series — Kalman filter propagates factors on the transition equation alone for any NaN column. A model with 40/60 series populated still produces meaningful factors.

---

## 6. Ticker Checklists

### 6.1 Euro Area Heatmap — DFM series requiring PM input

| # | Series ID | Bloomberg | Haver | Action |
|---|-----------|-----------|-------|--------|
| 8 | `ea_us_current_activity_indicator` | MISSING | MISSING | Confirm if available; if not, set `source: "derived"` |
| 9 | `ea_cesi` | `CESIEUR Index` (unverified) | MISSING | PM to verify BBG ticker; find Haver mnemonic |
| 20 | `ea_building_permits_yoy` | MISSING | `BPEZM@EUDATA` ✓ | Find BBG ticker |
| 21 | `ea_eurocoin` | MISSING | MISSING | CEPR index — likely not on BBG/Haver; set `source: "derived"` |
| 26 | `ea_ces_inflation_exp_1y` | MISSING | MISSING | ECB CES survey — not on BBG; find Haver mnemonic if available |
| 33 | `ea_hicp_services_to_goods_ratio` | MISSING | MISSING | Derived ratio — set `source: "derived"`, compute from existing HICP series |
| 35 | `ea_hicp_weighted_median_yoy` | MISSING | MISSING | ECB internal measure — check availability |
| 43 | `ea_ces_inflation_exp_3y` | MISSING | MISSING | Same as 1y — ECB CES only |
| 44 | `ea_spf_lt_inflation_expectations` | `ECSPF5Y Index` (unverified) | MISSING | PM to verify |
| 48 | `ea_labour_participation_rate` | MISSING | `LFPEZQ@EUDATA` ✓ | Find BBG ticker |
| 49 | `ea_indeed_job_postings_yoy` | MISSING | MISSING | Indeed data — not on BBG/Haver; set `source: "derived"` |
| 56 | `ea_labour_productivity_yoy` | MISSING | `LPRODQ@EUDATA` ✓ | Find BBG ticker |
| 57 | `ea_indeed_wage_tracker_yoy` | MISSING | MISSING | Indeed — set `source: "derived"` |
| 58 | `ea_ecb_wage_tracker_excl_oneoffs` | MISSING | MISSING | ECB internal — check availability |
| 59 | `ea_ecb_wage_tracker_incl_oneoffs` | MISSING | MISSING | ECB internal — check availability |

All 45 other EA DFM series have confirmed tickers.

### 6.2 Fair Value Models — optional series

| Internal key | Bloomberg ticker | Note |
|---|---|---|
| `GSEAFCI` | `GSEAFCI Index` | GS Euro Area FCI — requires GS data subscription; zeros if absent |
| `EUR_TWI` | `EURR002W Index` | ECB EUR trade-weighted index — verify ticker |
| `ITRX5Y` | `ITRXEBE5 Index` | iTraxx Europe Crossover 5y — verify ticker |
| `CESIEUR` | `CESIEUR Index` | Citi CESI EUR — usually available |
| `SMOVEU1M` | `EUSV0001 Index` | 1m10y EUR swaption normal vol — should be available |

If any of these fail, they fall back to zero and the model self-adjusts (ElasticNet shrinks their coefficients toward zero).

### 6.3 Inflation PCA — tickers to verify in Bloomberg

**EUR curves (BTPei, OATei, DBRei):**

| Bond | Real yield BBG ticker | Field |
|------|----------------------|-------|
| BTPei 28 | `ITIL28 Index` | `YLD_YTM_MID` |
| BTPei 30 | `ITIL30 Index` | `YLD_YTM_MID` |
| BTPei 32 | `ITIL32 Index` | `YLD_YTM_MID` |
| BTPei 35 | `ITIL35 Index` | `YLD_YTM_MID` |
| BTPei 38 | `ITIL38 Index` | `YLD_YTM_MID` |
| BTPei 41 | `ITIL41 Index` | `YLD_YTM_MID` |
| BTPei 51 | `ITIL51 Index` | `YLD_YTM_MID` |
| OATei 27–47 | `FROB27I`–`FROB47I Index` | `YLD_YTM_MID` |
| DBRei 26–46 | `DBIBL26`–`DBIBL46 Index` | `YLD_YTM_MID` |
| EUR infl swaps 1–30y | `EUSWI{n} Curncy` | `PX_LAST` |
| EUR OIS 1–30y | `EUSWF{n} Curncy` | `PX_LAST` |

**GBP curve (UKi):**

| Bond | Real yield BBG ticker | Field |
|------|----------------------|-------|
| UKi 27 | `UKTIIL27 Index` | `YLD_YTM_MID` |
| UKi 30 | `UKTIIL30 Index` | `YLD_YTM_MID` |
| UKi 32 | `UKTIIL32 Index` | `YLD_YTM_MID` |
| UKi 35 | `UKTIIL35 Index` | `YLD_YTM_MID` |
| UKi 40 | `UKTIIL40 Index` | `YLD_YTM_MID` |
| UKi 47 | `UKTIIL47 Index` | `YLD_YTM_MID` |
| UKi 55 | `UKTIIL55 Index` | `YLD_YTM_MID` |
| GBP infl swaps 1–30y | `BPSWIS{n} Curncy` | `PX_LAST` |
| GBP OIS 1–30y | `BPSWS{n} Curncy` | `PX_LAST` |

---

### 6.4 Option-Implied CDF — tickers to verify in Bloomberg

**Par swap rate tickers (verify format: `SWDF <Go>` in Bloomberg):**

| Currency | Ticker format | Examples |
|---|---|---|
| USD | `USSW{n} Curncy` | `USSW2 Curncy`, `USSW10 Curncy`, `USSW30 Curncy` |
| EUR | `EUSA{n} Curncy` | `EUSA2 Curncy`, `EUSA10 Curncy`, `EUSA30 Curncy` |
| GBP | `BPSWS{n} Curncy` | `BPSWS2 Curncy`, `BPSWS10 Curncy`, `BPSWS30 Curncy` |

where `n` is the tenor without the 'y' suffix (e.g., `1`, `2`, `5`, `10`, `15`, `20`, `30`).

**Swaption ATM normal vol tickers (verify format: `SWVOL <Go>` or `VCUB <Go>` in Bloomberg):**

| Currency | Ticker format | Examples |
|---|---|---|
| USD | `USSN{exp}{tail} Curncy` | `USSN6M10Y Curncy`, `USSN1Y5Y Curncy`, `USSN3M30Y Curncy` |
| EUR | `EUSN{exp}{tail} Curncy` | `EUSN6M10Y Curncy`, `EUSN1Y5Y Curncy`, `EUSN3M30Y Curncy` |
| GBP | `BPSN{exp}{tail} Curncy` | `BPSN6M10Y Curncy`, `BPSN1Y5Y Curncy`, `BPSN3M30Y Curncy` |

Expiry codes: `1M`, `3M`, `6M`, `1Y`, `2Y`, `3Y`, `5Y`, `7Y`, `10Y`  
Tail codes: `1Y`, `2Y`, `5Y`, `10Y`, `15Y`, `20Y`, `30Y`

Bloomberg returns these values in **bp/yr** (normal vol convention). The backend divides by 100 to get %/yr, then multiplies by √T (expiry in years) to get the at-expiry σ used in the Gram-Charlier formula.

**Quick verification:**
```python
from bbg import blp
import pandas as pd
today = pd.Timestamp.today().strftime("%Y%m%d")
start = (pd.Timestamp.today() - pd.offsets.BDay(5)).strftime("%Y%m%d")

# Check a swap rate
df = blp.bdh("USSW10 Curncy", "PX_LAST", start, today)
print(df)

# Check a swaption vol (should return ~75 bp/yr for USD 6m10y)
df = blp.bdh("USSN6M10Y Curncy", "PX_LAST", start, today)
print(df)
```

---

## 7. Troubleshooting

### Backend warnings on startup

Each module logs any series that returned no data:

```
data_fetcher: 'ea_building_permits_yoy' returned no data for 2023-01-01–2025-06-25.
No observations placed for: ['ea_building_permits_yoy', ...]
```

A clean run will show no such warnings. Check `has_data` in heatmap module logs.

### API response includes `data_source` field

Several endpoints return a `data_source` field:

```json
{ "data_source": "bloomberg" }   // or "simulation"
```

Check this field to confirm live data loaded correctly.

### "Module not found" for blpapi / Haver

Both are optional dependencies. Install as needed:

```bash
pip install xbbg           # Bloomberg
pip install Haver          # Haver (Windows only)
```

If not installed, the respective fetcher class is unavailable and the module logs a warning, then falls back to simulation.

### Bloomberg fetch returns empty DataFrame

Most common causes:
1. Terminal not open / not logged in
2. No data license for the requested ticker
3. Ticker string incorrect (typo, wrong yellow-key suffix)

Debug with:

```python
from bbg import blp
df = blp.bdh("GDBR10 Index", "PX_LAST", "2024-01-01", "2025-01-01")
print(df)
```

### Data looks stale

The server precomputes all heatmap data on startup and caches in module globals. **Restart the server** to refresh to today's data.

```bash
# With auto-reload (dev):
uvicorn backend.main:app --reload --port 8000
# The first request after file change triggers re-import → re-fetch
```

### How to verify a ticker

```python
# Quick BBG ticker check (run from within backend/ dir with Terminal open):
cd backend
python -c "
from bbg import blp
import pandas as pd
df = blp.bdh('GUKG10 Index', 'PX_LAST', '2025-01-01', pd.Timestamp.today().strftime('%Y-%m-%d'))
print(df.tail())
"
```
