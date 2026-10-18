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

ASW levels are a proxy when live: BVAL yield minus the €STR OIS par rate at
the same tenor, in bps (cheap = positive). That is a spread to OIS, not a
par-par asset swap; Bloomberg's ASW index tickers return nothing on our Terminal.

Bloomberg tickers (checked on the Terminal 2026-10-19):
  Yields      : BVAL constant-maturity curves, BV{TT}{curve} BVLI Index, curve ids in
                BVAL_CURVES (e.g. BV100910 = Bund 10y). Fitted daily from the issuer's
                bonds, so unlike the generic G…YR tickers they don't jump when the
                benchmark bond changes, and they quote every tenor (1y–30y).
  ESTR        : ESTRON Index
  €STR OIS    : EESWE{T} Curncy
  EUR 1m10y vol: ENPS0A10 ICPL Curncy

Live data only when ANALYTICS_DATA_SOURCE=bloomberg; otherwise simulated.
Series that return nothing (or stop updating) are dropped and listed in the
payload's missing_series.
"""

import functools
import threading
import time
import warnings
from typing import Optional

import numpy as np
import pandas as pd
from scipy import stats
from scipy.interpolate import CubicSpline

from egb_expressions_config import (
    ALL_EXPRESSIONS, GROUP_META,
    REPO_BLOC, REPO_BLOCS, COUNTRY_TENORS, CURVE_TENORS, _lbl,
)
from egb_bond_finder import build_egb_bond_map
from settings import settings
# The detail view reuses Swaps RV's statistics so both tools report them the same way
from swaps_rv import (
    _BT_WINDOWS, _PC_NAMES, _bt_stats, _curve_factors, _ols, _policy_meetings,
    _residual_zscore, _row_rank_corr, _zscore,
)

# ─── Constants ────────────────────────────────────────────────────────────────

ALL_TENORS = [2, 5, 7, 10, 15, 20, 30]   # union of all benchmark tenors

# ─── Bloomberg ticker maps ────────────────────────────────────────────────────

# Bloomberg BVAL sovereign yield curve ids (EUR government bond curves)
BVAL_CURVES: dict[str, str] = {
    "Bund": "0910", "OAT": "0915", "BTP": "0905", "Bonos": "0902", "Belgium": "0900",
    "Portugal": "0917", "Netherlands": "0920", "Austria": "0908", "Finland": "0919",
}

_YIELD_TICKERS: dict[str, dict[int, str]] = {
    c: {t: f"BV{t:02d}{BVAL_CURVES[c]} BVLI Index" for t in CURVE_TENORS[c]} for c in COUNTRY_TENORS
}

_ESTR_TICKER = "ESTRON Index"

# ASW proxy legs: yield − €STR OIS at the same tenor (see module docstring)
_ASW_TENORS: dict[str, list[int]] = {
    "Bund":        [2, 5, 10, 30],
    "OAT":         [2, 5, 10, 30],
    "BTP":         [5, 10, 30],
    "Bonos":       [5, 10],
    "Belgium":     [10],
    "Netherlands": [10],
}
_OIS_TICKERS: dict[int, str] = {
    t: f"EESWE{t} Curncy" for t in sorted({t for ts in _ASW_TENORS.values() for t in ts})
}

# EUR 1m10y ATM normal swaption vol (bps); ICAP source, as in swaps_rv
_VOL_TICKER = "ENPS0A10 ICPL Curncy"

_LIVE_YEARS = 6
_STALE_DAYS = 7   # a series whose last print is older than this vs the yields is dropped

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


BETA_FACTORS = ["Bund 10y", "OAT-Bund 10y", "Bund 2s10s", "1m10y vol"]


def _beta_factors(yield_df: pd.DataFrame, vol_s: pd.Series) -> pd.DataFrame:
    """The Beta Monitor's explanatory variables as levels in bp, on the yield dates."""
    def col(c: str, t: int) -> pd.Series:
        return yield_df[(c, t)] * 100.0 if (c, t) in yield_df.columns else pd.Series(np.nan, index=yield_df.index)
    return pd.DataFrame({
        "Bund 10y":     col("Bund", 10),
        "OAT-Bund 10y": col("OAT", 10) - col("Bund", 10),
        "Bund 2s10s":   col("Bund", 10) - col("Bund", 2),
        "1m10y vol":    vol_s.reindex(yield_df.index),
    }, index=yield_df.index)


def _non_self_factors(y: np.ndarray, X: np.ndarray) -> np.ndarray:
    """Mask of the factors that are not the expression itself. OAT-Bund 10y and Bund
    2s10s are both regressors and expressions; regressed on themselves they score
    R² = 1 and say nothing, so a factor whose daily changes match the expression's
    (|corr| > 0.999) is left out and the others explain what is left."""
    keep = np.ones(X.shape[1], dtype=bool)
    if np.std(y) > 0:
        for j in range(X.shape[1]):
            if np.std(X[:, j]) > 0 and abs(np.corrcoef(y, X[:, j])[0, 1]) > 0.999:
                keep[j] = False
    return keep


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

def _field_frame(raw: Optional[pd.DataFrame], field: str) -> pd.DataFrame:
    """bdh output as one column per ticker for `field`; empty frame when nothing came back."""
    if raw is None or raw.empty:
        return pd.DataFrame()
    df = raw.xs(field, axis=1, level=1) if isinstance(raw.columns, pd.MultiIndex) else raw
    df = df.copy()
    df.index = pd.to_datetime(df.index)
    return df.sort_index()


def _live_series(df: pd.DataFrame, tickers: list[str], last: pd.Timestamp,
                 missing: list[str]) -> dict[str, pd.Series]:
    """Tickers with a print within _STALE_DAYS of `last`; the others are appended to `missing`."""
    out = {}
    for t in tickers:
        s = df[t].dropna() if t in df.columns else pd.Series(dtype=float)
        if s.empty or s.index.max() < last - pd.Timedelta(days=_STALE_DAYS):
            missing.append(t)
        else:
            out[t] = s
    return out


