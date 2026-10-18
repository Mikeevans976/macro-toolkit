# Huggins & Schaller, *Fixed Income Relative Value Analysis* (2nd ed., 2024): Part II tools to adapt

**Scope:** Chapters 5–20 (Part II "Financial Models" plus the epilogue). Part I (Ch 2–4: OU mean reversion, PCA, MVOU) is already implemented in `mean_reversion.py`, `pca_analysis.py` and parts of `swaps_rv.py`, and is referenced here only as a building block.
**Purpose:** list every model, analytical tool and chart in Part II that could become a feature of the Analytics Hub. For each one: what the book does, how we would build it, the data it needs, and where it fits in the current codebase.
**Status legend:** 🟢 already exists (extend it) · 🟡 partly exists · 🔴 new
**Effort:** S (< 1 day) · M (2–5 days) · L (1–2 weeks) · XL (needs data we do not yet have)

> Bloomberg tickers below are suggestions only. Check each one in the terminal (`SECF`, `CDSW`, `VCUB`, `BBAS`, `REPO`) before relying on it. Our standing rule applies: Bloomberg first, with a simulation fallback.

---

## 0. Summary: the top 12 to build

| # | Tool | Book source | Status | Effort | Why it matters |
|---|---|---|---|---|---|
| 1 | **Gov-bond analytic pipeline**: fitted curve → constant-maturity (CM) par series → PCA → OU monitor → bond selection | Ch 9 (Fig 9.1), Ch 11 | 🟡 | M | Joins three tools we already have into the book's end-to-end process |
| 2 | **Fitted-curve residual history + OU analytics per bond** (half-life, ex-ante Sharpe, T-stat instead of Z-score) | Ch 8 | 🟡 | M | Rich/cheap needs a time dimension; at the moment we only have a snapshot |
| 3 | **SOFR / €STR asset-swap fair-value model**: ASW = specialness + adj. CDS + haircut cost (+ g·q·d) | Ch 11, 12 | 🔴 | L | A causal swap-spread model rather than regression-on-macro |
| 4 | **Global USD-ASW yardstick**: (local ASW – CCBS)/CF for UST/Bund/OAT/BTP/JGB/Gilt by maturity | Ch 16, 17 | 🔴 | L | One universal rich/cheap measure for all sovereigns |
| 5 | **ASW vs CDS arbitrage-inequality monitor** (USD ASW ≤ CDS) | Ch 16 | 🔴 | M | A hard boundary and a rare but high-quality signal |
| 6 | **Sovereign CDS PCA**: cross-issuer (EGB) factors and 1-factor residuals | Ch 13 | 🔴 | S–M | Reuses `pca_analysis.py`; the book calls it a "neglected" source of RV |
| 7 | **"Risk-free" yield PCA**: bond yield – CDS, compared with raw PCA | Ch 13 | 🔴 | M | Stabilises eigenvectors through credit-regime shifts (BTPs) |
| 8 | **Bond futures CTD / delivery-option analyser**: one-factor plus multi-factor Monte Carlo, CTD probabilities, OABPV | Ch 7 | 🔴 | L | The core of basis trading and correct futures hedging |
| 9 | **Swaption breakeven explorer** (type ①): forward vs spot vs breakeven bands, macro-implied variables | Ch 19 | 🟡 | M | Extends the Option CDF tool and existing vol data |
| 10 | **Implied vs realised vol curve and box-trade screener** (type ②), EWMA realised vol | Ch 19 | 🔴 | M | A clean RV framework for gamma-sector options |
| 11 | **Vega-sector vol-surface PCA** (type ③): straddle RV with PCA hedges | Ch 19 | 🔴 | M | Reuses the PCA engine on the swaption cube |
| 12 | **Haircut-adjusted yield / funding-cost overlay** (ECB, Fed and BoE haircut schedules) | Ch 18 | 🔴 | S | Explains structural BTP–Bund and Gilt curve-steepness components |

The full catalogue by chapter follows. Section 21 gives a suggested build order.

---

## Chapter 5: Yield, duration and convexity

### 5.1 Fisher–Weil duration and convexity calculator 🔴 S
- **Book:** Macaulay duration discounts every cash flow at the bond's single YTM. Fisher–Weil discounts each cash flow on the actual zero curve, `D_FW = Σ T_i · X_i·(1+y_i/c)^(-cT_i) / P`. The authors recommend FW.
- **Build:** a utility in a new `backend/bond_math.py`, using the discount function from `fitted_bond_curves.py` (EGB curves) or `swaps_rv._build_discount_factors` (swap curves). Return Macaulay, modified, Fisher–Weil, key-rate durations and convexity side by side.
- **Use:** replace the rough `dur_T ≈ T·(1 – y/200)` in `egb_rv.py` carry and in the PCA trade-builder BPVs.

