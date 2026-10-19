# series_catalogue_th.json — Documentation

Catalogue for the **Thailand Macro Heatmap** (EM bloc).  
Engine: `backend/regional_heatmap.py` (config in `backend/heatmap_regions.py`)  
API: `GET /api/tools/heatmap/{slug}`

Generated from the probed ticker list; every Bloomberg ticker was checked on the Terminal on 2026-10-18 (`backend/scripts/probe_catalogue.py data/series_catalogue_th.json`).

## Factors

| Factor | Series | Primary (sign anchor) |
|---|---|---|
| Global Macro | all 9 | `th_private_consumption_yoy` (BOT Private Consumption Index YoY) |
| Growth | 4 | `th_private_consumption_yoy` (BOT Private Consumption Index YoY, sign +1) |
| Inflation | 3 | `th_core_cpi_yoy` (Core CPI YoY, sign +1) |
| Employment | 2 | `th_unemployment` (Unemployment Rate, sign -1) |

## Curve: ThaiGB (BVAL)

| Tenor | Ticker |
|---|---|
| 2y | `BV020122 BVLI Index` |
| 5y | `BV050122 BVLI Index` |
| 10y | `BV100122 BVLI Index` |
| 20y | `BV200122 BVLI Index` |
| 30y | `BV300122 BVLI Index` |

## DFM series

| Col | Id | Ticker | Factor | Sign | Freq | Lag (d) | Transform | Group |
|---|---|---|---|---|---|---|---|---|
| 0 | `th_private_consumption_yoy` * | `THCIY Index` | Growth | +1 | monthly | 30 |  | Consumer |
| 1 | `th_business_sentiment` | `THBSI Index` | Growth | +1 | monthly | 0 |  | Business Surveys |
| 2 | `th_consumer_conf` | `THCCI Index` | Growth | +1 | monthly | 10 |  | Consumer |
| 3 | `th_exports_yoy` | `THCTEXPY Index` | Growth | +1 | monthly | 25 |  | External |
| 4 | `th_core_cpi_yoy` * | `THCOPIY Index` | Inflation | +1 | monthly | 3 |  | Prices |
| 5 | `th_cpi_yoy` | `THCPIYOY Index` | Inflation | +1 | monthly | 3 |  | Prices |
| 6 | `th_ppi_yoy` | `THPPIACY Index` | Inflation | +1 | monthly | 10 |  | Pipeline Prices |
| 7 | `th_unemployment` * | `THLMUERT Index` | Employment | -1 | quarterly | 45 |  | Labour Market |
| 8 | `th_bsi_employment` | `THBSEMP Index` | Employment | +1 | monthly | 0 |  | Labour Market |

\* factor primary.

## Notes

- Manufacturing production index tickers are dead on this Terminal; Growth leans on the BOT private-consumption index, surveys and exports.
- Unemployment is quarterly; the BOT business-sentiment employment index adds a monthly read.
- No Wages factor. Inflation-linked bonds are small and have no BVAL curve: no breakeven section.
