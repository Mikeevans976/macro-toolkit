---
name: inflation-seasonality
description: How to read inflation fixings, seasonality and linker carry.
---

# Inflation seasonality and fixings

- **Think in index levels.** YoY rates mix this month's change with the base twelve months ago. Decompose a YoY move into the new month-on-month change and the base effect dropping out.
- **Seasonal patterns:** non-seasonally-adjusted indices (HICP, RPI, CPI) have strong monthly patterns: sales periods, energy tariffs, administered prices, tax changes. Compare a month's NSA change with its own history, not with other months.
- **Energy:** model energy pass-through from oil and gas futures; it dominates short-dated fixings.
- **Fixings markets:** compare swap-implied fixings (`inflation_fixings`) with your bottom-up estimate month by month; the edge is usually in one or two specific months.
- **Linker carry:** carry on linkers depends on the expected index accrual over the holding period, so seasonality creates predictable carry patterns.
- **Fair value:** use `fair_value_models` for breakevens versus drivers (energy, real yields, risk appetite); `inflation_pca` for curve shape.

## Output
Per market: next three fixings (your estimate versus implied), where the market is wrong, and whether it is genuine surprise or calendar noise.
