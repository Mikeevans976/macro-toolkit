from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats
from scipy.interpolate import CubicSpline
from curves_flies_config import CURVES, FLIES

# ---------------------------------------------------------------------------
# Zero-curve helpers (carry computation)
# ---------------------------------------------------------------------------

_SWAP_TENORS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30]
_MAX_TENOR   = 50   # 30y20y needs D up to year 50


def _build_discount_factors(swap_row: np.ndarray) -> np.ndarray:
    """
    Given par swap rates on _SWAP_TENORS (in %), return discount factors D[0..50].
    Interpolates with cubic spline; extrapolates flat beyond 30y.
    """
    cs    = CubicSpline(_SWAP_TENORS, swap_row, bc_type="not-a-knot")
    rates = cs(np.arange(1, _MAX_TENOR + 1, dtype=float))
    rates[30:] = swap_row[-1]          # flat beyond 30y

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

FORWARD_GROUPS = {
    "1y":     {"labels": ["1y1y","2y1y","3y1y","4y1y","5y1y","6y1y","7y1y","8y1y","9y1y"], "color": "#3B82F6"},
    "2y":     {"labels": ["1y2y","2y2y","3y2y","5y2y"],                                     "color": "#8B5CF6"},
    "5y":     {"labels": ["1y5y","2y5y","3y5y","5y5y","7y5y"],                              "color": "#10B981"},
    "10y":    {"labels": ["1y10y","2y10y","3y10y","5y10y","10y10y"],                        "color": "#F59E0B"},
    "15y":    {"labels": ["2y15y","5y15y","10y15y"],                                        "color": "#EF4444"},
    "20y":    {"labels": ["1y20y","2y20y","5y20y","10y20y"],                                "color": "#06B6D4"},
    "25/30y": {"labels": ["2y25y","5y25y","2y30y","5y30y"],                                 "color": "#EC4899"},
}


def compute_rv(as_of_date: str | None = None) -> dict:
    # 1. Load CSVs
    fwd_df  = pd.read_csv(DATA_DIR / "eur_estr_forwards.csv",  parse_dates=["date"], index_col="date")
    beta_df = pd.read_csv(DATA_DIR / "eur_beta_variables.csv", parse_dates=["date"], index_col="date")
    swap_df = pd.read_csv(DATA_DIR / "eur_estr_swaps.csv",     parse_dates=["date"], index_col="date")

    # 2. Align on common dates
    common_idx = fwd_df.index.intersection(beta_df.index)
    fwd_df = fwd_df.loc[common_idx].sort_index()
    beta_df = beta_df.loc[common_idx].sort_index()

    min_date = fwd_df.index[0].strftime("%Y-%m-%d")
    max_date = fwd_df.index[-1].strftime("%Y-%m-%d")

    # 3. Slice to requested date (or latest)
    if as_of_date:
        cutoff = pd.Timestamp(as_of_date)
        fwd_df = fwd_df.loc[fwd_df.index <= cutoff]
        beta_df = beta_df.loc[beta_df.index <= cutoff]
        if fwd_df.empty:
            raise ValueError(f"No data available on or before {as_of_date}")

    as_of = fwd_df.index[-1].strftime("%Y-%m-%d")

    # Build discount factors for the as-of date (used for carry)
    as_of_ts   = fwd_df.index[-1]
    swap_row   = swap_df.loc[swap_df.index <= as_of_ts].iloc[-1].values.astype(float)
    D          = _build_discount_factors(swap_row)

    # 3. Curve snapshot
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

    # 4. Build curve and fly time series
    def curve_series(front, back):
        return (fwd_df[back] - fwd_df[front]) * 100  # bps

    def fly_series(front, belly, back):
        return (2 * fwd_df[belly] - fwd_df[front] - fwd_df[back]) * 100  # bps

    # Collect all series: list of (label, group, series, legs, weights)
    all_series = []
    for label, front, back in CURVES:
        if front not in fwd_df.columns or back not in fwd_df.columns:
            continue
        all_series.append((label, "curve", curve_series(front, back),
                           (front, back), (-1, 1)))
    for label, front, belly, back in FLIES:
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
        })

    # 5. Beta Monitor — regress each curve/fly daily change on beta variable daily changes
    beta_changes = pd.DataFrame(index=beta_df.index)
    beta_changes["1y10y_fwd"] = beta_df["1y10y_fwd"].diff() * 100
    beta_changes["2y1y_fwd"]  = beta_df["2y1y_fwd"].diff()  * 100
    beta_changes["1m10y_vol"] = beta_df["1m10y_vol"].diff()
    beta_changes["1y10y_vol"] = beta_df["1y10y_vol"].diff()
    beta_changes = beta_changes.dropna()

    beta_monitor = []
    for label, group, series, legs, weights in all_series:
        y_full = series.diff().dropna()
        common = y_full.index.intersection(beta_changes.index)
        y = y_full.loc[common].values
        X_raw = beta_changes.loc[common].values
        X = np.hstack([np.ones((len(y), 1)), X_raw])
        coeffs, _, _, _ = np.linalg.lstsq(X, y, rcond=None)
        y_hat = X @ coeffs
        resid = y - y_hat
        ss_res = float(np.sum(resid ** 2))
        ss_tot = float(np.sum((y - y.mean()) ** 2))
        r2 = round(1.0 - ss_res / ss_tot, 3) if ss_tot > 0 else 0.0
        cumresid = np.cumsum(resid)
        cr_std = float(cumresid.std())
        residual_zscore = round((float(cumresid[-1]) - float(cumresid.mean())) / cr_std, 2) if cr_std > 0 else 0.0
        beta_monitor.append({
            "label": label,
            "group": group,
            "beta_1y10y_fwd": round(float(coeffs[1]), 3),
            "beta_2y1y_fwd":  round(float(coeffs[2]), 3),
            "beta_1m10y_vol": round(float(coeffs[3]), 3),
            "beta_1y10y_vol": round(float(coeffs[4]), 3),
            "r2": r2,
            "residual_zscore": residual_zscore,
        })

    # 6. 1y time series for each expression (for detail chart)
    series_out: dict = {}
    for label, group, series, legs, weights in all_series:
        window = series.iloc[-win_1y:]
        series_out[label] = [
            {"date": d.strftime("%Y-%m-%d"), "value": round(float(v), 2)}
            for d, v in zip(window.index, window.values)
        ]

    return {
        "as_of": as_of,
        "min_date": min_date,
        "max_date": max_date,
        "curve_snapshot": curve_snapshot,
        "rv_monitor": rv_monitor,
        "beta_monitor": beta_monitor,
        "series": series_out,
    }
