"""
Step-by-step manual validation of the 10y5y-5y5y flattener
against the tool's compute_rv() output.

Run:  python backend/tests/validate_10y5y_5y5y.py

All arithmetic is written out explicitly so it can be verified
with a calculator or spreadsheet.
"""

import sys
from pathlib import Path
import numpy as np
import pandas as pd
from scipy import stats as scipy_stats

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from swaps_rv import (
    _build_discount_factors,
    _fwd_rate,
    _carry_fwd_bps,
    _carry_expr_bps,
    compute_rv,
    _SWAP_TENORS,
)

BOLD  = "\033[1m"
END   = "\033[0m"
GREEN = "\033[92m"
RED   = "\033[91m"

def check(label: str, expected: float, got: float, tol: float = 0.01) -> bool:
    ok = abs(got - expected) <= tol
    mark = f"{GREEN} PASS{END}" if ok else f"{RED} FAIL{END}"
    print(f"  {mark}  {label}")
    print(f"         hand : {expected:.6f}")
    print(f"         tool : {got:.6f}")
    if not ok:
        print(f"         diff : {abs(got-expected):.6f}  (tol {tol})")
    return ok

DATA = Path(__file__).resolve().parents[2] / "data"


# ─── Load data (same logic as compute_rv) ────────────────────────────────────
fwd_df  = pd.read_csv(DATA/"eur_estr_forwards.csv",  parse_dates=["date"], index_col="date")
beta_df = pd.read_csv(DATA/"eur_beta_variables.csv",  parse_dates=["date"], index_col="date")
swap_df = pd.read_csv(DATA/"eur_estr_swaps.csv",      parse_dates=["date"], index_col="date")

common  = fwd_df.index.intersection(beta_df.index)
fwd_df  = fwd_df.loc[common].sort_index()
n       = len(fwd_df)
win_1y  = min(252, n)
win_3m  = min(63, n)

as_of_ts = fwd_df.index[-1]
swap_row = swap_df.loc[swap_df.index <= as_of_ts].iloc[-1].values.astype(float)
D        = _build_discount_factors(swap_row)

print(f"\n{BOLD}10y5y-5y5y Flattener — Manual Validation{END}")
print(f"As-of date : {as_of_ts.date()}")
print(f"History    : {n} trading days")
print(f"1y window  : {win_1y} days   3m window: {win_3m} days")


# ─────────────────────────────────────────────────────────────────────────────
# STEP 1 — Discount factors at key maturities
# ─────────────────────────────────────────────────────────────────────────────
print(f"\n{BOLD}━━ STEP 1  Discount factors ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━{END}")
print("""
  Bootstrap formula:  D(n) = (1 – R(n) × Σ_{k=1}^{n-1} D(k)) / (1 + R(n))
  Applied iteratively up to tenor 20 (needed for 10y5y = starts yr 10, ends yr 15 ← actually yr 15)

  We need D(5)..D(15) for the 5y5y annuity and D(10)..D(15) for the 10y5y annuity.
  Rather than showing all 20 steps, we state the outputs of the bootstrap
  and verify them via the repricing condition:
      R(n) × Σ_{k=1}^{n} D(k) = 1 – D(n)   [par swap must price at par]
""")

for tenor, d_val in [(5, D[5]), (10, D[10]), (15, D[15]), (20, D[20])]:
    # Repricing check: R(tenor) * annuity = 1 - D(tenor)
    from scipy.interpolate import CubicSpline
    cs = CubicSpline(_SWAP_TENORS, swap_row, bc_type="not-a-knot")
    rates_full = cs(np.arange(1, 51, dtype=float))
    rates_full[30:] = swap_row[-1]
    R_n = rates_full[tenor - 1] / 100.0
    annuity_n = sum(D[k] for k in range(1, tenor + 1))
    pv_fixed  = R_n * annuity_n
    pv_float  = 1.0 - d_val
    reprice_ok = abs(pv_fixed - pv_float) < 1e-6
    mark = f"{GREEN}✓{END}" if reprice_ok else f"{RED}✗{END}"
    print(f"  D({tenor:2d}) = {d_val:.8f}   reprice check: R({tenor}y)×annuity = {pv_fixed:.8f},  1-D({tenor}) = {pv_float:.8f}  {mark}")


# ─────────────────────────────────────────────────────────────────────────────
# STEP 2 — Forward par rates f(5,5) and f(10,5)
# ─────────────────────────────────────────────────────────────────────────────
print(f"\n{BOLD}━━ STEP 2  Forward par rates ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━{END}")

A55  = sum(D[5+k]  for k in range(1, 6))   # D(6)+D(7)+D(8)+D(9)+D(10)
A105 = sum(D[10+k] for k in range(1, 6))   # D(11)+D(12)+D(13)+D(14)+D(15)

f55  = (D[5]  - D[10]) / A55  * 100.0
f105 = (D[10] - D[15]) / A105 * 100.0

