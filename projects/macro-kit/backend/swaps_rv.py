from pathlib import Path
from datetime import datetime
import threading
import time
import warnings

import numpy as np
import pandas as pd
from scipy import stats
from scipy.interpolate import CubicSpline
from curves_flies_config import CURVES_BY_CCY, FLIES_BY_CCY
from settings import settings

# ---------------------------------------------------------------------------
# Zero-curve helpers (carry computation)
# ---------------------------------------------------------------------------

_SWAP_TENORS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30]
_MAX_TENOR   = 50   # 30y20y needs D up to year 50


def _fit_par_rates(swap_row: np.ndarray) -> np.ndarray:
    """Annual par rates (%) for 1.._MAX_TENOR years: cubic spline on the quotes, flat beyond 30y."""
    cs    = CubicSpline(_SWAP_TENORS, swap_row, bc_type="not-a-knot")
    rates = cs(np.arange(1, _MAX_TENOR + 1, dtype=float))
    rates[30:] = swap_row[-1]
    return rates


def _build_discount_factors(swap_row: np.ndarray) -> np.ndarray:
    """
    Given par swap rates on _SWAP_TENORS (in %), return discount factors D[0..50].
    Interpolates with cubic spline; extrapolates flat beyond 30y.
    """
    rates = _fit_par_rates(swap_row)

    D       = np.zeros(_MAX_TENOR + 1)
    D[0]    = 1.0
    annuity = 0.0
    for n in range(1, _MAX_TENOR + 1):
        r    = rates[n - 1] / 100.0
        D[n] = (1.0 - r * annuity) / (1.0 + r)
        annuity += D[n]
    return D


def _fwd_rate(s: int, t: int, D: np.ndarray) -> float:
    """Forward par rate (%) for swap starting in s years, tenor t years."""
    num = D[s] - D[s + t]
    den = sum(D[s + k] for k in range(1, t + 1))
    return (num / den) * 100.0


def _parse_label(label: str):
    """'12y3y' -> (12, 3)"""
    parts = label.split("y")
    return int(parts[0]), int(parts[1])


def _carry_fwd_bps(label: str, D: np.ndarray) -> float:
    """
    1y carry for a single forward label, in bps — receiver convention.
    carry = (f_now - f_rolled) × 100:
      positive = the receiver gains (rate rolls to a lower level).
      On an upward-sloping curve every receiver has positive carry;
      a flattener (pay front, receive back) has negative net carry
      because the front's roll-down exceeds the back's.
    """
    s, t  = _parse_label(label)
    f_now    = _fwd_rate(s,     t, D)
    f_rolled = _fwd_rate(s - 1, t, D)   # s-1 == 0 gives the spot par rate
    return (f_now - f_rolled) * 100.0   # bps, receiver convention


def _carry_expr_bps(legs: tuple, weights: tuple, D: np.ndarray) -> float:
    """
    Carry for an expression defined by (legs, weights).
    Curve:  legs=(front, back),        weights=(-1, +1)
    Fly:    legs=(front, belly, back),  weights=(-1, +2, -1)
    """
    return sum(w * _carry_fwd_bps(leg, D) for w, leg in zip(weights, legs))

DATA_DIR = Path(__file__).parent.parent / "data"

# ---------------------------------------------------------------------------
# Per-currency data file map
# ---------------------------------------------------------------------------

_CCY_FILES = {
    "EUR": {
        "forwards": "eur_estr_forwards.csv",
        "betas":    "eur_beta_variables.csv",
        "swaps":    "eur_estr_swaps.csv",
    },
    "GBP": {
        "forwards": "gbp_sonia_forwards.csv",
        "betas":    "gbp_beta_variables.csv",
        "swaps":    "gbp_sonia_swaps.csv",
    },
    "USD": {
        "forwards": "usd_sofr_forwards.csv",
        "betas":    "usd_beta_variables.csv",
        "swaps":    "usd_sofr_swaps.csv",
    },
}

