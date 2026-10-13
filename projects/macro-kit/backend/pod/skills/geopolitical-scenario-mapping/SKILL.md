---
name: geopolitical-scenario-mapping
description: How to turn a geopolitical or policy event into market scenarios.
---

# Geopolitical scenario mapping

1. **Define the event** and its decision points (dates, actors, thresholds).
2. **Scenario tree:** two to four mutually exclusive outcomes with rough probabilities that sum to 100%. Avoid a "status quo" bucket that hides most of the probability.
3. **Transmission:** for each outcome, map the channels: energy and commodity prices, trade and tariffs, risk appetite, fiscal response, central bank response, safe-haven flows.
4. **Market impact:** direction and rough size for the pod's markets (rates by curve point, FX, spreads, vol).
5. **What's priced:** use `option_implied_cdf` and option skews, plus prediction markets and polling where available, to estimate the probability the market assigns.
6. **Trade:** the outcome where your probability differs most from the market's, and the cheapest asymmetric expression (often options).

Be explicit about uncertainty; geopolitical probabilities are judgements, not measurements.
