# series_catalogue_cl.json — Documentation

Catalogue for the **Chile Macro Heatmap** (EM bloc).  
Engine: `backend/regional_heatmap.py` (config in `backend/heatmap_regions.py`)  
API: `GET /api/tools/heatmap/{slug}`

Generated from the probed ticker list; every Bloomberg ticker was checked on the Terminal on 2026-10-18 (`backend/scripts/probe_catalogue.py data/series_catalogue_cl.json`).

## Factors

| Factor | Series | Primary (sign anchor) |
|---|---|---|
| Global Macro | all 14 | `cl_imacec_yoy` (IMACEC Economic Activity YoY) |
| Growth | 8 | `cl_imacec_yoy` (IMACEC Economic Activity YoY, sign +1) |
| Inflation | 2 | `cl_cpi_yoy` (Headline CPI YoY, sign +1) |
| Employment | 2 | `cl_unemployment` (Unemployment Rate, sign -1) |
| Wages | 2 | `cl_hourly_wage_yoy` (Nominal Hourly Wage YoY (SA), sign +1) |

## Curve: BTP (BVAL)

| Tenor | Ticker |
|---|---|
| 2y | `BV02CLPG BVLI Index` |
| 3y | `BV03CLPG BVLI Index` |
| 5y | `BV05CLPG BVLI Index` |
| 7y | `BV07CLPG BVLI Index` |
| 10y | `BV10CLPG BVLI Index` |
| 10y real | `BV10BCUC BVLI Index` |

## DFM series

| Col | Id | Ticker | Factor | Sign | Freq | Lag (d) | Transform | Group |
|---|---|---|---|---|---|---|---|---|
| 0 | `cl_imacec_yoy` * | `CLIMYOYN Index` | Growth | +1 | monthly | 32 |  | Activity |
| 1 | `cl_ip_yoy` | `CHIPTOTY Index` | Growth | +1 | monthly | 30 |  | Activity |
| 2 | `cl_manuf_yoy` | `CHIPMFGY Index` | Growth | +1 | monthly | 30 |  | Activity |
| 3 | `cl_copper_production_yoy` | `CLPCTOTL Index` | Growth | +1 | monthly | 30 | yoy | Activity |
| 4 | `cl_retail_sales_yoy` | `CLRTRYOY Index` | Growth | +1 | monthly | 30 |  | Consumer |
| 5 | `cl_business_conf` | `CHBCIMCE Index` | Growth | +1 | monthly | 5 |  | Business Surveys |
| 6 | `cl_consumer_conf` | `CLCECTRY Index` | Growth | +1 | monthly | 5 |  | Consumer |
| 7 | `cl_exports_yoy` | `ECOYECLN Index` | Growth | +1 | monthly | 7 | yoy | External |
| 8 | `cl_cpi_yoy` * | `CNPINSYO Index` | Inflation | +1 | monthly | 8 |  | Prices |
| 9 | `cl_core_cpi_yoy` | `CNPISAYO Index` | Inflation | +1 | monthly | 8 |  | Prices |
| 10 | `cl_unemployment` * | `CHUETOTL Index` | Employment | -1 | monthly | 30 |  | Labour Market |
| 11 | `cl_employment_yoy` | `CHLSEMPD Index` | Employment | +1 | monthly | 30 | yoy | Labour Market |
| 12 | `cl_hourly_wage_yoy` * | `CHHNSAYO Index` | Wages | +1 | monthly | 35 |  | Wages |
| 13 | `cl_hourly_wage_nsa_yoy` | `CHHNYOY Index` | Wages | +1 | monthly | 35 |  | Wages |

\* factor primary.

## Notes

- Curve: Bonos Tesorería Pesos BVAL, 2y-10y (flat beyond 10y).
- Breakeven: 10y BTP minus the 10y UF-linked (BCU) BVAL real yield.
- Core CPI was rebased in 2024; the new series has ~3 years of history, so headline CPI anchors the Inflation factor.