print(f"""
  f(5,5)  = (D(5) – D(10)) / [D(6)+D(7)+D(8)+D(9)+D(10)]
           = ({D[5]:.8f} – {D[10]:.8f}) / {A55:.8f}
           = {D[5]-D[10]:.8f} / {A55:.8f}
           = {f55:.6f} %

  f(10,5) = (D(10) – D(15)) / [D(11)+D(12)+D(13)+D(14)+D(15)]
           = ({D[10]:.8f} – {D[15]:.8f}) / {A105:.8f}
           = {D[10]-D[15]:.8f} / {A105:.8f}
           = {f105:.6f} %
""")

all_pass = True
all_pass &= check("f(5,5)  %", f55,  _fwd_rate(5,  5, D))
all_pass &= check("f(10,5) %", f105, _fwd_rate(10, 5, D))

# Spot-check against CSV forward rates
csv_f55  = float(fwd_df['5y5y'].iloc[-1])
csv_f105 = float(fwd_df['10y5y'].iloc[-1])
all_pass &= check("f(5,5)  % vs CSV",  f55,  csv_f55,  tol=0.01)
all_pass &= check("f(10,5) % vs CSV",  f105, csv_f105, tol=0.01)


# ─────────────────────────────────────────────────────────────────────────────
# STEP 3 — Expression value
# ─────────────────────────────────────────────────────────────────────────────
print(f"\n{BOLD}━━ STEP 3  Expression value (flattener) ━━━━━━━━━━━━━━━━━━━{END}")

hand_value = (f105 - f55) * 100.0
print(f"""
  value = (f(10,5) – f(5,5)) × 100
        = ({f105:.6f}% – {f55:.6f}%) × 100
        = {f105-f55:.6f}% × 100
        = {hand_value:.4f} bps
""")

series  = (fwd_df['10y5y'] - fwd_df['5y5y']) * 100.0
current = float(series.iloc[-1])
all_pass &= check("current value (bps)", hand_value, current, tol=0.02)


# ─────────────────────────────────────────────────────────────────────────────
# STEP 4 — Z-score and percentile
# ─────────────────────────────────────────────────────────────────────────────
print(f"\n{BOLD}━━ STEP 4  Z-score and percentile (1y window = {win_1y} days) ━━{END}")

window   = series.iloc[-win_1y:]
mean_1y  = float(window.mean())
std_1y   = float(window.std())     # pandas ddof=1
hand_z   = round((current - mean_1y) / std_1y, 2) if std_1y > 0 else 0.0
hand_pct = round(float(scipy_stats.percentileofscore(window.values, current)), 1)

print(f"""
  1y window: {win_1y} daily observations

  mean  = {mean_1y:.4f} bps
  std   = {std_1y:.4f} bps   (sample, ddof=1)

  z-score = (current – mean) / std
          = ({current:.4f} – {mean_1y:.4f}) / {std_1y:.4f}
          = {current - mean_1y:.4f} / {std_1y:.4f}
          = {hand_z:.4f}

  percentile = fraction of {win_1y} observations ≤ {current:.2f} bps
             = {hand_pct:.1f}%
""")

rv = compute_rv()
row = next(r for r in rv["rv_monitor"] if r["label"] == "10y5y-5y5y")

all_pass &= check("z-score",    hand_z,   row["zscore_1y"])
all_pass &= check("percentile", hand_pct, row["pctile_1y"])


# ─────────────────────────────────────────────────────────────────────────────
# STEP 5 — 3m realised vol
# ─────────────────────────────────────────────────────────────────────────────
print(f"\n{BOLD}━━ STEP 5  3m realised vol ({win_3m}-day window) ━━━━━━━━━━━━━━{END}")

daily_ch   = series.diff().iloc[-win_3m:]
std_daily  = float(daily_ch.std())
hand_vol   = round(std_daily * (252**0.5), 2)

print(f"""
  Formula: std(daily bps changes, last {win_3m} days) × √252

  std of daily changes = {std_daily:.6f} bps/day
  annualised vol       = {std_daily:.6f} × √252
                       = {std_daily:.6f} × {252**0.5:.6f}
                       = {hand_vol:.4f} bps
""")

all_pass &= check("3m vol (bps)", hand_vol, row["vol3m_bps"])


# ─────────────────────────────────────────────────────────────────────────────
# STEP 6 — 1y carry
# ─────────────────────────────────────────────────────────────────────────────
print(f"\n{BOLD}━━ STEP 6  1y carry ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━{END}")

A45  = sum(D[4+k]  for k in range(1, 6))   # annuity for f(4,5): D(5)+...+D(9)
A95  = sum(D[9+k]  for k in range(1, 6))   # annuity for f(9,5): D(10)+...+D(14)
f45  = (D[4]  - D[9])  / A45  * 100.0      # f(4,5)  — rolled 5y5y
f95  = (D[9]  - D[14]) / A95  * 100.0      # f(9,5)  — rolled 10y5y

