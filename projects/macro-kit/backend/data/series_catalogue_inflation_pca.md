# series_catalogue_inflation_pca.json — Documentation

Catalogue for the **Inflation PCA** tool.  
Backend file: `backend/inflation_pca.py`

---

## 1. What Is In The Catalogue

The catalogue defines **6 curves** (Germany, France, Italy, Spain, UK, US), each with:

| Field | Purpose |
|-------|---------|
| `ilb_screen` | Bloomberg SRCH expression to discover all active ILB bonds |
| `nominal_screen` | Bloomberg SRCH expression to discover all active nominal bonds |
| `filter_inflation_linked_only` | Whether to apply `INFLATION_LINKED_IND=Y` filter post-search |
| `min_ilb_outstanding_mn` | Minimum notional outstanding to include an ILB (default €1bn) |
| `min_nominal_outstanding_mn` | Minimum notional outstanding to include a nominal (default €5bn) |
| `default_bonds` | Hardcoded fallback bond list used for simulation when Bloomberg is unavailable |

**No fixed ticker list is maintained.** The set of bonds is discovered fresh on each request via Bloomberg SRCH and cached for the trading day. When a new bond is issued or an old one matures, it appears/disappears automatically.

### 1.1 Curves

| Curve ID | Country | Label | CCY | Inflation ref | ILB screen | Nominal screen |
|----------|---------|-------|-----|--------------|------------|----------------|
| `dbrei` | Germany | DBRei | EUR | HICPxT | `FI:DBIBL` ⚠️ | `FI:DBR` ⚠️ |
| `oatei` | France | OATei | EUR | HICPxT | `FI:FROB` ⚠️ + filter | `FI:FRTR` ⚠️ |
| `btpei` | Italy | BTPei | EUR | HICPxT | `FI:ITIL` ⚠️ | `FI:BTPS` ⚠️ |
| `spgbei` | Spain | SPGBei | EUR | HICPxT | `FI:SPGBEI` ⚠️ | `FI:SPGB` ⚠️ |
| `uki` | UK | UKi | GBP | RPI | `FI:UKTIIL` ⚠️ | `FI:UKT` ⚠️ |
| `tips` | US | TIPS | USD | CPI-U | `FI:TII` ⚠️ | `FI:T` ⚠️ |

> ⚠️ **All 12 screen names are unverified.** They must be confirmed in a live Bloomberg
> Terminal before going live. See §7.1 for the verification procedure.

France is a special case: `FI:FROB` returns all OATs (nominal + inflation-linked), so the
code applies an additional `INFLATION_LINKED_IND=Y` filter to isolate OATei bonds.

### 1.2 Bloomberg fields used

| Stage | Field | Description |
|-------|-------|-------------|
| Discovery | `MATURITY` | Bond maturity date |
| Discovery | `AMT_OUTSTANDING` | Notional outstanding (millions, local CCY) |
| Discovery | `CALLABLE` | "Y" or "N" — callable bonds are excluded |
| Discovery | `INFLATION_LINKED_IND` | "Y" or "N" — used to filter France's ILB-only universe |
| Time series | `YLD_YTM_MID` | Real yield (on ILB) and nominal yield (on comparator) |
| Time series | `YAS_ASW_SPREAD` | Asset swap spread — used for IOTA on both ILB and nominal |

---

## 2. Architecture

Unlike the Fair Value Models (pre-computed at startup), this tool runs **per request**,
called once per curve ID.

