# Macro heatmaps for the main EM economies: plan

**Goal:** extend the regional macro heatmaps (today: EA, UK, US, JP, CA, SE, NO, CH, AU, NZ) to the main emerging-market economies, on the same engine, API and page.
**Status (2026-10-18):** Phase A, Wave 1 and Wave 2 built: 20 EM regions, all running fully live on Bloomberg (macro, yields and, where a linker market exists, breakevens), with no missing series. Phase C not started. See §0.
**Effort:** S (< 1 day) · M (2–5 days) · L (1–2 weeks)

---

## 0. Build status and decisions taken

**Decisions (§8), made at build time:**
1. Country list: Wave 1 as proposed.
2. Curves: government bonds everywhere, via Bloomberg **BVAL constant-maturity curves** (`BV{tenor}{curve} BVLI Index`). EM generic tickers (`G…YR Index`) have gaps of months to years (SA 2y, Brazil 5y). No constant-maturity DI swap ticker was found, so Brazil uses the NTN-F BVAL curve.
3. DM simulated breakevens: kept unchanged (DM payload values unchanged; DM snapshots differ only by the new keys).
4. Live window: 5 years (`LIVE_YEARS`). The simulated window stays 2023-06 → 2025-06.
5. Vendor: Bloomberg only; every catalogue entry has `ticker_haver: null`.

**Built (Phase A):** per-region factor sets (`External`, `Credit`), validated configs, configurable curve legs, optional breakeven (`breakeven=False`; `breakeven_10y_series_id` for quoted breakevens), partial-panel live mode with `data_source.missing_series`, rolling live window, catalogue `transform` (`yoy`, `diff_yoy`, `sum12`), EM nav category, pod `macro_factors` covers all regions and reports the real data source. New tool: `backend/scripts/probe_catalogue.py`. Tests: `tests/test_heatmap_engine.py`, a China fixture and page test.

**What the data allowed (differences from §5):**

| Region | Factors | Curve (BVAL) | Breakeven | Live check (2026-10-16) |
|---|---|---|---|---|
| Mexico | Growth, Inflation, Employment, Wages | 2/3/5/10/20/30y | live (Udibono BVAL) | 30/30 series; PC1 R² 0.74 |
| China | Growth, Inflation, Employment, **Credit** | 1/2/5/7/10/30y | none | 28/28; PC1 R² 0.95 |
| India | Growth, Inflation, **External** (no Employment: PLFS monthly only since 2025) | 2/5/10/15/30y | none | 15/15; PC1 R² 0.70 |
| Brazil | Growth, Inflation, Employment, Wages | NTN-F 1/2/3/5/7/10y | **live** (NTN-B BVAL 10y) | 23/23; PC1 R² 0.69 |
| South Korea | Growth, Inflation, Employment, **External** (no live wage series) | 3/5/10/20/30y | live (KWGGBE, quoted) | 18/18; PC1 R² 0.83 |
| South Africa | Growth, Inflation, Employment (quarterly + PMI), Wages (quarterly) | 2/5/10/20/30y | live (ILB BVAL 10y) | 17/17; PC1 R² 0.76 |
| Poland | Growth, Inflation, Employment, Wages (one series) | 2/3/5/7/10y | none | 14/14; PC1 R² 0.40 |
| Indonesia | Growth, Inflation, **External** | 2/5/10/20/30y | none | 13/13; PC1 R² 0.78 |

**Wave 2 (built 2026-10-18).** The user asked for "the remaining EM": §2's Wave 2 plus Romania, Turkey, Peru, Malaysia, Philippines and Taiwan. Still excluded: Saudi Arabia (USD peg, no liquid local curve), Argentina and Russia (data and market access).

