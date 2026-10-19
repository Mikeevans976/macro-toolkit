# Quarterly Review: Q3 2026

*19 October 2026. Levels are indicative, taken from official sources (BoE, ECB, Bundesbank, FRED, Bank of Canada) and market reports as of 15–19 Oct. Entries will be checked against live quotes before execution; option premia are model estimates, capped by the entry rules in each table.*

## Summary

**Where the book makes money.**
- **Theme 1 (BoE):** makes money unless the BoE delivers the full hiking cycle: +£4.9m if gradual, +£4.8m on one-and-done, −£1.9m on the full cycle.
- **Theme 2 (inflation persistence):** makes money while energy stays high (+£1.2m to +£7.4m) and loses £4.1m if the shock fades.
- **Theme 3 (France):** pays in a crisis (+£5.8m) or if the shock fades (+£1.9m), and loses £2.4m if France muddles through.
- **Theme 4 (European revival):** pays if the revival takes hold (+£6.1m) or on a Ukraine peace dividend (+£4.6m), and loses £1.7m if derailed.
- **Theme 5 (AI):** pays in a correction (+£2.6m) or a burst (+£14.8m), and loses £2.4m if the boom continues.

**How the themes interact.**
- **Energy is the common factor.** Themes 1 and 2 are negatively correlated by design: the full cycle that costs Theme 1 £1.9m is Theme 2's best outcome. Together they make money in every natural pairing of their scenarios (+£0.7m to +£8.3m).
- **When the shock fades,** Theme 2's loss is offset by Theme 1 (one-and-done) and Theme 3 (Bund calls).
- **Themes 3 and 4 are opposite bets on Europe:** a French crisis is what derails the revival.
- **Theme 5 is the growth hedge:** a burst rallies rates, which helps Themes 1 and 3 and hurts Themes 2 and 4.
- **The weakest combination** is the status quo with France calming and the AI boom continuing: about +£1.0m. That is +£4.9m from Theme 1 (gradual) and +£1.2m from Theme 2 (plateau), against −£2.4m from Theme 3, −£2.4m from Theme 5 and −£0.3m from Theme 4.
- **Each theme's scenarios are separate,** so these combinations are illustrative, not a joint model.

| # | Theme | Trades | Capital deployed | P&L |
|---|-------|--------|------------------|-----|
| 1 | Gradual, short BoE hiking cycle; heavy gilt supply in the belly | Receive SONIA 6m×1y; 6m×1y receiver spread; 3m×10y straddle; 2s10s30s fly; 10y gilt–OIS widener | £5.22m (max loss at stops) | +£3.08m expected (6m); −£1.9m if the full cycle is delivered |
| 2 | Inflation persistence, with domestic pressures re-accelerating (UK, euro area, G10) | Long UK 3y RPI; long US 5y breakeven; long EUR 1y1y inflation; pay EUR 1y1y vs receive SONIA 1y1y; long Dec-27 Brent | £5.31m (max loss at stops) | +£1.99m expected (6m); +£7.4m if persistence is broad, −£4.1m if the shock fades |
| 3 | Euro area fiscal crisis, with the political risk premium rising | OAT–Bund widener; short OAT vs Bonos; 6m Bund call spread | £2.65m (max loss at stops) | +£0.70m expected (6m); +£5.8m in a crisis, −£2.4m if France muddles through |
| 4 | Euro area fiscal and growth revival | Bund 5s30s steepener; 6m EURUSD call spread | £1.99m (max loss at stops) | +£1.45m expected (6m); +£6.1m if the revival takes hold, −£1.7m if derailed |
| 5 | The AI bubble bursts | Receive US 2y; 6m Nasdaq 100 put spread; buy CDX IG protection | £3.32m (max loss at stops) | +£2.78m expected (6m); +£14.8m in a burst, −£2.4m if the boom continues |
| | **Total** | **18 trades** | **£18.49m** | **+£10.0m expected** |

