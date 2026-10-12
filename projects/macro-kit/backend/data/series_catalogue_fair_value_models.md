# series_catalogue_fair_value_models.json — Documentation

Catalogue for the **Fair Value Models** tool.  
Backend file: `backend/fair_value_models.py`

---

## 1. What Is In The Catalogue

### 1.0 This catalogue is read at runtime

Unlike most other tool catalogues (which are documentation only), **this catalogue
is loaded by `_fetch_live_data()` at server startup** to build `_BBG_RAW`,
`_REQUIRED_BBG`, and `_OPTIONAL_BBG`. To change a Bloomberg ticker, edit this
JSON — no Python change needed.

Each entry requires:
- `internal_key` — the key used throughout the Python computation code
- `bloomberg_ticker` — the Bloomberg string passed to `blp.bdh()`
- `treatment` — controls fallback behaviour (see below)

**Treatment values**:

| Value | Behaviour if absent |
|-------|-------------------|
| `"required"` | Any missing ticker triggers full simulation fallback |
| `"optional_zero"` | Series is zeroed; model assigns near-zero coefficient |
| `"optional_interp"` | Silently skipped; forward derivation falls back to interpolation |

The catalogue has **27 explicit entries** (no template notation). Every ticker
fetched at runtime must have its own entry here.

### 1.1 Series breakdown

| Role | Internal keys | Treatment |
|------|--------------|-----------|
| HICPxT swap outrights — model Y targets | `EUSWI1/2/5/10/20/30` | required |
| HICPxT swaps — forward derivation inputs only | `EUSWI3/4/15` | optional_interp |
| ESTR OIS par rates — X regressors | `EESWE1/2/5/10/20/30` | required |
| ESTR OIS — bootstrap inputs only | `EESWE3/4/15` | optional_interp |
| Core macro regressors | `Brent`, `Gas`, `BCOM_raw`, `EUR003M` | required |
| Optional macro regressors | `EUR_TWI`, `GSEAFCI`, `ITRX5Y`, `CESIEUR`, `SMOVEU1M` | optional_zero |

### Verified status

| Internal key | Bloomberg ticker | Verified |
|--------------|-----------------|----------|
| `EUSWI1`..`EUSWI30` | `EUSWI{n} Curncy` | ✅ |
| `EESWE1`..`EESWE30` | `EUSWF{n} Curncy` | ✅ |
| `EUR003M` | `EUR003M Index` | ✅ |
| `Brent` | `CO1 Comdty` | ✅ |
| `Gas` | `TTF1 Comdty` | ✅ |
| Bloomberg Commodity Index | `BCOM Index` | ✅ |
| EUR swaption vol 1m10y | `EUSV0001 Index` | ✅ |
| EUR trade-weighted index | `EURR002W Index` | ⚠️ unverified |
| GS Euro Area FCI | `GSEAFCI Index` | ⚠️ unverified + GS subscription required |
| iTraxx Europe 5Y | `ITRXEBE5 Index` | ⚠️ unverified |
| Citi Economic Surprise EUR | `CESIEUR Index` | ⚠️ unverified |

> **Note on GSEAFCI**: this series requires a Goldman Sachs data subscription. If
> the Bloomberg terminal does not have the GS feed, the series returns no data.
> The code handles this gracefully — `GSEAFCI` has `treatment: "optional_zero"` and is
> silently zeroed if absent. The model assigns a near-zero coefficient to it in
> that case.

Total Bloomberg tickers fetched at runtime: **27** (9 HICP + 9 ESTR + 4 macro
required + 5 macro optional, all with explicit catalogue entries).

---

## 2. Architecture

### Pre-computation at module load

Unlike the EGB RV and Swaps RV tools (which compute per request), the Fair Value
Models run the rolling Elastic Net **once at server startup** and cache all results
in a module-level dict `_RESULTS`. The API endpoint just returns `_RESULTS`.

This means:
- The first request is instant (no heavy computation on demand).
- **Changing the data source or date range requires a server restart.**
- If Bloomberg data is updated intraday, the server must be restarted to pick it up.

### Data source selection

Controlled by the `ANALYTICS_DATA_SOURCE` environment variable:

```
ANALYTICS_DATA_SOURCE=bloomberg  → attempts _fetch_live_data(); falls back to _simulate() on failure
ANALYTICS_DATA_SOURCE=<anything> → simulation only (default)
```

The code checks this at module import time (lines 800–816 of `fair_value_models.py`).

### High-level data flow

```
Module import
│
├─ ANALYTICS_DATA_SOURCE == "bloomberg"?
│     │
│     └─► _fetch_live_data("2004-01-01", today)
│               │
│               ├─ blp.bdh(22 tickers, "PX_LAST", start, end)
│               ├─ Drop rows where any _REQUIRED_BBG series is NaN
│               ├─ Convert rates to decimal (÷ 100)
│               ├─ Log-transform commodity prices
│               ├─ Bootstrap ESTR discount factors → 7 forward rates
│               ├─ Zero-coupon algebra → 7 HICPxT forward rates
│               └─ Return (vars_dict, DatetimeIndex)
│
└─ Fallback: _simulate() → vars_dict  (deterministic, seeded, 2004–2024)

For each of 14 model definitions:
    X = column_stack of x_keys from vars_dict
    y = y_key from vars_dict
    _RESULTS[model_id] = _rolling_elastic_net(X, y, feature_names)

get_fair_value_models_data() → {"groups", "model_ids", "models": _RESULTS, "data_source"}
```

---

## 3. Models

14 models in 2 groups, all using **Rolling Elastic Net** with the same
hyperparameters.

### Model definitions

**Group 1 — Outright HICPxT** (Y = spot zero-coupon inflation swap rate)

| Model ID | Y | Key regressors |
|----------|---|----------------|
| `hicp_1y` | EUSWI1 (1Y spot) | 1Y ESTR swap + full macro + EURIBOR 3M |
| `hicp_2y` | EUSWI2 (2Y spot) | 2Y ESTR swap + full macro + EURIBOR 3M |
| `hicp_5y` | EUSWI5 (5Y spot) | 5Y ESTR swap + full macro (no EURIBOR) |
| `hicp_10y` | EUSWI10 (10Y spot) | 10Y ESTR swap + full macro |
| `hicp_15y` | EUSWI15 (15Y spot) | 15Y ESTR swap + full macro |
| `hicp_20y` | EUSWI20 (20Y spot) | 20Y ESTR swap + full macro |
| `hicp_30y` | EUSWI30 (30Y spot) | 30Y ESTR swap + full macro |

**Group 2 — Forward HICPxT** (Y = bootstrapped forward inflation swap rate)

| Model ID | Y | Key regressors |
|----------|---|----------------|
| `hicp_1y1y` | HICP 1Y1Y forward | 1Y1Y ESTR fwd + full macro + EURIBOR 3M |
| `hicp_2y1y` | HICP 2Y1Y forward | 2Y1Y ESTR fwd + full macro + EURIBOR 3M |
| `hicp_2y2y` | HICP 2Y2Y forward | 2Y2Y ESTR fwd + full macro + EURIBOR 3M |
| `hicp_2y3y` | HICP 2Y3Y forward | 2Y3Y ESTR fwd + full macro (no EURIBOR) |
| `hicp_5y5y` | HICP 5Y5Y forward | 5Y5Y ESTR fwd + full macro |
| `hicp_10y10y` | HICP 10Y10Y forward | 10Y10Y ESTR fwd + macro + **swaption vol** (no Citi ESI) |
| `hicp_20y10y` | HICP 20Y10Y forward | 20Y10Y ESTR fwd + macro + **swaption vol** (no Citi ESI) |

**Regressor logic by tenor**:
- 1Y, 2Y outrights and 1Y1Y, 2Y1Y, 2Y2Y forwards: **include EURIBOR 3M** — policy rate anchor dominates the short end.
- 5Y+ outrights and 2Y3Y+ forwards: **drop EURIBOR 3M** — too far from policy horizon.
- 10Y10Y and 20Y10Y: **add swaption vol**, **drop Citi ESI** — at ultra-long tenors, rates volatility matters; macro newsflow surprises are less relevant.

### Rolling Elastic Net parameters

