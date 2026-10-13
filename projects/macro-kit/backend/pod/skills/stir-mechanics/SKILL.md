---
name: stir-mechanics
description: Mechanics of short-rate markets: futures, OIS and meeting pricing.
---

# STIR mechanics

- **Meeting-by-meeting pricing:** derive the implied policy rate after each meeting from OIS or meeting-dated swaps. Report it as bp of change and as probability of a move.
- **Futures:** price = 100 − implied rate. Contracts settle on quarterly IMM dates; reference period mismatch versus meeting dates matters.
- **Convexity:** futures versus forward rates differ by a convexity adjustment that grows with maturity and volatility; small in the first year, material further out.
- **Turn and quarter-end effects:** year-end and quarter-end funding pressure can distort short tenors and fixing spreads.
- **Basis:** Euribor versus €STR (a term credit and liquidity premium), SOFR versus Fed funds. Basis moves can masquerade as policy repricing.
- **Positioning:** use `euribor_positioning` to see where speculative positions concentrate along the strip; crowded points react more to surprises.

## Output
Pricing for the next three meetings, your probabilities, the cheapest expression of disagreement (outright, spread between meetings, or options), and the risk events in between.