FORWARD_GROUPS = {
    "1y":     {"labels": ["1y1y","2y1y","3y1y","4y1y","5y1y","6y1y","7y1y","8y1y","9y1y"], "color": "#3B82F6"},
    "2y":     {"labels": ["1y2y","2y2y","3y2y","5y2y"],                                     "color": "#8B5CF6"},
    "5y":     {"labels": ["1y5y","2y5y","3y5y","5y5y","7y5y"],                              "color": "#10B981"},
    "10y":    {"labels": ["1y10y","2y10y","3y10y","5y10y","10y10y"],                        "color": "#F59E0B"},
    "15y":    {"labels": ["2y15y","5y15y","10y15y"],                                        "color": "#EF4444"},
    "20y":    {"labels": ["1y20y","2y20y","5y20y","10y20y"],                                "color": "#06B6D4"},
    "25/30y": {"labels": ["2y25y","5y25y","2y30y","5y30y"],                                 "color": "#EC4899"},
}

# ---------------------------------------------------------------------------
# Bloomberg ticker maps
# ---------------------------------------------------------------------------

# Par OIS swap rate tickers: {currency: {tenor_years: bbg_ticker}}
_OIS_TICKERS: dict[str, dict[int, str]] = {
    "EUR": {n: f"EESWE{n} Curncy"   for n in _SWAP_TENORS},   # ESTR OIS
    "GBP": {n: f"BPSWS{n} Curncy"   for n in _SWAP_TENORS},   # SONIA OIS
    "USD": {n: f"USOSFR{n} Curncy"  for n in _SWAP_TENORS},   # SOFR OIS
}

# Swaption normal vol tickers (bps): {currency: {label: bbg_ticker}}
# EUR: ATMF normal vols priced by ICAP; the default BGN source returns nothing
# on our Terminal, so the ICPL source must be explicit (checked 2026-10-16).
# GBP/USD resolve but return no prices, so their Beta Monitors run on the
# forward variables only.
_VOL_TICKERS: dict[str, dict[str, str]] = {
    "EUR": {"1m10y": "ENPS0A10 ICPL Curncy", "1y10y": "ENPS0110 ICPL Curncy"},
    "GBP": {"1m10y": "BPSN0A10 Curncy", "1y10y": "BPSN0110 Curncy"},
    "USD": {"1m10y": "USSN0A10 Curncy", "1y10y": "USSN0110 Curncy"},
}

_BETA_VARS = ["1y10y_fwd", "2y1y_fwd", "1m10y_vol", "1y10y_vol"]

# ---------------------------------------------------------------------------
# BBG helpers
# ---------------------------------------------------------------------------

def _fwd_labels_for_ccy(ccy: str) -> list[str]:
    """Collect every unique forward label referenced by curves, flies, and snapshot."""
    labels: set[str] = set()
    for group_info in FORWARD_GROUPS.values():
        labels.update(group_info["labels"])
    for _, front, back in CURVES_BY_CCY[ccy]:
        labels.add(front)
        labels.add(back)
    for _, front, belly, back in FLIES_BY_CCY[ccy]:
        labels.add(front)
        labels.add(belly)
        labels.add(back)
    return sorted(labels)


