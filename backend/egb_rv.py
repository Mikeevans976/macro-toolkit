"""
EGB RV Monitor — Bund, OAT, BTP, Bonos, Belgium, Portugal, Netherlands, Austria, Finland.

Carry methodology (yield expressions):
  leg_carry_bps = ((y_T − repo_bloc) / dur_T + roll_T) × 100
  where:
    y_T       = yield at tenor T in %
    repo_bloc = repo rate for the country's repo bloc (ESTR baseline + user spread)
    dur_T     = modified duration ≈ T × (1 − y_T / 200)  [rough par-bond approximation]
    roll_T    = y(T) − y(T−1) from cubic spline [% per year]
  expression_carry = Σ weight_i × leg_carry_bps_i

Repo blocs:
  "Bund"  — Bund (often trades special)
  "OAT"   — OAT, Belgium, Netherlands, Austria, Finland (near GC)
  "BTP"   — Italy
  "Bonos" — Spain, Portugal (peripheral GC proxy)

For ASW expressions:
  carry_bps = ASW_level_bps + roll_bond_bps
  where roll_bond_bps = (y(T) − y(T−1)) × 100

Bloomberg tickers (⚠️ verify ASW tickers before live use):
  Bund        : GDBR{T} Index
  OAT         : GFRN{T} Index
  BTP         : GBTPGR{T} Index
  Bonos       : GSPG{T}YR Index
  Belgium     : GBGB{T}YR Index      ⚠️
  Portugal    : GPTIT{T}YR Index     ⚠️
  Netherlands : GNETH{T}YR Index     ⚠️
  Austria     : GAGB{T}YR Index      ⚠️
  Finland     : GFINGB{T} Index      ⚠️
  ESTR        : ESTRON Index
  EUR 1m10y vol: EUSV0001 Index
"""

import warnings
from typing import Optional

import numpy as np
import pandas as pd
from scipy import stats
from scipy.interpolate import CubicSpline

from egb_expressions_config import (
    ALL_EXPRESSIONS, GROUP_META,
    REPO_BLOC, REPO_BLOCS, COUNTRY_TENORS,
)

# ─── Constants ────────────────────────────────────────────────────────────────

ALL_TENORS = [2, 5, 7, 10, 15, 20, 30]   # union of all benchmark tenors

# ─── Bloomberg ticker maps ────────────────────────────────────────────────────

_YIELD_TICKERS: dict[str, dict[int, str]] = {
    "Bund":        {t: f"GDBR{t} Index"     for t in COUNTRY_TENORS["Bund"]},
    "OAT":         {t: f"GFRN{t} Index"     for t in COUNTRY_TENORS["OAT"]},
    "BTP":         {t: f"GBTPGR{t} Index"   for t in COUNTRY_TENORS["BTP"]},
    "Bonos":       {t: f"GSPG{t}YR Index"   for t in COUNTRY_TENORS["Bonos"]},
    "Belgium":     {t: f"GBGB{t}YR Index"   for t in COUNTRY_TENORS["Belgium"]},
    "Portugal":    {t: f"GPTIT{t}YR Index"  for t in COUNTRY_TENORS["Portugal"]},
    "Netherlands": {t: f"GNETH{t}YR Index"  for t in COUNTRY_TENORS["Netherlands"]},
    "Austria":     {t: f"GAGB{t}YR Index"   for t in COUNTRY_TENORS["Austria"]},
    "Finland":     {t: f"GFINGB{t} Index"   for t in COUNTRY_TENORS["Finland"]},
}

_ESTR_TICKER = "ESTRON Index"

# ⚠️ Verify these before live use
_ASW_TICKERS: dict[str, dict[int, str]] = {
    "Bund":        {t: f"DASW{t} Index"   for t in [2, 5, 10, 30]},
    "OAT":         {t: f"FOASW{t} Index"  for t in [2, 5, 10, 30]},
    "BTP":         {t: f"ITASW{t} Index"  for t in [5, 10, 30]},
    "Bonos":       {t: f"SPASW{t} Index"  for t in [5, 10]},
    "Belgium":     {t: f"BEASW{t} Index"  for t in [10]},
    "Netherlands": {t: f"NLASW{t} Index"  for t in [10]},
}