- *Method:* Capital deployed is the max loss at the stops (the premium, for options).
- *Sizing:* Max loss is a conviction share of a £2.65m per-trade risk unit: conviction 2 → £663k, 3 → £1.33m, 4 → £1.99m. The unit is set so the book's six-month expected P&L is £10m, 3.54× the provisional £750k limit. The pod's per-trade, bucket, scenario-loss and trade-count limits need to be raised by the same factor.
- *Expected P&L:* Each trade's six-month P&L is weighted by its own theme's scenario probabilities, capped at the target and floored at the stop, with carry excluded unless stated. Expected values add across themes.

---

## Theme 1: Gradual, short BoE hiking cycle, with heavy gilt supply in the belly

### Current state of the theme

- **Monetary policy:**
  - The centre of the MPC (Bailey, Lombardelli, Breeden, Ramsden) backs a November hike, but makes further hikes conditional on the energy shock lasting and reaching wages.
  - Breeden and Bailey shifted tone dovish again in October, calling second-round effects "quite subdued."
  - Bank Rate is 3.75%, held 6–3 in July and September (Greene, Mann and Pill voted for 4%). CPI is 3.1%, seen above 4% in early 2027.
- **Fiscal and supply:**
  - The 28 Oct Budget defers the hard choices. Headroom is expected at ~£14–15bn, down from £23.6bn; below £10bn would hit gilts.
  - Banks expect the remit to rise £5bn to £251.2bn, with Mediums up to 37.4% (from 30.9%) and Longs down to 4.9%, then ~£300bn next year. Belly supply is heavier both now and later.
- **Drivers:**
  - Imported energy, not domestic overheating. Dated Brent is $127 (14 Oct) after re-spiking in Q3 ($70 at end-June, $116 at end-September), and the January Ofgem cap is estimated at +22%.
  - Services (3.4%) and core (2.6%) CPI are flat, and the labour market is loosening.
  - Duration is selling off globally on fiscal concerns and synchronised hiking; the 30y gilt hit 6.05%, its highest since 1998.
- **Pricing (15 Oct):**
  - OIS forwards peak at ~4.88% (~4.5 hikes), ~50bp above our 4.35% modal outcome.
  - Q3 moves were belly-led: 5y +67bp, 30y +38bp, and the 2s10s30s fly up 16bp to +15bp.
  - The 10y gilt–OIS spread narrowed 5bp to 45bp in Q3 and is now 48bp.

### Scenarios

**Weighted terminal ≈ 4.35% against ~4.88% priced: ~50bp too much hiking, with the skew in our favour. Scenarios 1 and 3 (70%) rally the front end, and the full cycle is mostly priced. The belly stays cheap except in a growth break.**

| Scenario | Prob. | Terminal | Front end | Belly | Triggers |
|---|---|---|---|---|---|
| 1. Gradual and short | 50% | 4.25% (Nov, Feb) | Rallies | Stays cheap | Oil stabilises; wages cool |
| 2. Full cycle | 25% | 4.75–5.00% | Flat to modest selloff | Cheapens; bear flattening | Hormuz stays shut; services and wages re-accelerate |
| 3. One and done | 20% | 3.75–4.00%; cuts H2 2027 | Rallies hard | Richens; bull steepening | US–Iran deal; unemployment rises |
| 4. Fiscal stress | 5% | ~4.50%, then pause | Volatile | Cheapens sharply | Headroom < £10bn; LDI-style selloff |

- *Weighted terminal:* 0.50 × 4.25 + 0.25 × 4.875 + 0.20 × 3.90 + 0.05 × 4.50 ≈ 4.35%.

### Trades

**Expected P&L is +£3.08m against £5.22m of max loss. The theme makes +£4.9m if the cycle is gradual and short, +£4.8m on one-and-done and +£2.4m under fiscal stress. It loses money in only one scenario, the full hiking cycle (−£1.9m), and Theme 2 is the hedge for it.**

