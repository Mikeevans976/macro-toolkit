"""
EGB RV expression definitions for Bund and OAT.

Each expression is a tuple:
  (label, group, legs)

where legs is a list of (country, tenor, weight):
  country: "Bund" | "OAT" | "Bund_ASW" | "OAT_ASW"
  tenor:   int (years)
  weight:  +1 | -1 | +2 (steepener/fly convention)

Level convention (yield expressions):
  value_bps = Σ weight_i × y_i × 100    [y in %, result in bps]
  → positive = back leg minus front leg = steepener is positive when curve is upward sloping

Carry convention:
  carry_bps/yr = Σ weight_i × ((y_T − ESTR) / dur_T + roll_T) × 100
  where roll_T = y(T) − y(T−1) from cubic spline  (positive on upward-sloping curve)

ASW legs are in bps directly; carry_ASW = ASW_bps + roll_bond × 100
"""

# ─── Cross-country spreads (OAT − Bund) ─────────────────────────────────────

EGB_SPREADS = [
    ("OAT-Bund 2y",   "spread", [("OAT", 2,  +1), ("Bund", 2,  -1)]),
    ("OAT-Bund 5y",   "spread", [("OAT", 5,  +1), ("Bund", 5,  -1)]),
    ("OAT-Bund 7y",   "spread", [("OAT", 7,  +1), ("Bund", 7,  -1)]),
    ("OAT-Bund 10y",  "spread", [("OAT", 10, +1), ("Bund", 10, -1)]),
    ("OAT-Bund 15y",  "spread", [("OAT", 15, +1), ("Bund", 15, -1)]),
    ("OAT-Bund 20y",  "spread", [("OAT", 20, +1), ("Bund", 20, -1)]),
    ("OAT-Bund 30y",  "spread", [("OAT", 30, +1), ("Bund", 30, -1)]),
]

# ─── Intra-Bund curves ───────────────────────────────────────────────────────

BUND_CURVES = [
    ("Bund 2s5s",    "bund_curve", [("Bund", 5,  +1), ("Bund", 2,  -1)]),
    ("Bund 2s7s",    "bund_curve", [("Bund", 7,  +1), ("Bund", 2,  -1)]),
    ("Bund 2s10s",   "bund_curve", [("Bund", 10, +1), ("Bund", 2,  -1)]),
    ("Bund 2s30s",   "bund_curve", [("Bund", 30, +1), ("Bund", 2,  -1)]),
    ("Bund 5s10s",   "bund_curve", [("Bund", 10, +1), ("Bund", 5,  -1)]),
    ("Bund 5s30s",   "bund_curve", [("Bund", 30, +1), ("Bund", 5,  -1)]),
    ("Bund 7s10s",   "bund_curve", [("Bund", 10, +1), ("Bund", 7,  -1)]),
    ("Bund 10s15s",  "bund_curve", [("Bund", 15, +1), ("Bund", 10, -1)]),
    ("Bund 10s20s",  "bund_curve", [("Bund", 20, +1), ("Bund", 10, -1)]),
    ("Bund 10s30s",  "bund_curve", [("Bund", 30, +1), ("Bund", 10, -1)]),
    ("Bund 20s30s",  "bund_curve", [("Bund", 30, +1), ("Bund", 20, -1)]),
]

# ─── Intra-OAT curves ────────────────────────────────────────────────────────

OAT_CURVES = [
    ("OAT 2s5s",     "oat_curve", [("OAT", 5,  +1), ("OAT", 2,  -1)]),
    ("OAT 2s10s",    "oat_curve", [("OAT", 10, +1), ("OAT", 2,  -1)]),
    ("OAT 2s30s",    "oat_curve", [("OAT", 30, +1), ("OAT", 2,  -1)]),
    ("OAT 5s10s",    "oat_curve", [("OAT", 10, +1), ("OAT", 5,  -1)]),
    ("OAT 5s30s",    "oat_curve", [("OAT", 30, +1), ("OAT", 5,  -1)]),
    ("OAT 10s20s",   "oat_curve", [("OAT", 20, +1), ("OAT", 10, -1)]),
    ("OAT 10s30s",   "oat_curve", [("OAT", 30, +1), ("OAT", 10, -1)]),
]

# ─── Intra-Bund flies ────────────────────────────────────────────────────────