```
GET /api/tools/inflation-pca?curve=btpei
│
└─► get_inflation_pca_data("btpei")
        │
        ├─ ANALYTICS_DATA_SOURCE == "bloomberg"?
        │       │
        │       ├─► _get_bond_pair("Italy")          ← cached per trading day
        │       │       _discover_ilb_and_nominals("Italy")
        │       │         ├─ blp.bsrch("FI:ITIL")   → ILB tickers
        │       │         ├─ blp.bdp(ilb_tickers, [MATURITY, AMT_OUTSTANDING, ...])
        │       │         ├─ filter: > 1y maturity, non-callable, > €1bn outstanding
        │       │         ├─ blp.bsrch("FI:BTPS")   → nominal tickers
        │       │         ├─ blp.bdp(nom_tickers, [...])
        │       │         ├─ filter: > 1y maturity, non-callable, > €5bn outstanding
        │       │         └─ for each ILB → find nominal with closest maturity
        │       │         → (ilb_bonds, nominal_bonds)  [aligned lists]
        │       │
        │       ├─► _fetch_bond_field(ilb_bonds, "YLD_YTM_MID")
        │       │       → real_df [T, N]
        │       │
        │       ├─► _fetch_bond_field(nominal_bonds, "YLD_YTM_MID")
        │       │       → nominal_yield_df [T, N]
        │       │       breakeven = nominal_yield − real_yield  (per bond)
        │       │
        │       ├─► _fetch_bond_field(ilb_bonds, "YAS_ASW_SPREAD")
        │       │       → linker_asw_df [T, N]
        │       │
        │       └─► _fetch_bond_field(nominal_bonds, "YAS_ASW_SPREAD")
        │               → nominal_asw_df [T, N]
        │               IOTA = linker_asw − nominal_asw  (per bond)
        │
        └─ Fallback: _simulate_yields(curve_id, yield_type, T)
                Uses default_bonds from _CURVES for bond count and labels.
                AR(1) factor model — level/slope/curvature factors.

For each of real / breakeven / iota:
    _compute_pca(levels)   → PC1/2/3 loadings + variance explained
    _compute_flies(...)    → all N-choose-3 PCA-neutral butterflies

Response: {curve, bonds, dates, data_source, real, breakeven, iota}
data_source: "bloomberg" | "partial" | "simulation"
```

### Bond universe caching

`_get_bond_pair(country)` caches the discovered `(ilb_bonds, nominal_bonds)` pair
keyed by `(country, today_str)`. Bloomberg SRCH is hit at most once per country per
trading day, regardless of how many times the endpoint is called.

### Data window

Once the bond list is known, `_fetch_bond_field()` fetches the **last 252 business days**
(≈1 year) of time-series data via `blp.bdh()`. Minimum 63 rows required; otherwise that
yield type falls back to simulation.

### Partial fallback

Real yields, breakeven, and IOTA fall back independently:

| Condition | `data_source` |
|-----------|--------------|
| All three on live data | `"bloomberg"` |
| At least one live | `"partial"` |
| All three simulated | `"simulation"` |

If bond discovery fails entirely (e.g. screen returns nothing), the endpoint falls back to
simulation using `default_bonds` from the catalogue.

---

## 3. Yield Types

### Real yield

`YLD_YTM_MID` fetched directly from Bloomberg on each discovered ILB bond ticker.

### Breakeven

Per bond, computed from Bloomberg data:

```
breakeven[j] = nominal_yield[j] − real_yield[j]
```

`nominal_yield[j]` is `YLD_YTM_MID` on the closest-maturity nominal government bond to
linker `j`. This is the bond-implied breakeven — what inflation must average over the
bond's life for the linker and nominal to deliver the same total return.

### IOTA

Per bond, computed from Bloomberg data:

```
IOTA[j] = linker_asw[j] − nominal_asw[j]
```

Both `linker_asw` and `nominal_asw` are `YAS_ASW_SPREAD` fetched from Bloomberg on the
respective bonds. IOTA captures relative richness/cheapness in asset-swap space: a negative
IOTA means the linker trades cheap on ASW relative to the maturity-matched nominal.

---

## 4. Nominal Comparator Matching

For each discovered ILB bond, the nominal comparator is the bond in the nominal universe
with the **smallest absolute difference in remaining maturity** (in calendar days):

```python
idx = (nominal_universe["MATURITY"] - ilb_maturity).abs().idxmin()
```

The nominal universe is pre-filtered by the same criteria as the ILB universe (callable,
outstanding, > 1y remaining), so the matched nominal is always a liquid, active bond.

---

## 5. PCA Methodology

PCA is run on **daily yield changes** (first differences), not levels.

```python
dY = np.diff(levels, axis=0)     # [T-1, N]
X  = dY - dY.mean(axis=0)        # mean-centre each bond
C  = X.T @ X / (T - 2)           # sample covariance [N, N]
eigenvalues, eigenvectors = np.linalg.eigh(C)
# Sorted descending → PC1, PC2, PC3
```

