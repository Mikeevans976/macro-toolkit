---
name: sizing-framework
description: How conviction and risk budget translate into trade size.
---

# Sizing framework

1. **Risk budget per trade:** start from the maximum loss at the stop. Default ladder by conviction (adjust to the PM's budget):
   conviction 2 → 25% of the single-trade limit; 3 → 50%; 4 → 75%; 5 → 100%.
2. **Red Team adjustment:** `proceed-smaller` halves the size; `rework` means no size.
3. **Stop distance:** use the invalidation level, not an arbitrary number. `sizing_engine` with method 'stop' gives P&L per bp.
4. **Cross-check with vol:** method 'vol' with recent daily vol; if the two sizes differ a lot, the stop is probably too tight or too wide.
5. **Book context:** run `risk_engine` with the trade included; reduce size if it adds to an existing concentration.
6. **Record:** `advance_trade(action='size')` with pnl_per_bp_k (sign convention: negative = gains when yields fall) and max_loss_k, and explain the steps in the note.
