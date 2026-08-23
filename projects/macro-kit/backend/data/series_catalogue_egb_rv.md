# series_catalogue_egb_rv.json — Documentation

Catalogue for the **EGB RV Monitor** tool.  
Backend file: `backend/egb_rv.py` · API route: `GET /api/tools/egb-rv?date={YYYY-MM-DD}`

---

## 1. What Is Already In The Catalogue

### 1.1 Important: the catalogue is documentation, not runtime config

Like the Swaps RV tool, **this catalogue is not read at runtime**. All tickers are
hardcoded inside `egb_rv.py` in three dicts, built dynamically from `COUNTRY_TENORS`
(defined in `egb_expressions_config.py`):

```python
# egb_rv.py  (lines 56–80)

_YIELD_TICKERS = {
    "Bund":        {t: f"GDBR{t} Index"    for t in COUNTRY_TENORS["Bund"]},
    "OAT":         {t: f"GFRN{t} Index"    for t in COUNTRY_TENORS["OAT"]},
    "BTP":         {t: f"GBTPGR{t} Index"  for t in COUNTRY_TENORS["BTP"]},
    "Bonos":       {t: f"GSPG{t}YR Index"  for t in COUNTRY_TENORS["Bonos"]},
    "Belgium":     {t: f"GBGB{t}YR Index"  for t in COUNTRY_TENORS["Belgium"]},
    "Portugal":    {t: f"GPTIT{t}YR Index" for t in COUNTRY_TENORS["Portugal"]},
    "Netherlands": {t: f"GNETH{t}YR Index" for t in COUNTRY_TENORS["Netherlands"]},
    "Austria":     {t: f"GAGB{t}YR Index"  for t in COUNTRY_TENORS["Austria"]},
    "Finland":     {t: f"GFINGB{t} Index"  for t in COUNTRY_TENORS["Finland"]},
}

_ESTR_TICKER = "ESTRON Index"

_ASW_TICKERS = {                                   # ⚠️ unverified — see §3
    "Bund":        {t: f"DASW{t} Index"  for t in [2, 5, 10, 30]},
    "OAT":         {t: f"FOASW{t} Index" for t in [2, 5, 10, 30]},
    "BTP":         {t: f"ITASW{t} Index" for t in [5, 10, 30]},
    "Bonos":       {t: f"SPASW{t} Index" for t in [5, 10]},
    "Belgium":     {t: f"BEASW{t} Index" for t in [10]},
    "Netherlands": {t: f"NLASW{t} Index" for t in [10]},
}

_VOL_TICKER = "EUSV0001 Index"   # EUR 1m10y normal vol (bps) — used as beta regressor
```

To change a ticker: edit `egb_rv.py` and update this catalogue to match.

### 1.2 Tenor coverage per country

`COUNTRY_TENORS` is defined in `egb_expressions_config.py` and controls which tenors
are fetched for each country. Current values:

| Country | Tenors fetched | Yield ticker pattern |
|---------|---------------|---------------------|
| Bund (Germany) | 2, 5, 7, 10, 15, 20, 30y | `GDBR{t} Index` |
| OAT (France) | 2, 5, 7, 10, 15, 20, 30y | `GFRN{t} Index` |
| BTP (Italy) | 2, 5, 7, 10, 15, 20, 30y | `GBTPGR{t} Index` |
| Bonos (Spain) | 2, 5, 7, 10, 15, 20, 30y | `GSPG{t}YR Index` |
| Belgium | 2, 5, 10, 15, 20, 30y | `GBGB{t}YR Index` |
| Portugal | 2, 5, 10, 15, 30y | `GPTIT{t}YR Index` |
| Netherlands | 2, 5, 10, 15, 20, 30y | `GNETH{t}YR Index` |
| Austria | 2, 5, 10, 15, 20, 30y | `GAGB{t}YR Index` |
| Finland | 2, 5, 10, 20, 30y | `GFINGB{t} Index` |

Total yield tickers fetched from Bloomberg: **56**.

### 1.3 Repo blocs

Carry calculations use ESTR as the baseline repo rate. Each country belongs to a
repo bloc that determines its repo sensitivity:

| Country | Repo bloc |
|---------|----------|
| Germany | Bund (often trades special, negative repo) |
| France, Belgium, Netherlands, Austria, Finland | OAT (near GC) |
| Italy | BTP |
| Spain, Portugal | Bonos (peripheral GC proxy) |

### 1.4 ASW spread coverage

ASW expressions use these tickers (`verified: false` — see §3):

| Country | Tenors | Ticker pattern |
|---------|--------|---------------|
| Bund | 2, 5, 10, 30y | `DASW{t} Index` |
| OAT | 2, 5, 10, 30y | `FOASW{t} Index` |
| BTP | 5, 10, 30y | `ITASW{t} Index` |
| Bonos | 5, 10y | `SPASW{t} Index` |
| Belgium | 10y | `BEASW{t} Index` |
| Netherlands | 10y | `NLASW{t} Index` |

> Portugal and Austria have no ASW tickers defined in the code. If ASW
> expressions for those countries are added later, tickers need to be found and
> added to `_ASW_TICKERS` in `egb_rv.py`.

### 1.5 Two Bloomberg yield modes: generic tickers vs individual bonds

The tool has two ways to fetch yield data, toggled by a button in the frontend UI:

**Generic mode (default)** — uses the interpolated constant-maturity index tickers
in `_YIELD_TICKERS` above (e.g. `GDBR10 Index`). These are Bloomberg composite
series, not backed by any specific bond. Field: `PX_LAST`.

**Individual bonds mode** — for each (country, tenor), queries Bloomberg for all
outstanding bullet government bonds and selects the one whose remaining maturity
is closest to the target. Field: `YLD_YTM_MID` on the specific bond ticker (e.g.
`DBR 0 08/15/2034 Govt`). This is the actual tradeable yield, not an interpolated
composite.

The toggle fires a refetch with `?use_individual_bonds=true`. The API response
gains two extra fields:
- `yield_mode`: `"generic"` | `"individual_bonds"` | `"simulation"`
- `bond_map`: `{country: {tenor: {ticker, actual_years, deviation_years, yield_pct, ...}}}` —
  empty dict in generic/simulation mode

Individual bond selection is implemented in `backend/egb_bond_finder.py`. See
`egb_bond_finder.md` for the full design, Bloomberg search expressions, universe
filters, and caching behaviour.

> **bsrch expressions need terminal verification** before individual bonds mode
> can go live — see `egb_bond_finder.md` §3.

### 1.6 Data fallback

Unlike the Swaps RV tool, there is **no CSV fallback** — the tool falls back directly
to a deterministic simulation (`_simulate_data()` in `egb_rv.py`). The simulation
generates ~5y of synthetic daily EGB yield paths for all 9 countries using
mean-reverting spread processes vs Bund, plus synthetic ESTR, ASW, and vol paths.
The `data_source` field in the API response is `"bloomberg"` or `"simulation"`.

In individual bonds mode, if Bloomberg is unavailable `_fetch_from_bbg` returns
`None`, the server falls back to simulation, and `yield_mode` is `"simulation"`
with `bond_map: {}`. The Bond Reference panel in the UI only renders when
`yield_mode === "individual_bonds"`.

---

## 2. How to Test That It Works

### 2.1 Test both yield modes (simulation — no Bloomberg required)

```bash
source .venv/bin/activate
uvicorn backend.main:app --reload --port 8000
```

```bash
curl "http://localhost:8000/api/tools/egb-rv" | python3 -m json.tool | head -40
```

Expected response shape:

```json
{
  "as_of": "2025-06-30",
  "min_date": "2020-...",
  "max_date": "2025-06-30",
  "data_source": "simulation",
  "rv_monitor":   [ { "label": "BTP10-Bund10", "value_bps": 160.2, ... }, ... ],
  "beta_monitor": [ { "label": "BTP10-Bund10", "r2": 0.72, ... }, ... ],
  "series":       { "BTP10-Bund10": [ { "date": "...", "value": ... }, ... ] },
  "groups":       { ... }
}
```

With the optional `date` parameter:

```bash
curl "http://localhost:8000/api/tools/egb-rv?date=2024-12-31" | python3 -m json.tool | head -10
```

Individual bonds mode (falls back to simulation when Bloomberg unavailable):

```bash
curl "http://localhost:8000/api/tools/egb-rv?use_individual_bonds=true" \
  | python3 -m json.tool | grep -E '"yield_mode"|"bond_map"'
# → "yield_mode": "simulation"
# → "bond_map": {}
```

### 2.2 Spot-check simulation sanity

Run this to verify simulation values are in economically plausible ranges:

```python
import sys; sys.path.insert(0, "backend")
from egb_rv import _simulate_data
import pandas as pd

yield_df, estr_s, asw_df, vol_s = _simulate_data()

# Yield levels (in %)
for country in ["Bund", "OAT", "BTP", "Bonos", "Belgium", "Netherlands"]:
    cols = [c for c in yield_df.columns if c[0] == country and c[1] == 10]
    if cols:
        last = float(yield_df[cols[0]].iloc[-1])
        print(f"{country:12s} 10y: {last:.2f}%")

# ESTR
print(f"ESTR: {float(estr_s.iloc[-1]):.2f}%")

# ASW
for col in asw_df.columns:
    print(f"ASW {col[0]:12s} {col[1]}y: {float(asw_df[col].iloc[-1]):.1f} bps")

# Vol
print(f"EUR 1m10y vol: {float(vol_s.iloc[-1]):.1f} bps")
```

Expected approximate ranges (simulation, as of the synthetic end-date 2025-06-30):
- Bund 10y: ~2.5% · OAT 10y: ~3.2% · BTP 10y: ~4.1% · Bonos 10y: ~3.6%
- ESTR: ~2.5%
- Bund ASW 10y: ~−45 bps · OAT ASW 10y: ~+5 bps · BTP ASW 10y: ~−8 bps
- EUR 1m10y vol: ~60 bps

### 2.3 Test Bloomberg connectivity — yield tickers

With Bloomberg Terminal open and `xbbg` installed:

```python
from xbbg import blp
import pandas as pd

start = (pd.Timestamp.today() - pd.DateOffset(days=10)).strftime("%Y-%m-%d")
end   = pd.Timestamp.today().strftime("%Y-%m-%d")

# Core 4 (definitely correct)
core = [
    "GDBR10 Index",   # Bund 10y
    "GFRN10 Index",   # OAT 10y
    "GBTPGR10 Index", # BTP 10y
    "GSPG10YR Index", # Bonos 10y
]
# Semi-core — ⚠️ verify these load correctly
semi = [
    "GBGB10YR Index",  # Belgium 10y
    "GPTIT10YR Index", # Portugal 10y
    "GNETH10YR Index", # Netherlands 10y
    "GAGB10YR Index",  # Austria 10y
    "GFINGB10 Index",  # Finland 10y
]

df = blp.bdh(core + semi, "PX_LAST", start, end)
print(df.tail(3))
```

What to check:
- All 9 tickers return non-NaN values in the **1.5–5.5%** range.
- Belgium, Portugal, Netherlands, Austria, Finland tickers load without error —
  these are marked ⚠️ in the code docstring because the naming pattern is
  less standard than Bund/OAT/BTP/Bonos. Confirm each is correct.
- `ESTRON Index` returns the ESTR overnight fixing (currently ~2–3%).

Also test a full row fetch across all tenors for one country:

```python
bund_all = [f"GDBR{t} Index" for t in [2, 5, 7, 10, 15, 20, 30]]
print(blp.bdh(bund_all, "PX_LAST", start, end).tail(1))
```

### 2.4 Test Bloomberg connectivity — ASW tickers

```python
asw_to_check = [
    "DASW2 Index",   "DASW5 Index",   "DASW10 Index",  "DASW30 Index",   # Bund
    "FOASW2 Index",  "FOASW5 Index",  "FOASW10 Index", "FOASW30 Index",  # OAT
    "ITASW5 Index",  "ITASW10 Index", "ITASW30 Index",                   # BTP
    "SPASW5 Index",  "SPASW10 Index",                                     # Bonos
    "BEASW10 Index",                                                       # Belgium
    "NLASW10 Index",                                                       # Netherlands
]

asw_df = blp.bdh(asw_to_check, "PX_LAST", start, end)
print(asw_df.tail(3))
```

