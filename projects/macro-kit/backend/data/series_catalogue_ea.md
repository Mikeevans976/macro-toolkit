# series_catalogue_ea.json — Documentation

Master catalogue for the **Euro Area** tools.  
Backend files: `backend/data_fetcher.py`, `backend/macro_data_loader.py`  
Consumed by: `euro_area_heatmap.py`, `global_yields.py`, `fair_value_models.py`, `swaps_rv.py`

---

## 1. What Is In The Catalogue

### 1.1 Summary

| | Count |
|-|-------|
| Total series | 147 |
| DFM macro series (Block 1) | 60 |
| Bloomberg tickers | 115 / 147 (78%) |
| Haver tickers | 49 / 147 (33%) |

### 1.2 Tools that consume this catalogue

| Tool | What it uses |
|------|-------------|
| `euro_area_heatmap` | 60 DFM macro series (Block 1) + 8 Bund yield series (Block 2) |
| `global_yields` | 24 10y government bond yields (`tools: ["global_yields"]`) |
| `fair_value_models` | Fair value model inputs |
| `swaps_rv` | EUR swap and market rate series |

### 1.3 DFM macro series (60 series, used by Euro Area Heatmap Block 1)

Each entry has a `dfm_col_index` (0–59), a `dfm_factor`, and a `dfm_sign`.

| Factor | Series count | Primary series | Sign anchor |
|--------|-------------|---------------|-------------|
| Growth | 25 | `ea_composite_pmi` | +1 (PMI rises with growth) |
| Inflation | 20 | (inflation primary from catalogue) | +1 |
| Employment | 8 | (employment primary) | −1 (unemployment inverse) |
| Wages | 7 | (wages primary) | +1 |

**Global Macro** factor is extracted from the full 60-series panel (not a named
group); its sign is anchored by `ea_esi` (ESI: +1 = better macro conditions).

### 1.4 Catalogue schema

Every entry in `"series"` has:

```json
{
  "id":                 "ea_composite_pmi",
  "name":               "EA Composite PMI",
  "description":        "...",
  "source":             "haver",
  "ticker_bloomberg":   "MAPMEROZ Index",
  "ticker_haver":       "PMIEZCO@EMERGE",
  "frequency":          "monthly",
  "units":              "index",
  "typical_lag_days":   23,
  "asset_class":        "macro_survey",
  "geography":          "euro_area",
  "tools":              ["euro_area_heatmap"],
  "role":               "factor_input",
  "dfm_factor":         "Growth",
  "dfm_sign":           1,
  "dfm_col_index":      22,
  "dfm_primary":        true,
  "heatmap_group":      "Business Activity"
}
```

Key fields for the DFM pipeline:

| Field | Purpose |
|-------|---------|
| `dfm_col_index` | Column position in the `[T×60]` observation matrix |
| `dfm_factor` | Which factor block this series identifies |
| `dfm_sign` | +1 or −1: direction of series relative to factor |
| `dfm_primary` | If `true`, this series anchors the sign of its factor |
| `typical_lag_days` | Used to estimate release date from period end |

---

## 2. Architecture

### 2.1 How the catalogue is loaded at runtime

```python
# data_fetcher.py and macro_data_loader.py both default to:
_CATALOGUE_PATH = Path(__file__).parent / "data" / "series_catalogue_ea.json"
```

Regional heatmaps (UK, Japan, etc.) pass `catalogue_path` explicitly to point
to their own catalogue (e.g. `series_catalogue_uk.json`). The EA catalogue is
the default when `catalogue_path=None`.

### 2.2 Ticker resolution flow

```
series_id (e.g. "ea_composite_pmi")
    ↓
_CatalogueResolver (data_fetcher.py)
    looks up ticker_bloomberg or ticker_haver
    ↓
BloombergFetcher  → blp.bdh(ticker, "PX_LAST", start, end)
HaverFetcher      → Haver(path).series(ticker)
    ↓
dict[series_id → pd.Series]   (PeriodIndex for macro, DatetimeIndex for daily)
```

### 2.3 Full Euro Area Heatmap data pipeline

