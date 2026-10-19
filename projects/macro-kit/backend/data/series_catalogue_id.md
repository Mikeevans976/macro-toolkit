# series_catalogue_id.json — Documentation

Catalogue for the **Indonesia Macro Heatmap** (EM bloc).  
Engine: `backend/regional_heatmap.py` (config in `backend/heatmap_regions.py`)  
API: `GET /api/tools/heatmap/{slug}`

Generated from the probed ticker list; every Bloomberg ticker was checked on the Terminal on 2026-10-18 (`backend/scripts/probe_catalogue.py data/series_catalogue_id.json`).

## Factors

| Factor | Series | Primary (sign anchor) |
|---|---|---|
| Global Macro | all 13 | `id_retail_sales_yoy` (BI Retail Sales Survey YoY) |
| Growth | 5 | `id_retail_sales_yoy` (BI Retail Sales Survey YoY, sign +1) |
| Inflation | 3 | `id_core_cpi_yoy` (Core CPI YoY, sign +1) |
| External | 5 | `id_exports_yoy` (Exports YoY, sign +1) |

## Curve: INDOGB (BVAL)

| Tenor | Ticker |
|---|---|
| 2y | `BV020132 BVLI Index` |
| 5y | `BV050132 BVLI Index` |
| 10y | `BV100132 BVLI Index` |
| 20y | `BV200132 BVLI Index` |
| 30y | `BV300132 BVLI Index` |

## DFM series

| Col | Id | Ticker | Factor | Sign | Freq | Lag (d) | Transform | Group |
|---|---|---|---|---|---|---|---|---|
| 0 | `id_retail_sales_yoy` * | `IDRSTOTY Index` | Growth | +1 | monthly | 10 |  | Consumer |
| 1 | `id_pmi_mfg` | `MPMIIDMA Index` | Growth | +1 | monthly | 1 |  | Business Surveys |
| 2 | `id_consumer_conf` | `IDCCI Index` | Growth | +1 | monthly | 8 |  | Consumer |
| 3 | `id_loans_yoy` | `IDBCALY Index` | Growth | +1 | monthly | 30 |  | Credit & Money |
| 4 | `id_m2_yoy` | `IDM2YOY Index` | Growth | +1 | monthly | 30 |  | Credit & Money |
| 5 | `id_core_cpi_yoy` * | `IDIFCRIY Index` | Inflation | +1 | monthly | 1 |  | Prices |
| 6 | `id_cpi_yoy` | `IDCPIY Index` | Inflation | +1 | monthly | 1 |  | Prices |
| 7 | `id_wpi_yoy` | `IDWPIY Index` | Inflation | +1 | monthly | 1 |  | Pipeline Prices |
| 8 | `id_exports_yoy` * | `IDEXPY Index` | External | +1 | monthly | 15 |  | Trade |
| 9 | `id_imports_yoy` | `IDIMPTLY Index` | External | +1 | monthly | 15 |  | Trade |
| 10 | `id_trade_balance` | `IDBALTOL Index` | External | +1 | monthly | 15 |  | Trade |
| 11 | `id_fx_reserves_yoy` | `IDGFA Index` | External | +1 | monthly | 7 | yoy | Reserves & FX |
| 12 | `id_reer` | `BISBIDR Index` | External | +1 | monthly | 15 |  | Reserves & FX |

\* factor primary.

## Notes

- No Employment or Wages factor: labour data are semi-annual. An External factor (trade, reserves, REER) takes their place.
- Car, motorcycle and cement sales tickers return no data on this Terminal; Growth leans on retail sales, the PMI, consumer confidence, loans and M2.
- No inflation-linked market: no breakeven section.