| Parameter | Value | Notes |
|-----------|-------|-------|
| `ROLL_WINDOW` | 500 | ~2 calendar years of training data |
| `MIN_WINDOW` | 252 | Minimum obs before first fit (~1y) |
| `FIT_STEP` | 1 | Refit every trading day |
| `alpha` | 0.01 | Regularisation strength |
| `l1_ratio` | 0.5 | Equal lasso + ridge penalty |
| Prediction | OOS | Train on [t−500, t−1]; predict t |

All features are **StandardScaler-normalised** before each fit.

---

## 4. Derived Series

These are not Bloomberg tickers — they are computed from raw fetched data.

### ESTR forward rates (7 series)

Bootstrapped per-row using OIS discount factors:

```
_estr_discount_factors(par_rates)  — cubic-spline gap-fill, then recursive bootstrap
_estr_fwd(D, s, t)                 — forward par OIS rate, start=s, tenor=t years
```

| Key | Forward |
|-----|---------|
| `ESTR_1Y1Y` | 1Y forward, 1Y tenor |
| `ESTR_2Y1Y` | 2Y forward, 1Y tenor |
| `ESTR_2Y2Y` | 2Y forward, 2Y tenor |
| `ESTR_2Y3Y` | 2Y forward, 3Y tenor |
| `ESTR_5Y5Y` | 5Y forward, 5Y tenor |
| `ESTR_10Y10Y` | 10Y forward, 10Y tenor |
| `ESTR_20Y10Y` | 20Y forward, 10Y tenor |

Requires EESWE1, EESWE2, EESWE3, EESWE4, EESWE5, EESWE10, EESWE15, EESWE20, EESWE30 as inputs. Any row with fewer than 4 tenors available is skipped and forward-filled.

### HICPxT forward rates (7 series)

Zero-coupon algebra: `((1+r_far)^(s+t) / (1+r_near)^s)^(1/t) - 1`

| Key | Near rate | Far rate |
|-----|-----------|----------|
| `HICP_1Y1Y` | EUSWI1 | EUSWI2 |
| `HICP_2Y1Y` | EUSWI2 | EUSWI3 |
| `HICP_2Y2Y` | EUSWI2 | EUSWI4 |
| `HICP_2Y3Y` | EUSWI2 | EUSWI5 |
| `HICP_5Y5Y` | EUSWI5 | EUSWI10 |
| `HICP_10Y10Y` | EUSWI10 | EUSWI20 |
| `HICP_20Y10Y` | EUSWI20 | EUSWI30 |

EUSWI3 and EUSWI4 are required for HICP_2Y1Y and HICP_2Y2Y respectively — this
is why `EUSWI3 Curncy` and `EUSWI4 Curncy` are in `_REQUIRED_BBG` even though
they are not model targets.

### 3M10Y slope

`slope_3m10y = EESWE10 - EUR003M` — the 10Y ESTR swap minus EURIBOR 3M. Used as
a curve steepness regressor in all models.

---

## 5. Output per Model

`_rolling_elastic_net()` returns a dict with:

| Field | Description |
|-------|-------------|
| `dates` | Date strings for all output rows |
| `actual` | Y values (decimal rate) |
| `fitted` | OOS model predictions (null before MIN_WINDOW) |
| `residuals` | `actual − fitted` (null before MIN_WINDOW) |
| `sigma1_hi/lo` | ±1σ band on residuals (252d rolling) |
| `sigma2_hi/lo` | ±2σ band on residuals (252d rolling) |
| `rolling_r2` | In-sample R² on training window |
| `oos_r2` | Rolling OOS R² (252d window) |
| `bench_r2` | Random-walk benchmark R² (252d window) |
| `coef_names` | Feature labels |
| `coef_series` | Time series of each rolling coefficient |
| `latest_coefs` | Most recent coefficient values |
| `scatter` | Residual vs forward returns (5/10/20/100 days) |
| `scatter_trend` | OLS trend lines for scatter plots |

Output is **subsampled by `OUTPUT_STEP`** (currently 1, so no subsampling). The
equity-curve-style charts use all dates.

---

## 6. Required vs Optional Bloomberg Series

