"""
Definitions of curve and fly expressions built from OIS forward rates.

Curve:  (label, front, back)         value = (back − front) × 100  [bps]
Fly:    (label, front, belly, back)   value = (2×belly − front − back) × 100  [bps]

Separate lists per currency so the user can customise per-market expressions.
EUR uses ESTR forwards, GBP uses SONIA forwards, USD uses SOFR forwards —
the forward-rate labels (e.g. "1y10y") are currency-agnostic; the backend
skips any label not present in the loaded CSV.
"""

# ─── EUR (ESTR) ───────────────────────────────────────────────────────────────

CURVES = [
    # Short-end / ECB path (1y tenor)
    ("2y1y-1y1y",   "1y1y",  "2y1y"),
    ("3y1y-2y1y",   "2y1y",  "3y1y"),
    ("4y1y-3y1y",   "3y1y",  "4y1y"),
    # Medium-term curves
    ("10y2y-12y3y",  "10y2y", "12y3y"),
    ("2y2y-1y1y",    "1y1y",  "2y2y"),
    ("1y10y-1y2y",   "1y2y",  "1y10y"),
    # 5y-tenor curves
    ("10y5y-5y5y",   "5y5y",  "10y5y"),
    # Cross-tenor / long-end
    ("10y20y-5y5y",  "5y5y",  "10y20y"),
    ("20y10y-10y10y","10y10y","20y10y"),
    ("30y20y-10y10y","10y10y","30y20y"),
    # Same-start, different-tenor (duration curves)
    ("1y30y-1y10y",  "1y10y", "1y30y"),
    ("1y30y-1y5y",   "1y5y",  "1y30y"),
    ("1y20y-1y5y",   "1y5y",  "1y20y"),
    ("1y30y-1y2y",   "1y2y",  "1y30y"),
    # More ECB path consecutive steps (1y tenor)
    ("5y1y-4y1y",    "4y1y",  "5y1y"),
    ("6y1y-5y1y",    "5y1y",  "6y1y"),
    ("7y1y-6y1y",    "6y1y",  "7y1y"),
    ("8y1y-7y1y",    "7y1y",  "8y1y"),
    # 2y tenor family
    ("2y2y-1y2y",    "1y2y",  "2y2y"),
    ("3y2y-2y2y",    "2y2y",  "3y2y"),
    # 5y tenor family
    ("5y5y-2y5y",    "2y5y",  "5y5y"),
    ("7y5y-5y5y",    "5y5y",  "7y5y"),
    # 10y tenor family
    ("5y10y-2y10y",  "2y10y", "5y10y"),
    ("10y10y-5y10y", "5y10y", "10y10y"),
    # 20y tenor family
    ("5y20y-2y20y",  "2y20y", "5y20y"),
    ("10y20y-5y20y", "5y20y", "10y20y"),
    # Cross-tenor same start
    ("2y10y-2y5y",   "2y5y",  "2y10y"),
    ("5y10y-5y5y",   "5y5y",  "5y10y"),
]

