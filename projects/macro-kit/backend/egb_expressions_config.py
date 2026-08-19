"""
EGB RV expression definitions — Bund, OAT, BTP, Bonos, Belgium, Portugal,
Netherlands, Austria, Finland.

Each expression: (label, group, legs)
  legs: list of (country, tenor, weight)
    country: yield country name or "<Country>_ASW"
    tenor:   int (years)
    weight:  +1 | -1 | +2

Carry convention (yield legs):
  carry_bps = Σ weight_i × ((y_T − repo_i) / dur_T + roll_T) × 100
  where repo_i is looked up from the country's repo bloc (see REPO_BLOC below).

Repo blocs:
  "Bund"  — Bund (often trades special)
  "OAT"   — OAT, Belgium, Netherlands, Austria, Finland (near GC)
  "BTP"   — Italy
  "Bonos" — Spain, Portugal (peripheral GC proxy)

Bloomberg tickers (⚠️ = verify before live use):
  Bund        : GDBR{T} Index
  OAT         : GFRN{T} Index
  BTP         : GBTPGR{T} Index
  Bonos       : GSPG{T}YR Index
  Belgium     : GBGB{T}YR Index      ⚠️
  Portugal    : GPTIT{T}YR Index     ⚠️
  Netherlands : GNETH{T}YR Index     ⚠️
  Austria     : GAGB{T}YR Index      ⚠️
  Finland     : GFINGB{T} Index      ⚠️
"""

from itertools import combinations as _comb

# ─── Country repo blocs ───────────────────────────────────────────────────────

REPO_BLOC: dict[str, str] = {
    "Bund":        "Bund",
    "OAT":         "OAT",
    "BTP":         "BTP",
    "Bonos":       "Bonos",
    "Belgium":     "OAT",     # semi-core, near GC
    "Netherlands": "OAT",     # semi-core, near GC
    "Austria":     "OAT",     # semi-core, near GC
    "Finland":     "OAT",     # semi-core, near GC
    "Portugal":    "Bonos",   # peripheral, similar to Bonos repo
}

# Repo blocs that have user-adjustable sliders
REPO_BLOCS = ["Bund", "OAT", "BTP", "Bonos"]

# ─── Benchmark tenors per country ────────────────────────────────────────────

COUNTRY_TENORS: dict[str, list[int]] = {
    "Bund":        [2, 5, 7, 10, 15, 20, 30],
    "OAT":         [2, 5, 7, 10, 15, 20, 30],
    "BTP":         [2, 5, 7, 10, 15, 20, 30],
    "Bonos":       [2, 5, 7, 10, 15, 20, 30],
    "Belgium":     [2, 5, 10, 15, 20, 30],
    "Portugal":    [2, 5, 10, 15, 30],
    "Netherlands": [2, 5, 10, 15, 20, 30],
    "Austria":     [2, 5, 10, 15, 20, 30],
    "Finland":     [2, 5, 10, 20, 30],
}

# All tenors used (union) — for simulation
ALL_TENORS = [2, 5, 7, 10, 15, 20, 30]

# Short label map for display
_SHORT: dict[str, str] = {
    "Netherlands": "NL",
    "Belgium":     "BE",
    "Portugal":    "PGB",
    "Austria":     "AT",
    "Finland":     "FI",
}

def _lbl(country: str) -> str:
    return _SHORT.get(country, country)

# Typical spread level vs Bund — used to order cross-country spread pairs
# (wider country listed first so the level is positive by convention)
_SPREAD_RANK: dict[str, int] = {
    "Bund":        0,
    "Netherlands": 1,
    "Finland":     2,
    "Austria":     3,
    "Belgium":     4,
    "OAT":         5,
    "Portugal":    6,
    "Bonos":       7,
    "BTP":         8,
}

_PERIPHERAL = {"BTP", "Bonos", "Portugal"}

def _cross_group(a: str, b: str) -> str:
    """spread_periph if either leg is a peripheral country, else spread_core."""
    return "spread_periph" if (a in _PERIPHERAL or b in _PERIPHERAL) else "spread_core"

# ─── Spreads vs Bund ─────────────────────────────────────────────────────────

def _make_spreads_vs_bund(country: str) -> list:
    """All tenors this country shares with Bund."""
    bund_set = set(COUNTRY_TENORS["Bund"])
    tenors = [t for t in COUNTRY_TENORS[country] if t in bund_set]
    grp = "spread_periph" if country in _PERIPHERAL else "spread_core"
    short = _lbl(country)
    return [
        (f"{short}-Bund {t}y", grp, [(country, t, +1), ("Bund", t, -1)])
        for t in tenors
    ]


