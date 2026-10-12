# series_catalogue_us.json — Documentation

Catalogue for the **US Macro Heatmap**.  
Backend file: `backend/us_heatmap.py`  
API routes: `GET /api/tools/us-heatmap/{daily-factors,fair-value,yield-pca,pc-regressions}`

---

## 1. What Is In The Catalogue

### 1.1 Summary

| | Count |
|-|-------|
| Total series | 71 |
| DFM macro series (Block 1) | 56 |
| Bloomberg tickers | 63 / 71 (89%) |
| Haver tickers | 59 / 71 (83%) |

The US catalogue is the largest of all regional heatmaps (71 series, 56 DFM
inputs) and has the best dual-source coverage — both Bloomberg and Haver are
well-populated.

### 1.2 DFM macro series (56 series, Block 1)

| Factor | Series count | Primary series | Sign |
|--------|-------------|---------------|------|
| Growth | 20 | `us_ism_manufacturing_pmi` | +1 |
| Inflation | 18 | `us_cpi_core_yoy` | +1 |
| Employment | 16 | `us_unemployment_rate` | −1 |
| Wages | 6 | `us_avg_hourly_earnings_yoy` | +1 |

**Global Macro** anchor: `us_spglobal_composite_pmi` (+1).

Note that ISM Manufacturing PMI anchors the **Growth** factor, while S&P Global
Composite PMI anchors **Global Macro**. Both are in the catalogue; they play
different roles in the model.

Key design choices:
- **Inflation** has 18 series — the largest inflation block of any region,
  reflecting the Fed's dual mandate and the richness of US price data (CPI
  headline/core, PCE headline/core/supercore, PPI, import prices, inflation
  expectations from Michigan and NY Fed).
- **Employment** has 16 series — similarly dense, covering unemployment rate,
  payrolls, jobless claims (initial + continuing), JOLTS (openings, quits,
  hires), labour force participation, and U-6 underemployment.
- **Wages** includes the Employment Cost Index (ECI) and Unit Labour Costs
  alongside the more timely Average Hourly Earnings.

### 1.3 Data frequency mix

| Frequency | Series count | Examples |
|-----------|-------------|---------|
| Monthly | ~45 | CPI, payrolls, PMIs, retail sales |
| Quarterly | ~8 | GDP, ECI, ULC, productivity, Case-Shiller |
| Daily | ~11 | Fed funds rate, UST yields, SOFR, FX, equities |

Quarterly series (GDP, ECI, ULC, productivity) contribute only ~4 observations
per year to the observation matrix. The Kalman filter handles the sparse panel
natively, but these series have less influence on the smoother than monthly ones.

### 1.4 Yield series (Block 2 — 5 UST tenors)

| Series ID | Tenor | Yield mean (sim) |
|-----------|-------|-----------------|
| `us_ust_2y` | 2y | 4.00% |
| `us_ust_5y` | 5y | 4.15% |
| `us_ust_10y` | 10y | 4.48% |
| `us_ust_20y` | 20y | 4.85% |
| `us_ust_30y` | 30y | 4.75% |

PCA sign conventions: PC1 @ 10y (index 2), PC2 @ 30y (index 4), PC3 @ 5y (index 1).

### 1.5 Derived series

Two series have `source: "derived"` and no vendor ticker:
- `us_ust_2s10s` — 2s10s Treasury curve spread
- `us_ust_5s30s` — 5s30s Treasury curve spread

These are computed downstream (likely from yield series) and not fetched from
Bloomberg/Haver. The fetcher silently skips derived series.

---

## 2. Architecture

The pipeline is identical to the Euro Area — see `series_catalogue_ea.md` §2
for the full data flow diagram. Region-specific differences:

| Config | Value |
|--------|-------|
| `bond_name` | UST |
| `m_macro` | 56 |
| `catalogue_path` | `data/series_catalogue_us.json` |
| `random_seed` | 42 |
| `yield_means` | 4.00 / 4.15 / 4.48 / 4.85 / 4.75% (2y→30y) |

**Inflation dominates short-end UST yields** in the factor loading matrix:
the Inflation factor loading on the 2y is 0.50 — the highest of any tenor or
factor. Growth dominates the long end (0.24 at 30y). This reflects the market
pricing dynamic where 2y rates are most sensitive to Fed rate expectations
(driven by inflation and employment) while 30y rates are more driven by
long-run growth expectations.

