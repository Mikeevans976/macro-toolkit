# series_catalogue_hicp_fixings.json — Documentation

Catalogue for the **Inflation Fixings Monitor — Euro Area** tab.  
Backend file: `backend/hicp_fixings.py`  
API route: `GET /api/tools/inflation-fixings/eur`

---

## 1. What Is In The Catalogue

The catalogue is the **single source of truth** for all tickers consumed by
`hicp_fixings.py`. The module reads tickers directly from this file at import
time — nothing is hardcoded in the Python.

### 1.1 Historical series (7 entries)

Fetched via `BDH` (time series). Only `eur_hicp_xt` is used for level
reconstruction; the others are displayed on the Historical subtab.

| ID | Label | Bloomberg ticker | Haver ticker | Base? |
|----|-------|-----------------|--------------|-------|
| `eur_hicp_headline` | HICP Headline | `EUHICP Index` | null | |
| `eur_hicp_xt` | HICP ex Tobacco | `EUHICPXT Index` | null | **Yes** |
| `eur_hicp_core` | HICP Core | `EUHICPXFE Index` | null | |
| `eur_hicp_core_goods` | Core Goods | `EUHICPIG Index` | null | |
| `eur_hicp_services` | Services | `EUHICPSER Index` | null | |
| `eur_hicp_energy` | HICP Energy | `EUHICPEN Index` | null | |
| `eur_hicp_food` | Food incl. A&T | `EUHICPF Index` | null | |

**Haver**: All entries have `ticker_haver: null`. Haver carries YoY rates for
most of these (e.g. `CPIEZM@EUDATA` for headline, `CPIEZXFE@EUDATA` for core)
but **not index levels**. This tool requires levels for reconstruction, so
Bloomberg is the only viable source.

### 1.2 Fixings

Fetched via `BDP` (snapshot, current price). Bloomberg `PX_LAST` returns the
**%YoY implied rate**, not a raw index level.

| Series | Ticker template | Tenors | Verified? |
|--------|----------------|--------|-----------|
| F-series | `EUSWIF{n} Comdty` | 1–12 | Yes |
| T-series | `EUSWIT{n} Comdty` | 1–12 | Yes |

- **F-series** covers the 12 calendar months starting ~1 year ahead of today.
  `n` = calendar month (1=Jan … 12=Dec).
- **T-series** covers the following 12-month cycle.

**Base for reconstruction** (`history_base_id`): `eur_hicp_xt`  
→ `EUHICPXT Index` is the settlement index for all EUR HICPxT inflation swaps.

---

## 2. Architecture

### Catalogue loading (module import)

```python
_CAT_PATH = Path(__file__).parent / "data" / "series_catalogue_hicp_fixings.json"
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
GET /api/tools/inflation-fixings/eur
│
├─► _bloomberg_hicp_xt_history(n_months=48)           [BDH — if Bloomberg]
│       blp.bdh("EUHICPXT Index", "PX_LAST", start, end, periodicity="MONTHLY")
│       Returns pd.Series indexed by month-start timestamps
│       → Falls back to _sim_hicp_xt_history() if None/empty
│
├─► _seasonal_factors(hist)
│       Average MoM % by calendar month over full history
│       Used as additive correction: MoM SA ≈ MoM NSA − factor[month]
│
├─► _bloomberg_yoy_rates()                            [BDP — if Bloomberg]
│       blp.bdp(EUSWIF1..12 + EUSWIT1..12, "PX_LAST")
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
This convention assumes the market quotes the 12-month cycle starting one year
from now (F-series) and the following year (T-series).

---

## 3. Level Reconstruction Methodology

Bloomberg EUSWIF/T tickers return a **YoY rate** (%), not an index level.
The reconstruction converts rates back to levels using historical EUHICPXT data.

### F-series (months 1–12)

```
Level_F(t) = EUHICPXT_hist[t − 12mo] × (1 + YoY_F(t) / 100)
```

The base is always a **known historical level** — requires at least 12 months
of `EUHICPXT` history. The module fetches 48 months to be safe.

### T-series (months 13–24)

```
Level_T(t) = Level_F[t − 12mo] × (1 + YoY_T(t) / 100)
```

The base is the **reconstructed F-series level**, not historical data.
Error in F-series propagates into T-series.

### MoM calculations

```
MoM NSA(t) = (Level(t) / Level(t−1) − 1) × 100
MoM SA(t)  = MoM NSA(t) − seasonal_factor[calendar_month(t)]
```

Seasonal factors are derived from trailing `EUHICPXT` history (48 months),
not hardcoded. In simulation mode, the simulated history produces the factors.

---

## 4. Simulation Fallback

Used when `ANALYTICS_DATA_SOURCE != "bloomberg"` (default) or on any Bloomberg
failure.

### Seasonal MoM pattern (HICP-XT, %)

```python
_SEASONAL_MOM_PCT = [
    -0.55, -0.20, +0.55, +0.40, +0.10, +0.05,
    -0.30, -0.20, +0.15, -0.05, +0.00, +0.05,
]  # Jan … Dec
```

Calibrated to Euro Area observed seasonality. Zero-mean (no long-run drift
from seasonal alone).

### Simulation parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| `annual_growth` | 2.1% | Approximate EUR HICP-XT trend |
| `start_level` | 130.0 | EUHICPXT level ~4 years before today |
| `n_back` | 48 months | History depth generated |

The simulation is **deterministic** given the same inputs — the same server
restart always produces the same chart.

---

## 5. Known Ticker Issues

### 5.1 F/T-series are verified Bloomberg tickers

`EUSWIF{n} Comdty` and `EUSWIT{n} Comdty` are **confirmed active** in
Bloomberg (`"verified": true` in catalogue). These are the standard EUR HICPxT
calendar-month fixings instruments.

### 5.2 No Haver tickers for index levels

All `ticker_haver` fields are `null`. Haver publishes YoY rates but not the
index levels required for reconstruction. This is a permanent limitation —
Bloomberg is the required data source for live mode.

### 5.3 HICP headline vs HICPxT

The reconstruction uses `EUHICPXT` (ex-tobacco) as the base, because all EUR
inflation swaps settle against HICPxT, not the headline index. The headline
(`EUHICP Index`) is displayed on the Historical subtab for context only.

---

## 6. How to Test

### 6.1 Simulation mode (no Bloomberg required)

```bash
source .venv/bin/activate
uvicorn backend.main:app --reload --port 8000
```

```bash
curl http://localhost:8000/api/tools/inflation-fixings/eur \
  -H "Authorization: Bearer <token>" | python3 -m json.tool | head -60
