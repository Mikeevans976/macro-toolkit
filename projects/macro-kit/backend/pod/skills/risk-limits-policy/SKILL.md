---
name: risk-limits-policy
description: The pod's risk limits and how the CRO applies them.
---

# Risk limits policy

Limits live in `backend/pod/limits.yaml` and are reported by `risk_engine`. **If `limits_are_placeholders` is true, say so prominently: the PM has not set real limits yet.**

## Limits
- |P&L per bp| per tenor bucket and in total (rate risk).
- Worst loss across the parametric scenarios (`scenario_library`).
- Maximum loss at the stop for any single trade.
- Maximum number of live trades.

## How to apply them
1. Run `risk_engine` with the trade under review included (`include_trade_ids`).
2. Any breach → `risk_block`, unless the trade *reduces* an existing breach.
3. No breach but the worst scenario uses more than 75% of the limit → approve only with a smaller size, stated in the note.
4. Check concentration: several ideas sharing one factor (e.g. all long duration) count as one bet.
5. Check the Red Team verdict: `proceed-smaller` must be reflected in the size.

## Escalation
Raise a `critical` alert for any breach in the live book, and a `warning` when usage exceeds 75% of a limit.
