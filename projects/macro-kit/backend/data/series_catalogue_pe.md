# series_catalogue_pe.json — Documentation

Catalogue for the **Peru Macro Heatmap** (EM bloc).  
Engine: `backend/regional_heatmap.py` (config in `backend/heatmap_regions.py`)  
API: `GET /api/tools/heatmap/{slug}`

Generated from the probed ticker list; every Bloomberg ticker was checked on the Terminal on 2026-10-18 (`backend/scripts/probe_catalogue.py data/series_catalogue_pe.json`).

## Factors

| Factor | Series | Primary (sign anchor) |
|---|---|---|
| Global Macro | all 11 | `pe_activity_yoy` (BCRP Economic Activity YoY) |
| Growth | 6 | `pe_activity_yoy` (BCRP Economic Activity YoY, sign +1) |
| Inflation | 4 | `pe_core_cpi_yoy` (Lima Core CPI YoY, sign +1) |
| Employment | 1 | `pe_unemployment_lima` (Lima Unemployment Rate, sign -1) |

## Curve: Soberano (BVAL)

| Tenor | Ticker |
|---|---|
| 2y | `BV020995 BVLI Index` |
| 5y | `BV050995 BVLI Index` |
| 10y | `BV100995 BVLI Index` |
| 20y | `BV200995 BVLI Index` |
| 30y | `BV300995 BVLI Index` |

## DFM series

| Col | Id | Ticker | Factor | Sign | Freq | Lag (d) | Transform | Group |
|---|---|---|---|---|---|---|---|---|
| 0 | `pe_activity_yoy` * | `PRGDPYOY Index` | Growth | +1 | monthly | 45 |  | Activity |
| 1 | `pe_manuf_yoy` | `PRGDNYOY Index` | Growth | +1 | monthly | 45 |  | Activity |
| 2 | `pe_business_exp_economy` | `PECSECON Index` | Growth | +1 | monthly | 10 |  | Business Surveys |
| 3 | `pe_business_exp_sector` | `PECSSECT Index` | Growth | +1 | monthly | 10 |  | Business Surveys |
| 4 | `pe_traditional_exports_yoy` | `PTETTOT Index` | Growth | +1 | monthly | 40 | yoy | External |
| 5 | `pe_trade_balance` | `PERTBAL Index` | Growth | +1 | monthly | 45 |  | External |
| 6 | `pe_core_cpi_yoy` * | `PRCPCOYO Index` | Inflation | +1 | monthly | 1 |  | Prices |
| 7 | `pe_cpi_yoy` | `PRCPALLY Index` | Inflation | +1 | monthly | 1 |  | Prices |
| 8 | `pe_wpi_yoy` | `PRWPYOY Index` | Inflation | +1 | monthly | 1 |  | Pipeline Prices |
| 9 | `pe_infl_exp_12m` | `PEMSCPI Index` | Inflation | +1 | monthly | 5 |  | Inflation Expectations |
| 10 | `pe_unemployment_lima` * | `PRUEUER Index` | Employment | -1 | monthly | 15 |  | Labour Market |

\* factor primary.

## Notes

- Employment is the Lima metropolitan unemployment rate only (a single series); no Wages factor.
- VAC (inflation-linked) bonds exist but no BVAL real curve was found: no breakeven section.
