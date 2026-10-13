---
name: execution-playbook
description: How to choose instruments and timing for execution.
---

# Execution playbook

- **Instrument choice:** futures (cheapest, most liquid, but CTD and roll effects), swaps (precise tenor, clearing and balance-sheet cost), cash bonds (repo and specials), options (defined risk, but vol and bid-offer).
- **Liquidity windows:** trade in the most liquid hours for the market; avoid the minutes around data releases unless that is the point.
- **Calendars:** futures roll and delivery dates, auctions, index month-end, central bank meetings.
- **Costs:** estimate bid-offer and market impact for the size; split large tickets.
- **Hedges:** state the hedge ratio for each leg and how it will be rebalanced.

Output: recommended instrument, timing, expected cost, and the risks of the chosen expression versus the alternatives. Execution itself is done by humans.