### 5.2 Coupon-effect diagnostic 🔴 S
- **Book:** on a sloped curve, two fairly priced bonds with the same maturity but different coupons have different yields, so a raw yield spread is a misleading RV measure.
- **Build:** for any bond pair, show the yield spread *explained by the coupon effect* (each bond priced off the fitted curve) against the observed spread. This is a column in the Fitted Bond Curves bond table.

### 5.3 Convexity "Jensen" panel (education/sanity check) 🔴 S
- **Book:** expected return from symmetric ±Δy grows explosively with maturity. Read correctly, convexity turns symmetric *return* distributions into asymmetric *yield* distributions (Dybvig–Ingersoll–Ross: long zero rates cannot fall).
- **Build:** a small interactive panel with maturity and vol sliders, showing (a) the expected return under ±Δy and (b) the probability of a yield decline needed to hold expected return fixed. Mostly useful as a convexity-bias sanity check for 30Y+ structures in `swaps_rv`.

---

## Chapter 6: Yield-curve models

### 6.1 Shadow-rate (SR) Vasicek model 🔴 L
- **Book:** model a shadow rate as Vasicek. The observed rate is `max(SR, floor)`, averaged over Monte Carlo paths. Use it to (a) value a change in the floor (for example ECB APP yield limit –25 → –50 bp) and its effect on the 2s10s slope, and (b) produce an SR history (Fig 6.1).
- **Calibration warning:** the optimum is ill-conditioned because different (σ, μ, κ) sets give near-identical fits. The book fixes this in stages: optimise all parameters → average μ, κ → re-optimise (x₀, σ) → average σ → re-optimise x₀ only.
- **Build:** `backend/shadow_rate.py` with Monte Carlo pricing of zero rates under a floor, the three-stage calibration across history, and outputs for (i) the SR time series, (ii) a "what-if floor" curve shock and (iii) an SR curve as an alternative PCA input.
- **Link:** feed the SR curve into `pca_analysis.py` as an alternative input set when ZIRP-era eigenvectors are unstable (Ch 3 problem).

### 6.2 Policy-path jump-diffusion calibrator (meeting-date jumps) 🔴 L
- **Book:** jump process on scheduled policy dates plus diffusion and drift, calibrated jointly to SOFR **and** Fed Funds futures. It gives one consensus policy path, a rich/cheap reading for every contract, and an implied secured–unsecured spread path.
- **Build:** start with a deterministic step-function path fitted to €STR/SOFR futures and OIS (meeting dates from the calendar we already pull for the pod), then add a diffusion term. Output a per-contract residual table, the implied path and the implied SOFR–FF spread.
- **Link:** the Euribor positioning tracker and Macro Options Monitor (same futures universe).

---

## Chapter 7: Bond futures and the delivery option

### 7.1 Basket and CTD analytics 🔴 M
- **Book:** CF definition, converted forward price `FwdP/CF`, gross/net basis, implied repo, the CTD switch "inflection point" against yield level (Fig 7.1) and fair futures price `FwdP_CTD/CF_CTD – DO` (Fig 7.2).
- **Build:** `backend/bond_futures.py` covering:
  - basket per contract (RX/OE/DU/UB, TY/FV/TU/US/WN, G, OAT, BTP): CF, dirty price, repo, forward price, gross basis, carry, net basis, implied repo;
  - **chart A:** converted forward price of each deliverable against parallel yield shift (–200…+200 bp), with the CTD envelope (Fig 7.1);
  - **chart B:** fair futures price against yield, with the DO as the gap to the CTD line (Fig 7.2).
- **Data:** BBG `DLV` fields (`FUT_DLVRBLE_BNDS_ISINS`, `FUT_CNVS_FACTOR`, `FUT_CTD_ISIN`), repo (`REPO`), deliverables' prices. The fallback is the synthetic basket already built in `fitted_bond_curves._flag_deliverables`.

### 7.2 One-factor delivery-option model (Box 7.1) 🔴 M
- Regress each deliverable's yield on the CTD yield to get betas. Map a range of CTD yields at delivery to every deliverable's yield, find the inflection points, decompose the switch payoff into puts and calls, and price each with skew-matched implied vol from futures options (Black) **or** integrate the payoff against the option-implied density.
- **Output:** DO value, fair futures, **option-adjusted BPV (OABPV)** by bumping yields ±1 bp, and theoretical against market net basis.
- **Link:** reuse the density from `OptionDerivedCDF` (Gram–Charlier) for the integration variant.