def _fetch_from_bbg(start: str, end: str, use_individual_bonds: bool = False):
    """
    Fetch EGB yields (all 9 countries), ESTR, €STR OIS and EUR 1m10y vol from Bloomberg.
    Returns (yield_df, estr_s, asw_df, vol_s, bond_map, missing) or None when no
    yields come back.

    yield_df : DatetimeIndex, MultiIndex columns (country, tenor), values in %
    estr_s   : Series, ESTR in %
    asw_df   : DatetimeIndex, MultiIndex columns (country, tenor), values in bps
               (yield − OIS proxy)
    vol_s    : Series, 1m10y vol in bps normal
    missing  : tickers that returned nothing or went stale, sorted
    """
    try:
        from bbg import blp
    except ImportError:
        return None

    try:
        # ── Yields ────────────────────────────────────────────────────────────
        bond_map: dict = {}
        yield_ticker_map: dict[str, tuple[str, int]] = {}

        if use_individual_bonds:
            bond_map = build_egb_bond_map(COUNTRY_TENORS, as_of_date=end)
            for country, tenor_map in bond_map.items():
                for tenor, info in tenor_map.items():
                    if info is not None:
                        yield_ticker_map[info["ticker"]] = (country, tenor)
            bbg_yield_field = "YLD_YTM_MID"
        else:
            for country, tmap in _YIELD_TICKERS.items():
                for tenor, ticker in tmap.items():
                    yield_ticker_map[ticker] = (country, tenor)
            bbg_yield_field = "PX_LAST"

        if not yield_ticker_map:
            warnings.warn("[egb_rv] yield_ticker_map is empty — no bonds found")
            return None

        missing: list[str] = []
        raw_y = _field_frame(blp.bdh(list(yield_ticker_map), bbg_yield_field, start, end), bbg_yield_field)
        if raw_y.empty:
            warnings.warn("[egb_rv] No yield data from BBG")
            return None
        live_y = _live_series(raw_y, list(yield_ticker_map), raw_y.index.max(), missing)
        if not live_y:
            warnings.warn("[egb_rv] Every yield series is empty or stale")
            return None
        ydf = pd.DataFrame({yield_ticker_map[t]: s for t, s in live_y.items()}).sort_index().sort_index(axis=1)
        last = ydf.index.max()

        # ── ESTR, €STR OIS, vol: one request ─────────────────────────────────
        mkt_tickers = [_ESTR_TICKER, _VOL_TICKER, *_OIS_TICKERS.values()]
        raw_m = _field_frame(blp.bdh(mkt_tickers, "PX_LAST", start, end), "PX_LAST")
        live_m = _live_series(raw_m, mkt_tickers, last, missing) if not raw_m.empty else {}
        if raw_m.empty:
            missing.extend(mkt_tickers)

        def on_yield_dates(ticker: str) -> pd.Series:
            s = live_m.get(ticker)
            return s.reindex(ydf.index, method="ffill") if s is not None else pd.Series(np.nan, index=ydf.index)

        if _ESTR_TICKER in live_m:
            estr_s = on_yield_dates(_ESTR_TICKER)
        else:
            warnings.warn("[egb_rv] No ESTR data; defaulting to 0%")
            estr_s = pd.Series(0.0, index=ydf.index)
        vol_s = on_yield_dates(_VOL_TICKER)

        # ── ASW proxy: yield − €STR OIS, bps ─────────────────────────────────
        asw_cols = {}
        for country, tenors in _ASW_TENORS.items():
            for tenor in tenors:
                ois = _OIS_TICKERS[tenor]
                if (country, tenor) in ydf.columns and ois in live_m:
                    asw_cols[(country, tenor)] = (ydf[(country, tenor)] - on_yield_dates(ois)) * 100.0
        asw_df = pd.DataFrame(asw_cols, index=ydf.index) if asw_cols else pd.DataFrame(index=ydf.index)

        return ydf, estr_s, asw_df, vol_s, bond_map, sorted(set(missing))

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

# Six years of ~70 tickers is one slow pull, so live data are cached in-process
# (as in swaps_rv): the full fetch happens once; after that a refresh or an
# expired entry refetches only the last _TOPUP_DAYS and splices them on.
_BBG_CACHE_TTL_S = 15 * 60
_TOPUP_DAYS = 14
_bbg_cache: dict[bool, tuple[float, tuple]] = {}   # use_individual_bonds -> (fetched_at, frames)
_bbg_lock = threading.Lock()


def _splice(old: tuple, new: tuple) -> tuple:
    """Replace the overlapping tail of each cached frame with the freshly fetched rows."""
    cut = new[0].index.min()
    frames = tuple(pd.concat([o.loc[o.index < cut], n]) for o, n in zip(old[:4], new[:4]))
    return frames + new[4:]


