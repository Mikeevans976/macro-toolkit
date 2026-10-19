# series_catalogue_hu.json — Documentation

Catalogue for the **Hungary Macro Heatmap** (EM bloc).  
Engine: `backend/regional_heatmap.py` (config in `backend/heatmap_regions.py`)  
API: `GET /api/tools/heatmap/{slug}`

Generated from the probed ticker list; every Bloomberg ticker was checked on the Terminal on 2026-10-18 (`backend/scripts/probe_catalogue.py data/series_catalogue_hu.json`).

## Factors

| Factor | Series | Primary (sign anchor) |
|---|---|---|
| Global Macro | all 14 | `hu_ip_yoy` (Industrial Production YoY (SWDA)) |
| Growth | 6 | `hu_ip_yoy` (Industrial Production YoY (SWDA), sign +1) |
| Inflation | 4 | `hu_core_cpi_yoy` (Core CPI YoY, sign +1) |
| Employment | 2 | `hu_unemployment` (Unemployment Rate, sign -1) |
| Wages | 2 | `hu_gross_wages_yoy` (Average Gross Wages YoY, sign +1) |

## Curve: HGB (BVAL)

| Tenor | Ticker |
|---|---|
| 2y | `BV020114 BVLI Index` |
| 3y | `BV030114 BVLI Index` |
| 5y | `BV050114 BVLI Index` |
| 10y | `BV100114 BVLI Index` |
| 15y | `BV150114 BVLI Index` |

## DFM series

| Col | Id | Ticker | Factor | Sign | Freq | Lag (d) | Transform | Group |
|---|---|---|---|---|---|---|---|---|
| 0 | `hu_ip_yoy` * | `HUIPIYOY Index` | Growth | +1 | monthly | 38 |  | Activity |
| 1 | `hu_retail_sales_yoy` | `HURTAYOY Index` | Growth | +1 | monthly | 36 |  | Consumer |
| 2 | `hu_esi` | `EUESHU Index` | Growth | +1 | monthly | 0 |  | Business Surveys |
| 3 | `hu_industrial_conf` | `EUICHU Index` | Growth | +1 | monthly | 0 |  | Business Surveys |
| 4 | `hu_consumer_conf` | `EUCCHU Index` | Growth | +1 | monthly | 0 |  | Consumer |
| 5 | `hu_gki_sentiment` | `GKIESNDX Index` | Growth | +1 | monthly | 0 |  | Business Surveys |
| 6 | `hu_core_cpi_yoy` * | `HUCIYOY Index` | Inflation | +1 | monthly | 10 |  | Prices |
| 7 | `hu_cpi_yoy` | `HUCPIYY Index` | Inflation | +1 | monthly | 10 |  | Prices |
| 8 | `hu_core_hicp_yoy` | `CPEXHUY Index` | Inflation | +1 | monthly | 17 |  | Prices |
| 9 | `hu_ppi_yoy` | `HUPPIYY Index` | Inflation | +1 | monthly | 35 |  | Pipeline Prices |
| 10 | `hu_unemployment` * | `HUEMRATE Index` | Employment | -1 | monthly | 22 |  | Labour Market |
| 11 | `hu_mfg_employment_exp` | `EUI7HU Index` | Employment | +1 | monthly | 0 |  | Labour Market |
| 12 | `hu_gross_wages_yoy` * | `HUGWLYOY Index` | Wages | +1 | monthly | 50 |  | Wages |
| 13 | `hu_private_wages_yoy` | `HUGWPRVY Index` | Wages | +1 | monthly | 50 |  | Wages |

\* factor primary.

## Notes

- European Commission survey series (ESI, industrial and consumer confidence, manufacturing employment expectations) and Eurostat core HICP / unemployment fill gaps in the national data.
- The BVAL curve stops at 15y, so the long-end regime section is 2s15s.
- No liquid inflation-linked market: no breakeven section.
