# series_catalogue_momentum.json

Catalogue for the **Momentum (CTA Signals)** tool. Backend: `backend/momentum.py`.

The default universe is not in this catalogue: it is code, in
`backend/momentum_universe.py` (one `Market` per row: id, label, group, ticker
expression, price/level kind, display unit, whether it is a CTA market and its
risk-budget sector). Edit that file to add or remove markets, then run

    cd backend && python scripts/probe_momentum.py

to check the tickers on the Terminal (history, roll-adjusted generic, static
fields).

The catalogue's single `user_supplied` entry stands for the Single Series view,
which takes any ticker or weighted expression at runtime.

Methodology (signals, regimes, sizing, calibration, caching): see
`docs/DOCUMENTATION.md` §6.7.