def _load_bbg(use_individual_bonds: bool, refresh: bool = False) -> Optional[tuple]:
    """Live frames for the last _LIVE_YEARS to today, from the cache when fresh."""
    with _bbg_lock:   # concurrent requests share a single fetch
        hit = _bbg_cache.get(use_individual_bonds)
        if hit and not refresh and time.monotonic() - hit[0] < _BBG_CACHE_TTL_S:
            return hit[1]
        end = pd.Timestamp.today()
        if hit:
            new = _fetch_from_bbg((end - pd.Timedelta(days=_TOPUP_DAYS)).strftime("%Y-%m-%d"),
                                  end.strftime("%Y-%m-%d"), use_individual_bonds)
            if new is None:
                return hit[1]   # Bloomberg hiccup: keep serving the cached history
            # Only splice like-for-like; if a series appeared or dropped out, refetch in full
            if all(list(n.columns) == list(o.columns) for n, o in ((new[0], hit[1][0]), (new[2], hit[1][2]))) \
                    and new[5] == hit[1][5]:
                _bbg_cache[use_individual_bonds] = (time.monotonic(), _splice(hit[1], new))
                return _bbg_cache[use_individual_bonds][1]
        result = _fetch_from_bbg((end - pd.DateOffset(years=_LIVE_YEARS)).strftime("%Y-%m-%d"),
                                 end.strftime("%Y-%m-%d"), use_individual_bonds)
        if result is None:
            return hit[1] if hit else None
        _bbg_cache[use_individual_bonds] = (time.monotonic(), result)
        return result


@functools.lru_cache(maxsize=1)
def _simulated() -> tuple:
    """The simulated frames, built once: deterministic, and the backtest cache keys on their identity."""
    return _simulate_data()


def _raw_frames(use_individual_bonds: bool, refresh: bool = False) -> tuple[tuple, dict]:
    """(yield_df, estr_s, asw_df, vol_s) for the whole history, plus where they came from.
    The tuple is the cached object itself, so its identity changes only when the data do."""
    live = _load_bbg(use_individual_bonds, refresh) if settings.data_source == "bloomberg" else None
    if live is not None:
        return live[:4], {
            "data_source": "bloomberg",
            "yield_mode": "individual_bonds" if use_individual_bonds else "bval",
            "bond_map": live[4], "missing_series": live[5],
        }
    return _simulated(), {"data_source": "simulation", "yield_mode": "simulation",
                          "bond_map": {}, "missing_series": []}


def _aligned(raw: tuple, as_of_date: Optional[str] = None) -> tuple:
    """Frames on the yield dates, cut at the as-of date."""
    yield_df, estr_s, asw_df, vol_s = raw
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
    return yield_df, estr_s, asw_df, vol_s


def _latest_asw(asw_df: pd.DataFrame) -> dict[tuple, float]:
    if asw_df.empty:
        return {}
    last = asw_df.iloc[-1]
    return {tuple(c): float(v) for c, v in last.items() if not np.isnan(v)}


def _splines_at(yield_row: pd.Series) -> dict[str, CubicSpline]:
    """One cubic spline per country through that day's yields (countries with ≥3 tenors)."""
    splines: dict[str, CubicSpline] = {}
    for country, tenors in CURVE_TENORS.items():
        ys = np.array([float(yield_row.get((country, t), np.nan)) for t in tenors])
        valid = ~np.isnan(ys)
        if valid.sum() >= 3:
            splines[country] = _build_spline(list(np.array(tenors)[valid]), ys[valid])
    return splines


