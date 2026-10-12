# series_catalogue_swaps_rv.json — Documentation

Catalogue for the **Swaps RV Monitor** tool.  
Backend file: `backend/swaps_rv.py` · API route: `GET /api/swaps-rv?currency={EUR|GBP|USD}`

---

## 1. What Is Already In The Catalogue

### 1.1 Important: the catalogue is documentation, not runtime config

Unlike the regional heatmap catalogues (which will eventually drive data fetching),
**this catalogue is not read at runtime**. The tickers are hardcoded directly inside
`swaps_rv.py` in two dicts:

```python
# swaps_rv.py  (lines 112–123)

_OIS_TICKERS = {
    "EUR": {n: f"EUSWF{n} Curncy"  for n in _SWAP_TENORS},   # EUR ESTR OIS
    "GBP": {n: f"BPSWS{n} Curncy"  for n in _SWAP_TENORS},   # GBP SONIA OIS
    "USD": {n: f"USOSFR{n} Curncy" for n in _SWAP_TENORS},   # USD SOFR OIS
}

_VOL_TICKERS = {
    "EUR": {"1m10y": "EUSV0001 Index", "1y10y": "EUSV0110 Index"},
    "GBP": {"1m10y": "BPSV0001 Index", "1y10y": "BPSV0110 Index"},
    "USD": {"1m10y": "USSV0001 Index", "1y10y": "USSV0110 Index"},
}
```

If you ever change a ticker, edit those dicts in Python and update the catalogue to match.

### 1.2 Series overview

All 9 entries are **`verified: true`** and have a Bloomberg ticker. There are no Haver
tickers (see §3).

| id | Bloomberg pattern | Tenors / labels | Description |
|----|------------------|-----------------|-------------|
| `eur_estr_ois` | `EUSWF{n} Curncy` | 1, 2, 3 … 10, 12, 15, 20, 25, 30y | EUR ESTR OIS par swap rates |
| `gbp_sonia_ois` | `BPSWS{n} Curncy` | same | GBP SONIA OIS par swap rates |
| `usd_sofr_ois` | `USOSFR{n} Curncy` | same | USD SOFR OIS par swap rates |
| `eur_swaption_vol_1m10y` | `EUSV0001 Index` | — | EUR ATM normal vol, 1m × 10y |
| `eur_swaption_vol_1y10y` | `EUSV0110 Index` | — | EUR ATM normal vol, 1y × 10y |
| `gbp_swaption_vol_1m10y` | `BPSV0001 Index` | — | GBP ATM normal vol, 1m × 10y |
| `gbp_swaption_vol_1y10y` | `BPSV0110 Index` | — | GBP ATM normal vol, 1y × 10y |
| `usd_swaption_vol_1m10y` | `USSV0001 Index` | — | USD ATM normal vol, 1m × 10y |
| `usd_swaption_vol_1y10y` | `USSV0110 Index` | — | USD ATM normal vol, 1y × 10y |

**Swaption vol units**: ATM normal vol returned in bp/yr. The backend uses this as-is
(no unit conversion) for the beta regression explanatory variables.

### 1.3 Data fallback

When Bloomberg is unavailable the backend falls back to CSV files at `data/` (project
root, **not** `backend/data/`):

| Currency | Forwards CSV | Beta-variables CSV | Par-swaps CSV |
|----------|--------------|--------------------|---------------|
| EUR | `eur_estr_forwards.csv` | `eur_beta_variables.csv` | `eur_estr_swaps.csv` |
| GBP | `gbp_sonia_forwards.csv` | `gbp_beta_variables.csv` | `gbp_sonia_swaps.csv` |
| USD | `usd_sofr_forwards.csv` | `usd_beta_variables.csv` | `usd_sofr_swaps.csv` |

These files are pre-generated and committed to the repo. The live Bloomberg path
bootstraps forward rates on the fly from par OIS rates; the CSVs already contain the
bootstrapped forwards so that the fallback path is instant.

---

## 2. How to Test That It Works

### 2.1 Test the fallback (no Bloomberg required)

Start the server in the default (CSV) mode and hit the endpoint:

```bash
source .venv/bin/activate
uvicorn backend.main:app --reload --port 8000
```

```bash
curl "http://localhost:8000/api/swaps-rv?currency=EUR" | python3 -m json.tool | head -60
```

