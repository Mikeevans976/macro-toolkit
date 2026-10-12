# series_catalogue_rpi_fixings.json — Documentation

Catalogue for the **Inflation Fixings Monitor — United Kingdom** tab.  
Backend file: `backend/rpi_fixings.py`  
API route: `GET /api/tools/inflation-fixings/gbp`

---

## 1. What Is In The Catalogue

The catalogue is the **single source of truth** for all tickers consumed by
`rpi_fixings.py`. The module reads tickers directly from this file at import
time — nothing is hardcoded in the Python.

### 1.1 Historical series (7 entries)

Fetched via `BDH` (time series). Only `gbp_rpi` is used for level
reconstruction; the others are displayed on the Historical subtab.

| ID | Label | Bloomberg ticker | Haver ticker | Base? |
|----|-------|-----------------|--------------|-------|
| `gbp_rpi` | RPI | `UKCERPI Index` | `RPI@UKDATA` | **Yes** |
| `gbp_cpi` | CPI | `UKRPCJPA Index` | `CPI@UKDATA` | |
| `gbp_cpi_core` | CPI Core | `UKCRCORE Index` | `CPICORE@UKDATA` | |
| `gbp_cpi_services` | CPI Services | `UKRPCJSR Index` | null | |
| `gbp_cpi_core_goods` | CPI Core Goods | `UKRPCJCG Index` | null | |
| `gbp_cpi_energy` | CPI Energy | `UKRPCJEN Index` | null | |
| `gbp_cpi_food` | Food, Alc. & Tobacco | `UKRPCJFT Index` | null | |

**Haver**: RPI, CPI, and Core CPI have confirmed Haver codes. Services, core
goods, energy and food index levels are not confirmed in Haver — only YoY rates
may be available.

### 1.2 Fixings

Fetched via `BDP` (snapshot, current price). Bloomberg `PX_LAST` returns the
**%YoY implied rate**, not a raw index level.

| Series | Ticker template | Tenors | Verified? |
|--------|----------------|--------|-----------|
| F-series | `UKRPIF{n} Comdty` | 1–12 | No — synthetic |
| T-series | `UKRPIT{n} Comdty` | 1–12 | No — synthetic |
| Live alternative | `BPSWIS{n} Curncy` | 1–10, 15, 20, 25, 30y | **Yes** |

**Important**: `UKRPIF{n}` and `UKRPIT{n}` are a **synthetic convention** for
this tool — Bloomberg does not publish calendar-month GBP RPI fixings in exactly
this format. In live Bloomberg mode, the correct approach is to use
`BPSWIS{n} Curncy` (GBP RPI zero-coupon inflation swaps, standard tenors)
and interpolate to calendar-month YoY rates.

**Base for reconstruction** (`history_base_id`): `gbp_rpi`  
→ `UKCERPI Index` is the settlement index for GBP RPI inflation swaps.

---

## 2. Architecture

### Catalogue loading (module import)

```python
_CAT_PATH = Path(__file__).parent / "data" / "series_catalogue_rpi_fixings.json"
with open(_CAT_PATH) as _f:
    _CAT = json.load(_f)

_fix         = _CAT["fixings"]
_TICKERS_F   = [_fix["f_series"]["ticker_template"].replace("{n}", str(n)) for n in _fix["f_series"]["tenors"]]
_TICKERS_T   = [_fix["t_series"]["ticker_template"].replace("{n}", str(n)) for n in _fix["t_series"]["tenors"]]
_TICKER_HIST = next(s["ticker_bloomberg"] for s in _CAT["historical_series"] if s.get("base_for_reconstruction"))
```

To change a ticker, edit the catalogue JSON. The module picks it up on next
server start — no Python changes required.

### Full data flow

