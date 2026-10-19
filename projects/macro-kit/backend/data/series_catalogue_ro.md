# series_catalogue_ro.json — Documentation

Catalogue for the **Romania Macro Heatmap** (EM bloc).  
Engine: `backend/regional_heatmap.py` (config in `backend/heatmap_regions.py`)  
API: `GET /api/tools/heatmap/{slug}`

Generated from the probed ticker list; every Bloomberg ticker was checked on the Terminal on 2026-10-18 (`backend/scripts/probe_catalogue.py data/series_catalogue_ro.json`).

## Factors

| Factor | Series | Primary (sign anchor) |
|---|---|---|
| Global Macro | all 11 | `ro_ip_yoy` (Industrial Production YoY) |
| Growth | 5 | `ro_ip_yoy` (Industrial Production YoY, sign +1) |
| Inflation | 3 | `ro_core_hicp_yoy` (Core HICP YoY (Eurostat), sign +1) |
| Employment | 2 | `ro_unemployment` (Unemployment Rate (SA), sign -1) |
| Wages | 1 | `ro_net_wages_yoy` (Average Net Wage YoY, sign +1) |

## Curve: ROMGB (BVAL)

| Tenor | Ticker |
|---|---|
| 2y | `BV020489 BVLI Index` |
| 3y | `BV030489 BVLI Index` |
| 5y | `BV050489 BVLI Index` |
| 7y | `BV070489 BVLI Index` |
| 10y | `BV100489 BVLI Index` |

## DFM series

| Col | Id | Ticker | Factor | Sign | Freq | Lag (d) | Transform | Group |
|---|---|---|---|---|---|---|---|---|
| 0 | `ro_ip_yoy` * | `ROIOUYOY Index` | Growth | +1 | monthly | 40 |  | Activity |
| 1 | `ro_retail_sales_yoy` | `RORSUYOY Index` | Growth | +1 | monthly | 35 |  | Consumer |
| 2 | `ro_esi` | `EUESRO Index` | Growth | +1 | monthly | 0 |  | Business Surveys |
| 3 | `ro_industrial_conf` | `EUICRO Index` | Growth | +1 | monthly | 0 |  | Business Surveys |
| 4 | `ro_consumer_conf` | `EUCCRO Index` | Growth | +1 | monthly | 0 |  | Consumer |
| 5 | `ro_core_hicp_yoy` * | `CPEXROY Index` | Inflation | +1 | monthly | 17 |  | Prices |
| 6 | `ro_cpi_yoy` | `ROCOPYOY Index` | Inflation | +1 | monthly | 12 |  | Prices |
| 7 | `ro_ppi_yoy` | `ROPPIYOY Index` | Inflation | +1 | monthly | 35 |  | Pipeline Prices |
| 8 | `ro_unemployment` * | `ROUERTYS Index` | Employment | -1 | monthly | 30 |  | Labour Market |
| 9 | `ro_mfg_employment_exp` | `EUI7RO Index` | Employment | +1 | monthly | 0 |  | Labour Market |
| 10 | `ro_net_wages_yoy` * | `ROWNLYOY Index` | Wages | +1 | monthly | 40 |  | Wages |

\* factor primary.

## Notes

- European Commission survey series (ESI, industrial and consumer confidence, manufacturing employment expectations) and Eurostat core HICP / unemployment fill gaps in the national data.
- The BVAL curve is flat beyond 10y (extrapolated), so the curve stops at 10y and there is no long-end regime section.
- No liquid inflation-linked market: no breakeven section.
