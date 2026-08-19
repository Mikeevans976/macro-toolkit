"""
HICP monthly fixings — Euro Area.

Fetches the first 24 HICP-XT monthly fixing levels from Bloomberg:
  EUSWIF{n} Comdty  where n = calendar month number (1=Jan … 12=Dec)
  EUSWIT{n} Comdty  same, for the second annual cycle

Contract convention
-------------------
The ticker number is the *calendar month*, not a sequential position.
The F series covers the 12-month cycle starting from the same calendar
month one year ahead of today; T covers the following 12-month cycle.

Example (today = Aug 2025):
  Nearest fixing  → EUSWIF8  = Aug 2026
  Next            → EUSWIF9  = Sep 2026
  ...             → EUSWIF12 = Dec 2026
  ...             → EUSWIF1  = Jan 2027
  ...             → EUSWIF7  = Jul 2027   (12th)
  13th            → EUSWIT8  = Aug 2027
  ...             → EUSWIT7  = Jul 2028   (24th)

Bloomberg fetch uses BDP (snapshot of current prices, field PX_LAST).
Falls back to deterministic simulation when Bloomberg is unavailable.
"""

from __future__ import annotations

import os
from datetime import date
from typing import Optional

import pandas as pd

# ─── All 24 tickers (Bloomberg order, not time order) ────────────────────────

_TICKERS_F = [f"EUSWIF{n} Comdty" for n in range(1, 13)]
_TICKERS_T = [f"EUSWIT{n} Comdty" for n in range(1, 13)]

# ─── Bloomberg fetch ──────────────────────────────────────────────────────────

def _bloomberg_fixings() -> Optional[dict[str, float]]:
    """
    Fetch all 24 fixing prices via BDP snapshot.
    Returns dict {ticker: level} or None on any failure.
    """
    try:
        from bbg import blp
        all_tickers = _TICKERS_F + _TICKERS_T
        df = blp.bdp(all_tickers, "PX_LAST")
        if df.empty:
            return None
        return {t: float(df.loc[t, "PX_LAST"]) for t in all_tickers if t in df.index}
    except Exception:
        return None

# ─── Simulation fallback ──────────────────────────────────────────────────────

# HICP seasonal MoM pattern (% deviation from trend, Jan=index 0 … Dec=index 11).
# Normalised to sum to zero over 12 months.
_SEASONAL_MOM_PCT = [
    -0.55, -0.20, +0.55, +0.40, +0.10, +0.05,
    -0.30, -0.20, +0.15, -0.05, +0.00, +0.05,
]

def _sim_fixings(first_month: pd.Timestamp, last_known: float) -> list[float]:
    annual_growth  = 0.020
    monthly_trend  = (1.0 + annual_growth) ** (1.0 / 12) - 1.0
    level = last_known
    levels: list[float] = []
    for i in range(24):
        cal      = first_month + pd.DateOffset(months=i)
        seasonal = _SEASONAL_MOM_PCT[cal.month - 1] / 100.0
        level   *= (1.0 + monthly_trend + seasonal)
        levels.append(round(level, 2))
    return levels

# ─── Ticker lookup ────────────────────────────────────────────────────────────

def _ticker(cal: pd.Timestamp, is_t_series: bool) -> str:
    """Return the BBG ticker for a given calendar month, F or T series."""
    prefix = "EUSWIT" if is_t_series else "EUSWIF"
    return f"{prefix}{cal.month} Comdty"

# ─── Public entry point ───────────────────────────────────────────────────────

def get_hicp_fixings(as_of_date: Optional[str] = None) -> dict:
    """
    Return the 24 HICP monthly fixings ordered by proximity (nearest first).

    The first fixing is always the same calendar month one year ahead of today
    (e.g. today = Aug 2025 → first fixing = Aug 2026 = EUSWIF8).

    Response shape
    --------------
    {
        "data_source"     : "bloomberg" | "simulation",
        "as_of_date"      : "YYYY-MM-DD",
        "last_known_hicp" : <float>,
        "fixings" : [
            {
                "month_num"      : 8,               # calendar month (1–12)
                "ticker"         : "EUSWIF8 Comdty",
                "calendar_month" : "2026-08",
                "level"          : 140.21,
                "mom_implied"    : 0.18,
            },
            ...  (24 entries, nearest → furthest)
        ]
    }
    """
    today        = as_of_date or date.today().isoformat()
    ref          = pd.Timestamp(today)
    # First fixing: same calendar month, next year
    first_month  = pd.Timestamp(ref.year + 1, ref.month, 1)
    last_known   = 137.5   # approximate latest known HICP Headline (Jun 2025, 2015=100)

    source      = os.environ.get("ANALYTICS_DATA_SOURCE", "csv").lower()
    bbg_prices  = _bloomberg_fixings() if source == "bloomberg" else None
    data_source = "bloomberg" if bbg_prices else "simulation"

    fixings: list[dict] = []
    prev_level = last_known

    # Simulate forward curve (used as fallback or for any missing tickers)
    sim_levels = _sim_fixings(first_month, last_known)

    for i in range(24):
        cal       = first_month + pd.DateOffset(months=i)
        is_t      = (i >= 12)
        ticker    = _ticker(cal, is_t)

        level     = (bbg_prices.get(ticker) if bbg_prices else None) or sim_levels[i]
        mom       = round((level / prev_level - 1.0) * 100.0, 3)
        prev_level = level

        fixings.append({
            "month_num":      cal.month,
            "ticker":         ticker,
            "calendar_month": cal.strftime("%Y-%m"),
            "level":          level,
            "mom_implied":    mom,
        })

    return {
        "data_source":     data_source,
        "as_of_date":      today,
        "last_known_hicp": last_known,
        "fixings":         fixings,
    }