_VOL_TICKER = "EUSV0001 Index"   # EUR 1m10y swaption normal vol (bps)

# ─── Carry helpers ────────────────────────────────────────────────────────────

def _modified_duration(T: float, y_pct: float) -> float:
    """Rough modified duration for an approximate par bond at tenor T."""
    return max(T * (1.0 - y_pct / 200.0), 0.5)


def _build_spline(tenors: list[int], yields: np.ndarray) -> CubicSpline:
    """Cubic spline of yield curve; extrapolates flat beyond last tenor."""
    return CubicSpline(tenors, yields, bc_type="not-a-knot", extrapolate=True)


def _leg_carry_components(country: str, T: int, splines: dict, repo: float) -> tuple[float, float]:
    """
    Returns (income_carry_bps, roll_bps) for a single yield leg.
      income_carry = (y_T − repo) / dur_T × 100   [repo = ESTR baseline]
      roll         = (y_T − y_{T-1}) × 100
    Total carry = income_carry + roll.
    Repo sensitivity per bloc is captured separately by _repo_sensitivity().
    """
    cs = splines[country]
    y_T  = float(cs(T))
    y_T1 = float(cs(max(T - 1.0, 0.5)))
    roll = y_T - y_T1
    dur  = _modified_duration(T, y_T)
    income_carry = (y_T - repo) / dur * 100.0
    roll_bps     = roll * 100.0
    return income_carry, roll_bps


def _leg_carry_bps(country: str, T: int, splines: dict, repo: float) -> float:
    """Full carry (income + roll) for a single yield leg in bps/yr."""
    ic, roll = _leg_carry_components(country, T, splines, repo)
    return ic + roll


def _asw_carry_components(country_base: str, T: int, splines: dict, asw_level: float) -> tuple[float, float]:
    """
    Returns (income_carry_bps, roll_bps) for an ASW leg.
      income_carry = ASW_level_bps
      roll         = bond roll-down in bps
    """
    cs = splines[country_base]
    y_T  = float(cs(T))
    y_T1 = float(cs(max(T - 1.0, 0.5)))
    roll_bps = (y_T - y_T1) * 100.0
    return asw_level, roll_bps


def _repo_sensitivity(legs: list, splines: dict) -> dict[str, float]:
    """
    Carry change (bps) per 1% change in repo rate for each repo bloc.
    δcarry / δrepo_bloc = Σ_{legs in bloc} weight_i × (−100 / dur_i)

    Positive value → carry increases when that bloc's repo rises (net short that bloc).
    Negative value → carry decreases when repo rises (net long that bloc).
    """
    sens: dict[str, float] = {bloc: 0.0 for bloc in REPO_BLOCS}
    for country, tenor, weight in legs:
        if country.endswith("_ASW"):
            continue  # ASW carry does not depend on repo directly
        bloc = REPO_BLOC.get(country)
        if bloc is None:
            continue
        cs = splines.get(country)
        if cs is None:
            continue
        y_T = float(cs(tenor))
        dur = _modified_duration(tenor, y_T)
        sens[bloc] += weight * (-100.0 / dur)
    return {k: round(v, 4) for k, v in sens.items()}


def _expression_carry_components(
    legs: list, splines: dict, asw_latest: dict, repo: float
) -> tuple[float, float]:
    """
    Returns (income_carry_bps, roll_bps) for a composite expression.
    income_carry is affected by repo assumptions; roll is not.
    repo is the ESTR baseline (user adjustments applied via sensitivity on frontend).
    """
    total_income = 0.0
    total_roll   = 0.0
    for country, tenor, weight in legs:
        if country.endswith("_ASW"):
            base = country.replace("_ASW", "")
            level = asw_latest.get((base, tenor), 0.0)
            ic, roll = _asw_carry_components(base, tenor, splines, level)
        else:
            ic, roll = _leg_carry_components(country, tenor, splines, repo)
        total_income += weight * ic
        total_roll   += weight * roll
    return total_income, total_roll