FLIES = [
    # ECB path (1y tenor)
    ("1y1y|2y1y|3y1y",   "1y1y",  "2y1y",  "3y1y"),
    ("2y1y|3y1y|4y1y",   "2y1y",  "3y1y",  "4y1y"),
    # 2y tenor
    ("4y2y|6y2y|8y2y",   "4y2y",  "6y2y",  "8y2y"),
    ("3y2y|5y2y|7y2y",   "3y2y",  "5y2y",  "7y2y"),
    # 5y tenor
    ("5y5y|10y5y|15y5y", "5y5y",  "10y5y", "15y5y"),
    ("10y5y|15y5y|20y5y","10y5y", "15y5y", "20y5y"),
    ("1y5y|5y5y|10y5y",  "1y5y",  "5y5y",  "10y5y"),
    # Mixed / long-end
    ("5y5y|10y10y|20y10y","5y5y", "10y10y","20y10y"),
    ("1y10y|1y20y|1y30y","1y10y", "1y20y", "1y30y"),
    ("1y5y|1y10y|1y30y", "1y5y",  "1y10y", "1y30y"),
    # Tenor butterflies (same start, different tenors)
    ("1y2y|1y5y|1y10y",  "1y2y",  "1y5y",  "1y10y"),
    # ECB path wider flies (1y tenor)
    ("1y1y|3y1y|5y1y",    "1y1y",  "3y1y",  "5y1y"),
    ("3y1y|5y1y|7y1y",    "3y1y",  "5y1y",  "7y1y"),
    ("4y1y|6y1y|8y1y",    "4y1y",  "6y1y",  "8y1y"),
    # 5y tenor extra
    ("1y5y|3y5y|5y5y",    "1y5y",  "3y5y",  "5y5y"),
    ("3y5y|5y5y|7y5y",    "3y5y",  "5y5y",  "7y5y"),
    # 10y tenor flies
    ("1y10y|3y10y|5y10y", "1y10y", "3y10y", "5y10y"),
    ("2y10y|5y10y|10y10y","2y10y", "5y10y", "10y10y"),
    # 20y tenor
    ("2y20y|5y20y|10y20y","2y20y", "5y20y", "10y20y"),
    # Cross-tenor same start (curvature along term structure)
    ("2y5y|2y10y|2y20y",  "2y5y",  "2y10y", "2y20y"),
    ("5y5y|5y10y|5y20y",  "5y5y",  "5y10y", "5y20y"),
    ("1y2y|1y10y|1y20y",  "1y2y",  "1y10y", "1y20y"),
]

# ─── GBP (SONIA) ──────────────────────────────────────────────────────────────

GBP_CURVES = [
    # Short-end / BoE path (1y tenor)
    ("2y1y-1y1y",    "1y1y",  "2y1y"),
    ("3y1y-2y1y",    "2y1y",  "3y1y"),
    ("4y1y-3y1y",    "3y1y",  "4y1y"),
    ("5y1y-4y1y",    "4y1y",  "5y1y"),
    ("6y1y-5y1y",    "5y1y",  "6y1y"),
    ("7y1y-6y1y",    "6y1y",  "7y1y"),
    ("8y1y-7y1y",    "7y1y",  "8y1y"),
    # Medium-term curves
    ("2y2y-1y1y",    "1y1y",  "2y2y"),
    ("1y10y-1y2y",   "1y2y",  "1y10y"),
    # 5y-tenor curves
    ("10y5y-5y5y",   "5y5y",  "10y5y"),
    # Cross-tenor / long-end
    ("20y10y-10y10y","10y10y","20y10y"),
    ("30y20y-10y10y","10y10y","30y20y"),
    # Same-start, different-tenor (duration curves)
    ("1y30y-1y10y",  "1y10y", "1y30y"),
    ("1y30y-1y5y",   "1y5y",  "1y30y"),
    ("1y20y-1y5y",   "1y5y",  "1y20y"),
    ("1y30y-1y2y",   "1y2y",  "1y30y"),
    # 2y tenor family
    ("2y2y-1y2y",    "1y2y",  "2y2y"),
    ("3y2y-2y2y",    "2y2y",  "3y2y"),
    # 5y tenor family
    ("5y5y-2y5y",    "2y5y",  "5y5y"),
    ("7y5y-5y5y",    "5y5y",  "7y5y"),
    # 10y tenor family
    ("5y10y-2y10y",  "2y10y", "5y10y"),
    ("10y10y-5y10y", "5y10y", "10y10y"),
    # 20y tenor family
    ("5y20y-2y20y",  "2y20y", "5y20y"),
    ("10y20y-5y20y", "5y20y", "10y20y"),
    # Cross-tenor same start
    ("2y10y-2y5y",   "2y5y",  "2y10y"),
    ("5y10y-5y5y",   "5y5y",  "5y10y"),
]

