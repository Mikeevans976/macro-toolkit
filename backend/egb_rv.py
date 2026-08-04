"""
EGB RV Monitor — Bund and OAT relative value engine.

Carry methodology (yield expressions):
  leg_carry_bps = ((y_T − ESTR) / dur_T + roll_T) × 100
  where:
    y_T    = yield at tenor T in %
    ESTR   = ECB overnight rate (repo proxy) in %
    dur_T  = modified duration ≈ T × (1 − y_T / 200)  [rough par-bond approximation]
    roll_T = y(T) − y(T−1) from cubic spline [% per year; positive = upward-sloping curve]
  expression_carry = Σ weight_i × leg_carry_bps_i

For ASW expressions:
  carry_bps = ASW_level_bps + roll_bond_bps
  where roll_bond_bps = (y(T) − y(T−1)) × 100

Beta regression variables: Bund 10y, OAT−Bund 10y spread, Bund 2s10s slope, EUR 1m10y vol.

Bloomberg tickers (⚠️ verify ASW tickers before live use):
  Bund yields : GDBR{T} Index   (T = 2, 5, 7, 10, 15, 20, 30)
  OAT yields  : GFRN{T} Index
  ESTR        : ESTRON Index
  Bund ASW    : DASW{T} Index   ⚠️ verify
  OAT ASW     : FOASW{T} Index  ⚠️ verify
  EUR 1m10y vol: EUSV0001 Index
"""

import warnings
from typing import Optional

import numpy as np
import pandas as pd
from scipy import stats
from scipy.interpolate import CubicSpline

from egb_expressions_config import ALL_EXPRESSIONS, GROUP_META

# ─── Constants ────────────────────────────────────────────────────────────────

TENORS = [2, 5, 7, 10, 15, 20, 30]   # benchmark tenors for yield curve

# ─── Bloomberg ticker maps ────────────────────────────────────────────────────

_YIELD_TICKERS: dict[str, dict[int, str]] = {
    "Bund": {t: f"GDBR{t} Index"  for t in TENORS},
    "OAT":  {t: f"GFRN{t} Index"  for t in TENORS},
}

_ESTR_TICKER = "ESTRON Index"

# ⚠️ Verify these before live use
_ASW_TICKERS: dict[str, dict[int, str]] = {
    "Bund": {t: f"DASW{t} Index"  for t in [2, 5, 10, 30]},
    "OAT":  {t: f"FOASW{t} Index" for t in [2, 5, 10, 30]},
}

_VOL_TICKER = "EUSV0001 Index"   # EUR 1m10y swaption normal vol (bps)

# ─── Carry helpers ────────────────────────────────────────────────────────────

def _modified_duration(T: float, y_pct: float) -> float:
    """Rough modified duration for an approximate par bond at tenor T."""
    return max(T * (1.0 - y_pct / 200.0), 0.5)


def _build_spline(tenors: list[int], yields: np.ndarray) -> CubicSpline:
    """Cubic spline of yield curve; extrapolates flat beyond last tenor."""
    return CubicSpline(tenors, yields, bc_type="not-a-knot", extrapolate=True)


def _leg_carry_bps(country: str, T: int, splines: dict, repo: float) -> float:
    """
    Carry for a single yield leg in bps/yr per unit DV01.
      carry = ((y_T − repo) / dur_T + roll_T) × 100
    """
    cs = splines[country]
    y_T  = float(cs(T))
    y_T1 = float(cs(max(T - 1.0, 0.5)))   # yield 1yr earlier on the curve
    roll = y_T - y_T1                       # % per year; positive on upward-sloping curve
    dur  = _modified_duration(T, y_T)
    return ((y_T - repo) / dur + roll) * 100.0


def _asw_carry_bps(country_base: str, T: int, splines: dict, asw_level: float) -> float:
    """
    Carry for an ASW position in bps/yr.
      carry = ASW_level_bps + bond_roll_bps
    """
    cs = splines[country_base]
    y_T  = float(cs(T))
    y_T1 = float(cs(max(T - 1.0, 0.5)))
    roll_bps = (y_T - y_T1) * 100.0
    return asw_level + roll_bps


def _expression_carry(legs: list, splines: dict, asw_latest: dict, repo: float) -> float:
    """Aggregate carry across all legs of an expression."""
    total = 0.0
    for country, tenor, weight in legs:
        if country.endswith("_ASW"):
            base = country.replace("_ASW", "")
            level = asw_latest.get((base, tenor), 0.0)
            total += weight * _asw_carry_bps(base, tenor, splines, level)
        else:
            total += weight * _leg_carry_bps(country, tenor, splines, repo)
    return total


def _expression_level(legs: list, yield_row: dict, asw_row: dict) -> float:
    """Level of an expression in bps."""
    total = 0.0
    for country, tenor, weight in legs:
        if country.endswith("_ASW"):
            base = country.replace("_ASW", "")
            total += weight * asw_row.get((base, tenor), np.nan)
        else:
            total += weight * yield_row.get((country, tenor), np.nan) * 100.0
    return total