def _expression_level(legs: list, yield_row: dict, asw_row: dict) -> float:
    """Level of an expression in bps."""
    total = 0.0
    for country, tenor, weight in legs:
        if country.endswith("_ASW"):
            base = country.replace("_ASW", "")
            total += weight * asw_row.get((base, tenor), np.nan)
        else:
            v = yield_row.get((country, tenor), np.nan)
            if np.isnan(v):
                return np.nan
            total += weight * v * 100.0
    return total

# ─── Bloomberg fetch ──────────────────────────────────────────────────────────

def _fetch_from_bbg(start: str, end: str):
    """
    Fetch EGB yields (all 9 countries), ESTR, ASW spreads, EUR 1m10y vol from Bloomberg.
    Returns (yield_df, estr_s, asw_df, vol_s) or None on failure.

    yield_df : DatetimeIndex, MultiIndex columns (country, tenor), values in %
    estr_s   : Series, ESTR in %
    asw_df   : DatetimeIndex, MultiIndex columns (country, tenor), values in bps
    vol_s    : Series, 1m10y vol in bps normal
    """
    try:
        from bbg import blp
    except ImportError:
        return None

    try:
        # ── Yields ────────────────────────────────────────────────────────────
        yield_ticker_map: dict[str, tuple[str, int]] = {}
        for country, tmap in _YIELD_TICKERS.items():
            for tenor, ticker in tmap.items():
                yield_ticker_map[ticker] = (country, tenor)

        raw_y = blp.bdh(list(yield_ticker_map), "PX_LAST", start, end)
        if raw_y is None or raw_y.empty:
            warnings.warn("[egb_rv] No yield data from BBG")
            return None
        if isinstance(raw_y.columns, pd.MultiIndex):
            raw_y = raw_y.xs("PX_LAST", axis=1, level=1)

        records: list[tuple] = []
        for ticker, (country, tenor) in yield_ticker_map.items():
            if ticker in raw_y.columns:
                s = raw_y[ticker].dropna()
                for date, val in s.items():
                    records.append((date, country, tenor, val))
        ydf = (
            pd.DataFrame(records, columns=["date", "country", "tenor", "yield"])
            .pivot_table(index="date", columns=["country", "tenor"], values="yield")
        )
        ydf.index = pd.to_datetime(ydf.index)

        # ── ESTR ──────────────────────────────────────────────────────────────
        raw_estr = blp.bdh([_ESTR_TICKER], "PX_LAST", start, end)
        if raw_estr is None or raw_estr.empty:
            warnings.warn("[egb_rv] No ESTR data; defaulting to 0%")
            estr_s = pd.Series(0.0, index=ydf.index)
        else:
            if isinstance(raw_estr.columns, pd.MultiIndex):
                raw_estr = raw_estr.xs("PX_LAST", axis=1, level=1)
            estr_s = raw_estr.iloc[:, 0].reindex(ydf.index, method="ffill")

        # ── ASW ───────────────────────────────────────────────────────────────
        asw_ticker_map: dict[str, tuple[str, int]] = {}
        for country, tmap in _ASW_TICKERS.items():
            for tenor, ticker in tmap.items():
                asw_ticker_map[ticker] = (country, tenor)

        raw_asw = blp.bdh(list(asw_ticker_map), "PX_LAST", start, end)
        if raw_asw is None or raw_asw.empty:
            warnings.warn("[egb_rv] No ASW data from BBG; ASW expressions will be skipped")
            asw_df = pd.DataFrame(index=ydf.index)
        else:
            if isinstance(raw_asw.columns, pd.MultiIndex):
                raw_asw = raw_asw.xs("PX_LAST", axis=1, level=1)
            arecs: list[tuple] = []
            for ticker, (country, tenor) in asw_ticker_map.items():
                if ticker in raw_asw.columns:
                    for date, val in raw_asw[ticker].dropna().items():
                        arecs.append((date, country, tenor, val))
            if arecs:
                asw_df = (
                    pd.DataFrame(arecs, columns=["date", "country", "tenor", "asw"])
                    .pivot_table(index="date", columns=["country", "tenor"], values="asw")
                )
                asw_df.index = pd.to_datetime(asw_df.index)
                asw_df = asw_df.reindex(ydf.index, method="ffill")
            else:
                asw_df = pd.DataFrame(index=ydf.index)

        # ── Vol ───────────────────────────────────────────────────────────────
        raw_vol = blp.bdh([_VOL_TICKER], "PX_LAST", start, end)
        if raw_vol is None or raw_vol.empty:
            vol_s = pd.Series(np.nan, index=ydf.index)
        else:
            if isinstance(raw_vol.columns, pd.MultiIndex):
                raw_vol = raw_vol.xs("PX_LAST", axis=1, level=1)
            vol_s = raw_vol.iloc[:, 0].reindex(ydf.index, method="ffill")

        return ydf, estr_s, asw_df, vol_s

    except Exception as exc:
        warnings.warn(f"[egb_rv] BBG fetch failed: {exc}")
        return None

