# series_catalogue_cz.json — Documentation

Catalogue for the **Czech Republic Macro Heatmap** (EM bloc).  
Engine: `backend/regional_heatmap.py` (config in `backend/heatmap_regions.py`)  
API: `GET /api/tools/heatmap/{slug}`

Generated from the probed ticker list; every Bloomberg ticker was checked on the Terminal on 2026-10-18 (`backend/scripts/probe_catalogue.py data/series_catalogue_cz.json`).

## Factors

| Factor | Series | Primary (sign anchor) |
|---|---|---|
| Global Macro | all 14 | `cz_ip_yoy` (Industrial Production YoY) |
| Growth | 7 | `cz_ip_yoy` (Industrial Production YoY, sign +1) |
| Inflation | 3 | `cz_core_hicp_yoy` (Core HICP YoY (Eurostat), sign +1) |
| Employment | 2 | `cz_unemployment` (Unemployment Rate (Eurostat), sign -1) |
| Wages | 2 | `cz_nominal_wages_yoy` (Average Gross Nominal Wage YoY, sign +1) |

## Curve: CZGB (BVAL)

| Tenor | Ticker |
|---|---|
| 2y | `BV020480 BVLI Index` |
| 5y | `BV050480 BVLI Index` |
| 10y | `BV100480 BVLI Index` |
| 20y | `BV200480 BVLI Index` |
| 30y | `BV300480 BVLI Index` |

## DFM series

| Col | Id | Ticker | Factor | Sign | Freq | Lag (d) | Transform | Group |
|---|---|---|---|---|---|---|---|---|
| 0 | `cz_ip_yoy` * | `CZIPITYY Index` | Growth | +1 | monthly | 37 |  | Activity |
| 1 | `cz_retail_sales_yoy` | `CZRSXYOY Index` | Growth | +1 | monthly | 35 |  | Consumer |
| 2 | `cz_pmi_mfg` | `MPMICZMA Index` | Growth | +1 | monthly | 1 |  | Business Surveys |
| 3 | `cz_business_conf` | `CZCCBUS Index` | Growth | +1 | monthly | 0 |  | Business Surveys |
| 4 | `cz_consumer_conf` | `CZCCCON Index` | Growth | +1 | monthly | 0 |  | Consumer |
| 5 | `cz_esi` | `EUESCZ Index` | Growth | +1 | monthly | 0 |  | Business Surveys |
| 6 | `cz_industrial_conf` | `EUICCZ Index` | Growth | +1 | monthly | 0 |  | Business Surveys |
| 7 | `cz_core_hicp_yoy` * | `CPEXCZY Index` | Inflation | +1 | monthly | 17 |  | Prices |
| 8 | `cz_cpi_yoy` | `CZCPYOY Index` | Inflation | +1 | monthly | 10 |  | Prices |
| 9 | `cz_ppi_yoy` | `CZPPYOY Index` | Inflation | +1 | monthly | 20 |  | Pipeline Prices |
| 10 | `cz_unemployment` * | `UMRTCZ Index` | Employment | -1 | monthly | 30 |  | Labour Market |
| 11 | `cz_mfg_employment_exp` | `EUI7CZ Index` | Employment | +1 | monthly | 0 |  | Labour Market |
| 12 | `cz_nominal_wages_yoy` * | `CZNWYOY Index` | Wages | +1 | quarterly | 65 |  | Wages |
| 13 | `cz_real_wages_yoy` | `CZRWYOY Index` | Wages | +1 | quarterly | 65 |  | Wages |

\* factor primary.

## Notes

- European Commission survey series (ESI, industrial and consumer confidence, manufacturing employment expectations) and Eurostat core HICP / unemployment fill gaps in the national data.
- Wages are quarterly (CZSO average gross wage).
- The national unemployment series stopped in 2024; the Eurostat harmonised rate is used.
- No liquid inflation-linked market: no breakeven section.