def _compute_egb_rv(as_of_date: Optional[str] = None, use_individual_bonds: bool = False,
                    refresh: bool = False) -> dict:
    """
    Compute EGB RV monitor for Bund, OAT, BTP, Bonos, Belgium, Portugal,
    Netherlands, Austria, Finland.

    Returns:
      as_of, min_date, max_date, data_source,
      rv_monitor   : list of RV rows (level, changes, z-score, pctile, vol, carry, repo sensitivities)
      beta_monitor : list of beta regression rows
      series       : full daily history per expression, as (dates, values) arrays
      groups       : group metadata for display
    """
    raw, meta = _raw_frames(use_individual_bonds, refresh)
    yield_df, estr_s, asw_df, vol_s = _aligned(raw, as_of_date)
    data_source, yield_mode = meta["data_source"], meta["yield_mode"]
    bond_map, missing_series = meta["bond_map"], meta["missing_series"]

    min_date = yield_df.index[0].strftime("%Y-%m-%d")
    max_date = yield_df.index[-1].strftime("%Y-%m-%d")
    as_of    = max_date

    n = len(yield_df)
    win_1y  = min(252, n)
    win_3m  = min(63, n)

    # ── Build cubic splines for the as-of date (for carry) ───────────────
    latest_repo = float(estr_s.iloc[-1])
    latest_asw  = _latest_asw(asw_df)
    splines     = _splines_at(yield_df.iloc[-1])

    # ── Build expression time series — one matrix product ─────────────────
    # Stack yield legs (bps) and ASW legs (bps) into one panel M (n_days × n_cols);
    # every expression is a weighted sum of panel columns, so S = M @ W.
    asw_bps = asw_df.reindex(yield_df.index, method="ffill") if not asw_df.empty else pd.DataFrame(index=yield_df.index)
    col_keys = [("Y",) + tuple(c) for c in yield_df.columns] + [("A",) + tuple(c) for c in asw_bps.columns]
    col_pos  = {k: i for i, k in enumerate(col_keys)}
    M = np.hstack([
        yield_df.to_numpy(dtype=float) * 100.0,
        asw_bps.to_numpy(dtype=float) if len(asw_bps.columns) else np.empty((n, 0)),
    ])

    exprs: list[tuple[str, str, list]] = []
    W_rows: list[list[tuple[int, float]]] = []
    for label, group, legs in ALL_EXPRESSIONS:
        terms = []
        for country, tenor, weight in legs:
            key = ("A", country[:-4], tenor) if country.endswith("_ASW") else ("Y", country, tenor)
            if key not in col_pos:
                terms = None
                break
            terms.append((col_pos[key], float(weight)))
        if terms:
            exprs.append((label, group, legs))
            W_rows.append(terms)

    W = np.zeros((M.shape[1], len(exprs)))
    used = np.zeros((M.shape[1], len(exprs)), dtype=bool)
    for j, terms in enumerate(W_rows):
        for i, w in terms:
            W[i, j] += w
            used[i, j] = True
    nan_M = np.isnan(M)
    S = np.nan_to_num(M) @ W
    S[(nan_M.astype(np.int32) @ used.astype(np.int32)) > 0] = np.nan   # any NaN leg → NaN

    # ── Beta explanatory variables (levels in bp; regressions use their daily changes)
    beta_X = _beta_factors(yield_df, vol_s).to_numpy(dtype=float)

    # ── RV + carry + beta ─────────────────────────────────────────────────
    rv_monitor   = []
    beta_monitor = []
    series_out: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    dates_str = np.array(yield_df.index.strftime("%Y-%m-%d"))

    for j, (label, group, legs) in enumerate(exprs):
        col_s = S[:, j]
        pos   = np.flatnonzero(~np.isnan(col_s))
        v     = col_s[pos]
        ns    = len(v)
        if ns < 10:
            continue

        # Check all required legs have data
        is_asw_expr = all(c.endswith("_ASW") for c, _, _ in legs)
        if is_asw_expr and asw_df.empty:
            continue
        yield_countries = [c for c, _, _ in legs if not c.endswith("_ASW")]
        if not all(c in splines for c in yield_countries):
            continue

        current = float(v[-1])
        d1d = round(float(v[-1] - v[-2]),  2) if ns >= 2  else None
        d1w = round(float(v[-1] - v[-6]),  2) if ns >= 6  else None
        d1m = round(float(v[-1] - v[-22]), 2) if ns >= 22 else None

        window  = v[-win_1y:]
        mean_1y = float(window.mean())
        std_1y  = float(window.std(ddof=1)) if len(window) > 1 else 0.0
        zscore  = round((current - mean_1y) / std_1y, 2) if std_1y > 0 else 0.0
        # scipy.stats.percentileofscore(kind="rank")
        left    = int((window < current).sum())
        right   = int((window <= current).sum())
        pctile  = round((left + right + (1 if right > left else 0)) * 50.0 / len(window), 1)

        dv = np.diff(v)
        daily_ch_3m = dv[-win_3m:]
        vol3m = round(float(daily_ch_3m.std(ddof=1)) * (252 ** 0.5), 2) if len(daily_ch_3m) > 1 else 0.0

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
            "legs":              [{"country": c, "tenor": t, "weight": w} for c, t, w in legs],
        })

        # Full history — kept as arrays; serialised only when requested
        series_out[label] = (dates_str[pos], np.round(v, 2))

        # Beta regression: daily changes on the factors' daily changes over the same days
        # (the series' own valid dates), last 1y — the regression the detail view expands
        dX  = beta_X[pos[1:]] - beta_X[pos[:-1]]
        sel = ~np.isnan(dX).any(axis=1)
        y, Xc = dv[sel][-win_1y:], dX[sel][-win_1y:]
        if len(y) < 30:
            continue
        keep = _non_self_factors(y, Xc)
        coeffs, resid, r2 = _ols(y, Xc[:, keep])
        betas = dict(zip(np.flatnonzero(keep), coeffs[1:]))   # factor index -> β; the expression's own factor has none

        def beta(j: int) -> Optional[float]:
            return round(float(betas[j]), 3) if j in betas else None

        beta_monitor.append({
            "label":             label,
            "group":             group,
            "beta_bund10y":      beta(0),
            "beta_spread10y":    beta(1),
            "beta_slope":        beta(2),
            "beta_vol1m10y":     beta(3),
            "r2":                round(r2, 3),
            "residual_zscore":   round(_residual_zscore(resid), 2),
        })

    return {
        "as_of":        as_of,
        "min_date":     min_date,
        "max_date":     max_date,
        "data_source":  data_source,
        "yield_mode":   yield_mode,
        "missing_series": missing_series,
        "bond_map":     bond_map,
        "rv_monitor":   rv_monitor,
        "beta_monitor": beta_monitor,
        "series":       series_out,
        "groups":       GROUP_META,
        "policy_meetings": _policy_meetings("EUR", min_date, as_of),
    }


# ─── Cached public API ────────────────────────────────────────────────────────
#
# A full run is ~1k expressions over ~6y of history (plus several BBG requests
# when live), so results are cached per (as_of_date, use_individual_bonds).
# The monitor payload omits per-expression series; the detail view fetches the
# one it needs via get_egb_series(), served from the same cache entry.

_CACHE_TTL_S = 15 * 60
_cache: dict[tuple, tuple[float, dict]] = {}
_cache_lock = threading.Lock()


def _cached_result(as_of_date: Optional[str], use_individual_bonds: bool, refresh: bool = False) -> dict:
    key = (as_of_date or None, bool(use_individual_bonds))
    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and not refresh and now - hit[0] < _CACHE_TTL_S:
            return hit[1]
        result = _compute_egb_rv(as_of_date=as_of_date, use_individual_bonds=use_individual_bonds,
                                 refresh=refresh)
        _cache[key] = (now, result)
        return result


def warm_cache() -> None:
    """Fetch and compute the BVAL-curve monitor once (startup) so the first visitor doesn't wait."""
    if settings.data_source != "bloomberg":
        return
    compute_egb_rv()


def compute_egb_rv(
    as_of_date: Optional[str] = None,
    use_individual_bonds: bool = False,
    refresh: bool = False,
) -> dict:
    """Monitor payload (everything except per-expression series). See _compute_egb_rv."""
    result = _cached_result(as_of_date, use_individual_bonds, refresh)
    return {k: v for k, v in result.items() if k != "series"}


def get_egb_series(
    label: str,
    as_of_date: Optional[str] = None,
    use_individual_bonds: bool = False,
) -> list[dict]:
    """Full daily history for one expression: [{date, value}, ...]."""
    result = _cached_result(as_of_date, use_individual_bonds)
    if label not in result["series"]:
        raise KeyError(label)
    dates, values = result["series"][label]
    return [{"date": d, "value": float(v)} for d, v in zip(dates, values)]