def _fetch_from_bbg(
    ccy: str, start: str, end: str
) -> "tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame] | None":
    """
    Fetch par OIS rates + swaption vols from Bloomberg; bootstrap all forward rates.
    Returns (fwd_df, beta_df, swap_df) or None if the rates are unavailable.

    fwd_df  — columns = forward labels (e.g. "1y10y"), values in %
    beta_df — columns: 1y10y_fwd, 2y1y_fwd (%), plus 1m10y_vol, 1y10y_vol
              (bps normal vol) when Bloomberg returns them
    swap_df — columns = tenor ints in _SWAP_TENORS order, values = par rates in %
    """
    try:
        from bbg import blp
    except ImportError:
        return None

    try:
        # ── 1. Fetch par OIS rates ──────────────────────────────────────────
        ois_tickers = list(_OIS_TICKERS[ccy].values())
        raw_ois = blp.bdh(ois_tickers, "PX_LAST", start, end)
        if raw_ois is None or raw_ois.empty:
            warnings.warn(f"[swaps_rv] No OIS data from BBG for {ccy}")
            return None

        if isinstance(raw_ois.columns, pd.MultiIndex):
            par = raw_ois.xs("PX_LAST", axis=1, level=1)
        else:
            par = raw_ois.copy()

        inv_ois = {v: k for k, v in _OIS_TICKERS[ccy].items()}
        par = par.rename(columns=inv_ois)
        # Keep columns in _SWAP_TENORS order; drop rows with any NaN par rate
        par = par[[n for n in _SWAP_TENORS if n in par.columns]].dropna()
        if par.empty:
            warnings.warn(f"[swaps_rv] OIS data empty after cleaning for {ccy}")
            return None

        swap_df = par.copy()   # par rates, integer-keyed columns

        # ── 2. Bootstrap forward rates for every business day ───────────────
        fwd_labels = _fwd_labels_for_ccy(ccy)
        fwd_rows: list[dict] = []
        for date, row in par.iterrows():
            D = _build_discount_factors(row.values.astype(float))
            rec: dict = {}
            for label in fwd_labels:
                s, t = _parse_label(label)
                if s >= 1 and s + t <= _MAX_TENOR:
                    rec[label] = _fwd_rate(s, t, D)   # already in %
            fwd_rows.append(rec)

        fwd_df = pd.DataFrame(fwd_rows, index=par.index)

        # ── 3. Fetch swaption vols (optional beta explanatory variables) ────
        vol_tickers = list(_VOL_TICKERS[ccy].values())
        raw_vol = blp.bdh(vol_tickers, "PX_LAST", start, end)
        if raw_vol is None or raw_vol.empty:
            warnings.warn(f"[swaps_rv] No vol data from BBG for {ccy}; beta monitor uses forwards only")
            vol = pd.DataFrame()
        elif isinstance(raw_vol.columns, pd.MultiIndex):
            vol = raw_vol.xs("PX_LAST", axis=1, level=1)
        else:
            vol = raw_vol.copy()

        inv_vol = {v: k for k, v in _VOL_TICKERS[ccy].items()}
        vol = vol.rename(columns=inv_vol)

        # ── 4. Build beta_df ────────────────────────────────────────────────
        beta_df = pd.DataFrame(index=fwd_df.index)
        beta_df["1y10y_fwd"] = fwd_df["1y10y"]
        beta_df["2y1y_fwd"]  = fwd_df["2y1y"]
        # Vols join only if they cover the window; a stale series would cut the history short
        for label in ("1m10y", "1y10y"):
            s = vol[label].dropna() if label in vol.columns else pd.Series(dtype=float)
            if not s.empty and s.index.max() >= fwd_df.index.max() - pd.Timedelta(days=7):
                beta_df[f"{label}_vol"] = s
            elif label in vol.columns:
                warnings.warn(f"[swaps_rv] {ccy} {label} vol is stale or empty; left out of the beta monitor")
        beta_df = beta_df.dropna()

        if beta_df.empty:
            warnings.warn(f"[swaps_rv] beta_df empty after join for {ccy}")
            return None

        return fwd_df, beta_df, swap_df

    except Exception as exc:
        warnings.warn(f"[swaps_rv] BBG fetch failed for {ccy}: {exc}")
        return None


# Fetching 5y of history and bootstrapping every day takes 10-40 s per currency,
# so live data is cached in-process. The full fetch happens once; after that a
# refresh or an expired entry refetches only the last _TOPUP_DAYS and splices
# them on. Computed payloads are cached per (currency, as-of) until the data changes.
_BBG_CACHE_TTL_S = 15 * 60
_TOPUP_DAYS = 14
# ccy -> (fetched_at monotonic, (fwd_df, beta_df, swap_df), pulled_at wall-clock time)
_bbg_cache: dict[str, tuple[float, tuple, datetime]] = {}
_rv_cache: dict[tuple, tuple[float, dict]] = {}         # (ccy, as_of) -> (fetched_at, payload)
_bbg_locks = {ccy: threading.Lock() for ccy in _OIS_TICKERS}


def _splice(old: tuple, new: tuple) -> tuple:
    """Replace the overlapping tail of each cached frame with the freshly fetched rows."""
    cut = new[0].index.min()
    return tuple(pd.concat([o.loc[o.index < cut], n]) for o, n in zip(old, new))


