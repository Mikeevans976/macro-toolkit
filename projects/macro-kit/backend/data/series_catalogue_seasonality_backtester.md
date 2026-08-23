# series_catalogue_seasonality_backtester.json — Documentation

Catalogue for the **Seasonality Backtester** tool.  
Backend file: `backend/seasonality_backtester.py`

---

## 1. What Is In The Catalogue

The catalogue has a single entry with `"bloomberg_ticker": "user_supplied"` and
`"ticker_haver": "user_supplied"`. This is intentional and complete — there is
**no fixed ticker list to fill in**. The user types any Bloomberg expression at
runtime; the tool fetches and analyses whatever they enter.

There is nothing to add to this catalogue.

---

## 2. Architecture

The tool is split into a **data layer** (Bloomberg fetch) and a **computation
layer** (pure Python statistics). The two layers are decoupled — the computation
endpoints accept arbitrary `dates` + `values` arrays, so they work regardless
of where the data came from.

```
Frontend: SeasonalityBacktester.tsx
│
├─ Simulation mode (no backend call)
│     generateSyntheticSeries(id)   ← client-side, 10 synthetic instruments
│     → SeriesData { dates, values }
│
└─ Bloomberg mode
      GET /api/tools/seasonality/data?expression=...&start=...
            fetch_bbg_expression()   ← requires Bloomberg Terminal
            → SeriesData { expression, dates, values, n_obs }

Either way, once SeriesData is available:

POST /api/tools/seasonality/stats    ← get_seasonality_stats()
POST /api/tools/seasonality/heatmap  ← get_seasonality_heatmap()
POST /api/tools/seasonality/backtest ← run_seasonality_backtest()
```

### API routes (all require JWT auth)

| Method | Route | Purpose |
|--------|-------|---------|
| `GET` | `/api/tools/seasonality/data` | Fetch + evaluate a Bloomberg expression |
| `POST` | `/api/tools/seasonality/stats` | Compute seasonal statistics across all dimensions |
| `POST` | `/api/tools/seasonality/heatmap` | Build month × day-of-week mean return matrix |
| `POST` | `/api/tools/seasonality/backtest` | Run a rule-based backtest |

---

## 3. Bloomberg Expression Fetcher

`fetch_bbg_expression(expression, start="2010-01-01")` in `seasonality_backtester.py`.

### Supported expression syntax

Any arithmetic combination of Bloomberg tickers using `+`, `-`, `*`, `/`, `()`.
Tickers must include a yellow key. Supported yellow keys:

```
Index  Equity  Comdty  Corp  Govt  Curncy  Mtge  Muni  Pfd
```

Examples:

```
GDBR10 Index                                   ← single ticker
GDBR10 Index - GDBR2 Index                     ← spread (bps if both yields)
GDBR30 Index - 2 * GDBR10 Index + GDBR2 Index  ← butterfly
USGG10YR Index - GDBR10 Index                  ← cross-market spread
EURUSD Curncy                                  ← FX
SPX Index                                      ← equity index
CO1 Comdty + CO2 Comdty                        ← commodity expression
```

### How the parser works

1. Regex `[A-Z][A-Z0-9 ]*?\s+(?:Index|Equity|...)` extracts all tickers from the expression string.
2. Tickers are sorted **longest first** to prevent substring collisions during substitution (e.g. `GDBR10 Index` must be substituted before any shorter match).
3. Each ticker is replaced with a safe variable name `__v0__`, `__v1__`, etc.
4. The modified expression is evaluated with `eval()` using a **restricted namespace** — `__builtins__` is set to `{}` to block access to Python internals. Only arithmetic operators and the data arrays are in scope.

### Bloomberg fetch details

- Fetches `PX_LAST` via `blp.bdh()` from `start` to today for all constituent tickers in a single call.
- Drops any row where **any** constituent is missing (inner join on dates).
- Evaluates the arithmetic expression on the aligned arrays.
- Returns a flat dict: `{ expression, dates: [str], values: [float], n_obs: int }`.

### No fallback — Bloomberg required

Unlike the EGB RV and Fair Value tools, this function has **no CSV or simulation
fallback**. If `blp` cannot be imported it raises `RuntimeError` immediately.
If Bloomberg returns no data it raises `ValueError`.

The frontend handles this by offering its own **client-side simulation mode**
(see §4) — it never calls `/api/tools/seasonality/data` when in simulation mode.

---

## 4. Client-Side Simulation Mode

The frontend generates synthetic data directly in the browser — no backend call.
10 instruments are available:

| ID | Label | Approx. level | Baked-in seasonal signal |
|----|-------|---------------|--------------------------|
| `10Y_Bund` | 10Y Bund Yield | ~2.50% | Yes (sin harmonics + TOM + DOW bumps) |
| `10Y_Gilt` | 10Y Gilt Yield | ~4.00% | Yes |
| `10Y_UST` | 10Y UST Yield | ~4.20% | Yes |
| `EUR_USD` | EUR/USD | ~1.08 | Yes |
| `GBP_USD` | GBP/USD | ~1.27 | Yes |
| `EuroStoxx50` | EuroStoxx 50 | ~4500 | Yes |
| `FTSE100` | FTSE 100 | ~7800 | Yes |
| `SPX` | S&P 500 | ~4800 | Yes |
| `2s10s_EUR` | 2s10s EUR Curve (bps) | ~50 bps | Yes |
| `2s10s_GBP` | 2s10s GBP Curve (bps) | ~40 bps | Yes |

The generator uses a seeded LCG PRNG + Box-Muller transforms. Each instrument
has baked-in seasonality (annual/semi-annual sin harmonics, turn-of-month bumps,
Friday-Monday DOW differential) so the tool's analysis sections produce
meaningful output in demo mode.

Data covers 2010-01-04 to 2024-12-31. Expression prefix is `[Simulated]`.

---

## 5. Seasonal Dimensions

`get_seasonality_stats()` computes statistics across five dimensions simultaneously.
All dimensions operate on **daily first-differences** of the expression value
(i.e. daily changes, not levels).

### Day of week (DOW)

Bins 0–4 mapping to Mon–Fri. `dow` annotation comes from `pandas.DatetimeIndex.dayofweek`.

### Month

Bins 1–12 (Jan–Dec).

### Day-of-month quintile (DOM)

The calendar day is bucketed into 5 groups:

| Quintile | Days |
|----------|------|
| 1 | 1–6 |
| 2 | 7–12 |
| 3 | 13–18 |
| 4 | 19–23 |
| 5 | 24–31 |

### Turn-of-month (TOM)

Business-day offset relative to the last business day of each calendar month.
Offsets: −3, −2, −1, +1, +2, +3. The month-end day itself (offset 0) is **not
included** in any bin.

### Quarter-end (QE)

Business-day offset relative to the last business day of each calendar quarter.
Offsets: −5, −4, −3, −2, −1, +1, +2, +3, +4, +5. Quarter-end itself (offset 0)
is **not included** in any bin.

### Per-bin statistics

Each bin returns:

| Field | Description |
|-------|-------------|
| `mean` | Mean daily change (in expression units — bps, index pts, etc.) |
| `std` | Sample standard deviation |
| `t_stat` | t-statistic for H₀: mean = 0 |
| `p_value` | Two-tailed p-value |
| `win_rate` | Fraction of days with a positive change |
| `n` | Number of observations in the bin |

> **Units**: returns are in the same units as the expression itself — basis
> points for yield spreads, index points for equities. They are **not** percentage
> returns. A `mean` of 0.5 for `GDBR10 Index` means the 10y Bund yield moves
> +0.5 bps on average on that day-type.

---

## 6. Backtest Mechanics

`run_seasonality_backtest(dates, values, rule)` runs a simple rule-based
backtest. The rule JSON structure:

```json
{
  "type": "dow" | "month" | "dom_quintile" | "tom" | "quarter_end",
  "bins": [int, ...],
  "direction": 1 | -1
}
```

**Signal construction**: on each day, if the day's annotation (DOW, month, etc.)
is in `bins`, the signal is `direction`. Otherwise it is `0`.

**P&L**: `signal × daily_change`. Direction `+1` = long (benefits from rising
values); `−1` = short (benefits from falling values).

**No transaction costs or slippage are modelled.** All returns are mark-to-market
daily changes in expression units, accumulated as a running sum (not compounded).

### Metrics returned

| Metric | Formula |
|--------|---------|
| `total_return` | `sum(strategy_returns)` |
| `ann_return` | `mean(strategy_returns) × 252` |
| `sharpe` | `ann_return / (std(active_returns) × √252)` where active = days in market |
| `max_drawdown` | `min(cumsum - running_max(cumsum))` |
| `win_rate` | `fraction of active days where return > 0` |
| `days_in_market` | Count of signal ≠ 0 days |
| `pct_in_market` | `days_in_market / total_days` |

The equity curve is subsampled every 5 calendar rows before returning to keep
the payload small. Annual breakdown provides per-year metrics.

---

## 7. How to Test

### 7.1 Simulation mode (no Bloomberg required)

Start the server and open the frontend. Select any synthetic instrument from the
dropdown. The tool analyses the client-generated series immediately — no API call
to `/data` is made. Stats, heatmap, and backtest tabs should all render.

To confirm the computation endpoints work independently of Bloomberg:

```bash
# First get synthetic data via the frontend console, or generate it manually:
python3 -c "
import json, numpy as np, pandas as pd

# Build a minimal synthetic series
dates = [d.strftime('%Y-%m-%d') for d in pd.bdate_range('2015-01-01', '2025-01-01')]
rng = np.random.default_rng(42)
values = np.cumsum(rng.normal(0, 0.05, len(dates))).tolist()

payload = {'dates': dates, 'values': values}
print(json.dumps(payload)[:200])
" > /tmp/payload.json

# Stats endpoint
curl -s -X POST http://localhost:8000/api/tools/seasonality/stats \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d @/tmp/payload.json | python3 -m json.tool | head -40

# Backtest endpoint
curl -s -X POST http://localhost:8000/api/tools/seasonality/backtest \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{"dates": [...], "values": [...], "rule": {"type": "dow", "bins": [4], "direction": 1}}' \
  | python3 -m json.tool | head -30
```

### 7.2 Test Bloomberg expression fetch

With Bloomberg Terminal open:

```bash
curl -s "http://localhost:8000/api/tools/seasonality/data?\
expression=GDBR10%20Index&start=2020-01-01" \
  -H "Authorization: Bearer <token>" | python3 -m json.tool | head -20
```

Expected: `{ "expression": "GDBR10 Index", "dates": ["2020-01-02", ...], "values": [0.xx, ...], "n_obs": ~1300 }`.

Test arithmetic expressions:

```bash
# Spread
curl -s "http://localhost:8000/api/tools/seasonality/data?\
expression=GDBR10%20Index%20-%20GDBR2%20Index&start=2018-01-01" \
  -H "Authorization: Bearer <token>" | python3 -m json.tool | grep n_obs

# Butterfly — spaces must be URL-encoded
# GDBR30 Index - 2 * GDBR10 Index + GDBR2 Index
```

### 7.3 Test the expression parser directly

```python
import sys; sys.path.insert(0, "backend")
from seasonality_backtester import _extract_tickers

# Should extract all three, longest first
print(_extract_tickers("GDBR30 Index - 2 * GDBR10 Index + GDBR2 Index"))
# → ['GDBR30 Index', 'GDBR10 Index', 'GDBR2 Index']

# FX
print(_extract_tickers("EURUSD Curncy"))
# → ['EURUSD Curncy']

# Edge case: should NOT extract partial matches
print(_extract_tickers("some random text"))
# → []
```

### 7.4 Sanity-check backtest output

```python
import sys; sys.path.insert(0, "backend")
import numpy as np, pandas as pd
from seasonality_backtester import run_seasonality_backtest

# Generate a series with a strong Friday effect (values rise on Fridays)
dates = [d.strftime('%Y-%m-%d') for d in pd.bdate_range('2010-01-01', '2024-12-31')]
rng = np.random.default_rng(0)
changes = rng.normal(0, 1, len(dates))
# Add +2 on every Friday (dayofweek == 4)
fri = pd.DatetimeIndex(dates).dayofweek == 4
changes[fri] += 2.0
values = np.cumsum(changes).tolist()

# Long Fridays should have strongly positive metrics
result = run_seasonality_backtest(
    dates, values,
    rule={"type": "dow", "bins": [4], "direction": 1}
)
print("Sharpe:", result["metrics"]["sharpe"])   # should be >> 1
print("Win rate:", result["metrics"]["win_rate"])  # should be >> 0.5
print("Days in market:", result["metrics"]["days_in_market"])  # ~15% of all days
```

---

## 8. What Has to Be Added

### Nothing in the catalogue

The catalogue is complete as-is — tickers are user-supplied at runtime, so
there is nothing to fill in.

### Known gap: `custom` rule type not implemented in backend

The frontend type system includes `type: 'custom'` with `customLegs` (arbitrary
date-range legs defined by the user). This rule type appears in `Rule['type']`
and `RULE_BIN_META` in `SeasonalityBacktester.tsx`, but `run_seasonality_backtest()`
in the backend has no handler for it — the `mask` falls through to `pd.Series(False)`
and the backtest returns all zeros.

If custom date-range rules are needed, the backend needs a new branch:

```python
elif rule_type == "custom":
    custom_legs = rule.get("customLegs", [])
    mask = pd.Series(False, index=df.index)
    for leg in custom_legs:
        leg_mask = (
            (df["date"].dt.month == leg["startMonth"]) & (df["date"].dt.day >= leg["startDay"])
        ) | (
            (df["date"].dt.month == leg["endMonth"]) & (df["date"].dt.day <= leg["endDay"])
        )
        mask |= leg_mask
```

This is approximate — the exact intended semantics of `customLegs` should be
confirmed with the frontend team before implementing.

### Haver tickers — not applicable

The tool uses user-supplied Bloomberg expressions at runtime. Haver is not used
and is not applicable.