# ─── Simulation fallback ──────────────────────────────────────────────────────

# Spread parameters vs Bund (at ALL_TENORS = [2,5,7,10,15,20,30])
# Format: mean_spreads_pct, sigma_pct_per_rootday, mr_speed, min_clip_pct
_SPREAD_PARAMS: dict[str, tuple[list, float, float, float]] = {
    "OAT":         ([0.55, 0.60, 0.65, 0.68, 0.70, 0.72, 0.75], 0.013 / 252**0.5, 0.005,  0.10),
    "BTP":         ([1.20, 1.40, 1.55, 1.60, 1.65, 1.70, 1.75], 0.025 / 252**0.5, 0.004,  0.20),
    "Bonos":       ([0.80, 0.90, 0.98, 1.05, 1.10, 1.12, 1.15], 0.018 / 252**0.5, 0.005,  0.10),
    "Belgium":     ([0.30, 0.35, 0.40, 0.42, 0.44, 0.46, 0.48], 0.008 / 252**0.5, 0.005,  0.00),
    "Portugal":    ([0.75, 0.85, 0.95, 1.00, 1.05, 1.10, 1.12], 0.016 / 252**0.5, 0.005,  0.10),
    "Netherlands": ([0.05, 0.07, 0.08, 0.10, 0.11, 0.12, 0.13], 0.004 / 252**0.5, 0.008, -0.10),
    "Austria":     ([0.15, 0.18, 0.20, 0.23, 0.24, 0.25, 0.26], 0.006 / 252**0.5, 0.007, -0.05),
    "Finland":     ([0.10, 0.12, 0.14, 0.15, 0.16, 0.17, 0.18], 0.005 / 252**0.5, 0.007, -0.05),
}


def _simulate_spread_path(
    rng: np.random.Generator,
    n_days: int,
    mean: list[float],
    sigma: float,
    mr: float,
    min_clip: float,
) -> np.ndarray:
    """Simulate a correlated mean-reverting spread path across ALL_TENORS tenors."""
    n = len(mean)
    # High intra-country correlation (decays with tenor distance)
    corr = np.array([[0.97 ** abs(i - j) for j in range(n)] for i in range(n)])
    cov  = (sigma ** 2) * corr
    L    = np.linalg.cholesky(cov)
    shocks = (L @ rng.standard_normal((n, n_days))).T  # (n_days, n)
    path = np.zeros((n_days, n))
    mean_arr = np.array(mean)
    path[0] = mean_arr * 0.8
    for t in range(1, n_days):
        path[t] = path[t - 1] + mr * (mean_arr - path[t - 1]) + shocks[t]
    return np.clip(path, min_clip, None)


