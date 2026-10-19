# series_catalogue_tr.json — Documentation

Catalogue for the **Turkey Macro Heatmap** (EM bloc).  
Engine: `backend/regional_heatmap.py` (config in `backend/heatmap_regions.py`)  
API: `GET /api/tools/heatmap/{slug}`

Generated from the probed ticker list; every Bloomberg ticker was checked on the Terminal on 2026-10-18 (`backend/scripts/probe_catalogue.py data/series_catalogue_tr.json`).

## Factors

| Factor | Series | Primary (sign anchor) |
|---|---|---|
| Global Macro | all 13 | `tr_ip_yoy` (Industrial Production YoY (SWDA)) |
| Growth | 7 | `tr_ip_yoy` (Industrial Production YoY (SWDA), sign +1) |
| Inflation | 4 | `tr_core_cpi_d12m` (Core CPI YoY, 12m Change, sign +1) |
| Employment | 2 | `tr_unemployment_sa` (Unemployment Rate (SA), sign -1) |

## Curve: TURKGB (BVAL)

| Tenor | Ticker |
|---|---|
| 2y | `BV020965 BVLI Index` |
| 3y | `BV030965 BVLI Index` |
| 5y | `BV050965 BVLI Index` |
| 7y | `BV070965 BVLI Index` |
| 10y | `BV100965 BVLI Index` |

## DFM series

| Col | Id | Ticker | Factor | Sign | Freq | Lag (d) | Transform | Group |
|---|---|---|---|---|---|---|---|---|
| 0 | `tr_ip_yoy` * | `TUIOSAYY Index` | Growth | +1 | monthly | 40 |  | Activity |
| 1 | `tr_retail_sales_yoy` | `TRRDLVLY Index` | Growth | +1 | monthly | 35 |  | Consumer |
| 2 | `tr_pmi_mfg` | `MPMITRMA Index` | Growth | +1 | monthly | 1 |  | Business Surveys |
| 3 | `tr_capacity_utilisation` | `TYCOLEVS Index` | Growth | +1 | monthly | 0 |  | Business Surveys |
| 4 | `tr_real_sector_conf` | `TUCOGY1S Index` | Growth | +1 | monthly | 0 |  | Business Surveys |
| 5 | `tr_consumer_conf` | `TUCDCNF2 Index` | Growth | +1 | monthly | 0 |  | Consumer |
| 6 | `tr_exports_yoy` | `ECOYETRN Index` | Growth | +1 | monthly | 30 | yoy | External |
| 7 | `tr_core_cpi_d12m` * | `TUCXEFYY Index` | Inflation | +1 | monthly | 3 | diff_yoy | Prices |
| 8 | `tr_cpi_d12m` | `TUCPIY Index` | Inflation | +1 | monthly | 3 | diff_yoy | Prices |
| 9 | `tr_cpi_services_d12m` | `TUCPSSY Index` | Inflation | +1 | monthly | 3 | diff_yoy | Prices |
| 10 | `tr_ppi_d12m` | `TUDPYOY Index` | Inflation | +1 | monthly | 3 | diff_yoy | Pipeline Prices |
| 11 | `tr_unemployment_sa` * | `TUUNRSA Index` | Employment | -1 | monthly | 40 |  | Labour Market |
| 12 | `tr_employment_rate` | `TULSER Index` | Employment | +1 | monthly | 40 |  | Labour Market |

\* factor primary.

## Notes

- Inflation regime: y/y inflation ran from ~20% to ~85% and back within the window, so raw levels would dominate every z-score. The inflation series enter as the 12-month change in the y/y rate (`diff_yoy`): the factor reads disinflation (negative) versus re-acceleration (positive).
- The curve stops at 10y (BVAL 1y-10y, inverted for most of the window); there is no long-end regime section.
- No monthly wage series: no Wages factor. CPI-indexed bonds exist but no BVAL real curve was found: no breakeven section.
