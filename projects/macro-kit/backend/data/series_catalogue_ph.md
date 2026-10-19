# series_catalogue_ph.json — Documentation

Catalogue for the **Philippines Macro Heatmap** (EM bloc).  
Engine: `backend/regional_heatmap.py` (config in `backend/heatmap_regions.py`)  
API: `GET /api/tools/heatmap/{slug}`

Generated from the probed ticker list; every Bloomberg ticker was checked on the Terminal on 2026-10-18 (`backend/scripts/probe_catalogue.py data/series_catalogue_ph.json`).

## Factors

| Factor | Series | Primary (sign anchor) |
|---|---|---|
| Global Macro | all 9 | `ph_manuf_volume_yoy` (Manufacturing Volume of Production YoY) |
| Growth | 5 | `ph_manuf_volume_yoy` (Manufacturing Volume of Production YoY, sign +1) |
| Inflation | 3 | `ph_core_cpi_yoy` (Core CPI YoY, sign +1) |
| Employment | 1 | `ph_unemployment` (LFS Unemployment Rate, sign -1) |

## Curve: RPGB (BVAL)

| Tenor | Ticker |
|---|---|
| 2y | `BV02RPGB BVLI Index` |
| 5y | `BV05RPGB BVLI Index` |
| 10y | `BV10RPGB BVLI Index` |
| 20y | `BV20RPGB BVLI Index` |
| 30y | `BV30RPGB BVLI Index` |

## DFM series

| Col | Id | Ticker | Factor | Sign | Freq | Lag (d) | Transform | Group |
|---|---|---|---|---|---|---|---|---|
| 0 | `ph_manuf_volume_yoy` * | `VOPIMFG Index` | Growth | +1 | monthly | 40 | yoy | Activity |
| 1 | `ph_pmi_mfg` | `MPMIPHMA Index` | Growth | +1 | monthly | 1 |  | Business Surveys |
| 2 | `ph_exports_yoy` | `PHEXYOY Index` | Growth | +1 | monthly | 40 |  | External |
| 3 | `ph_remittances_yoy` | `PHWRTTLY Index` | Growth | +1 | monthly | 45 |  | Consumer |
| 4 | `ph_bank_loans_yoy` | `PHOSTLNY Index` | Growth | +1 | monthly | 30 |  | Credit |
| 5 | `ph_core_cpi_yoy` * | `PHC2CI12 Index` | Inflation | +1 | monthly | 5 |  | Prices |
| 6 | `ph_cpi_yoy` | `PHC2II Index` | Inflation | +1 | monthly | 5 |  | Prices |
| 7 | `ph_ppi_yoy` | `PHPPII Index` | Inflation | +1 | monthly | 40 |  | Pipeline Prices |
| 8 | `ph_unemployment` * | `PHLFUERT Index` | Employment | -1 | monthly | 38 |  | Labour Market |

\* factor primary.

## Notes

- Employment is the monthly Labour Force Survey unemployment rate (a single series); no Wages factor.
- OFW cash remittances are a consumption driver and enter Growth.
- No inflation-linked market: no breakeven section.
