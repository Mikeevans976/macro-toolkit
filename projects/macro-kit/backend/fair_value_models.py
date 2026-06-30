"""
HICPxT Inflation Swap Fair Value Models.
Rolling Elastic Net on 14 EUR inflation swap instruments.

Live data path: set ANALYTICS_DATA_SOURCE=bloomberg.
Simulation fallback: synthetic data seeded for reproducibility.
"""
from __future__ import annotations

import os
import warnings

import numpy as np
import pandas as pd
from scipy.interpolate import CubicSpline
from sklearn.linear_model import ElasticNet
from sklearn.preprocessing import StandardScaler

# ─── Configuration ────────────────────────────────────────────────────────────

DATES: pd.DatetimeIndex = pd.bdate_range("2004-01-02", "2024-12-31")
T: int = len(DATES)
_RNG = np.random.default_rng(20240101)

ROLL_WINDOW: int = 500   # ~2 calendar years
MIN_WINDOW:  int = 252   # minimum obs before first fit
FIT_STEP:    int = 1     # refit every N days
OUTPUT_STEP: int = 1     # output every N days

_GROUPS = [
    {"id": "outright", "label": "Outright HICPxT",
     "model_ids": ["hicp_1y", "hicp_2y", "hicp_5y", "hicp_10y", "hicp_15y", "hicp_20y", "hicp_30y"]},
    {"id": "forward",  "label": "Forward Swaps",
     "model_ids": ["hicp_1y1y", "hicp_2y1y", "hicp_2y2y", "hicp_2y3y", "hicp_5y5y", "hicp_10y10y", "hicp_20y10y"]},
]