| # | Trade | Entry | Target | Stop | R : R | Conv. | Size | Max loss | Exp. P&L |
|---|---|---|---|---|---|---|---|---|---|
| T1 | Receive SONIA 6m×1y | 4.76% | 4.35% | 5.06% | 1.4x | 4 | £66k/bp | £1.99m | +£1.58m |
| T2 | 6m×1y receiver spread, ATMF / −75bp | Premium ≤ 25bp | 75bp payout | Premium | ≥ 3x | 3 | £1.33m premium | £1.33m | +£719k |
| T3 | Long 3m×10y straddle | Implied ≤ 80bp | — | −40% premium; exit 26 Nov | Asym. | 2 | £663k premium | £663k | +£90k |
| T4 | 2s10s30s fly, short 10y vs 2y and 30y (50:100:50) | +15bp | +27bp | +7bp | 1.5x | 3 | £88k/bp | £708k | +£482k |
| T5 | 10y gilt–OIS widener | 48bp | 56bp | 42bp | 1.3x | 2 | £88k/bp | £531k | +£208k |
| | **Total** | | | | | | | **£5.22m** | **+£3.08m** |

| P&L by scenario (£k) | 1 (50%) | 2 (25%) | 3 (20%) | 4 (5%) |
|---|---|---|---|---|
| T1 | +2,721 | −1,461 | +2,721 | +729 |
| T2 | +1,114 | −1,327 | +2,653 | −743 |
| T3 | −50 | +25 | +375 | +662 |
| T4 | +884 | +442 | −619 | +1,061 |
| T5 | +265 | +442 | −354 | +708 |
| **Theme 1** | **+4,934** | **−1,879** | **+4,776** | **+2,417** |

- **T1:** Receives Apr-27 to Apr-28, where the terminal is priced. The stop sits above the Q3 peak forward (5.03%), ~4 daily standard deviations away (realised 7.5bp/day).
- **T2:** Holds the view through a hawkish November that would stop out T1. Notional is ~£550m at 25bp; above 25bp, scale up T1 instead.
- **T3:** Covers the Budget (28 Oct), MPC (5 Nov) and Ofgem cap (25 Nov), hedging scenarios 2 and 4. Buy only at or below realised vol (78bp); valued at the 26 Nov exit.
- **T4:** The fly is at +15bp (1y range −10 to +25bp) as Mediums rise and Longs shrink. The stop is ~3× daily realised vol.
- **T5:** Supply hasn't reached swap spreads yet (1y low 44bp). The catalyst is headroom below £10bn or a gilt-heavy remit.
- *Overlap:* T1, T2 and T4's 2y wing are one front-end bet.

---

## Theme 2: Inflation persistence, with domestic pressures re-accelerating (UK, euro area, G10)

### Current state of the theme

- **The common shock:**
  - Energy has lifted headline inflation across the G10, though not continuously: Brent fell back to $70 by end-June, then re-intensified in Q3 (dated $127 on 14 Oct).
  - The curve is steeply backwardated (Dec-26 ~$110, Dec-27 ~$87), so the market prices the shock fading.
  - Central banks are split. The Fed (3.75–4.00%), ECB (2.50%) and BoJ (1.25%) hiked in September; the BoE and BoC (2.25%) held.
  - Domestic pressures haven't clearly turned anywhere, with only tentative signs in the euro area and Japan.
- **UK:**
  - Not re-accelerating yet: services 3.4% (from 4.4% in January) and core 2.6%, both flat. DMP expectations are steady (1y 3.1%, 3y 2.8%, wages 3.4%).
  - The pipeline is building: CPI is seen above 4% in early 2027, the Ofgem cap is estimated at +22%, and hikes lift RPI through mortgage interest.
  - 3y RPI is 4.02%, 47bp below its March peak.
- **Euro area:**
  - The rise is in headline, not domestic, inflation. September HICP was 3.8% (energy +18.8%).
  - Services (3.2%) and core (2.5%) are only 20–30bp above their troughs, and one month of volatile data isn't a trend. Wages haven't responded.
  - The ECB sees inflation "well above target for an extended period," and Lagarde is uncommitted for 29 Oct.
  - Swaps price 1y1y inflation at ~2.3% and 5y5y at ~2.2% (ECB, 9 Sep).