### Required (`_REQUIRED_BBG`) — missing any → fall back to simulation

```
EUSWI1, EUSWI2, EUSWI5, EUSWI10, EUSWI20, EUSWI30   ← HICP outright targets
EESWE1, EESWE2, EESWE5, EESWE10, EESWE20, EESWE30   ← ESTR OIS regressors
Brent, Gas, BCOM_raw, EUR003M                         ← Core macro regressors
```

Note: EUSWI3, EUSWI4, EESWE3, EESWE4 are fetched but not in `_REQUIRED_BBG` —
they are only needed for the forward derivation and are silently skipped (with
forward-fill) if missing.

### Optional (`_OPTIONAL_BBG`) — zeroed if absent, no fallback triggered

```
EUR_TWI    → EURR002W Index   (ECB broad NEER)
GSEAFCI    → GSEAFCI Index    (GS FCI — needs GS subscription)
ITRX5Y     → ITRXEBE5 Index   (iTraxx Europe 5Y)
CESIEUR    → CESIEUR Index    (Citi ESI EUR)
SMOVEU1M   → EUSV0001 Index   (EUR 1m10y swaption vol)
```

The model assigns near-zero coefficients to zeroed optional series — the
Elastic Net lasso penalty actively shrinks irrelevant features.

---

## 7. How to Test

### 7.1 Simulation mode (no Bloomberg required)

Start the server without setting `ANALYTICS_DATA_SOURCE`:

```bash
source .venv/bin/activate
uvicorn backend.main:app --reload --port 8000
```

```bash
curl http://localhost:8000/api/tools/fair-value-models \
  -H "Authorization: Bearer <token>" | python3 -m json.tool | head -30
```

Expected response structure:

```json
{
  "data_source": "simulation",
  "groups": [
    {"id": "outright", "label": "Outright HICPxT", "model_ids": [...]},
    {"id": "forward",  "label": "Forward Swaps",   "model_ids": [...]}
  ],
  "model_ids": ["hicp_1y", "hicp_2y", ..., "hicp_20y10y"],
  "models": {
    "hicp_10y": {
      "title": "EUR 10Y HICPxT",
      "dates": ["2004-01-02", ...],
      "actual": [0.0212, ...],
      "fitted": [null, null, ..., 0.0198, ...],
      "residuals": [...],
      ...
    },
    ...
  }
}
```

`fitted` values are `null` for the first 252 rows (MIN_WINDOW).

### 7.2 Sanity-check simulation output

```python
import sys; sys.path.insert(0, "backend")
from fair_value_models import get_fair_value_models_data, data_source

d = get_fair_value_models_data()
print("Source:", data_source)

m = d["models"]["hicp_10y"]
# Find the first non-null fitted value
first_fitted = next(i for i, v in enumerate(m["fitted"]) if v is not None)
print(f"First OOS prediction at row {first_fitted} (date: {m['dates'][first_fitted]})")
print(f"Actual:  {m['actual'][first_fitted]:.4f}")
print(f"Fitted:  {m['fitted'][first_fitted]:.4f}")
print(f"Residual:{m['residuals'][first_fitted]:.4f}")

# Latest coefficients
print("\nLatest coefficients for hicp_10y:")
for name, coef in d["models"]["hicp_10y"]["latest_coefs"].items():
    print(f"  {name}: {coef:.4f}")
```

Expected (simulation): 10Y HICP around 1–3% (decimal 0.01–0.03), with the
`10Y Swap` coefficient dominant (~0.8) and commodity/macro coefficients smaller.

### 7.3 Test Bloomberg data fetch directly

```python
import sys; sys.path.insert(0, "backend")
from fair_value_models import _fetch_live_data
import pandas as pd

result = _fetch_live_data("2023-01-01", pd.Timestamp.today().strftime("%Y-%m-%d"))
if result is None:
    print("Bloomberg unavailable or data missing")
else:
    vars_dict, dates = result
    print(f"Fetched {len(dates)} business days")
    print(f"Keys: {list(vars_dict.keys())}")

    # Check HICP rates are in decimal (not %)
    print(f"EUSWI10 last: {vars_dict['EUSWI10'][-1]:.4f}  (expect ~0.02–0.03)")

    # Check forward rates computed correctly
    print(f"HICP_5Y5Y last: {vars_dict['HICP_5Y5Y'][-1]:.4f}  (expect ~0.02–0.025)")
    print(f"ESTR_5Y5Y last: {vars_dict['ESTR_5Y5Y'][-1]:.4f}  (expect ~0.015–0.025)")

    # Check optional series
    print(f"GSEAFCI last: {vars_dict['GSEAFCI'][-1]:.2f}  (0.0 if GS subscription absent)")
```

