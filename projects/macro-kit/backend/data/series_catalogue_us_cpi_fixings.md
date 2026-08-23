# series_catalogue_us_cpi_fixings.json — Documentation

Catalogue for the **Inflation Fixings Monitor — United States** tab.  
Backend file: `backend/us_cpi_fixings.py`  
API route: `GET /api/tools/inflation-fixings/usd`

---

## 1. What Is In The Catalogue

The catalogue is the **single source of truth** for all tickers consumed by
`us_cpi_fixings.py`. The module reads tickers directly from this file at import
time — nothing is hardcoded in the Python.

### 1.1 Historical series (5 entries)

Fetched via `BDH` (time series). Only `usd_cpi_nsa` is used for level
reconstruction; the others are displayed on the Historical subtab.

| ID | Label | Bloomberg ticker | Haver ticker | Base? |
|----|-------|-----------------|--------------|-------|
| `usd_cpi_nsa` | CPI (NSA) | `CPURNSA Index` | `CPIU@USECON` | **Yes** |
| `usd_cpi_sa` | CPI (SA) | `CPIAUCSL Index` | `CPIUS@USECON` | |
| `usd_cpi_core` | Core CPI | `CPUPAXFE Index` | `CPIXFE@USECON` | |
| `usd_cpi_core_goods` | Core Goods | `CPUPAXFEG Index` | null | |
| `usd_cpi_core_services` | Core Services | `CPUPAXFES Index` | null | |

**Haver**: NSA, SA, and Core CPI have confirmed Haver codes. Core Goods
(`CPIXFEG@USECON`) and Core Services (`CPIXFES@USECON`) are listed as
unconfirmed — check in Haver before using.

**CPI SA in simulation**: In live Bloomberg mode, `CPIAUCSL Index` is fetched
directly. In simulation, CPI SA is derived from the simulated NSA series via
STL decomposition in the frontend — the backend only returns NSA and forward
fixings.

### 1.2 Fixings

Fetched via `BDP` (snapshot, current price). Bloomberg `PX_LAST` returns the
**%YoY implied rate**, not a raw index level.

| Series | Ticker template | Tenors | Verified? |
|--------|----------------|--------|-----------|
| F-series | `USCPIF{n} Comdty` | 1–12 | No — synthetic |
| T-series | `USCPIT{n} Comdty` | 1–12 | No — synthetic |
| Live alternative | `USSWIT{n} Curncy` | 1–10, 15, 20, 25, 30y | **Yes** |

**Important**: `USCPIF{n}` and `USCPIT{n}` are a **synthetic convention** for
this tool — Bloomberg does not publish calendar-month USD CPI fixings in this
format. In live Bloomberg mode, the correct approach is to use
`USSWIT{n} Curncy` (USD CPI NSA zero-coupon inflation swaps, standard tenors)
and interpolate to calendar-month YoY rates.

**Base for reconstruction** (`history_base_id`): `usd_cpi_nsa`  
→ `CPURNSA Index` (US CPI All Urban Consumers, NSA, 1982-84=100) is the
settlement index for USD CPI inflation swaps.

---

## 2. Architecture

### Catalogue loading (module import)

```python
_CAT_PATH = Path(__file__).parent / "data" / "series_catalogue_us_cpi_fixings.json"
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
GET /api/tools/inflation-fixings/usd
│
├─► _bloomberg_cpi_history(n_months=48)               [BDH — if Bloomberg]
│       blp.bdh("CPURNSA Index", "PX_LAST", start, end, periodicity="MONTHLY")
│       Returns pd.Series indexed by month-start timestamps
│       → Falls back to _sim_cpi_history() if None/empty
│
├─► _seasonal_factors(hist)
│       Average MoM % by calendar month over full history
│       Used as additive correction: MoM SA ≈ MoM NSA − factor[month]
│
├─► _bloomberg_yoy_rates()                            [BDP — if Bloomberg]
│       blp.bdp(USCPIF1..12 + USCPIT1..12, "PX_LAST")
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

Bloomberg returns `PX_LAST` on USD CPI swap tickers as a **YoY rate** (%).
The reconstruction converts rates back to NSA index levels.

### F-series (months 1–12)

```
Level_F(t) = CPURNSA_hist[t − 12mo] × (1 + YoY_F(t) / 100)
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

Seasonal factors are derived from trailing `CPURNSA` history, not hardcoded.
The `mom_sa` values in the response are an approximation — the official BLS
seasonal adjustment uses X-13ARIMA-SEATS, not a simple historical average.

---