- **Other G10:**
  - US PCE is 3.8%, against a 2.37% 5y breakeven that is 30bp below its March peak.
  - Japanese core CPI is expected above 2% for the first time since December.
  - Canada (CPI 3.0%, trimmed core 1.9%) is looking through.

### Scenarios

**Theme 2's scenarios turn on two questions: does the energy shock persist, and do second-round effects take hold, and where? Broad persistence is a 25% risk, but breakevens and the Brent curve price the shock fading. The euro area gets its own scenario because it has the widest headline–breakeven gap; that scenario requires its tentative services uptick to become a trend. The long end stays anchored (5y5y ~2.2% in EUR, ~3.1% in UK RPI), so all the trades sit in the front end.**

| Scenario | Prob. | Energy | Second-round effects | UK 3y RPI | EUR 1y1y infl. | US 5y BE | EUR − GBP 1y1y | Brent Dec-27 |
|---|---|---|---|---|---|---|---|---|
| A. Shock fades | 20% | Reverses (US–Iran deal) or demand destruction | None | 3.70% | 2.10% | 2.18% | −149bp | $72 |
| B. Contained plateau | 40% | Stays high; headline peaks early 2027 | Contained | 3.95% | 2.35% | 2.40% | −162bp | $93 |
| C. Euro-area-led | 15% | Stays high | Euro area only: services ≥ 3.3%, wages respond | 4.05% | 2.60% | 2.42% | −135bp | $93 |
| D. Broad persistence | 25% | Stays high, plus a winter gas spike | G10-wide: services, wages and expectations rise | 4.45% | 2.70% | 2.67% | −179bp | $104 |

- *Level anchors:* A = 1y lows; B = roughly flat plus carry; C = EUR closes half its gap to the March high; D = March 2026 highs.
- *Pairings with Theme 1:* A ↔ one-and-done, B and C ↔ gradual, D ↔ full cycle.
- *Key events:* Canada CPI (19 Oct), UK labour (20 Oct), UK CPI (21 Oct), BoC (28 Oct), ECB and BoJ (29 Oct), BoE DMP (30 Oct), euro area flash HICP, and the Ofgem cap (25 Nov).

### Trades

**Expected P&L is +£1.99m on £5.31m of max loss: +£7.37m in broad persistence, −£4.07m if the shock fades. Themes 1 + 2 together are +£5.07m expected and positive in every natural pairing: +£0.71m (A with one-and-done), +£6.09m (B with gradual), +£8.29m (C with gradual) and +£5.49m (D with the full cycle).**

| # | Trade | Entry | Target | Stop | R : R | Conv. | Size | Max loss | Exp. P&L |
|---|---|---|---|---|---|---|---|---|---|
| T6 | Long UK 3y zero-coupon RPI swap | 4.02% | 4.45% | 3.72% | 1.4x | 3 | £44k/bp | £1.33m | +£106k |
| T7 | Long US 5y breakeven (TIPS vs Treasuries) | 2.37% | 2.67% | 2.20% | 1.8x | 3 | £78k/bp | £1.33m | +£471k |
| T8 | Long EUR 1y1y HICPx inflation swap | ~2.30% (ECB, 9 Sep) | 2.70% | 2.10% | 2.0x | 2 | £33k/bp | £663k | +£414k |
| T9 | Pay EUR 1y1y vs receive SONIA 1y1y (EUR − GBP) | −169bp | −135bp | −192bp | 1.5x | 2 | £29k/bp each leg | £663k | +£270k |
| T10 | Long Brent Dec-27 future | $86.7 (16 Oct settle) | $102 | $77 | 1.6x | 3 | £137k per $1/bbl (~177 lots) | £1.33m | +£733k |
| | **Total** | | | | | | | **£5.31m** | **+£1.99m** |