What to check:
- Bund ASW tickers return values in the **−20 to −60 bps** range (Bund is rich vs ESTR).
- OAT ASW tickers return values near **0 to +20 bps** (near GC).
- BTP ASW tickers return values in the **−5 to −20 bps** range.
- If any ticker returns all NaN or fails, flag it — the ASW ticker format needs
  confirming against Bloomberg's actual series names (they vary by data provider).
- Record the confirmed tickers in the catalogue and set `verified: true`.

---

## 3. What Is Missing / What Has to Be Added

### 3.1 Individual bonds mode — bsrch expressions need terminal verification

Before `?use_individual_bonds=true` can go live, the 9 Bloomberg `bsrch` search
expressions in `egb_bond_finder.py` must be verified in a live Terminal
(e.g. `FI:DBR` for Bund). Full procedure and fallback behaviour documented in
`egb_bond_finder.md`.

### 3.2 Haver tickers — not applicable for this tool

EGB yields, ESTR, ASW spreads, and swaption vol are all **daily market prices**.
Haver does not carry these. All `ticker_haver` fields are `null` by design.

### 3.3 ASW tickers — must be verified before going live (PRIORITY)

This is the **only open blocker** before the tool can run on Bloomberg live data.

The 14 ASW tickers in `_ASW_TICKERS` have `verified: false` in the catalogue.
Until they are confirmed in a Bloomberg Terminal, any expression that includes
an `_ASW` leg will be silently skipped at runtime (the code handles missing ASW
data gracefully, but those expressions will be absent from `rv_monitor` output).

Steps:
1. Run the Bloomberg snippet in §2.4 and confirm each ticker returns data.
2. Check that the values are in the right units — **bps** spread vs ESTR swap.
   (If values look like raw percentages, the scale is wrong.)
3. For any ticker that fails, search Bloomberg for the correct ASW series using
   `FLDS` or a country-specific ASW page (e.g. `SOVM <GO>` for sovereign ASW).
4. Update the confirmed tickers in `egb_rv.py` (`_ASW_TICKERS`) and set
   `verified: true` in this catalogue.

### 3.4 Minor: Belgium and Netherlands ASW only have 10y

The code only defines ASW tickers for Belgium 10y and Netherlands 10y. If the
team wants 2y/5y/30y ASW for these countries, tickers need to be found and
added to `_ASW_TICKERS`. Suggested patterns to check:
- Belgium 2y: `BEASW2 Index` · 5y: `BEASW5 Index` · 30y: `BEASW30 Index`
- Netherlands 2y: `NLASW2 Index` · 5y: `NLASW5 Index` · 30y: `NLASW30 Index`

### 3.5 Portugal and Austria have no ASW tickers

No ASW expressions exist for Portugal or Austria. This is likely intentional
(lower liquidity), but flag with the team if expressions like `Portugal ASW 10y`
are wanted. Possible patterns:
- Portugal: `PTASW{t} Index`
- Austria: `OEASW{t} Index`

### 3.6 Finland yield ticker pattern inconsistency

All other countries follow `G{XX}B{t}YR Index` (with a `YR` suffix), but Finland
uses `GFINGB{t} Index` (no `YR`). This is already correctly implemented in the
code but is worth double-checking on Bloomberg that `GFINGB10 Index` (not
`GFINGB10YR Index`) is the live series.

### 3.7 Potential future country additions

If the tool is extended to cover more EGB issuers, patterns to check:

| Country | Yield pattern (likely) | Repo bloc |
|---------|------------------------|----------|
| Greece | `GGGB{t}YR Index` | Bonos |
| Ireland | `GIGB{t}YR Index` | OAT |

Add them to `COUNTRY_TENORS` in `egb_expressions_config.py` and `_YIELD_TICKERS`
in `egb_rv.py`, then add entries to this catalogue.
