#!/usr/bin/env python3
"""
Derive 34 EUR ESTR forward par swap rates from the simulated OTR swap curve.

Methodology
-----------
1. Load data/eur_estr_swaps.csv (15 par swap tenors, 1y–30y).
2. For each business day, interpolate par rates to every integer tenor 1–35y
   (cubic spline on the grid; flat extrapolation beyond 30y).
3. Bootstrap a zero curve (annual-pay OIS approximation):
      D(1)  = 1 / (1 + R(1))
      D(n)  = (1 – R(n) · Σ D(i), i<n) / (1 + R(n))
4. Compute forward par swap rates:
      f(s,t) = (D(s) – D(s+t)) / Σ D(s+k), k=1..t     [%]

Forwards (34 total)
-------------------
  1y tenor  : 1y1y 2y1y 3y1y 4y1y 5y1y 6y1y 7y1y 8y1y 9y1y
  2y tenor  : 1y2y 2y2y 3y2y 5y2y
  5y tenor  : 1y5y 2y5y 3y5y 5y5y 7y5y
  10y tenor : 1y10y 2y10y 3y10y 5y10y 10y10y
  15y tenor : 2y15y 5y15y 10y15y
  20y tenor : 1y20y 2y20y 5y20y 10y20y
  25/30y    : 2y25y 5y25y 2y30y 5y30y

Output: data/eur_estr_forwards.csv
Usage:  python backend/scripts/simulate_forwards.py
"""

import numpy as np
import pandas as pd
from scipy.interpolate import CubicSpline
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

INPUT_PATH  = Path(__file__).resolve().parents[2] / "data" / "eur_estr_swaps.csv"
OUTPUT_PATH = Path(__file__).resolve().parents[2] / "data" / "eur_estr_forwards.csv"

# Tenors present in the swap CSV
SWAP_TENORS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30]

# Max maturity needed: 30y20y = 50y
MAX_TENOR = 50

FORWARDS = [
    # (start_y, tenor_y, label)
    # --- 1y tenor ---
    (1,  1, "1y1y"),
    (2,  1, "2y1y"),
    (3,  1, "3y1y"),
    (4,  1, "4y1y"),
    (5,  1, "5y1y"),
    (6,  1, "6y1y"),
    (7,  1, "7y1y"),
    (8,  1, "8y1y"),
    (9,  1, "9y1y"),
    # --- 2y tenor ---
    (1,  2, "1y2y"),
    (2,  2, "2y2y"),
    (3,  2, "3y2y"),
    (4,  2, "4y2y"),
    (5,  2, "5y2y"),
    (6,  2, "6y2y"),
    (7,  2, "7y2y"),
    (8,  2, "8y2y"),
    (10, 2, "10y2y"),
    # --- 3y tenor ---
    (12, 3,  "12y3y"),
    # --- 5y tenor ---
    (1,  5, "1y5y"),
    (2,  5, "2y5y"),
    (3,  5, "3y5y"),
    (5,  5, "5y5y"),
    (7,  5, "7y5y"),
    (10, 5, "10y5y"),
    (15, 5, "15y5y"),
    (20, 5, "20y5y"),
    # --- 10y tenor ---
    (1,  10, "1y10y"),
    (2,  10, "2y10y"),
    (3,  10, "3y10y"),
    (5,  10, "5y10y"),
    (10, 10, "10y10y"),
    (20, 10, "20y10y"),
    # --- 15y tenor ---
    (2,  15, "2y15y"),
    (5,  15, "5y15y"),
    (10, 15, "10y15y"),
    # --- 20y tenor ---
    (1,  20, "1y20y"),
    (2,  20, "2y20y"),
    (5,  20, "5y20y"),
    (10, 20, "10y20y"),
    # --- 25y / 30y tenor ---
    (2,  25, "2y25y"),
    (5,  25, "5y25y"),
    (2,  30, "2y30y"),
    (5,  30, "5y30y"),
    (1,  30, "1y30y"),
    # --- Ultra-long ---
    (30, 20, "30y20y"),
]

LABELS = [f[2] for f in FORWARDS]

# ---------------------------------------------------------------------------
# Core functions
# ---------------------------------------------------------------------------

def interpolate_par_rates(swap_row: np.ndarray) -> np.ndarray:
    """
    Interpolate par rates from SWAP_TENORS grid to every integer 1..MAX_TENOR.
    Cubic spline on the grid; flat extrapolation beyond 30y using the 30y rate.
    Returns array of length MAX_TENOR (index 0 = tenor 1y).
    """
    cs = CubicSpline(SWAP_TENORS, swap_row, bc_type="not-a-knot")
    tenors_full = np.arange(1, MAX_TENOR + 1, dtype=float)
    rates = cs(tenors_full)
    # Flat extrapolation beyond 30y (replace any cubic overshoot)
    rates[30:] = swap_row[-1]
    return rates  # in % units


def bootstrap(par_rates_pct: np.ndarray) -> np.ndarray:
    """
    Annual-pay OIS bootstrap.
    par_rates_pct: array of par rates in %, index 0 = 1y, length MAX_TENOR.
    Returns discount factors D[1..MAX_TENOR], same indexing.
    """
    D = np.zeros(MAX_TENOR + 1)   # D[0] = D(0) = 1 (unused placeholder)
    D[0] = 1.0
    annuity = 0.0
    for n in range(1, MAX_TENOR + 1):
        r = par_rates_pct[n - 1] / 100.0
        D[n] = (1.0 - r * annuity) / (1.0 + r)
        annuity += D[n]
    return D


def forward_par_rate(s: int, t: int, D: np.ndarray) -> float:
    """
    Forward par swap rate (%) for swap starting in s years, tenor t years.
    f(s,t) = (D(s) – D(s+t)) / Σ D(s+k), k=1..t
    """
    numerator   = D[s] - D[s + t]
    denominator = sum(D[s + k] for k in range(1, t + 1))
    return (numerator / denominator) * 100.0


def process_row(swap_row: np.ndarray) -> np.ndarray:
    """Return all forward rates for one date's swap curve."""
    par_full = interpolate_par_rates(swap_row)
    D        = bootstrap(par_full)
    return np.array([forward_par_rate(s, t, D) for s, t, _ in FORWARDS])


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    swaps = pd.read_csv(INPUT_PATH, index_col="date", parse_dates=True)
    print(f"Loaded {len(swaps)} dates from {INPUT_PATH}")

    results = np.apply_along_axis(process_row, axis=1, arr=swaps.values)

    df = pd.DataFrame(results, index=swaps.index, columns=LABELS).round(4)
    df.index.name = "date"

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(OUTPUT_PATH)
    print(f"Wrote {len(df)} rows × {len(LABELS)} forwards → {OUTPUT_PATH}\n")

    print("End of sample (latest date):")
    print(df.tail(1).T.to_string(header=False))

    # Sanity checks
    last = df.iloc[-1]
    print(f"\nSanity checks on latest date:")
    print(f"  5y5y  = {last['5y5y']:.4f}%   (expect > 5y par ≈ {swaps.iloc[-1]['5y']:.4f}%)")
    print(f"  1y1y  = {last['1y1y']:.4f}%   (expect close to 2y par ≈ {swaps.iloc[-1]['2y']:.4f}%)")
    print(f"  10y10y = {last['10y10y']:.4f}%  (expect close to 20y par ≈ {swaps.iloc[-1]['20y']:.4f}%)")


if __name__ == "__main__":
    main()
