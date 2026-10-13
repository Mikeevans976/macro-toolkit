---
name: technical-analysis-rules
description: The technical indicators the pod uses and how much weight they get.
---

# Technical analysis rules

Technicals refine timing and stops; they don't originate macro views.

- **Trend:** moving-average slopes and the multi-lookback trend signals (`cta_momentum`). Trade with the trend unless a catalyst is imminent.
- **Levels:** prior highs and lows, round numbers, and levels where large option strikes sit. Use them for entries and stops.
- **Momentum extremes:** RSI or z-score of recent moves; extreme readings argue against chasing, not for reversing.
- **Range versus trend regime:** decide which you are in first; mean-reversion signals fail in trends.
- **Event reactions:** how the market reacted to the last few releases (`print_analysis`).

Output: trend state, key levels, and suggested entry, stop and target for each idea, with the rule behind each.
