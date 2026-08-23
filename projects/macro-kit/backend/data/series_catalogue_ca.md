# series_catalogue_ca.json — Documentation

Catalogue for the **Canada Macro Heatmap**.  
Backend file: `backend/canada_heatmap.py`  
API routes: `GET /api/tools/canada-heatmap/{daily-factors,fair-value,yield-pca,pc-regressions}`

---

## 1. What Is In The Catalogue

### 1.1 Summary

| | Count |
|-|-------|
| Total series | 55 |
| DFM macro series (Block 1) | 43 |
| Bloomberg tickers | 35 / 55 (64%) |
| Haver tickers | 30 / 55 (55%) |

### 1.2 DFM macro series (43 series, Block 1)

| Factor | Series count | Primary series | Sign |
|--------|-------------|---------------|------|
| Growth | 17 | `ca_spglobal_composite_pmi` | +1 |
| Inflation | 8 | `ca_cpi_median_yoy` | +1 |
| Employment | 8 | `ca_unemployment_rate` | −1 |
| Wages | 5 | `ca_avg_hourly_earnings_yoy` | +1 |

**Global Macro** anchor: `ca_spglobal_composite_pmi` (+1).

Key series: CPI Median (Bank of Canada preferred core measure) anchors the
Inflation factor rather than headline CPI. Canada reports three core measures
(trim, median, common); median is the least volatile.

### 1.3 Yield series (Block 2 — 5 CanGov tenors)

| Series ID | Tenor |
|-----------|-------|
| `ca_cangov_2y` | 2y |
| `ca_cangov_5y` | 5y |
| `ca_cangov_10y` | 10y |
| `ca_cangov_20y` | 20y |
| `ca_cangov_30y` | 30y |

PCA sign conventions: PC1 @ 10y (index 2), PC2 @ 30y (index 4), PC3 @ 5y (index 1).

---

## 2. Architecture

The pipeline is identical to the Euro Area — see `series_catalogue_ea.md` §2
for the full data flow diagram. Region-specific differences:

| Config | Value |
|--------|-------|
| `bond_name` | CanGov |
| `m_macro` | 43 |
| `catalogue_path` | `data/series_catalogue_ca.json` |
| `random_seed` | 55 |

---

## 3. Known Issues

### 3.1 Bloomberg and Haver coverage both moderate

35/55 Bloomberg (64%), 30/55 Haver (55%). Neither source alone covers the full
catalogue. For best model quality use Bloomberg as primary.

### 3.2 Three BoC core inflation measures

The catalogue likely includes CPI Trim, CPI Median, and CPI Common. Only Median
is the primary for the Inflation factor; the other two are supporting series.
All three should load from Bloomberg (`CACPIMED Index`, `CACPITRIM Index`,
`CACPICMN Index`).

### 3.3 Date range is stale

Shared `DAILY_DATES` ends 2025-06-30. See `series_catalogue_ea.md` §3.

### 3.4 Heatmap grid is synthetic

The z-score grid in the frontend is deterministic synthetic data.

---

## 4. How to Test

```python
import sys; sys.path.insert(0, "backend")
from canada_heatmap import get_daily_factors, get_fair_value, get_yield_pca
import numpy as np

fac = get_daily_factors()
for name, vals in fac.factors.items():
    print(f"  {name:15s}  mean={np.mean(vals):+.3f}  std={np.std(vals):.3f}")

fv = get_fair_value()
rc = np.array(fv.rich_cheap_bps)
print(f"\nCanGov 10y rich/cheap: mean={rc.mean():+.1f}bps  last={rc[-1]:+.1f}bps")
```

### Verify Bloomberg tickers

```python
import sys; sys.path.insert(0, "backend")
from data_fetcher import get_fetcher

fetcher = get_fetcher("bloomberg")
data = fetcher.fetch(
    ["ca_spglobal_composite_pmi", "ca_cpi_median_yoy", "ca_unemployment_rate"],
    start="2022-01-01", end="2025-06-30",
)
for sid, series in data.items():
    print(f"{sid}: {len(series)} obs, last={series.iloc[-1]:.2f}")
```
