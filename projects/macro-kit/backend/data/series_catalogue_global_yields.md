# series_catalogue_global_yields.json — Documentation

Catalogue for the **Global Yields** tool.  
Backend file: `backend/global_yields.py`

---

## 1. What Is In The Catalogue

### 1.1 Important: actual tickers live in `series_catalogue_ea.json`, not here

`series_catalogue_global_yields.json` says `"bloomberg_ticker": "see series_catalogue_ea.json"`
for every entry. The real Bloomberg tickers are stored in the **main Euro Area
catalogue** (`backend/data/series_catalogue_ea.json`) as entries with
`"tools": ["global_yields"]` (or `["euro_area_heatmap", "global_yields"]` for
shared series like Bund 10y). This catalogue is documentation only — it lists
the 24 countries and confirms all tickers are verified; it does not drive runtime
behaviour.

### 1.2 The 24 Bloomberg tickers

All fetched via `PX_LAST` (generic constant-maturity government bond yield indices):

**DM (16 countries)**

| Country | Series ID | Bloomberg ticker | Notes |
|---------|-----------|-----------------|-------|
| Germany | `bund_10y` | `GDBR10 Index` | Also used by euro_area_heatmap |
| US | `gov10y_us` | `USGG10YR Index` | |
| UK | `gov10y_uk` | `GUKG10 Index` | |
| Canada | `gov10y_canada` | `GCAN10YR Index` | |
| Japan | `gov10y_japan` | `GJGB10 Index` | |
| Australia | `gov10y_australia` | `GACGB10 Index` | |
| Switzerland | `gov10y_switzerland` | `GSWISS10 Index` | No YR suffix — verify active series name |
| France | `gov10y_france` | `GFRN10 Index` | |
| Austria | `gov10y_austria` | `GAGB10YR Index` | |
| Netherlands | `gov10y_netherlands` | `GNTH10YR Index` | ⚠️ See §4.1 |
| Belgium | `gov10y_belgium` | `GBGB10YR Index` | |
| Italy | `gov10y_italy` | `GBTPGR10 Index` | |
| Greece | `gov10y_greece` | `GGGB10YR Index` | |
| Ireland | `gov10y_ireland` | `GIGB10YR Index` | |
| Portugal | `gov10y_portugal` | `GSPT10YR Index` | ⚠️ See §4.2 |
| Spain | `gov10y_spain` | `GSPG10YR Index` | |

**EM (8 countries)**

| Country | Series ID | Bloomberg ticker | Notes |
|---------|-----------|-----------------|-------|
| Brazil | `gov10y_brazil` | `GEBR10Y Index` | |
| Mexico | `gov10y_mexico` | `GMXN10YR Index` | |
| India | `gov10y_india` | `GIND10YR Index` | |
| South Korea | `gov10y_south_korea` | `GKOR10YR Index` | |
| Indonesia | `gov10y_indonesia` | `GIDN10YR Index` | |
| South Africa | `gov10y_south_africa` | `GSAF10YR Index` | |
| Poland | `gov10y_poland` | `GPOL10YR Index` | |
| Czech Republic | `gov10y_czech` | `GCZK10YR Index` | |

**Haver tickers**: only `bund_10y` has one (`BNDEZQ10@EUDATA`). All 23 others
have `null` — this tool is daily market data and Haver is not applicable.

---

## 2. Architecture

### Pre-computed at module import

Like the Fair Value Models tool, Global Yields runs the PCA **once at server
startup** and caches all results as module-level variables. The API endpoint
just returns the pre-computed dict. A server restart is required to pick up
new Bloomberg data.

### Data fetcher — different from other tools

Unlike EGB RV, Swaps RV, and Fair Value Models (which call `blp` directly),
this tool uses a `data_fetcher` abstraction:

```python
from data_fetcher import get_fetcher
fetcher = get_fetcher("bloomberg")
raw = fetcher.fetch(series_ids=_SERIES_IDS, start=start, end=end)
```