hand_carry_5y5y  = (f55  - f45)  * 100.0   # receiver convention: f_now – f_rolled
hand_carry_10y5y = (f105 - f95)  * 100.0
hand_carry_expr  = -hand_carry_5y5y + hand_carry_10y5y   # weights (-1, +1)

print(f"""
  Receiver convention:  carry(label) = (f_now – f_rolled) × 100  [bps]

  For 5y5y  (s=5, t=5):
      f_now    = f(5,5)  = {f55:.6f} %
      f_rolled = f(4,5)  = (D(4)–D(9)) / [D(5)+…+D(9)]
               = ({D[4]:.8f}–{D[9]:.8f}) / {A45:.8f}
               = {f45:.6f} %
      carry    = ({f55:.6f}–{f45:.6f}) × 100 = {hand_carry_5y5y:.4f} bps

  For 10y5y (s=10, t=5):
      f_now    = f(10,5) = {f105:.6f} %
      f_rolled = f(9,5)  = (D(9)–D(14)) / [D(10)+…+D(14)]
               = ({D[9]:.8f}–{D[14]:.8f}) / {A95:.8f}
               = {f95:.6f} %
      carry    = ({f105:.6f}–{f95:.6f}) × 100 = {hand_carry_10y5y:.4f} bps

  Flattener carry = (−1)×carry(5y5y) + (+1)×carry(10y5y)
                  = (−1)×{hand_carry_5y5y:.4f} + (+1)×{hand_carry_10y5y:.4f}
                  = {hand_carry_expr:.4f} bps
""")

all_pass &= check("carry(5y5y)  bps",  hand_carry_5y5y,  _carry_fwd_bps("5y5y",  D))
all_pass &= check("carry(10y5y) bps",  hand_carry_10y5y, _carry_fwd_bps("10y5y", D))
all_pass &= check("carry(expr)  bps",  hand_carry_expr,
                  _carry_expr_bps(("5y5y","10y5y"), (-1,1), D))
all_pass &= check("carry(expr)  bps vs compute_rv()", hand_carry_expr, row["carry1y_bps"])


# ─────────────────────────────────────────────────────────────────────────────
# STEP 7 — Carry/vol ratio
# ─────────────────────────────────────────────────────────────────────────────
print(f"\n{BOLD}━━ STEP 7  Carry / vol ratio ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━{END}")

hand_cv = round(hand_carry_expr / hand_vol, 2) if hand_vol > 0 else None
print(f"""
  C/V = carry / vol = {hand_carry_expr:.4f} / {hand_vol:.4f} = {hand_cv}
""")
all_pass &= check("C/V ratio", hand_cv, row["carry_vol_ratio"], tol=0.02)


# ─────────────────────────────────────────────────────────────────────────────
# STEP 8 — Changes (Δ1d, Δ1w, Δ1m)
# ─────────────────────────────────────────────────────────────────────────────
print(f"\n{BOLD}━━ STEP 8  Changes ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━{END}")

d1d = round(float(series.iloc[-1] - series.iloc[-2]),  2)
d1w = round(float(series.iloc[-1] - series.iloc[-6]),  2)
d1m = round(float(series.iloc[-1] - series.iloc[-22]), 2)

print(f"""
  Δ1d = today – yesterday   = {series.iloc[-1]:.2f} – {series.iloc[-2]:.2f} = {d1d:+.2f} bps
  Δ1w = today – 5 days ago  = {series.iloc[-1]:.2f} – {series.iloc[-6]:.2f} = {d1w:+.2f} bps
  Δ1m = today – 21 days ago = {series.iloc[-1]:.2f} – {series.iloc[-22]:.2f} = {d1m:+.2f} bps
""")

all_pass &= check("d1d (bps)", d1d, row["d1d_bps"])
all_pass &= check("d1w (bps)", d1w, row["d1w_bps"])
all_pass &= check("d1m (bps)", d1m, row["d1m_bps"])


# ─────────────────────────────────────────────────────────────────────────────
# SUMMARY
# ─────────────────────────────────────────────────────────────────────────────
print(f"\n{BOLD}{'─'*60}{END}")
if all_pass:
    print(f"{BOLD}{GREEN}  ALL CHECKS PASSED ✓{END}")
else:
    print(f"{BOLD}{RED}  SOME CHECKS FAILED — see above{END}")
print(f"{BOLD}{'─'*60}{END}")

print(f"""
  Final summary for 10y5y-5y5y on {as_of_ts.date()}:

  Value      {current:.2f} bps
  Δ1d        {d1d:+.2f} bps
  Δ1w        {d1w:+.2f} bps
  Δ1m        {d1m:+.2f} bps
  3m vol     {hand_vol:.2f} bps
  Carry      {hand_carry_expr:.2f} bps
  C/V        {hand_cv}
  Z-score    {hand_z}
  Percentile {hand_pct}%
""")
