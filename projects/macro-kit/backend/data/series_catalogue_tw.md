# series_catalogue_tw.json — Documentation

Catalogue for the **Taiwan Macro Heatmap** (EM bloc).  
Engine: `backend/regional_heatmap.py` (config in `backend/heatmap_regions.py`)  
API: `GET /api/tools/heatmap/{slug}`

Generated from the probed ticker list; every Bloomberg ticker was checked on the Terminal on 2026-10-18 (`backend/scripts/probe_catalogue.py data/series_catalogue_tw.json`).

## Factors

| Factor | Series | Primary (sign anchor) |
|---|---|---|
| Global Macro | all 11 | `tw_export_orders_yoy` (Export Orders YoY) |
| Growth | 3 | `tw_ip_yoy` (Industrial Production YoY, sign +1) |
| Inflation | 3 | `tw_core_cpi_yoy` (Core CPI YoY, sign +1) |
| Employment | 1 | `tw_unemployment_sa` (Unemployment Rate (SA), sign -1) |
| Wages | 2 | `tw_mfg_earnings_yoy` (Manufacturing Average Monthly Earnings YoY, sign +1) |
| External | 2 | `tw_export_orders_yoy` (Export Orders YoY, sign +1) |

## Curve: TGB (BVAL)

| Tenor | Ticker |
|---|---|
| 2y | `BV020126 BVLI Index` |
| 5y | `BV050126 BVLI Index` |
| 10y | `BV100126 BVLI Index` |
| 20y | `BV200126 BVLI Index` |
| 30y | `BV300126 BVLI Index` |

## DFM series

| Col | Id | Ticker | Factor | Sign | Freq | Lag (d) | Transform | Group |
|---|---|---|---|---|---|---|---|---|
| 0 | `tw_ip_yoy` * | `TWINDPIY Index` | Growth | +1 | monthly | 23 |  | Activity |
| 1 | `tw_pmi_mfg` | `MPMITWMA Index` | Growth | +1 | monthly | 1 |  | Business Surveys |
| 2 | `tw_retail_sales_yoy` | `TARSYOY Index` | Growth | +1 | monthly | 23 |  | Consumer |
| 3 | `tw_core_cpi_yoy` * | `TWCOCPIY Index` | Inflation | +1 | monthly | 7 |  | Prices |
| 4 | `tw_cpi_yoy` | `TWCPIYOY Index` | Inflation | +1 | monthly | 7 |  | Prices |
| 5 | `tw_ppi_yoy` | `TWPPIYOY Index` | Inflation | +1 | monthly | 7 |  | Pipeline Prices |
| 6 | `tw_unemployment_sa` * | `TWLFADJ Index` | Employment | -1 | monthly | 22 |  | Labour Market |
| 7 | `tw_mfg_earnings_yoy` * | `TWLCEARY Index` | Wages | +1 | monthly | 50 |  | Wages |
| 8 | `tw_earnings_yoy` | `TWMET Index` | Wages | +1 | monthly | 50 | yoy | Wages |
| 9 | `tw_export_orders_yoy` * | `TWEOTTLY Index` | External | +1 | monthly | 20 |  | Trade |
| 10 | `tw_exports_yoy` | `TWTREXPY Index` | External | +1 | monthly | 7 |  | Trade |

\* factor primary.

## Notes

- An External factor (export orders and exports) sits alongside the usual four; export orders also anchor Global Macro.
- No inflation-linked market: no breakeven section.
