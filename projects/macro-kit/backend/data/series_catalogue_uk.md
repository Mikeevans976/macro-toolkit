# series_catalogue_uk.json — Documentation

Catalogue for the **UK Macro Heatmap**.  
Backend file: `backend/uk_heatmap.py`  
API routes: `GET /api/tools/uk-heatmap/{daily-factors,fair-value,yield-pca,pc-regressions}`

---

## 1. What Is In The Catalogue

### 1.1 Summary

| | Count |
|-|-------|
| Total series | 54 |
| DFM macro series (Block 1) | 48 |
| Bloomberg tickers | 29 / 54 (54%) |
| Haver tickers | 37 / 54 (69%) |

Haver coverage is notably stronger here than for EA — UK macro data is
well-represented in Haver DLX.

### 1.2 DFM macro series (48 series, Block 1)

| Factor | Series count | Primary series | Sign |
|--------|-------------|---------------|------|
| Growth | 14 | `uk_composite_pmi` | +1 |
| Inflation | 9 | `uk_services_cpi_yoy` | +1 |
| Employment | 8 | `uk_unemployment_rate` | −1 |
| Wages | 5 | `uk_awe_regular_yoy` | +1 |

**Global Macro** anchor: `uk_composite_pmi` (UK Composite PMI, +1).

### 1.3 Yield series (Block 2 — 5 Gilt tenors)

| Series ID | Tenor |
|-----------|-------|
| `gilt_2y` | 2y |
| `gilt_5y` | 5y |
| `gilt_10y` | 10y |
| `gilt_20y` | 20y |
| `gilt_30y` | 30y |

PCA sign conventions: PC1 @ 10y (index 2), PC2 @ 30y (index 4), PC3 @ 5y (index 1).

---

## 2. Architecture

The pipeline is identical to the Euro Area — see `series_catalogue_ea.md` §2
for the full data flow diagram. Region-specific differences:

| Config | Value |
|--------|-------|
| `bond_name` | Gilt |
| `m_macro` | 48 |
| `catalogue_path` | `data/series_catalogue_uk.json` |
| `random_seed` | 99 |
| `yield_means` | approximately 3.8 / 3.7 / 3.9 / 4.2 / 4.4% (2y→30y) |

The catalogue is loaded by `RegionalHeatmap` at import of `uk_heatmap.py`. All
computation (DFM + Yield PCA + fair value) runs once at server startup and is
cached. A restart is required to pick up new data.

---

## 3. Known Issues

### 3.1 Bloomberg coverage is low (54%)

Only 29 of 54 entries have Bloomberg tickers. When `ANALYTICS_DATA_SOURCE=bloomberg`,
25 series will be missing — those without tickers are silently skipped by the
fetcher and their columns remain NaN in the observation matrix. The Kalman
filter handles sparse panels, but model quality degrades if many series are
missing.

Check which series lack Bloomberg tickers:

```python
import json
from pathlib import Path
cat = json.loads(Path("backend/data/series_catalogue_uk.json").read_text())
missing = [s["id"] for s in cat["series"] if not s.get("ticker_bloomberg")]
print(f"No Bloomberg ticker ({len(missing)}): {missing}")
```

### 3.2 Date range is stale

`DAILY_DATES = pd.bdate_range("2023-06-01", "2025-06-30")` — defined in
`regional_heatmap.py`, shared across all regions. See `series_catalogue_ea.md`
§3 for the fix.

### 3.3 Heatmap grid is synthetic

Same as EA: the z-score grid in `UKHeatmap.tsx` is deterministic synthetic data,
not live DFM output.

---

## 4. How to Test

### 4.1 Simulation mode

```bash
source .venv/bin/activate && uvicorn backend.main:app --reload --port 8000
```

```python
import sys; sys.path.insert(0, "backend")
from uk_heatmap import get_daily_factors, get_fair_value, get_yield_pca
import numpy as np

fac = get_daily_factors()
print(f"UK factors: {list(fac.factors.keys())}")
for name, vals in fac.factors.items():
    print(f"  {name:15s}  mean={np.mean(vals):+.3f}  std={np.std(vals):.3f}")

fv = get_fair_value()
rc = np.array(fv.rich_cheap_bps)
print(f"\nGilt 10y rich/cheap: mean={rc.mean():+.1f}bps  last={rc[-1]:+.1f}bps")

pca = get_yield_pca()
for label, var in pca.explained_var.items():
    print(f"  {label}: {var:.1%}")
```

### 4.2 Verify Haver tickers (preferred data source for UK)

```python
import sys; sys.path.insert(0, "backend")
from data_fetcher import get_fetcher

fetcher = get_fetcher("haver", path="/path/to/haver")
data = fetcher.fetch(
    ["uk_composite_pmi", "uk_unemployment_rate", "uk_awe_regular_yoy"],
    start="2022-01-01", end="2025-06-30",
)
for sid, series in data.items():
    print(f"{sid}: {len(series)} obs, last={series.iloc[-1]:.2f}")
```