_MODEL_DEFS: list[dict] = [
    # Group 1: Outright
    # 1Y/2Y: include EURIBOR 3M (policy anchor dominates at short end) + full macro set
    {"id": "hicp_1y",    "title": "EUR 1Y HICPxT",    "group": "outright",
     "x_names": ["1Y Swap",  "log(Brent)", "log(Gas)", "EURIBOR 3M", "log(BCOM)", "EUR TWI", "GS FCI", "iTraxx 5Y", "Citi ESI", "3M10Y Slope"],
     "x_keys":  ["EESWE1",   "log_Brent",  "log_Gas",  "EUR003M",    "log_BCOM",  "EUR_TWI", "GSEAFCI", "ITRX5Y",   "CESIEUR",  "slope_3m10y"],
     "y_key":   "EUSWI1"},
    {"id": "hicp_2y",    "title": "EUR 2Y HICPxT",    "group": "outright",
     "x_names": ["2Y Swap",  "log(Brent)", "log(Gas)", "EURIBOR 3M", "log(BCOM)", "EUR TWI", "GS FCI", "iTraxx 5Y", "Citi ESI", "3M10Y Slope"],
     "x_keys":  ["EESWE2",   "log_Brent",  "log_Gas",  "EUR003M",    "log_BCOM",  "EUR_TWI", "GSEAFCI", "ITRX5Y",   "CESIEUR",  "slope_3m10y"],
     "y_key":   "EUSWI2"},
    # 5Y–30Y: no EURIBOR 3M (too far from policy anchor); full macro + slope
    {"id": "hicp_5y",    "title": "EUR 5Y HICPxT",    "group": "outright",
     "x_names": ["5Y Swap",  "log(Brent)", "log(Gas)", "log(BCOM)", "EUR TWI", "GS FCI", "iTraxx 5Y", "Citi ESI", "3M10Y Slope"],
     "x_keys":  ["EESWE5",   "log_Brent",  "log_Gas",  "log_BCOM",  "EUR_TWI", "GSEAFCI", "ITRX5Y",   "CESIEUR",  "slope_3m10y"],
     "y_key":   "EUSWI5"},
    {"id": "hicp_10y",   "title": "EUR 10Y HICPxT",   "group": "outright",
     "x_names": ["10Y Swap", "log(Brent)", "log(Gas)", "log(BCOM)", "EUR TWI", "GS FCI", "iTraxx 5Y", "Citi ESI", "3M10Y Slope"],
     "x_keys":  ["EESWE10",  "log_Brent",  "log_Gas",  "log_BCOM",  "EUR_TWI", "GSEAFCI", "ITRX5Y",   "CESIEUR",  "slope_3m10y"],
     "y_key":   "EUSWI10"},
    {"id": "hicp_15y",   "title": "EUR 15Y HICPxT",   "group": "outright",
     "x_names": ["15Y Swap", "log(Brent)", "log(Gas)", "log(BCOM)", "EUR TWI", "GS FCI", "iTraxx 5Y", "Citi ESI", "3M10Y Slope"],
     "x_keys":  ["EESWE15",  "log_Brent",  "log_Gas",  "log_BCOM",  "EUR_TWI", "GSEAFCI", "ITRX5Y",   "CESIEUR",  "slope_3m10y"],
     "y_key":   "EUSWI15"},
    {"id": "hicp_20y",   "title": "EUR 20Y HICPxT",   "group": "outright",
     "x_names": ["20Y Swap", "log(Brent)", "log(Gas)", "log(BCOM)", "EUR TWI", "GS FCI", "iTraxx 5Y", "Citi ESI", "3M10Y Slope"],
     "x_keys":  ["EESWE20",  "log_Brent",  "log_Gas",  "log_BCOM",  "EUR_TWI", "GSEAFCI", "ITRX5Y",   "CESIEUR",  "slope_3m10y"],
     "y_key":   "EUSWI20"},
    {"id": "hicp_30y",   "title": "EUR 30Y HICPxT",   "group": "outright",
     "x_names": ["30Y Swap", "log(Brent)", "log(Gas)", "log(BCOM)", "EUR TWI", "GS FCI", "iTraxx 5Y", "Citi ESI", "3M10Y Slope"],
     "x_keys":  ["EESWE30",  "log_Brent",  "log_Gas",  "log_BCOM",  "EUR_TWI", "GSEAFCI", "ITRX5Y",   "CESIEUR",  "slope_3m10y"],
     "y_key":   "EUSWI30"},
    # Group 2: Forward Swaps
    # Short forwards: include EURIBOR 3M alongside full macro set
    {"id": "hicp_1y1y",   "title": "EUR 1Y1Y HICPxT",   "group": "forward",
     "x_names": ["1Y1Y ESTR", "log(Brent)", "log(Gas)", "EURIBOR 3M", "log(BCOM)", "EUR TWI", "GS FCI", "iTraxx 5Y", "Citi ESI", "3M10Y Slope"],
     "x_keys":  ["ESTR_1Y1Y", "log_Brent",  "log_Gas",  "EUR003M",    "log_BCOM",  "EUR_TWI", "GSEAFCI", "ITRX5Y",   "CESIEUR",  "slope_3m10y"],
     "y_key":   "HICP_1Y1Y"},
    {"id": "hicp_2y1y",   "title": "EUR 2Y1Y HICPxT",   "group": "forward",
     "x_names": ["2Y1Y ESTR", "log(Brent)", "log(Gas)", "EURIBOR 3M", "log(BCOM)", "EUR TWI", "GS FCI", "iTraxx 5Y", "Citi ESI", "3M10Y Slope"],
     "x_keys":  ["ESTR_2Y1Y", "log_Brent",  "log_Gas",  "EUR003M",    "log_BCOM",  "EUR_TWI", "GSEAFCI", "ITRX5Y",   "CESIEUR",  "slope_3m10y"],
     "y_key":   "HICP_2Y1Y"},
    {"id": "hicp_2y2y",   "title": "EUR 2Y2Y HICPxT",   "group": "forward",
     "x_names": ["2Y2Y ESTR", "log(Brent)", "log(Gas)", "EURIBOR 3M", "log(BCOM)", "EUR TWI", "GS FCI", "iTraxx 5Y", "Citi ESI", "3M10Y Slope"],
     "x_keys":  ["ESTR_2Y2Y", "log_Brent",  "log_Gas",  "EUR003M",    "log_BCOM",  "EUR_TWI", "GSEAFCI", "ITRX5Y",   "CESIEUR",  "slope_3m10y"],
     "y_key":   "HICP_2Y2Y"},
    # Medium forwards: no EURIBOR 3M, full macro + slope + Citi ESI
    {"id": "hicp_2y3y",   "title": "EUR 2Y3Y HICPxT",   "group": "forward",
     "x_names": ["2Y3Y ESTR", "log(Brent)", "log(Gas)", "log(BCOM)", "EUR TWI", "GS FCI", "iTraxx 5Y", "Citi ESI", "3M10Y Slope"],
     "x_keys":  ["ESTR_2Y3Y", "log_Brent",  "log_Gas",  "log_BCOM",  "EUR_TWI", "GSEAFCI", "ITRX5Y",   "CESIEUR",  "slope_3m10y"],
     "y_key":   "HICP_2Y3Y"},
    {"id": "hicp_5y5y",   "title": "EUR 5Y5Y HICPxT",   "group": "forward",
     "x_names": ["5Y5Y ESTR", "log(Brent)", "log(Gas)", "log(BCOM)", "EUR TWI", "GS FCI", "iTraxx 5Y", "Citi ESI", "3M10Y Slope"],
     "x_keys":  ["ESTR_5Y5Y", "log_Brent",  "log_Gas",  "log_BCOM",  "EUR_TWI", "GSEAFCI", "ITRX5Y",   "CESIEUR",  "slope_3m10y"],
     "y_key":   "HICP_5Y5Y"},
    # Ultra-long forwards: swaption vol retained; Citi ESI dropped (macro newsflow less relevant)
    {"id": "hicp_10y10y", "title": "EUR 10Y10Y HICPxT", "group": "forward",
     "x_names": ["10Y10Y ESTR", "log(Brent)", "log(Gas)", "1M Swaption Vol", "log(BCOM)", "EUR TWI", "GS FCI", "iTraxx 5Y", "3M10Y Slope"],
     "x_keys":  ["ESTR_10Y10Y", "log_Brent",  "log_Gas",  "SMOVEU1M",        "log_BCOM",  "EUR_TWI", "GSEAFCI", "ITRX5Y",   "slope_3m10y"],
     "y_key":   "HICP_10Y10Y"},
    {"id": "hicp_20y10y", "title": "EUR 20Y10Y HICPxT", "group": "forward",
     "x_names": ["20Y10Y ESTR", "log(Brent)", "log(Gas)", "1M Swaption Vol", "log(BCOM)", "EUR TWI", "GS FCI", "iTraxx 5Y", "3M10Y Slope"],
     "x_keys":  ["ESTR_20Y10Y", "log_Brent",  "log_Gas",  "SMOVEU1M",        "log_BCOM",  "EUR_TWI", "GSEAFCI", "ITRX5Y",   "slope_3m10y"],
     "y_key":   "HICP_20Y10Y"},
]

# ─── Bloomberg Ticker Map ─────────────────────────────────────────────────────

