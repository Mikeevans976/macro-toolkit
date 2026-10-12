---
name: evidence-and-citation
description: How to cite data, check freshness, and treat simulated data.
---

# Evidence and citation

## Cite every number

Each number in your answer must come from a tool output in this run, a web source you fetched, or another agent's submitted view. Say which: "(swaps_rv, as of 2026-10-08)". If you are estimating, say so.

## Check the data source

Many tool outputs carry `data_source` and `as_of` fields.

- **`data_source` is "simulation" (or similar):** the analytics fell back to synthetic data because Bloomberg is not connected. You may still describe the method, but **do not present simulated levels as market facts**, and do not give conviction above 2 to a view resting on simulated data. State it plainly at the top of your answer: "Note: tool data is simulated."
- **Stale data:** if `as_of` is more than 2 business days old for market data, or more than one release behind for macro data, say so and lower conviction.

## Disagreements

If two sources disagree (for example, a tool level and a web article), report both and say which you trust and why. Don't silently pick one.

## Web sources

Prefer primary sources: central bank sites, statistics offices, debt management offices. Note the publication date.
