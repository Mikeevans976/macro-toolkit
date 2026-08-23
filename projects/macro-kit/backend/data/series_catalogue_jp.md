# series_catalogue_jp.json — Documentation

Catalogue for the **Japan Macro Heatmap**.  
Backend file: `backend/japan_heatmap.py`  
API routes: `GET /api/tools/japan-heatmap/{daily-factors,fair-value,yield-pca,pc-regressions}`

---

## 1. What Is In The Catalogue

### 1.1 Summary

| | Count |
|-|-------|
| Total series | 60 |
| DFM macro series (Block 1) | 44 |
| Bloomberg tickers | 42 / 60 (70%) |
| Haver tickers | 30 / 60 (50%) |

Japan has the largest total catalogue (60 series) — reflecting the richer set of
BoJ-watched indicators and the inclusion of more financial conditions series.

### 1.2 DFM macro series (44 series, Block 1)

| Factor | Series count | Primary series | Sign |
|--------|-------------|---------------|------|
| Growth | 16 | `jp_tankan_large_mfg_di` | +1 |
| Inflation | 9 | `jp_cpi_ex_fresh_food_yoy` | +1 |
| Employment | 9 | `jp_unemployment_rate` | −1 |
| Wages | 5 | `jp_total_cash_earnings_yoy` | +1 |

**Global Macro** anchor: `jp_jibun_composite_pmi` (+1).

Key differences from other regions:
- **Tankan** (BoJ quarterly survey) anchors the Growth factor — not PMI. This
  reflects the Tankan's status as the primary BoJ signal. However, it is
  quarterly, so 2 of every 3 monthly grid points will be NaN for that series.
- **CPI ex-Fresh Food** is the BoJ's official underlying inflation target
  measure (not core CPI, which excludes energy too).
- **Total Cash Earnings** includes bonuses (summer/winter), making wage data
  more volatile seasonally than in other regions.

### 1.3 Yield series (Block 2 — 5 JGB tenors)

| Series ID | Tenor |
|-----------|-------|
| `jp_jgb_2y` | 2y |
| `jp_jgb_5y` | 5y |
| `jp_jgb_10y` | 10y |
| `jp_jgb_20y` | 20y |
| `jp_jgb_30y` | 30y |

PCA sign conventions: PC1 @ 10y (index 2), PC2 @ 30y (index 4), PC3 @ 5y (index 1).

---

## 2. Architecture

The pipeline is identical to the Euro Area — see `series_catalogue_ea.md` §2
for the full data flow diagram. Region-specific differences:

| Config | Value |
|--------|-------|
| `bond_name` | JGB |
| `m_macro` | 44 |
| `catalogue_path` | `data/series_catalogue_jp.json` |
| `random_seed` | 77 |

---

## 3. Known Issues

### 3.1 Tankan is quarterly — sparse observation matrix

`jp_tankan_large_mfg_di` is released quarterly (March, June, September,
December surveys). Its column in the [T×44] observation matrix will be non-NaN
only ~4 times per year. The Kalman filter handles this natively, but the Tankan
contributes less to the smoother than monthly series in the same factor group.

### 3.2 YCC / yield curve control distortion

Through much of 2022–2024, the BoJ maintained Yield Curve Control (YCC),
capping the 10y JGB yield at first 0.25%, then 0.5%, then 1.0%. This means the
historical yield series used for PCA has structural breaks:

- **Simulation**: not affected (yields are synthesised from factors).
- **Live Bloomberg**: the PCA and fair value reconstruction will reflect the
  capped yield history. PC1 (level) will be artificially suppressed during YCC
  periods. Fair value estimates for the 10y JGB may be unreliable until enough
  post-YCC history accumulates.

Track BoJ policy announcements for the dates of each YCC modification and
consider truncating the yield history to the post-YCC period.

### 3.3 Wage data seasonal distortion

Japan's `jp_total_cash_earnings_yoy` spikes in June and December (bonus
payments). The Kalman filter treats these as genuine signal. If the model should
filter out bonus seasonality, the wage index excluding bonuses
(`jp_scheduled_earnings_yoy`, if catalogued) would be a cleaner anchor.

### 3.4 Date range is stale

Shared `DAILY_DATES` ends 2025-06-30. See `series_catalogue_ea.md` §3.

---

## 4. How to Test

```python
import sys; sys.path.insert(0, "backend")
from japan_heatmap import get_daily_factors, get_fair_value, get_yield_pca
import numpy as np

fac = get_daily_factors()
for name, vals in fac.factors.items():
    print(f"  {name:15s}  mean={np.mean(vals):+.3f}  std={np.std(vals):.3f}")

fv = get_fair_value()
rc = np.array(fv.rich_cheap_bps)
print(f"\nJGB 10y rich/cheap: mean={rc.mean():+.1f}bps  last={rc[-1]:+.1f}bps")

# In simulation, JGB 10y mean yield should be low (~0.5–1.5%)
pca = get_yield_pca()
for label, var in pca.explained_var.items():
    print(f"  {label}: {var:.1%}")
```

### Verify Bloomberg tickers (including Tankan)

```python
import sys; sys.path.insert(0, "backend")
from data_fetcher import get_fetcher

fetcher = get_fetcher("bloomberg")
data = fetcher.fetch(
    ["jp_tankan_large_mfg_di", "jp_jibun_composite_pmi",
     "jp_cpi_ex_fresh_food_yoy", "jp_total_cash_earnings_yoy"],
    start="2022-01-01", end="2025-06-30",
)
for sid, series in data.items():
    print(f"{sid}: {len(series)} obs, last={series.iloc[-1]:.2f}")
# Tankan: expect ~12 obs (quarterly over 3 years)
# PMI: expect ~42 obs (monthly)
```