# Raw series fetched from BBG via PX_LAST.
# Rates (EUSWI*, EESWE*, EUR003M) → divided by 100 to get decimals.
# Commodity/index series → kept at level then log-transformed or used as-is.
_BBG_RAW: dict[str, str] = {
    # HICPxT inflation swap outrights — Y targets (& inputs for forward derivation)
    "EUSWI1":   "EUSWI1 Curncy",
    "EUSWI2":   "EUSWI2 Curncy",
    "EUSWI3":   "EUSWI3 Curncy",    # needed for HICP_2Y1Y
    "EUSWI4":   "EUSWI4 Curncy",    # needed for HICP_2Y2Y
    "EUSWI5":   "EUSWI5 Curncy",
    "EUSWI10":  "EUSWI10 Curncy",
    "EUSWI15":  "EUSWI15 Curncy",
    "EUSWI20":  "EUSWI20 Curncy",
    "EUSWI30":  "EUSWI30 Curncy",
    # ESTR par OIS swap rates — X regressors + forward bootstrap
    "EESWE1":   "EUSWF1 Curncy",
    "EESWE2":   "EUSWF2 Curncy",
    "EESWE3":   "EUSWF3 Curncy",    # needed for ESTR_2Y1Y bootstrap
    "EESWE4":   "EUSWF4 Curncy",    # needed for ESTR_2Y2Y bootstrap
    "EESWE5":   "EUSWF5 Curncy",
    "EESWE10":  "EUSWF10 Curncy",
    "EESWE15":  "EUSWF15 Curncy",
    "EESWE20":  "EUSWF20 Curncy",
    "EESWE30":  "EUSWF30 Curncy",
    # Macro regressors
    "Brent":    "CO1 Comdty",        # Brent crude front-month, USD/bbl → log_Brent
    "Gas":      "TTF1 Comdty",       # TTF nat gas front-month, EUR/MWh → log_Gas
    "BCOM_raw": "BCOM Index",        # Bloomberg Commodity Index → log_BCOM
    "EUR003M":  "EUR003M Index",     # EURIBOR 3M, %
    "EUR_TWI":  "EURR002W Index",    # ECB broad NEER, index level
    "GSEAFCI":  "GSEAFCI Index",     # GS Euro Area FCI (needs GS data subscription)
    "ITRX5Y":   "ITRXEBE5 Index",    # iTraxx Europe 5Y on-the-run, bps
    "CESIEUR":  "CESIEUR Index",     # Citi Economic Surprise EUR
    "SMOVEU1M": "EUSV0001 Index",    # EUR 1M10Y swaption normal vol, bps
}

# Series that are essential — if any are missing, fall back to simulation.
_REQUIRED_BBG = {
    "EUSWI1", "EUSWI2", "EUSWI5", "EUSWI10", "EUSWI20", "EUSWI30",
    "EESWE1", "EESWE2", "EESWE5", "EESWE10", "EESWE20", "EESWE30",
    "Brent", "Gas", "BCOM_raw", "EUR003M",
}

# Optional — filled with zeros if unavailable (model assigns near-zero coefficient)
_OPTIONAL_BBG = {"EUR_TWI", "GSEAFCI", "ITRX5Y", "CESIEUR", "SMOVEU1M"}


# ─── Forward derivation helpers ───────────────────────────────────────────────

def _estr_discount_factors(par_rates: dict[int, float]) -> np.ndarray:
    """
    Bootstrap discount factors D[0..30] from available ESTR par OIS tenors.
    par_rates: {tenor_years: rate_decimal}.  Cubic-spline gap-fill before bootstrap.
    """
    tenors = sorted(par_rates)
    rates_pct = [par_rates[t] * 100.0 for t in tenors]
    cs = CubicSpline(tenors, rates_pct, bc_type="not-a-knot")
    all_pct = cs(np.arange(1, 31, dtype=float))

    D = np.zeros(31)
    D[0] = 1.0
    ann = 0.0
    for n in range(1, 31):
        r = all_pct[n - 1] / 100.0
        D[n] = (1.0 - r * ann) / (1.0 + r)
        ann += D[n]
    return D


def _estr_fwd(D: np.ndarray, s: int, t: int) -> float:
    """Forward par OIS rate (decimal) for swap starting in s years, tenor t years."""
    num = D[s] - D[s + t]
    den = sum(D[s + k] for k in range(1, t + 1))
    return num / den


def _hicp_fwd(r_near: float, r_far: float, s: int, t: int) -> float:
    """
    Zero-coupon HICPxT forward rate (decimal).
    r_near: spot rate to year s; r_far: spot rate to year s+t; both decimal.
    """
    return ((1.0 + r_far) ** (s + t) / (1.0 + r_near) ** s) ** (1.0 / t) - 1.0


# ─── Live data fetch ──────────────────────────────────────────────────────────