**Sign conventions** (applied so charts are stable across curve reshufflings):
- PC1 (level factor): flip so mean loading is positive.
- PC2 (slope factor): flip so the longest bond's loading is positive.
- PC3 (curvature): no canonical flip.

---

## 6. PCA-Neutral Butterflies

All `N choose 3` bond triplets are evaluated as PC1+PC2-neutral butterflies.
For triplet (i, j, k) where i < j < k (wings i and k, belly j):

```
det = pc1[i]·pc2[k] − pc1[k]·pc2[i]

wL = (pc1[j]·pc2[k] − pc1[k]·pc2[j]) / det
wR = (pc1[i]·pc2[j] − pc2[i]·pc1[j]) / det

fly_spread = wL·y[i] − y[j] + wR·y[k]   (× 100 → bps)
```

If |det| < 1e-6 the triplet is skipped (degenerate PC loadings).

**Z-score**: current spread vs 63-day rolling mean/std.

| Z-score | Signal |
|---------|--------|
| > 2 | Very Rich |
| 1 to 2 | Rich |
| −1 to 1 | Neutral |
| −2 to −1 | Cheap |
| < −2 | Very Cheap |

Results sorted by `|z-score|` descending.

---

## 7. How to Test

### 7.1 Verify the 12 Bloomberg SRCH screens (PRIORITY)

All 12 screen names need to be confirmed in Bloomberg Terminal. The test is simple:
if `blp.bsrch(screen)` returns a non-empty list of tickers with valid maturity data, the
screen works.

```python
from bbg import blp
import pandas as pd

SCREENS = {
    "DBRei ILB":     "FI:DBIBL",
    "OATei ILB":     "FI:FROB",     # expect mix of nominal + ILB — filter separately
    "BTPei ILB":     "FI:ITIL",
    "SPGBei ILB":    "FI:SPGBEI",   # most likely to need correction
    "UKi ILB":       "FI:UKTIIL",
    "TIPS ILB":      "FI:TII",      # most likely to need correction
    "DBR nominal":   "FI:DBR",
    "OAT nominal":   "FI:FRTR",
    "BTP nominal":   "FI:BTPS",
    "SPGB nominal":  "FI:SPGB",
    "UKT nominal":   "FI:UKT",
    "UST nominal":   "FI:T",        # most likely to need correction
}

for label, screen in SCREENS.items():
    try:
        tickers = blp.bsrch(screen)
        if not tickers:
            print(f"  {label:20s}: NO RESULTS  ✗")
            continue
        info = blp.bdp(tickers[:5], ["MATURITY", "INFLATION_LINKED_IND"])
        print(f"  {label:20s}: {len(tickers)} bonds  ✓")
        print(info[["MATURITY", "INFLATION_LINKED_IND"]].to_string())
    except Exception as e:
        print(f"  {label:20s}: ERROR — {e}  ✗")
```

For any screen that fails or returns wrong bonds:
- ILB screens: search the issuer prefix in Terminal (`ITIL <Govt> <GO>`, `TII <Govt> <GO>`)
  and derive the correct `FI:` prefix from the results.
- Nominal screens: cross-reference with `egb_bond_finder.COUNTRY_BSRCH` which covers DE/FR/IT/ES.
- Update `_ILB_SCREENS` and `_NOMINAL_SCREENS` in `inflation_pca.py` and the catalogue.

### 7.2 Simulation mode (no Bloomberg required)

```bash
source .venv/bin/activate
uvicorn backend.main:app --reload --port 8000
```

```bash
for curve in dbrei oatei btpei spgbei uki tips; do
  echo "=== $curve ==="
  curl -s "http://localhost:8000/api/tools/inflation-pca?curve=$curve" \
    -H "Authorization: Bearer <token>" \
    | python3 -m json.tool | grep -E '"curve"|"data_source"|"name"|"zscore"' | head -12
done
```

Expected `data_source: "simulation"` for all curves until screens are verified.

### 7.3 Sanity-check simulation values

