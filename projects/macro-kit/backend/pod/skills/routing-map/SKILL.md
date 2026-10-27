---
name: routing-map
description: Which pod agent or desk handles which kind of question.
---

# Routing map

Route each question to the narrowest agent that can answer it; consult a desk head only when it spans a desk, and the Deputy PM only when it spans desks.

| Question about | Agent id |
|---|---|
| US / euro area / UK / Japan economy and central bank | us-economist, ea-economist, uk-economist, japan-economist |
| Canada, Australia, NZ, Sweden, Norway, Switzerland | dollar-bloc-economist |
| China, emerging markets | china-em-economist |
| Central bank statements, speeches, minutes | cb-comms-analyst |
| Elections, tariffs, wars, sanctions | geopolitics-analyst |
| Central bank meeting pricing, short-rate futures | stir-strategist |
| Curve shape, duration, global yields | curve-strategist |
| Swap curves, flies, swap spreads | swaps-rv-analyst |
| Government bond spreads, specific bonds | sovereign-spreads-analyst |
| Inflation markets | inflation-strategist |
| Issuance, auctions, repo, funding | supply-funding-analyst |
| G10 FX / EM FX and local rates | g10-fx-strategist, em-fx-rates-strategist |
| Commodities | commodities-strategist |
| Equities, credit, risk appetite | equity-credit-strategist |
| Rates options and volatility (swaptions, STIR and bond options) | rates-vol-strategist |
| FX, commodity and equity options and volatility | vol-options-strategist |
| Positioning and flows | positioning-flows-analyst |
| Technicals, trend | technicals-analyst |
| Regimes, correlations | regime-correlation-analyst |
| Backtests of statistical or forecasting models (nowcasts, payrolls), statistical claims | model-backtest-analyst |
| Backtests of a trade or trading strategy | strategy-backtest-analyst |
| Book risk, stress tests | market-risk-analyst, cro |
| Trade sizing | sizing-analyst |
| How to execute a trade | execution-strategist |
| Status of live trades | trade-monitor |
| Past performance, lessons | performance-analyst |
| News today | news-scanner |
| Data calendar, release previews | calendar-analyst |
| Sell-side research, past notes | research-librarian |
| Data problems | data-quality-sentinel |
| Macro themes: status, scenarios and probabilities, theme trades, risk across themes | macro-themes-strategist |
| The house view | deputy-pm |
