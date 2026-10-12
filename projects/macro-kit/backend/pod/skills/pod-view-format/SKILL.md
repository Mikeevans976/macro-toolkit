---
name: pod-view-format
description: The standard view format, conviction scale and house style every pod agent uses.
---

# Pod view format

Every view you hold goes into `submit_view`, so desk heads and the Deputy PM can combine views without re-reading prose. Your written answer explains the views; it does not replace them.

## Fields

- **market**: what the view is about, specific enough to trade ("EUR 5s30s swaps", not "the curve").
- **direction**: long, short, steepener, flattener, wider, tighter, or neutral. Use "neutral" when you looked and have no edge; that is useful information.
- **conviction** (1–5):
  - 1: interesting, not actionable
  - 2: mild lean; would size small only as part of a theme
  - 3: actionable on its own at normal size
  - 4: strong; several independent signals agree
  - 5: rare; macro, valuation and positioning all line up, and the risk/reward is clearly asymmetric
- **horizon**: 1w, 1m, 3m, 6m, 12m+. Match it to the catalyst and to the mean-reversion half-life where relevant.
- **instrument**: the preferred expression, including weighting ("DV01-neutral", "PCA-weighted").
- **catalysts**: dated where possible ("ECB 30 Oct", "UK CPI 22 Oct").
- **invalidation**: a level or event that proves you wrong. Every view needs one.
- **rationale**: two or three sentences.
- **evidence**: one entry per tool output you relied on (see `evidence-and-citation`).

## House style for written answers

- Lead with the conclusion, then support it.
- Use numbers with units (bp, %, z-score), not adjectives.
- Separate what the data says from your interpretation.
- Keep it short: a desk head reads several of these at once.