```
Server startup → import euro_area_heatmap.py
    ↓
RegionalHeatmap._precompute()   [runs once, caches all results]
    │
    ├── BLOCK 1: Macro DFM
    │   │
    │   ├─ _fetch_macro_data()
    │   │     data_fetcher.get_fetcher(source)
    │   │         → resolves 60 series IDs → Bloomberg/Haver tickers
    │   │         → BDH / Haver fetch (~2.5 years of history)
    │   │         → returns dict[series_id → pd.Series with PeriodIndex]
    │   │
    │   ├─ load_macro_data()   [macro_data_loader.py]
    │   │     converts PeriodIndex → estimated release dates
    │   │         (period_end + typical_lag_days from catalogue)
    │   │     places observations on daily grid → Y_daily [T×60]
    │   │         NaN on non-release days (ragged-edge panel)
    │   │
    │   ├─ Block-PCA initialisation
    │   │     within-group PCA per factor → F_init [T, 5], Λ_init [60, 5]
    │   │     full-panel PCA for Global Macro factor
    │   │
    │   └─ Kalman filter + RTS smoother   [dfm.py]
    │         state:  f_t [5] — latent daily factors (AR(1) per factor)
    │         obs:    y_t [60] — NaN on non-release days (handled natively)
    │         → FACTORS_SMOOTH [T, 5]
    │
    ├── BLOCK 2: Yield PCA
    │   │
    │   ├─ _fetch_yield_data()
    │   │     fetches 8 Bund yield series (bund_2y … bund_30y)
    │   │     aligns to daily grid, forward-fills gaps ≤ 5 business days
    │   │     → YIELDS [T, 8]
    │   │
    │   └─ _compute_pca()
    │         eigendecomposition of sample covariance
    │         sign-corrected: PC1 @ 10y, PC2 @ 30y, PC3 @ 7y
    │         → PC_SCORES [T, 3], PC_LOADINGS [3, 8]
    │
    └── FAIR VALUE
          OLS: PC1_score ~ FACTORS_SMOOTH  (no intercept)
          OLS: PC2_score ~ FACTORS_SMOOTH  (no intercept)
          Macro FV (10y) = mean_10y + PC1_fitted × L[PC1,10y]
                                     + PC2_fitted × L[PC2,10y]
          Rich/cheap (bps) = (actual − macro_FV) × 100
```

### 2.4 Pre-computation at import

All computation runs **once at server startup** and is cached as module-level
attributes. API endpoints just return the cached data — there is no per-request
computation. A server restart is required to pick up new market data.

### 2.5 Simulation fallback

If `ANALYTICS_DATA_SOURCE` is not `bloomberg` or `haver` (default: `csv`),
or if any fetch fails, the pipeline falls back to deterministic simulation:

- **Block 1**: AR(1) factor simulation + synthetic monthly observations.
  `random_seed=42` in `HeatmapConfig` ensures reproducibility.
- **Block 2**: yields synthesised from simulated factors using
  `yield_factor_loadings` (hardcoded in `euro_area_heatmap.py`).

The Kalman smoother runs identically on real and simulated data.

---

## 3. Date Range

```python
DAILY_DATES = pd.bdate_range("2023-06-01", "2025-06-30")
```

Defined in `regional_heatmap.py`. This is **fixed and currently stale** — the
grid ends 13+ months before today (2026-08-23). The model fits on data through
June 2025 only, and simulation uses the same static grid.

To fix, make the end date dynamic in `regional_heatmap.py`:

```python
DAILY_DATES = pd.bdate_range(
    start="2023-06-01",
    end=pd.Timestamp.today().normalize(),
)
```

---

## 4. Known Issues

### 4.1 Date range is stale (PRIORITY)

See §3. The fixed `"2025-06-30"` end date means live Bloomberg data after that
date is never fetched, and the model is always fit on the same historical window
regardless of when the server runs.

### 4.2 Haver coverage is sparse (33%)

Only 49 of 147 series have confirmed Haver codes. The remaining series either
have Bloomberg-only tickers or unconfirmed Haver availability. When running with
`ANALYTICS_DATA_SOURCE=haver`, many series will fall back to simulation.

### 4.3 Heatmap grid is synthetic

The coloured z-score heatmap displayed on the frontend (`EuroAreaHeatmap.tsx`)
uses deterministic sin/cos z-score generators — it does **not** call the backend
or use the DFM factor output. Only the 4 API routes (daily factors, fair value,
yield PCA, PC regressions) return live/modelled data.

### 4.4 Global Yields ticker discrepancies

Two series used by both `global_yields` and `euro_area_heatmap` have
conflicting tickers between tools:
- Netherlands 10y: `GNTH10YR Index` (here) vs `GNETH10YR Index` (EGB RV)
- Portugal 10y: `GSPT10YR Index` (here) vs `GPTIT10YR Index` (EGB RV)

See `series_catalogue_global_yields.md` §4 for verification steps.

---

## 5. How to Test

### 5.1 Simulation mode (no Bloomberg/Haver required)

```bash
source .venv/bin/activate
uvicorn backend.main:app --reload --port 8000
```