EGB_SPREADS_VS_BUND = (
    _make_spreads_vs_bund("OAT")
    + _make_spreads_vs_bund("BTP")
    + _make_spreads_vs_bund("Bonos")
    + _make_spreads_vs_bund("Belgium")
    + _make_spreads_vs_bund("Portugal")
    + _make_spreads_vs_bund("Netherlands")
    + _make_spreads_vs_bund("Austria")
    + _make_spreads_vs_bund("Finland")
)

# ─── Cross-country spreads (all non-Bund pairs) ───────────────────────────────

_NON_BUND = [c for c in COUNTRY_TENORS if c != "Bund"]


def _all_cross_spreads() -> list:
    """
    For every pair of non-Bund countries, generate one spread per shared tenor.
    Convention: wider country (higher _SPREAD_RANK) listed first → positive level.
    """
    result = []
    for a, b in _comb(_NON_BUND, 2):
        # Ensure a is the wider country
        if _SPREAD_RANK[a] < _SPREAD_RANK[b]:
            a, b = b, a
        shared = [t for t in COUNTRY_TENORS[a] if t in COUNTRY_TENORS[b]]
        grp = _cross_group(a, b)
        la, lb = _lbl(a), _lbl(b)
        for t in shared:
            result.append((f"{la}-{lb} {t}y", grp, [(a, t, +1), (b, t, -1)]))
    return result


CROSS_SPREADS = _all_cross_spreads()

EGB_SPREADS = EGB_SPREADS_VS_BUND + CROSS_SPREADS

# ─── Intra-country curves (ALL pairs) ────────────────────────────────────────

def _all_curves(country: str, group: str) -> list:
    """All (t1, t2) steepener pairs where t1 < t2."""
    short = _lbl(country)
    tenors = COUNTRY_TENORS[country]
    return [
        (f"{short} {t1}s{t2}s", group,
         [(country, t2, +1), (country, t1, -1)])
        for t1, t2 in _comb(tenors, 2)
    ]


BUND_CURVES   = _all_curves("Bund",        "bund_curve")
OAT_CURVES    = _all_curves("OAT",         "oat_curve")
BTP_CURVES    = _all_curves("BTP",         "btp_curve")
BONOS_CURVES  = _all_curves("Bonos",       "bonos_curve")
BE_CURVES     = _all_curves("Belgium",     "other_curve")
PGB_CURVES    = _all_curves("Portugal",    "other_curve")
NL_CURVES     = _all_curves("Netherlands", "other_curve")
AT_CURVES     = _all_curves("Austria",     "other_curve")
FI_CURVES     = _all_curves("Finland",     "other_curve")

ALL_CURVES = (
    BUND_CURVES + OAT_CURVES + BTP_CURVES + BONOS_CURVES
    + BE_CURVES + PGB_CURVES + NL_CURVES + AT_CURVES + FI_CURVES
)

# ─── Intra-country flies (ALL triples) ───────────────────────────────────────

def _all_flies(country: str, group: str) -> list:
    """All (t1, t2, t3) butterfly positions where t1 < t2 < t3."""
    short = _lbl(country)
    tenors = COUNTRY_TENORS[country]
    return [
        (f"{short} {t1}s{t2}s{t3}s", group,
         [(country, t1, -1), (country, t2, +2), (country, t3, -1)])
        for t1, t2, t3 in _comb(tenors, 3)
    ]


BUND_FLIES  = _all_flies("Bund",        "bund_fly")
OAT_FLIES   = _all_flies("OAT",         "oat_fly")
BTP_FLIES   = _all_flies("BTP",         "btp_fly")
BONOS_FLIES = _all_flies("Bonos",       "bonos_fly")
BE_FLIES    = _all_flies("Belgium",     "other_fly")
PGB_FLIES   = _all_flies("Portugal",    "other_fly")
NL_FLIES    = _all_flies("Netherlands", "other_fly")
AT_FLIES    = _all_flies("Austria",     "other_fly")
FI_FLIES    = _all_flies("Finland",     "other_fly")

ALL_FLIES = (
    BUND_FLIES + OAT_FLIES + BTP_FLIES + BONOS_FLIES
    + BE_FLIES + PGB_FLIES + NL_FLIES + AT_FLIES + FI_FLIES
)

# ─── Boxes: all country/Bund curve pairs ─────────────────────────────────────

def _all_boxes(country: str) -> list:
    """All boxes: (country t1s-t2s) vs (Bund t1s-t2s), using tenors shared with Bund."""
    short = _lbl(country)
    bund_set = set(COUNTRY_TENORS["Bund"])
    shared = [t for t in COUNTRY_TENORS[country] if t in bund_set]
    return [
        (f"Box {short}/Bund {t1}s{t2}s", "box",
         [(country, t2, +1), (country, t1, -1), ("Bund", t2, -1), ("Bund", t1, +1)])
        for t1, t2 in _comb(shared, 2)
    ]