# ─── Detail view: one expression ──────────────────────────────────────────────
#
# Same analyses as the Swaps RV detail page, on bond yields: the Beta Monitor
# regression in full, a factor-neutral version, the curve roll-down behind the
# carry, and a backtest of how much predicted roll-down was delivered. Payloads
# match the Swaps RV ones so the page reuses its components.

_EXPRESSIONS = {label: (group, legs) for label, group, legs in ALL_EXPRESSIONS}


def _expression(label: str) -> tuple[str, list]:
    try:
        return _EXPRESSIONS[label]
    except KeyError:
        raise KeyError(f"Unknown expression: {label}") from None


def _leg_label(country: str, tenor: int) -> str:
    if country.endswith("_ASW"):
        return f"{_lbl(country[:-4])} ASW {tenor}y"
    return f"{_lbl(country)} {tenor}y"


def _leg_series(country: str, tenor: int, yield_df: pd.DataFrame, asw_df: pd.DataFrame) -> pd.Series:
    """One leg in bp: the yield × 100, or the ASW level."""
    if country.endswith("_ASW"):
        key = (country[:-4], tenor)
        if asw_df.empty or key not in asw_df.columns:
            raise KeyError(f"No data for {_leg_label(country, tenor)}")
        return asw_df[key].astype(float)
    if (country, tenor) not in yield_df.columns:
        raise KeyError(f"No data for {_leg_label(country, tenor)}")
    return yield_df[(country, tenor)].astype(float) * 100.0


def _detail_frames(label: str, as_of_date: Optional[str], use_individual_bonds: bool):
    """(group, legs, aligned frames, leg series in bp, meta) for one expression."""
    group, legs = _expression(label)
    raw, meta = _raw_frames(use_individual_bonds)
    frames = _aligned(raw, as_of_date)
    return group, legs, frames, [_leg_series(c, t, frames[0], frames[2]) for c, t, _ in legs], meta


def _leg_repo(country: str, estr_pct: float, repo_spreads_bp: Optional[dict[str, float]]) -> float:
    """Repo (%) for a leg: €STR plus the user's spread for the country's repo bloc, as the
    page applies it to the monitor's carry."""
    bloc = REPO_BLOC.get(country)
    return estr_pct + (repo_spreads_bp or {}).get(bloc, 0.0) / 100.0


def _combine(weights, leg_s: list[pd.Series]) -> pd.Series:
    return sum(w * s for w, s in zip(weights, leg_s)).dropna()


def compute_regression(label: str, as_of_date: Optional[str] = None, use_individual_bonds: bool = False,
                       window: int = 63) -> dict:
    """
    The Beta Monitor regression for one expression, in detail: coefficients with standard
    errors, t-stats and VIFs on the 1y window; rolling-window betas over the full history;
    daily and cumulative residuals; and the 1y move attributed to each factor.
    """
    group, legs, (yield_df, _, _, vol_s), leg_s, meta = _detail_frames(label, as_of_date, use_individual_bonds)
    series = _combine([w for _, _, w in legs], leg_s)
    changes = _beta_factors(yield_df, vol_s).reindex(series.index).diff()
    y_full = series.diff()
    ok = y_full.notna() & changes.notna().all(axis=1)
    y_full, changes = y_full[ok], changes[ok]
    common_all = y_full.index
    common = common_all[-min(252, len(yield_df)):]   # same 1y window as the Beta Monitor
    if len(common) < 30:
        raise KeyError(f"Not enough history to regress {label}")
    keep = _non_self_factors(y_full.loc[common].values, changes.loc[common, BETA_FACTORS].values)
    factors = [f for f, k in zip(BETA_FACTORS, keep) if k]
    excluded = [f for f, k in zip(BETA_FACTORS, keep) if not k]

    y = y_full.loc[common].values
    Xf = changes.loc[common, factors].values
    coeffs, resid, r2 = _ols(y, Xf)
    n, k = len(y), len(factors)

    # Classical OLS standard errors
    X = np.hstack([np.ones((n, 1)), Xf])
    dof = max(n - k - 1, 1)
    sigma2 = float(resid @ resid) / dof
    se = np.sqrt(np.diag(sigma2 * np.linalg.pinv(X.T @ X)))
    tstat = np.divide(coeffs, se, out=np.zeros_like(coeffs), where=se > 0)

    # VIF: how well each factor is explained by the others (1 = independent)
    vif = []
    for j in range(k):
        _, _, r2_j = _ols(Xf[:, j], np.delete(Xf, j, axis=1))
        vif.append(1.0 / (1.0 - r2_j) if r2_j < 1 else float("inf"))

    factor_vol = Xf.std(axis=0, ddof=1)
    factor_rows = [{
        "name": f,
        "beta": round(float(coeffs[j + 1]), 4),
        "se": round(float(se[j + 1]), 4),
        "t": round(float(tstat[j + 1]), 2),
        "factor_vol_bp": round(float(factor_vol[j]), 3),
        "beta_x_vol_bp": round(float(coeffs[j + 1] * factor_vol[j]), 3),
        "vif": round(float(vif[j]), 2),
    } for j, f in enumerate(factors)]

    fitted = X @ coeffs
    cum = np.cumsum(resid)
    dates = [d.strftime("%Y-%m-%d") for d in common]
    residuals = [{
        "date": d, "actual": round(float(a), 3), "fitted": round(float(f), 3),
        "resid": round(float(e), 3), "cum": round(float(c), 3),
    } for d, a, f, e, c in zip(dates, y, fitted, resid, cum)]

    # Attribution: cumulative move = Σ β·ΔX per factor + intercept drift + residual (exact)
    cum_contrib = np.cumsum(Xf * coeffs[1:], axis=0)
    cum_actual = np.cumsum(y)
    attribution = []
    for i, d in enumerate(dates):
        row = {"date": d, "actual": round(float(cum_actual[i]), 3),
               "intercept": round(float(coeffs[0] * (i + 1)), 3), "residual": round(float(cum[i]), 3)}
        row.update({f: round(float(cum_contrib[i, j]), 3) for j, f in enumerate(factors)})
        attribution.append(row)

    # Rolling-window betas across the full history
    y_all = y_full.values
    X_all = changes[factors].values
    rolling = []
    for end in range(window, len(y_all) + 1):
        c_w, _, r2_w = _ols(y_all[end - window:end], X_all[end - window:end])
        row = {"date": common_all[end - 1].strftime("%Y-%m-%d"), "r2": round(r2_w, 3)}
        row.update({f: round(float(c_w[j + 1]), 4) for j, f in enumerate(factors)})
        rolling.append(row)

    return {
        "label": label,
        "group": group,
        "as_of": yield_df.index[-1].strftime("%Y-%m-%d"),
        "data_source": meta["data_source"],
        "factors": factor_rows,
        "excluded_factors": excluded,   # the expression itself, when it is one of the factors
        "intercept": {"beta": round(float(coeffs[0]), 4), "se": round(float(se[0]), 4), "t": round(float(tstat[0]), 2)},
        "n_obs": n,
        "r2": round(r2, 3),
        "adj_r2": round(1 - (1 - r2) * (n - 1) / dof, 3),
        "resid_vol_bp": round(float(np.sqrt(sigma2)), 3),
        "residual_zscore": round(_residual_zscore(resid), 2),
        "cum_resid_mean": round(float(cum.mean()), 3),
        "cum_resid_std": round(float(cum.std()), 3),
        "rolling_window": window,
        "rolling": rolling,
        "residuals": residuals,
        "attribution": attribution,
    }