### 7.4 Activate Bloomberg mode and run full server

```bash
ANALYTICS_DATA_SOURCE=bloomberg uvicorn backend.main:app --reload --port 8000
```

Watch server logs on startup — you will see either:
- `[fair_value_models] ...` warnings for any missing optional series
- A clean start if all data loads

Check the response:

```bash
curl http://localhost:8000/api/tools/fair-value-models \
  -H "Authorization: Bearer <token>" \
  | python3 -m json.tool | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('data_source:', d['data_source'])
m = d['models']['hicp_10y']
# Last 5 actual vs fitted
for i in range(-5, 0):
    print(f'  {m[\"dates\"][i]}  actual={m[\"actual\"][i]:.4f}  fitted={m[\"fitted\"][i]}')"
```

### 7.5 Verify the 4 unverified optional tickers

With Bloomberg Terminal open:

```python
from bbg import blp
import pandas as pd

start = (pd.Timestamp.today() - pd.DateOffset(days=30)).strftime("%Y-%m-%d")
end   = pd.Timestamp.today().strftime("%Y-%m-%d")

optional = {
    "EURR002W Index": "EUR TWI — expect 95–115",
    "GSEAFCI Index":  "GS FCI — expect 98–103 (NaN if no GS sub)",
    "ITRXEBE5 Index": "iTraxx 5Y — expect 50–150 bps",
    "CESIEUR Index":  "Citi ESI EUR — expect −100 to +100",
}

df = blp.bdh(list(optional.keys()), "PX_LAST", start, end)
print(df.tail(5))
for ticker, note in optional.items():
    last = df[ticker]["PX_LAST"].dropna()
    print(f"{ticker}: last={float(last.iloc[-1]):.2f}  [{note}]" if len(last) else f"{ticker}: NO DATA")
```

---

## 8. What Has to Be Added

### 8.1 Verify the 4 optional tickers (PRIORITY)

Run the snippet in §7.5 above. For each ticker:
- `EURR002W Index`: check it is the ECB broad NEER (not bilateral EUR/USD). Typical range 95–115.
- `GSEAFCI Index`: if no GS subscription, accept that this stays zeroed. Flag to the team — the model still runs correctly.
- `ITRXEBE5 Index`: confirm this is the on-the-run 5Y iTraxx Europe series (not a specific series roll date). Typical range 50–150 bps.
- `CESIEUR Index`: confirm it is the Citi Economic Surprise Index for the Euro Area. Typical range −100 to +100.

Update `verified: true` in the catalogue for each ticker that passes.

### 8.2 No Haver tickers — not applicable

All inputs are **daily market prices** (swap rates, commodity futures, FX, credit
indices). Haver does not carry these. All `ticker_haver` fields in the catalogue
are null by design.

### 8.3 No runtime date filtering

The tool always returns the full history (2004–today from Bloomberg; 2004–2024
from simulation). There is no `?date=` parameter. If the team wants to add one,
`get_fair_value_models_data()` would need to accept a cutoff and slice `_RESULTS`
accordingly. This would require per-request computation or pre-slicing at startup.

### 8.4 EUSWI3/4 and EUSWF3/4 gap in catalogue

The catalogue template covers tenors `[1, 2, 3, 4, 5, 10, 15, 20, 30]` so
EUSWI3/EUSWI4 and EUSWF3/EUSWF4 are technically listed — but their role is
intermediate (forward derivation only, not model targets). If anyone reads the
catalogue and wonders why 3Y and 4Y are not model outputs, this is why:
they are used only as inputs to `HICP_2Y1Y` and `HICP_2Y2Y`.