---

## 3. Known Issues

### 3.1 Bloomberg-only series (5 series)

These series have no Haver ticker and are therefore unavailable when running
with `ANALYTICS_DATA_SOURCE=haver`:
- CPI Supercore (services ex-shelter)
- PCE Supercore
- NY Fed 3y Inflation Expectations
- PPI Core
- Atlanta Fed Wage Tracker

All five are Bloomberg-only. For a Haver deployment, these columns will remain
NaN and fall back to AR(1) imputation in the Kalman smoother.

### 3.2 Quarterly series are sparse

GDP, ECI, ULC, productivity, and Case-Shiller contribute ~4 observations per
year each. The Employment factor (which includes ECI) and the Growth factor
(which includes GDP) rely heavily on the AR(1) transition model between
quarterly releases. This is by design but worth knowing when interpreting factor
dynamics in months without major quarterly data releases.

### 3.3 Date range is stale

Shared `DAILY_DATES` ends 2025-06-30. See `series_catalogue_ea.md` §3.

### 3.4 Heatmap grid is synthetic

The z-score grid in the frontend is deterministic synthetic data, not live DFM
output.

---

## 4. How to Test

### 4.1 Simulation mode

```python
import sys; sys.path.insert(0, "backend")
from us_heatmap import get_daily_factors, get_fair_value, get_yield_pca
import numpy as np

fac = get_daily_factors()
print(f"Date range: {fac.dates[0]} → {fac.dates[-1]}  ({len(fac.dates)} days)")
for name, vals in fac.factors.items():
    print(f"  {name:15s}  mean={np.mean(vals):+.3f}  std={np.std(vals):.3f}")

fv = get_fair_value()
rc = np.array(fv.rich_cheap_bps)
print(f"\nUST 10y rich/cheap: mean={rc.mean():+.1f}bps  last={rc[-1]:+.1f}bps")

pca = get_yield_pca()
for label, var in pca.explained_var.items():
    print(f"  {label}: {var:.1%}")
```

### 4.2 Verify Bloomberg tickers for key series

```python
import sys; sys.path.insert(0, "backend")
from data_fetcher import get_fetcher
import pandas as pd

fetcher = get_fetcher("bloomberg")
data = fetcher.fetch(
    ["us_ism_manufacturing_pmi", "us_spglobal_composite_pmi",
     "us_cpi_core_yoy", "us_unemployment_rate",
     "us_avg_hourly_earnings_yoy", "us_nonfarm_payrolls"],
    start="2022-01-01", end="2025-06-30",
)
for sid, series in data.items():
    print(f"{sid}: {len(series)} obs, last={series.iloc[-1]:.2f} ({series.index[-1]})")
```

### 4.3 Check quarterly series observation count

```python
import sys; sys.path.insert(0, "backend")
from data_fetcher import get_fetcher

fetcher = get_fetcher("bloomberg")
quarterly = ["us_real_gdp_qoq_saar", "us_eci_total_qoq", "us_nfb_unit_labour_costs_qoq"]
data = fetcher.fetch(quarterly, start="2022-01-01", end="2025-06-30")
for sid, series in data.items():
    print(f"{sid}: {len(series)} obs (expect ~14 for quarterly over 3.5 years)")
```

### 4.4 Test full live run

```bash
ANALYTICS_DATA_SOURCE=bloomberg uvicorn backend.main:app --reload --port 8000
curl http://localhost:8000/api/tools/us-heatmap/daily-factors \
  -H "Authorization: Bearer <token>" | python3 -m json.tool | head -20
```

---

## 5. What Has To Be Added

### 5.1 Haver tickers for Bloomberg-only series

The 5 Bloomberg-only series (CPI Supercore, PCE Supercore, NY Fed 3y exp, PPI
Core, Atlanta Fed Wage Tracker) could potentially be sourced from Haver or
alternative databases. If Haver equivalents exist, add `ticker_haver` to those
entries.

### 5.2 Fix the hard-coded date range

See `series_catalogue_ea.md` §3. Same fix needed in `regional_heatmap.py`.

### 5.3 Wire live data to the heatmap grid

Same as EA — the z-score grid is currently synthetic. A new API endpoint
returning DFM-based per-series z-scores would be needed to show live data in
the grid.
