---
name: regime-playbook
description: Market regime definitions and what tends to work in each.
---

# Regime playbook

Classify the current regime on two axes: growth (accelerating / slowing) and inflation (rising / falling), plus a stress overlay.

| Regime | Rates | Curve | FX | Risk |
|---|---|---|---|---|
| Reflation (growth up, inflation up) | higher | steeper | commodity FX up | equities up, bonds down |
| Goldilocks (growth up, inflation down) | stable | mixed | carry works | broad risk-on |
| Stagflation (growth down, inflation up) | front end up | flatter | USD, CHF up | equities and bonds both down |
| Disinflationary slowdown (growth down, inflation down) | lower | bull steepening | JPY, CHF up | duration hedges equities |
| Stress overlay | front end down sharply | steeper | safe havens up | correlations go to one |

- Confirm the regime with several signals (macro factors, `correlation_regimes`, equity–bond correlation), not one.
- Regime changes are when historical relationships and backtests fail; say so when you see one.

Output: the current regime with confidence, signs of transition, and which pod ideas fit or fight it.
