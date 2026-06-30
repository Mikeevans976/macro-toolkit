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

# ─── Lookup by currency ───────────────────────────────────────────────────────

CURVES_BY_CCY = {
    "EUR": CURVES,
    "GBP": GBP_CURVES,
    "USD": USD_CURVES,
}

FLIES_BY_CCY = {
    "EUR": FLIES,
    "GBP": GBP_FLIES,
    "USD": USD_FLIES,
}