```
GET /api/tools/inflation-fixings/gbp
│
├─► _bloomberg_rpi_history(n_months=48)               [BDH — if Bloomberg]
│       blp.bdh("UKCERPI Index", "PX_LAST", start, end, periodicity="MONTHLY")
│       Returns pd.Series indexed by month-start timestamps
│       → Falls back to _sim_rpi_history() if None/empty
│
├─► _seasonal_factors(hist)
│       Average MoM % by calendar month over full history
│       Used as additive correction: MoM SA ≈ MoM NSA − factor[month]
│
├─► _bloomberg_yoy_rates()                            [BDP — if Bloomberg]
│       blp.bdp(UKRPIF1..12 + UKRPIT1..12, "PX_LAST")
│       Returns {ticker: yoy_pct}
│       → Falls back to _sim_yoy_rates() if None
│
├─► _reconstruct_levels(yoy_rates, hist, first_month)
│       F-series:  Level_F(t) = hist[t−12mo] × (1 + YoY/100)
│       T-series:  Level_T(t) = Level_F[t−12mo] × (1 + YoY/100)
│
└─► Build response: 24 fixings + last-24-month history tail
```

### `first_month` convention

`first_month = Timestamp(today.year + 1, today.month, 1)`

The 24 fixings span from `first_month` (F1) to `first_month + 23 months` (T12).

---

## 3. Level Reconstruction Methodology

### F-series (months 1–12)

```
Level_F(t) = UKCERPI_hist[t − 12mo] × (1 + YoY_F(t) / 100)
```

### T-series (months 13–24)

```
Level_T(t) = Level_F[t − 12mo] × (1 + YoY_T(t) / 100)
```

### MoM calculations

```
MoM NSA(t) = (Level(t) / Level(t−1) − 1) × 100
MoM SA(t)  = MoM NSA(t) − seasonal_factor[calendar_month(t)]
```

Seasonal factors are derived from trailing `UKCERPI` history, not hardcoded.

---

## 4. Simulation Fallback

Used when `ANALYTICS_DATA_SOURCE != "bloomberg"` (default) or on any Bloomberg
failure.

### Seasonal MoM pattern (UK RPI, %)

```python
_SEASONAL_MOM_PCT = [
    +0.50, +0.40, +0.60, +0.20, +0.10, -0.10,
    -0.20, +0.10, +0.20, -0.20, -0.10, -0.30,
]  # Jan … Dec
```

UK RPI has a notable January spike (historically driven by mortgage payment
resets and post-Christmas price adjustments) and a December dip.

### Simulation parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| `annual_growth` | 3.1% | Approximate UK RPI trend |
| `start_level` | 285.0 | UKCERPI level ~4 years before today |
| `n_back` | 48 months | History depth generated |

---

## 5. Known Ticker Issues

### 5.1 UKRPIF/T are unverified synthetic tickers (PRIORITY)

`UKRPIF{n} Comdty` and `UKRPIT{n} Comdty` are marked `"verified": false` in
the catalogue. Bloomberg likely does **not** publish GBP RPI fixings in exactly
this calendar-month format.

**Live Bloomberg approach**: Use `BPSWIS{n} Curncy` (standard-tenor GBP RPI
zero-coupon swaps, `"verified": true` in catalogue) and interpolate to
calendar-month YoY rates, then reconstruct levels. This requires adding an
interpolation step between the BDP fetch and `_reconstruct_levels()`.

To verify in Bloomberg Terminal:
```python
from bbg import blp
snap = blp.bdp(["UKRPIF1 Comdty", "UKRPIF3 Comdty", "BPSWIS1 Curncy", "BPSWIS5 Curncy"], "PX_LAST")
print(snap)
# UKRPIF tickers: likely return NaN (unverified)
# BPSWIS tickers: should return GBP RPI swap rates
```

### 5.2 Haver tickers for sub-components

CPI Services, Core Goods, Energy, and Food have `ticker_haver: null` because
index level codes are unconfirmed. YoY rates may be available in Haver but are
not needed for reconstruction.

### 5.3 UK RPI vs CPIH distinction

UK inflation fixings settle on **RPI** (Retail Price Index), not CPI or CPIH.
RPI uses an arithmetic mean methodology and includes mortgage interest payments;
it typically runs ~1pp above CPI. The settlement index (`UKCERPI`) is the
**all-items RPI**, not RPIX (ex-mortgage interest).

---

## 6. How to Test

### 6.1 Simulation mode (no Bloomberg required)

```bash
source .venv/bin/activate
uvicorn backend.main:app --reload --port 8000
```

```bash
curl http://localhost:8000/api/tools/inflation-fixings/gbp \
  -H "Authorization: Bearer <token>" | python3 -m json.tool | head -60
```

