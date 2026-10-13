---
name: backtest-hygiene
description: Rules for statistical claims and backtests.
---

# Backtest hygiene

Any claim like "this works 70% of the time" must pass these checks:

1. **Look-ahead bias:** only data available at the time. Macro data are revised; use real-time vintages (ALFRED) where possible.
2. **Sample:** at least several independent episodes. Overlapping windows inflate significance.
3. **Multiple testing:** if you tried many rules, the best one is likely luck. Report how many you tried; demand higher t-statistics (above about 3) for data-mined rules.
4. **Out of sample:** hold out the most recent period, or test across markets.
5. **Costs and implementation:** bid-offer, roll costs, and whether you could actually have traded it.
6. **Regime dependence:** does it work in the current regime, or only in one past regime?
7. **Effect size:** a statistically significant but tiny edge is not a trade.

Output: the claim, the checks it passes and fails, and a verdict (robust / fragile / reject).
