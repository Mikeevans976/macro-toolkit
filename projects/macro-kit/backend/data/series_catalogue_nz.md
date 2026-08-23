# series_catalogue_nz.json — Documentation

Catalogue for the **New Zealand Macro Heatmap**.  
Backend file: `backend/new_zealand_heatmap.py`  
API routes: `GET /api/tools/new-zealand-heatmap/{daily-factors,fair-value,yield-pca,pc-regressions}`

---

## 1. What Is In The Catalogue

### 1.1 Summary

| | Count |
|-|-------|
| Total series | 52 |
| DFM macro series (Block 1) | 42 |
| Bloomberg tickers | 44 / 52 (85%) |
| Haver tickers | 15 / 52 (29%) |

New Zealand has the highest Bloomberg coverage (85%) but the lowest Haver
coverage (29%) of all 9 regional heatmaps. Bloomberg is the only practical
live data source for this region.

### 1.2 DFM macro series (42 series, Block 1)

| Factor | Series count | Primary series | Sign |
|--------|-------------|---------------|------|
| Growth | 15 | `nz_pmi_manufacturing` | +1 |
| Inflation | 8 | `nz_non_tradables_cpi_yoy` | +1 |
| Employment | 8 | `nz_unemployment_rate_hlfs` | −1 |
| Wages | 4 | `nz_lci_yoy` | +1 |

**Global Macro** anchor: `nz_pmi_manufacturing` (+1).

Key series:
- **Non-Tradables CPI** is the RBNZ's preferred core inflation signal — it
  strips out imported price pressures (tradables) to isolate domestic
  inflation dynamics. Used as the Inflation factor anchor.
- **HLFS** (Household Labour Force Survey) unemployment rate is the official
  RBNZ-monitored measure.
- **LCI** (Labour Cost Index, salary and wage rates, quarterly) is the RBNZ's
  preferred wage measure over the more volatile QES average wages. It is
  quarterly, so observations are sparse.

### 1.3 Yield series (Block 2 — 5 NZGB tenors)

| Series ID | Tenor |
|-----------|-------|
| `nz_nzgb_2y` | 2y |
| `nz_nzgb_5y` | 5y |
| `nz_nzgb_10y` | 10y |
| `nz_nzgb_20y` | 20y |
| `nz_nzgb_30y` | 30y |

PCA sign conventions: PC1 @ 10y (index 2), PC2 @ 30y (index 4), PC3 @ 5y (index 1).

---

## 2. Architecture

The pipeline is identical to the Euro Area — see `series_catalogue_ea.md` §2
for the full data flow diagram. Region-specific differences:

| Config | Value |
|--------|-------|
| `bond_name` | NZGB |
| `m_macro` | 42 |
| `catalogue_path` | `data/series_catalogue_nz.json` |
| `random_seed` | 11 |

---

## 3. Known Issues

### 3.1 Haver coverage is very low (29%)

Only 15 of 52 series have Haver tickers. `ANALYTICS_DATA_SOURCE=haver` will
produce a severely degraded model — nearly all series will be missing and the
pipeline will fall back to full simulation. **Bloomberg is required** for live
data on NZ.

### 3.2 LCI is quarterly

`nz_lci_yoy` (Labour Cost Index) is released quarterly. The Wages factor for
NZ is sparsely identified in the same way as Norway's TBU wage series. Consider
adding QES average ordinary time hourly earnings as a monthly supplement if
available on Bloomberg.

### 3.3 CPI is quarterly (not monthly)

New Zealand CPI is released **quarterly** (January, April, July, October). This
means all 8 Inflation-factor series have at most 4 observations per year. The
Kalman smoother identifies inflation dynamics predominantly from the AR(1)
transition between quarterly CPI releases. The Non-Tradables component follows
the same quarterly cadence.

This is a fundamental data limitation for NZ — the Inflation factor will be
less precisely estimated than for regions with monthly CPI.

### 3.4 NZGB 20y and 30y tenor liquidity

The New Zealand government bond curve at long maturities is thin. The 20y and
30y NZGB lines may have extended gaps in Bloomberg. Simulation fallback for
Block 2 is more likely for NZ than for larger DM markets.

### 3.5 Date range is stale

Shared `DAILY_DATES` ends 2025-06-30. See `series_catalogue_ea.md` §3.

---

## 4. How to Test

```python
import sys; sys.path.insert(0, "backend")
from new_zealand_heatmap import get_daily_factors, get_fair_value, get_yield_pca
import numpy as np

fac = get_daily_factors()
for name, vals in fac.factors.items():
    print(f"  {name:15s}  mean={np.mean(vals):+.3f}  std={np.std(vals):.3f}")

fv = get_fair_value()
rc = np.array(fv.rich_cheap_bps)
print(f"\nNZGB 10y rich/cheap: mean={rc.mean():+.1f}bps  last={rc[-1]:+.1f}bps")
```

### Verify Bloomberg tickers

```python
import sys; sys.path.insert(0, "backend")
from data_fetcher import get_fetcher

fetcher = get_fetcher("bloomberg")
data = fetcher.fetch(
    ["nz_pmi_manufacturing", "nz_non_tradables_cpi_yoy",
     "nz_unemployment_rate_hlfs", "nz_lci_yoy"],
    start="2022-01-01", end="2025-06-30",
)
for sid, series in data.items():
    print(f"{sid}: {len(series)} obs, last={series.iloc[-1]:.2f}")
# CPI-based series: expect ~12 obs (quarterly over 3 years)
# LCI: expect ~12 obs (quarterly)
# PMI: expect ~42 obs (monthly)
```