def _fetch_live_data(
    start: str, end: str
) -> "tuple[dict[str, np.ndarray], pd.DatetimeIndex] | None":
    """
    Fetch all Fair Value Model inputs from Bloomberg.

    Returns (vars_dict, DatetimeIndex) with the same keys as _simulate(), or None
    on any failure.  Caller should fall back to _simulate() when None is returned.
    """
    try:
        from bbg import blp
    except ImportError:
        return None

    try:
        tickers = list(_BBG_RAW.values())
        id_by_tick = {v: k for k, v in _BBG_RAW.items()}

        raw_df = blp.bdh(tickers, "PX_LAST", start, end)
        if raw_df is None or raw_df.empty:
            warnings.warn("[fair_value_models] BBG returned no data.", stacklevel=1)
            return None

        if isinstance(raw_df.columns, pd.MultiIndex):
            raw_df = raw_df.xs("PX_LAST", axis=1, level=1)

        raw_df = raw_df.rename(columns=id_by_tick)

        # Check required series
        missing = _REQUIRED_BBG - set(raw_df.columns)
        if missing:
            warnings.warn(
                f"[fair_value_models] Missing required BBG series: {missing}; "
                "falling back to simulation.",
                stacklevel=1,
            )
            return None

        # Drop rows where any required series is NaN
        raw_df = raw_df.dropna(subset=list(_REQUIRED_BBG))
        if raw_df.empty:
            return None

        n = len(raw_df)
        dates = pd.DatetimeIndex(raw_df.index)
        out: dict[str, np.ndarray] = {}

        # ── Swap rates → decimal ─────────────────────────────────────────────
        rate_cols = [c for c in raw_df.columns
                     if c.startswith("EUSWI") or c.startswith("EESWE") or c == "EUR003M"]
        for col in rate_cols:
            out[col] = raw_df[col].values / 100.0

        # ── Log commodity prices ──────────────────────────────────────────────
        out["log_Brent"] = np.log(np.clip(raw_df["Brent"].values,    5.0,  500.0))
        out["log_Gas"]   = np.log(np.clip(raw_df["Gas"].values,      1.0,  500.0))
        out["log_BCOM"]  = np.log(np.clip(raw_df["BCOM_raw"].values, 50.0, 600.0))

        # ── Optional macro series (zeros if absent) ───────────────────────────
        for col in _OPTIONAL_BBG:
            if col in raw_df.columns:
                out[col] = raw_df[col].values
            else:
                out[col] = np.zeros(n)
                warnings.warn(
                    f"[fair_value_models] {col} not in BBG response; using zeros.",
                    stacklevel=1,
                )

        # ── Derived: 3M10Y slope ──────────────────────────────────────────────
        out["slope_3m10y"] = out["EESWE10"] - out["EUR003M"]

        # ── ESTR forward rates (bootstrapped per row) ─────────────────────────
        _estr_fwd_specs = {
            "ESTR_1Y1Y":   (1, 1),
            "ESTR_2Y1Y":   (2, 1),
            "ESTR_2Y2Y":   (2, 2),
            "ESTR_2Y3Y":   (2, 3),
            "ESTR_5Y5Y":   (5, 5),
            "ESTR_10Y10Y": (10, 10),
            "ESTR_20Y10Y": (20, 10),
        }
        _estr_par_map = {
            1: "EESWE1", 2: "EESWE2", 3: "EESWE3", 4: "EESWE4",
            5: "EESWE5", 10: "EESWE10", 15: "EESWE15", 20: "EESWE20", 30: "EESWE30",
        }
        for fk in _estr_fwd_specs:
            out[fk] = np.full(n, np.nan)

        for i in range(n):
            par = {t: out[k][i] for t, k in _estr_par_map.items() if k in out}
            if len(par) < 4:
                continue
            try:
                D = _estr_discount_factors(par)
                for fk, (s, t) in _estr_fwd_specs.items():
                    if s + t <= 30:
                        out[fk][i] = _estr_fwd(D, s, t)
            except Exception:
                pass

        for fk in _estr_fwd_specs:
            out[fk] = pd.Series(out[fk]).ffill().bfill().values

        # ── HICPxT forward rates (zero-coupon algebra) ────────────────────────
        _hicp_fwd_specs = {
            "HICP_1Y1Y":   (1, 1,  "EUSWI1",  "EUSWI2"),
            "HICP_2Y1Y":   (2, 1,  "EUSWI2",  "EUSWI3"),
            "HICP_2Y2Y":   (2, 2,  "EUSWI2",  "EUSWI4"),
            "HICP_2Y3Y":   (2, 3,  "EUSWI2",  "EUSWI5"),
            "HICP_5Y5Y":   (5, 5,  "EUSWI5",  "EUSWI10"),
            "HICP_10Y10Y": (10, 10, "EUSWI10", "EUSWI20"),
            "HICP_20Y10Y": (20, 10, "EUSWI20", "EUSWI30"),
        }
        for fk, (s, t, near_k, far_k) in _hicp_fwd_specs.items():
            if near_k in out and far_k in out:
                r_n = out[near_k]
                r_f = out[far_k]
                valid = (~np.isnan(r_n)) & (~np.isnan(r_f)) & (r_n > -0.05) & (r_f > -0.05)
                arr = np.full(n, np.nan)
                arr[valid] = _hicp_fwd(r_n[valid], r_f[valid], s, t)
                out[fk] = pd.Series(arr).ffill().bfill().values
            else:
                out[fk] = np.zeros(n)
                warnings.warn(
                    f"[fair_value_models] Cannot compute {fk}: "
                    f"missing {near_k} or {far_k}.",
                    stacklevel=1,
                )

        return out, dates

    except Exception as exc:
        warnings.warn(f"[fair_value_models] BBG fetch failed: {exc}", stacklevel=1)
        return None


# ─── Simulation ───────────────────────────────────────────────────────────────

