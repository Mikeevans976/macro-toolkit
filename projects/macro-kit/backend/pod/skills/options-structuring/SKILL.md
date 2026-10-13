---
name: options-structuring
description: How to choose option structures to express a macro view.
---

# Options structuring

- **Match the structure to the view:**
  - directional with defined loss: payers or receivers, or spreads to cut premium;
  - range-bound: sell straddles or strangles only with clear risk limits;
  - conditional views (e.g. curve steepens if rates fall): conditional curve options or mid-curves;
  - tail protection: out-of-the-money options where skew is cheap.
- **Vol level and skew:** compare implied with realised vol and with history; buy optionality when it is cheap relative to the event risk ahead.
- **Expiry versus catalyst:** expiry must be after the catalyst, with time for the move.
- **Greeks:** report delta, vega and theta in money terms; theta is the monthly cost of waiting.
- **What's priced:** use `option_implied_cdf` to compare the market's distribution with yours.

Output: the structure, cost, maximum loss, break-even, and why it beats the linear trade.