`_SERIES_IDS` is the ordered list of series IDs from `COUNTRY_SERIES` (e.g.
`["bund_10y", "gov10y_us", ...]`). The fetcher resolves these to Bloomberg
tickers via `series_catalogue_ea.json` at runtime. This means adding or
changing a ticker requires editing `series_catalogue_ea.json`, not
`global_yields.py`.

### Full data flow

```
Module import
│
├─► _fetch_yields(start="2022-01-03", end="2025-06-27")
│       data_fetcher.get_fetcher("bloomberg")
│           → reads tickers from series_catalogue_ea.json for _SERIES_IDS
│           → blp.bdh(24 tickers, "PX_LAST", start, end)
│       Align to DAILY_DATES, forward-fill gaps ≤5 business days
│       Missing countries → fill with _MEANS (long-run yield mean)
│       Returns [T, 24] matrix, or None on any failure
│
└─► _simulate_yields(rng)   ← if fetch returns None
        3-factor AR(1) model + macro trend overlays
        Returns [T, 24] matrix

_run_pca(YIELDS)
    Standardise each country: Z = (Y − mean) / std
    Covariance on Z → eigendecomposition → PC1/PC2/PC3
    Sign-correct loadings (see §3)
    Compute fitted + residuals in bps

get_global_yields_data() → {dates, factors, explained_var, residuals, table, data_source}
```

### Fixed date range — important limitation

`DAILY_DATES` is hard-coded to `2022-01-03` → `2025-06-27` in the module.
This date range does **not** update automatically. Once the server date passes
2025-06-27, the live data path will still request data through that end date
and the simulation will use the same fixed grid.

To extend the date range, update these two lines in `global_yields.py`:

```python
DAILY_DATES: pd.DatetimeIndex = pd.bdate_range("2022-01-03", "2025-06-27")
```

Change `"2025-06-27"` to today's date (or set it dynamically with
`pd.Timestamp.today().strftime("%Y-%m-%d")`).

---

## 3. PCA Methodology

### Standardised PCA

PCA is run on **z-scored yields**, not raw levels. Each country is standardised
independently:

```
Z[t, i] = (yield[t, i] − mean_i) / std_i
```

This prevents high-volatility EM yields (Brazil ~12%, Mexico ~9%) from
dominating the covariance matrix and drowning out DM dynamics.

### Factor structure (3 PCs)

| Factor | Label | Sign convention |
|--------|-------|----------------|
| PC1 | Global | DM average loading forced positive — positive score = high global yields |
| PC2 | DM | DM average loading > EM average loading — captures DM-specific moves |
| PC3 | EM | EM average loading > DM average loading — captures EM-idiosyncratic moves |

Sign-correction is applied to eigenvectors after decomposition so that charts
are stable regardless of numerical sign conventions in `np.linalg.eigh`.

### Reconstruction and residual

```
Z_hat[t, i] = scores[t, :3] @ loadings[:3, i]   (3-PC approximation)
fitted[t, i] = mean_i + Z_hat[t, i] × std_i      (back to yield %, same as model fair value)
residual[t, i] = (yield[t, i] − fitted[t, i]) × 100   (bps)
```

### Rich/cheap z-score

For each country, over a 252-day rolling window:

```
z_score = (residual_last − avg_252d) / std_252d
```

`z_score > 0` = yield is above model (cheap); `z_score < 0` = below model (rich).

---

## 4. Known Ticker Issues

### 4.1 Netherlands ticker discrepancy vs EGB RV

The EGB RV tool uses `GNETH10YR Index` for the Netherlands 10y yield.  
Global Yields uses `GNTH10YR Index` (no "E" after "GN").

One of these is wrong, or they are two Bloomberg aliases for the same series.
**Verify both in Bloomberg Terminal** — type each and confirm which loads the
Netherlands 10y generic yield. Update the incorrect one.

