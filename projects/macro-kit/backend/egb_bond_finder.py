"""
egb_bond_finder.py

For each EGB country and target tenor, queries Bloomberg for all outstanding
government bonds and selects the one whose remaining maturity is closest to
the target.

Results are cached per (country, date) so Bloomberg is only hit once per day
per country.

Usage:
    from egb_bond_finder import build_egb_bond_map
    bond_map = build_egb_bond_map(COUNTRY_TENORS, as_of_date="2025-06-30")
    # bond_map["Bund"][10] == {
    #   "ticker": "DBR 0 08/15/2034 Govt",
    #   "target_years": 10,
    #   "actual_years": 9.87,
    #   "deviation_years": 0.13,
    #   "maturity": "2034-08-15",
    #   "coupon": 0.0,
    #   "yield_pct": 2.42,
    #   "duration": 9.1,
    #   "outstanding_mn": 18000.0,
    # }
"""

from __future__ import annotations

import warnings
from datetime import date

import pandas as pd

# ─── Bloomberg search expressions ────────────────────────────────────────────
# bsrch expression to find all outstanding government bonds per country.
# Syntax: "FI:{PREFIX}" where PREFIX is the Bloomberg issuer ticker.
# Verify in Terminal: type the prefix + <Govt> <GO>, e.g. "DBR <Govt> <GO>".

COUNTRY_BSRCH: dict[str, str] = {
    "Bund":        "FI:DBR",
    "OAT":         "FI:FRTR",
    "BTP":         "FI:BTPS",
    "Bonos":       "FI:SPGB",
    "Belgium":     "FI:BGB",
    "Portugal":    "FI:PGB",
    "Netherlands": "FI:NETHER",
    "Austria":     "FI:RAGB",
    "Finland":     "FI:RFGB",
}

# Reference data fields fetched per bond
_BOND_FIELDS = [
    "MATURITY",         # maturity date
    "COUPON",           # coupon rate (%)
    "AMT_OUTSTANDING",  # notional outstanding (millions, local CCY)
    "CALLABLE",         # "Y" or "N"
    "YLD_YTM_MID",      # yield to maturity, mid (%)
    "DUR_ADJ_MID",      # modified duration, mid
]

# Module-level cache: {(country, date_str) -> DataFrame}
_UNIVERSE_CACHE: dict[tuple[str, str], pd.DataFrame] = {}


def _fetch_universe(country: str, min_outstanding_mn: float = 5_000.0) -> pd.DataFrame:
    """
    Query Bloomberg for all outstanding bullet government bonds for `country`.

    Returns a DataFrame indexed by Bloomberg ticker string with columns:
        MATURITY (Timestamp), COUPON, AMT_OUTSTANDING, YLD_YTM_MID,
        DUR_ADJ_MID, ytm_years (float).

    Filters:
        - Bullet bonds only (CALLABLE != "Y")
        - > 6 months remaining maturity
        - Amount outstanding >= min_outstanding_mn (default 5 000 mn = €5 bn)

    Returns empty DataFrame on any Bloomberg failure.
    """
    try:
        from bbg import blp
    except ImportError:
        warnings.warn("[egb_bond_finder] bbg not available")
        return pd.DataFrame()

    search_expr = COUNTRY_BSRCH.get(country)
    if search_expr is None:
        warnings.warn(f"[egb_bond_finder] No search expression for {country!r}")
        return pd.DataFrame()

    try:
        tickers = blp.bsrch(search_expr)
    except Exception as exc:
        warnings.warn(f"[egb_bond_finder] bsrch failed for {country}: {exc}")
        return pd.DataFrame()

    if not tickers:
        warnings.warn(f"[egb_bond_finder] bsrch returned no tickers for {country} ({search_expr!r})")
        return pd.DataFrame()

    try:
        ref = blp.bdp(tickers, _BOND_FIELDS)
    except Exception as exc:
        warnings.warn(f"[egb_bond_finder] bdp failed for {country}: {exc}")
        return pd.DataFrame()

    if ref is None or ref.empty:
        warnings.warn(f"[egb_bond_finder] bdp returned no data for {country}")
        return pd.DataFrame()

    today = pd.Timestamp.today().normalize()
    ref["MATURITY"] = pd.to_datetime(ref["MATURITY"], errors="coerce")
    ref["ytm_years"] = (ref["MATURITY"] - today).dt.days / 365.25

    mask = (
        (ref["CALLABLE"].astype(str).str.upper() != "Y")
        & (ref["ytm_years"] > 0.5)
        & (ref["AMT_OUTSTANDING"] >= min_outstanding_mn)
    )
    universe = ref.loc[mask].copy().sort_values("ytm_years")

    if universe.empty:
        warnings.warn(f"[egb_bond_finder] No bonds pass filters for {country}")

    return universe