| P&L by scenario (£k) | A (20%) | B (40%) | C (15%) | D (25%) |
|---|---|---|---|---|
| T6 | −1,327 | −311 | +134 | +1,903 |
| T7 | −1,323 | +233 | +389 | +2,335 |
| T8 | −665 | +166 | +994 | +1,327 |
| T9 | +577 | +202 | +980 | −290 |
| T10 | −1,327 | +863 | +863 | +2,094 |
| **Theme 2** | **−4,065** | **+1,153** | **+3,360** | **+7,369** |

- **T6:** UK persistence shows up first in the front end (Ofgem cap, RPI mortgage interest). The target is the March high. It avoids the long end because of RPI reform risk.
- **T7:** A 2.37% breakeven against 3.8% PCE carries positively. The stop is just above the 1y low (2.16%).
- **T8:** The widest gap in the G10 (3.8% headline vs ~2.3% priced). It rests on that gap, not on domestic data. Enter at or below 2.40%; move to conviction 3 if October services print ≥ 3.3%.
- **T9:** The ECB is priced for the least persistence (~70bp of hikes vs ~113bp BoE, ~90bp Fed). It wins in A–C and loses in D, where GBP's higher beta (8.0 vs 5.8bp/day) sells off harder. The stop sits beyond the 1y range (−182 to −119bp).
- **T10:** The curve prices a fast fade: Dec-27 is ~$40 below dated Brent. If energy stays high, roll-up toward spot (~$93) is the payoff and is included as carry. It stops out in A.
- *Not traded:* NOK (EURNOK already at its 1y low, 10.71); CAD (weak despite oil, USDCAD 1.427); Japan and Canada linkers (illiquid or non-existent).
- *Sizing:* T6, T7, T8 and T10 share one factor, energy (£4.64m combined max loss). T9 is a rates spread with lower energy correlation.
- *Levels:* BoE curves (UK, 15 Oct); FRED (US, 16 Oct); ECB (EUR inflation, 9 Sep; AAA curve for the EUR 1y1y, a government curve, so the €STR swap spread may differ slightly); press settlement (Brent, 16 Oct).

---

## Theme 3: Euro area fiscal crisis, with the political risk premium rising

### Current state of the theme

- **France is the epicentre:**
  - OAT–Bund 10y is 137bp (16 Oct), up from 59bp a year ago. It peaked at ~147bp in early October, the widest since 2012, and France now trades wider than Italy.
  - A €43–54bn 2027 consolidation faces a parliament with no stable majority: the revenue vote is on 20 Oct and the final vote ~17 Nov.
  - The deficit is ~5% of GDP in 2027, and the presidential election is due in spring 2027.
- **Ratings:** Moody's Aa3 negative (review 23 Oct); S&P A+ stable (review 27 Nov). Fitch warned on 9 Oct; Scope cut to A+ on 18 Sep; DBRS is on negative outlook.
- **Contagion is limited so far:** Italy is 107bp (peak 131bp on 2 Oct) and Belgium 65bp (from 55bp). Spain is flat at ~45bp. Bunds are the safe haven (10y 3.49%, 19 Oct).
- **Backdrop:**
  - Energy and defence spending (+0.65pp of GDP in 2026, +0.9pp in 2027) are eroding fiscal space.
  - The ECB is hiking and running down its bond holdings, so private buyers absorb more supply.

### Scenarios

**Much of the premium rise has already happened: OAT–Bund has more than doubled in a year. The base case is a grind wider into the spring 2027 election, not a crisis. So the trades lean on relative value (France against Spain) and convexity (Bund calls), with only a small outright widener. The calls pay in a crisis and also when the energy shock fades, Theme 2's worst scenario.**

| Scenario | Prob. | What happens | OAT–Bund | France–Spain 10y | Bund 10y |
|---|---|---|---|---|---|
| A. Muddle through | 25% | Budget passes in some form; ratings hold | 105bp | 75bp | 3.55% |
| B. Grind wider | 40% | Budget forced through or delayed; a downgrade; election premium builds | 150bp | 100bp | 3.40% |
| C. Crisis | 15% | Government falls or budget fails; contagion to Italy and Belgium; TPI untested under an excessive-deficit procedure | 190bp | 120bp | 3.10% |
| D. Shock fades | 20% | Energy reverses; ECB hikes priced out; spreads compress | 95bp | 72bp | 3.15% |

