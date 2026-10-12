# egb_bond_finder.py — Documentation

Module implementing **individual-bond selection** for the EGB RV Monitor.  
File: `backend/egb_bond_finder.py` · Consumed by: `backend/egb_rv.py`

---

## 1. What It Does and Why

The default EGB RV Monitor fetches yield data using Bloomberg's **generic
constant-maturity index tickers** (e.g. `GDBR10 Index` for the German 10y
Bund). These are interpolated composite series — not backed by any specific
bond. They are convenient but have two limitations:

1. **Yield is synthetic**: the value is interpolated across multiple bonds,
   so it doesn't match the yield you'd actually trade.
2. **ASW calculations require a specific bond**: an asset swap spread is
   defined per ISIN, not per maturity point.

This module provides an alternative: for each country and target tenor, it
queries Bloomberg for all outstanding government bonds, then selects the
**bond whose remaining maturity is closest to the target**. The EGB RV
backend then fetches `YLD_YTM_MID` on that specific bond — the actual
tradeable yield.

The two modes are toggled at runtime via a button in the frontend UI. No
restart is needed.

---

## 2. Architecture

```
egb_bond_finder.py
│
├── COUNTRY_BSRCH          dict — bsrch search expression per country
├── _BOND_FIELDS           list — Bloomberg reference data fields to fetch
├── _UNIVERSE_CACHE        dict — in-memory cache keyed by (country, date)
│
├── _fetch_universe()      queries Bloomberg: bsrch → bdp → filter → DataFrame
├── _get_universe()        cache wrapper around _fetch_universe()
├── find_closest()         picks the bond nearest to a target tenor
└── build_egb_bond_map()   public API — loops over all countries and tenors
```

### Data flow (individual bonds mode)

```
Request: GET /api/tools/egb-rv?use_individual_bonds=true
         │
         ▼
compute_egb_rv(use_individual_bonds=True)
         │
         ▼
_fetch_from_bbg(..., use_individual_bonds=True)
         │
         ├─► build_egb_bond_map(COUNTRY_TENORS)
         │       │
         │       └─► for each country:
         │             _get_universe(country, today)        ← cached
         │                 bsrch("FI:DBR")                 ← Bloomberg search
         │                 bdp(tickers, _BOND_FIELDS)       ← reference data
         │                 filter + sort by ytm_years
         │             find_closest(universe, target_years) ← pure Python
         │
         ├─► yield_ticker_map = {bond_ticker: (country, tenor)}
         │
         └─► blp.bdh(tickers, "YLD_YTM_MID", start, end)  ← historical yields
```

---

## 3. Bloomberg Search Expressions

The `COUNTRY_BSRCH` dict maps each country to a `bsrch` search expression.
These return a list of Bloomberg ticker strings for all outstanding bonds
matching the issuer prefix.

| Country | Expression | Issuer prefix | Example ticker |
|---------|-----------|---------------|----------------|
| Germany | `FI:DBR` | Deutsche Bundesanleihe | `DBR 0 08/15/2034 Govt` |
| France | `FI:FRTR` | OAT (Obligations du Trésor) | `FRTR 3 11/25/2035 Govt` |
| Italy | `FI:BTPS` | BTP (Buoni del Tesoro) | `BTPS 4 05/01/2035 Govt` |
| Spain | `FI:SPGB` | Bonos del Estado | `SPGB 3 7/8 10/31/2035 Govt` |
| Belgium | `FI:BGB` | Belgian Government Bond | `BGB 3 03/22/2034 Govt` |
| Portugal | `FI:PGB` | Portuguese Government Bond | `PGB 3 10/15/2035 Govt` |
| Netherlands | `FI:NETHER` | Dutch State Loan | `NETHER 0 1/4 07/15/2033 Govt` |
| Austria | `FI:RAGB` | Republic of Austria | `RAGB 1 7/8 10/20/2036 Govt` |
| Finland | `FI:RFGB` | Republic of Finland | `RFGB 1 09/15/2031 Govt` |

> ⚠️ **These expressions must be verified in a live Bloomberg Terminal before
> going live.** Syntax may vary by terminal configuration. In the terminal:
> type the issuer prefix + `<Govt> <GO>` (e.g. `DBR <Govt> <GO>`) and confirm
> you get a list of outstanding bonds. Then test the Python call:
> ```python
> from bbg import blp
> tickers = blp.bsrch("FI:DBR")
> print(tickers[:5])
> ```
> If `tickers` is empty or raises, update `COUNTRY_BSRCH` with the correct
> expression for your Bloomberg configuration.

---

## 4. Bond Universe Filters

`_fetch_universe()` applies three filters before returning the universe:

| Filter | Value | Rationale |
|--------|-------|-----------|
| Bullet bonds only | `CALLABLE != "Y"` | Exclude callable/putable bonds where YTM is ambiguous |
| Minimum remaining maturity | `ytm_years > 0.5` | Exclude bonds within 6 months of maturity (illiquid, approaching redemption) |
| Minimum outstanding | `AMT_OUTSTANDING >= 5 000 mn` | Exclude small/illiquid lines; threshold is in millions (local CCY) |

To change the minimum outstanding threshold, pass `min_outstanding_mn` to
`build_egb_bond_map()`. The default is 5 000 mn (€5 bn), which filters well
for core EGB markets. For Portugal and Finland (smaller markets), you may need
to lower this if the universe becomes too thin.

---

## 5. Closest-Bond Selection

`find_closest(universe, target_years)` picks the bond minimising
`|ytm_years − target_years|`. It returns a dict:

```python
{
    "ticker":          "DBR 0 08/15/2034 Govt",   # Bloomberg ticker string
    "target_years":    10,                          # what we asked for
    "actual_years":    9.873,                       # what we got
    "deviation_years": 0.127,                       # |actual − target|
    "maturity":        "2034-08-15",
    "coupon":          0.0,
    "yield_pct":       2.4215,                      # YLD_YTM_MID at time of search
    "duration":        9.12,                        # DUR_ADJ_MID
    "outstanding_mn":  18000.0,                     # millions
}
```

`build_egb_bond_map()` enforces a **maximum deviation** (`max_deviation_years`,
default 1.5y). If no bond is within 1.5y of the target, the entry is `None`
and a warning is emitted. That (country, tenor) combination is excluded from
the `yield_ticker_map` and will be absent from the analysis — expressions
that reference it will be silently skipped by `egb_rv.py`.

---

## 6. Caching

The bond universe for each (country, date) is stored in `_UNIVERSE_CACHE`, a
module-level dict. Within a single server session, the first request for a
given country triggers `bsrch` + `bdp`; subsequent requests on the same day
return from cache instantly.

The cache is **not persisted across server restarts**. On a production server
with daily restarts (e.g. via Procfile), this is fine — one cold-start per day
per country. On a long-running server, the cache grows slowly (9 countries ×
one entry per unique date the tool is queried) and never evicts — this is
acceptable given the small size.

---

## 7. Integration with egb_rv.py

The `_fetch_from_bbg()` function in `egb_rv.py` branches on `use_individual_bonds`:

```python
if use_individual_bonds:
    bond_map = build_egb_bond_map(COUNTRY_TENORS, as_of_date=end)
    # yield_ticker_map built from bond_map; fetches YLD_YTM_MID
else:
    # existing _YIELD_TICKERS dict; fetches PX_LAST on generic index tickers
```

The `compute_egb_rv()` response includes two new fields in both modes:

| Field | Type | Description |
|-------|------|-------------|
| `yield_mode` | `"generic"` \| `"individual_bonds"` \| `"simulation"` | Which data path was taken |
| `bond_map` | `{country: {tenor: BondInfo \| null}}` | Full bond metadata (empty dict in generic/simulation mode) |

Note that `bond_map` keys use **integer tenors** in Python but **string keys**
in JSON (standard JSON serialisation). The frontend handles this by looking up
`bondMap[country][String(tenor)]`.

---

## 8. How to Test

### 8.1 Without Bloomberg (mode falls back to simulation)

The individual bonds toggle still works — clicking it fires a refetch with
`?use_individual_bonds=true`. Since Bloomberg is unavailable, `_fetch_from_bbg`
returns `None`, the server falls back to `_simulate_data()`, and the response
has `yield_mode: "simulation"`, `bond_map: {}`. The **Bond Reference panel
does not appear** in the UI (it only renders when `yield_mode === "individual_bonds"`).

```bash
curl "http://localhost:8000/api/tools/egb-rv?use_individual_bonds=true" \
  | python3 -m json.tool | grep -E '"yield_mode"|"bond_map"'
# → "yield_mode": "simulation"
# → "bond_map": {}
```

### 8.2 Test bsrch and bdp directly

```python
import sys; sys.path.insert(0, "backend")
from bbg import blp

# Step 1 — confirm bsrch returns bond tickers
tickers = blp.bsrch("FI:DBR")
print(f"Found {len(tickers)} Bund tickers")
print(tickers[:5])

# Step 2 — confirm bdp returns reference data
fields = ["MATURITY", "COUPON", "AMT_OUTSTANDING", "CALLABLE", "YLD_YTM_MID", "DUR_ADJ_MID"]
ref = blp.bdp(tickers[:10], fields)
print(ref)
```

