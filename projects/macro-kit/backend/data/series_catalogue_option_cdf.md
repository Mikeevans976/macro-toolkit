# series_catalogue_option_cdf.json — Documentation

Catalogue for the **Option-Implied CDF** tool.  
Backend file: `backend/option_derived_cdf.py`  
API route: `GET /api/tools/option-cdf?ccy={USD|EUR|GBP}&tail={1y|2y|5y|10y|15y|20y|30y}`

---

## 1. What Is In The Catalogue

The catalogue defines 6 series across 3 currencies (USD, EUR, GBP):

| ID | Description | Bloomberg template | Verified |
|----|-------------|-------------------|----------|
| `usd_par_swap_rates` | USD par swap rates | `USSW{t} Curncy` | Yes |
| `eur_par_swap_rates` | EUR par swap rates | `EUSA{t} Curncy` | Yes |
| `gbp_par_swap_rates` | GBP par swap rates | `BPSWS{t} Curncy` | Yes |
| `usd_swaption_atm_vol` | USD ATM swaption vols | `USSN{exp}{tail} Curncy` | No |
| `eur_swaption_atm_vol` | EUR ATM swaption vols | `EUSN{exp}{tail} Curncy` | No |
| `gbp_swaption_atm_vol` | GBP ATM swaption vols | `BPSN{exp}{tail} Curncy` | No |

### Swap rate tenors (all 3 currencies)

1y, 2y, 5y, 10y, 15y, 20y, 30y — fetched via `BDH PX_LAST`, last value taken.

### Swaption vol expiry × tail matrix

Valid expiries: `1M, 3M, 6M, 1Y, 2Y, 3Y, 5Y, 7Y, 10Y`  
Valid tails: `1Y, 2Y, 5Y, 10Y, 15Y, 20Y, 30Y`

Bloomberg returns ATM normal implied vol in **bp/yr**. The backend converts to
**% at expiry** before returning to the frontend:

```
vol_pct_at_expiry = (bp_per_yr / 100) × √T_expiry_years
```

### Swaption tickers are unverified

The `{prefix}N{exp}{tail}` convention (e.g. `USSN6M10Y Curncy`,
`EUSN1Y5Y Curncy`, `BPSN3M30Y Curncy`) is marked `"verified": false`. Confirm
each ticker returns data in Bloomberg Terminal before relying on live mode.

---

## 2. Architecture

### Data flow

```
GET /api/tools/option-cdf?ccy=USD&tail=10y
    ↓
option_derived_cdf.get_option_cdf_params(ccy="USD", tail="10y")
    │
    ├── if ANALYTICS_DATA_SOURCE == "bloomberg":
    │       _fetch_swap_rates("USD")
    │           blp.bdh(USSW1..USSW30, "PX_LAST", last 5 days)
    │           → forward rates from par swap curve
    │       _fetch_swaption_vols("USD", "10y")
    │           blp.bdh(USSN1M10Y..USSN10Y10Y, "PX_LAST", last 5 days)
    │           → annual vol in bp/yr, converted to % at expiry
    │
    └── fallback (simulation):
            static tables _FWD_RATE and _ANNUAL_VOL
            (mid-2025 calibration, hardcoded in option_derived_cdf.py)
    │
    └── skew: _BASE_SKEW[ccy] − 0.08 × √T_expiry
              (negative, decays with expiry — see §3)
    │
    └── Response: {ccy, tail, data_source, params: {expiry → {forward, vol, skew}}}
```

### What the backend provides vs what the frontend computes

| | Backend | Frontend |
|--|---------|----------|
| Forward swap rate | ✓ | |
| ATM vol (% at expiry) | ✓ | |
| Skew (γ₁ approx.) | ✓ | |
| Gram-Charlier distribution | | ✓ |
| CDF / PDF rendering | | ✓ |
| Rate scenarios / quantiles | | ✓ |

The backend is a thin data provider. All option math (Gram-Charlier expansion,
CDF construction, quantile extraction) runs entirely in the browser.

### Per-request computation

Unlike the heatmap tools (which pre-compute at startup), this endpoint runs
Bloomberg fetches **on each request**. There is no caching. Response latency
depends on Bloomberg API round-trip time (~1–3s).

---

## 3. Simulation Fallback

Static calibration tables baked into `option_derived_cdf.py` (mid-2025 levels):

### Forward rates by currency and tail

| Tail | USD | EUR | GBP |
|------|-----|-----|-----|
| 1y | 4.65% | 2.20% | 3.90% |
| 2y | 4.45% | 2.25% | 3.95% |
| 5y | 4.35% | 2.45% | 4.05% |
| 10y | 4.50% | 2.60% | 4.20% |
| 15y | 4.60% | 2.70% | 4.30% |
| 20y | 4.65% | 2.75% | 4.35% |
| 30y | 4.70% | 2.80% | 4.40% |

### Annual vol by currency and tail

| Tail | USD | EUR | GBP |
|------|-----|-----|-----|
| 1y | 1.20% | 0.85% | 1.05% |
| 2y | 1.00% | 0.75% | 0.90% |
| 5y | 0.85% | 0.65% | 0.78% |
| 10y | 0.75% | 0.60% | 0.70% |
| 15y | 0.70% | 0.57% | 0.65% |
| 20y | 0.67% | 0.55% | 0.62% |
| 30y | 0.65% | 0.52% | 0.60% |