- *Signposts:* French revenue vote (20 Oct), Moody's (23 Oct), ECB (29 Oct), final budget vote (~17 Nov), S&P (27 Nov), Italian spreads, and 2027 candidate polling.

### Trades

**Expected P&L is +£0.70m on £2.65m of max loss, with a convex profile: +£5.75m in a crisis, +£1.86m if the shock fades, +£0.20m on the grind wider and −£2.43m if France muddles through. The Bund call spread (T13) carries the theme.**

| # | Trade | Entry | Target | Stop | R : R | Conv. | Size | Max loss | Exp. P&L |
|---|---|---|---|---|---|---|---|---|---|
| T11 | OAT–Bund 10y widener | 137bp | 175bp | 118bp | 2.0x | 2 | £35k/bp | £663k | +£81k |
| T12 | Short 10y OAT vs long 10y Bonos (DV01-neutral) | ~85bp | 115bp | 70bp | 2.0x | 2 | £44k/bp | £663k | +£240k |
| T13 | 6m Bund future call spread (≈ 3.42% / 3.20% yield) | Premium ≤ 30% of max payout | Max payout £4.42m | Premium | ≥ 2.3x | 3 | £1.33m premium | £1.33m | +£382k |
| | **Total** | | | | | | | **£2.65m** | **+£703k** |

| P&L by scenario (£k) | A (25%) | B (40%) | C (15%) | D (20%) |
|---|---|---|---|---|
| T11 | −665 | +453 | +1,327 | −665 |
| T12 | −442 | +665 | +1,327 | −573 |
| T13 | −1,327 | −923 | +3,096 | +3,096 |
| **Theme 3** | **−2,434** | **+195** | **+5,750** | **+1,858** |

