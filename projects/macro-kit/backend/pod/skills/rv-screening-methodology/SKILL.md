---
name: rv-screening-methodology
description: How to screen curve, fly and spread RV so z-scores don't mislead.
---

# RV screening methodology

A z-score alone is not a trade. Screen in this order.

1. **Extremes.** Start with |z-score| ≥ 1.5 on the 1y window (`swaps_rv`, `egb_rv`). Check the percentile agrees.
2. **Carry and roll.** The structure must carry in your favour, or the expected mean reversion must clearly exceed the carry cost over the horizon. Prefer a carry/vol ratio above about 0.3.
3. **Mean-reversion speed.** Use `mean_reversion` on the expression. A half-life longer than your horizon means the z-score will probably still be extreme when you need to exit. Horizon should be at least the half-life.
4. **Is the factor driving it?** Use `pca_analysis`. If the "cheap" fly is really a PC1/PC2 move, express that view directly instead, or weight the fly so it is neutral to those factors.
5. **Structural reasons** (the most common reason screens fail):
   - supply: auctions, syndications, DMO remit changes
   - CTD and delivery effects in futures-linked points
   - index extension at month end
   - ratings events and ECB eligibility for sovereigns
   - central bank buying or QT concentrated in specific maturities
   - new issues trading cheap to the fitted curve (`fitted_bond_curves`)
6. **Regime.** If `correlation_regimes` shows a break involving the legs, history may not be a guide.

## Weighting

Default to DV01-neutral for curves. For flies, state whether wings are 50/50, regression-weighted or PCA-weighted, and why.

## Report

For each candidate: level, z-score, percentile, carry, half-life, the structural check, and a verdict. Include rejected candidates with the reason: they stop other agents re-proposing them.
