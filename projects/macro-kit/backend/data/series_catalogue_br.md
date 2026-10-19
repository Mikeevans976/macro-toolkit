# series_catalogue_br.json — Documentation

Catalogue for the **Brazil Macro Heatmap** (EM bloc).  
Engine: `backend/regional_heatmap.py` (config in `backend/heatmap_regions.py`)  
API: `GET /api/tools/heatmap/{slug}`

Generated from the probed ticker list; every Bloomberg ticker was checked on the Terminal on 2026-10-18 (`backend/scripts/probe_catalogue.py data/series_catalogue_br.json`).

## Factors

| Factor | Series | Primary (sign anchor) |
|---|---|---|
| Global Macro | all 23 | `br_ibc_br_yoy` (IBC-Br Economic Activity YoY) |
| Growth | 11 | `br_ibc_br_yoy` (IBC-Br Economic Activity YoY, sign +1) |
| Inflation | 7 | `br_core_ipca_smoothed_12m` (Core IPCA (Smoothed), 12m, sign +1) |
| Employment | 3 | `br_unemployment` (PNAD Unemployment Rate, sign -1) |
| Wages | 2 | `br_real_income_yoy` (PNAD Real Usual Income YoY, sign +1) |

## Curve: NTN-F (BVAL)

| Tenor | Ticker |
|---|---|
| 1y | `EIC1AMSS BVLI Index` |
| 2y | `EIC2AMSS BVLI Index` |
| 3y | `EIC3AMSS BVLI Index` |
| 5y | `EIC5AMSS BVLI Index` |
| 7y | `EIC7AMSS BVLI Index` |
| 10y | `EICTAMSS BVLI Index` |
| 10y real | `BV10BNTN BVLI Index` |

## DFM series

| Col | Id | Ticker | Factor | Sign | Freq | Lag (d) | Transform | Group |
|---|---|---|---|---|---|---|---|---|
| 0 | `br_ibc_br_yoy` * | `BZEAYOY% Index` | Growth | +1 | monthly | 45 |  | Activity |
| 1 | `br_ip_yoy` | `BZIPYOY% Index` | Growth | +1 | monthly | 35 |  | Activity |
| 2 | `br_retail_sales_yoy` | `BZRTRYOY Index` | Growth | +1 | monthly | 42 |  | Consumer |
| 3 | `br_retail_amplified_yoy` | `BZRTAMPY Index` | Growth | +1 | monthly | 42 |  | Consumer |
| 4 | `br_services_volume_yoy` | `BRSRTTYV Index` | Growth | +1 | monthly | 44 |  | Activity |
| 5 | `br_pmi_mfg` | `MPMIBRMA Index` | Growth | +1 | monthly | 1 |  | Business Surveys |
| 6 | `br_pmi_services` | `MPMIBRSA Index` | Growth | +1 | monthly | 3 |  | Business Surveys |
| 7 | `br_industrial_conf` | `FGVIINSA Index` | Growth | +1 | monthly | 0 |  | Business Surveys |
| 8 | `br_consumer_conf` | `BZFGCCSA Index` | Growth | +1 | monthly | 0 |  | Consumer |
| 9 | `br_vehicle_production_yoy` | `BZVPTLVH Index` | Growth | +1 | monthly | 7 | yoy | Activity |
| 10 | `br_household_credit_yoy` | `BRCCUHTY Index` | Growth | +1 | monthly | 28 |  | Credit |
| 11 | `br_core_ipca_smoothed_12m` * | `BBNCSMOT Index` | Inflation | +1 | monthly | 10 | sum12 | Prices |
| 12 | `br_core_ipca_nonsmoothed_12m` | `BBNCNSMO Index` | Inflation | +1 | monthly | 10 | sum12 | Prices |
| 13 | `br_ipca_yoy` | `BZPIIPCY Index` | Inflation | +1 | monthly | 10 |  | Prices |
| 14 | `br_ipca15_yoy` | `BZPIIPYO Index` | Inflation | +1 | monthly | 0 |  | Prices |
| 15 | `br_ipca_services_12m` | `IPTNSRVT Index` | Inflation | +1 | monthly | 10 |  | Prices |
| 16 | `br_igpm_yoy` | `IBREGPMY Index` | Inflation | +1 | monthly | 0 |  | Pipeline Prices |
| 17 | `br_focus_ipca_12m` | `FCBRP1 Index` | Inflation | +1 | monthly | 0 |  | Inflation Expectations |
| 18 | `br_unemployment` * | `BRLFUNRT Index` | Employment | -1 | monthly | 30 |  | Labour Market |
| 19 | `br_unemployed_level` | `BRLFUPRT Index` | Employment | -1 | monthly | 30 |  | Labour Market |
| 20 | `br_caged_jobs_12m` | `BZJCTOTS Index` | Employment | +1 | monthly | 30 | sum12 | Labour Market |
| 21 | `br_real_income_yoy` * | `BRLFTNIN Index` | Wages | +1 | monthly | 30 | yoy | Wages |
| 22 | `br_real_wage_bill_yoy` | `BRLFESRI Index` | Wages | +1 | monthly | 30 | yoy | Wages |

\* factor primary.

## Notes

- Curve: Bloomberg's NTN-F BVAL curve (1y-10y). Constant-maturity DI swap tickers were not found on this Terminal; the NTN-F curve tracks the DI curve closely.
- Breakeven: 10y NTN-F minus the 10y NTN-B BVAL real yield.
- Core IPCA (smoothed and non-smoothed) is published as a monthly % change; it enters as a trailing 12-month sum (`sum12`).
- CAGED net formal jobs (SA) enter as a trailing 12-month sum.
