#!/usr/bin/env python3
"""
Simulate 1 year of daily EUR ESTR OTR par swap rates using a 3-factor Nelson-Siegel model.

The three factors drive:
  β1 — level  (parallel shifts, anchors the long end)
  β2 — slope  (2s30s steepness; negative = normal upward-sloping curve)
  β3 — curvature (belly richness/cheapness)

Each factor follows a mean-reverting Ornstein-Uhlenbeck process so the curve
stays economically plausible over the simulation window.

Output: data/eur_estr_swaps.csv
Usage:  python backend/scripts/simulate_swaps.py
"""

import numpy as np
import pandas as pd
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

TENORS_Y = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30]
SEED = 42
OUTPUT_PATH = Path(__file__).resolve().parents[2] / "data" / "eur_estr_swaps.csv"

# Nelson-Siegel decay parameter (0.5 is standard; maximises loading at ~2y)
NS_LAMBDA = 0.5

# ---------------------------------------------------------------------------
# Approximate EUR ESTR curve levels (in %)
# 1y ago (Jun-2025): ECB cutting cycle underway, short end ~2.2%, curve mildly steep
# Today (Jun-2026): ECB cuts completed, curve gently upward-sloping
# ---------------------------------------------------------------------------
BETA_START = np.array([2.55, -0.25,  0.30])   # [level, slope, curvature] Jun-2025
BETA_END   = np.array([2.40, -0.55,  0.10])   # Jun-2026

# Mean-reversion speed (higher → reverts faster to long-run mean)
KAPPA = np.array([0.015, 0.020, 0.030])

# Daily volatility of each factor (in %)
#   level:     ~4 bps/day  (annualised ~63 bps)
#   slope:     ~3 bps/day
#   curvature: ~2 bps/day
SIGMA = np.array([0.040, 0.030, 0.020])

# Factor correlation matrix
CORR = np.array([
    [1.00,  0.40,  0.10],
    [0.40,  1.00,  0.30],
    [0.10,  0.30,  1.00],
])

# ---------------------------------------------------------------------------
# Nelson-Siegel rate function
# ---------------------------------------------------------------------------

def ns_rate(tau: np.ndarray, b1: float, b2: float, b3: float) -> np.ndarray:
    """Par swap rate (%) for tenor array tau (years)."""
    x = NS_LAMBDA * tau
    loading2 = (1.0 - np.exp(-x)) / x
    loading3 = loading2 - np.exp(-x)
    return b1 + b2 * loading2 + b3 * loading3


# ---------------------------------------------------------------------------
# Simulation
# ---------------------------------------------------------------------------

def simulate() -> pd.DataFrame:
    np.random.seed(SEED)

    dates = pd.bdate_range(start="2025-06-17", end="2026-06-17")
    n = len(dates)

    # Cholesky factor for correlated shocks
    L = np.linalg.cholesky(CORR)

    # Long-run mean drifts linearly from BETA_START to BETA_END
    theta = np.linspace(BETA_START, BETA_END, n)   # shape (n, 3)

    # Simulate OU paths
    betas = np.zeros((n, 3))
    betas[0] = BETA_START

    for t in range(1, n):
        z = np.random.standard_normal(3)
        shock = L @ z * SIGMA
        mean_reversion = KAPPA * (theta[t] - betas[t - 1])
        betas[t] = betas[t - 1] + mean_reversion + shock

    # Build rate matrix  (n_dates × n_tenors)
    tau = np.array(TENORS_Y, dtype=float)
    rates = ns_rate(tau[np.newaxis, :], betas[:, 0:1], betas[:, 1:2], betas[:, 2:3])

    cols = [f"{t}y" for t in TENORS_Y]
    df = pd.DataFrame(rates, index=dates, columns=cols).round(4)
    df.index.name = "date"

    return df


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    df = simulate()

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(OUTPUT_PATH)

    print(f"Wrote {len(df)} business days × {len(TENORS_Y)} tenors → {OUTPUT_PATH}\n")

    print("Start of sample (2025-06-17):")
    print(df.head(1).T.to_string(header=False), "\n")

    print("End of sample (2026-06-17):")
    print(df.tail(1).T.to_string(header=False), "\n")

    # Quick sanity: curve should be upward-sloping at the end
    last = df.iloc[-1]
    slope_2s10s = (last["10y"] - last["2y"]) * 100
    slope_5s30s = (last["30y"] - last["5y"]) * 100
    print(f"Final curve shape:  2s10s = {slope_2s10s:+.1f} bps  |  5s30s = {slope_5s30s:+.1f} bps")


if __name__ == "__main__":
    main()