| Region | Factors | Curve (BVAL) | Breakeven | Live check (2026-10-16) |
|---|---|---|---|---|
| Hungary | Growth, Inflation, Employment, Wages | 2/3/5/10/15y (2s15s) | none | 14/14; PC1 R² 0.84 |
| Czech Republic | Growth, Inflation, Employment, Wages (quarterly) | 2/5/10/20/30y | none | 14/14; PC1 R² 0.74 |
| Romania | Growth, Inflation, Employment, Wages | 2/3/5/7/10y | none | 11/11; PC1 R² 0.68 |
| Turkey | Growth, Inflation (**12m change of y/y**), Employment | 2/3/5/7/10y | none | 13/13; PC1 R² 0.82 |
| Israel | Growth, Inflation, Employment | 2/5/10/20/30y | **live** (CPI-linked BVAL) | 11/11; PC1 R² 0.80 |
| Chile | Growth, Inflation, Employment, Wages | BTP 2/3/5/7/10y | **live** (UF/BCU BVAL) | 14/14; PC1 R² 0.72 |
| Colombia | Growth, Inflation, Employment | 2/5/10/20/30y | none | 9/9; PC1 R² 0.73 |
| Peru | Growth, Inflation, Employment (Lima) | 2/5/10/20/30y | none | 11/11; PC1 R² 0.84 |
| Thailand | Growth, Inflation, Employment (quarterly + BSI) | 2/5/10/20/30y | none | 9/9; PC1 R² 0.74 |
| Malaysia | Growth, Inflation, Employment, Wages | 2/5/10/20/30y | none | 11/11; PC1 R² 0.50 |
| Philippines | Growth, Inflation, Employment | 2/5/10/20/30y | none | 9/9; PC1 R² 0.66 |
| Taiwan | Growth, Inflation, Employment, Wages, **External** | 2/5/10/20/30y | none | 11/11; PC1 R² 0.76 |

The CEE regions borrow European Commission survey series and Eurostat core HICP / unemployment where the national tickers are dead. Colombia, Thailand and the Philippines have thin panels (9 series): treat their factors as indicative.

**Flags:** heatmap icons and page titles use inline SVG flags (`components/CountryFlag.tsx`, `country-flag-icons` 1.5.13) keyed by the ISO code in `features/heatmap/regions.ts`. Emoji flags were removed: Windows has no flag emoji and showed them as letter pairs.

Each catalogue's `.md` lists every ticker and the region's data caveats.

**Found along the way (not fixed here):** the DM catalogues are mostly dead on this Terminal (e.g. UK 48 of 54 tickers, Japan 48 of 57), so every DM region's macro block falls back to simulation in live mode. This was already the case before this work. `probe_catalogue.py` makes the fix routine. Bloomberg also has BVAL linker curves for AUD, JPY, SEK, CAD, ITA and FRA (`BVUSH{F,G,J}10`, `BVCSLD10`…), which would give those DM regions live breakevens.

**Next:** Phase C (C4, the EM cross-section view, first) and fixing the DM catalogues with the probe script.

> Bloomberg tickers are not listed here on purpose. Each one is probed in the terminal (`bdp`/`bdh`) during Phase B before it goes into a catalogue. Our standing rule applies: Bloomberg first, simulation fallback, and the page always says which one it is showing.

---

## 1. How the heatmaps work today, and what breaks for EM

One engine (`backend/regional_heatmap.py`) serves every region from a `HeatmapConfig` in `backend/heatmap_regions.py` plus a `backend/data/series_catalogue_<cc>.json`. `GET /api/tools/heatmap/{region}` returns the whole page; the frontend (`features/heatmap/`) only renders it. Adding a DM-style region is the four-step recipe in `CLAUDE.md`.

The model:
- **Block 1:** a mixed-frequency DFM (Kalman smoother) on monthly/quarterly indicators gives five daily factors: Global Macro (full-panel PC) plus Growth, Inflation, Employment and Wages (within-group PCs, each sign-anchored on a `dfm_primary` series).
- **Block 2:** PCA on daily government-bond yields; PC1/PC2 regressed on the factors; macro fair value by PCA inversion; rich/cheap at 10y.
- **Page analytics** (`heatmap_analytics.py`): 2s10s/2s30s curve regimes, 10y breakeven regimes, scenario probabilities from both, curve fair-value table, indicator z-score table.

The recipe works for EM only for countries that look like a DM country. These assumptions in the code fail for several EMs:

| # | Assumption | Where | EM problem |
|---|---|---|---|
| A1 | Exactly five factors, the same names everywhere (`FACTOR_NAMES`, `K = 5`) | `regional_heatmap.py`; colours in `sections/ModelSections.tsx`; `yield_factor_loadings` is `[n_tenors, 5]` | No usable monthly wage data in China, India, Indonesia; no monthly unemployment in Indonesia, South Africa (quarterly). Each named factor **must** have a `dfm_primary` series or construction raises `KeyError`. EM also needs factors DM does not: an **External** block (FX, exports, reserves, flows) and, for China, **Credit**. |
| A2 | The curve has `2y` and `10y` tenors | `get_dashboard()` calls `tenors.index("2y")` / `"10y"`; `_breakeven_10y` | Korea's short benchmark is 3y; Poland/Hungary/Czechia have nothing liquid beyond 10–15y; Brazil's nominal curve is really the DI futures strip. |
| A3 | The curve is the government-bond curve | `yield_series_ids` | In MXN, BRL, PLN, HUF, CZK, KRW, ZAR, ILS the IRS curve (TIIE, DI, WIBOR/WIRON, BUBOR, PRIBOR, CD, JIBAR, TELBOR) is as or more liquid, and carries no credit/supply premium. |
| A4 | A breakeven always exists, simulated if no linker is configured | `_breakeven_10y`, `Breakeven` schema is required, `ScenarioSection` always shows a breakeven signal | A simulated breakeven is defensible as a placeholder for DM, but in China, India, Poland, Indonesia there is no market to proxy. The page would show an invented signal. |
| A5 | Live mode needs **every** DFM series to have ≥ 3 observations, else the whole region falls back to simulation | `_sufficient` in `_precompute` | EM catalogues will always have a few dead or short series (rebased CPI, new surveys). One bad ticker would silently turn a whole EM page simulated (the same failure we already see in EA/NO/CH). |
| A6 | Fixed sample `2023-06-01 → 2025-06-30` | `DAILY_DATES` | Applies to all regions, not EM-specific, but a live EM page that stops 16 months ago is not useful. Two years is also short for EM, where a single inflation episode dominates the z-scores. |
| A7 | Indicators enter as published levels (z-scored on the sample) | `macro_data_loader.py`; catalogue has no transform field | Fine when catalogues pick y/y series, but China publishes YTD cumulative FAI and combined Jan–Feb data; several EM series are NSA levels. |
| A8 | Pod `macro_factors` tool lists the ten regions by hand | `backend/pod/tools/analytics.py` `_REGIONS` | New regions are invisible to the pod until added. |

A1–A5 must be fixed before EM regions are added; A6 is shared work that should land first; A7–A8 are small.

---

## 2. Which economies

Selected by index weight (GBI-EM, EM-equity), liquidity of local rates, and data quality. **This is a decision for you; the plan assumes the recommendation.**

**Wave 1 (recommended, 8):** China, India, Brazil, Mexico, South Korea, South Africa, Poland, Indonesia.
Together they cover the largest EM economies and every EM region (Asia, LatAm, CEEMEA). Each has a liquid local curve and a monthly data set deep enough for a DFM.

**Wave 2 (6):** Hungary, Czechia, Chile, Colombia, Thailand, Israel. Each is a cheap add once Wave 1 has generalised the engine (most are CEE/LatAm clones of Poland/Mexico).

**Deferred:** Turkey (inflation regime break: 2y z-scores of a 20–80% CPI path tell you nothing, so it needs a different normalisation), Taiwan and Malaysia (thin local-rates interest for this desk; add on request), Saudi Arabia (peg, hard-currency curve), Argentina and Russia (data/market access).

---

## 3. Phase A: generalise the engine (no new regions yet)

All A-phase changes must keep the existing ten DM snapshots in `tests/snapshots/api_contract.json` **unchanged**. That is the regression test for this phase.

### A1. Region-specific factor set · M
- `HeatmapConfig.factors: list[str]` (default `["Global Macro", "Growth", "Inflation", "Employment", "Wages"]`). Global Macro is always first; the named factors are whatever groups the catalogue declares.
- Replace the module constants `FACTOR_NAMES` / `_NAMED_FACTORS` / `K` with per-instance values. `_simulate_macro_block` builds `group_factor_col` from the config; `ar` and `innov_std` become length-`K` (DM keeps the current numbers exactly, so the seeded simulations reproduce).
- Validate at construction: every named factor has ≥ 2 catalogue series and exactly one `dfm_primary`; `yield_factor_loadings.shape == (n_tenors, K)`. A clear error beats today's `KeyError`.
- New factor names allowed: **External** (FX vs USD, REER, exports y/y, trade balance, FX reserves, portfolio flows; primary = exports y/y or REER) and **Credit** (China: TSF y/y, new loans, M1; primary = TSF stock y/y).
- Payload: `factors.factors` is already a name-keyed dict, so the schema holds. Add `factor_names: list[str]` to the dashboard so the page doesn't assume five. Frontend: `ModelSections.tsx` falls back to a categorical colour for unknown factor names (`categoryColor` in `theme.ts`).
- `pod/tools/analytics.py`: describe factors per region instead of hard-coding the five names in the tool description.

