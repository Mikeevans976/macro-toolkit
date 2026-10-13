---
name: data-quality-rules
description: Thresholds and checks the Data Quality Sentinel applies.
---

# Data quality rules

- **Simulated data:** any tool returning a simulated `data_source` is flagged. While Bloomberg is disconnected, everything is simulated; say this once at the top rather than per tool.
- **Staleness:** market data older than 2 business days → stale. Macro data more than one release behind → stale.
- **Failures:** any tool that errors is reported with its error.
- **Outliers:** daily moves above 5 standard deviations, or values outside historical ranges, are flagged for a human to check before anyone trades on them.
- **Escalation:** `warning` alert for stale or failing core tools (swaps_rv, egb_rv, inflation_fixings, macro_factors); `critical` only if data are wrong in a way that could lead to a bad trade.

Output: a table from `data_health`, with the action needed for each problem.