# Factor-neutral weights. The factors are the first three principal components of
# daily Bund curve changes (2y–30y) over the last year: level, slope, curvature. A
# leg's exposure is its regression on the standardised PC scores (bp per 1σ day), so
# legs from any country are treated alike. Kept legs hold their weights and the
# hedge legs are re-solved: 2-leg spreads and curves become level-neutral; flies
# (belly kept) and boxes (first country's curve kept) become level- and slope-neutral.

def _neutral_plan(n_legs: int) -> Optional[tuple[list[int], list[int], int, str]]:
    """(kept legs, hedge legs, factors hedged, description) for an expression's shape."""
    if n_legs == 2:
        return [0], [1], 1, "First leg kept at its weight; second leg re-weighted so the expression has no level exposure."
    if n_legs == 3:
        return [1], [0, 2], 2, "Belly kept at 2; wings re-weighted so the fly has no level or slope exposure."
    if n_legs == 4:
        return [0, 1], [2, 3], 2, ("First curve kept; second curve's legs re-weighted so the box has no "
                                   "level or slope exposure.")
    return None


def _neutral_weights(weights: list[float], E: np.ndarray, plan) -> Optional[list[float]]:
    """Solve the hedge legs' weights so the hedged factor exposures are zero; None if they can't be."""
    kept, hedge, k, _ = plan
    M = E[:k][:, hedge]
    if np.linalg.cond(M) > 1e6:
        return None
    x = np.linalg.solve(M, -E[:k][:, kept] @ np.asarray([weights[i] for i in kept], float))
    out = list(map(float, weights))
    for i, w in zip(hedge, x):
        out[i] = float(w)
    return out


