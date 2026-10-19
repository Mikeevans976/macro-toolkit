# series_catalogue_il.json — Documentation

Catalogue for the **Israel Macro Heatmap** (EM bloc).  
Engine: `backend/regional_heatmap.py` (config in `backend/heatmap_regions.py`)  
API: `GET /api/tools/heatmap/{slug}`

Generated from the probed ticker list; every Bloomberg ticker was checked on the Terminal on 2026-10-18 (`backend/scripts/probe_catalogue.py data/series_catalogue_il.json`).

## Factors

| Factor | Series | Primary (sign anchor) |
|---|---|---|
| Global Macro | all 11 | `il_ip_yoy` (Industrial Production YoY (OECD, SA)) |
| Growth | 5 | `il_ip_yoy` (Industrial Production YoY (OECD, SA), sign +1) |
| Inflation | 4 | `il_cpi_ex_housing_yoy` (CPI ex Housing YoY, sign +1) |
| Employment | 2 | `il_unemployment` (Unemployment Rate, sign -1) |

## Curve: ILGOV (BVAL)

| Tenor | Ticker |
|---|---|
| 2y | `BV02ILGO BVLI Index` |
| 5y | `BV05ILGO BVLI Index` |
| 10y | `BV10ILGO BVLI Index` |
| 20y | `BV20ILGO BVLI Index` |
| 30y | `BV30ILGO BVLI Index` |
| 10y real | `BV10ILCP BVLI Index` |

## DFM series

| Col | Id | Ticker | Factor | Sign | Freq | Lag (d) | Transform | Group |
|---|---|---|---|---|---|---|---|---|
| 0 | `il_ip_yoy` * | `OEILUIAB Index` | Growth | +1 | monthly | 45 |  | Activity |
| 1 | `il_retail_sales_yoy` | `ISCSRET Index` | Growth | +1 | monthly | 45 | yoy | Consumer |
| 2 | `il_consumer_conf` | `ILCNCONF Index` | Growth | +1 | monthly | 5 |  | Consumer |
| 3 | `il_capacity_utilisation` | `OEILDGBO Index` | Growth | +1 | monthly | 30 |  | Business Surveys |
| 4 | `il_exports_yoy` | `ISCAEXSA Index` | Growth | +1 | quarterly | 45 | yoy | External |
| 5 | `il_cpi_ex_housing_yoy` * | `ISCPXHYY Index` | Inflation | +1 | monthly | 15 |  | Prices |
| 6 | `il_cpi_yoy` | `ISCPIYYN Index` | Inflation | +1 | monthly | 15 |  | Prices |
| 7 | `il_infl_exp_1y` | `ISFLI1Y Index` | Inflation | +1 | monthly | 0 |  | Inflation Expectations |
| 8 | `il_infl_exp_3y` | `ISFLI3Y Index` | Inflation | +1 | monthly | 0 |  | Inflation Expectations |
| 9 | `il_unemployment` * | `ISUMUNER Index` | Employment | -1 | monthly | 25 |  | Labour Market |
| 10 | `il_employment_rate` | `ISUMEMPR Index` | Employment | +1 | monthly | 25 |  | Labour Market |

\* factor primary.

## Notes

- No Wages factor: the CBS average-wage tickers return no data on this Terminal.
- Industrial production is the OECD-published series (national tickers are dead). Exports are quarterly national-accounts data.
- Breakeven: 10y nominal minus the 10y CPI-linked BVAL real yield. Market-implied inflation (years 1 and 3) also enters the Inflation factor.