Expected response structure:

```json
{
  "data_source": "simulation",
  "as_of_date": "2026-08-23",
  "last_known_rpi": 368.45,
  "rpi_history": [
    {"month": "2024-09", "level": 361.20},
    ...
  ],
  "fixings": [
    {
      "month_num": 8,
      "ticker": "UKRPIF8 Comdty",
      "calendar_month": "2027-08",
      "yoy_implied": 3.10,
      "level": 380.12,
      "mom_nsa": 0.200,
      "mom_sa": 0.090
    },
    ...
  ]
}
```

### 6.2 Sanity-check simulation values

```python
import sys; sys.path.insert(0, "backend")
from rpi_fixings import get_rpi_fixings

d = get_rpi_fixings()
print("Source:", d["data_source"])
print("Last known UKCERPI:", d["last_known_rpi"])
print(f"History: {len(d['rpi_history'])} months")

for f in d["fixings"][:3]:
    print(f"  {f['calendar_month']}  {f['ticker']:20s}  YoY={f['yoy_implied']:.2f}%  "
          f"Level={f['level']:.2f}  MoM NSA={f['mom_nsa']:+.3f}%")
```

Expected (simulation):
- `data_source`: `"simulation"`
- UKCERPI level: ~300–400 (Jan 1987=100 base; current ~380)
- YoY rates ~3.0–3.5%
- F-series: `UKRPIF1 Comdty` … `UKRPIF12 Comdty`
- T-series: `UKRPIT1 Comdty` … `UKRPIT12 Comdty`

### 6.3 Verify Bloomberg tickers (live mode)

With Bloomberg Terminal open:

```python
from bbg import blp
import pandas as pd

# Historical RPI level
start = (pd.Timestamp.today() - pd.DateOffset(months=12)).strftime("%Y%m%d")
end   = pd.Timestamp.today().strftime("%Y%m%d")
hist = blp.bdh("UKCERPI Index", "PX_LAST", start, end, periodicity="MONTHLY")
print("UKCERPI history:")
print(hist.tail(5))
# Expected: Jan 1987=100 base, current level ~370–390

# Live alternative — standard-tenor RPI swaps (these are verified)
bpswis = [f"BPSWIS{n} Curncy" for n in [1, 2, 3, 5, 7, 10, 15, 20, 25, 30]]
snap = blp.bdp(bpswis, "PX_LAST")
print("\nBPSWIS standard-tenor RPI swaps:")
print(snap)
# Expected: YoY rates ~2.5–4.5%; no NaN rows

# Synthetic F/T tickers — likely return NaN
f_tickers = [f"UKRPIF{n} Comdty" for n in range(1, 5)]
snap2 = blp.bdp(f_tickers, "PX_LAST")
print("\nUKRPIF synthetic tickers:")
print(snap2)
```

---

## 7. What Has To Be Added

### 7.1 Replace synthetic UKRPIF/T with BPSWIS interpolation (PRIORITY)

The live Bloomberg path currently tries to fetch `UKRPIF{n} Comdty` which are
unverified synthetic tickers. The correct live implementation:

1. Fetch `BPSWIS{n} Curncy` for standard tenors (1, 2, 3, 5, 7, 10, 15, 20, 25, 30y)
   via `BDP`.
2. Interpolate (linear or cubic spline) from standard tenors to the 24
   calendar-month forward dates.
3. Pass the interpolated YoY rates into `_reconstruct_levels()` with the same
   ticker key format as the current synthetic convention, or refactor to use
   date-keyed dicts instead of ticker strings.

The catalogue already documents this path under `fixings.live_bloomberg_alternative`.

### 7.2 Bloomberg live path for Historical subtab

Same as for EUR: the Historical subtab currently uses synthetic frontend data.
To wire live data, fetch all 7 `historical_series` tickers via BDH and add a
`historical_series` key to the API response.

### 7.3 Haver codes for sub-components

CPI Services (`UKRPCJSR Index`), Core Goods (`UKRPCJCG Index`), Energy
(`UKRPCJEN Index`), and Food (`UKRPCJFT Index`) index-level codes are marked
as unconfirmed in Haver. If Haver is used as a data source, verify whether
index levels (not just YoY rates) are available for these series and update
the catalogue accordingly.
