---
name: positioning-interpretation
description: How to read positioning and flow data without over-reading it.
---

# Positioning interpretation

- **CFTC COT:** weekly, published with a lag; leveraged funds and asset managers often disagree. Use extremes (percentile over several years), not levels.
- **Trend followers (CTAs):** model positions from trend signals (`cta_momentum`). Identify the levels where signals flip; those are where forced buying or selling begins.
- **Futures positioning by contract** (`euribor_positioning`): where along the strip positions are concentrated, and whether they are moving.
- **Crowding score:** combine extremity of positioning, consensus in surveys and research, and recent one-way flows.
- **Use:** positioning tells you about the *path and asymmetry* of a move, not its direction. A crowded trade can keep working until a catalyst.

Output: which trades are crowded, the trigger levels for systematic flows, and how that changes the risk/reward of the pod's ideas.