### A2. Configurable curve legs · S
- `HeatmapConfig.short_tenor = "2y"`, `long_tenor = "10y"`, `ultra_tenor: str | None = "30y"`, `fv_tenor = "10y"` (today implicit in `pca_pc1_pivot`).
- `get_dashboard()` uses these instead of `index("2y")` / `index("10y")`; the curve-regime name is built from them (`3s10s` for Korea, `2s10s` for Poland with no 2s30s section).
- `curve_fair_value_table` takes outrights/spreads from the config (it already skips missing tenors).
- Frontend: subtitles in `RegimeSections.tsx` / `FairValueSection.tsx` read the tenor labels from the payload instead of the literal "10y" / "2s10s".

### A3. Curve instrument: bonds or swaps · S
- `HeatmapConfig.curve_instrument: Literal["govt", "swap"] = "govt"` plus `curve_name` (e.g. "TIIE swaps", "DI futures") replacing `bond_name` in labels. The maths is unchanged; this is labelling plus the catalogue pointing at swap tickers. Keep `bond_name` for DM.
- Default per country in §5. We can add a govt/swap toggle later (two engines per region) if the desk wants both; not in this plan.

### A4. Optional breakeven · M
- `HeatmapConfig.breakeven_mode: Literal["live", "simulated", "none"]`. DM regions keep today's behaviour (`live` if a real-yield id is set, else `simulated`). EM regions without a linker market get `none`.
- With `none`: `breakeven` becomes `null` in the payload; `scenario_section` computes from the curve signal alone (`current.breakeven` and `breakeven` series `null`). Schema: `Breakeven | None`, `ScenarioSeries | None`. Regenerate OpenAPI + `schema.ts`.
- Frontend: `BreakevenSection` renders nothing when absent; `ScenarioSection` shows one column and says "curve signal only (no inflation-linked market)".
- `DataSources.breakeven` gains the value `"none"`.

### A5. Partial-panel live mode · S
- Replace "every series ≥ 3 obs" with: every factor **primary** has ≥ 3 obs **and** ≥ 75% of DFM series do. Columns with < 3 obs are dropped from the DFM (the Kalman filter already copes with all-NaN columns, but they distort the block PCA initialisation) and listed in a new `data_source.missing_series: list[str]`.
- The page shows the missing list under the source badge, so a partially live page is visible as such. This also fixes the silent all-or-nothing fallback seen on EA/NO/CH (see `macro-kit-live-data-gaps`).
- Simulated mode is untouched, so snapshots don't move.

### A6. Rolling sample window · S (shared, land first)
- `DAILY_DATES` ends on the last business day before today (live) and stays fixed at `2025-06-30` under `ANALYTICS_DATA_SOURCE=simulation`/`csv`, so snapshots and the frontend fixture are stable.
- Lengthen the live window to 5 years (`HEATMAP_YEARS`, default 5) with a 2-year fetch buffer as now. EM needs at least one full cycle to make z-scores meaningful.
- Move the grid into the engine instance (it is currently module-global) so the window can differ by mode without import-order surprises.

### A7. Catalogue transforms · S
- Optional catalogue field `transform`: `none` (default) · `yoy` · `ytd_to_monthly_yoy` (China FAI-style cumulative series) · `diff12`. Applied in `data_fetcher`/`macro_data_loader` before release-date placement. Document in the catalogue `.md` template.
- China's combined Jan–Feb releases: leave January NaN (the Kalman filter handles it); note it in the catalogue.

### A8. Region grouping in the UI · S
- `HEATMAP_REGIONS` entries get `bloc: "dm" | "em"`; `dashboard_config.yaml` gets a separate **EM Macro Fundamentals** category (red stays for DM, choose a distinct category colour from the palette) so the launchpad doesn't become a 24-tile list.
- Add each region to `TOOL_FLAG` in `Glyph.tsx`.

**Tests for Phase A**
- Existing contract snapshots unchanged (`pytest backend/tests/test_api_contract.py`).
- New unit tests in `test_heatmap_analytics.py`: curve section with non-2y short leg; scenario section with breakeven `None`.
- New engine tests (a small synthetic catalogue in `tests/fixtures/`): 4-factor region (no Wages), 6-factor region (+External), missing primary raises a clear error, partial-panel live mode drops the dead column and reports it.
- Frontend: `regionalHeatmap.test.tsx` gets a fixture with `breakeven: null` and a non-default factor list.

