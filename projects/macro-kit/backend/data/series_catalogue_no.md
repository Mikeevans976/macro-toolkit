# series_catalogue_no.json — Documentation

Catalogue for the **Norway Macro Heatmap**.  
Backend file: `backend/norway_heatmap.py`  
API routes: `GET /api/tools/norway-heatmap/{daily-factors,fair-value,yield-pca,pc-regressions}`

---

## 1. What Is In The Catalogue

### 1.1 Summary

| | Count |
|-|-------|
| Total series | 52 |
| DFM macro series (Block 1) | 40 |
| Bloomberg tickers | 41 / 52 (79%) |
| Haver tickers | 23 / 52 (44%) |

### 1.2 DFM macro series (40 series, Block 1)

| Factor | Series count | Primary series | Sign |
|--------|-------------|---------------|------|
| Growth | 14 | `no_pmi_manufacturing` | +1 |
| Inflation | 7 | `no_cpi_ate_yoy` | +1 |
| Employment | 8 | `no_unemployment_rate_nav` | −1 |
| Wages | 4 | `no_annual_wage_growth_tbu` | +1 |

**Global Macro** anchor: `no_pmi_manufacturing` (+1).

Key series:
- **CPI-ATE** (CPI adjusted for tax changes and excluding energy) is Norges
  Bank's preferred underlying inflation measure — used as the Inflation anchor.
- **NAV unemployment** is the registered unemployment rate from the Norwegian
  Labour and Welfare Administration (seasonally adjusted). The LFS survey rate
  is more volatile and released less frequently.
- **Annual wage growth TBU** is the Technical Reporting Committee on Income
  Settlements' (TBU) estimate — the official input to wage negotiations. It is
  annual, released once per year (typically February). This is a strong policy
  signal but contributes very sparse observations to the Kalman smoother.

### 1.3 Yield series (Block 2 — 5 NGB tenors)

| Series ID | Tenor |
|-----------|-------|
| `no_ngb_2y` | 2y |
| `no_ngb_5y` | 5y |
| `no_ngb_10y` | 10y |
| `no_ngb_20y` | 20y |
| `no_ngb_30y` | 30y |

PCA sign conventions: PC1 @ 10y (index 2), PC2 @ 30y (index 4), PC3 @ 5y (index 1).

---

## 2. Architecture

The pipeline is identical to the Euro Area — see `series_catalogue_ea.md` §2
for the full data flow diagram. Region-specific differences:

| Config | Value |
|--------|-------|
| `bond_name` | NGB |
| `m_macro` | 40 |
| `catalogue_path` | `data/series_catalogue_no.json` |
| `random_seed` | 88 |

---

## 3. Known Issues

### 3.1 TBU wage growth is annual

`no_annual_wage_growth_tbu` is released once per year. Its DFM column will be
non-NaN for approximately 1 of 12 monthly observations. The Wages factor for
Norway is therefore the most sparsely identified of any region. The Kalman
smoother will rely heavily on the AR(1) transition model between annual releases.

Consider supplementing with a higher-frequency wage proxy (e.g. manufacturing
hourly wages from SSB) as a second Wages-factor series if available on Bloomberg
or Haver.

### 3.2 NGB liquidity at long tenors

Norwegian government bond markets are smaller than other DM markets. The 20y and
30y tenors may have gaps in Bloomberg pricing. The fetcher forward-fills ≤5
business days; longer gaps trigger yield simulation fallback.

### 3.3 Oil price sensitivity not captured in DFM

Norway's macro is heavily influenced by oil prices (Brent), which are not
included in the DFM factor model. Fair value estimates for NGBs may underperform
during large oil price moves. Consider adding `brent_crude_yoy` as a Growth
or Global Macro input series.

### 3.4 Date range is stale

Shared `DAILY_DATES` ends 2025-06-30. See `series_catalogue_ea.md` §3.

---

## 4. How to Test

```python
import sys; sys.path.insert(0, "backend")
from norway_heatmap import get_daily_factors, get_fair_value, get_yield_pca
import numpy as np

fac = get_daily_factors()
for name, vals in fac.factors.items():
    print(f"  {name:15s}  mean={np.mean(vals):+.3f}  std={np.std(vals):.3f}")

fv = get_fair_value()
rc = np.array(fv.rich_cheap_bps)
print(f"\nNGB 10y rich/cheap: mean={rc.mean():+.1f}bps  last={rc[-1]:+.1f}bps")
```

### Verify Bloomberg tickers

```python
import sys; sys.path.insert(0, "backend")
from data_fetcher import get_fetcher

fetcher = get_fetcher("bloomberg")
data = fetcher.fetch(
    ["no_pmi_manufacturing", "no_cpi_ate_yoy",
     "no_unemployment_rate_nav", "no_annual_wage_growth_tbu"],
    start="2022-01-01", end="2025-06-30",
)
for sid, series in data.items():
    print(f"{sid}: {len(series)} obs, last={series.iloc[-1]:.2f}")
# TBU wages: expect ~3 obs (annual, 2022/2023/2024)
```