Expected response shape:

```json
{
  "as_of": "2025-06-30",
  "min_date": "2020-01-02",
  "max_date": "2025-06-30",
  "curve_snapshot": { ... },
  "rv_monitor": [ { "label": "2y5y-3y5y", "value_bps": 4.2, ... }, ... ],
  "beta_monitor": [ { "label": "2y5y-3y5y", "r2": 0.61, ... }, ... ],
  "series": { "2y5y-3y5y": [ { "date": "...", "value": ... }, ... ], ... }
}
```

Repeat for `currency=GBP` and `currency=USD`.

### 2.2 Test Bloomberg connectivity

With a Bloomberg Terminal open and `xbbg` installed, run from the repo root:

```python
from xbbg import blp
import pandas as pd

# OIS par rates — fetch last 5 days
ois = blp.bdh(
    ["EUSWF1 Curncy", "EUSWF2 Curncy", "EUSWF5 Curncy",
     "EUSWF10 Curncy", "EUSWF30 Curncy"],
    "PX_LAST",
    (pd.Timestamp.today() - pd.DateOffset(days=7)).strftime("%Y-%m-%d"),
    pd.Timestamp.today().strftime("%Y-%m-%d"),
)
print(ois.tail())

# Swaption vols
vols = blp.bdh(
    ["EUSV0001 Index", "EUSV0110 Index",
     "BPSV0001 Index", "BPSV0110 Index",
     "USSV0001 Index", "USSV0110 Index"],
    "PX_LAST",
    (pd.Timestamp.today() - pd.DateOffset(days=7)).strftime("%Y-%m-%d"),
    pd.Timestamp.today().strftime("%Y-%m-%d"),
)
print(vols.tail())
```

What to check:
- All OIS tickers return values in the **2–6%** range (roughly, as of 2025).
- All swaption vol tickers return values in the **30–120 bp/yr** range.
- No ticker returns an all-NaN column.

If Bloomberg is connected, start the server and hit the endpoint — the `as_of` date
in the JSON response should match today's date.

### 2.3 Run the unit tests

```bash
source .venv/bin/activate
cd backend && pytest tests/test_analytics.py -v -k swaps
```

The test suite covers:
- Hand-computable carry/roll answers on a flat-curve toy example.
- Self-consistency: carry computed from par rates == carry computed from bootstrapped forwards.
- End-to-end sanity: `compute_rv("EUR")` returns a dict with the expected top-level keys and non-empty `rv_monitor`.

---

## 3. What Is Missing / What Has to Be Added

### 3.1 Haver tickers — not applicable for this tool

OIS swap rates and swaption vols are **daily market prices**, not statistical releases.
Haver Analytics does not carry interbank swap rates or swaption vols. All `ticker_haver`
fields are `null` by design and should stay that way.

### 3.2 Minor discrepancy: 11y tenor in catalogue vs. code

The catalogue lists `"tenors_or_expiries": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 20, 25, 30]`
(16 tenors, including 11y), but the code uses:

```python
_SWAP_TENORS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30]   # 15 tenors — no 11y
```

**The 11y tenor is never fetched from Bloomberg.** The catalogue entry is therefore
slightly wrong. Action required: either remove 11 from the catalogue's `tenors_or_expiries`
array, or add 11 to `_SWAP_TENORS` in `swaps_rv.py` if 11y coverage is wanted.
Ask the team which is correct before editing.

### 3.3 Potential future additions (not urgent)

These are not missing today but are worth flagging if the tool is extended:

| What | Bloomberg tickers | Notes |
|------|------------------|-------|
| JPY TONA OIS | `JYOSFR{n} Curncy` | Bank of Japan overnight rate swaps |
| AUD AONIA OIS | `ADSW{n} Curncy` | Reserve Bank of Australia |
| CHF SARON OIS | `SFSW{n} Curncy` | Swiss National Bank |
| Broader vol grid (e.g. 3m5y, 5y5y) | `EUSV{exp}{tail} Index` | Needed if vol-surface features are added to the beta regression |

To add a new currency: (1) add to `_OIS_TICKERS` and `_VOL_TICKERS` in `swaps_rv.py`,
(2) add the forward/beta/swap CSVs to `data/` for the fallback path,
(3) add the new entries to this catalogue.
