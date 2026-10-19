# series_catalogue_in.json — Documentation

Catalogue for the **India Macro Heatmap** (EM bloc).  
Engine: `backend/regional_heatmap.py` (config in `backend/heatmap_regions.py`)  
API: `GET /api/tools/heatmap/{slug}`

Generated from the probed ticker list; every Bloomberg ticker was checked on the Terminal on 2026-10-18 (`backend/scripts/probe_catalogue.py data/series_catalogue_in.json`).

## Factors

| Factor | Series | Primary (sign anchor) |
|---|---|---|
| Global Macro | all 15 | `in_ip_yoy` (Industrial Production YoY) |
| Growth | 6 | `in_ip_yoy` (Industrial Production YoY, sign +1) |
| Inflation | 3 | `in_core_cpi_yoy` (Core CPI (ex Food & Fuel) YoY, sign +1) |
| External | 6 | `in_exports_yoy` (Merchandise Exports YoY, sign +1) |

## Curve: G-sec (BVAL)

| Tenor | Ticker |
|---|---|
| 2y | `BV020123 BVLI Index` |
| 5y | `BV050123 BVLI Index` |
| 10y | `BV100123 BVLI Index` |
| 15y | `BV150123 BVLI Index` |
| 30y | `BV300123 BVLI Index` |

## DFM series

| Col | Id | Ticker | Factor | Sign | Freq | Lag (d) | Transform | Group |
|---|---|---|---|---|---|---|---|---|
| 0 | `in_ip_yoy` * | `INBGIIPY Index` | Growth | +1 | monthly | 28 |  | Activity |
| 1 | `in_pmi_mfg` | `MPMIINMA Index` | Growth | +1 | monthly | 1 |  | Business Surveys |
| 2 | `in_pmi_services` | `MPMIINSA Index` | Growth | +1 | monthly | 3 |  | Business Surveys |
| 3 | `in_pmi_composite` | `MPMIINCA Index` | Growth | +1 | monthly | 3 |  | Business Surveys |
| 4 | `in_gst_collections_yoy` | `GSTXTXCO Index` | Growth | +1 | monthly | 1 | yoy | Activity |
| 5 | `in_diesel_consumption_yoy` | `PETCHSD Index` | Growth | +1 | monthly | 10 | yoy | Activity |
| 6 | `in_core_cpi_yoy` * | `INBGCEY Index` | Inflation | +1 | monthly | 12 |  | Prices |
| 7 | `in_cpi_yoy` | `INFUTOTY Index` | Inflation | +1 | monthly | 12 |  | Prices |
| 8 | `in_wpi_yoy` | `INBGWPIY Index` | Inflation | +1 | monthly | 14 |  | Pipeline Prices |
| 9 | `in_exports_yoy` * | `INMTEXUY Index` | External | +1 | monthly | 15 |  | Trade |
| 10 | `in_imports_yoy` | `INMTIMUY Index` | External | +1 | monthly | 15 |  | Trade |
| 11 | `in_trade_balance` | `INMTBAL$ Index` | External | +1 | monthly | 15 |  | Trade |
| 12 | `in_services_exports_yoy` | `INITSEXP Index` | External | +1 | monthly | 15 | yoy | Trade |
| 13 | `in_fx_reserves_yoy` | `INMORES$ Index` | External | +1 | monthly | 7 | yoy | Reserves & FX |
| 14 | `in_reer` | `BISBINR Index` | External | +1 | monthly | 15 |  | Reserves & FX |

\* factor primary.

## Notes

- No Employment or Wages factor: the monthly PLFS unemployment rate only starts in 2025 (18 observations) and the rural wage series stopped in 2025.
- An External factor (merchandise and services trade, FX reserves, REER) takes their place.
- CPI was rebased in 2026; the headline y/y series is spliced on Bloomberg but sub-indices restart, so only headline and core are used.
- HSBC PMIs start in 2023 on Bloomberg; industrial production anchors Growth and Global Macro because it has the full history.
- No liquid inflation-linked market: no breakeven section.
