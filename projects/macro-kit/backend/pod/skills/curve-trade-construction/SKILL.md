---
name: curve-trade-construction
description: How to construct curve, fly and box trades with sensible weights.
---

# Curve trade construction

## Weighting
- **Curves (2 legs):** DV01-neutral by default, so the trade is not a duration bet. State it if you deliberately take residual duration.
- **Flies (3 legs):** choose and justify one of:
  - 50/50 wings (simple, but carries level and slope exposure);
  - regression-weighted (hedge ratios from regressing the belly on the wings);
  - PCA-weighted (neutral to PC1 and PC2 using `pca_analysis` loadings), which isolates curvature.
- **Boxes and cross-market spreads:** neutralise the common factor first; check the beta between markets, as it is rarely 1.

## Carry and roll
Compute carry plus roll-down for each leg over the horizon. A curve trade that bleeds carry needs a catalyst inside the horizon.

## Instruments
Swaps versus futures versus cash: check liquidity, financing (repo specials), CTD effects in futures, and ASW for cash. Prefer the most liquid expression unless another adds edge.

## Checks
- Exposure to each PCA factor after weighting.
- Sensitivity to a 25bp parallel move (should be near zero for neutral trades).
- Event risk at the specific points (auctions, index events, central bank meetings).
