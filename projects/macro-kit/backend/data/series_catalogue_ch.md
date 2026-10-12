# series_catalogue_ch.json — Documentation

Catalogue for the **Switzerland Macro Heatmap**.  
Backend file: `backend/switzerland_heatmap.py`  
API routes: `GET /api/tools/switzerland-heatmap/{daily-factors,fair-value,yield-pca,pc-regressions}`

---

## 1. What Is In The Catalogue

### 1.1 Summary

| | Count |
|-|-------|
| Total series | 52 |
| DFM macro series (Block 1) | 42 |
| Bloomberg tickers | 42 / 52 (81%) |
| Haver tickers | 22 / 52 (42%) |

### 1.2 DFM macro series (42 series, Block 1)

| Factor | Series count | Primary series | Sign |
|--------|-------------|---------------|------|
| Growth | 14 | `ch_pmi_manufacturing` | +1 |
| Inflation | 8 | `ch_core_cpi_excl_fe_yoy` | +1 |
| Employment | 8 | `ch_unemployment_rate_seco` | −1 |
| Wages | 4 | `ch_nominal_wage_index_yoy` | +1 |

**Global Macro** anchor: `ch_pmi_manufacturing` (+1).

Key series: Switzerland uses the SECO seasonally-adjusted unemployment rate as
the Employment anchor (not the raw LFS rate). The SNB monitors CPI ex-Food &
Energy as its preferred underlying measure.

### 1.3 Yield series (Block 2 — 5 Confederation bond tenors)

| Series ID | Tenor |
|-----------|-------|
| `ch_conf_2y` | 2y |
| `ch_conf_5y` | 5y |
| `ch_conf_10y` | 10y |
| `ch_conf_20y` | 20y |
| `ch_conf_30y` | 30y |

PCA sign conventions: PC1 @ 10y (index 2), PC2 @ 30y (index 4), PC3 @ 5y (index 1).

---

## 2. Architecture

The pipeline is identical to the Euro Area — see `series_catalogue_ea.md` §2
for the full data flow diagram. Region-specific differences:

| Config | Value |
|--------|-------|
| `bond_name` | Confederation |
| `m_macro` | 42 |
| `catalogue_path` | `data/series_catalogue_ch.json` |
| `random_seed` | 33 |

---

## 3. Known Issues

### 3.1 Haver coverage is low (42%)

Bloomberg is the primary source for Swiss data — Haver coverage is thin.
22 of 52 entries have Haver tickers.

### 3.2 Swiss Confederation bond liquidity

Swiss Confederation bonds are less liquid than other DM sovereign markets,
particularly at the 20y and 30y tenors. Bloomberg yield series for long tenors
may have gaps; the fetcher forward-fills ≤5 business days, but longer gaps will
cause yield simulation fallback.

### 3.3 SNF wage data frequency

Swiss nominal wage data (`ch_nominal_wage_index_yoy`) is annual, not monthly.
`typical_lag_days` in the catalogue should reflect the ~3–4 month publication
lag. The Kalman filter handles annual observation frequency natively (11 of 12
monthly grid points will be NaN), but the Wages factor may be less precisely
identified than for regions with monthly wage data.

### 3.4 Date range is stale

Shared `DAILY_DATES` ends 2025-06-30. See `series_catalogue_ea.md` §3.

---

## 4. How to Test

```python
import sys; sys.path.insert(0, "backend")
from switzerland_heatmap import get_daily_factors, get_fair_value, get_yield_pca
import numpy as np

fac = get_daily_factors()
for name, vals in fac.factors.items():
    print(f"  {name:15s}  mean={np.mean(vals):+.3f}  std={np.std(vals):.3f}")

fv = get_fair_value()
rc = np.array(fv.rich_cheap_bps)
print(f"\nConfederation 10y rich/cheap: mean={rc.mean():+.1f}bps  last={rc[-1]:+.1f}bps")
```

### Verify Bloomberg tickers

```python
import sys; sys.path.insert(0, "backend")
from data_fetcher import get_fetcher

fetcher = get_fetcher("bloomberg")
data = fetcher.fetch(
    ["ch_pmi_manufacturing", "ch_core_cpi_excl_fe_yoy", "ch_unemployment_rate_seco"],
    start="2022-01-01", end="2025-06-30",
)
for sid, series in data.items():
    print(f"{sid}: {len(series)} obs, last={series.iloc[-1]:.2f}")
```