```python
import sys; sys.path.insert(0, "backend")
from inflation_pca import get_inflation_pca_data, _CURVES

for cid in _CURVES:
    d = get_inflation_pca_data(cid)
    print(f"\n{cid.upper()}  ({d['data_source']})")
    print(f"  bonds: {[b['label'] for b in d['bonds']]}")
    for yt in ["real", "breakeven", "iota"]:
        last = d[yt]["levels"][-1]
        ve   = d[yt]["var_explained"]
        nf   = len(d[yt]["flies"])
        print(f"  {yt:10s}: last={[round(v,2) for v in last]}  ve={ve}  flies={nf}")
```

Expected simulation ranges:
- DBRei real: ~0.2–0.9%, breakeven: ~1.8–2.2%, IOTA: −0.25 to −0.08
- OATei real: ~0.5–1.3%, breakeven: ~1.9–2.3%, IOTA: −0.15 to 0.0
- BTPei real: ~0.8–1.8%, breakeven: ~2.1–2.4%, IOTA: −0.05 to +0.20
- SPGBei real: ~0.7–1.5%, breakeven: ~2.0–2.3%, IOTA: −0.10 to +0.10
- UKi real: ~−0.2–1.1%, breakeven: ~3.2–3.8%, IOTA: −0.40 to −0.10
- TIPS real: ~0.3–1.0%, breakeven: ~2.2–2.5%, IOTA: −0.20 to −0.05

### 7.4 Test Bloomberg live path (after screens are verified)

```python
import sys, os
os.environ["ANALYTICS_DATA_SOURCE"] = "bloomberg"
sys.path.insert(0, "backend")
from inflation_pca import get_inflation_pca_data

d = get_inflation_pca_data("btpei")
print("data_source:", d["data_source"])
print("bonds discovered:")
for b in d["bonds"]:
    print(f"  {b['label']:12s}  {b['maturity']}  {b['bbgTicker']}")
print()
print("real yields (last):", [round(v, 3) for v in d["real"]["levels"][-1]])
print("breakevens  (last):", [round(v, 3) for v in d["breakeven"]["levels"][-1]])
print("IOTA bps    (last):", [round(v, 1) for v in d["iota"]["levels"][-1]])
```

What to check:
- `data_source` should be `"bloomberg"` or `"partial"` (not `"simulation"`)
- Discovered bond list should update vs the hardcoded defaults as new bonds are issued
- Breakevens should be positive and in a plausible range (EUR ~1.5–2.5%, UK ~3–4%)
- IOTA should typically be negative for core EUR (linker ASW tighter than nominal)

---

## 8. What Has to Be Added / Verified

### 8.1 Verify all 12 Bloomberg SRCH screens — PRIORITY BLOCKER

Run §7.1. Until at least one curve's screens are confirmed, the entire tool runs on
simulation. Suggested order of verification:

1. **Italy** (`FI:ITIL` + `FI:BTPS`) — ILB screen is most likely correct
2. **Germany** (`FI:DBIBL` + `FI:DBR`) — both screens likely correct
3. **UK** (`FI:UKTIIL` + `FI:UKT`) — ILB screen likely correct
4. **France** (`FI:FROB` + filter + `FI:FRTR`) — filter logic needs confirming
5. **Spain** (`FI:SPGBEI` + `FI:SPGB`) — ILB screen name most uncertain
6. **US** (`FI:TII` + `FI:T`) — both screen names most uncertain

### 8.2 Spain default bond tickers

`default_bonds` for `spgbei` and `tips` have `null` tickers. This only affects the
simulation fallback labels — the dynamic discovery path doesn't use `bbgTicker` from
`default_bonds`. No action required until the screens are confirmed.

### 8.3 No Haver tickers — not applicable

ILB real yields, nominal yields, and ASW spreads are daily market prices not carried
by Haver.

### 8.4 Outstanding threshold calibration

The current filters (`_MIN_ILB_MN = 1000`, `_MIN_NOMINAL_MN = 5000`) may need
adjustment per market:
- UK gilts: outstanding in £bn — `5000` may be too high for UKi ILBs
- US TIPS: outstanding in $mn — thresholds are likely fine
- Verify by checking how many bonds survive the filter for each country once screens work