def compute_neutral(label: str, as_of_date: Optional[str] = None, use_individual_bonds: bool = False,
                    repo_spreads_bp: Optional[dict[str, float]] = None) -> dict:
    """One expression next to its factor-neutral version (see the comment above).
    repo_spreads_bp: {repo bloc: bp over €STR}, the page's repo assumptions, for the carry."""
    group, legs, (yield_df, estr_s, asw_df, _), leg_s, meta = _detail_frames(label, as_of_date, use_individual_bonds)
    plan = _neutral_plan(len(legs))
    if plan is None:
        raise KeyError(f"No factor-neutral version for {label}: it has a single leg")
    kept, hedge, k, rule = plan
    weights = [float(w) for _, _, w in legs]

    n = len(yield_df)
    win_1y, win_3m = min(252, n), min(63, n)
    bund = yield_df["Bund"].dropna(how="any")
    dates, scores, load, share = _curve_factors(bund, yield_df.index[-win_1y:])

    def exposure(s: pd.Series) -> np.ndarray:
        y = s.diff().reindex(dates).values
        ok = ~np.isnan(y)
        A = np.hstack([np.ones((int(ok.sum()), 1)), scores[ok]])
        return np.linalg.lstsq(A, y[ok], rcond=None)[0][1:]

    E = np.column_stack([exposure(s) for s in leg_s])
    neutral = _neutral_weights(weights, E, plan)

    splines = _splines_at(yield_df.iloc[-1])
    estr, latest = float(estr_s.iloc[-1]), _latest_asw(asw_df)
    leg_carry = []
    for c, t, _ in legs:
        ic, roll = _expression_carry_components([(c, t, 1)], splines, latest, _leg_repo(c, estr, repo_spreads_bp))
        leg_carry.append(ic + roll)

    def stats_of(w: list[float], s: pd.Series) -> dict:
        window = s.iloc[-win_1y:]
        e = E @ np.asarray(w, float)
        carry = float(np.dot(w, leg_carry))
        vol = float(s.diff().iloc[-win_3m:].std()) * 252 ** 0.5
        return {
            "value_bps": round(float(s.iloc[-1]), 2),
            "zscore_1y": round(_zscore(s, win_1y), 2),
            "pctile_1y": round(float(stats.percentileofscore(window.values, float(s.iloc[-1]))), 1),
            "vol3m_bps": round(vol, 2),
            "ivol_bps": None,          # no option vols on bonds
            "carry1y_bps": round(carry, 2),
            "carry_vol_ratio": round(carry / vol, 2) if vol > 0 else None,
            "carry_ivol_ratio": None,
            "exposure": {name: round(float(v), 3) for name, v in zip(_PC_NAMES, e)},
        }

    standard = _combine(weights, leg_s)
    neutral_s = _combine(neutral, leg_s) if neutral else None
    hist = pd.DataFrame({"standard": standard, "neutral": neutral_s}).dropna(subset=["standard"]).round(2)

    var = float(standard.diff().reindex(dates).var(ddof=1))
    e_std = E @ np.asarray(weights, float)
    unstable = None
    if neutral:
        unstable = any(not (0.25 <= neutral[i] / weights[i] <= 2.5) for i in hedge)

    return {
        "label": label,
        "group": "curve" if k == 1 else "fly",
        "rule": rule,
        "basis": "daily Bund yield changes (2y–30y)",
        "as_of": yield_df.index[-1].strftime("%Y-%m-%d"),
        "data_source": meta["data_source"],
        "window_days": len(dates),
        "hedged": list(_PC_NAMES[:k]),
        "factors": [{
            "name": name,
            "variance_share": round(float(share[i]), 4),
            "loadings": [{"tenor": int(t), "loading": round(float(v), 4)} for t, v in zip(bund.columns, load[i])],
        } for i, name in enumerate(_PC_NAMES)],
        "legs": [{
            "label": _leg_label(c, t),
            "weight": weights[i],
            "neutral_weight": round(neutral[i], 4) if neutral else None,
            "carry1y_bps": round(float(leg_carry[i]), 2),
            "exposure": {name: round(float(E[j, i]), 3) for j, name in enumerate(_PC_NAMES)},
        } for i, (c, t, _) in enumerate(legs)],
        "factor_share": round(min(float((e_std[:k] ** 2).sum()) / var, 1.0), 3) if var > 0 else 0.0,
        "unstable": unstable,
        "standard": stats_of(weights, standard),
        "neutral": stats_of(neutral, neutral_s) if neutral else None,
        "history": [{
            "date": d.strftime("%Y-%m-%d"),
            "standard": float(r.standard),
            "neutral": None if pd.isna(r.neutral) else float(r.neutral),
        } for d, r in hist.iterrows()],
    }


def compute_rolldown(label: str, as_of_date: Optional[str] = None, use_individual_bonds: bool = False,
                     repo_spreads_bp: Optional[dict[str, float]] = None) -> dict:
    """The curves behind one expression's carry: each leg's income carry and roll T → T−1
    along its country's spline on the as-of date, with those curves for the chart.
    repo_spreads_bp: {repo bloc: bp over €STR}, the page's repo assumptions."""
    group, legs, (yield_df, estr_s, asw_df, _), _, meta = _detail_frames(label, as_of_date, use_individual_bonds)
    row = yield_df.iloc[-1]
    splines = _splines_at(row)
    estr, latest = float(estr_s.iloc[-1]), _latest_asw(asw_df)

    out_legs, countries = [], []
    for c, t, w in legs:
        is_asw = c.endswith("_ASW")
        base = c[:-4] if is_asw else c
        if base not in splines:
            raise KeyError(f"No {base} curve on {row.name:%Y-%m-%d}")
        cs = splines[base]
        y, t1 = float(cs(t)), max(t - 1.0, 0.5)
        y1 = float(cs(t1))
        if is_asw:
            dur, repo, income = None, None, latest.get((base, t))
            if income is None:
                raise KeyError(f"No ASW level for {_leg_label(c, t)}")
        else:
            dur, repo = _modified_duration(t, y), _leg_repo(c, estr, repo_spreads_bp)
            income = (y - repo) / dur * 100.0
        roll = (y - y1) * 100.0
        out_legs.append({
            "label": _leg_label(c, t), "country": base, "kind": "asw" if is_asw else "yield",
            "tenor": t, "weight": w, "yield_pct": round(y, 4),
            "repo_pct": round(repo, 4) if repo is not None else None,
            "rolled_tenor": t1, "rolled_yield_pct": round(y1, 4), "duration": round(dur, 2) if dur else None,
            "income_bps": round(income, 2), "roll_bps": round(roll, 2),
            "contribution_bps": round(w * (income + roll), 2),
        })
        if base not in countries:
            countries.append(base)

    curves = [{
        "country": c,
        "label": _lbl(c),
        "quotes": [{"tenor": t, "yield_pct": round(float(row[(c, t)]), 4)}
                   for t in CURVE_TENORS[c] if (c, t) in row.index and not np.isnan(row[(c, t)])],
        "fitted": [{"tenor": float(x), "yield_pct": round(float(splines[c](x)), 4)} for x in np.arange(1.0, 30.5, 0.5)],
    } for c in countries]

    return {
        "label": label,
        "group": group,
        "as_of": row.name.strftime("%Y-%m-%d"),
        "data_source": meta["data_source"],
        "estr_pct": round(estr, 4),
        "legs": out_legs,
        "curves": curves,
        "carry1y_bps": round(sum(lg["contribution_bps"] for lg in out_legs), 2),
    }


# Roll-down realisation. For every past day t and yield expression: the roll-down an
# unchanged curve promised (each leg's yield at T minus that day's curve at T−1) and
# what holding it for a year delivered (yield at T on t minus the curve at T−1 a year
# later). Income carry is left out: it accrues whatever the curve does. ASW
# expressions are not covered. Computed for every day and expression at once and
# cached until the data change.

