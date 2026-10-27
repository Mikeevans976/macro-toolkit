---
name: forecast-evaluation
description: How to backtest and judge statistical and forecasting models (nowcasts, payrolls, inflation).
---

# Forecast evaluation

## Set-up

1. **Real time.** Every forecast uses only the data public on its origin date: first prints as published, later revisions only after their release, survey data as of the survey date. Use `nowcast_backtest` (real time by construction) where it covers the model; otherwise say which vintages you used and what look-ahead remains.
2. **Re-estimation.** Parameters re-estimated only with data available at each origin (expanding or rolling window); state which.
3. **Target.** Score against the first print (what markets trade) and, separately, the latest value (what the economy did). Report revision noise (first vs latest RMSE) so errors can be judged against it.
4. **Horizons.** Score each horizon separately (e.g. 60, 30, 7 days before the release); never average across horizons.
5. **Exclusions.** State any excluded periods (e.g. 2020-03 to 2021-06) and show results with them if they matter.

## Benchmarks

Every model is compared with at least:
- **naive** (last print, or the historical mean for growth rates);
- **consensus** (Bloomberg survey median, via `print_vs_consensus`) where it exists;
- the **simplest reasonable model** (an AR or bridge equation).

## Metrics

- RMSE and mean error (bias) per horizon; relative RMSE against each benchmark.
- **Diebold–Mariano** test of equal accuracy (small-sample correction, HAC variance). With fewer than ~30 forecasts, treat p-values as indicative.
- **Surprise sign:** how often the model gets the sign of the surprise (print − consensus) right. This is what makes a model tradable.
- Density forecasts: coverage of the 68% and 90% bands; PIT histogram if there is enough data.
- Stability: metrics by sub-period (pre-2020, post-2021) and the rolling RMSE ratio.

## Payrolls and other noisy monthly releases

- Sampling error is large (US nonfarm payrolls about ±130k at 90%); no model beats that noise on the first print. Judge it on the surprise sign and on revisions.
- Check whether the model adds anything over the inputs markets already see (ADP, claims, surveys).

## Verdict

- **Tradable:** beats consensus on surprise sign significantly, stable across sub-periods.
- **Informative:** beats naive but not consensus; useful for the narrative, not for trading the print.
- **Not useful:** does not beat naive by more than noise.

Report: set-up, the table of metrics by horizon against benchmarks, stability, verdict, and what would improve the model.