---

## 4. Phase B: per-country build (repeat for each region)

Per country, in this order:

1. **Catalogue** `backend/data/series_catalogue_<cc>.json` + `.md` (same format as `series_catalogue_uk.*`): 30–45 DFM series, `dfm_factor`, `dfm_sign`, one `dfm_primary` per factor, `heatmap_group`, `typical_lag_days`, `transform`, plus curve (and linker) series. Fewer series than DM is fine: the factor blocks need quality, not count.
2. **Probe tickers** on the terminal with a short script (`scripts/probe_catalogue.py <cc>`, new, reusable for DM gaps too): `bdp` for existence, `bdh` for history depth and last date. Record dead tickers in the `.md`; try alternate sources (ICPL-style suffixes, Haver `@EMERGE` / `@EMERGEPR`) before giving up on a series.
3. **`HeatmapConfig`** in `heatmap_regions.py`: factors, curve legs/instrument, breakeven mode, seed (`zlib.crc32(slug)`, not a hand-picked number), simulated `yield_means` near current levels, `yield_factor_loadings` sized to the factor set.
4. **Wiring:** `_REGIONS` in `test_api_contract.py` → `UPDATE_SNAPSHOTS=1`; `regions.ts`; `TOOL_FLAG`; `dashboard_config.yaml`; pod `_REGIONS`; `python scripts/make_heatmap_fixture.py` only if the fixture region changes.
5. **Live check** on the terminal: `data_source` should read live/live, `missing_series` short; eyeball factor signs (Growth up in a known upswing, Inflation up in the 2022 shock) and the 10y fair value vs actual.

Effort per Wave 1 country: M (most of it is the catalogue and ticker probing). Wave 2 countries reuse a Wave 1 template: S–M.

---

## 5. Wave 1 country specs

Factor columns show the primary (sign-anchor) series. "—" = factor dropped for that country. Tickers are found in Phase B.

| Region (slug) | Curve (instrument, tenors) | Short/long/ultra | Breakeven | Growth primary | Inflation primary | Employment primary | Wages primary | Extra factor | Global Macro anchor |
|---|---|---|---|---|---|---|---|---|---|
| China (`china`) | CGB · 1y 2y 5y 7y 10y 30y | 2y / 10y / 30y | none | NBS manufacturing PMI | Core CPI y/y | Urban surveyed unemployment (−) | — | **Credit**: TSF stock y/y | NBS mfg PMI |
| India (`india`) | G-sec · 2y 5y 10y 30y | 2y / 10y / 30y | none (IIBs illiquid) | HSBC composite PMI | CPI y/y (watch base revision) | PLFS monthly unemployment (−) | — | **External**: merchandise exports y/y | Composite PMI |
| Brazil (`brazil`) | DI futures (swap) · 1y 2y 3y 5y 10y | 2y / 10y / — | **live** (NTN-B 10y real) | IBC-Br y/y | IPCA core y/y | PNAD unemployment (−) | PNAD real usual income y/y | — | IBC-Br |
| Mexico (`mexico`) | Mbono · 2y 3y 5y 10y 20y 30y | 2y / 10y / 30y | **live** (Udibono 10y) | IGAE y/y | Core INPC y/y | IMSS formal jobs y/y | IMSS avg daily wage y/y | — | IGAE |
| South Korea (`korea`) | KTB · 3y 5y 10y 20y 30y | **3y** / 10y / 30y | live if KTBi has history, else simulated | Exports y/y (20-day prelim. as release) | Core CPI y/y | Unemployment rate (−) | Monthly earnings y/y (2m lag) | — | Exports y/y |
| South Africa (`south-africa`) | SAGB · 2y 5y 10y 20y 30y | 2y / 10y / 30y | **live** (ILB 10y real) | Absa manufacturing PMI | Core CPI y/y | QLFS unemployment (quarterly, −) | QES earnings y/y (quarterly) | — | Absa PMI |
| Poland (`poland`) | POLGB · 2y 5y 10y | 2y / 10y / — | none | Manufacturing PMI | Core CPI y/y | Registered unemployment (−) | Enterprise-sector wages y/y | — | Manufacturing PMI |
| Indonesia (`indonesia`) | INDOGB · 2y 5y 10y 20y 30y | 2y / 10y / 30y | none | Manufacturing PMI | Core CPI y/y | — (semi-annual only) | — | **External**: exports y/y | Manufacturing PMI |

