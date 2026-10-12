# series_catalogue_print_analysis.json — Documentation

Catalogue for the **Print Analysis** tool.  
Backend file: `backend/print_analysis.py`

---

## 1. What Is In The Catalogue

The catalogue has **3 entries**, all with `"bloomberg_ticker": "user_supplied"`. This
is intentional and complete — the user types the economic indicator ticker and the
market instrument ticker at runtime. There is **no fixed ticker list to fill in**.

The catalogue documents two things:
1. Which Bloomberg fields are fetched for the economic indicator (7 fields)
2. The role of the market reaction instrument (user-supplied, `PX_LAST` only)

Nothing needs to be added to this catalogue.

---

## 2. Architecture

Both API functions accept user-supplied tickers directly:

```
POST /api/tools/print-analysis/releases
    fetch_print_vs_consensus(ticker, start)
    → release history + surprise stats

POST /api/tools/print-analysis/market-reaction
    fetch_market_reaction(market_ticker, releases)
    → day-of-release market move per print
```

### Fallback behaviour

Unlike other tools, there is **no `ANALYTICS_DATA_SOURCE` env var** — the code
simply tries `from bbg import blp` on each call. If the import fails (Bloomberg
not installed) or the Terminal call raises (Terminal not running), it falls back
to `_simulate_releases()` / `_simulate_market_reaction()` automatically.

Simulation is seeded by the ticker string — the same ticker always produces the
same synthetic series, which is useful for consistent UI demos.

---

## 3. Bloomberg Fields

### Economic indicator ticker

All 7 fields are requested in a single `blp.bdh()` call:

| Field | Description | Notes |
|-------|-------------|-------|
| `PX_LAST` | Realised/actual release value | Index date = reference period |
| `ECO_SURVEY_AVG` | Consensus average forecast | Pre-release Bloomberg survey |
| `ECO_SURVEY_MEDIAN` | Consensus median | |
| `ECO_SURVEY_HIGH` | Highest survey estimate | |
| `ECO_SURVEY_LOW` | Lowest survey estimate | |
| `BN_SURVEY_NUMBER` | Number of survey respondents | |
| `ECO_RELEASE_DT` | Actual release date | Separate from the index date — see §4 |

Missing survey fields (`ECO_SURVEY_AVG`, etc.) are returned as `null` in the
response and excluded from derived statistics. Missing survey data does **not**
trigger the simulation fallback — only Bloomberg connectivity failure does.

`PX_LAST` is required: if it's absent from the response, the code raises
`RuntimeError` with a message to check the ticker spelling and yellow key.

### Market reaction ticker

Only `PX_LAST` is fetched over a window spanning all release dates. The move is
computed as:

```
market_move = close(release_date) − close(prior_business_day)
```

Units match the ticker — bps for yield indices, index points for equities, etc.
No conversion is applied.

---

## 4. Key Data Design: reference period vs release date

Bloomberg's `bdh()` index for economic indicators uses the **reference period**
as the date (e.g. `2025-01-01` for January CPI data), not the actual release date.
The actual release date (e.g. `2025-02-12`, when the data came out) lives in
the separate `ECO_RELEASE_DT` field.

The tool returns both:
- `date` — the reference period (from the series index)
- `release_date` — from `ECO_RELEASE_DT`

The market reaction calculation uses `release_date` to look up market prices,
so this distinction matters. If `ECO_RELEASE_DT` is null for a row, that
release is excluded from the market reaction output.

---

## 5. Derived Fields

### Surprise

```
surprise = actual (PX_LAST) − consensus_avg (ECO_SURVEY_AVG)
```

Null if `ECO_SURVEY_AVG` is missing. Units are the same as the indicator
(e.g. percentage points for CPI YoY, index points for PMI).

### Z-score

```
z_score = (surprise − mean(all surprises)) / std(all surprises)
```

Normalised over the full history returned. Requires at least 3 non-null
surprises; otherwise returned as null.

### Summary statistics

Returned alongside the release list:

| Field | Description |
|-------|-------------|
| `n_releases` | Total releases with a non-null actual value |
| `mean_surprise` | Mean of `surprise` series |
| `std_surprise` | Standard deviation of `surprise` series |
| `pct_beats` | % of releases where `surprise > 0` |
| `pct_misses` | % of releases where `surprise < 0` |
| `pct_inline` | % of releases where `surprise == 0` |

---

## 6. How to Test

### 6.1 Simulation mode (no Bloomberg required)

Start the server and send a request with any ticker string:

```bash
curl -s -X POST http://localhost:8000/api/tools/print-analysis/releases \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"ticker": "UKPRIC YOY Index", "start": "2015-01-01"}' \
  | python3 -m json.tool | head -40
```

Expected response shape:

```json
{
  "ticker": "UKPRIC YOY Index [simulated]",
  "releases": [
    {
      "date":         "2024-11-01",
      "release_date": "2024-12-10",
      "actual":       2.63,
      "avg":          2.71,
      "median":       2.69,
      "high":         2.95,
      "low":          2.48,
      "n":            34,
      "surprise":     -0.08,
      "z_score":      -0.42
    },
    ...
  ],
  "summary": {
    "n_releases":    118,
    "mean_surprise": 0.02,
    "std_surprise":  0.19,
    "pct_beats":     52.5,
    "pct_misses":    44.9,
    "pct_inline":    2.5
  }
}
```

The `[simulated]` suffix in the ticker confirms simulation mode is active.

### 6.2 Test the market reaction endpoint (simulation)

```bash
# Use the releases from 6.1 (pass a short subset)
curl -s -X POST http://localhost:8000/api/tools/print-analysis/market-reaction \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "market_ticker": "GDBR10 Index",
    "releases": [
      {"period": "2024-11-01", "release_date": "2024-12-10", "surprise": -0.08},
      {"period": "2024-10-01", "release_date": "2024-11-12", "surprise": 0.15}
    ]
  }' | python3 -m json.tool
```

Expected:
```json
{
  "market_ticker": "GDBR10 Index [simulated]",
  "reactions": [
    {"period": "2024-11-01", "release_date": "2024-12-10", "market_move": -1.832},
    {"period": "2024-10-01", "release_date": "2024-11-12", "market_move":  3.417}
  ]
}
```

### 6.3 Test with Bloomberg Terminal open

```python
import sys; sys.path.insert(0, "backend")
from print_analysis import fetch_print_vs_consensus

# Euro Area HICP — common test case
result = fetch_print_vs_consensus("ECCPEMUY Index", start="2020-01-01")
print("ticker:", result["ticker"])
print("n_releases:", result["summary"]["n_releases"])
print("mean_surprise:", result["summary"]["mean_surprise"])
print()
# Last 3 releases
for r in result["releases"][:3]:
    print(f"  {r['date']}  actual={r['actual']}  avg={r['avg']}  surprise={r['surprise']}  z={r['z_score']}")
```

What to check:
- `ticker` should NOT have `[simulated]` suffix
- `release_date` values should be separate from `date` (typically 2–6 weeks later)
- Surprise magnitudes should be small (typically ±0.1–0.3pp for HICP)
- `ECO_SURVEY_AVG` is available for most major indicators; esoteric tickers may return null

Other common test tickers:
- `NFP TCH Index` — US Nonfarm Payrolls (large surprise impact)
- `USURTOT Index` — US Unemployment Rate
- `UKPRIC YOY Index` — UK CPI YoY
- `PMITMEZ Index` — Euro Area Manufacturing PMI

---

## 7. What Has to Be Added

### Nothing in the catalogue

The catalogue is complete as-is. Tickers are user-supplied at runtime.

### Haver tickers — not applicable

Economic release data (actual prints + Bloomberg survey consensus) is not
available in Haver. All `ticker_haver` fields are null by design.

### Known gap: no revision tracking

The tool records the **latest vintage** of each release — Bloomberg's `PX_LAST`
reflects any subsequent revisions. If a release was revised significantly after
the initial print, the stored `actual` value may differ from what was traded at
release time. For indicators with frequent revisions (e.g. US GDP, US payrolls),
this can affect surprise and z-score calculations.

Bloomberg's `ECO_RELEASE_DT_FINAL` or revision-specific fields could be used
to fetch the first-print value, but this is not currently implemented.
