# series_catalogue_au.json — Documentation

Catalogue for the **Australia Macro Heatmap**.  
Backend file: `backend/australia_heatmap.py`  
API routes: `GET /api/tools/australia-heatmap/{daily-factors,fair-value,yield-pca,pc-regressions}`

---

## 1. What Is In The Catalogue

### 1.1 Summary

| | Count |
|-|-------|
| Total series | 52 |
| DFM macro series (Block 1) | 42 |
| Bloomberg tickers | 41 / 52 (79%) |
| Haver tickers | 24 / 52 (46%) |

### 1.2 DFM macro series (42 series, Block 1)

| Factor | Series count | Primary series | Sign |
|--------|-------------|---------------|------|
| Growth | 17 | `au_pmi_manufacturing` | +1 |
| Inflation | 8 | `au_trimmed_mean_cpi_yoy` | +1 |
| Employment | 9 | `au_unemployment_rate` | −1 |
| Wages | 5 | `au_wage_price_index_yoy` | +1 |

**Global Macro** anchor: `au_pmi_manufacturing` (+1).

Key series: Trimmed Mean CPI is the RBA's preferred underlying inflation measure
and anchors the Inflation factor (rather than headline CPI).

### 1.3 Yield series (Block 2 — 5 ACGB tenors)

| Series ID | Tenor |
|-----------|-------|
| `au_acgb_2y` | 2y |
| `au_acgb_5y` | 5y |
| `au_acgb_10y` | 10y |
| `au_acgb_20y` | 20y |
| `au_acgb_30y` | 30y |

PCA sign conventions: PC1 @ 10y (index 2), PC2 @ 30y (index 4), PC3 @ 5y (index 1).

---

## 2. Architecture

The pipeline is identical to the Euro Area — see `series_catalogue_ea.md` §2
for the full data flow diagram. Region-specific differences:

| Config | Value |
|--------|-------|
| `bond_name` | ACGB |
| `m_macro` | 42 |
| `catalogue_path` | `data/series_catalogue_au.json` |
| `random_seed` | 22 |

---

## 3. Known Issues

### 3.1 Haver coverage is moderate (46%)

24 of 52 series have Haver tickers. When running with `ANALYTICS_DATA_SOURCE=haver`,
28 series will fall back to NaN columns. Bloomberg is the better source for
Australian data.

### 3.2 Date range is stale

Shared `DAILY_DATES` ends 2025-06-30. See `series_catalogue_ea.md` §3.

### 3.3 Heatmap grid is synthetic

The z-score grid in the frontend is deterministic synthetic data.

---

## 4. How to Test

```python
import sys; sys.path.insert(0, "backend")
from australia_heatmap import get_daily_factors, get_fair_value, get_yield_pca
import numpy as np

fac = get_daily_factors()
for name, vals in fac.factors.items():
    print(f"  {name:15s}  mean={np.mean(vals):+.3f}  std={np.std(vals):.3f}")

fv = get_fair_value()
rc = np.array(fv.rich_cheap_bps)
print(f"\nACGB 10y rich/cheap: mean={rc.mean():+.1f}bps  last={rc[-1]:+.1f}bps")

pca = get_yield_pca()
for label, var in pca.explained_var.items():
    print(f"  {label}: {var:.1%}")
```

### Verify Bloomberg tickers

```python
import sys; sys.path.insert(0, "backend")
from data_fetcher import get_fetcher

fetcher = get_fetcher("bloomberg")
data = fetcher.fetch(
    ["au_pmi_manufacturing", "au_trimmed_mean_cpi_yoy", "au_unemployment_rate"],
    start="2022-01-01", end="2025-06-30",
)
for sid, series in data.items():
    print(f"{sid}: {len(series)} obs, last={series.iloc[-1]:.2f}")
```
