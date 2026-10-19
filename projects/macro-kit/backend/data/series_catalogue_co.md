# series_catalogue_co.json — Documentation

Catalogue for the **Colombia Macro Heatmap** (EM bloc).  
Engine: `backend/regional_heatmap.py` (config in `backend/heatmap_regions.py`)  
API: `GET /api/tools/heatmap/{slug}`

Generated from the probed ticker list; every Bloomberg ticker was checked on the Terminal on 2026-10-18 (`backend/scripts/probe_catalogue.py data/series_catalogue_co.json`).

## Factors

| Factor | Series | Primary (sign anchor) |
|---|---|---|
| Global Macro | all 9 | `co_ip_yoy` (Industrial Production YoY) |
| Growth | 4 | `co_ip_yoy` (Industrial Production YoY, sign +1) |
| Inflation | 3 | `co_core_cpi_yoy` (Core CPI (ex Food & Regulated) YoY, sign +1) |
| Employment | 2 | `co_unemployment_sa` (Unemployment Rate (SA), sign -1) |

## Curve: TES (BVAL)

| Tenor | Ticker |
|---|---|
| 2y | `BV020477 BVLI Index` |
| 5y | `BV050477 BVLI Index` |
| 10y | `BV100477 BVLI Index` |
| 20y | `BV200477 BVLI Index` |
| 30y | `BV300477 BVLI Index` |

## DFM series

| Col | Id | Ticker | Factor | Sign | Freq | Lag (d) | Transform | Group |
|---|---|---|---|---|---|---|---|---|
| 0 | `co_ip_yoy` * | `COOIPIYY Index` | Growth | +1 | monthly | 45 |  | Activity |
| 1 | `co_retail_sales_yoy` | `COSAYOY Index` | Growth | +1 | monthly | 45 |  | Consumer |
| 2 | `co_consumer_conf` | `COCCCC Index` | Growth | +1 | monthly | 20 |  | Consumer |
| 3 | `co_industrial_conf` | `COCCIC Index` | Growth | +1 | monthly | 20 |  | Business Surveys |
| 4 | `co_core_cpi_yoy` * | `COEFOFRY Index` | Inflation | +1 | monthly | 5 |  | Prices |
| 5 | `co_cpi_yoy` | `COCPIYOY Index` | Inflation | +1 | monthly | 5 |  | Prices |
| 6 | `co_ppi_yoy` | `CPPRNATY Index` | Inflation | +1 | monthly | 5 |  | Pipeline Prices |
| 7 | `co_unemployment_sa` * | `COUNTONT Index` | Employment | -1 | monthly | 30 |  | Labour Market |
| 8 | `co_employed_yoy` | `COOPTOEM Index` | Employment | +1 | monthly | 30 | yoy | Labour Market |

\* factor primary.

## Notes

- No Wages factor and a thin Growth block: the ISE activity indicator and monthly export tickers were not found on this Terminal.
- UVR (inflation-linked) TES exist but no BVAL real curve was found: no breakeven section.