```

Expected response structure:

```json
{
  "data_source": "simulation",
  "as_of_date": "2026-08-23",
  "last_known_hicp_xt": 138.42,
  "hicp_xt_history": [
    {"month": "2024-09", "level": 136.10},
    ...
  ],
  "fixings": [
    {
      "month_num": 8,
      "ticker": "EUSWIF8 Comdty",
      "calendar_month": "2027-08",
      "yoy_implied": 2.15,
      "level": 141.22,
      "mom_nsa": 0.183,
      "mom_sa": 0.023
    },
    ...
  ]
}
```

### 6.2 Sanity-check simulation values

```python
import sys; sys.path.insert(0, "backend")
from hicp_fixings import get_hicp_fixings

d = get_hicp_fixings()
print("Source:", d["data_source"])
print("Last known EUHICPXT:", d["last_known_hicp_xt"])
print(f"History: {len(d['hicp_xt_history'])} months, "
      f"{d['hicp_xt_history'][0]['month']} → {d['hicp_xt_history'][-1]['month']}")

print("\nFirst 3 fixings:")
for f in d["fixings"][:3]:
    print(f"  {f['calendar_month']}  {f['ticker']:20s}  YoY={f['yoy_implied']:.2f}%  "
          f"Level={f['level']:.2f}  MoM NSA={f['mom_nsa']:+.3f}%  MoM SA={f['mom_sa']:+.3f}%")

print("\nLast 3 fixings (T-series):")
for f in d["fixings"][-3:]:
    print(f"  {f['calendar_month']}  {f['ticker']:20s}  YoY={f['yoy_implied']:.2f}%  Level={f['level']:.2f}")
```

Expected (simulation):
- `data_source`: `"simulation"`
- EUHICPXT level: ~130–150 (index 2015=100)
- All 24 fixings have non-null `level`, `mom_nsa`, `mom_sa`
- YoY rates ~2.0–2.5%
- F-series tickers: `EUSWIF1 Comdty` … `EUSWIF12 Comdty`
- T-series tickers: `EUSWIT1 Comdty` … `EUSWIT12 Comdty`

### 6.3 Verify Bloomberg tickers (live mode)

With Bloomberg Terminal open:

```python
from bbg import blp
import pandas as pd

# Historical level — should return monthly data
start = (pd.Timestamp.today() - pd.DateOffset(months=12)).strftime("%Y%m%d")
end   = pd.Timestamp.today().strftime("%Y%m%d")
hist = blp.bdh("EUHICPXT Index", "PX_LAST", start, end, periodicity="MONTHLY")
print("EUHICPXT history:")
print(hist.tail(5))
# Expected: 2015=100 base, current level ~130–145

# Forward fixings snapshot
f_tickers = [f"EUSWIF{n} Comdty" for n in range(1, 13)]
t_tickers = [f"EUSWIT{n} Comdty" for n in range(1, 13)]
snap = blp.bdp(f_tickers + t_tickers, "PX_LAST")
print("\nFixing snapshot:")
print(snap)
# Expected: YoY rates ~1.5–3.0%; no NaN rows
```

### 6.4 Test full live run

```bash
ANALYTICS_DATA_SOURCE=bloomberg uvicorn backend.main:app --reload --port 8000
```

```bash
curl http://localhost:8000/api/tools/inflation-fixings/eur \
  -H "Authorization: Bearer <token>" \
  | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('data_source:', d['data_source'])
print('Last EUHICPXT:', d['last_known_hicp_xt'])
for f in d['fixings'][:3]:
    print(f['calendar_month'], f['ticker'], 'YoY=', f['yoy_implied'])
"
```

---

## 7. What Has To Be Added

### 7.1 Bloomberg live path for historical series subtab (PRIORITY)

The Historical subtab displays 7 HICP series (headline, core, services, etc.).
Currently, the backend `/api/tools/inflation-fixings/eur` endpoint only returns
`hicp_xt_history` (the reconstruction base). The other 6 series
(`EUHICP`, `EUHICPXFE`, `EUHICPIG`, `EUHICPSER`, `EUHICPEN`, `EUHICPF`)
are rendered using **hardcoded synthetic data** in the frontend.

To wire live data for the Historical subtab:
1. Add a `historical_series` key to the API response, fetching all 7 tickers
   from `historical_series` in the catalogue via `BDH`.
2. Update the frontend `EurHistorical` component to consume the live data.

### 7.2 Haver tickers — not applicable

All Haver codes are `null` by design (Haver carries YoY, not levels). No action
needed unless the tool is redesigned to use YoY rates from Haver and reconstruct
levels differently.

### 7.3 T-series error propagation

If any F-series level is `None` (e.g. a Bloomberg gap for that calendar month),
the corresponding T-series fixing 12 months later will also be `None` because
its base level is missing. This is by design but worth noting — a gap in
F-series silently creates a gap in T-series.
