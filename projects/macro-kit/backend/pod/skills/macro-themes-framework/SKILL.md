---
name: macro-themes-framework
description: How the pod identifies, tracks, scenario-maps, trades and risk-manages its macro themes.
---

# Macro themes framework

A theme is a macro narrative the pod expects to play out over 3–12 months that markets misprice. The book holds five to eight themes; each trade belongs to one.

## 1. Identifying a theme

A candidate needs all four:

- **A mechanism:** cause → macro outcome → market outcome, in two or three links.
- **A pricing gap:** what is priced (forwards, OIS, options, consensus) against what the pod expects, in numbers.
- **Catalysts** within the horizon that force the market to reprice.
- **Expressions:** at least one liquid trade with good payoff asymmetry.

Retire a theme when the gap has closed (priced in), the mechanism is broken, or nothing will force a repricing within the horizon.

## 2. Tracking a theme

For each theme keep a scorecard:

| Check | How |
|---|---|
| Price confirmation | The 3–6 markets that should move with the theme (rates, FX, commodities, equities, credit): direction and size of moves since the theme was set, against what the scenarios imply. Note which markets disagree |
| Data confirmation | Releases and surprises since the theme was set: for or against the mechanism |
| Sell-side | research_search / research_calls: who agrees, who changed their call, the consensus. Consensus moving towards the theme means the gap is closing |
| Positioning | cta_momentum and positioning: is the theme crowded? |
| Signposts | Each scenario's signposts: which have been hit |

Verdict per theme: **on track** (prices and data confirm), **drifting** (mixed, or the move has run ahead of the data), **broken** (mechanism contradicted or invalidation hit). Prices confirming while the data do not is a warning, not a confirmation.

## 3. Scenarios and probabilities

- Three to five scenarios, mutually exclusive, probabilities summing to exactly 1.
- Each scenario: name, trigger, the policy rate or macro path, end-of-horizon levels for the key markets, and signposts that would raise its probability.
- Anchor probabilities on base rates and on what options price; move away from the market only with a stated reason.
- Include a low-probability tail scenario when it would dominate P&L (e.g. fiscal stress).
- Update probabilities in steps after signposts, not continuously; record why each changed.

## 4. From theme to trades

- For each candidate trade, compute P&L in every scenario of its theme (capped at the target, floored at the stop; options at expiry), the max loss, and the expected P&L (probability-weighted). Use the same units as `trade_themes` (£k).
- Prefer trades that make money in the likely scenarios and lose little in the others. Compare linear and option expressions (ask the volatility strategists).
- Two or three trades per theme at most; each must add something the others don't (a different scenario paid, better carry, a hedge).
- Every trade needs entry, target, stop and invalidation, and goes through the ledger gates.

## 5. Portfolio risk across themes

- **Interactions:** for each pair of themes, the shared factor and whether they pay in the same states. Note designed offsets.
- **Worst joint combination:** the natural combination of scenarios across themes that loses most; size so it stays within the loss budget.
- **Risk usage per theme:** max loss and risk_engine exposure per theme; no single theme should dominate unless its conviction is highest.
- **Concentration:** themes that are the same bet in different clothes (e.g. all short dollar) count as one.
- **Actions:** resize, hedge or exit; say which and why. The CRO's limits are binding.

## Output

1. Theme scorecard table: theme, verdict, what changed, probability changes.
2. Per theme: scenarios with probabilities, the trades with scenario P&L, expected P&L and max loss.
3. New and retired themes.
4. Portfolio: interactions, worst combination, risk by theme, recommended actions.
5. Exact edits for `trade_themes.json` if anything should change.
