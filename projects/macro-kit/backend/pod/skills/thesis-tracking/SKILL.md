---
name: thesis-tracking
description: How to monitor live trades and decide when a thesis is broken.
---

# Thesis tracking

For each live or approved trade (`list_trades`):
1. Re-read the thesis, catalysts, invalidation and the Red Team's kill criteria.
2. Check each against current data and news (web sources and the analytics tools).
3. Classify: **intact**, **weakening** (a supporting pillar has gone, but no trigger hit), or **broken** (invalidation or kill criteria hit).
4. Upcoming catalysts in the next two weeks and how they could change the classification.

## Actions
- Intact: `trade_note` with the evidence.
- Weakening: `trade_note` plus a `warning` alert.
- Broken: `critical` alert naming the trigger that was hit. Closing a trade is the PM's decision.
