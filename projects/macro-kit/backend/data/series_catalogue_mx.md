# series_catalogue_mx.json — Documentation

Catalogue for the **Mexico Macro Heatmap** (EM bloc).  
Engine: `backend/regional_heatmap.py` (config in `backend/heatmap_regions.py`)  
API: `GET /api/tools/heatmap/{slug}`

Generated from the probed ticker list; every Bloomberg ticker was checked on the Terminal on 2026-10-18 (`backend/scripts/probe_catalogue.py data/series_catalogue_mx.json`).

## Factors

| Factor | Series | Primary (sign anchor) |
|---|---|---|
| Global Macro | all 30 | `mx_igae_yoy` (IGAE Economic Activity YoY) |
| Growth | 13 | `mx_igae_yoy` (IGAE Economic Activity YoY, sign +1) |
| Inflation | 7 | `mx_core_cpi_yoy` (Core CPI YoY, sign +1) |
| Employment | 6 | `mx_unemployment_sa` (Unemployment Rate (SA), sign -1) |
| Wages | 4 | `mx_contract_wage_nominal` (Contractual Wage Increase (Nominal), sign +1) |

## Curve: Mbono (BVAL)

| Tenor | Ticker |
|---|---|
| 2y | `BV020476 BVLI Index` |
| 3y | `BV030476 BVLI Index` |
| 5y | `BV050476 BVLI Index` |
| 10y | `BV100476 BVLI Index` |
| 20y | `BV200476 BVLI Index` |
| 30y | `BV300476 BVLI Index` |
| 10y real | `BV10MUDI BVLI Index` |

## DFM series

| Col | Id | Ticker | Factor | Sign | Freq | Lag (d) | Transform | Group |
|---|---|---|---|---|---|---|---|---|
| 0 | `mx_igae_yoy` * | `IGAEYOY Index` | Growth | +1 | monthly | 52 |  | Activity |
| 1 | `mx_ip_yoy` | `MXIPTYOY Index` | Growth | +1 | monthly | 41 |  | Activity |
| 2 | `mx_ip_manuf_yoy` | `MXIPFYOY Index` | Growth | +1 | monthly | 41 |  | Activity |
| 3 | `mx_investment_yoy` | `MINVTOSA Index` | Growth | +1 | monthly | 37 | yoy | Activity |
| 4 | `mx_imef_mfg` | `IMEFMAIN Index` | Growth | +1 | monthly | 1 |  | Business Surveys |
| 5 | `mx_imef_nonmfg` | `IMEFNMIN Index` | Growth | +1 | monthly | 1 |  | Business Surveys |
| 6 | `mx_pmi_mfg` | `MPMIMXMA Index` | Growth | +1 | monthly | 1 |  | Business Surveys |
| 7 | `mx_mfg_business_conf` | `MXBUMANU Index` | Growth | +1 | monthly | 2 |  | Business Surveys |
| 8 | `mx_consumer_conf` | `MXCDCOSA Index` | Growth | +1 | monthly | 5 |  | Consumer |
| 9 | `mx_retail_sales_yoy` | `MXWRTREY Index` | Growth | +1 | monthly | 50 |  | Consumer |
| 10 | `mx_antad_sss` | `MXSATOTL Index` | Growth | +1 | monthly | 10 |  | Consumer |
| 11 | `mx_remittances_yoy` | `MXRETOT$ Index` | Growth | +1 | monthly | 32 | yoy | Consumer |
| 12 | `mx_exports_yoy` | `MXTBBEXP Index` | Growth | +1 | monthly | 25 | yoy | External |
| 13 | `mx_core_cpi_yoy` * | `MXCCYOY Index` | Inflation | +1 | monthly | 9 |  | Prices |
| 14 | `mx_cpi_yoy` | `MXCPYOY Index` | Inflation | +1 | monthly | 9 |  | Prices |
| 15 | `mx_cpi_services_yoy` | `MXCCSVYY Index` | Inflation | +1 | monthly | 9 |  | Prices |
| 16 | `mx_cpi_goods_yoy` | `MXCCGDYY Index` | Inflation | +1 | monthly | 9 |  | Prices |
| 17 | `mx_infl_exp_12m` | `MXFLC2GD Index` | Inflation | +1 | monthly | 1 |  | Inflation Expectations |
| 18 | `mx_core_exp_12m` | `MXFLC2CD Index` | Inflation | +1 | monthly | 1 |  | Inflation Expectations |
| 19 | `mx_infl_exp_1_4y` | `MXFLC4D1 Index` | Inflation | +1 | monthly | 1 |  | Inflation Expectations |
| 20 | `mx_unemployment_sa` * | `MXUEUNSA Index` | Employment | -1 | monthly | 28 |  | Labour Market |
| 21 | `mx_underemployment` | `MXRIUEMP Index` | Employment | -1 | monthly | 28 |  | Labour Market |
| 22 | `mx_informality` | `MXRIIFRA Index` | Employment | -1 | monthly | 28 |  | Labour Market |
| 23 | `mx_participation` | `MXUETEAS Index` | Employment | +1 | monthly | 28 |  | Labour Market |
| 24 | `mx_formal_jobs_12m` | `MXWITMOL Index` | Employment | +1 | monthly | 10 | sum12 | Labour Market |
| 25 | `mx_imef_employment` | `IMEFEMNY Index` | Employment | +1 | monthly | 1 |  | Labour Market |
| 26 | `mx_contract_wage_nominal` * | `MXNSNOML Index` | Wages | +1 | monthly | 10 |  | Wages |
| 27 | `mx_contract_wage_real` | `MXRSREAL Index` | Wages | +1 | monthly | 10 |  | Wages |
| 28 | `mx_mfg_wages` | `MXMIMITO Index` | Wages | +1 | monthly | 40 |  | Wages |
| 29 | `mx_mfg_earnings_yoy` | `OEMXTEDD Index` | Wages | +1 | monthly | 70 |  | Wages |

\* factor primary.

## Notes

- IMSS formal-employment levels are dead on this Terminal; formal job creation enters as the trailing 12-month sum of monthly net jobs (`sum12` on MXWITMOL).
- Wages are contractual settlements (federal jurisdiction) plus manufacturing earnings; there is no economy-wide monthly wage series on Bloomberg.
- The S&P Global PMI starts in 2023 on Bloomberg; earlier months are NaN and the Kalman filter skips them.
