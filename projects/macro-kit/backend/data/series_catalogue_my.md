# series_catalogue_my.json — Documentation

Catalogue for the **Malaysia Macro Heatmap** (EM bloc).  
Engine: `backend/regional_heatmap.py` (config in `backend/heatmap_regions.py`)  
API: `GET /api/tools/heatmap/{slug}`

Generated from the probed ticker list; every Bloomberg ticker was checked on the Terminal on 2026-10-18 (`backend/scripts/probe_catalogue.py data/series_catalogue_my.json`).

## Factors

| Factor | Series | Primary (sign anchor) |
|---|---|---|
| Global Macro | all 11 | `my_ip_yoy` (Industrial Production YoY) |
| Growth | 5 | `my_ip_yoy` (Industrial Production YoY, sign +1) |
| Inflation | 3 | `my_core_cpi_yoy` (Core CPI YoY, sign +1) |
| Employment | 2 | `my_unemployment` (Unemployment Rate, sign -1) |
| Wages | 1 | `my_mfg_wages_yoy` (Manufacturing Salaries & Wages YoY, sign +1) |

## Curve: MGS (BVAL)

| Tenor | Ticker |
|---|---|
| 2y | `BV020128 BVLI Index` |
| 5y | `BV050128 BVLI Index` |
| 10y | `BV100128 BVLI Index` |
| 20y | `BV200128 BVLI Index` |
| 30y | `BV300128 BVLI Index` |

## DFM series

| Col | Id | Ticker | Factor | Sign | Freq | Lag (d) | Transform | Group |
|---|---|---|---|---|---|---|---|---|
| 0 | `my_ip_yoy` * | `MAIPINDY Index` | Growth | +1 | monthly | 40 |  | Activity |
| 1 | `my_manuf_yoy` | `MAIPMFGY Index` | Growth | +1 | monthly | 40 |  | Activity |
| 2 | `my_pmi_mfg` | `MPMIMYMA Index` | Growth | +1 | monthly | 1 |  | Business Surveys |
| 3 | `my_retail_sales_yoy` | `MARTTOTY Index` | Growth | +1 | monthly | 40 |  | Consumer |
| 4 | `my_exports_yoy` | `MAETEXSY Index` | Growth | +1 | monthly | 20 |  | External |
| 5 | `my_core_cpi_yoy` * | `MCPITOTY Index` | Inflation | +1 | monthly | 22 |  | Prices |
| 6 | `my_cpi_yoy` | `MACPIYOY Index` | Inflation | +1 | monthly | 22 |  | Prices |
| 7 | `my_ppi_yoy` | `MPPILYOY Index` | Inflation | +1 | monthly | 30 |  | Pipeline Prices |
| 8 | `my_unemployment` * | `MAEPMUN% Index` | Employment | -1 | monthly | 40 |  | Labour Market |
| 9 | `my_unemployed_persons` | `MAEPMUNM Index` | Employment | -1 | monthly | 40 |  | Labour Market |
| 10 | `my_mfg_wages_yoy` * | `MAMNSYOY Index` | Wages | +1 | monthly | 40 |  | Wages |

\* factor primary.

## Notes

- Wages are manufacturing salaries and wages (a single series).
- No inflation-linked market: no breakeven section.