def _get_universe(country: str, as_of: str, min_outstanding_mn: float = 5_000.0) -> pd.DataFrame:
    """Fetch and cache the bond universe for (country, date)."""
    key = (country, as_of)
    if key not in _UNIVERSE_CACHE:
        _UNIVERSE_CACHE[key] = _fetch_universe(country, min_outstanding_mn)
    return _UNIVERSE_CACHE[key]


def find_closest(universe: pd.DataFrame, target_years: float) -> dict | None:
    """
    Return the bond in `universe` (output of _fetch_universe) whose remaining
    maturity is closest to `target_years`.

    Returns a metadata dict, or None if the universe is empty.
    """
    if universe.empty:
        return None

    idx = (universe["ytm_years"] - target_years).abs().idxmin()
    row = universe.loc[idx]

    return {
        "ticker":          str(idx),
        "target_years":    target_years,
        "actual_years":    round(float(row["ytm_years"]), 3),
        "deviation_years": round(abs(float(row["ytm_years"]) - target_years), 3),
        "maturity":        row["MATURITY"].strftime("%Y-%m-%d"),
        "coupon":          float(row["COUPON"]),
        "yield_pct":       round(float(row["YLD_YTM_MID"]), 4),
        "duration":        round(float(row["DUR_ADJ_MID"]), 2),
        "outstanding_mn":  float(row["AMT_OUTSTANDING"]),
    }


def build_egb_bond_map(
    country_tenors: dict[str, list[int]],
    as_of_date: str | None = None,
    min_outstanding_mn: float = 5_000.0,
    max_deviation_years: float = 1.5,
) -> dict[str, dict[int, dict | None]]:
    """
    For every country and target tenor, find the individual bond whose remaining
    maturity is closest to the target.

    Args:
        country_tenors:      {country: [tenor_years, ...]} — same structure as
                             COUNTRY_TENORS in egb_expressions_config.py.
        as_of_date:          Date string YYYY-MM-DD (used as cache key; defaults
                             to today).
        min_outstanding_mn:  Minimum notional outstanding in millions to include
                             a bond in the universe (default 5 000 mn = €5 bn).
        max_deviation_years: Maximum allowed deviation from target tenor. If the
                             closest bond is further away than this, the entry is
                             None and the caller should fall back to the generic
                             ticker. Default 1.5y.

    Returns:
        {
          "Bund": {
            2:  {"ticker": "DBR 0 09/10/2026 Govt", "actual_years": 1.99, ...},
            10: {"ticker": "DBR 0 08/15/2034 Govt", "actual_years": 9.87, ...},
            ...
          },
          "OAT":  { ... },
          ...
        }

    Entries are None where no bond is found within max_deviation_years.
    """
    today_str = as_of_date or date.today().isoformat()
    result: dict[str, dict[int, dict | None]] = {}

    for country, tenors in country_tenors.items():
        universe = _get_universe(country, today_str, min_outstanding_mn)
        result[country] = {}
        for target in tenors:
            match = find_closest(universe, float(target))
            if match is None or match["deviation_years"] > max_deviation_years:
                warnings.warn(
                    f"[egb_bond_finder] No bond within {max_deviation_years}y "
                    f"of {target}y for {country} — tenor excluded"
                )
                result[country][target] = None
            else:
                result[country][target] = match

    return result
