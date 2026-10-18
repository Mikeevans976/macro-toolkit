# series_catalogue_egb_rv.json — Documentation

Catalogue for the **EGB RV Monitor** tool.
Backend file: `backend/egb_rv.py` · API route: `GET /api/tools/egb-rv?date={YYYY-MM-DD}`

---

## 1. What Is In The Catalogue

### 1.1 The catalogue is documentation, not runtime config

**This catalogue is not read at runtime.** Tickers are hardcoded in `egb_rv.py`
(`BVAL_CURVES`, `_YIELD_TICKERS`, `_ESTR_TICKER`, `_OIS_TICKERS`, `_VOL_TICKER`),
built from `CURVE_TENORS` in `egb_expressions_config.py`. To change a ticker, edit
`egb_rv.py` and update this catalogue to match. Every ticker below was checked
on the Terminal on 2026-10-19 (about 1,535 daily observations each over 6 years).

### 1.2 Yield tickers and tenors: BVAL constant-maturity curves

Yields come from Bloomberg's BVAL sovereign curves, `BV{TT}{curve} BVLI Index`
with a two-digit tenor (`BV100910 BVLI Index` = Bund 10y). BVAL fits each tenor
daily from the issuer's bonds, so unlike the generic `G…YR` tickers the series
don't jump when the benchmark bond changes, and every tenor is quoted.

| Country | BVAL curve | Expression tenors | Curve points |
|---------|-----------|-------------------|--------------|
| Bund (Germany) | 0910 | 2, 5, 7, 10, 15, 20, 30y | + 1y |
| OAT (France) | 0915 | 2, 5, 7, 10, 15, 20, 30y | + 1y |
| BTP (Italy) | 0905 | 2, 5, 7, 10, 15, 20, 30y | + 1y |
| Bonos (Spain) | 0902 | 2, 5, 7, 10, 15, 20, 30y | + 1y |
| Belgium | 0900 | 2, 5, 10, 15, 20, 30y | + 1y |
| Portugal | 0917 | 2, 5, 10, 15, 30y | + 1y |
| Netherlands | 0920 | 2, 5, 10, 15, 20, 30y | + 1y |
| Austria | 0908 | 2, 5, 10, 15, 20, 30y | + 1y |
| Finland | 0919 | 2, 5, 10, 20, 30y | + 1y |

The 1y point is only used to fit each curve, so a 2y leg rolls to a quoted 1y
yield instead of an extrapolated one; no expression has a 1y leg. 65 yield tickers
in all; a full 6-year pull takes about 20 s.

History: until 2026-10-19 the tool used generic tickers (`GDBR{t}`, `GFRN{t}`,
`GBTPGR{t}`, `GSPG{t}YR`, `GBGB{t}YR`, `GSPT{t}YR`, `GNTH{t}YR`, `GAGB{t}YR`,
`GFIN{t}YR`). They have no Spain 20y, Netherlands 15y/20y or Finland 20y, and the
older `GPTIT`/`GNETH`/`GFINGB` patterns return nothing.

### 1.3 Other market data

| Series | Ticker | Use |
|--------|--------|-----|
| €STR fixing | `ESTRON Index` | Repo baseline for carry |
| €STR OIS par rates | `EESWE{t} Curncy`, t = 2, 5, 10, 30 | ASW proxy (§1.4) |
| EUR 1m10y ATM normal vol | `ENPS0A10 ICPL Curncy` | Beta-monitor regressor. ICAP source, as in Swaps RV; `EUSV0001 Index` returns nothing |

### 1.4 ASW expressions use a proxy

No Bloomberg ASW index ticker works on our Terminal (`DASW…`, `FOASW…`, `ITASW…`,
`SPASW…`, `BEASW…`, `NLASW…` all return nothing). When live, each ASW leg is

    ASW(country, T) = (BVAL yield(T) − €STR OIS par rate(T)) × 100   [bps]

with cheap = positive. This is a spread to OIS, not a par-par asset swap: it
ignores the bond's coupon and price relative to par. Coverage: Bund and OAT 2, 5,
10, 30y; BTP 5, 10, 30y; Bonos 5, 10y; Belgium and Netherlands 10y. Simulated mode
keeps its own synthetic ASW paths.

### 1.5 Repo blocs

| Country | Repo bloc |
|---------|----------|
| Germany | Bund (often trades special) |
| France, Belgium, Netherlands, Austria, Finland | OAT (near GC) |
| Italy | BTP |
| Spain, Portugal | Bonos (peripheral GC proxy) |

### 1.6 Two yield modes: BVAL curves vs individual bonds

**BVAL mode (default, live)** uses the constant-maturity curves in §1.2,
field `PX_LAST`.

**Individual bonds mode** (`?use_individual_bonds=true`) picks, for each
(country, tenor), the outstanding bullet bond closest to the target maturity and
uses its `YLD_YTM_MID`. See `egb_bond_finder.py` / `egb_bond_finder.md`.
**Not live yet:** `bbg.blp` has no `bsrch` or `bdp`, so the bond search fails and
the mode falls back to simulation (§3.1).

### 1.7 Data source and fallbacks

- Bloomberg is called only when `ANALYTICS_DATA_SOURCE=bloomberg`; otherwise the
  tool runs on the deterministic simulation (`_simulate_data()`).
- Live data cover the last 6 years and are cached in-process: one full fetch,
  then every 15 minutes (or on Refresh) only the last 14 days are refetched and
  spliced on. A full fetch takes about 20 s and is warmed at startup.
- A ticker that returns nothing, or whose last print is more than 7 days older
  than the latest yield date, is dropped and listed in the payload's
  `missing_series`. The page badge then reads "Live · … · N missing", and its
  tooltip lists the tickers. Expressions with a dropped leg disappear.
- If ESTR is missing, repo defaults to 0%; if vol is missing, the beta monitor is
  empty. If no yields come back at all, the tool falls back to simulation and
  the badge says "Simulated data".

---

## 2. How to Check It

```bash
# Every ticker against the Terminal
cd backend && python scripts/probe_catalogue.py --tickers "GDBR10 Index" "GSPT10YR Index" "ENPS0A10 ICPL Curncy"

# Live payload: data_source "bloomberg", missing_series []
curl -H "Authorization: Bearer $TOKEN" "http://localhost:8000/api/tools/egb-rv" | python -m json.tool | head -20
```

Unit tests for the live path (fake Bloomberg, no Terminal needed):
`backend/tests/test_egb_rv_live.py`.

---

## 3. Open Items

### 3.1 Individual bonds mode (next)

Add `bsrch` to `bbg.py`, give `bbg.blp` a `bdp` returning the DataFrame
`egb_bond_finder` expects, then verify the nine `FI:` search expressions on the
Terminal.

### 3.2 True par-par ASW

Replace the §1.4 proxy if working ASW tickers are found, or compute par-par ASW
from individual bonds once §3.1 is done (the `asset_basis_swap` engine already
does the maths).

### 3.3 Haver — not applicable

These are daily market prices; Haver does not carry them.

### 3.4 Possible future countries

| Country | Yield pattern (unverified) | Repo bloc |
|---------|---------------------------|----------|
| Greece | `GGGB{t}YR Index` | Bonos |
| Ireland | `GIGB{t}YR Index` | OAT |

Add them to `COUNTRY_TENORS` and `_YIELD_TICKERS`, probe them, then add entries here.
