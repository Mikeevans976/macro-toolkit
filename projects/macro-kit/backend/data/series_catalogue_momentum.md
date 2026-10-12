# series_catalogue_momentum.json — Documentation

Catalogue for the **Momentum (CTA Signals)** tool.  
Backend file: `backend/momentum.py`

---

## 1. What Is In The Catalogue

The catalogue has **1 entry** with `"bloomberg_ticker": "user_supplied"`. This is
intentional and complete — the user types the Bloomberg ticker at runtime. There
is **no fixed ticker list to fill in**.

Any Bloomberg ticker with a `PX_LAST` price history works: yields, equities,
commodities, FX, futures generics, etc. The tool fetches from `2010-01-01` and
requires at least **315 business days** of history before producing signals.

Nothing needs to be added to this catalogue.

---

## 2. Architecture

### Per-request, single-ticker

```
POST /api/tools/momentum/signals
    compute_momentum_signals(ticker, start="2010-01-01")
    → price history + 4 lookback signals + composite + position + label + percentile
```

The function:
1. Tries `from bbg import blp` and calls `blp.bdh(ticker, ["PX_LAST"], start, today)`
2. On any failure falls back to `_simulate_series(ticker)` — a regime-switching
   random walk seeded by `MD5(ticker)`, ensuring the same ticker always produces
   the same synthetic series

### Fallback behaviour

Like `print_analysis.py`, there is no `ANALYTICS_DATA_SOURCE` env var. The import
is attempted on every call. If Bloomberg is unavailable, simulation activates
automatically. The `[simulated]` suffix is appended to the ticker in the response.

---

## 3. Signal Computation

### 3.1 Constants

| Constant | Value | Meaning |
|----------|-------|---------|
| `LOOKBACKS` | `{1M: 21, 3M: 63, 6M: 126, 12M: 252}` | Business day lookback lengths |
| `VOL_WINDOW` | 63 | Days for rolling annualised volatility |
| `VOL_TARGET` | 0.10 | 10% annualised target for position sizing |
| `MIN_HISTORY` | 315 | Minimum days required before first signal output |

### 3.2 Raw signal per lookback

For each lookback length `L` (in business days):

```
raw_signal(L) = diff(price, L) / (trailing_ann_vol_level × sqrt(L / 252))
```

- `diff(price, L)` = price today minus price `L` days ago (level change)
- `trailing_ann_vol_level` = rolling std of 1-day level changes over `VOL_WINDOW`
  days, annualised by `× sqrt(252)`
- Raw signal is **capped at ±5**

This is the standard CTA/trend signal: a normalised price momentum where both
numerator and denominator are in price units, so the ratio is dimensionless.

### 3.3 Composite signal

```
composite = equal-weight mean of [signal_1M, signal_3M, signal_6M, signal_12M]
```

Important: the composite is `NaN` if **any** of the four lookback signals is
`NaN`. This happens for the first 252 days of valid history (12M lookback not
yet available). No partial-lookback composite is produced.

### 3.4 Position size

```
position = (VOL_TARGET × composite / ann_vol_pct).clip(-8, 8)
```

Note: `ann_vol_pct` is the rolling annualised volatility of **percentage returns**
(i.e. `pct_change()` × `sqrt(252)`), not level changes. This distinction matters
for assets with very different price scales (e.g. a yield vs an equity index).
The position represents a notional risk allocation, normalised to 10% annualised
vol target, clipped to ±8 units.

### 3.5 Direction label

Based on the composite signal value:

| Range | Label |
|-------|-------|
| composite > 1.5 | `Strong Long` |
| 0.5 < composite ≤ 1.5 | `Long` |
| −0.5 ≤ composite ≤ 0.5 | `Neutral` |
| −1.5 ≤ composite < −0.5 | `Short` |
| composite < −1.5 | `Strong Short` |

### 3.6 Percentile