GBP_FLIES = [
    # BoE path (1y tenor)
    ("1y1y|2y1y|3y1y",    "1y1y",  "2y1y",  "3y1y"),
    ("2y1y|3y1y|4y1y",    "2y1y",  "3y1y",  "4y1y"),
    ("1y1y|3y1y|5y1y",    "1y1y",  "3y1y",  "5y1y"),
    ("3y1y|5y1y|7y1y",    "3y1y",  "5y1y",  "7y1y"),
    ("4y1y|6y1y|8y1y",    "4y1y",  "6y1y",  "8y1y"),
    # 2y tenor
    ("3y2y|5y2y|7y2y",    "3y2y",  "5y2y",  "7y2y"),
    # 5y tenor
    ("5y5y|10y5y|15y5y",  "5y5y",  "10y5y", "15y5y"),
    ("10y5y|15y5y|20y5y", "10y5y", "15y5y", "20y5y"),
    ("1y5y|5y5y|10y5y",   "1y5y",  "5y5y",  "10y5y"),
    ("1y5y|3y5y|5y5y",    "1y5y",  "3y5y",  "5y5y"),
    # Mixed / long-end
    ("5y5y|10y10y|20y10y","5y5y",  "10y10y","20y10y"),
    ("1y10y|1y20y|1y30y", "1y10y", "1y20y", "1y30y"),
    ("1y5y|1y10y|1y30y",  "1y5y",  "1y10y", "1y30y"),
    # Tenor butterflies (same start, different tenors)
    ("1y2y|1y5y|1y10y",   "1y2y",  "1y5y",  "1y10y"),
    # 10y tenor
    ("1y10y|3y10y|5y10y", "1y10y", "3y10y", "5y10y"),
    ("2y10y|5y10y|10y10y","2y10y", "5y10y", "10y10y"),
    # 20y tenor
    ("2y20y|5y20y|10y20y","2y20y", "5y20y", "10y20y"),
    # Cross-tenor same start
    ("2y5y|2y10y|2y20y",  "2y5y",  "2y10y", "2y20y"),
    ("5y5y|5y10y|5y20y",  "5y5y",  "5y10y", "5y20y"),
    ("1y2y|1y10y|1y20y",  "1y2y",  "1y10y", "1y20y"),
]

# ─── USD (SOFR) ───────────────────────────────────────────────────────────────

USD_CURVES = [
    # Short-end / Fed path (1y tenor)
    ("2y1y-1y1y",    "1y1y",  "2y1y"),
    ("3y1y-2y1y",    "2y1y",  "3y1y"),
    ("4y1y-3y1y",    "3y1y",  "4y1y"),
    ("5y1y-4y1y",    "4y1y",  "5y1y"),
    ("6y1y-5y1y",    "5y1y",  "6y1y"),
    ("7y1y-6y1y",    "6y1y",  "7y1y"),
    ("8y1y-7y1y",    "7y1y",  "8y1y"),
    # Medium-term curves
    ("2y2y-1y1y",    "1y1y",  "2y2y"),
    ("1y10y-1y2y",   "1y2y",  "1y10y"),
    # 5y-tenor curves
    ("10y5y-5y5y",   "5y5y",  "10y5y"),
    # Cross-tenor / long-end
    ("20y10y-10y10y","10y10y","20y10y"),
    ("30y20y-10y10y","10y10y","30y20y"),
    # Same-start, different-tenor (duration curves)
    ("1y30y-1y10y",  "1y10y", "1y30y"),
    ("1y30y-1y5y",   "1y5y",  "1y30y"),
    ("1y20y-1y5y",   "1y5y",  "1y20y"),
    ("1y30y-1y2y",   "1y2y",  "1y30y"),
    # 2y tenor family
    ("2y2y-1y2y",    "1y2y",  "2y2y"),
    ("3y2y-2y2y",    "2y2y",  "3y2y"),
    # 5y tenor family
    ("5y5y-2y5y",    "2y5y",  "5y5y"),
    ("7y5y-5y5y",    "5y5y",  "7y5y"),
    # 10y tenor family
    ("5y10y-2y10y",  "2y10y", "5y10y"),
    ("10y10y-5y10y", "5y10y", "10y10y"),
    # 20y tenor family
    ("5y20y-2y20y",  "2y20y", "5y20y"),
    ("10y20y-5y20y", "5y20y", "10y20y"),
    # Cross-tenor same start
    ("2y10y-2y5y",   "2y5y",  "2y10y"),
    ("5y10y-5y5y",   "5y5y",  "5y10y"),
]

