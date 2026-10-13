---
name: stress-scenario-library
description: How to use and extend the pod's stress scenarios.
---

# Stress scenario library

`scenario_library` holds hypothetical parametric shocks by tenor bucket (parallel, steepeners, flatteners, front-end repricing, term-premium shock). They are not historical replays.

## Using them
- Report the P&L of the book in each scenario, the worst one, and which trades drive it.
- Ask which scenario is *most plausible* given the house view, not only which is worst.

## Historical episodes to reason about (describe qualitatively; do not invent bp numbers)
- 2013 taper tantrum: long-end sell-off on Fed balance-sheet guidance.
- March 2020: dash for cash; correlations broke and liquidity vanished.
- 2022 UK gilt / LDI episode: forced selling of long gilts.
- March 2023 US regional bank stress: sharp front-end rally and repricing of the policy path.
- August 2024 yen carry unwind: FX and equity volatility spike.

When Bloomberg is connected, historical moves can be measured from data; until then, never state historical bp moves as facts.