Notes that shape the catalogues:
- **China:** NBS data come out mid-month (lag ~15d), PMIs on the last day of the month (lag 0–1d). Retail, IP and FAI arrive Jan–Feb combined. Add Caixin/RatingDog PMIs, IP, retail, FAI (`ytd_to_monthly_yoy`), property sales and starts to Growth; CPI, PPI, core CPI to Inflation; PMI employment subindices to Employment; TSF, new loans, M1, M2 to Credit.
- **India:** IIP lag ~28d, CPI ~12d; GST collections and auto sales are useful high-frequency Growth inputs. The CPI base revision changes the index level, so use the y/y series and splice.
- **Brazil:** DI is the market curve; NTN-F as a cross-check. Focus survey expectations are a natural Inflation-group series (weekly, sample month-end).
- **Mexico:** Udibono breakeven is liquid enough at 10y. Banxico surveys and IMEF PMIs add timeliness to Growth.
- **Korea:** exports are the best-known nowcast, hence the Growth and Global Macro anchor. Short tenor is 3y because the 2y KTB is a minor line.
- **South Africa:** quarterly Employment/Wages go through the loader's existing quarterly path; Employment and Wages factors will be smoother and lag. Add SACCI/BER confidence, mining and manufacturing production, retail, electricity production to Growth.
- **Poland:** wages and employment are monthly and timely (good). Curve stops at 10y, so no 2s30s section.
- **Indonesia:** fewest series; Growth carries retail sales, car and motorbike sales, consumer confidence; External carries exports, imports, trade balance, FX reserves, IDR REER.

Wave 2 in one line each (same table to be filled when started): Hungary (HGB or BUBOR swaps, no BE), Czechia (PRIBOR swaps, no BE), Chile (BCP/BTP, BE from BCU), Colombia (TES, BE from UVR TES), Thailand (ThaiGB, no BE), Israel (ILGOV/TELBOR, BE from CPI-linked Galil).

---

## 6. Phase C: EM-specific page additions (optional, after Wave 1)

Only if the desk finds Wave 1 useful. Each is self-contained.

| Item | What | Effort |
|---|---|---|
| C1 Policy-rate panel | Policy rate, real policy rate (vs core CPI and vs 1y-ahead expectations), 2y minus policy rate | S |
| C2 External-vulnerability strip | FX vs USD (3m/12m z), REER, reserves in months of imports, CDS 5y, current account % GDP | M |
| C3 Global-beta regression | Regress the region's PC1 on UST 10y and DXY as well as the local factors; report how much of local rates is imported | M |
| C4 EM cross-section view | One table: each EM region's latest factor z-scores, 10y rich/cheap, scenario probabilities (the DM equivalent would be welcome too) | M |

C4 is the most useful for the pod (the China & EM and EM FX & Rates agents in `GLOBAL_MACRO_POD_PROPOSAL.md` are short of data).

---

## 7. Order of work

1. **A6** rolling window (shared, unblocks meaningful live EM pages).
2. **A5** partial-panel live mode (also fixes current DM fallbacks).
3. **A1–A4, A7, A8** engine and page generalisation, DM snapshots unchanged.
4. **Wave 1 pilots:** Mexico (closest to the DM template: full four factors, linker), then China (the hardest: Credit factor, no BE, cumulative data). If both work, the rest of Wave 1 is routine.
5. Brazil, Korea, South Africa, Poland, India, Indonesia.
6. Phase C items as requested; Wave 2 countries.

Rough total: Phase A ~1.5 weeks; Wave 1 ~3–4 weeks (dominated by catalogues and ticker probing); Wave 2 ~1.5 weeks.

---

## 8. Decisions (resolved at build time, see §0)

1. **Country list:** accept Wave 1 as above, or swap (e.g. Hungary for Indonesia, Chile for India)?
2. **Swaps vs bonds:** use swaps for Brazil only (as above), or also for Mexico/Poland/Korea/South Africa, where TIIE/WIRON/CD/JIBAR swaps are what the desk trades?
3. **Simulated breakevens:** should DM regions without a linker also move to `none` (more honest), or keep their simulated breakeven?
4. **Window:** is 5 years the right live history, or do you want 10 to cover 2015–16 and the 2020 shock?
5. **Data vendor for EM macro:** Bloomberg only, or allow Haver (`@EMERGE`) where Bloomberg coverage is thin? Haver is usually better for EM labour and wage data.
