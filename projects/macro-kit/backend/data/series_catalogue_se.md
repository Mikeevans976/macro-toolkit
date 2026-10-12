# series_catalogue_se.json — Documentation

Catalogue for the **Sweden Macro Heatmap**.  
Backend file: `backend/sweden_heatmap.py`  
API routes: `GET /api/tools/sweden-heatmap/{daily-factors,fair-value,yield-pca,pc-regressions}`

---

## 1. What Is In The Catalogue

### 1.1 Summary

| | Count |
|-|-------|
| Total series | 52 |
| DFM macro series (Block 1) | 40 |
| Bloomberg tickers | 42 / 52 (81%) |
| Haver tickers | 24 / 52 (46%) |

### 1.2 DFM macro series (40 series, Block 1)

| Factor | Series count | Primary series | Sign |
|--------|-------------|---------------|------|
| Growth | 14 | `se_silf_pmi_manufacturing` | +1 |
| Inflation | 7 | `se_cpif_yoy` | +1 |
| Employment | 8 | `se_unemployment_rate_lfs` | −1 |
| Wages | 4 | `se_avg_hourly_earnings_yoy` | +1 |

**Global Macro** anchor: `se_silf_pmi_manufacturing` (+1).

Key series:
- **CPIF** (CPI with fixed interest rate) is the Riksbank's inflation target
  measure — it strips out the direct mechanical impact of Riksbank rate changes
  on mortgage costs, which affect the standard CPI in Sweden.
- **Silf/Swedbank Manufacturing PMI** is the most widely followed Swedish
  business confidence indicator and the primary Global Macro anchor.
- **LFS unemployment** (AKU in Swedish) is the Statistics Sweden labour force
  survey rate, consistent with the ILO definition.

### 1.3 Yield series (Block 2 — 5 SGB tenors)

| Series ID | Tenor |
|-----------|-------|
| `se_sgb_2y` | 2y |
| `se_sgb_5y` | 5y |
| `se_sgb_10y` | 10y |
| `se_sgb_20y` | 20y |
| `se_sgb_30y` | 30y |

PCA sign conventions: PC1 @ 10y (index 2), PC2 @ 30y (index 4), PC3 @ 5y (index 1).

---

## 2. Architecture

The pipeline is identical to the Euro Area — see `series_catalogue_ea.md` §2
for the full data flow diagram. Region-specific differences:

| Config | Value |
|--------|-------|
| `bond_name` | SGB |
| `m_macro` | 40 |
| `catalogue_path` | `data/series_catalogue_se.json` |
| `random_seed` | 66 |

---

## 3. Known Issues

### 3.1 CPIF vs CPI distinction

Standard Swedish CPI is significantly affected by Riksbank rate changes (via
variable-rate mortgage costs). The Riksbank targets **CPIF** and communicates
in CPIF terms. Ensure all Bloomberg/Haver tickers in the Inflation group are
pulling CPIF-based series (not standard CPI) where that distinction exists.

### 3.2 SGB market size

Sweden has a smaller government bond market than the large DM peers. The 20y
and 30y SGB tenors can be illiquid. Watch for NaN gaps in Bloomberg data for
these tenors; extended gaps trigger yield simulation fallback for Block 2.

### 3.3 Haver coverage is moderate (46%)

24 of 52 series have Haver tickers. Bloomberg is the stronger source for
Swedish data.

### 3.4 Date range is stale

Shared `DAILY_DATES` ends 2025-06-30. See `series_catalogue_ea.md` §3.

---

## 4. How to Test

```python
import sys; sys.path.insert(0, "backend")
from sweden_heatmap import get_daily_factors, get_fair_value, get_yield_pca
import numpy as np

fac = get_daily_factors()
for name, vals in fac.factors.items():
    print(f"  {name:15s}  mean={np.mean(vals):+.3f}  std={np.std(vals):.3f}")

fv = get_fair_value()
rc = np.array(fv.rich_cheap_bps)
print(f"\nSGB 10y rich/cheap: mean={rc.mean():+.1f}bps  last={rc[-1]:+.1f}bps")
```

### Verify Bloomberg tickers

```python
import sys; sys.path.insert(0, "backend")
from data_fetcher import get_fetcher

fetcher = get_fetcher("bloomberg")
data = fetcher.fetch(
    ["se_silf_pmi_manufacturing", "se_cpif_yoy",
     "se_unemployment_rate_lfs", "se_avg_hourly_earnings_yoy"],
    start="2022-01-01", end="2025-06-30",
)
for sid, series in data.items():
    print(f"{sid}: {len(series)} obs, last={series.iloc[-1]:.2f}")
```