### 7.3 Multi-factor Monte Carlo DO model (Box 7.2) 🔴 L ⭐
- **Book:** state variables `y₁, y₂–y₁, …, yₙ–y₁` are jointly normal with a full covariance. Simulate to delivery, mean-adjust so each bond's average simulated price equals its forward, then compute the CTD per path. DO = mean switch profit. CTD probability = frequency. Fair calendar roll from the front and back contract. OABPV from a PC1-consistent 1 bp shift.
- **Inputs:**
  - level vol from futures-option implied vol;
  - spread vols from history *before* basket entry, scaled by the "into-delivery" multiplier (Fig 7.4: spread vol more than doubles in the final year), optionally as a time-varying vol per path;
  - historical correlations, with stress scenarios.
- **Charts:**
  - **CTD scatter** (Fig 7.3): axes are the spread changes of bond 2 and bond 3 against bond 1, with points marked by CTD;
  - CTD-probability bar chart;
  - DO against the spread-vol input (should be close to linear through the origin);
  - Fig 7.4-style spread vol by time-to-delivery bucket, built from our own history.
- **Trade output:** model DO against market-implied DO (net basis/CF); long/short CTD net-basis signal; hedge with OABPV; front–back roll fair value.

### 7.4 Futures-aware hedge ratios 🔴 S
- Once 7.2/7.3 exist, the PCA trade builder and EGB RV should offer "execute with futures" and size by OABPV rather than CTD BPV/CF.

---

## Chapter 8: Fitted bond curves (🟢 implemented in `fitted_bond_curves.py`; extensions)

The core is done: joint optimisation of the curve and the external-variable regression, exponential or cubic splines, L1/L2 loss, `predict_new_issue`, `par_benchmarks`. Remaining items from the chapter:

### 8.1 Rich/cheap residual time series + OU stats 🟡 M ⭐
- **Book:** do not use naked Z-scores. Report half-life, ex-ante Sharpe at about a 2-week horizon, and a T-stat (Student-t) for each bond's residual, and allow a structural non-zero mean.
- **Build:** store a daily fit (cache per `as_of`), assemble a residual panel per ISIN, and pass each series to `mean_reversion.analyse`-style PMLE. Add a residual-history chart plus OU card to `get_bond_detail`.

### 8.2 Heteroscedasticity diagnostics and WLS presets 🟡 S
- Residuals shown in **EUR and in bp** (Figs 8.2/8.3), with a toggle and a residual against maturity scatter.
- Weight presets: ∝ BPV, a deliverable penalty and a specialness penalty (the book lists all three).

### 8.3 Extra external variables 🟡 S–M
- Repo specialness (bp, from the BBG repo screen), "recent CTD" and "likely next CTD" flags, and bid-ask as a liquidity proxy.
- **Time series of coefficients** (benchmark premium, age decay, deliverable premium) as a chart. Ch 9 calls this "link to flows".

### 8.4 Generic notional benchmarks → CM par series 🟡 S ⭐
- **Book:** `C = 100·(1 – Z_T)/A_T` gives a synthetic par yield for any tenor. Ch 11 recommends these CM Treasury/Bund series *instead of* swap rates, which have structural breaks from LIBOR → SOFR and the SOFR pre/post-SRF change, as PCA/OU inputs.
- **Build:** a nightly job that writes `par_benchmarks` for 2/5/7/10/20/30Y per issuer into a parquet history, exposed as an `expression` source in Mean Reversion and a curve option in PCA.

### 8.5 New-issue and futures-pricing hook 🟢→ S
- `predict_new_issue` exists. Connect it to 7.1 so a not-yet-issued Schatz or Bobl can enter the futures basket. This is the book's suggested application.

---

## Chapter 9: An analytic process for government bond markets ⭐

### 9.1 End-to-end "Gov Bond RV Workflow" page 🟡 M
The book's Fig 9.1 maps directly onto our modules:

```
Market prices of bonds
   └─► Fitted curve (Ch 8)  ──► rich/cheap, micro switches, ext-var coefficients ("link to flows")
          └─► CM par series (8.4)
                 └─► PCA (Ch 3) ──► factors ↔ macro links, maturity selection, PCA hedge ratios
                        └─► OU on factors (Ch 2) ──► market monitor (Sharpe threshold alerts)
                               └─► back to fitted curve ──► pick cheapest / richest bond in each leg
                                      └─► BPV-adjusted hedge ratios, carry, MR on CM series,
                                          bucketing MR (Stanton), FPT, execution (target/stop)
```
- **Build:** a wizard-style page that chains `fitted_bond_curves` → `pca_analysis` → `mean_reversion`. Step 3 re-maps PCA weights on CM tenors to actual ISINs (BPV-adjusted) and shows carry per bond.
- **Market monitor:** a scheduled job runs PCA + OU on every configured curve or CCY and pushes an alert when ex-ante Sharpe exceeds a threshold. The book says it ran this "for many years". This fits the `agents/` and pod infrastructure.
- **Option:** replace PCA with MVOU in step 2 (book's alternative).

---

## Chapter 10: Map of the swap block (concepts → design)

### 10.1 "Driver decomposition" diagram component 🔴 S
- Figs 10.1/10.2: a bond's ASW = funding swap (repo vs reference rate) + credit swap (sovereign CDS) + non-cash-flow benefits. CCBS links the currency blocks and CDS ties to each issuer.
- **Build:** an interactive SVG on the new "Swap Spreads" page. Each node shows its live value (UST SOFR-ASW, US CDS, SOFR–ESTR CCBS, Bund ESTR-ASW, German CDS) and its 1-week change, so a move can be traced through the system (the JGB-CDS → Bund EURIBOR-ASW example).

---

## Chapter 11: Reference rates

### 11.1 Reference-rate dashboard 🔴 S
- Table 11.1 (term/O-N × secured/unsecured per CCY), with live fixings for SOFR, FF/EFFR, €STR, Euribor 3M/6M, SONIA, TONA and TIBOR, plus the spreads between them.
- SOFR against FF with SRF-rate band (Fig 11.3) and a **regime flag** for structural breaks (LIBOR cessation, SRF launch 28 Jul 2021) that downstream time-series tools must respect.

### 11.2 Secured–unsecured basis model `g·q·d` 🔴 S
- Spread ≈ cost of equity × BIS risk weight × capital ratio (e.g. 10% × 20% × 8% = 16 bp).
- **Build:** a calculator plus regulatory what-if, for example "d 8% → 12% ⇒ Bund €STR-ASW –20 → –30 bp".

### 11.3 Repo–term-rate (repo–LIBOR/Euribor) model 🔴 S–M
- `L = R/(1–p(1–c)) + p(1–c)/(1–p(1–c)) + qd(g–b)/(1–p(1–c))`
- **Build:** a fair-value calculator with inputs repo, PD (from bank CDS index, e.g. iTraxx Senior Fin), recovery, g, b, q and d. Back out an implied cost of equity g from market Euribor–€STR (a useful stress gauge).
- **Uses:** fair value for the Euribor-ASW funding leg, and the ICBS (Ch 14) and CCBS (Ch 15) inputs.

### 11.4 Repo specialness tracker 🔴 M (data-limited, XL for full history)
- Specialness = GC – special repo by ISIN. Track benchmarks and CTDs, with an expected-specialness curve by years-to-maturity per issuer (Fig 12.2: German/French/Dutch/Italian/Spanish).
- This is an input to 8.3, 12.1 and 17.2. **Data:** BBG `REPO` screen or Eurex Repo / Brokertec if available; otherwise a user-maintained table.

---

## Chapter 12: Asset swaps

### 12.1 Asset-swap fair-value model 🔴 L ⭐
- General: **ASW = fair value of (repo – reference-rate) basis swap + adjusted CDS (+ haircut cost)**.
  - **SOFR-ASW** = –PV(expected specialness) + 0.39·CDS (physical) or 0.45·CDS (cash) + haircut cost.
  - **€STR/OIS-ASW** = SOFR-type components – g·q·d (secured–unsecured basis).
  - **Euribor-ASW** = OIS-ASW components – term risk (repo–Euribor model 11.3).
- **Haircut term** (Fig 12.4): without it the model under-predicts the UST 5Y SOFR-ASW. With a 2% haircut × 5% excess funding it adds about 10 bp. Can be inverted to infer the marginal player's haircut funding cost (book: ~8 bp, Sep 2023).
- **Charts:** market against model ASW history per tenor (Fig 12.4), and a component waterfall (specialness / CDS / basis / term / haircut).
- **Link:** `egb_rv.py` already pulls ASW levels for EGBs. This adds the "why" and a fair value.

### 12.2 Term structure of the three ASW curves 🔴 S
- Fig 12.5: SOFR-ASW, OIS-ASW and LIBOR/Euribor-ASW curves against maturity are near-parallel shifts. Plot all three for each issuer, with Table 12.1 as a legend of which drivers apply to each.

### 12.3 Cyclicality panel 🔴 S
- Rolling correlation of SOFR-ASW / €STR-ASW against macro (unemployment, deficit/issuance, policy rate) and against CDS. It tests the book's claim that most macro drivers act *through* the CDS, so the CDS beta should absorb them.
- **Link:** the heatmap macro series already in `macro_data_loader.py`.

---

## Chapter 13: Credit default swaps

### 13.1 CDS adjustment calculator 🔴 S
- Adjusted CDS = CDS × 0.45 (FX component, cash settled) or × 0.39 (FX + DO, physical), with a 30/45/60% scenario slider. The book insists every trade is checked under the low, mid and high case.

### 13.2 CDS-curve PCA (single issuer, 2/5/10Y) 🔴 S
- Usually about 99.5% PC1, so there is little curve RV. Main use: choose the best maturity for a directional CDS view, using the PC2 sign.
- **Build:** a curve config in `pca_analysis` series catalogue (`CDS_<ISSUER>`).

### 13.3 Cross-issuer sovereign CDS PCA 🔴 S–M ⭐
- **Book:**
  - EGB 5Y CDS: PC1 is a "euro-crisis fever chart" and its loadings give the hedge ratios (10 bp DE ⇒ 26 bp FR ⇒ 64 bp IT). Higher PCs are bailout-country specific.
  - **Core-only** (DE, FR, NL, AT): PC2 is "big vs small core" with fast mean reversion, i.e. pure RV.
  - 1-factor residuals pick the trade (sell FR CDS against buy 1.4× AT).
- **Build:** new curve sets in the PCA catalogue (all-EGB, core-EGB, G7, EM). Run the standard PCA + OU + residual + PCA-hedge pipeline.
- **Data:** BBG sovereign CDS tickers (verify each, e.g. `CDSW`).

### 13.4 "Risk-free" yield curve PCA (yield – CDS) 🔴 M ⭐
- **Book:**
  - subtracting CDS from bond yields restores the 3-factor structure and removes the PC1–PC2 sub-period correlation caused by credit-regime shifts (Fig 13.14; Table 13.1: 10Y R² 0.79 → 0.96);
  - PC2 reverts faster, and eigenvectors are more stable near the zero bound (an alternative to the shadow rate);
  - trade example: BTP 2s5s steepener against the CDS curve (73 bp potential).
- **Build:** a `pca_analysis` input transform `yield_minus_cds` (unadjusted for tradeable hedges, adjusted for analysis). Compare panels: eigenvalues, PC1/PC2 histories raw against risk-free, and a factor-correlation scatter by sub-period.
- **Trade checklist** (book's pitfalls), auto-generated: net long or short CDS (FX component, DO exposure), repo near default, redenomination risk for EGBs.

### 13.5 Implied default-probability stripping 🔴 S
- Strip hazard rates from the CDS curve and flag negative forward PDs. The book mentions this as the usual approach, to be complemented with PCA.

---

## Chapter 14: Intra-currency basis swaps

### 14.1 ICBS monitor 🔴 S
- Euribor 3s6s, €STR–Euribor 3M/6M, SOFR–FF (and the SOFR–FF futures spread), TONA–TIBOR. History with stress overlays (subprime, euro crisis).
- **Scatter vs CCBS** (Figs 14.3/14.4): the book's regression `SOFR:ED spread = –0.51·(2Y JPY CCBS) + 3.8, R² 0.51`. Use it to replace capital-heavy CCBS legs with futures-spread hedges.
- ICBS fair value from the 11.2/11.3 models against the market.

---

## Chapter 15: Cross-currency basis swaps

### 15.1 CCBS dashboard 🔴 M
- 1–30Y curves for EUR, JPY, GBP, CHF (and others) against USD, with the history and a **structural-break flag** (LIBOR–LIBOR → SOFR–RFR).
- A synthetic continuous series: adjust post-transition quotes back to the old type with the ICBS (book recommendation).
- CIP deviation / FX-forward "richness" for the short end (FX swap implied rate against OIS).

### 15.2 CCBS driver regressions 🔴 M
- **Book models:**
  - CCBS on the ASW difference (UST – JGB 2Y, R² 0.34, Fig 15.1);
  - CCBS PC1 on realised 5Y swap vol (R² 0.86 in crisis, Fig 15.2);
  - recommended joint model: USD-EUR, USD-JPY and USD-GBP CCBS on AA-corporate ASW differences + SOFR–FF spread, fitted simultaneously.
- CCBS against the FX spot overlay and rolling correlation (Fig 15.4, "dollars going special").
- **Link:** `correlation_regimes.py` can host the CCBS–FX and CCBS–vol pairs. This is a natural fit for the regime-break scanner.

### 15.3 CCBS curve PCA 🔴 S
- The book mentions it (PC1 used in Fig 15.2), but warns that the CCBS is flow-driven and should not be traded on statistics alone. This is a config entry in the PCA catalogue.

---

## Chapter 16: Combining asset, basis and default swaps ⭐

### 16.1 USD-ASW converter 🔴 M
- `USD_ASW = (Local_ASW_vs_CCBS_leg – CCBS)/CF`, with CF = BPV_USD/BPV_local. Add the ICBS when the local ASW leg differs from the CCBS leg (e.g. TIBOR → TONA).
- Worked check from the book: JGB 10Y 6M-ASW –1 + ICBS 12 = 11, CCBS –64.5, CF 0.95 ⇒ **+79 bp vs USD**. Use this as a unit test.

### 16.2 Global USD-ASW curve chart 🔴 S (after 16.1)
- Fig 16.1/17.2: USD ASW against maturity for UST, Bunds, OATs, BTPs, JGBs and Gilts (scatter per bond plus a fitted line). This is the global asset-allocation picture.

### 16.3 Arbitrage-inequality monitor: USD ASW against CDS 🔴 M ⭐
- **Book:** USD ASW (market) ≤ CDS (market) whenever specialness and haircuts are small. A violation is a long asset & basis-swapped bond + long CDS trade, the only side the book endorses.
- **Charts:**
  - per issuer, USD ASW per bond against maturity with the CDS ask curve overlaid (Fig 16.3);
  - "headroom" = CDS – USD ASW per maturity (how far ASW can widen before arbitrage);
  - history per bond (Fig 16.4, the Korea 2008–09 case).
- **Alert:** headroom < –X bp (configurable, since balance-sheet costs set the practical threshold).
- **Meta-signal:** the size and persistence of violations is a proxy for the scarcity of arbitrage capital (Ch 18). Plot it as an index.

### 16.4 Equilibrium decomposition: local ASW, USD ASW and CCBS 🔴 S
- Figs 16.5–16.7: for each issuer, plot local ASW, USD ASW, CCBS and CDS together, and compute which leg absorbs CCBS volatility. Use rolling vol shares, or regress ΔUSD_ASW and ΔLocal_ASW on ΔCCBS.
  - Low-risk issuer (Bund): USD ASW stable; local ASW and CCBS offset.
  - Risky issuer (JGB): local ASW stable; USD ASW mirrors CCBS and tracks CDS.
- Output: a "regime label" per issuer, used to predict how a CCBS shock will transmit.

---

## Chapter 17: Global bond RV via fitted curves and SOFR-ASW

### 17.1 Asset & basis-swap cash-flow engine 🔴 M ⭐
- **Book:** three steps.
  1. Par asset-swap the bond in local currency (up-front = 100 – dirty).
  2. CCBS to the target CCY (notional = par, T+2 aligned).
  3. Reverse asset-swap floating → fixed in the target CCY.
- Worked example: UST 3.375% May-33 → GBP: dirty 90.37, SOFR+30 → SONIA–19+30 = SONIA+11 → **4.46% GBP coupon** (from 4.83% USD). Use it as a regression test.
- **Build:** `backend/asset_basis_swap.py` (shared by 16.1). Output each bond as either a synthetic fixed-coupon bond in CCY X or a floater at RFR + s.

### 17.2 Cross-currency fitted curve 🟡 M
- Feed the synthetic bonds from 17.1 into `fitted_bond_curves.fit_curve`. Options: fit through the home issuer only (Bund yardstick, Fig 17.1) or jointly (a global yardstick), with **global external variables** such as a cross-market benchmark premium.
- **Chart:** spread against the Bund curve by maturity, coloured by issuer (Fig 17.1).

### 17.3 SOFR-ASW rich/cheap with external-variable regression 🔴 M
- For USD: skip the curve and regress SOFR-ASW of all (basis-swapped) bonds on specialness, benchmark flag, haircut bucket and adjusted CDS. The residual is the rich/cheap measure.
- The book prefers **par** ASW against SOFR. Interpolated and full ASW carry coupon-effect biases, and non-SOFR ASW are unfit as RV measures. Add a warning label in `egb_rv` where Euribor ASW is shown as rich/cheap.

### 17.4 ASW-definition comparator (education/QA) 🔴 S
- For a chosen bond, show interpolated, par, full and zero-coupon ASW together with the coupon-effect bias against the fitted curve, so analysts see why only par SOFR-ASW is acceptable.

---

## Chapter 18: Other factors (haircuts, regulation, supply)

### 18.1 Haircut-cost yield overlay 🔴 S ⭐
- Encode the haircut schedules:
  - **Fed:** Table 18.1;
  - **BoE:** Table 18.2, which is very steep;
  - **ECB:** Table 18.3, tiered by issuer (DE/FR/ES and IT; bullet and zero).
- Yield drag ≈ haircut × excess funding cost (default 600 bp; user slider). Chart haircut-implied spread against maturity per issuer (Fig 18.1: BTP–Bund ≈ 47 bp at 10Y, 54 bp at 30Y for zeros).
- **Uses:** a structural-component line on EGB RV spread charts, the haircut term in 12.1, and an explanation of the steep Gilt SOFR-ASW curve (17.2).
- Keep schedules in `data/haircut_schedules.json` with an as-of date, since they change.

### 18.2 Balance-sheet / shadow-cost calculator 🔴 S
- Box 18.1: blended cost of funds under a CET1 constraint, against the asset-displacement hurdle. Mainly a pod-side sizing aid, giving a hurdle rate per RV trade alongside the ex-ante Sharpe.

### 18.3 Funding-stress and arbitrage-capital index 🔴 M
- Combine observable deviations from no-arbitrage: SOFR–IORB, quarter-end SOFR spikes, CCBS level, ASW–CDS violations (16.3), futures net-basis dislocations (Ch 7) and bond–swap spreads at quarter end.
- Output one index with a regime flag, used to raise entry thresholds (Ch 20) and to read the "one man's constraint is another's opportunity" signal.

### 18.4 Supply/demand event log 🔴 S
- Annotation layer (DFA tap/repo facility usage, ECB comments, auctions) on EGB RV and ASW charts, so excess richness beyond model fair value (Bunds in Figs 17.1/17.2) can be attributed.

---

## Chapter 19: Options

### 19.1 Volatility-surface segmentation map 🔴 S
- Fig 19.5: expiry × tail grid classified as gamma / grey / vega. Derive the boundary empirically: run PCA on the whole surface and find where the PC1 loading changes sign (Figs 19.20/19.21). Shown as a heatmap.

### 19.2 Type ① breakeven explorer (single underlying) 🟡 M ⭐
- **Book:** for each expiry (1M/3M/6M/1Y) × strategy (payer/receiver/straddle), plot **spot curve, forward curve and breakeven band** against the underlying tenor (Figs 19.6–19.8). The band width shows the level of implied vol, and forward minus spot shows rolldown.
- Add a history of (breakeven – spot) per point to judge whether today is unusual.
- **Macro-implied variable** (Fig 19.9): convert breakeven–spot into a ΔPC1 (divide by the PC1 loading), then into a macro variable through the factor–macro regression already in `pca_analysis`/heatmaps. Output an "option-implied CPI or policy-rate path" surface per expiry and tail.
- **Scenario t-stat heatmap:** baseline, recession and recovery yield forecasts against breakevens.
- **Link:** extends `option_derived_cdf.py` (same vol tickers) and `CurveRolldown.tsx` (forward against spot is already there).

### 19.3 Type ① conditional curve-trade screener (two or more underlyings) 🔴 M ⭐
- For every curve or fly (e.g. 2s10s, 2s5s10s, 7s10s20s), compute:
  1. directionality R² of the curve trade against the level (as in Ch 3, Fig 3.14);
  2. for the *right* conditionality (payers if it flattens in a selloff, receivers otherwise), the up-front premium pickup at BPV×delta weights.
- **Chart:** scatter with R² on x and premium pickup on y. Candidates sit in the top-right (Fig 19.11, Nhan Ngoc Le).
- **Conditional swap-spread variant:** swaption vol against bond-futures-option vol history (Fig 19.12).
- **Data:** swaption normal vol matrix (already partly in `swaps_rv.py` tickers) and forward rates from the `swaps_rv` bootstrap.

### 19.4 Type ② implied vs realised vol tools 🔴 M ⭐
- **Realised normal vol** in bp/yr from daily bp changes, **EWMA-weighted** rather than a rolling window (Figs 19.14–19.16: rolling windows create fake drop-offs). Add a utility to `bond_math`/`mean_reversion`.
- **Single underlying:** history of realised vol against a horizontal line at current implied, annotated with regime events (Fig 19.13: Lehman, BoJ QE, earthquake).
- **Curve view:** current implied and realised vol curves across tails (Fig 19.17).
- **Box trade:** history of realised (5Y–2Y) vol spread against the current implied spread (Fig 19.18), plus a **non-directional** version. Regress the realised spread on the realised level to get the neutral ratio (book: 1.23× 2Y per 5Y), giving Fig 19.19.
- **Output:** a ranked table of delta-hedged straddle spreads by (implied spread – realised spread distribution percentile).

### 19.5 Type ③ vega-sector vol-surface PCA 🔴 M ⭐
- Restrict to the vega sector (from 19.1). PCA on the ATM normal vol surface gives:
  - PC1 = overall vol level, correlated with SPX/VIX/oil;
  - PC2 = expiry-dimension slope, correlated with the swap rate level and vol-of-vol;
  - PC3 = tail-dimension slope, which is pure RV.
- 3-D/heatmap eigenvectors (Figs 19.21–19.24), factor histories, a macro-correlation table (Table 19.1), 1-factor residual surface (Fig 19.26) and PC2 against swap-rate scatter (Fig 19.27, regime split).
- PCA-hedged straddle trades (vega-neutral to PC1), plus pitfall checks: eigenvalue 2 ≈ 3 instability, residual delta, theta mismatch, and holding horizon against half-life.
- **Build:** reuse `pca_analysis` with a "surface" input flattened to (expiry, tail) columns. The frontend renders loadings as heatmaps.

### 19.6 Normal ↔ lognormal vol converter 🔴 S
- Exact conversion (price via Black → invert Bachelier) and the quick approximation σ_N ≈ σ_LN·F. A utility for any lognormal-quoted source.

### 19.7 Asian-option awareness for RFR futures options 🔴 S (note only)
- Flag 1M/3M SOFR/€STR futures options that are inside their reference period (path-dependent). Price them with a geometric-average approximation, or at minimum show a warning in the Macro Options Monitor.

---

## Chapter 20: Relative value in a broader perspective

### 20.1 Intervention-adjusted entry thresholds 🔴 S
- **Book:** when the official sector is on the other side (QE, APP limits, SRF, haircut changes), mispricings can be larger and last longer. Raise thresholds, or prefer higher-PC trades that are less exposed to policy.
- **Build:** a per-market "policy intervention" flag (manual plus event log 18.4) that scales the OU signal threshold in the market monitor (9.1) and tags trade ideas in the pod.

---

## 21. Suggested build order

**Phase A: quick wins on existing engines (1–2 weeks)**
1. 8.4 CM par series job, then 8.1 residual history + OU per bond (Fitted Curves).
2. 13.3 sovereign CDS PCA and 13.2 CDS-curve PCA (catalogue entries, after verifying CDS tickers).
3. 19.6 vol converter, 19.4 EWMA realised vol and the implied/realised curve chart.
4. 18.1 haircut-schedule overlay and 13.1 CDS adjustment calculator.
5. 5.1 Fisher–Weil/BPV utility, then replace the rough durations in `egb_rv.py`.

**Phase B: the gov-bond workflow and options (2–4 weeks)**
6. 9.1 analytic-process page and OU market-monitor job.
7. 19.2 breakeven explorer, 19.3 conditional-trade screener, 19.5 vega-sector PCA.
8. 13.4 risk-free yield PCA.

**Phase C: the swap block (4–6 weeks; most new data)**
9. 11.1/11.2/11.3 reference-rate dashboard and basis models.
10. 17.1 asset & basis-swap engine, then 16.1/16.2 USD-ASW yardstick.
11. 16.3 ASW–CDS arbitrage monitor and 16.4 equilibrium decomposition.
12. 12.1 ASW fair-value model (needs 11.4 specialness and 18.1 haircuts).
13. 15.1/15.2 CCBS dashboard and driver regressions; 14.1 ICBS monitor.
14. 17.2/17.3 cross-currency fitted curve and SOFR-ASW regression.

**Phase D: heavy models**
15. 7.1–7.4 bond-futures basket, one-factor and multi-factor DO and OABPV.
16. 6.1 shadow-rate model; 6.2 policy-path jump-diffusion.
17. 18.3 arbitrage-capital/funding-stress index; 20.1 intervention thresholds.

## 22. Data gaps to resolve first

| Need | Used by | Candidate source (verify) |
|---|---|---|
| Sovereign CDS 1–10Y (US, DE, FR, IT, ES, NL, AT, BE, PT, IE, JP, UK) | 12.1, 13.x, 16.3 | BBG `CDSW` / CMAN tickers |
| SOFR / €STR / SONIA / TONA OIS curves | 12.1, 16.1, 17.1 | already in `swaps_rv` for some CCYs |
| CCBS curves (SOFR–€STR, SOFR–Euribor, SOFR–TONA, SOFR–SONIA) | 15.x, 16.x, 17.1 | BBG `BBAS` / basis swap tickers |
| ICBS (€STR–Euribor 3M/6M, Euribor 3s6s, SOFR–FF) | 14.1, 16.1 | BBG basis tickers; SOFR/FF futures spread |
| Per-bond par ASW vs SOFR / €STR / Euribor | 12.x, 16.x, 17.x | BBG `ASW` fields (`ASSET_SWAP_SPD_MID` etc.) |
| Repo GC and special rates by ISIN | 7.x, 8.3, 11.4, 12.1 | BBG `REPO`; otherwise manual |
| Futures baskets, CF, CTD | 7.x | BBG `DLV` fields |
| Swaption ATM normal vol cube (expiry × tail) | 19.x | `USSN/EUSN/BPSN…` (partly wired) |
| Bond-futures option implied vol | 7.2, 19.3 | BBG `OMON` / futures option vol fields |
| Haircut schedules (Fed, ECB, BoE) | 12.1, 18.1 | static JSON from the central banks' sites, with an as-of date |

## 23. Cross-cutting conventions to adopt from the book

- **Sign convention:** ASW quoted as *Reference rate + X*. A richening bond means a lower (more negative) ASW.
- **Prefer half-life, ex-ante Sharpe and T-stat over Z-scores** in every RV table.
- **Structural-break awareness:** never splice LIBOR-era swap, ASW or CCBS series with RFR-era series without an ICBS adjustment. Default long-history inputs to fitted-curve CM par yields.
- **Normal (bp) vol everywhere;** EWMA for realised vol.
- **Run every credit-linked trade under several adjusted-CDS scenarios** (30/45/60%), and report the net CDS, DO and FX exposure in a default.
- **Correct hedge ratios:** PCA on CM tenors, re-mapped to actual bonds by BPV; futures sized by OABPV; options weighted BPV×delta for conditional trades and PCA for vega-sector trades.