### Skew heuristic

```
skew(ccy, T_expiry) = base_skew[ccy] − 0.08 × √T_expiry
```

| Currency | Base skew |
|----------|-----------|
| USD | −0.45 |
| EUR | −0.30 |
| GBP | −0.40 |

Skew is negative (left-skewed distribution — market prices tail risk of rates
falling more than rising). The magnitude decays with expiry horizon. These are
approximate heuristics for simulation mode only; live mode derives skew from
the vol surface slope between OTM strikes.

---

## 4. Known Issues

### 4.1 Swaption vol tickers unverified (PRIORITY)

`USSN`, `EUSN`, `BPSN` prefix tickers are marked `"verified": false`. The
specific format `{prefix}N{expiry}{tail}` needs to be confirmed in Bloomberg
Terminal. Common issues:

- Expiry/tail separator may differ (e.g. `USSN6M10Y` vs `USSN6M 10Y`)
- Some expiry/tail combinations may not trade (e.g. very short expiry × very
  long tail)
- Normal vs lognormal vol convention — confirm Bloomberg returns **normal**
  (not lognormal/Black) vols for these tickers

To verify:
```python
from bbg import blp
snap = blp.bdp(["USSN6M10Y Curncy", "USSN1Y5Y Curncy", "EUSN3M10Y Curncy"], "PX_LAST")
print(snap)
# Expected: values in range 50–200 bp/yr for normal ATM vol
```

### 4.2 Skew is a heuristic, not market-derived

In live mode the backend currently does not fetch OTM swaption vols to compute
a market-implied skew. The same heuristic formula is used for both simulation
and Bloomberg mode. To use market skew in live mode, add fetches for 25-delta
receiver and payer swaption vols and compute the vol surface slope.

### 4.3 No caching — Bloomberg latency per request

Every API call triggers a live Bloomberg fetch. For a UI that re-queries on
currency/tail change, this can produce noticeable latency. Consider caching
the swap curve and vol surface with a short TTL (e.g. 5 minutes).

### 4.4 Gram-Charlier validity bounds

The Gram-Charlier expansion (used in the frontend) is only a valid density for
small values of skew (γ₁) and excess kurtosis (γ₂). Large skew values can
produce negative probability densities. The backend skew heuristic keeps values
in the range −0.45 to −0.1, which is generally safe, but live market conditions
(e.g. crisis vol spikes) could push values outside valid bounds.

---

## 5. How to Test

### 5.1 Simulation mode

```bash
source .venv/bin/activate && uvicorn backend.main:app --reload --port 8000
```

```bash
curl "http://localhost:8000/api/tools/option-cdf?ccy=USD&tail=10y" \
  -H "Authorization: Bearer <token>" | python3 -m json.tool
```

Expected response:

```json
{
  "ccy": "USD",
  "tail": "10y",
  "data_source": "simulation",
  "params": {
    "1m": {"forward": 4.50, "vol": 0.087, "skew": -0.434},
    "3m": {"forward": 4.50, "vol": 0.150, "skew": -0.414},
    "6m": {"forward": 4.50, "vol": 0.212, "skew": -0.387},
    "1y": {"forward": 4.50, "vol": 0.300, "skew": -0.330},
    ...
  }
}
```

### 5.2 Sanity-check simulation values

```python
import sys; sys.path.insert(0, "backend")
from option_derived_cdf import get_option_cdf_params
import math

for ccy in ["USD", "EUR", "GBP"]:
    for tail in ["5y", "10y", "30y"]:
        d = get_option_cdf_params(ccy, tail)
        p1y = d["params"]["1y"]
        print(f"{ccy} {tail:4s}: fwd={p1y['forward']:.2f}%  "
              f"vol(1y)={p1y['vol']:.3f}  skew={p1y['skew']:.3f}")
```

### 5.3 Verify swap rate tickers (live mode)

```python
from bbg import blp

# Par swap rates — all verified
usd = [f"USSW{t} Curncy" for t in ["1", "2", "5", "10", "20", "30"]]
eur = [f"EUSA{t} Curncy" for t in ["1", "2", "5", "10", "20", "30"]]
gbp = [f"BPSWS{t} Curncy" for t in ["1", "2", "5", "10", "20", "30"]]

snap = blp.bdp(usd + eur + gbp, "PX_LAST")
print(snap)
# Expected: USD ~4.0–4.8%, EUR ~2.0–2.8%, GBP ~3.5–4.5%
```

### 5.4 Test full live run

```bash
ANALYTICS_DATA_SOURCE=bloomberg uvicorn backend.main:app --reload --port 8000
curl "http://localhost:8000/api/tools/option-cdf?ccy=EUR&tail=5y" \
  -H "Authorization: Bearer <token>" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('data_source:', d['data_source'])
for exp, p in d['params'].items():
    print(f'  {exp:4s}: fwd={p[\"forward\"]:.2f}%  vol={p[\"vol\"]:.3f}  skew={p[\"skew\"]:.3f}')
"
```
