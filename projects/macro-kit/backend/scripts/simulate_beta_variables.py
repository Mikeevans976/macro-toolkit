#!/usr/bin/env python3
"""
Simulate 1 year of daily beta variables for EUR ESTR swap RV analysis.

Variables
---------
  1y10y_fwd   : 1y-into-10y forward swap rate           (%)
  2y1y_fwd    : 2y-into-1y forward swap rate            (%)
  1m10y_vol   : 1m-expiry 10y-tenor ATM swaption vol    (bps, normal)
  1y10y_vol   : 1y-expiry 10y-tenor ATM swaption vol    (bps, normal)

Dynamics
--------
Each variable follows an Ornstein-Uhlenbeck process with a slowly drifting
long-run mean (from start to end levels). The 4×4 correlation matrix captures:
  - High co-movement between the two forwards (~0.75)
  - High co-movement between the two vol surfaces (~0.80)
  - Modest negative rate–vol correlation (~-0.35): vol rises as rates fall

Output: data/eur_beta_variables.csv
Usage:  python backend/scripts/simulate_beta_variables.py
"""

import numpy as np
import pandas as pd
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SEED = 43   # different seed from simulate_swaps.py
OUTPUT_PATH = Path(__file__).resolve().parents[2] / "data" / "eur_beta_variables.csv"

VARIABLES = ["1y10y_fwd", "2y1y_fwd", "1m10y_vol", "1y10y_vol"]

# ---------------------------------------------------------------------------
# Approximate EUR ESTR levels
#
# Forwards (%)
#   1y10y fwd  ≈ (11·R11 − 1·R1) / 10  → sits ~25–35 bps above the 10y rate
#   2y1y  fwd  ≈  3·R3 − 2·R2          → sits between 2y and 3y, slightly steeper
#
# Swaption normal vols (bps)
#   EUR ATM vol surface (Jun-2025 → Jun-2026, post-ECB cuts, falling vol regime)
#   1m10y: shorter expiry → more responsive to near-term event risk, higher realised vol
#   1y10y: longer expiry → smoother, lower
# ---------------------------------------------------------------------------

#                  1y10y_fwd  2y1y_fwd  1m10y_vol  1y10y_vol
START = np.array([  2.68,      2.52,     72.0,       82.0  ])
END   = np.array([  2.58,      2.38,     62.0,       74.0  ])

# Mean-reversion speed (higher → faster reversion)
KAPPA = np.array([0.015, 0.018, 0.040, 0.025])

# Daily volatility
#   forwards:  ~4 bps/day
#   1m10y vol: ~3 bps/day  (shorter expiry → jumpier)
#   1y10y vol: ~2 bps/day
SIGMA = np.array([0.040, 0.040, 3.0, 2.0])

# Correlation matrix
#   Order: [1y10y_fwd, 2y1y_fwd, 1m10y_vol, 1y10y_vol]
#
#   fwd–fwd:  high positive (driven by the same underlying curve)
#   vol–vol:  high positive (driven by the same implied vol surface)
#   fwd–vol:  negative (vol tends to rise when rates fall, risk-off)
CORR = np.array([
    # 1y10y_fwd  2y1y_fwd  1m10y_vol  1y10y_vol
    [  1.00,      0.75,     -0.35,     -0.30  ],   # 1y10y_fwd
    [  0.75,      1.00,     -0.30,     -0.25  ],   # 2y1y_fwd
    [ -0.35,     -0.30,      1.00,      0.80  ],   # 1m10y_vol
    [ -0.30,     -0.25,      0.80,      1.00  ],   # 1y10y_vol
])

# ---------------------------------------------------------------------------
# Simulation
# ---------------------------------------------------------------------------

def simulate() -> pd.DataFrame:
    np.random.seed(SEED)

    dates = pd.bdate_range(start="2025-06-17", end="2026-06-17")
    n = len(dates)

    # Cholesky factor for correlated shocks
    L = np.linalg.cholesky(CORR)

    # Long-run mean drifts linearly from START → END
    theta = np.linspace(START, END, n)   # (n, 4)

    paths = np.zeros((n, 4))
    paths[0] = START

    for t in range(1, n):
        z = np.random.standard_normal(4)
        shock = L @ z * SIGMA
        mean_reversion = KAPPA * (theta[t] - paths[t - 1])
        paths[t] = paths[t - 1] + mean_reversion + shock

    df = pd.DataFrame(paths, index=dates, columns=VARIABLES)
    df.index.name = "date"

    # Round sensibly: rates to 4dp, vols to 2dp
    df[["1y10y_fwd", "2y1y_fwd"]] = df[["1y10y_fwd", "2y1y_fwd"]].round(4)
    df[["1m10y_vol", "1y10y_vol"]] = df[["1m10y_vol", "1y10y_vol"]].round(2)

    return df


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    df = simulate()

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(OUTPUT_PATH)

    print(f"Wrote {len(df)} business days × {len(VARIABLES)} variables → {OUTPUT_PATH}\n")

    print("Start of sample (2025-06-17):")
    print(df.head(1).T.to_string(header=False), "\n")

    print("End of sample (2026-06-17):")
    print(df.tail(1).T.to_string(header=False), "\n")

    # Sanity: correlation between 1y10y_fwd and 1m10y_vol should be negative
    corr = df["1y10y_fwd"].corr(df["1m10y_vol"])
    print(f"Realised corr(1y10y_fwd, 1m10y_vol) = {corr:+.3f}  (expected ~-0.35)")


if __name__ == "__main__":
    main()