def _simulate_data(n_days: int = 1260, seed: int = 42) -> tuple:
    """
    Generate ~5y of realistic synthetic daily EGB data for all 9 countries.
    Returns (yield_df, estr_s, asw_df, vol_s).
    """
    rng = np.random.default_rng(seed)
    dates = pd.bdate_range(end="2025-06-30", periods=n_days)

    # ── Bund curve (levels in %) ───────────────────────────────────────────
    bund_mean  = np.array([1.50, 2.00, 2.30, 2.50, 2.62, 2.72, 2.80])
    sigma_bund = np.array([0.05, 0.04, 0.035, 0.03, 0.025, 0.022, 0.020]) / 252**0.5
    corr_bund  = np.array([
        [1.00, 0.97, 0.95, 0.92, 0.88, 0.85, 0.82],
        [0.97, 1.00, 0.98, 0.96, 0.93, 0.90, 0.87],
        [0.95, 0.98, 1.00, 0.99, 0.96, 0.93, 0.90],
        [0.92, 0.96, 0.99, 1.00, 0.98, 0.96, 0.93],
        [0.88, 0.93, 0.96, 0.98, 1.00, 0.99, 0.97],
        [0.85, 0.90, 0.93, 0.96, 0.99, 1.00, 0.99],
        [0.82, 0.87, 0.90, 0.93, 0.97, 0.99, 1.00],
    ])
    cov_bund = np.outer(sigma_bund, sigma_bund) * corr_bund
    L_bund   = np.linalg.cholesky(cov_bund)
    shocks_b = (L_bund @ rng.standard_normal((7, n_days))).T
    bund_path = np.zeros((n_days, 7))
    bund_path[0] = bund_mean - 0.80
    for t in range(1, n_days):
        bund_path[t] = bund_path[t-1] + 0.004 * (bund_mean - bund_path[t-1]) + shocks_b[t]

    # ── All-tenor Bund interpolator (for subsetting other countries) ───────
    def bund_at_tenor(t_idx: int) -> np.ndarray:
        """Return Bund path for ALL_TENORS index t_idx (column of bund_path)."""
        return bund_path[:, t_idx]

    # ── Spread paths for all other countries (at ALL_TENORS) ──────────────
    all_cols: list[tuple] = [("Bund", t) for t in ALL_TENORS]
    all_data: list[np.ndarray] = [bund_path[:, i] for i in range(7)]

    for country, (mean_spreads, sigma, mr, min_clip) in _SPREAD_PARAMS.items():
        spread = _simulate_spread_path(rng, n_days, mean_spreads, sigma, mr, min_clip)
        country_yields = bund_path + spread   # (n_days, 7) at ALL_TENORS
        # Keep only tenors in COUNTRY_TENORS[country]
        for i, t in enumerate(ALL_TENORS):
            if t in COUNTRY_TENORS[country]:
                all_cols.append((country, t))
                all_data.append(country_yields[:, i])

    # ── Build MultiIndex DataFrame ─────────────────────────────────────────
    cols     = pd.MultiIndex.from_tuples(all_cols)
    yield_df = pd.DataFrame(np.column_stack(all_data), index=dates, columns=cols)

    # ── ESTR: starts at 4%, mean-reverts to 2.5% ──────────────────────────
    estr_path = np.zeros(n_days)
    estr_path[0] = 4.0
    estr_shock = rng.standard_normal(n_days) * 0.01
    for t in range(1, n_days):
        estr_path[t] = estr_path[t-1] + 0.003 * (2.5 - estr_path[t-1]) + estr_shock[t]
    estr_s = pd.Series(estr_path, index=dates)

    # ── ASW: Bund negative, OAT near-zero, others with realistic levels ────
    asw_specs = {
        "Bund":        ([2, 5, 10, 30],  [-35.0, -40.0, -45.0, -38.0], 2.0),
        "OAT":         ([2, 5, 10, 30],  [ 20.0,  12.0,   5.0,   2.0], 1.8),
        "BTP":         ([5, 10, 30],     [ -5.0,  -8.0, -15.0],        3.5),
        "Bonos":       ([5, 10],         [  8.0,   3.0],               2.5),
        "Belgium":     ([10],            [ 15.0],                       1.5),
        "Netherlands": ([10],            [  5.0],                       1.2),
    }

    asw_cols_list: list[tuple] = []
    asw_data_list: list[np.ndarray] = []
    sigma_asw_base = 1.0 / 252**0.5
    for country, (tenors, means, sigma_mult) in asw_specs.items():
        n_t = len(tenors)
        sigma_a = sigma_asw_base * sigma_mult
        path = np.zeros((n_days, n_t))
        path[0] = np.array(means) + rng.standard_normal(n_t) * sigma_mult * 2
        for t in range(1, n_days):
            path[t] = path[t-1] + 0.003 * (np.array(means) - path[t-1]) + rng.standard_normal(n_t) * sigma_a
        for i, tenor in enumerate(tenors):
            asw_cols_list.append((country, tenor))
            asw_data_list.append(path[:, i])

    asw_df = pd.DataFrame(
        np.column_stack(asw_data_list),
        index=dates,
        columns=pd.MultiIndex.from_tuples(asw_cols_list),
    )

    # ── EUR 1m10y vol (bps normal) ────────────────────────────────────────
    vol_path = np.zeros(n_days)
    vol_path[0] = 60.0
    for t in range(1, n_days):
        vol_path[t] = vol_path[t-1] + 0.005 * (65.0 - vol_path[t-1]) + rng.standard_normal() * 1.5
    vol_path = np.clip(vol_path, 20.0, 200.0)
    vol_s = pd.Series(vol_path, index=dates)

    return yield_df, estr_s, asw_df, vol_s

