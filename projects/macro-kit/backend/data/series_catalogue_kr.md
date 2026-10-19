# series_catalogue_kr.json — Documentation

Catalogue for the **South Korea Macro Heatmap** (EM bloc).  
Engine: `backend/regional_heatmap.py` (config in `backend/heatmap_regions.py`)  
API: `GET /api/tools/heatmap/{slug}`

Generated from the probed ticker list; every Bloomberg ticker was checked on the Terminal on 2026-10-18 (`backend/scripts/probe_catalogue.py data/series_catalogue_kr.json`).

## Factors

| Factor | Series | Primary (sign anchor) |
|---|---|---|
| Global Macro | all 18 | `kr_exports_yoy` (Exports YoY) |
| Growth | 7 | `kr_ip_yoy` (Industrial Production YoY, sign +1) |
| Inflation | 5 | `kr_core_cpi_yoy` (Core CPI (ex Food & Energy) YoY, sign +1) |
| Employment | 3 | `kr_unemployment_sa` (Unemployment Rate (SA), sign -1) |
| External | 3 | `kr_exports_yoy` (Exports YoY, sign +1) |

## Curve: KTB (BVAL)

| Tenor | Ticker |
|---|---|
| 3y | `BV030232 BVLI Index` |
| 5y | `BV050232 BVLI Index` |
| 10y | `BV100232 BVLI Index` |
| 20y | `BV200232 BVLI Index` |
| 30y | `BV300232 BVLI Index` |
| 10y breakeven | `KWGGBE Index` |

## DFM series

| Col | Id | Ticker | Factor | Sign | Freq | Lag (d) | Transform | Group |
|---|---|---|---|---|---|---|---|---|
| 0 | `kr_ip_yoy` * | `KOIPIY Index` | Growth | +1 | monthly | 30 |  | Activity |
| 1 | `kr_retail_sales_yoy` | `KOCGCGY Index` | Growth | +1 | monthly | 30 |  | Consumer |
| 2 | `kr_services_output_yoy` | `KOSVTOTY Index` | Growth | +1 | monthly | 30 |  | Activity |
| 3 | `kr_pmi_mfg` | `MPMIKRMA Index` | Growth | +1 | monthly | 1 |  | Business Surveys |
| 4 | `kr_bsi_total` | `SKBSICSA Index` | Growth | +1 | monthly | 0 |  | Business Surveys |
| 5 | `kr_bsi_mfg` | `KOBSMC Index` | Growth | +1 | monthly | 0 |  | Business Surveys |
| 6 | `kr_consumer_sentiment` | `KOCCCSI Index` | Growth | +1 | monthly | 0 |  | Consumer |
| 7 | `kr_core_cpi_yoy` * | `SKCIFEY Index` | Inflation | +1 | monthly | 2 |  | Prices |
| 8 | `kr_core_cpi_ag_oil_yoy` | `SKCIYOY Index` | Inflation | +1 | monthly | 2 |  | Prices |
| 9 | `kr_cpi_yoy` | `KOCPIYOY Index` | Inflation | +1 | monthly | 2 |  | Prices |
| 10 | `kr_ppi_yoy` | `KOPPIYOY Index` | Inflation | +1 | monthly | 22 |  | Pipeline Prices |
| 11 | `kr_expected_inflation` | `KOCCIN Index` | Inflation | +1 | monthly | 0 |  | Inflation Expectations |
| 12 | `kr_unemployment_sa` * | `KOEAUERS Index` | Employment | -1 | monthly | 14 |  | Labour Market |
| 13 | `kr_employment_yoy` | `KOEAEMPY Index` | Employment | +1 | monthly | 14 |  | Labour Market |
| 14 | `kr_mfg_employment_yoy` | `KOUEMFGY Index` | Employment | +1 | monthly | 14 |  | Labour Market |
| 15 | `kr_exports_yoy` * | `KOEXTOTY Index` | External | +1 | monthly | 1 |  | Trade |
| 16 | `kr_exports_20d_yoy` | `KOTBEXPY Index` | External | +1 | monthly | 0 |  | Trade |
| 17 | `kr_semis_exports_yoy` | `KOTVESEY Index` | External | +1 | monthly | 1 |  | Trade |

\* factor primary.

## Notes

- No Wages factor: the monthly earnings series on Bloomberg (KOME*, KOQE*) return no data on this Terminal. An External factor (total, 20-day preliminary and semiconductor exports) takes its place; exports also anchor Global Macro.
- Short curve leg is 3y, the KTB benchmark; regimes are 3s10s and 3s30s.
- Breakeven: Bloomberg's South Korea breakeven index (KWGGBE, from the KTBi linker), used directly.