def _load_bbg(ccy: str, refresh: bool = False) -> "tuple[float, tuple] | None":
    """Live data for the 5 years to today as (fetched_at, frames), from the cache when fresh."""
    with _bbg_locks[ccy]:   # concurrent requests for one currency share a single fetch
        hit = _bbg_cache.get(ccy)
        if hit and not refresh and time.monotonic() - hit[0] < _BBG_CACHE_TTL_S:
            return hit
        end = pd.Timestamp.today()
        if hit:
            new = _fetch_from_bbg(ccy, (end - pd.Timedelta(days=_TOPUP_DAYS)).strftime("%Y-%m-%d"),
                                  end.strftime("%Y-%m-%d"))
            if new is None:
                return hit   # Bloomberg hiccup: keep serving the cached history
            # Vol columns can appear or drop out; only splice like-for-like, else refetch in full
            if list(new[1].columns) == list(hit[1][1].columns):
                _bbg_cache[ccy] = (time.monotonic(), _splice(hit[1], new), datetime.now().astimezone())
                return _bbg_cache[ccy]
        result = _fetch_from_bbg(ccy, (end - pd.DateOffset(years=5)).strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d"))
        if result is None:
            return hit
        _bbg_cache[ccy] = (time.monotonic(), result, datetime.now().astimezone())
        return _bbg_cache[ccy]


def warm_cache() -> None:
    """Fetch and compute every currency once (startup warm-up) so the first visitor doesn't wait."""
    if settings.data_source != "bloomberg":
        return
    for ccy in _OIS_TICKERS:
        compute_rv(ccy)


def _load_frames(ccy: str, as_of_date: str | None, fetched: "tuple | None"):
    """(fwd_df, beta_df, swap_df, min_date, max_date): live frames when fetched, else the CSVs,
    aligned on common dates and sliced to the as-of date."""
    if fetched is not None:
        fwd_df, beta_df, swap_df = fetched[1]
    else:
        files   = _CCY_FILES[ccy]
        fwd_df  = pd.read_csv(DATA_DIR / files["forwards"], parse_dates=["date"], index_col="date")
        beta_df = pd.read_csv(DATA_DIR / files["betas"],    parse_dates=["date"], index_col="date")
        swap_df = pd.read_csv(DATA_DIR / files["swaps"],    parse_dates=["date"], index_col="date")

    common_idx = fwd_df.index.intersection(beta_df.index)
    fwd_df = fwd_df.loc[common_idx].sort_index()
    beta_df = beta_df.loc[common_idx].sort_index()
    if fwd_df.empty:
        raise ValueError(f"No data available for {ccy}")

    min_date = fwd_df.index[0].strftime("%Y-%m-%d")
    max_date = fwd_df.index[-1].strftime("%Y-%m-%d")

    if as_of_date:
        cutoff = pd.Timestamp(as_of_date)
        fwd_df = fwd_df.loc[fwd_df.index <= cutoff]
        beta_df = beta_df.loc[beta_df.index <= cutoff]
        if fwd_df.empty:
            raise ValueError(f"No data available on or before {as_of_date}")
    return fwd_df, beta_df, swap_df, min_date, max_date


def _factor_changes(beta_df: pd.DataFrame) -> "tuple[list[str], pd.DataFrame]":
    """Daily changes in bp of whichever beta variables the data source supplied (vols may be missing)."""
    beta_vars = [v for v in _BETA_VARS if v in beta_df.columns]
    changes = pd.DataFrame(index=beta_df.index)
    for v in beta_vars:
        # forwards are in %, vols already in bps
        changes[v] = beta_df[v].diff() * (100 if v.endswith("_fwd") else 1)
    return beta_vars, changes.dropna()


def _ols(y: np.ndarray, X_raw: np.ndarray) -> "tuple[np.ndarray, np.ndarray, float]":
    """OLS with an intercept: (coefficients [a, b1..bk], residuals, R²)."""
    X = np.hstack([np.ones((len(y), 1)), X_raw])
    coeffs, _, _, _ = np.linalg.lstsq(X, y, rcond=None)
    resid = y - X @ coeffs
    ss_tot = float(np.sum((y - y.mean()) ** 2))
    r2 = 1.0 - float(np.sum(resid ** 2)) / ss_tot if ss_tot > 0 else 0.0
    return coeffs, resid, r2


def _residual_zscore(resid: np.ndarray) -> float:
    """Z-score of the latest cumulative residual against its own window."""
    cumresid = np.cumsum(resid)
    cr_std = float(cumresid.std())
    return (float(cumresid[-1]) - float(cumresid.mean())) / cr_std if cr_std > 0 else 0.0


def compute_rv(currency: str = "EUR", as_of_date: str | None = None, refresh: bool = False) -> dict:
    ccy = currency.upper()
    if ccy not in _CCY_FILES:
        raise ValueError(f"Unsupported currency: {currency}")

    curves = CURVES_BY_CCY[ccy]
    flies  = FLIES_BY_CCY[ccy]

    # 1. Load data — Bloomberg when it is the configured source, else (or on failure) CSV.
    #    The live window is the 5y to today; an as-of date slices it below.
    fetched = _load_bbg(ccy, refresh) if settings.data_source == "bloomberg" else None
    data_source = "bloomberg" if fetched is not None else "csv"
    if fetched is not None:
        cached = _rv_cache.get((ccy, as_of_date))
        if cached and cached[0] == fetched[0]:
            return cached[1]

    # 2-3. Align on common dates and slice to the requested date (or latest)
    fwd_df, beta_df, swap_df, min_date, max_date = _load_frames(ccy, as_of_date, fetched)

    as_of = fwd_df.index[-1].strftime("%Y-%m-%d")

    # Build discount factors for the as-of date (used for carry)
    as_of_ts   = fwd_df.index[-1]
    swap_row   = swap_df.loc[swap_df.index <= as_of_ts].iloc[-1].values.astype(float)
    D          = _build_discount_factors(swap_row)

    # 4. Curve snapshot
    curve_snapshot = {}
    latest = fwd_df.iloc[-1]
    for group_key, group_info in FORWARD_GROUPS.items():
        points = []
        for label in group_info["labels"]:
            if label in fwd_df.columns:
                start_year = int(label.split("y")[0])
                points.append({
                    "start": start_year,
                    "label": label,
                    "rate": round(float(latest[label]), 4),
                })
        curve_snapshot[group_key] = {
            "color": group_info["color"],
            "points": points,
        }

    # 5. Build curve and fly time series
    def curve_series(front, back):
        return (fwd_df[back] - fwd_df[front]) * 100  # bps

    def fly_series(front, belly, back):
        return (2 * fwd_df[belly] - fwd_df[front] - fwd_df[back]) * 100  # bps

    # Collect all series: list of (label, group, series, legs, weights)
    all_series = []
    for label, front, back in curves:
        if front not in fwd_df.columns or back not in fwd_df.columns:
            continue
        all_series.append((label, "curve", curve_series(front, back),
                           (front, back), (-1, 1)))
    for label, front, belly, back in flies:
        if any(leg not in fwd_df.columns for leg in (front, belly, back)):
            continue
        all_series.append((label, "fly", fly_series(front, belly, back),
                           (front, belly, back), (-1, 2, -1)))

    n = len(fwd_df)
    win_1y = min(252, n)
    win_3m = min(63, n)

    rv_monitor = []
    for label, group, series, legs, weights in all_series:
        current = float(series.iloc[-1])
        d1d = round(float(series.iloc[-1] - series.iloc[-2]), 2) if n >= 2 else None
        d1w = round(float(series.iloc[-1] - series.iloc[-6]), 2) if n >= 6 else None
        d1m = round(float(series.iloc[-1] - series.iloc[-22]), 2) if n >= 22 else None
        window = series.iloc[-win_1y:]
        mean_1y = float(window.mean())
        std_1y  = float(window.std())
        zscore_1y = round((current - mean_1y) / std_1y, 2) if std_1y > 0 else 0.0
        pctile_1y = round(float(stats.percentileofscore(window.values, current)), 1)
        daily_changes_3m = series.diff().iloc[-win_3m:]
        vol3m_bps  = round(float(daily_changes_3m.std()) * (252 ** 0.5), 2)
        carry1y_bps = round(_carry_expr_bps(legs, weights, D), 2)
        carry_vol_ratio = round(carry1y_bps / vol3m_bps, 2) if vol3m_bps > 0 else None
        # Per-leg roll-down: each forward slides one year down its own forward curve
        leg_detail = []
        for leg, w in zip(legs, weights):
            s, t = _parse_label(leg)
            leg_detail.append({
                "label": leg,
                "weight": w,
                "tenor": t,
                "start": s,
                "rate": round(float(_fwd_rate(s, t, D)), 4),
                "rolled_label": f"{s - 1}y{t}y" if s > 1 else f"{t}y spot",
                "rolled_rate": round(float(_fwd_rate(s - 1, t, D)), 4),
                "contribution_bps": round(float(w * _carry_fwd_bps(leg, D)), 2),
            })
        rv_monitor.append({
            "label": label,
            "group": group,
            "value_bps": round(current, 2),
            "d1d_bps": d1d,
            "d1w_bps": d1w,
            "d1m_bps": d1m,
            "zscore_1y": zscore_1y,
            "pctile_1y": pctile_1y,
            "vol3m_bps": vol3m_bps,
            "carry1y_bps": carry1y_bps,
            "carry_vol_ratio": carry_vol_ratio,
            "legs": leg_detail,
        })

    # Curve the carry is computed on: par quotes, the fitted par curve, and a forward
    # curve f(s, t) by start s for every leg tenor t (s = 0 is the spot par rate).
    leg_tenors = sorted({_parse_label(leg)[1] for _, _, _, legs, _ in all_series for leg in legs})
    par_fit = _fit_par_rates(swap_row)
    curve = {
        "par_quotes": [{"tenor": n, "rate": round(float(r), 4)} for n, r in zip(_SWAP_TENORS, swap_row)],
        "par_fitted": [{"tenor": n, "rate": round(float(par_fit[n - 1]), 4)} for n in range(1, 31)],
        "forwards": {
            str(t): [{"start": s, "rate": round(float(_fwd_rate(s, t, D)), 4)} for s in range(0, min(30, _MAX_TENOR - t) + 1)]
            for t in leg_tenors
        },
    }

    # 6. Beta Monitor — regress each curve/fly daily change on beta variable daily changes
    beta_vars, beta_changes = _factor_changes(beta_df)

    beta_monitor = []
    for label, group, series, legs, weights in all_series:
        y_full = series.diff().dropna()
        common = y_full.index.intersection(beta_changes.index)[-win_1y:]   # 1y of daily changes
        coeffs, resid, r2 = _ols(y_full.loc[common].values, beta_changes.loc[common].values)
        r2 = round(r2, 3)
        residual_zscore = round(_residual_zscore(resid), 2)
        betas = dict(zip(beta_vars, coeffs[1:]))
        beta_monitor.append({
            "label": label,
            "group": group,
            **{f"beta_{v}": round(float(betas[v]), 3) if v in betas else None for v in _BETA_VARS},
            "r2": r2,
            "residual_zscore": residual_zscore,
        })

    # 7. 1y time series for each expression (for detail chart)
    series_out: dict = {}
    for label, group, series, legs, weights in all_series:
        window = series.iloc[-win_1y:]
        series_out[label] = [
            {"date": d.strftime("%Y-%m-%d"), "value": round(float(v), 2)}
            for d, v in zip(window.index, window.values)
        ]

    # 8. Full available history (up to as-of) for the detail view's lookback selector.
    #    Shared date axis + one value array per label keeps the payload compact.
    history_df = pd.DataFrame({label: series for label, _, series, _, _ in all_series}).round(2)
    history = {
        "dates": [d.strftime("%Y-%m-%d") for d in history_df.index],
        "values": {
            label: [None if pd.isna(v) else float(v) for v in history_df[label].values]
            for label in history_df.columns
        },
    }

    # When the latest live day is shown, its prices are intraday as of the Bloomberg pull;
    # past days are closes, so they carry no time.
    showing_latest_live = fetched is not None and fwd_df.index[-1] == fetched[1][0].index[-1]
    payload = {
        "data_source": data_source,
        "beta_vars": beta_vars,
        "as_of": as_of,
        "data_timestamp": fetched[2].isoformat(timespec="seconds") if showing_latest_live else None,
        "min_date": min_date,
        "max_date": max_date,
        "curve_snapshot": curve_snapshot,
        "curve": curve,
        "rv_monitor": rv_monitor,
        "beta_monitor": beta_monitor,
        "series": series_out,
        "history": history,
    }
    if fetched is not None:
        # Drop this currency's payloads built from older data, then remember this one
        for key in [k for k, v in _rv_cache.items() if k[0] == ccy and v[0] != fetched[0]]:
            del _rv_cache[key]
        _rv_cache[(ccy, as_of_date)] = (fetched[0], payload)
    return payload


# ---------------------------------------------------------------------------
# Regression detail for one structure (detail view)
# ---------------------------------------------------------------------------

def _expression(ccy: str, label: str) -> "tuple[str, tuple, tuple]":
    """(group, legs, weights) for a curve or fly label."""
    for lbl, front, back in CURVES_BY_CCY[ccy]:
        if lbl == label:
            return "curve", (front, back), (-1, 1)
    for lbl, front, belly, back in FLIES_BY_CCY[ccy]:
        if lbl == label:
            return "fly", (front, belly, back), (-1, 2, -1)
    raise KeyError(f"Unknown {ccy} structure: {label}")


def compute_regression(currency: str, label: str, as_of_date: str | None = None, window: int = 63) -> dict:
    """
    The Beta Monitor regression for one structure, in detail: coefficients with standard
    errors, t-stats and VIFs on the 1y window; rolling-window betas over the full history;
    daily and cumulative residuals; and the 1y move attributed to each factor.
    """
    ccy = currency.upper()
    if ccy not in _CCY_FILES:
        raise ValueError(f"Unsupported currency: {currency}")
    group, legs, weights = _expression(ccy, label)

    fetched = _load_bbg(ccy) if settings.data_source == "bloomberg" else None
    fwd_df, beta_df, _, _, _ = _load_frames(ccy, as_of_date, fetched)
    if any(leg not in fwd_df.columns for leg in legs):
        raise KeyError(f"No forward data for {label}")

    series = sum(w * fwd_df[leg] for w, leg in zip(weights, legs)) * 100   # bps
    factors, changes = _factor_changes(beta_df)
    y_full = series.diff().dropna()
    common_all = y_full.index.intersection(changes.index)
    win_1y = min(252, len(fwd_df))
    common = common_all[-win_1y:]   # same 1y window as the Beta Monitor

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
        if k == 1:
            vif.append(1.0)
            continue
        _, _, r2_j = _ols(Xf[:, j], np.delete(Xf, j, axis=1))
        vif.append(1.0 / (1.0 - r2_j) if r2_j < 1 else float("inf"))

    factor_vol = Xf.std(axis=0, ddof=1)
    factor_rows = [{
        "name": f,
        "beta": round(float(coeffs[j + 1]), 4),
        "se": round(float(se[j + 1]), 4),
        "t": round(float(tstat[j + 1]), 2),
        "factor_vol_bp": round(float(factor_vol[j]), 3),      # daily std of the factor, bp
        "beta_x_vol_bp": round(float(coeffs[j + 1] * factor_vol[j]), 3),
        "vif": round(float(vif[j]), 2),
    } for j, f in enumerate(factors)]

    # Daily and cumulative residuals, fitted vs actual
    fitted = X @ coeffs
    cum = np.cumsum(resid)
    dates = [d.strftime("%Y-%m-%d") for d in common]
    residuals = [{
        "date": d, "actual": round(float(a), 3), "fitted": round(float(f), 3),
        "resid": round(float(e), 3), "cum": round(float(c), 3),
    } for d, a, f, e, c in zip(dates, y, fitted, resid, cum)]

    # Attribution: cumulative move = Σ β·ΔX per factor + intercept drift + residual (exact)
    contrib = Xf * coeffs[1:]
    cum_contrib = np.cumsum(contrib, axis=0)
    cum_actual = np.cumsum(y)
    attribution = []
    for i, d in enumerate(dates):
        row = {"date": d, "actual": round(float(cum_actual[i]), 3),
               "intercept": round(float(coeffs[0] * (i + 1)), 3), "residual": round(float(cum[i]), 3)}
        row.update({f: round(float(cum_contrib[i, j]), 3) for j, f in enumerate(factors)})
        attribution.append(row)

    # Rolling-window betas across the full history
    y_all = y_full.loc[common_all].values
    X_all = changes.loc[common_all, factors].values
    rolling = []
    for end in range(window, len(y_all) + 1):
        c_w, _, r2_w = _ols(y_all[end - window:end], X_all[end - window:end])
        row = {"date": common_all[end - 1].strftime("%Y-%m-%d"), "r2": round(r2_w, 3)}
        row.update({f: round(float(c_w[j + 1]), 4) for j, f in enumerate(factors)})
        rolling.append(row)

    return {
        "label": label,
        "group": group,
        "currency": ccy,
        "as_of": fwd_df.index[-1].strftime("%Y-%m-%d"),
        "data_source": "bloomberg" if fetched is not None else "csv",
        "factors": factor_rows,
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