To check:
```python
from bbg import blp
import pandas as pd
start = (pd.Timestamp.today() - pd.DateOffset(days=10)).strftime("%Y-%m-%d")
end   = pd.Timestamp.today().strftime("%Y-%m-%d")
df = blp.bdh(["GNTH10YR Index", "GNETH10YR Index"], "PX_LAST", start, end)
print(df.tail(3))
# Expected: Netherlands 10y ~2.5–3.5%; one of these should return NaN
```

If `GNTH10YR Index` is wrong, update `series_catalogue_ea.json` (`gov10y_netherlands`
ticker_bloomberg field).

### 4.2 Portugal ticker discrepancy vs EGB RV

The EGB RV tool uses `GPTIT10YR Index` for Portugal 10y.  
Global Yields uses `GSPT10YR Index`.

Same verification needed:
```python
df = blp.bdh(["GSPT10YR Index", "GPTIT10YR Index"], "PX_LAST", start, end)
print(df.tail(3))
# Expected: Portugal 10y ~2.5–3.5%
```

Update `series_catalogue_ea.json` (`gov10y_portugal`) if `GSPT10YR Index` is wrong.

---

## 5. How to Test

### 5.1 Simulation mode (no Bloomberg required)

```bash
source .venv/bin/activate
uvicorn backend.main:app --reload --port 8000
```

```bash
curl http://localhost:8000/api/tools/global-yields \
  -H "Authorization: Bearer <token>" | python3 -m json.tool | head -50
```

Expected response structure:

```json
{
  "data_source": "simulation",
  "dates": ["2022-01-03", ..., "2025-06-27"],
  "factors": {
    "Global": [0.012, 0.034, ...],
    "DM":     [-0.003, 0.011, ...],
    "EM":     [0.022, -0.005, ...]
  },
  "explained_var": { "Global": 0.624, "DM": 0.183, "EM": 0.097 },
  "residuals": {
    "US":      [12.4, 11.8, ...],
    "Japan":   [-8.2, -9.1, ...],
    "UK":      [3.2, 4.1, ...],
    "Germany": [-2.1, -1.8, ...],
    "France":  [5.3, 6.0, ...]
  },
  "table": [
    {"country": "US", "is_dm": true, "actual": 3.82, "model": 3.74,
     "last": 8.1, "avg": 5.3, "stdev": 12.2, "z_score": 0.23},
    ...
  ]
}
```

### 5.2 Sanity-check simulation values

```python
import sys; sys.path.insert(0, "backend")
from global_yields import get_global_yields_data, _source, ALL_COUNTRIES, _MEANS

d = get_global_yields_data()
print("Source:", _source)
print(f"Date range: {d['dates'][0]} → {d['dates'][-1]}  ({len(d['dates'])} days)")
print(f"PC1 variance explained: {d['explained_var']['Global']:.1%}")

# Check table values are in plausible ranges
for row in d["table"]:
    print(f"{row['country']:15s}  actual={row['actual']:.2f}%  "
          f"model={row['model']:.2f}%  resid={row['last']:+.0f}bps  z={row['z_score']:+.2f}")
```

Expected (simulation):
- PC1 (Global) explains ~55–70% of variance
- PC2 (DM) explains ~12–20%
- PC3 (EM) explains ~8–15%
- Japan and Switzerland: lowest actual yields (~0.5–0.7%), low beta on PC1
- Brazil and South Africa: highest yields (~10–13%)
- Residuals typically ±20–60 bps for DM, ±50–100 bps for EM

### 5.3 Test Bloomberg live path

With Bloomberg Terminal open:

```python
from bbg import blp
import pandas as pd

start = "2024-01-01"
end   = pd.Timestamp.today().strftime("%Y-%m-%d")

# DM core — these should all work
dm_core = ["GDBR10 Index", "USGG10YR Index", "GUKG10 Index",
           "GJGB10 Index", "GCAN10YR Index"]
df = blp.bdh(dm_core, "PX_LAST", start, end)
print("DM core:")
print(df.tail(2))

# EGB semi-core — verify these load correctly
egb_semi = ["GAGB10YR Index", "GNTH10YR Index", "GBGB10YR Index",
            "GGGB10YR Index", "GIGB10YR Index", "GSPT10YR Index"]
df2 = blp.bdh(egb_semi, "PX_LAST", start, end)
print("\nEGB semi-core:")
print(df2.tail(2))

# EM — less standard patterns
em = ["GEBR10Y Index", "GMXN10YR Index", "GIND10YR Index", "GKOR10YR Index",
      "GIDN10YR Index", "GSAF10YR Index", "GPOL10YR Index", "GCZK10YR Index"]
df3 = blp.bdh(em, "PX_LAST", start, end)
print("\nEM:")
print(df3.tail(2))
```

Expected ranges (approximate):
- US 10y: 3.5–5.0% · UK: 3.5–4.5% · Germany: 2.0–2.8% · Japan: 0.5–1.1%
- Brazil: 10–14% · South Africa: 9–12% · India: 6.5–8%

Any ticker returning all NaN needs replacing. Check with Bloomberg's `SOVR <GO>`
or country-specific government bond pages.

### 5.4 Test full live run

```bash
ANALYTICS_DATA_SOURCE=bloomberg uvicorn backend.main:app --reload --port 8000
```

```bash
curl http://localhost:8000/api/tools/global-yields \
  -H "Authorization: Bearer <token>" \
  | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('data_source:', d['data_source'])
print('date range:', d['dates'][0], '→', d['dates'][-1])
print('Top 5 cheapest:')
t = sorted(d['table'], key=lambda r: -r['z_score'])
for r in t[:5]:
    print(f'  {r[\"country\"]:15s}  z={r[\"z_score\"]:+.2f}  resid={r[\"last\"]:+.0f}bps')
"
```

---

## 6. What Has to Be Added

### 6.1 Resolve Netherlands and Portugal ticker discrepancies (PRIORITY)

Run the snippets in §4.1 and §4.2. Confirm which ticker is correct vs the
EGB RV tool and update `series_catalogue_ea.json` accordingly. The two tools should
use the same Bloomberg series for the same country.

### 6.2 Fix the hard-coded date range (PRIORITY)

`DAILY_DATES` is frozen at `2022-01-03 → 2025-06-27`. As of the current date
(2026-08-22) this is already stale — the model is being fit on data ending
13 months ago, and any request served today uses a fixed historical date grid
that does not include recent observations.

Recommended fix in `global_yields.py`:

```python
# Replace the fixed date range with a rolling window ending today
DAILY_DATES: pd.DatetimeIndex = pd.bdate_range(
    start="2022-01-03",
    end=pd.Timestamp.today().normalize(),
)
T = len(DAILY_DATES)
```

This also requires updating `_END` at the bottom of the file (currently
`DAILY_DATES[-1].strftime(...)` so it will update automatically).

### 6.3 Haver tickers — not applicable for most series

23 of 24 entries have `ticker_haver: null`. These are daily market prices not
carried by Haver. Only `bund_10y` has a Haver ticker (`BNDEZQ10@EUDATA`) as a
secondary source. No action needed.

### 6.4 EM tickers — lower confidence, worth verifying

The EM Bloomberg ticker patterns (`GEBR10Y`, `GMXN10YR`, `GIND10YR`, etc.) are
less standardised than DM patterns. When Bloomberg access is available, test all
8 EM tickers and confirm they return plausible yield levels in local currency.
Note that some EM "10y" generics may represent a different point on the curve
than the canonical benchmark (e.g. Brazil's DI futures curve vs NTN-B yields).

### 6.5 Chart countries are hard-coded

`CHART_COUNTRIES = ["US", "Japan", "UK", "Germany", "France"]` — the residual
time-series chart only shows these 5 countries. The full 24-country table is
always returned, but adding a country to the chart requires editing
`global_yields.py`. No change needed unless the team wants different countries
highlighted.