_bt_cache: dict[bool, tuple[tuple, dict]] = {}   # use_individual_bonds -> (raw frames, core)


def _bt_core(raw: tuple) -> dict:
    yield_df = _aligned(raw)[0]
    dates = yield_df.index
    targets = dates + pd.DateOffset(years=1)
    has_end = np.asarray(targets <= dates[-1])
    end_idx = np.clip(dates.searchsorted(targets, side="right") - 1, 0, len(dates) - 1)

    # Every country's curve on every day, read where each tenor rolls to (T−1)
    rolled: dict[tuple, np.ndarray] = {}
    for country, tenors in CURVE_TENORS.items():
        ts = [t for t in tenors if (country, t) in yield_df.columns]
        if len(ts) < 3:
            continue
        Y = yield_df[[(country, t) for t in ts]].to_numpy(dtype=float)
        ok = ~np.isnan(Y).any(axis=1)
        cs = CubicSpline(ts, Y[ok], axis=1, bc_type="not-a-knot", extrapolate=True)
        for t in ts:
            r = np.full(len(dates), np.nan)
            r[ok] = cs(max(t - 1.0, 0.5))
            rolled[(country, t)] = r

    labels, groups, carry_cols, real_cols = [], [], [], []
    for label, group, legs in ALL_EXPRESSIONS:
        if any((c, t) not in rolled for c, t, _ in legs):   # ASW legs and missing tenors
            continue
        carry = sum(w * (yield_df[(c, t)].to_numpy(float) - rolled[(c, t)]) for c, t, w in legs) * 100.0
        realised = sum(w * (yield_df[(c, t)].to_numpy(float) - rolled[(c, t)][end_idx]) for c, t, w in legs) * 100.0
        labels.append(label)
        groups.append(group)
        carry_cols.append(carry)
        real_cols.append(np.where(has_end, realised, np.nan))
    return {
        "dates": dates, "end_dates": dates[end_idx], "has_end": has_end,
        "labels": labels, "groups": groups,
        "carry": np.column_stack(carry_cols), "realised": np.column_stack(real_cols),
    }


def _finite_stats(carry: np.ndarray, realised: np.ndarray) -> Optional[dict]:
    ok = np.isfinite(carry) & np.isfinite(realised)
    return _bt_stats(carry[ok], realised[ok]) if ok.sum() >= 2 else None


def compute_carry_backtest(as_of_date: Optional[str] = None, label: Optional[str] = None,
                           window: str = "1y", use_individual_bonds: bool = False) -> dict:
    """
    How much of the predicted 1y roll-down was delivered, for holding periods ending in
    `window` before the as-of date: across all yield expressions and per expression; with
    `label`, only that expression's row plus its full predicted-vs-realised history.
    """
    if window not in _BT_WINDOWS:
        raise ValueError(f"window must be one of {list(_BT_WINDOWS)}")
    raw, meta = _raw_frames(use_individual_bonds)
    hit = _bt_cache.get(use_individual_bonds)
    if hit and hit[0] is raw:
        core = hit[1]
    else:
        core = _bt_core(raw)
        _bt_cache[use_individual_bonds] = (raw, core)

    labels = core["labels"]
    if label is not None and label not in labels:
        _expression(label)   # unknown label → KeyError naming it
        raise KeyError(f"No roll-down backtest for {label} (ASW expressions are not covered)")

    dates, end_dates = core["dates"], core["end_dates"]
    as_of = min(pd.Timestamp(as_of_date), dates[-1]) if as_of_date else dates[-1]
    known = core["has_end"] & np.asarray(end_dates <= as_of)
    span = _BT_WINDOWS[window]
    in_window = known & (np.asarray(end_dates > as_of - span) if span is not None else True)
    carry, realised = core["carry"][in_window], core["realised"][in_window]
    n_starts = int(in_window.sum())

    result: dict = {
        "as_of": as_of.strftime("%Y-%m-%d"),
        "data_source": meta["data_source"],
        "window": window,
        "n_starts": n_starts,
        "first_end": end_dates[in_window][0].strftime("%Y-%m-%d") if n_starts else None,
        "last_end": end_dates[in_window][-1].strftime("%Y-%m-%d") if n_starts else None,
        "summary": None,
        "structures": [],
    }
    if n_starts >= 2:
        pooled = _finite_stats(carry, realised)
        rows_ok = np.isfinite(carry).all(axis=1) & np.isfinite(realised).all(axis=1)
        if pooled and rows_ok.any():
            result["summary"] = {**pooled, "rank_corr": round(float(np.nanmean(
                _row_rank_corr(carry[rows_ok], realised[rows_ok]))), 3)}
        cols = [labels.index(label)] if label is not None else range(len(labels))
        for k in cols:
            st = _finite_stats(carry[:, k], realised[:, k])
            if st is None:
                continue
            result["structures"].append({
                "label": labels[k], "group": core["groups"][k],
                "avg_carry_bp": round(float(np.nanmean(carry[:, k])), 2),
                "avg_realised_bp": round(float(np.nanmean(realised[:, k])), 2),
                "hit_rate": st["hit_rate"], "delivered": st["delivered"], "slope": st["slope"],
            })

    if label is not None:
        k = labels.index(label)
        series = []
        for i in np.flatnonzero(np.asarray(dates <= as_of)):
            c = core["carry"][i, k]
            if np.isnan(c):
                continue
            r = core["realised"][i, k] if known[i] else np.nan
            done = not np.isnan(r)
            series.append({
                "start": dates[i].strftime("%Y-%m-%d"),
                "end": end_dates[i].strftime("%Y-%m-%d") if done else None,
                "carry": round(float(c), 2),
                "realised": round(float(r), 2) if done else None,
                "fwd_err": round(float(r - c), 2) if done else None,
            })
        result["series"] = series
    return result
