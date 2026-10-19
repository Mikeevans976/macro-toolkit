# series_catalogue_pl.json — Documentation

Catalogue for the **Poland Macro Heatmap** (EM bloc).  
Engine: `backend/regional_heatmap.py` (config in `backend/heatmap_regions.py`)  
API: `GET /api/tools/heatmap/{slug}`

Generated from the probed ticker list; every Bloomberg ticker was checked on the Terminal on 2026-10-18 (`backend/scripts/probe_catalogue.py data/series_catalogue_pl.json`).

## Factors

| Factor | Series | Primary (sign anchor) |
|---|---|---|
| Global Macro | all 14 | `pl_ip_yoy` (Sold Industrial Output YoY) |
| Growth | 7 | `pl_ip_yoy` (Sold Industrial Output YoY, sign +1) |
| Inflation | 4 | `pl_core_cpi_yoy` (Core CPI (ex Food & Energy) YoY, sign +1) |
| Employment | 2 | `pl_unemployment` (Registered Unemployment Rate, sign -1) |
| Wages | 1 | `pl_wages_yoy` (Enterprise-Sector Gross Wage YoY, sign +1) |

## Curve: POLGB (BVAL)

| Tenor | Ticker |
|---|---|
| 2y | `BV020119 BVLI Index` |
| 3y | `BV030119 BVLI Index` |
| 5y | `BV050119 BVLI Index` |
| 7y | `BV070119 BVLI Index` |
| 10y | `BV100119 BVLI Index` |

## DFM series

| Col | Id | Ticker | Factor | Sign | Freq | Lag (d) | Transform | Group |
|---|---|---|---|---|---|---|---|---|
| 0 | `pl_ip_yoy` * | `POISCYOY Index` | Growth | +1 | monthly | 20 |  | Activity |
| 1 | `pl_construction_yoy` | `POOSCYOY Index` | Growth | +1 | monthly | 22 |  | Activity |
| 2 | `pl_retail_sales_yoy` | `PORSYOY Index` | Growth | +1 | monthly | 22 |  | Consumer |
| 3 | `pl_pmi_mfg` | `MPMIPLMA Index` | Growth | +1 | monthly | 1 |  | Business Surveys |
| 4 | `pl_business_climate_mfg` | `PLBTBCM Index` | Growth | +1 | monthly | 0 |  | Business Surveys |
| 5 | `pl_business_climate_construction` | `PLBTBCC Index` | Growth | +1 | monthly | 0 |  | Business Surveys |
| 6 | `pl_consumer_conf` | `POCSBWUK Index` | Growth | +1 | monthly | 0 |  | Consumer |
| 7 | `pl_core_cpi_yoy` * | `POBIEYOY Index` | Inflation | +1 | monthly | 16 |  | Prices |
| 8 | `pl_cpi_yoy` | `POCPIYOY Index` | Inflation | +1 | monthly | 15 |  | Prices |
| 9 | `pl_cpi_food_yoy` | `POCPFDYY Index` | Inflation | +1 | monthly | 15 |  | Prices |
| 10 | `pl_ppi_yoy` | `POPPIYOY Index` | Inflation | +1 | monthly | 20 |  | Pipeline Prices |
| 11 | `pl_unemployment` * | `POUER Index` | Employment | -1 | monthly | 25 |  | Labour Market |
| 12 | `pl_employment_yoy` | `POEYYOY Index` | Employment | +1 | monthly | 20 |  | Labour Market |
| 13 | `pl_wages_yoy` * | `POWGYOY Index` | Wages | +1 | monthly | 20 |  | Wages |

\* factor primary.

## Notes

- Curve stops at 10y (the BVAL curve beyond 10y is flat extrapolation), so there is no 2s30s section.
- Wages has a single series (enterprise-sector gross wage); the factor is that series, smoothed.
- No meaningful inflation-linked market: no breakeven section.