# ─── Main compute function ────────────────────────────────────────────────────

def compute_egb_rv(as_of_date: Optional[str] = None) -> dict:
    """
    Compute EGB RV monitor for Bund, OAT, BTP, Bonos, Belgium, Portugal,
    Netherlands, Austria, Finland.

    Returns:
      as_of, min_date, max_date, data_source,
      rv_monitor   : list of RV rows (level, changes, z-score, pctile, vol, carry, repo sensitivities)
      beta_monitor : list of beta regression rows
      series       : 1y daily series per expression
      groups       : group metadata for display
    """
    _end   = (pd.Timestamp(as_of_date) if as_of_date else pd.Timestamp.today()).strftime("%Y-%m-%d")
    _start = (pd.Timestamp(_end) - pd.DateOffset(years=6)).strftime("%Y-%m-%d")

    bbg_result = _fetch_from_bbg(_start, _end)
    if bbg_result is not None:
        yield_df, estr_s, asw_df, vol_s = bbg_result
        data_source = "bloomberg"
    else:
        yield_df, estr_s, asw_df, vol_s = _simulate_data()
        data_source = "simulation"

    # ── Align and trim ────────────────────────────────────────────────────
    yield_df = yield_df.sort_index().dropna(how="all")
    estr_s   = estr_s.reindex(yield_df.index, method="ffill").fillna(0.0)
    asw_df   = asw_df.reindex(yield_df.index, method="ffill") if not asw_df.empty else asw_df
    vol_s    = vol_s.reindex(yield_df.index, method="ffill")

    if as_of_date:
        cutoff = pd.Timestamp(as_of_date)
        yield_df = yield_df.loc[yield_df.index <= cutoff]
        estr_s   = estr_s.loc[estr_s.index <= cutoff]
        vol_s    = vol_s.loc[vol_s.index <= cutoff]
        if not asw_df.empty:
            asw_df = asw_df.loc[asw_df.index <= cutoff]

    if yield_df.empty:
        raise ValueError("No data available")

    min_date = yield_df.index[0].strftime("%Y-%m-%d")
    max_date = yield_df.index[-1].strftime("%Y-%m-%d")
    as_of    = max_date

    n = len(yield_df)
    win_1y  = min(252, n)
    win_3m  = min(63, n)

    # ── Build cubic splines for the as-of date (for carry) ───────────────
    latest_yields = yield_df.iloc[-1]
    latest_repo   = float(estr_s.iloc[-1])
    latest_asw: dict[tuple, float] = {}
    if not asw_df.empty:
        for col in asw_df.columns:
            val = float(asw_df.iloc[-1].get(col, np.nan))
            if not np.isnan(val):
                latest_asw[tuple(col)] = val

    splines: dict[str, CubicSpline] = {}
    for country, tenors in COUNTRY_TENORS.items():
        ys = np.array([float(latest_yields.get((country, t), np.nan)) for t in tenors])
        valid = ~np.isnan(ys)
        if valid.sum() >= 3:
            ts_valid = np.array(tenors)[valid]
            ys_valid = ys[valid]
            splines[country] = _build_spline(list(ts_valid), ys_valid)

    # ── Build expression time series — fully vectorised ───────────────────
    # yield_df columns are (country, tenor) MultiIndex; values in %.
    # Express all levels in bps: yield legs × 100, ASW legs in bps already.
    yield_bps = yield_df * 100.0   # shape (n_days, n_yield_cols)

    # Pre-build an ASW bps DataFrame aligned to yield_df.index
    asw_bps = asw_df.reindex(yield_df.index, method="ffill") if not asw_df.empty else pd.DataFrame(index=yield_df.index)

    expr_series: dict[str, pd.Series] = {}
    for label, group, legs in ALL_EXPRESSIONS:
        s = pd.Series(0.0, index=yield_df.index, dtype=float)
        valid = True
        for country, tenor, weight in legs:
            if country.endswith("_ASW"):
                base = country.replace("_ASW", "")
                col  = (base, tenor)
                if col not in asw_bps.columns:
                    valid = False; break
                s = s + weight * asw_bps[col]
            else:
                col = (country, tenor)
                if col not in yield_bps.columns:
                    valid = False; break
                s = s + weight * yield_bps[col]
        if valid:
            expr_series[label] = s.rename(label)
        else:
            expr_series[label] = pd.Series(np.nan, index=yield_df.index, name=label)

    # ── Beta explanatory variables ─────────────────────────────────────────
    def _safe_series(ca, ta, wa, cb=None, tb=None, wb=None):
        s = yield_df.get((ca, ta))
        if s is None:
            return pd.Series(np.nan, index=yield_df.index)
        result = s * wa * 100.0
        if cb is not None:
            sb = yield_df.get((cb, tb))
            if sb is not None:
                result = result + sb * wb * 100.0
        return result

    bund10y_s   = _safe_series("Bund", 10, +1)
    spread10y_s = _safe_series("OAT",  10, +1, "Bund", 10, -1)
    slope_s     = _safe_series("Bund", 10, +1, "Bund",  2, -1)

    beta_df = pd.DataFrame({
        "bund10y":   bund10y_s,
        "spread10y": spread10y_s,
        "slope":     slope_s,
        "vol1m10y":  vol_s,
    }, index=yield_df.index).dropna()

    # ── RV + carry + beta ─────────────────────────────────────────────────
    rv_monitor   = []
    beta_monitor = []
    series_out   = {}

    for label, group, legs in ALL_EXPRESSIONS:
        series = expr_series[label].dropna()
        if len(series) < 10:
            continue

        # Check all required legs have data
        is_asw_expr = all(c.endswith("_ASW") for c, _, _ in legs)
        if is_asw_expr and asw_df.empty:
            continue
        yield_countries = [c for c, _, _ in legs if not c.endswith("_ASW")]
        if not all(c in splines for c in yield_countries):
            continue

        current = float(series.iloc[-1])
        ns = len(series)
        d1d = round(float(series.iloc[-1] - series.iloc[-2]),  2) if ns >= 2  else None
        d1w = round(float(series.iloc[-1] - series.iloc[-6]),  2) if ns >= 6  else None
        d1m = round(float(series.iloc[-1] - series.iloc[-22]), 2) if ns >= 22 else None

        window  = series.iloc[-win_1y:]
        mean_1y = float(window.mean())
        std_1y  = float(window.std())
        zscore  = round((current - mean_1y) / std_1y, 2) if std_1y > 0 else 0.0
        pctile  = round(float(stats.percentileofscore(window.values, current)), 1)

        daily_ch_3m = series.diff().iloc[-win_3m:]
        vol3m = round(float(daily_ch_3m.std()) * (252 ** 0.5), 2)

        # Carry — split into income carry and roll components
        income_carry, roll_bps = 0.0, 0.0
        try:
            income_carry, roll_bps = _expression_carry_components(
                legs, splines, latest_asw, latest_repo
            )
            income_carry = round(income_carry, 2)
            roll_bps     = round(roll_bps, 2)
        except Exception:
            pass
        carry = round(income_carry + roll_bps, 2)
        carry_vol_ratio = round(carry / vol3m, 2) if vol3m > 0 else None

        repo_sens = _repo_sensitivity(legs, splines)

        rv_monitor.append({
            "label":             label,
            "group":             group,
            "value_bps":         round(current, 2),
            "d1d_bps":           d1d,
            "d1w_bps":           d1w,
            "d1m_bps":           d1m,
            "zscore_1y":         zscore,
            "pctile_1y":         pctile,
            "vol3m_bps":         vol3m,
            "carry1y_bps":       carry,
            "income_carry_bps":  income_carry,
            "roll_bps":          roll_bps,
            "carry_vol_ratio":   carry_vol_ratio,
            "bund_repo_sens":    repo_sens["Bund"],
            "oat_repo_sens":     repo_sens["OAT"],
            "btp_repo_sens":     repo_sens["BTP"],
            "bonos_repo_sens":   repo_sens["Bonos"],
        })

        # 1y time series
        window1y = series.iloc[-win_1y:]
        series_out[label] = [
            {"date": d.strftime("%Y-%m-%d"), "value": round(float(v), 2)}
            for d, v in zip(window1y.index, window1y.values)
        ]

        # Beta regression
        y_full  = series.diff().dropna()
        common  = y_full.index.intersection(beta_df.index)
        if len(common) < 30:
            continue
        y  = y_full.loc[common].values
        Xr = beta_df.loc[common].values
        X  = np.hstack([np.ones((len(y), 1)), Xr])
        coeffs, _, _, _ = np.linalg.lstsq(X, y, rcond=None)
        y_hat  = X @ coeffs
        resid  = y - y_hat
        ss_res = float(np.sum(resid ** 2))
        ss_tot = float(np.sum((y - y.mean()) ** 2))
        r2     = round(1.0 - ss_res / ss_tot, 3) if ss_tot > 0 else 0.0
        cum_r  = np.cumsum(resid)
        cr_std = float(cum_r.std())
        res_z  = round((float(cum_r[-1]) - float(cum_r.mean())) / cr_std, 2) if cr_std > 0 else 0.0

        beta_monitor.append({
            "label":             label,
            "group":             group,
            "beta_bund10y":      round(float(coeffs[1]), 3),
            "beta_spread10y":    round(float(coeffs[2]), 3),
            "beta_slope":        round(float(coeffs[3]), 3),
            "beta_vol1m10y":     round(float(coeffs[4]), 3),
            "r2":                r2,
            "residual_zscore":   res_z,
        })

    return {
        "as_of":        as_of,
        "min_date":     min_date,
        "max_date":     max_date,
        "data_source":  data_source,
        "rv_monitor":   rv_monitor,
        "beta_monitor": beta_monitor,
        "series":       series_out,
        "groups":       GROUP_META,
    }