EGB_BOXES_VS_BUND = (
    _all_boxes("OAT")
    + _all_boxes("BTP")
    + _all_boxes("Bonos")
    + _all_boxes("Belgium")
    + _all_boxes("Portugal")
    + _all_boxes("Netherlands")
    + _all_boxes("Austria")
    + _all_boxes("Finland")
)

# ─── Cross-country boxes (all non-Bund pairs) ─────────────────────────────────

def _all_cross_boxes() -> list:
    """
    For every pair of non-Bund countries, generate Box A/B t1s-t2s for all
    shared tenor pairs.  Convention: A is the wider country (higher _SPREAD_RANK),
    so Box A/B = (A curve - B curve) > 0 when A has a steeper curve.
    """
    result = []
    for a, b in _comb(_NON_BUND, 2):
        if _SPREAD_RANK[a] < _SPREAD_RANK[b]:
            a, b = b, a
        shared = [t for t in COUNTRY_TENORS[a] if t in COUNTRY_TENORS[b]]
        la, lb = _lbl(a), _lbl(b)
        for t1, t2 in _comb(shared, 2):
            result.append((
                f"Box {la}/{lb} {t1}s{t2}s", "box_cross",
                [(a, t2, +1), (a, t1, -1), (b, t2, -1), (b, t1, +1)],
            ))
    return result


CROSS_BOXES = _all_cross_boxes()

EGB_BOXES = EGB_BOXES_VS_BUND + CROSS_BOXES

# ─── Asset swap spreads ───────────────────────────────────────────────────────

EGB_ASW = [
    ("Bund ASW 2y",  "asw", [("Bund_ASW",    2,  +1)]),
    ("Bund ASW 5y",  "asw", [("Bund_ASW",    5,  +1)]),
    ("Bund ASW 10y", "asw", [("Bund_ASW",    10, +1)]),
    ("Bund ASW 30y", "asw", [("Bund_ASW",    30, +1)]),
    ("OAT ASW 2y",   "asw", [("OAT_ASW",     2,  +1)]),
    ("OAT ASW 5y",   "asw", [("OAT_ASW",     5,  +1)]),
    ("OAT ASW 10y",  "asw", [("OAT_ASW",     10, +1)]),
    ("OAT ASW 30y",  "asw", [("OAT_ASW",     30, +1)]),
    ("BTP ASW 5y",   "asw", [("BTP_ASW",     5,  +1)]),
    ("BTP ASW 10y",  "asw", [("BTP_ASW",     10, +1)]),
    ("BTP ASW 30y",  "asw", [("BTP_ASW",     30, +1)]),
    ("Bonos ASW 5y", "asw", [("Bonos_ASW",   5,  +1)]),
    ("Bonos ASW 10y","asw", [("Bonos_ASW",   10, +1)]),
    ("BE ASW 10y",   "asw", [("Belgium_ASW", 10, +1)]),
    ("NL ASW 10y",   "asw", [("Netherlands_ASW", 10, +1)]),
]

# ─── All expressions ──────────────────────────────────────────────────────────

ALL_EXPRESSIONS = (
    EGB_SPREADS
    + ALL_CURVES
    + ALL_FLIES
    + EGB_BOXES
    + EGB_ASW
)

# ─── Group metadata ───────────────────────────────────────────────────────────

GROUP_META = {
    "spread_core":   {"label": "Core Spreads",               "color": "#F59E0B"},
    "spread_periph": {"label": "Peripheral Spreads",         "color": "#EF4444"},
    "bund_curve":    {"label": "Bund Curves",                "color": "#3B82F6"},
    "oat_curve":     {"label": "OAT Curves",                 "color": "#8B5CF6"},
    "btp_curve":     {"label": "BTP Curves",                 "color": "#10B981"},
    "bonos_curve":   {"label": "Bonos Curves",               "color": "#06B6D4"},
    "other_curve":   {"label": "Other Curves (BE/PGB/NL/AT/FI)", "color": "#6366F1"},
    "bund_fly":      {"label": "Bund Flies",                 "color": "#60A5FA"},
    "oat_fly":       {"label": "OAT Flies",                  "color": "#A78BFA"},
    "btp_fly":       {"label": "BTP Flies",                  "color": "#34D399"},
    "bonos_fly":     {"label": "Bonos Flies",                "color": "#2DD4BF"},
    "other_fly":     {"label": "Other Flies (BE/PGB/NL/AT/FI)", "color": "#818CF8"},
    "box":           {"label": "Boxes vs Bund",              "color": "#EC4899"},
    "box_cross":     {"label": "Cross-Country Boxes",        "color": "#F472B6"},
    "asw":           {"label": "Asset Swap Spreads",         "color": "#F87171"},
}