## 4. Simulation Fallback

Used when `ANALYTICS_DATA_SOURCE != "bloomberg"` (default) or on any Bloomberg
failure.

### Seasonal MoM pattern (US CPI NSA, %)

```python
_SEASONAL_MOM_PCT = [
    +0.20, +0.30, +0.55, +0.40, +0.25, +0.15,
    +0.00, -0.05, +0.10, +0.00, -0.30, -0.60,
]  # Jan … Dec
```

US CPI NSA has a spring seasonal bump (Mar–Apr) and December deflation.
The pattern is calibrated to BLS-observed NSA seasonality.

### Simulation parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| `annual_growth` | 2.8% | Approximate US CPI NSA trend |
| `start_level` | 168.0 | CPURNSA level circa Jan 2000 (1982-84=100 base) |
| `n_back` | 48 months | History depth generated |

---

## 5. Known Ticker Issues

### 5.1 USCPIF/T are unverified synthetic tickers (PRIORITY)

`USCPIF{n} Comdty` and `USCPIT{n} Comdty` are marked `"verified": false` in
the catalogue. Bloomberg likely does **not** publish USD CPI fixings in
calendar-month format under these ticker names.

**Live Bloomberg approach**: Use `USSWIT{n} Curncy` (USD CPI NSA zero-coupon
inflation swaps, standard tenors, `"verified": true` in catalogue) and
interpolate to calendar-month YoY rates.

To verify in Bloomberg Terminal:
```python
from bbg import blp
snap = blp.bdp(["USCPIF1 Comdty", "USCPIF3 Comdty", "USSWIT1 Curncy", "USSWIT5 Curncy"], "PX_LAST")
print(snap)
# USCPIF tickers: likely return NaN (unverified)
# USSWIT tickers: should return USD CPI swap rates
```

### 5.2 CPURNSA vs CPIAUCSL — NSA is the settlement index

USD CPI inflation swaps settle on **CPURNSA** (All Urban Consumers, Not
Seasonally Adjusted), not the seasonally adjusted series (CPIAUCSL). The
reconstruction uses NSA throughout. The SA series is displayed on the
Historical subtab for analytical context only.

### 5.3 Core Goods and Core Services Haver codes unconfirmed

`CPUPAXFEG Index` (Core Goods) and `CPUPAXFES Index` (Core Services) do not
have confirmed Haver codes. `CPIXFEG@USECON` and `CPIXFES@USECON` are
suggested but need verification. If Haver is used as a secondary data source,
confirm these codes return index levels (not YoY rates).

---

## 6. How to Test

### 6.1 Simulation mode (no Bloomberg required)

```bash
source .venv/bin/activate
uvicorn backend.main:app --reload --port 8000
```

```bash
curl http://localhost:8000/api/tools/inflation-fixings/usd \
  -H "Authorization: Bearer <token>" | python3 -m json.tool | head -60
```

Expected response structure:

```json
{
  "data_source": "simulation",
  "as_of_date": "2026-08-23",
  "last_known_cpi": 312.45,
  "cpi_history": [
    {"month": "2024-09", "level": 308.10},
    ...
  ],
  "fixings": [
    {
      "month_num": 8,
      "ticker": "USCPIF8 Comdty",
      "calendar_month": "2027-08",
      "yoy_implied": 2.80,
      "level": 321.22,
      "mom_nsa": 0.183,
      "mom_sa": -0.017
    },
    ...
  ]
}
```

### 6.2 Sanity-check simulation values

```python
import sys; sys.path.insert(0, "backend")
from us_cpi_fixings import get_us_cpi_fixings

d = get_us_cpi_fixings()
print("Source:", d["data_source"])
print("Last known CPURNSA:", d["last_known_cpi"])
print(f"History: {len(d['cpi_history'])} months, "
      f"{d['cpi_history'][0]['month']} → {d['cpi_history'][-1]['month']}")

print("\nFirst 3 fixings:")
for f in d["fixings"][:3]:
    print(f"  {f['calendar_month']}  {f['ticker']:22s}  YoY={f['yoy_implied']:.2f}%  "
          f"Level={f['level']:.2f}  MoM NSA={f['mom_nsa']:+.3f}%  MoM SA={f['mom_sa']:+.3f}%")

print("\nLast 3 fixings (T-series):")
for f in d["fixings"][-3:]:
    print(f"  {f['calendar_month']}  {f['ticker']:22s}  YoY={f['yoy_implied']:.2f}%  Level={f['level']:.2f}")
```

