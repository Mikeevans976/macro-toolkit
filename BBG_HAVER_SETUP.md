# Bloomberg / Haver Data Setup

Guide for wiring real data into the Euro Area Heatmap.

---

## Running the backend with live data

**Bloomberg** (Terminal must be running and logged in):
```bash
pip install xbbg
cd backend
ANALYTICS_DATA_SOURCE=bloomberg python main.py
```

**Haver** (DLX must be installed and databases accessible):
```bash
pip install Haver
cd backend
ANALYTICS_DATA_SOURCE=haver HAVER_PATH=/path/to/haver/databases python main.py
```

Default (`ANALYTICS_DATA_SOURCE` unset) → simulation mode, no external data needed.

---

## Ticker checklist — DFM series

All 60 DFM series are defined in `backend/data/series_catalogue.json`.
Series with `source: "derived"` or `null` tickers are automatically skipped by the fetcher.
The model runs fine with partial coverage — missing-ticker columns stay NaN and the Kalman
filter propagates those factors on the transition equation alone.

### Series requiring PM input

| col | Series ID | Bloomberg | Haver | Action needed |
|-----|-----------|-----------|-------|---------------|
| 8 | `ea_us_current_activity_indicator` | MISSING | MISSING | Confirm if available; if not, set `source: "derived"` |
| 9 | `ea_cesi` | `CESIEUR Index` (unverified) | MISSING | PM to verify BBG ticker; find Haver mnemonic |
| 20 | `ea_building_permits_yoy` | MISSING | `BPEZM@EUDATA` ✓ | Find BBG ticker |
| 21 | `ea_eurocoin` | MISSING | MISSING | CEPR index — likely not on BBG/Haver; set `source: "derived"` |
| 26 | `ea_ces_inflation_exp_1y` | MISSING | MISSING | ECB CES survey — not on BBG; find Haver mnemonic if available |
| 33 | `ea_hicp_services_to_goods_ratio` | MISSING | MISSING | Derived ratio — set `source: "derived"`, compute from existing HICP series |
| 35 | `ea_hicp_weighted_median_yoy` | MISSING | MISSING | ECB internal measure — check availability |
| 43 | `ea_ces_inflation_exp_3y` | MISSING | MISSING | Same as 1y — ECB CES only |
| 44 | `ea_spf_lt_inflation_expectations` | `ECSPF5Y Index` (unverified) | MISSING | PM to verify |
| 48 | `ea_labour_participation_rate` | MISSING | `LFPEZQ@EUDATA` ✓ | Find BBG ticker |
| 49 | `ea_indeed_job_postings_yoy` | MISSING | MISSING | Indeed data — not on BBG/Haver; set `source: "derived"` |
| 56 | `ea_labour_productivity_yoy` | MISSING | `LPRODQ@EUDATA` ✓ | Find BBG ticker |
| 57 | `ea_indeed_wage_tracker_yoy` | MISSING | MISSING | Indeed — set `source: "derived"` |
| 58 | `ea_ecb_wage_tracker_excl_oneoffs` | MISSING | MISSING | ECB internal — check availability |
| 59 | `ea_ecb_wage_tracker_incl_oneoffs` | MISSING | MISSING | ECB internal — check availability |

### Series with confirmed tickers (no action needed)

All other 45 series have at least one confirmed ticker. Full list in `series_catalogue.json`.

---

## How to update a ticker

Open `backend/data/series_catalogue.json`, find the entry by `id`, and fill in:

```json
{
  "id": "ea_cesi",
  "ticker_bloomberg": "CESIEUR Index",
  "ticker_haver": "CESIEUR@SOMEDB",
  ...
}
```

To mark a series as unavailable externally:
```json
{
  "source": "derived",
  "ticker_bloomberg": null,
  "ticker_haver": null
}
```

The fetcher picks up changes immediately on next backend restart — no code changes needed.

---

## Checking what loaded on startup

The backend logs warnings for any series that returned no data. Look for:

```
data_fetcher: 'ea_xxx' returned no data for 2023-01-01–2025-06-25.
No observations placed for: ['ea_xxx', ...].
```

A clean run with full coverage will show no such warnings and `has_data=True` in the
heatmap module logs.