The composite percentile is computed over the **full non-subsampled history**
(all rows, before the every-5th-point subsampling applied to the output). This
gives a stable percentile rank even though the time series returned to the frontend
is thinned.

---

## 4. Output Subsampling

The raw output contains one row per business day. To reduce payload size, the
response is subsampled to every 5th row, with the **last row always retained**
(so the most recent signal is always present). The first `MIN_HISTORY` (315) rows
are dropped — those days don't have enough history for a 12M signal.

---

## 5. Simulation Mode

The simulation generates a regime-switching random walk:

- Ticker string is hashed with MD5 → integer seed for `np.random.default_rng`
- Regime alternates between **trending** (positive or negative drift) and
  **choppy** (near-zero drift, high noise)
- Result is a price series that looks plausibly momentum-bearing, with the same
  ticker always producing identical output across runs

The `[simulated]` suffix is appended to the ticker in all response fields.

---

## 6. Bloomberg Fields

Only one field is fetched:

| Field | Description |
|-------|-------------|
| `PX_LAST` | Last price — works for yields, equities, FX, commodities |

No survey, metadata, or multiple fields. The tool is purely price-based.

---

## 7. How to Test

### 7.1 Simulation mode (no Bloomberg required)

```bash
curl -s -X POST http://localhost:8000/api/tools/momentum/signals \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"ticker": "GDBR10 Index"}' \
  | python3 -m json.tool | head -60
```

Expected response shape:

```json
{
  "ticker": "GDBR10 Index [simulated]",
  "signals": [
    {
      "date":        "2012-07-18",
      "price":        1.83,
      "signal_1M":    0.42,
      "signal_3M":    1.17,
      "signal_6M":    1.53,
      "signal_12M":   0.94,
      "composite":    1.02,
      "position":     3.14,
      "label":       "Long",
      "percentile":   71.3
    },
    ...
  ],
  "summary": {
    "current_label":      "Long",
    "current_composite":  1.02,
    "current_position":   3.14,
    "current_percentile": 71.3
  }
}
```

The `[simulated]` suffix in the ticker confirms simulation mode is active.

### 7.2 Test with Bloomberg Terminal open

```python
import sys; sys.path.insert(0, "backend")
from momentum import compute_momentum_signals

result = compute_momentum_signals("GDBR10 Index")
print("ticker:", result["ticker"])
print("n_rows:", len(result["signals"]))

# Check most recent signal
last = result["signals"][-1]
print(f"date: {last['date']}")
print(f"composite: {last['composite']:.3f}  label: {last['label']}")
print(f"position: {last['position']:.2f}  percentile: {last['percentile']:.1f}%")
```

What to check:
- `ticker` should NOT have `[simulated]` suffix
- First `date` should be roughly 315 business days (~15 months) after 2010-01-03
- `signal_1M/3M/6M/12M` should all be non-null in recent rows
- `composite` should be the equal-weight mean of the four signals
- `label` should match the composite thresholds (±0.5, ±1.5)

Common test tickers:
- `GDBR10 Index` — German 10y Bund yield
- `CO1 Comdty` — Brent crude futures generic
- `EURUSD Curncy` — EUR/USD spot
- `SPX Index` — S&P 500

---

## 8. What Has to Be Added

### Nothing in the catalogue

The catalogue is complete as-is. Tickers are user-supplied at runtime.

### Known behaviour notes

**NaN composite for first 12M of valid history**: Any ticker with fewer than
252 + 315 = 567 business days (~2.25 years) of history from 2010 will produce
fewer composite rows than expected. The frontend should handle sparse `null` values
in `signal_12M`.

**Level-change vol vs pct-change vol**: The raw signal normalises by level-change
vol; position sizing normalises by pct-return vol. For most assets these are
proportional, but for very low-yield series (e.g. JGB at 0.05%) the ratio can
diverge significantly, producing large position values even for small signals.

**No revision or carry adjustment**: This is a pure price-momentum signal. There
is no carry normalisation, no seasonal adjustment, and no fundamental overlay.