BUND_FLIES = [
    ("Bund 2s5s10s",   "bund_fly", [("Bund", 2,  -1), ("Bund", 5,  +2), ("Bund", 10, -1)]),
    ("Bund 2s10s20s",  "bund_fly", [("Bund", 2,  -1), ("Bund", 10, +2), ("Bund", 20, -1)]),
    ("Bund 2s10s30s",  "bund_fly", [("Bund", 2,  -1), ("Bund", 10, +2), ("Bund", 30, -1)]),
    ("Bund 5s10s20s",  "bund_fly", [("Bund", 5,  -1), ("Bund", 10, +2), ("Bund", 20, -1)]),
    ("Bund 5s10s30s",  "bund_fly", [("Bund", 5,  -1), ("Bund", 10, +2), ("Bund", 30, -1)]),
    ("Bund 5s15s30s",  "bund_fly", [("Bund", 5,  -1), ("Bund", 15, +2), ("Bund", 30, -1)]),
    ("Bund 10s20s30s", "bund_fly", [("Bund", 10, -1), ("Bund", 20, +2), ("Bund", 30, -1)]),
]

# ─── Intra-OAT flies ─────────────────────────────────────────────────────────

OAT_FLIES = [
    ("OAT 2s5s10s",    "oat_fly",  [("OAT", 2,  -1), ("OAT", 5,  +2), ("OAT", 10, -1)]),
    ("OAT 2s10s30s",   "oat_fly",  [("OAT", 2,  -1), ("OAT", 10, +2), ("OAT", 30, -1)]),
    ("OAT 5s10s30s",   "oat_fly",  [("OAT", 5,  -1), ("OAT", 10, +2), ("OAT", 30, -1)]),
    ("OAT 5s15s30s",   "oat_fly",  [("OAT", 5,  -1), ("OAT", 15, +2), ("OAT", 30, -1)]),
    ("OAT 10s20s30s",  "oat_fly",  [("OAT", 10, -1), ("OAT", 20, +2), ("OAT", 30, -1)]),
]

# ─── Box trades (OAT curve minus Bund curve) ─────────────────────────────────
# Positive = OAT curve steeper than Bund curve

EGB_BOXES = [
    ("Box OAT/Bund 2s10s",  "box", [("OAT", 10, +1), ("OAT", 2,  -1), ("Bund", 10, -1), ("Bund", 2,  +1)]),
    ("Box OAT/Bund 2s30s",  "box", [("OAT", 30, +1), ("OAT", 2,  -1), ("Bund", 30, -1), ("Bund", 2,  +1)]),
    ("Box OAT/Bund 5s10s",  "box", [("OAT", 10, +1), ("OAT", 5,  -1), ("Bund", 10, -1), ("Bund", 5,  +1)]),
    ("Box OAT/Bund 5s30s",  "box", [("OAT", 30, +1), ("OAT", 5,  -1), ("Bund", 30, -1), ("Bund", 5,  +1)]),
    ("Box OAT/Bund 10s30s", "box", [("OAT", 30, +1), ("OAT", 10, -1), ("Bund", 30, -1), ("Bund", 10, +1)]),
]

# ─── Asset swap spreads ───────────────────────────────────────────────────────
# Carry = ASW_level_bps + roll_down_bond_bps

EGB_ASW = [
    ("Bund ASW 2y",  "asw", [("Bund_ASW", 2,  +1)]),
    ("Bund ASW 5y",  "asw", [("Bund_ASW", 5,  +1)]),
    ("Bund ASW 10y", "asw", [("Bund_ASW", 10, +1)]),
    ("Bund ASW 30y", "asw", [("Bund_ASW", 30, +1)]),
    ("OAT ASW 2y",   "asw", [("OAT_ASW",  2,  +1)]),
    ("OAT ASW 5y",   "asw", [("OAT_ASW",  5,  +1)]),
    ("OAT ASW 10y",  "asw", [("OAT_ASW",  10, +1)]),
    ("OAT ASW 30y",  "asw", [("OAT_ASW",  30, +1)]),
]

# ─── All expressions (ordered for display) ───────────────────────────────────

ALL_EXPRESSIONS = (
    EGB_SPREADS
    + BUND_CURVES
    + OAT_CURVES
    + BUND_FLIES
    + OAT_FLIES
    + EGB_BOXES
    + EGB_ASW
)

# ─── Group metadata ───────────────────────────────────────────────────────────

GROUP_META = {
    "spread":     {"label": "OAT−Bund Spreads",   "color": "#F59E0B"},
    "bund_curve": {"label": "Bund Curves",         "color": "#3B82F6"},
    "oat_curve":  {"label": "OAT Curves",          "color": "#8B5CF6"},
    "bund_fly":   {"label": "Bund Flies",          "color": "#10B981"},
    "oat_fly":    {"label": "OAT Flies",           "color": "#06B6D4"},
    "box":        {"label": "Boxes (OAT vs Bund)", "color": "#EC4899"},
    "asw":        {"label": "Asset Swap Spreads",  "color": "#EF4444"},
}