def _simulate() -> dict[str, np.ndarray]:
    """Return dict mapping key → [T] array of simulated market data."""

    years = np.array([(d.year + d.dayofyear / 365.0) for d in DATES])

    # ── Latent factors ──────────────────────────────────────────────────────
    # F_rates: global rates/inflation cycle, AR(0.9990), slow trend
    F_rates = np.zeros(T)
    for t in range(1, T):
        F_rates[t] = 0.9990 * F_rates[t - 1] + _RNG.normal(0, 0.012)

    # Inflation super-cycle overlay: low until 2022, surge 2021-2023, ease 2024
    supercycle = np.zeros(T)
    for i, y in enumerate(years):
        if y < 2014:
            supercycle[i] = 0.5 - (y - 2004) * 0.06          # 3.5→2.9 slow decline
        elif y < 2016:
            supercycle[i] = -0.3 - (y - 2014) * 0.20         # falls toward zero
        elif y < 2021:
            supercycle[i] = -0.7 + (y - 2016) * 0.04         # near zero / slightly neg
        elif y < 2022.5:
            supercycle[i] = -0.5 + (y - 2021) * 2.133        # sharp surge
        elif y < 2023.5:
            supercycle[i] = 2.7 - (y - 2022.5) * 1.8         # peak then ease
        else:
            supercycle[i] = 0.9 - (y - 2023.5) * 0.6         # continued easing
    supercycle = np.clip(supercycle, -0.8, 2.8)
    F_rates += supercycle

    # F_energy: energy price factor, AR(0.975)
    F_energy = np.zeros(T)
    for t in range(1, T):
        F_energy[t] = 0.975 * F_energy[t - 1] + _RNG.normal(0, 0.028)

    # Energy bumps
    def _bump_energy(center_year: float, height: float, width: float = 0.30):
        F_energy[:] += height * np.exp(-0.5 * ((years - center_year) / width) ** 2)

    _bump_energy(2008.5, 1.5, 0.30)   # 2008 oil spike
    _bump_energy(2009.0, -1.8, 0.25)  # crash
    _bump_energy(2012.0, 0.8, 0.40)   # recovery plateau
    _bump_energy(2016.0, -1.2, 0.30)  # 2016 trough
    _bump_energy(2020.25, -2.5, 0.20) # COVID crash
    _bump_energy(2022.3, 3.0, 0.25)   # 2022 energy crisis
    _bump_energy(2023.0, -2.2, 0.30)  # crash back

    # F_risk: credit/stress factor, AR(0.978)
    F_risk = np.zeros(T)
    for t in range(1, T):
        F_risk[t] = 0.978 * F_risk[t - 1] + _RNG.normal(0, 0.020)

    def _bump_risk(center_year: float, height: float, width: float = 0.25):
        F_risk[:] += height * np.exp(-0.5 * ((years - center_year) / width) ** 2)

    _bump_risk(2008.75, 2.0, 0.30)
    _bump_risk(2011.50, 1.0, 0.25)
    _bump_risk(2020.25, 2.5, 0.20)
    _bump_risk(2022.25, 0.9, 0.20)

    # ── Nominal swap rates (EESWE1..30) ─────────────────────────────────────
    # Params: (mean_bps_as_pct, sensitivity_to_F_rates, idio_std)
    nom_params = {
        "EESWE1":  (0.015, 0.90, 0.012),
        "EESWE2":  (0.015, 0.88, 0.012),
        "EESWE5":  (0.018, 0.82, 0.013),
        "EESWE10": (0.020, 0.76, 0.014),
        "EESWE15": (0.021, 0.73, 0.014),
        "EESWE20": (0.022, 0.70, 0.015),
        "EESWE30": (0.022, 0.68, 0.015),
    }
    out: dict[str, np.ndarray] = {}
    for key, (mean_level, sens, idio_std) in nom_params.items():
        idio = np.zeros(T)
        for t in range(1, T):
            idio[t] = 0.990 * idio[t - 1] + _RNG.normal(0, idio_std)
        series = mean_level + sens * 0.01 * F_rates + idio
        out[key] = np.clip(series, -0.015, 0.10)

    # ── ESTR forward rates ──────────────────────────────────────────────────
    # ESTR forwards slightly below corresponding nominal (no term premium)
    estr_params = {
        "ESTR_1Y1Y":   (0.013, 0.88, 0.013),
        "ESTR_2Y1Y":   (0.014, 0.85, 0.013),
        "ESTR_2Y2Y":   (0.015, 0.83, 0.013),
        "ESTR_2Y3Y":   (0.016, 0.81, 0.013),
        "ESTR_5Y5Y":   (0.019, 0.75, 0.014),
        "ESTR_10Y10Y": (0.021, 0.70, 0.014),
        "ESTR_20Y10Y": (0.021, 0.68, 0.015),
    }
    for key, (mean_level, sens, idio_std) in estr_params.items():
        idio = np.zeros(T)
        for t in range(1, T):
            idio[t] = 0.990 * idio[t - 1] + _RNG.normal(0, idio_std)
        series = mean_level + sens * 0.01 * F_rates + idio
        out[key] = np.clip(series, -0.015, 0.095)

    # ── Brent crude ─────────────────────────────────────────────────────────
    # Simulate log-Brent directly, then exponentiate
    log_brent_base = np.zeros(T)
    brent_idio = np.zeros(T)
    for t in range(1, T):
        brent_idio[t] = 0.980 * brent_idio[t - 1] + _RNG.normal(0, 0.025)
    log_brent_base = np.log(50) + 0.30 * F_energy + brent_idio

    # Deterministic shape anchors
    brent_shape = np.zeros(T)
    for i, y in enumerate(years):
        if y < 2004.5:
            brent_shape[i] = np.log(42)
        elif y < 2008.5:
            brent_shape[i] = np.log(42) + (y - 2004.5) / 4.0 * (np.log(130) - np.log(42))
        elif y < 2009.3:
            brent_shape[i] = np.log(130) - (y - 2008.5) / 0.8 * (np.log(130) - np.log(35))
        elif y < 2012.5:
            brent_shape[i] = np.log(35) + (y - 2009.3) / 3.2 * (np.log(110) - np.log(35))
        elif y < 2016.2:
            brent_shape[i] = np.log(110) - (y - 2012.5) / 3.7 * (np.log(110) - np.log(28))
        elif y < 2019.5:
            brent_shape[i] = np.log(28) + (y - 2016.2) / 3.3 * (np.log(80) - np.log(28))
        elif y < 2020.3:
            brent_shape[i] = np.log(80) - (y - 2019.5) / 0.8 * (np.log(80) - np.log(20))
        elif y < 2022.5:
            brent_shape[i] = np.log(20) + (y - 2020.3) / 2.2 * (np.log(130) - np.log(20))
        elif y < 2024.0:
            brent_shape[i] = np.log(130) - (y - 2022.5) / 1.5 * (np.log(130) - np.log(80))
        else:
            brent_shape[i] = np.log(80)

    # Blend deterministic shape with stochastic component
    log_brent = 0.60 * brent_shape + 0.40 * log_brent_base
    brent = np.exp(log_brent)
    brent = np.clip(brent, 15.0, 145.0)
    out["log_Brent"] = np.log(brent)

    # ── Gas TTF ─────────────────────────────────────────────────────────────
    gas_idio = np.zeros(T)
    for t in range(1, T):
        gas_idio[t] = 0.975 * gas_idio[t - 1] + _RNG.normal(0, 0.030)

    gas_shape = np.zeros(T)
    for i, y in enumerate(years):
        if y < 2021.0:
            gas_shape[i] = np.log(20) + (np.log(30) - np.log(20)) * (y - 2004) / 17.0
        elif y < 2022.5:
            gas_shape[i] = np.log(30) + (y - 2021.0) / 1.5 * (np.log(300) - np.log(30))
        elif y < 2023.3:
            gas_shape[i] = np.log(300) - (y - 2022.5) / 0.8 * (np.log(300) - np.log(30))
        else:
            gas_shape[i] = np.log(30) + (y - 2023.3) / 0.7 * (np.log(40) - np.log(30))
    gas_shape = np.clip(gas_shape, np.log(12), np.log(320))

    log_gas = 0.55 * gas_shape + 0.45 * (np.log(20) + 0.35 * F_energy + gas_idio)
    gas = np.exp(log_gas)
    gas = np.clip(gas, 10.0, 330.0)
    out["log_Gas"] = np.log(gas)

    # ── EUR 1M Swaption Vol (SMOVEU1M) ─────────────────────────────────────
    vol_idio = np.zeros(T)
    for t in range(1, T):
        vol_idio[t] = 0.980 * vol_idio[t - 1] + _RNG.normal(0, 3.0)
    smoveu = 70.0 + 15.0 * F_risk + vol_idio
    out["SMOVEU1M"] = np.clip(smoveu, 45.0, 130.0)

    # ── EURIBOR 3M (EUR003M) ────────────────────────────────────────────────
    # Tracks ECB policy rates closely; slightly above EESWE1 by the EURIBOR-OIS spread
    # The spread widens in stress episodes (F_risk loading)
    euribor_spread_idio = np.zeros(T)
    for t in range(1, T):
        euribor_spread_idio[t] = 0.950 * euribor_spread_idio[t - 1] + _RNG.normal(0, 0.0015)
    euribor_spread = 0.0010 + 0.004 * np.clip(F_risk / (F_risk.std() + 1e-8), -2, 3)
    out["EUR003M"] = np.clip(out["EESWE1"] + euribor_spread + euribor_spread_idio, -0.010, 0.060)

    # ── Bloomberg Commodity Index — log(BCOM) ────────────────────────────────
    # Broad basket (energy ~30%, metals ~25%, agri ~45%); correlated with F_energy + Brent
    bcom_idio = np.zeros(T)
    for t in range(1, T):
        bcom_idio[t] = 0.982 * bcom_idio[t - 1] + _RNG.normal(0, 0.018)
    log_bcom_raw = np.log(200) + 0.20 * F_energy + 0.25 * (out["log_Brent"] - np.log(50)) + bcom_idio
    out["log_BCOM"] = np.log(np.clip(np.exp(log_bcom_raw), 100, 350))

    # ── EUR Trade-Weighted Index (EUR_TWI) ───────────────────────────────────
    # ECB NEER; weakens when energy prices surge (terms-of-trade shock)
    # and when global risk-off hits EUR vs safe havens
    twi_idio = np.zeros(T)
    for t in range(1, T):
        twi_idio[t] = 0.985 * twi_idio[t - 1] + _RNG.normal(0, 0.50)
    out["EUR_TWI"] = np.clip(102 - 1.5 * F_energy + 0.8 * F_rates + twi_idio, 88, 115)

    # ── GS Euro Area Financial Conditions Index (GSEAFCI) ───────────────────
    # Higher = tighter financial conditions; spikes in stress episodes (F_risk)
    fci_idio = np.zeros(T)
    for t in range(1, T):
        fci_idio[t] = 0.975 * fci_idio[t - 1] + _RNG.normal(0, 0.15)
    out["GSEAFCI"] = np.clip(100 + 0.40 * F_risk - 0.15 * F_rates + fci_idio, 97.0, 104.0)

    # ── iTraxx Europe 5Y (ITRX5Y, spread in bps) ────────────────────────────
    # EUR IG credit default swap index; dominant loading on F_risk
    itrx_idio = np.zeros(T)
    for t in range(1, T):
        itrx_idio[t] = 0.978 * itrx_idio[t - 1] + _RNG.normal(0, 4.0)
    out["ITRX5Y"] = np.clip(65 + 30 * F_risk + itrx_idio, 30, 250)

    # ── Citi Economic Surprise Index EUR (CESIEUR) ───────────────────────────
    # Mean-reverting by construction (surprises vs consensus); no persistent trend
    cesi_idio = np.zeros(T)
    for t in range(1, T):
        cesi_idio[t] = 0.70 * cesi_idio[t - 1] + _RNG.normal(0, 30)
    out["CESIEUR"] = np.clip(cesi_idio, -150, 150)

    # ── 3M10Y Slope (slope_3m10y) ────────────────────────────────────────────
    # Derived: 10Y ESTR par swap minus EURIBOR 3M
    # Steepens in easing cycles (3M falls faster); flattens/inverts ahead of recession
    out["slope_3m10y"] = out["EESWE10"] - out["EUR003M"]

    # ── HICPxT outright rates (EUSWI1..30) ──────────────────────────────────
    # Energy inputs are DEMEANED so the regression sees deviations from a long-run
    # neutral price, not raw log-levels (which are large constants that cause clipping).
    # Long-run neutral: Brent $70/bbl, TTF Gas €25/MWh.
    _BRENT_LRM = np.log(70.0)
    _GAS_LRM   = np.log(25.0)
    brent_dev = out["log_Brent"] - _BRENT_LRM
    gas_dev   = out["log_Gas"]   - _GAS_LRM

    # (swap_key, b_swap, b_brent_dev, b_gas_dev, idio_std)
    # b_brent calibrated so a 1% move in log_Brent → ~2bp in 1Y HICP (empirical rule of thumb)
    hicp_out_params = {
        "EUSWI1":  ("EESWE1",  0.90, 0.022, 0.012, 0.0020),
        "EUSWI2":  ("EESWE2",  0.88, 0.021, 0.011, 0.0020),
        "EUSWI5":  ("EESWE5",  0.86, 0.019, 0.010, 0.0022),
        "EUSWI10": ("EESWE10", 0.84, 0.017, 0.009, 0.0022),
        "EUSWI15": ("EESWE15", 0.83, 0.015, 0.008, 0.0024),
        "EUSWI20": ("EESWE20", 0.82, 0.013, 0.007, 0.0024),
        "EUSWI30": ("EESWE30", 0.80, 0.011, 0.006, 0.0026),
    }
    for key, (swap_key, b1, b2, b3, idio_std) in hicp_out_params.items():
        idio = np.zeros(T)
        for t in range(1, T):
            idio[t] = 0.960 * idio[t - 1] + _RNG.normal(0, idio_std)
        series = (
            b1 * out[swap_key]
            + b2 * brent_dev                               # Brent deviation from $70
            + b3 * gas_dev                                 # Gas deviation from €25
            + 0.003   * (out["log_BCOM"] - np.log(200))   # broad commodity pass-through
            - 0.00015 * (out["EUR_TWI"] - 102)             # stronger EUR → lower import prices
            - 0.0010  * (out["GSEAFCI"] - 100)             # tighter FCI → lower inflation expectations
            - 0.000025 * (out["ITRX5Y"] - 65)              # wider credit → risk-off compression
            + 0.000008 * out["CESIEUR"]                    # positive data surprise → higher expectations
            + idio
        )
        out[key] = np.clip(series + 0.005, -0.04, 0.15)

    # ── HICPxT forward rates ─────────────────────────────────────────────────
    # Same demeaned energy convention; energy sensitivity declines at longer forward tenors
    # (swap_key, b_swap, b_brent_dev, b_gas_dev, b_vol, idio_std)
    hicp_fwd_params = {
        "HICP_1Y1Y":   ("ESTR_1Y1Y",   0.87, 0.018, 0.010, None,    0.0022),
        "HICP_2Y1Y":   ("ESTR_2Y1Y",   0.85, 0.016, 0.009, None,    0.0022),
        "HICP_2Y2Y":   ("ESTR_2Y2Y",   0.84, 0.015, 0.008, None,    0.0024),
        "HICP_2Y3Y":   ("ESTR_2Y3Y",   0.83, 0.014, 0.008, None,    0.0024),
        "HICP_5Y5Y":   ("ESTR_5Y5Y",   0.82, 0.010, 0.006, None,    0.0026),
        "HICP_10Y10Y": ("ESTR_10Y10Y", 0.80, 0.005, 0.003, -0.0015, 0.0028),
        "HICP_20Y10Y": ("ESTR_20Y10Y", 0.78, 0.003, 0.002, -0.0015, 0.0028),
    }
    for key, (estr_key, b1, b2, b3, b4_vol, idio_std) in hicp_fwd_params.items():
        idio = np.zeros(T)
        for t in range(1, T):
            idio[t] = 0.960 * idio[t - 1] + _RNG.normal(0, idio_std)
        series = (
            b1 * out[estr_key]
            + b2 * brent_dev
            + b3 * gas_dev
            + 0.003   * (out["log_BCOM"] - np.log(200))
            - 0.00015 * (out["EUR_TWI"] - 102)
            - 0.0010  * (out["GSEAFCI"] - 100)
            - 0.000025 * (out["ITRX5Y"] - 65)
            + 0.000008 * out["CESIEUR"]
            + idio
        )
        if b4_vol is not None:
            series += b4_vol * (out["SMOVEU1M"] - 70.0) * 0.001
        out[key] = np.clip(series + 0.008, -0.010, 0.10)

    # Verify no NaN
    for k, v in out.items():
        assert not np.any(np.isnan(v)), f"NaN found in {k}"

    return out