USD_FLIES = [
    # Fed path (1y tenor)
    ("1y1y|2y1y|3y1y",    "1y1y",  "2y1y",  "3y1y"),
    ("2y1y|3y1y|4y1y",    "2y1y",  "3y1y",  "4y1y"),
    ("1y1y|3y1y|5y1y",    "1y1y",  "3y1y",  "5y1y"),
    ("3y1y|5y1y|7y1y",    "3y1y",  "5y1y",  "7y1y"),
    ("4y1y|6y1y|8y1y",    "4y1y",  "6y1y",  "8y1y"),
    # 2y tenor
    ("3y2y|5y2y|7y2y",    "3y2y",  "5y2y",  "7y2y"),
    # 5y tenor
    ("5y5y|10y5y|15y5y",  "5y5y",  "10y5y", "15y5y"),
    ("10y5y|15y5y|20y5y", "10y5y", "15y5y", "20y5y"),
    ("1y5y|5y5y|10y5y",   "1y5y",  "5y5y",  "10y5y"),
    ("1y5y|3y5y|5y5y",    "1y5y",  "3y5y",  "5y5y"),
    # Mixed / long-end
    ("5y5y|10y10y|20y10y","5y5y",  "10y10y","20y10y"),
    ("1y10y|1y20y|1y30y", "1y10y", "1y20y", "1y30y"),
    ("1y5y|1y10y|1y30y",  "1y5y",  "1y10y", "1y30y"),
    # Tenor butterflies
    ("1y2y|1y5y|1y10y",   "1y2y",  "1y5y",  "1y10y"),
    # 10y tenor
    ("1y10y|3y10y|5y10y", "1y10y", "3y10y", "5y10y"),
    ("2y10y|5y10y|10y10y","2y10y", "5y10y", "10y10y"),
    # 20y tenor
    ("2y20y|5y20y|10y20y","2y20y", "5y20y", "10y20y"),
    # Cross-tenor same start
    ("2y5y|2y10y|2y20y",  "2y5y",  "2y10y", "2y20y"),
    ("5y5y|5y10y|5y20y",  "5y5y",  "5y10y", "5y20y"),
    ("1y2y|1y10y|1y20y",  "1y2y",  "1y10y", "1y20y"),
]

# ─── Universe ─────────────────────────────────────────────────────────────────
# One universe for every currency (GBP/USD/EUR lists above are kept as the
# historical record of what each market showed). Leg labels:
#   "5y10y" = 10y swap starting in 5y (forward);  "10y" = 10y spot swap.
# Spot legs start at 2y: a 1y spot swap rolls into an overnight rate, which is
# not on the curve, so its carry is undefined.


def _union(*lists):
    seen, out = set(), []
    for lst in lists:
        for item in lst:
            if item[0] not in seen:
                seen.add(item[0])
                out.append(item)
    return out


# Core: everything the three markets showed before, plus curated additions
CURATED_CURVES = [
    # Spot benchmarks (value = back − front, e.g. 2s10s = 10y − 2y)
    ("2s5s",   "2y",  "5y"),
    ("2s10s",  "2y",  "10y"),
    ("2s30s",  "2y",  "30y"),
    ("5s10s",  "5y",  "10y"),
    ("5s30s",  "5y",  "30y"),
    ("10s20s", "10y", "20y"),
    ("10s30s", "10y", "30y"),
    ("20s30s", "20y", "30y"),
    # Forward vs (near-)spot of the same tenor
    ("5y5y-1y5y",    "1y5y",  "5y5y"),
    ("10y10y-1y10y", "1y10y", "10y10y"),
    ("20y10y-1y10y", "1y10y", "20y10y"),
]

