# Free data sources (used when Bloomberg is blocked)

Download each into its own scratchpad folder; read with `python -I`.

| Need | Source | How |
|---|---|---|
| Gilt nominal, OIS, inflation (RPI) curves | BoE yield curves | Zips `glcnominalddata.zip`, `oisddata.zip`, `glcinflationddata.zip`, `latest-yield-curve-data.zip` from bankofengland.co.uk/statistics/yield-curves. Sheet "4. spot curve" (0.5y steps); "1. fwds, short end" (monthly forwards, for the OIS peak). Needs openpyxl. |
| Bank Rate, SONIA, gilt par yields | BoE IADB | CSV endpoint, series IUDBEDR, IUDSOIA, IUDSNPY/IUDMNPY/IUDLNPY |
| US yields, breakevens, FX, Brent, equities, vol, credit | FRED | `https://fred.stlouisfed.org/graph/fredgraph.csv?id=A,B,C&cosd=YYYY-MM-DD`. Multiple ids may return a zip. Series: DGS2, DGS10, DGS30, T5YIE, T10YIE, T5YIFR, SOFR, DFEDTARU, DEXUSEU, DEXJPUS, DEXCAUS, DEXNOUS, DCOILBRENTEU, SP500, NASDAQCOM, VIXCLS, BAMLC0A0CM (IG OAS), BAMLH0A0HYM2 (HY OAS). FX lags ~1 week. |
| Euro area AAA curve, €STR, country 10y | ECB data API | YC dataset `YC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_1Y` (also 2Y/5Y/10Y), `EST` for €STR, IRS monthly long-term rates by country. CSV columns `TIME_PERIOD`, `OBS_VALUE`. A government curve, not €STR swaps. |
| German Bund curve (daily) | Bundesbank | `https://api.statistiken.bundesbank.de/rest/download/BBSIS/D.I.ZST.ZI.EUR.S1311.B.A604.R10XX.R.A.A._Z._Z.A?format=csv&lang=en` (swap R10XX for R02XX, R05XX, R30XX). Skip 5 header rows; "." means missing. |
| Canada yields, policy rate, FX | Bank of Canada Valet | Series BD.CDN.2YR.DQ.YLD / 5YR / 10YR, V39079 (policy rate) |
| Futures curves (e.g. Brent Dec-27), option vols, CDX, swap spreads | Not free | Web search for the latest settlement and label it "press settlement, date". Price options with Black-Scholes at a stated vol and give an entry cap. |

Blocked or bot-walled: stooq.com (JavaScript challenge, so don't try to get around it). There are no free euro-area equity indices; use press levels.

Useful derived numbers to compute: 1y range and z-score, 3m realised vol (bp/day for rates, annualised % for FX and equities), quarter-end snapshots (Q2-end, Q3-end, latest), changes over the quarter, and correlations of daily changes for cross-theme links.