Expected (simulation):
- `data_source`: `"simulation"`
- CPURNSA level: ~300–330 (1982-84=100 base; actual ~320 as of 2026)
- All 24 fixings have non-null `level`, `mom_nsa`, `mom_sa`
- YoY rates ~2.5–3.0%
- F-series: `USCPIF1 Comdty` … `USCPIF12 Comdty`
- T-series: `USCPIT1 Comdty` … `USCPIT12 Comdty`

### 6.3 Verify Bloomberg tickers (live mode)

With Bloomberg Terminal open:

```python
from bbg import blp
import pandas as pd

# Historical NSA CPI — the reconstruction base
start = (pd.Timestamp.today() - pd.DateOffset(months=12)).strftime("%Y%m%d")
end   = pd.Timestamp.today().strftime("%Y%m%d")
hist = blp.bdh("CPURNSA Index", "PX_LAST", start, end, periodicity="MONTHLY")
print("CPURNSA history:")
print(hist.tail(5))
# Expected: 1982-84=100 base, current level ~310–330

# Live alternative — standard-tenor USD CPI swaps (these are verified)
usswit = [f"USSWIT{n} Curncy" for n in [1, 2, 3, 5, 7, 10, 15, 20, 25, 30]]
snap = blp.bdp(usswit, "PX_LAST")
print("\nUSSWIT standard-tenor CPI swaps:")
print(snap)
# Expected: YoY rates ~2.0–3.5%; no NaN rows

# Synthetic F/T tickers — likely return NaN
f_tickers = [f"USCPIF{n} Comdty" for n in range(1, 5)]
snap2 = blp.bdp(f_tickers, "PX_LAST")
print("\nUSCPIF synthetic tickers:")
print(snap2)

# Historical series for the Historical subtab
hist_tickers = ["CPURNSA Index", "CPIAUCSL Index", "CPUPAXFE Index",
                "CPUPAXFEG Index", "CPUPAXFES Index"]
hist_all = blp.bdh(hist_tickers, "PX_LAST", start, end, periodicity="MONTHLY")
print("\nAll historical series:")
print(hist_all.tail(3))
```

### 6.4 Test full live run

```bash
ANALYTICS_DATA_SOURCE=bloomberg uvicorn backend.main:app --reload --port 8000
```

```bash
curl http://localhost:8000/api/tools/inflation-fixings/usd \
  -H "Authorization: Bearer <token>" \
  | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('data_source:', d['data_source'])
print('Last CPURNSA:', d['last_known_cpi'])
for f in d['fixings'][:3]:
    print(f['calendar_month'], f['ticker'], 'YoY=', f['yoy_implied'])
"
```

---

## 7. What Has To Be Added

### 7.1 Replace synthetic USCPIF/T with USSWIT interpolation (PRIORITY)

Same issue as GBP: the live Bloomberg path tries `USCPIF{n}` which are
unverified synthetics. The correct live implementation:

1. Fetch `USSWIT{n} Curncy` for standard tenors (1, 2, 3, 5, 7, 10, 15, 20,
   25, 30y) via `BDP`.
2. Interpolate to calendar-month YoY rates (e.g. linear between adjacent tenor
   points, or cubic spline for smoother curve).
3. Pass interpolated rates into `_reconstruct_levels()`.

The catalogue already documents this path under `fixings.live_bloomberg_alternative`.

### 7.2 Bloomberg live path for Historical subtab

The Historical subtab currently uses synthetic frontend data. To wire live data:
1. Fetch all 5 `historical_series` tickers via `BDH` in the backend.
2. Add a `historical_series` key to the API response containing the level
   history for each series.
3. Note: CPI SA (`CPIAUCSL`) is fetched directly from Bloomberg in live mode.
   In simulation, the frontend derives it from NSA via STL decomposition.

### 7.3 MoM SA methodology

The current seasonal adjustment uses a simple historical-average MoM factor
per calendar month. The official BLS SA uses X-13ARIMA-SEATS. For a closer
approximation, apply BLS seasonal adjustment factors (published monthly by BLS)
rather than computing factors from CPURNSA history. These are available from
BLS at `https://www.bls.gov/cpi/research-series/` or via Bloomberg
`CPURNSA Index` field `SEAS_ADJ_FACTOR`.

### 7.4 Haver codes for Core Goods and Core Services

`CPUPAXFEG Index` and `CPUPAXFES Index` do not have confirmed Haver codes.
Verify `CPIXFEG@USECON` and `CPIXFES@USECON` return index levels (not YoY
rates) before adding them to the catalogue.
