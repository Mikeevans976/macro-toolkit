# series_catalogue_cn.json — Documentation

Catalogue for the **China Macro Heatmap** (EM bloc).  
Engine: `backend/regional_heatmap.py` (config in `backend/heatmap_regions.py`)  
API: `GET /api/tools/heatmap/{slug}`

Generated from the probed ticker list; every Bloomberg ticker was checked on the Terminal on 2026-10-18 (`backend/scripts/probe_catalogue.py data/series_catalogue_cn.json`).

## Factors

| Factor | Series | Primary (sign anchor) |
|---|---|---|
| Global Macro | all 28 | `cn_nbs_pmi_mfg` (NBS Manufacturing PMI) |
| Growth | 14 | `cn_nbs_pmi_mfg` (NBS Manufacturing PMI, sign +1) |
| Inflation | 4 | `cn_core_cpi_yoy` (Core CPI YoY, sign +1) |
| Employment | 4 | `cn_unemployment` (Surveyed Urban Unemployment Rate, sign -1) |
| Credit | 6 | `cn_tsf_stock_yoy` (Aggregate Financing Stock Growth, sign +1) |

## Curve: CGB (BVAL)

| Tenor | Ticker |
|---|---|
| 1y | `BV010020 BVLI Index` |
| 2y | `BV020020 BVLI Index` |
| 5y | `BV050020 BVLI Index` |
| 7y | `BV070020 BVLI Index` |
| 10y | `BV100020 BVLI Index` |
| 30y | `BV300020 BVLI Index` |

## DFM series

| Col | Id | Ticker | Factor | Sign | Freq | Lag (d) | Transform | Group |
|---|---|---|---|---|---|---|---|---|
| 0 | `cn_nbs_pmi_mfg` * | `CPMINDX Index` | Growth | +1 | monthly | 0 |  | Business Surveys |
| 1 | `cn_nbs_pmi_nonmfg` | `CPMINMAN Index` | Growth | +1 | monthly | 0 |  | Business Surveys |
| 2 | `cn_ratingdog_pmi_mfg` | `MPMICNMA Index` | Growth | +1 | monthly | 1 |  | Business Surveys |
| 3 | `cn_ratingdog_pmi_services` | `MPMICNSA Index` | Growth | +1 | monthly | 3 |  | Business Surveys |
| 4 | `cn_ip_yoy` | `CHVAIOY Index` | Growth | +1 | monthly | 15 |  | Activity |
| 5 | `cn_retail_sales_yoy` | `CNRSCYOY Index` | Growth | +1 | monthly | 15 |  | Activity |
| 6 | `cn_fai_ytd_yoy` | `CNFAYOY Index` | Growth | +1 | monthly | 15 |  | Activity |
| 7 | `cn_private_fai_ytd_yoy` | `CNFAPITY Index` | Growth | +1 | monthly | 15 |  | Activity |
| 8 | `cn_industrial_profits_ytd_yoy` | `CNPRTTLY Index` | Growth | +1 | monthly | 27 |  | Activity |
| 9 | `cn_car_sales_yoy` | `CNVSPSGY Index` | Growth | +1 | monthly | 12 |  | Activity |
| 10 | `cn_property_inv_ytd_yoy` | `CNFAESTY Index` | Growth | +1 | monthly | 15 |  | Property |
| 11 | `cn_new_home_prices_yoy` | `CHHEAVG Index` | Growth | +1 | monthly | 15 |  | Property |
| 12 | `cn_exports_yoy` | `CNFREXPY Index` | Growth | +1 | monthly | 9 |  | External |
| 13 | `cn_imports_yoy` | `CNFRIMPY Index` | Growth | +1 | monthly | 9 |  | External |
| 14 | `cn_core_cpi_yoy` * | `CNCPCRY Index` | Inflation | +1 | monthly | 10 |  | Prices |
| 15 | `cn_cpi_yoy` | `CNCPIYOY Index` | Inflation | +1 | monthly | 10 |  | Prices |
| 16 | `cn_cpi_nonfood_yoy` | `CNCPNFY Index` | Inflation | +1 | monthly | 10 |  | Prices |
| 17 | `cn_ppi_yoy` | `CHEFTYOY Index` | Inflation | +1 | monthly | 10 |  | Pipeline Prices |
| 18 | `cn_unemployment` * | `CNUESRU Index` | Employment | -1 | monthly | 15 |  | Labour Market |
| 19 | `cn_unemployment_31cities` | `CNUESR31 Index` | Employment | -1 | monthly | 15 |  | Labour Market |
| 20 | `cn_pmi_employment_mfg` | `CPMIEMPL Index` | Employment | +1 | monthly | 0 |  | Labour Market |
| 21 | `cn_pmi_employment_nonmfg` | `CPMINEMP Index` | Employment | +1 | monthly | 0 |  | Labour Market |
| 22 | `cn_tsf_stock_yoy` * | `CNFGASFG Index` | Credit | +1 | monthly | 12 |  | Credit & Money |
| 23 | `cn_loan_stock_yoy` | `CNFGRLG Index` | Credit | +1 | monthly | 12 |  | Credit & Money |
| 24 | `cn_m1_yoy` | `CNMS1YOY Index` | Credit | +1 | monthly | 12 |  | Credit & Money |
| 25 | `cn_m2_yoy` | `CNMS2YOY Index` | Credit | +1 | monthly | 12 |  | Credit & Money |
| 26 | `cn_new_loans_12m` | `CNLNNEW Index` | Credit | +1 | monthly | 12 | sum12 | Credit & Money |
| 27 | `cn_new_financing_12m` | `CNLNASF Index` | Credit | +1 | monthly | 12 | sum12 | Credit & Money |

\* factor primary.

## Notes

- No Wages factor: China publishes disposable income only quarterly and year-to-date. A Credit factor (TSF and loan stock growth, M1/M2, 12-month new loans and new financing) replaces it.
- Industrial production, retail sales and FAI are published for January and February combined; January stays NaN and the Kalman filter carries the state.
- FAI, property investment and profits are year-to-date y/y as published (no transform).
- No inflation-linked market, so the page has no breakeven section and scenarios use the curve signal only.