# ─── Rolling Elastic Net ──────────────────────────────────────────────────────

def _rolling_elastic_net(X: np.ndarray, y: np.ndarray, feature_names: list[str]) -> dict:
    """Fit rolling ElasticNet and return chart-ready dict."""

    en = ElasticNet(alpha=0.01, l1_ratio=0.5, max_iter=2000, tol=1e-4, warm_start=True)
    scaler = StandardScaler()

    n = len(y)
    fitted_full    = np.full(n, np.nan)   # OOS predictions (train on [t-500, t-1], predict t)
    residuals_full = np.full(n, np.nan)   # OOS residuals
    r2_is_full     = np.full(n, np.nan)   # in-sample R² on training window
    coef_full      = np.full((n, len(feature_names)), np.nan)

    fit_indices = list(range(MIN_WINDOW, n, FIT_STEP))
    if fit_indices and fit_indices[-1] != n - 1:
        fit_indices.append(n - 1)

    for t in fit_indices:
        # Train on [t-ROLL_WINDOW, t-1] — excludes t → genuine OOS prediction at t
        start = max(0, t - ROLL_WINDOW)
        Xw = X[start : t]
        yw = y[start : t]

        Xw_sc = scaler.fit_transform(Xw)
        en.fit(Xw_sc, yw)

        # OOS prediction at t
        x_curr = scaler.transform(X[t : t + 1])
        fitted_full[t]    = float(en.predict(x_curr)[0])
        residuals_full[t] = y[t] - fitted_full[t]
        coef_full[t]      = en.coef_

        # In-sample R² on training window (not t)
        y_pred_w = en.predict(Xw_sc)
        ss_res = np.sum((yw - y_pred_w) ** 2)
        ss_tot = np.sum((yw - yw.mean()) ** 2)
        r2_is_full[t] = 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0

    idx = pd.RangeIndex(n)
    fitted_s = pd.Series(fitted_full, index=idx).ffill().bfill()
    resid_s  = pd.Series(residuals_full, index=idx).ffill().bfill()
    r2_s     = pd.Series(r2_is_full, index=idx).ffill().bfill()

    coef_df = pd.DataFrame(coef_full, columns=feature_names)
    coef_df = coef_df.ffill().bfill()

    # Rolling sigma bands on OOS residuals
    resid_roll_mean = resid_s.rolling(252, min_periods=60).mean().bfill().ffill()
    resid_roll_std  = resid_s.rolling(252, min_periods=60).std().bfill().ffill()
    sigma1_hi = (resid_roll_mean + 1.0 * resid_roll_std)
    sigma1_lo = (resid_roll_mean - 1.0 * resid_roll_std)
    sigma2_hi = (resid_roll_mean + 2.0 * resid_roll_std)
    sigma2_lo = (resid_roll_mean - 2.0 * resid_roll_std)

    # ── Rolling OOS R² and random-walk benchmark ────────────────────────────
    y_s = pd.Series(y, index=idx)
    oos_resid_s = pd.Series(residuals_full, index=idx)  # NaN before MIN_WINDOW

    # Benchmark: random walk (predict today = yesterday)
    rw_resid = np.full(n, np.nan)
    rw_resid[1:] = y[1:] - y[:-1]
    rw_resid_s = pd.Series(rw_resid, index=idx)

    RW = 252  # rolling window for OOS R²
    MP = 60   # min periods

    ss_res_oos  = oos_resid_s.pow(2).rolling(RW, min_periods=MP).sum()
    ss_res_rw   = rw_resid_s.pow(2).rolling(RW, min_periods=MP).sum()
    y_mean_roll = y_s.rolling(RW, min_periods=MP).mean()
    ss_tot_roll = (y_s - y_mean_roll).pow(2).rolling(RW, min_periods=MP).sum()

    # Clip at -2 to keep chart readable when model is badly wrong early on
    oos_r2_s  = (1 - ss_res_oos  / ss_tot_roll).clip(-2, 1).ffill().bfill()
    bench_r2_s = (1 - ss_res_rw  / ss_tot_roll).clip(-2, 1).ffill().bfill()

    # Subsample for output — actual from day 0; fitted/residuals/bands/r2/coefs from MIN_WINDOW
    step_idx = list(range(0, n, OUTPUT_STEP))
    if step_idx and step_idx[-1] != n - 1:
        step_idx.append(n - 1)

    def _val(s: pd.Series, i: int, guard: bool = True) -> float | None:
        if guard and i < MIN_WINDOW:
            return None
        v = float(s.iloc[i])
        return round(v, 4) if not (v != v) else None  # NaN check

    dates_out = [DATES[i].strftime("%Y-%m-%d") for i in step_idx]
    actual_out = [round(float(y[i]), 4) for i in step_idx]
    fitted_out = [_val(fitted_s, i) for i in step_idx]
    resid_out  = [_val(resid_s, i) for i in step_idx]
    s1hi = [_val(sigma1_hi, i) for i in step_idx]
    s1lo = [_val(sigma1_lo, i) for i in step_idx]
    s2hi = [_val(sigma2_hi, i) for i in step_idx]
    s2lo = [_val(sigma2_lo, i) for i in step_idx]
    r2_out      = [_val(r2_s,      i) for i in step_idx]
    oos_r2_out  = [_val(oos_r2_s,  i) for i in step_idx]
    bench_r2_out = [_val(bench_r2_s, i) for i in step_idx]

    coef_series: dict[str, list[float | None]] = {}
    for name in feature_names:
        coef_series[name] = [_val(coef_df[name], i) for i in step_idx]

    last_valid_mask = ~np.isnan(coef_full[:, 0])
    last_valid = int(np.where(last_valid_mask)[0][-1]) if last_valid_mask.any() else -1
    latest_coefs: dict[str, float] = {}
    if last_valid >= 0:
        for j, name in enumerate(feature_names):
            latest_coefs[name] = round(float(coef_full[last_valid, j]), 4)
    else:
        latest_coefs = {name: 0.0 for name in feature_names}

    # Scatter: residual vs forward returns at 5 / 10 / 20 / 100 days
    SCATTER_STEP = max(1, n // 400)
    scatter_idx = list(range(MIN_WINDOW, n, SCATTER_STEP))
    sc_resid: list[float] = []
    sc_fwd5: list[float | None] = []
    sc_fwd10: list[float | None] = []
    sc_fwd20: list[float | None] = []
    sc_fwd100: list[float | None] = []
    for i in scatter_idx:
        r = resid_s.iloc[i]
        if np.isnan(r):
            continue
        for fwd_list, horizon in [(sc_fwd5, 5), (sc_fwd10, 10), (sc_fwd20, 20), (sc_fwd100, 100)]:
            if i + horizon < n:
                fwd_list.append(round(float(y[i + horizon] - y[i]), 4))
            else:
                fwd_list.append(None)
        sc_resid.append(round(float(r), 4))

    # OLS trend lines for scatter
    def _ols_line(xs: list, ys: list, n_pts: int = 30) -> dict[str, list[float]]:
        pairs = [(x, y_) for x, y_ in zip(xs, ys) if y_ is not None]
        if len(pairs) < 5:
            return {"x": [], "y": []}
        xv = np.array([p[0] for p in pairs])
        yv = np.array([p[1] for p in pairs])
        coef = np.polyfit(xv, yv, 1)
        x_min, x_max = float(xv.min()), float(xv.max())
        x_line = np.linspace(x_min, x_max, n_pts)
        y_line = np.polyval(coef, x_line)
        return {"x": [round(float(v), 4) for v in x_line],
                "y": [round(float(v), 4) for v in y_line]}

    scatter_trend = {
        "5d":   _ols_line(sc_resid, sc_fwd5),
        "10d":  _ols_line(sc_resid, sc_fwd10),
        "20d":  _ols_line(sc_resid, sc_fwd20),
        "100d": _ols_line(sc_resid, sc_fwd100),
    }

    return {
        "dates":        dates_out,
        "actual":       actual_out,
        "fitted":       fitted_out,
        "residuals":    resid_out,
        "sigma1_hi":    s1hi,
        "sigma1_lo":    s1lo,
        "sigma2_hi":    s2hi,
        "sigma2_lo":    s2lo,
        "rolling_r2":   r2_out,
        "oos_r2":       oos_r2_out,
        "bench_r2":     bench_r2_out,
        "coef_names":   feature_names,
        "coef_series":  coef_series,
        "latest_coefs": latest_coefs,
        "scatter": {
            "residuals": sc_resid,
            "fwd5d":   sc_fwd5,
            "fwd10d":  sc_fwd10,
            "fwd20d":  sc_fwd20,
            "fwd100d": sc_fwd100,
        },
        "scatter_trend": scatter_trend,
    }


# ─── Pre-compute ──────────────────────────────────────────────────────────────
# Try Bloomberg live data first; fall back to simulation on any failure.

_source = os.environ.get("ANALYTICS_DATA_SOURCE", "csv").lower()
_live_result = None

if _source == "bloomberg":
    _live_result = _fetch_live_data(
        start="2004-01-01",
        end=pd.Timestamp.today().strftime("%Y-%m-%d"),
    )

if _live_result is not None:
    _VARS, _live_dates = _live_result
    DATES = _live_dates    # override module-level DATES with live date range
    T = len(DATES)         # override T
    data_source = "bloomberg"
else:
    _VARS = _simulate()
    data_source = "simulation"

_RESULTS: dict[str, dict] = {}
for _m in _MODEL_DEFS:
    _X = np.column_stack([_VARS[k] for k in _m["x_keys"]])
    _y = _VARS[_m["y_key"]]
    _RESULTS[_m["id"]] = {
        "title": _m["title"],
        "group": _m["group"],
        **_rolling_elastic_net(_X, _y, _m["x_names"]),
    }


def get_fair_value_models_data() -> dict:
    return {
        "groups":      _GROUPS,
        "model_ids":   [m["id"] for m in _MODEL_DEFS],
        "models":      _RESULTS,
        "data_source": data_source,
    }