- **T11:** The direct expression, kept small because the spread is near its highs. Add on any retracement towards 120bp before the ratings reviews.
- **T12:** Isolates the French premium from contagion and the Bund bid; Spain has held at ~45bp while France doubled. The entry is estimated from ECB September averages plus October moves.
- **T13:** Pays below 3.42% on the Bund, in full at 3.20%, in a crisis or when the shock fades. Buy only if the premium is ≤ 30% of the max payout.
- *Not traded:* Italy (we'd rather be short France); EUR downside as a cross-asset overlay.
- *Levels:* Press reports (16 Oct) and ECB monthly long-term rates (to September).

---

## Theme 4: Euro area fiscal and growth revival (German fiscal expansion, rotation out of the US, Ukraine resolution)

### Current state of the theme

- **Where it stands:**
  - This was 2025's story; the energy shock put it on hold in 2026, and the market has given up on it.
  - EURUSD is at its 1y low (1.119, from 1.198 in January). The Bund curve is flat (2s10s 39bp) because the ECB is hiking into an energy shock.
- **German fiscal:**
  - The impulse is real: record borrowing of €512bn in 2026 (€318bn of bonds), and the Bundesbank sees ~1.3pp of GDP of defence and infrastructure impulse through 2028.
  - In October, Nagel saw ~1% growth this year, double June's 0.5%.
  - The 2027 issuance plan comes in December.
- **Rotation out of the US:**
  - It has stalled. Euro equity ETFs saw outflows from late February until July.
  - The Stoxx 600's discount to the S&P is the smallest in four years.
  - A 161bp UST–Bund 10y spread (5.10% vs 3.49%) pulls money back to the US.
- **Ukraine:** Talks, but no deal. The US has proposed trilateral talks by end-October. The 11 Oct "energy ceasefire" Trump announced is unconfirmed by either side, and strikes have escalated.
- **Bund curve (19 Oct):** 2y 3.10%, 10y 3.49% (a 17-year high), 30y 3.88%. 5s30s is 68bp (1y range 56–124bp), having flattened 27bp in Q3 despite record long-end supply.

### Scenarios

**A revival is a 25% scenario, but pricing treats it as close to zero. The curve flattened and EUR fell for cyclical reasons (energy and the ECB), not because the fiscal story died, so the payoff is asymmetric. A Ukraine deal is a 10% tail that lifts EUR and steepens the curve.**

| Scenario | Prob. | Growth and flows | ECB | EURUSD | Bund 5s30s | Triggers |
|---|---|---|---|---|---|---|
| A. Revival takes hold | 25% | German GDP > 1%; inflows return | Hikes; the long end leads on term premium and supply | 1.20 | 85bp | Oil stabilises; a large 2027 Bund plan; Fed cuts |
| B. Slow burn | 40% | Spending lands slowly; energy offsets it | On hold at 2.50% | 1.13 | 72bp | Status quo |
| C. Derailed | 25% | Energy deepens; French crisis; US exceptionalism returns | Hikes into weakness; bear flattening | 1.08 | 58bp | Hormuz stays shut; French downgrade; UST > 5.25% |
| D. Peace dividend | 10% | Ukraine deal; gas falls; reconstruction | Hikes priced out; bull steepening | 1.17 | 95bp | Durable ceasefire |

- *Signposts:* Ukraine talks (end-October), ECB (29 Oct), German Q3 GDP, the 2027 Bund plan (December), and weekly euro equity flows.

### Trades

**Expected P&L is +£1.45m on £1.99m of max loss: +£6.06m if the revival takes hold, +£4.59m on a peace dividend, −£0.26m on the slow burn and −£1.68m if derailed. Themes 2 and 3 pay when energy or politics go wrong; Theme 4 pays when they don't.**

| # | Trade | Entry | Target | Stop | R : R | Conv. | Size | Max loss | Exp. P&L |
|---|---|---|---|---|---|---|---|---|---|
| T14 | Bund 5s30s steepener (DV01-neutral) | 68bp | 95bp | 55bp | 2.1x | 3 | £102k/bp | £1.33m | +£617k |
| T15 | 6m EURUSD call spread, 1.14 / 1.20 | Premium ≤ 80 pips (model, 6.5% vol) | Max payout ~7.5× premium | Premium | ~7.5x | 2 | £663k premium | £663k | +£833k |
| | **Total** | | | | | | | **£1.99m** | **+£1.45m** |

| P&L by scenario (£k) | A (25%) | B (40%) | C (25%) | D (10%) |
|---|---|---|---|---|
| T14 | +1,734 | +407 | −1,019 | +2,756 |
| T15 | +4,327 | −665 | −665 | +1,833 |
| **Theme 4** | **+6,061** | **−258** | **−1,684** | **+4,589** |

- **T14:** Record Bund supply meets a curve that has flattened from 124bp to 68bp. It loses only in C. The stop is below the 1y low (56bp), ~5× daily realised vol.
- **T15:** Options are cheaper than spot: realised vol is 5.0% and spot carries negatively (6m forward ~1.110). The 1.20 cap is January's high. Buy only at or below 80 pips; valued at expiry.
- *Not traded:* Europe vs US equities (an equity-book trade); PLN and Ukraine reconstruction (a 10% tail that T14 and T15 already cover).
- *Levels:* Bundesbank curve (19 Oct); FRED (EURUSD 9 Oct, UST 15 Oct).

---

## Theme 5: The AI bubble bursts

### Current state of the theme

- **Where it stands:**
  - Markets are priced as if nothing can go wrong: the Nasdaq is 3% off its 6 Oct record (26,713), VIX is 16.5 and IG spreads are 84bp (1y range 73–94bp).
  - That is despite 5.10% 10y Treasuries, $127 Brent and a hiking Fed. AI drove ~80% of US equity gains in 2025.
- **Capex:**
  - Nvidia sees hyperscaler capex near $800bn in 2026 and ~$1.3trn in 2027. Amazon, Alphabet and Microsoft are spending ~102% of cloud revenue on it.
  - A burst needs a capex cut; late-October earnings are the next test.
- **Debt is where the cracks are:**
  - AI-related issuance is ~$500bn so far this year (Goldman), four times last year's pace.
  - Hyperscaler bond order books fell from ~5× covered in February to under 2× in July (Apollo).
  - ~$660bn of data-centre leases sits off balance sheet (Moody's), much of it financed by private credit. The market is questioning the speculative names (CoreWeave).
- **Macro link:** The 2y (4.77%) sits ~90bp above SOFR, so hikes are priced; a December hike is the median dot. A burst flips that to cuts. The Nasdaq already trades against the 2y (6m correlation −0.38).

### Scenarios

**A burst is a 20% risk (C + D) over six months, but pricing treats it as remote. Credit is the weak link because the buildout is debt-funded, not because AI demand has peaked. The Fed's response turns an equity event into a rates trade.**

| Scenario | Prob. | Trigger | Nasdaq | US 2y | IG OAS | Fed |
|---|---|---|---|---|---|---|
| A. Boom continues | 45% | Capex guided higher; earnings beat | +10% | 4.95% | 80bp | Hikes in December |
| B. Correction | 35% | Capex digestion; rates and energy bite | −10% | 4.55% | 95bp | Pauses |
| C. Burst | 15% | A hyperscaler cuts capex | −30% | 3.80% | 140bp | Cuts by Q1 2027 |
| D. Burst, with a credit event | 5% | A data-centre financing fails | −40% | 3.40% | 190bp | Cuts aggressively |

- *Signposts:* Hyperscaler earnings and capex guidance (late October), Nvidia earnings (November), FOMC (28 Oct, 9 Dec), hyperscaler bond order books, CoreWeave funding, and private-credit redemptions.

### Trades

**Expected P&L is +£2.78m on £3.32m of max loss: +£14.81m in a burst (all three trades hit their targets), +£2.56m in a correction and −£2.40m if the boom continues. The theme pays in the growth shock that hits Themes 2 and 4, at the cost of the most likely scenario.**

| # | Trade | Entry | Target | Stop | R : R | Conv. | Size | Max loss | Exp. P&L |
|---|---|---|---|---|---|---|---|---|---|
| T16 | Receive US 2y (long 2y Treasury) | 4.77% | 3.90% | 5.05% | 3.1x | 3 | £47k/bp | £1.33m | +£806k |
| T17 | 6m Nasdaq 100 put spread, 95% / 75% | Premium ≤ 3.0% of spot (model, 21% vol) | Max payout ~6.7× premium | Premium | ~6.7x | 3 | £1.33m premium | £1.33m | +£1.24m |
| T18 | Buy 5y CDX IG protection | 84bp (ICE BofA IG OAS) | 140bp | 72bp | 4.7x | 2 | £55k/bp | £663k | +£733k |
| | **Total** | | | | | | | **£3.32m** | **+£2.78m** |

| P&L by scenario (£k) | A (45%) | B (35%) | C (15%) | D (5%) |
|---|---|---|---|---|
| T16 | −853 | +1,044 | +4,122 | +4,122 |
| T17 | −1,327 | +906 | +7,596 | +7,596 |
| T18 | −219 | +609 | +3,096 | +3,096 |
| **Theme 5** | **−2,399** | **+2,559** | **+14,814** | **+14,814** |

- **T16:** ~90bp of hikes priced gives the front end the most to reprice. The stop sits above the 1y high (4.92%), ~5× daily realised vol. It is also hurt by Theme 2's broad persistence.
- **T17:** The burst trade itself, cheap with VIX at 16. It pays a quarter of its max in a 10% correction. Buy only at or below 3.0% of spot; notional ~£45m, valued at expiry.
- **T18:** Spreads are near their tights with record AI issuance ahead. Levels use the ICE BofA IG OAS as a proxy; the target and stop scale with CDX at execution.
- *Not traded:* JPY (−3.5% annual carry; hasn't tracked equities in 2026); TWD and KRW (outside this book).
- *Levels:* FRED (15–16 Oct).
