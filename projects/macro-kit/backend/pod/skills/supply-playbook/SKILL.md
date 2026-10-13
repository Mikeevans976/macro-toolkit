---
name: supply-playbook
description: How government bond supply affects curves and spreads.
---

# Supply playbook

- **Calendar:** auction and syndication dates, sizes and lines for each issuer over the horizon. Net supply (gross issuance minus redemptions, coupons and central bank purchases or QT runoff) matters more than gross.
- **Concession:** bonds and nearby swaps typically cheapen into an auction and recover afterwards. Measure the pattern for the specific issuer and tenor before trading it.
- **Syndications:** new long-dated lines usually come with a new-issue concession; check `new_issue_pricing` against the fitted curve.
- **Remits and funding plans:** DMO annual remits and quarterly plans set the tenor mix; changes in mix move the curve.
- **Month-end index extension:** index-tracking demand at month end supports longer bonds.
- **Central bank flows:** QT reinvestment changes, and any operations concentrated by maturity.

Output: the supply events in the horizon, expected concession, and which curve points or spreads they affect.
