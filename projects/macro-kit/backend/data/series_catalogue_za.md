# series_catalogue_za.json — Documentation

Catalogue for the **South Africa Macro Heatmap** (EM bloc).  
Engine: `backend/regional_heatmap.py` (config in `backend/heatmap_regions.py`)  
API: `GET /api/tools/heatmap/{slug}`

Generated from the probed ticker list; every Bloomberg ticker was checked on the Terminal on 2026-10-18 (`backend/scripts/probe_catalogue.py data/series_catalogue_za.json`).

## Factors

| Factor | Series | Primary (sign anchor) |
|---|---|---|
| Global Macro | all 17 | `za_absa_pmi` (Absa Manufacturing PMI (SA)) |
| Growth | 10 | `za_absa_pmi` (Absa Manufacturing PMI (SA), sign +1) |
| Inflation | 4 | `za_core_cpi_yoy` (Core CPI YoY, sign +1) |
| Employment | 2 | `za_unemployment` (QLFS Unemployment Rate, sign -1) |
| Wages | 1 | `za_earnings_yoy` (QES Average Monthly Earnings YoY, sign +1) |

## Curve: SAGB (BVAL)

| Tenor | Ticker |
|---|---|
| 2y | `BV020262 BVLI Index` |
| 5y | `BV050262 BVLI Index` |
| 10y | `BV100262 BVLI Index` |
| 20y | `BV200262 BVLI Index` |
| 30y | `BV300262 BVLI Index` |
| 10y real | `BV10SACP BVLI Index` |

## DFM series

| Col | Id | Ticker | Factor | Sign | Freq | Lag (d) | Transform | Group |
|---|---|---|---|---|---|---|---|---|
| 0 | `za_absa_pmi` * | `SAPMI Index` | Growth | +1 | monthly | 1 |  | Business Surveys |
| 1 | `za_spglobal_pmi` | `MPMIZAWA Index` | Growth | +1 | monthly | 3 |  | Business Surveys |
| 2 | `za_ber_business_conf` | `SABZCONF Index` | Growth | +1 | quarterly | 5 |  | Business Surveys |
| 3 | `za_consumer_conf` | `SACWC Index` | Growth | +1 | quarterly | 10 |  | Consumer |
| 4 | `za_manuf_production_yoy` | `SFPMYOY Index` | Growth | +1 | monthly | 42 |  | Activity |
| 5 | `za_mining_production_yoy` | `SAMPTGDY Index` | Growth | +1 | monthly | 42 |  | Activity |
| 6 | `za_electricity_production_yoy` | `SAPW09Y Index` | Growth | +1 | monthly | 40 |  | Activity |
| 7 | `za_retail_sales_yoy` | `SARSCONY Index` | Growth | +1 | monthly | 48 |  | Consumer |
| 8 | `za_car_sales_yoy` | `NAAMCARY Index` | Growth | +1 | monthly | 1 |  | Consumer |
| 9 | `za_private_credit_yoy` | `SACEIYY Index` | Growth | +1 | monthly | 30 |  | Credit |
| 10 | `za_core_cpi_yoy` * | `SCP8EPNY Index` | Inflation | +1 | monthly | 20 |  | Prices |
| 11 | `za_cpi_yoy` | `SACPIYOY Index` | Inflation | +1 | monthly | 20 |  | Prices |
| 12 | `za_ppi_yoy` | `SAPRFMGY Index` | Inflation | +1 | monthly | 25 |  | Pipeline Prices |
| 13 | `za_absa_pmi_prices` | `SAPMIPP Index` | Inflation | +1 | monthly | 1 |  | Pipeline Prices |
| 14 | `za_unemployment` * | `SAUERATQ Index` | Employment | -1 | quarterly | 45 |  | Labour Market |
| 15 | `za_absa_pmi_employment` | `SAPME Index` | Employment | +1 | monthly | 1 |  | Labour Market |
| 16 | `za_earnings_yoy` * | `EESAAEYO Index` | Wages | +1 | quarterly | 85 |  | Wages |

\* factor primary.

## Notes

- Unemployment (QLFS) and average earnings (QES) are quarterly; they enter through the loader's quarterly path, so the Employment and Wages factors move once a quarter. The Absa PMI employment index adds a monthly read to Employment.
- BER business confidence and consumer confidence are quarterly.
- Breakeven: 10y SAGB minus the 10y inflation-linked BVAL real yield.