Expected:
- `tickers` should contain 15–25 strings like `"DBR 0 08/15/2034 Govt"`
- `ref` should be a DataFrame with non-null `MATURITY`, `YLD_YTM_MID` in ~1–4% range,
  `DUR_ADJ_MID` in 1–25 range, `CALLABLE` = `"N"` for all Bunds

### 8.3 Test build_egb_bond_map

```python
import sys; sys.path.insert(0, "backend")
from egb_expressions_config import COUNTRY_TENORS
from egb_bond_finder import build_egb_bond_map

bond_map = build_egb_bond_map(COUNTRY_TENORS)

for country in ["Bund", "OAT", "BTP"]:
    print(f"\n{country}:")
    for tenor, info in bond_map[country].items():
        if info:
            print(f"  {tenor}y → {info['ticker']}  "
                  f"actual={info['actual_years']:.2f}y  "
                  f"dev={info['deviation_years']:.2f}y  "
                  f"yield={info['yield_pct']:.3f}%")
        else:
            print(f"  {tenor}y → None (no bond found)")
```

What to check:
- All core tenors (2, 5, 10y) have a match for Bund, OAT, BTP
- Deviations are typically <0.5y for liquid markets
- Any `None` entries for smaller countries (Portugal 15y, Finland 20y) at thin
  issuance points are expected — those tenors will be skipped in the RV analysis

### 8.4 Test the full API endpoint with Bloomberg

```bash
curl "http://localhost:8000/api/tools/egb-rv?use_individual_bonds=true" \
  | python3 -m json.tool | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('yield_mode:', d['yield_mode'])
print('bond_map keys:', list(d['bond_map'].keys()))
print('Bund 10y bond:', d['bond_map'].get('Bund', {}).get('10'))
"
```

Expected with Bloomberg live:
```
yield_mode: individual_bonds
bond_map keys: ['Bund', 'OAT', 'BTP', 'Bonos', 'Belgium', 'Portugal', 'Netherlands', 'Austria', 'Finland']
Bund 10y bond: {'ticker': 'DBR 0 08/15/2034 Govt', 'actual_years': 9.87, ...}
```

---

## 9. Frontend: the Toggle and Bond Reference Panel

The toggle lives in the EGB RV Monitor header bar (`frontend/src/pages/EGBRV.tsx`).

**Toggle button** — clicking switches `useIndividualBonds` state and immediately
refetches from the API with the new `use_individual_bonds` param. The data
source badge updates to reflect the active mode:
- `Live · Generic tickers` — green, Bloomberg connected, generic mode
- `Live · Individual bonds` — green, Bloomberg connected, individual bonds mode
- `Simulated data` — amber, Bloomberg unavailable (regardless of toggle)

**Bond Reference panel** — rendered only when `yield_mode === "individual_bonds"`.
Collapsed by default (click **Show** to expand). Displays a country × tenor grid
where each cell shows:
- The short bond identifier (e.g. `DBR 08/2034`)
- The actual remaining maturity in years, colour-coded by deviation from target:
  - Green: deviation < 0.25y
  - Amber: deviation < 0.75y
  - Red: deviation ≥ 0.75y
- Hover tooltip: full ticker, maturity date, yield, duration, outstanding

---

## 10. Limitations and Known Issues

### Historical consistency

`build_egb_bond_map` always selects the bond closest to each target tenor **as
of today**. The subsequent `blp.bdh` call then fetches historical yields for
that bond over the past ~6 years. This creates a subtle inconsistency:
the bond that is the 10y Bund today was the 16y Bund six years ago — so early
history in the series reflects a different point on the curve.

For the RV monitor's primary use case (cross-sectional z-scores and carry
computed from a rolling 1y window), this inconsistency is small and acceptable.
For a proper historical backtest you would need a bond-roll schedule — see the
design notes in `series_catalogue_egb_rv.md` §3.1 for discussion.

### On-the-run vs closest-maturity

The selected bond is the one with **minimum maturity distance** to the target,
not necessarily the **on-the-run** (most recently issued) bond. These often
coincide, but can differ when two bonds are nearly equidistant from the target.
If on-the-run selection is preferred, Bloomberg provides an `OTR` field on
some generic tickers — worth exploring as a future enhancement.

### bsrch syntax

The `FI:{PREFIX}` syntax needs terminal verification (see §3). If it fails for
a country, that country's entire bond universe will be empty and all its tenors
will be excluded from the individual bonds analysis. The tool falls back
gracefully — `egb_rv.py` emits a warning and those expressions are absent from
`rv_monitor` — but the user will notice missing rows. Check `stderr` on the
server for `[egb_bond_finder]` warnings.