```bash
# Daily factors
curl http://localhost:8000/api/tools/euro-area-heatmap/daily-factors \
  -H "Authorization: Bearer <token>" | python3 -m json.tool | head -20

# Fair value
curl http://localhost:8000/api/tools/euro-area-heatmap/fair-value \
  -H "Authorization: Bearer <token>" | python3 -m json.tool | head -20

# Yield PCA
curl http://localhost:8000/api/tools/euro-area-heatmap/yield-pca \
  -H "Authorization: Bearer <token>" | python3 -m json.tool | head -30

# PC regressions
curl http://localhost:8000/api/tools/euro-area-heatmap/pc-regressions \
  -H "Authorization: Bearer <token>" | python3 -m json.tool
```

### 5.2 Sanity-check pipeline output

```python
import sys; sys.path.insert(0, "backend")
from euro_area_heatmap import get_daily_factors, get_fair_value, get_yield_pca

# Factors
fac = get_daily_factors()
print(f"Date range: {fac.dates[0]} → {fac.dates[-1]}  ({len(fac.dates)} days)")
print("Factor names:", list(fac.factors.keys()))
for name, vals in fac.factors.items():
    import numpy as np
    print(f"  {name:15s}  mean={np.mean(vals):+.3f}  std={np.std(vals):.3f}")

# Fair value
fv = get_fair_value()
import numpy as np
rc = np.array(fv.rich_cheap_bps)
print(f"\nRich/cheap: mean={rc.mean():+.1f}bps  std={rc.std():.1f}bps  "
      f"last={rc[-1]:+.1f}bps")

# Yield PCA
pca = get_yield_pca()
print(f"\nPCA explained variance:")
for label, var in pca.explained_var.items():
    print(f"  {label}: {var:.1%}")
```

Expected (simulation, `random_seed=42`):
- 509 business days (2023-06-01 → 2025-06-30)
- 5 factors, each roughly zero-mean with std ~0.1–0.3
- PC1 (level) explains ~85–95% of yield variance
- PC2 (slope) explains ~3–10%
- Rich/cheap oscillates ±20–60 bps around zero

### 5.3 Verify Bloomberg ticker coverage

```python
import sys; sys.path.insert(0, "backend")
import json
from pathlib import Path

cat = json.loads((Path("backend/data/series_catalogue_ea.json")).read_text())
series = cat["series"]

no_bbg = [s["id"] for s in series if not s.get("ticker_bloomberg")]
print(f"Series without Bloomberg tickers ({len(no_bbg)}):")
for sid in no_bbg:
    print(f"  {sid}")
```

### 5.4 Test live Bloomberg fetch

With Bloomberg Terminal open and `ANALYTICS_DATA_SOURCE=bloomberg`:

```python
import sys; sys.path.insert(0, "backend")
from data_fetcher import get_fetcher

fetcher = get_fetcher("bloomberg")
data = fetcher.fetch(
    ["ea_composite_pmi", "ea_core_hicp_yoy", "ea_esi", "bund_10y"],
    start="2024-01-01",
    end="2025-06-30",
)
for sid, series in data.items():
    print(f"{sid}: {len(series)} obs, last={series.iloc[-1]:.2f} ({series.index[-1]})")
```

### 5.5 Test full live run

```bash
ANALYTICS_DATA_SOURCE=bloomberg uvicorn backend.main:app --reload --port 8000
```

Check logs for any `[euro_area] Fetcher returned no data` warnings — these
indicate series that failed to fetch and fell back to simulation.

---

## 6. What Has To Be Added

### 6.1 Fix the hard-coded date range (PRIORITY)

Make `DAILY_DATES` in `regional_heatmap.py` dynamic (see §3). This affects all
10 regional heatmaps simultaneously since they share the same date grid.

### 6.2 Expand Haver coverage

49/147 series (33%) have Haver codes. The remaining 98 series are Bloomberg-only.
For a Haver-based deployment, priority series to add Haver codes for:
- All `dfm_factor_input` series (the 60 DFM series drive model quality)
- Bund yield series (Block 2)

Check `BBG_HAVER_SETUP.md` for the current Haver verification status.

### 6.3 Wire live data to the heatmap grid

The z-score heatmap table on the frontend is synthetic. To show real DFM-based
z-scores in the grid, a new API endpoint would need to return per-series z-scores
derived from `FACTORS_SMOOTH` and the catalogue's `heatmap_group` metadata.

### 6.4 Release calendar integration

Currently, release dates are estimated as `period_end + typical_lag_days`. A
more accurate approach is to use an actual economic release calendar (e.g. from
Bloomberg `ECO <GO>` or a third-party provider) so the Kalman filter receives
observations on the correct dates, not an approximation.
