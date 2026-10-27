---
name: strategy-backtest-protocol
description: How to backtest a specific trade or a trading strategy, and how to report it.
---

# Strategy backtest protocol

## 1. Write the rule down first

Before looking at results: universe, signal, entry, exit (target, stop, time stop), sizing, rebalancing, and the instrument actually traded. A rule changed after seeing results counts as a new trial (backtest hygiene, multiple testing).

## 2. Data and implementation

- **Information:** signals use only data known at the decision time (close-to-next-close at the earliest; releases from their release time; real-time vintages for macro data).
- **Instruments:** trade what the pod would trade (futures with rolls, swaps with carry and roll-down, bonds with repo, options with premium and decay), not an index level.
- **Costs:** bid-offer per trade and per roll, from the execution playbook; double them as a stress.
- **Carry and roll:** include them; split P&L into price, carry/roll and costs.
- **Sizing:** constant DV01 or constant vol; state which.

## 3. Testing a specific trade idea

For a proposed trade (entry, target, stop, horizon):
- find historical analogues with the same signal conditions (z-score, regime, macro set-up), non-overlapping;
- report the distribution of outcomes: share hitting the target first, the stop first, or neither by the horizon; average time to each; P&L at the horizon;
- compare with the unconditional distribution (any entry date): the edge is the difference.

## 4. Testing a strategy

- In-sample / out-of-sample split decided in advance, or walk-forward.
- Report: annualised return and vol, Sharpe, max drawdown and its length, hit rate, average win/loss, skew, turnover, number of independent trades.
- **Robustness:** a parameter grid around the chosen values (a robust rule degrades smoothly), sub-periods, other markets, costs doubled.
- **Deflated Sharpe:** adjust for the number of variants tried.
- **Regimes:** results by regime (hiking/cutting cycle, high/low vol, risk-on/off); say what the current regime looks like historically.
- **Crowding:** whether the rule is a known factor (trend, carry, value) and how crowded it is now.

## 5. Tools

`seasonality` (calendar rules), `mean_reversion` (OU half-life, forward distributions), `cta_momentum` (trend), `swaps_rv` / `egb_rv` (RV z-scores), `correlation_pair`; anything else in `python_sandbox` with the series you have, stating the data source. If the history needed is not available, say so rather than approximate silently.

## Output

The rule, data and costs; results table (in and out of sample); robustness; regime split; verdict (**robust / fragile / reject**) with the sizing it supports; and what the backtest cannot tell you.