# ─── Bloomberg fetch ──────────────────────────────────────────────────────────

def _fetch_from_bbg(start: str, end: str):
    """
    Fetch Bund/OAT yields, ESTR, ASW spreads, EUR 1m10y vol from Bloomberg.
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

        # Build MultiIndex DataFrame
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

def _simulate_data(n_days: int = 1260, seed: int = 42) -> tuple:
    """
    Generate ~5y of realistic synthetic daily EGB data.
    Returns (yield_df, estr_s, asw_df, vol_s).
    """
    rng = np.random.default_rng(seed)
    dates = pd.bdate_range(end="2025-06-30", periods=n_days)

    # ── Bund curve (levels in %) ───────────────────────────────────────────
    # Start low, rise over history; mild upward slope
    bund_mean = np.array([1.50, 2.00, 2.30, 2.50, 2.62, 2.72, 2.80])  # 2,5,7,10,15,20,30
    # Correlated random walk for yield levels
    sigma_bund = np.array([0.05, 0.04, 0.035, 0.03, 0.025, 0.022, 0.020]) / np.sqrt(252)
    corr_bund = np.array([
        [1.00, 0.97, 0.95, 0.92, 0.88, 0.85, 0.82],
        [0.97, 1.00, 0.98, 0.96, 0.93, 0.90, 0.87],
        [0.95, 0.98, 1.00, 0.99, 0.96, 0.93, 0.90],
        [0.92, 0.96, 0.99, 1.00, 0.98, 0.96, 0.93],
        [0.88, 0.93, 0.96, 0.98, 1.00, 0.99, 0.97],
        [0.85, 0.90, 0.93, 0.96, 0.99, 1.00, 0.99],
        [0.82, 0.87, 0.90, 0.93, 0.97, 0.99, 1.00],
    ])
    cov_bund = np.outer(sigma_bund, sigma_bund) * corr_bund
    L_bund = np.linalg.cholesky(cov_bund)

    shocks_bund = (L_bund @ rng.standard_normal((7, n_days))).T
    # mean-revert toward bund_mean
    bund_path = np.zeros((n_days, 7))
    bund_path[0] = bund_mean - 0.80  # start 80bp below current
    for t in range(1, n_days):
        bund_path[t] = bund_path[t-1] + 0.004 * (bund_mean - bund_path[t-1]) + shocks_bund[t]

    # ── OAT-Bund spread (in %) ────────────────────────────────────────────
    oat_spread_mean = np.array([0.55, 0.60, 0.65, 0.68, 0.70, 0.72, 0.75])  # ~55-75bps
    sigma_spread = np.array([0.015, 0.013, 0.012, 0.010, 0.010, 0.010, 0.010]) / np.sqrt(252)
    corr_spread = np.array([
        [1.00, 0.95, 0.92, 0.90, 0.88, 0.85, 0.82],
        [0.95, 1.00, 0.97, 0.95, 0.92, 0.90, 0.87],
        [0.92, 0.97, 1.00, 0.98, 0.95, 0.93, 0.90],
        [0.90, 0.95, 0.98, 1.00, 0.98, 0.96, 0.93],
        [0.88, 0.92, 0.95, 0.98, 1.00, 0.99, 0.97],
        [0.85, 0.90, 0.93, 0.96, 0.99, 1.00, 0.99],
        [0.82, 0.87, 0.90, 0.93, 0.97, 0.99, 1.00],
    ])
    cov_spread = np.outer(sigma_spread, sigma_spread) * corr_spread
    L_spread = np.linalg.cholesky(cov_spread)
    shocks_spread = (L_spread @ rng.standard_normal((7, n_days))).T
    spread_path = np.zeros((n_days, 7))
    spread_path[0] = oat_spread_mean * 0.8
    for t in range(1, n_days):
        spread_path[t] = spread_path[t-1] + 0.005 * (oat_spread_mean - spread_path[t-1]) + shocks_spread[t]
    spread_path = np.clip(spread_path, 0.10, 2.00)

    oat_path = bund_path + spread_path

    # ── Build MultiIndex DataFrame ─────────────────────────────────────────
    cols = pd.MultiIndex.from_tuples(
        [("Bund", t) for t in TENORS] + [("OAT", t) for t in TENORS]
    )
    yield_data = np.hstack([bund_path, oat_path])
    yield_df = pd.DataFrame(yield_data, index=dates, columns=cols)

    # ── ESTR: starts at 4%, mean-reverts to 2.5% ──────────────────────────
    estr_path = np.zeros(n_days)
    estr_path[0] = 4.0
    estr_shock = rng.standard_normal(n_days) * 0.01
    for t in range(1, n_days):
        estr_path[t] = estr_path[t-1] + 0.003 * (2.5 - estr_path[t-1]) + estr_shock[t]
    estr_s = pd.Series(estr_path, index=dates)

    # ── ASW: Bund negative (~−30 to −50), OAT near-zero ──────────────────
    asw_tenors = [2, 5, 10, 30]
    bund_asw_mean = np.array([-35.0, -40.0, -45.0, -38.0])
    oat_asw_mean  = np.array([ 20.0,  12.0,   5.0,   2.0])
    sigma_asw = 2.0 / np.sqrt(252)

    bund_asw_path = np.zeros((n_days, 4))
    oat_asw_path  = np.zeros((n_days, 4))
    bund_asw_path[0] = bund_asw_mean + rng.standard_normal(4) * 5
    oat_asw_path[0]  = oat_asw_mean  + rng.standard_normal(4) * 3
    for t in range(1, n_days):
        bund_asw_path[t] = (bund_asw_path[t-1]
                             + 0.003 * (bund_asw_mean - bund_asw_path[t-1])
                             + rng.standard_normal(4) * sigma_asw)
        oat_asw_path[t]  = (oat_asw_path[t-1]
                             + 0.003 * (oat_asw_mean - oat_asw_path[t-1])
                             + rng.standard_normal(4) * sigma_asw * 0.8)

    asw_cols = pd.MultiIndex.from_tuples(
        [("Bund", t) for t in asw_tenors] + [("OAT", t) for t in asw_tenors]
    )
    asw_df = pd.DataFrame(
        np.hstack([bund_asw_path, oat_asw_path]),
        index=dates,
        columns=asw_cols,
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
    Compute EGB RV monitor for Bund and OAT.

    Returns:
      as_of, min_date, max_date, data_source,
      rv_monitor   : list of RV rows (level, changes, z-score, pctile, vol, carry)
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
    latest_asw    = {}
    if not asw_df.empty:
        for col in asw_df.columns:
            country, tenor = col
            val = asw_df.iloc[-1].get(col, np.nan)
            if not np.isnan(val):
                latest_asw[(country, tenor)] = float(val)

    splines: dict[str, CubicSpline] = {}
    for country in ("Bund", "OAT"):
        ys = np.array([float(latest_yields.get((country, t), np.nan)) for t in TENORS])
        valid = ~np.isnan(ys)
        if valid.sum() >= 3:
            ts_valid = np.array(TENORS)[valid]
            ys_valid = ys[valid]
            splines[country] = _build_spline(list(ts_valid), ys_valid)

    # ── Build time series for all expressions ─────────────────────────────
    expr_series: dict[str, pd.Series] = {}
    for label, group, legs in ALL_EXPRESSIONS:
        vals = []
        for date, row in yield_df.iterrows():
            y_row = {(c, t): float(row.get((c, t), np.nan))
                     for c in ("Bund", "OAT") for t in TENORS}
            a_row = {}
            if not asw_df.empty and date in asw_df.index:
                for col in asw_df.columns:
                    v = asw_df.at[date, col]
                    if not np.isnan(v):
                        a_row[tuple(col)] = float(v)
            v = _expression_level(legs, y_row, a_row)
            vals.append(v)
        expr_series[label] = pd.Series(vals, index=yield_df.index, name=label)

    # ── Beta explanatory variables ─────────────────────────────────────────
    def _safe_series(country_a, t_a, w_a, country_b=None, t_b=None, w_b=None):
        s = yield_df.get((country_a, t_a))
        if s is None:
            return pd.Series(np.nan, index=yield_df.index)
        result = s * w_a * 100.0
        if country_b is not None:
            sb = yield_df.get((country_b, t_b))
            if sb is not None:
                result = result + sb * w_b * 100.0
        return result

    bund10y_s  = _safe_series("Bund", 10, +1)                            # Bund 10y yield (bps)
    spread10y_s = _safe_series("OAT", 10, +1, "Bund", 10, -1)           # OAT-Bund 10y (bps)
    slope_s    = _safe_series("Bund", 10, +1, "Bund",  2, -1)           # Bund 2s10s (bps)

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
        has_yield_legs = any(not c.endswith("_ASW") for c, _, _ in legs)
        if has_yield_legs and not all(c.replace("_ASW", "") in splines
                                      for c, _, _ in legs if not c.endswith("_ASW")):
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

        # Carry
        carry = 0.0
        try:
            carry = round(
                _expression_carry(legs, splines, latest_asw, latest_repo), 2
            )
        except Exception:
            carry = 0.0
        carry_vol_ratio = round(carry / vol3m, 2) if vol3m > 0 else None

        rv_monitor.append({
            "label":           label,
            "group":           group,
            "value_bps":       round(current, 2),
            "d1d_bps":         d1d,
            "d1w_bps":         d1w,
            "d1m_bps":         d1m,
            "zscore_1y":       zscore,
            "pctile_1y":       pctile,
            "vol3m_bps":       vol3m,
            "carry1y_bps":     carry,
            "carry_vol_ratio": carry_vol_ratio,
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