CURATED_FLIES = [
    # Spot benchmarks (value = 2 × belly − wings)
    ("2s5s10s",   "2y",  "5y",  "10y"),
    ("2s10s30s",  "2y",  "10y", "30y"),
    ("5s7s10s",   "5y",  "7y",  "10y"),
    ("5s10s30s",  "5y",  "10y", "30y"),
    ("10s15s20s", "10y", "15y", "20y"),
    ("10s20s30s", "10y", "20y", "30y"),
    # Long-end forwards
    ("1y10y|10y10y|20y10y", "1y10y", "10y10y", "20y10y"),
]

CORE_CURVES = _union(CURVES, GBP_CURVES, USD_CURVES, CURATED_CURVES)
CORE_FLIES  = _union(FLIES, GBP_FLIES, USD_FLIES, CURATED_FLIES)


# Extended: generated from a grid, minus anything already in the core.
#   spot      — every pair of spot tenors; flies on neighbouring spot tenors
#   forwards  — fixed tenor, neighbouring starts (and flies on three neighbours);
#               fixed start, neighbouring tenors (and flies on three neighbours)
# Forwards are capped at start + tenor <= 40y (beyond 30y the curve is extrapolated flat).
SPOT_GRID   = [2, 3, 5, 7, 10, 15, 20, 30]
START_GRID  = [1, 2, 3, 4, 5, 7, 10, 15, 20]
TENOR_GRID  = [1, 2, 3, 5, 10, 20, 30]
MAX_END     = 40


def _spot(t):
    return f"{t}y"


def _fwd(s, t):
    return f"{s}y{t}y"


def _generate():
    curves, flies = [], []
    for i, a in enumerate(SPOT_GRID):
        for b in SPOT_GRID[i + 1:]:
            curves.append((f"{a}s{b}s", _spot(a), _spot(b)))
    for a, b, c in zip(SPOT_GRID, SPOT_GRID[1:], SPOT_GRID[2:]):
        flies.append((f"{a}s{b}s{c}s", _spot(a), _spot(b), _spot(c)))
    for t in TENOR_GRID:     # same tenor, neighbouring starts
        starts = [s for s in START_GRID if s + t <= MAX_END]
        for a, b in zip(starts, starts[1:]):
            curves.append((f"{_fwd(b, t)}-{_fwd(a, t)}", _fwd(a, t), _fwd(b, t)))
        for a, b, c in zip(starts, starts[1:], starts[2:]):
            flies.append((f"{_fwd(a, t)}|{_fwd(b, t)}|{_fwd(c, t)}", _fwd(a, t), _fwd(b, t), _fwd(c, t)))
    for s in START_GRID:     # same start, neighbouring tenors
        tenors = [t for t in TENOR_GRID if s + t <= MAX_END]
        for a, b in zip(tenors, tenors[1:]):
            curves.append((f"{_fwd(s, b)}-{_fwd(s, a)}", _fwd(s, a), _fwd(s, b)))
        for a, b, c in zip(tenors, tenors[1:], tenors[2:]):
            flies.append((f"{_fwd(s, a)}|{_fwd(s, b)}|{_fwd(s, c)}", _fwd(s, a), _fwd(s, b), _fwd(s, c)))
    core = {x[0] for x in CORE_CURVES} | {x[0] for x in CORE_FLIES}
    return [c for c in _union(curves) if c[0] not in core], [f for f in _union(flies) if f[0] not in core]


EXTENDED_CURVES, EXTENDED_FLIES = _generate()

# Kept for callers that look structures up by currency: every market shares the core.
CURVES_BY_CCY = {ccy: CORE_CURVES for ccy in ("EUR", "GBP", "USD")}
FLIES_BY_CCY  = {ccy: CORE_FLIES for ccy in ("EUR", "GBP", "USD")}
