"""
Seasonality Backtester — Bloomberg expression fetcher + seasonal analysis.

Public API (called by main.py):
  fetch_bbg_expression(expression, start)   → time series from Bloomberg
  get_seasonality_stats(dates, values)       → seasonal stats across all dims
  get_seasonality_heatmap(dates, values)     → month × DOW heatmap matrix
  run_seasonality_backtest(dates, values, rule) → backtest PnL + metrics
"""

from __future__ import annotations

import math
import re
import warnings
from typing import Any

import numpy as np
import pandas as pd
from scipy import stats as scipy_stats

# ---------------------------------------------------------------------------
# Bloomberg expression parser + fetcher
# ---------------------------------------------------------------------------

# Supported yellow keys
_BBG_YELLOW = r'(?:Index|Equity|Comdty|Corp|Govt|Curncy|Mtge|Muni|Pfd)'
_BBG_RE = re.compile(rf'[A-Z][A-Z0-9 ]*?\s+{_BBG_YELLOW}(?=\s|$|[+\-*/()])')


def _extract_tickers(expression: str) -> list[str]:
    """Return unique Bloomberg tickers in the expression, longest first."""
    found = _BBG_RE.findall(expression)
    # Deduplicate preserving order
    seen: set[str] = set()
    unique: list[str] = []
    for t in found:
        t = t.strip()
        if t not in seen:
            seen.add(t)
            unique.append(t)
    # Sort longest first so that shorter substrings don't get replaced first
    return sorted(unique, key=len, reverse=True)


def fetch_bbg_expression(
    expression: str,
    start: str = "2010-01-01",
) -> dict:
    """
    Parse a Bloomberg arithmetic expression, fetch the constituent series,
    evaluate the expression, and return a daily time series.

    Parameters
    ----------
    expression : e.g.
        "GDBR10 Index"
        "GDBR10 Index - GDBR2 Index"
        "GDBR30 Index - 2 * GDBR10 Index + GDBR2 Index"
    start : first date to fetch (YYYY-MM-DD), defaults to 2010-01-01

    Returns
    -------
    {
        "expression": str,
        "dates": [str, ...],
        "values": [float, ...],
        "n_obs": int,
    }
    """
    try:
        from bbg import blp
    except ImportError as e:
        raise RuntimeError(
            "blpapi is required for Bloomberg data. "
            "Install with: pip install blpapi  (Bloomberg Terminal must be running)."
        ) from e

    tickers = _extract_tickers(expression)
    if not tickers:
        raise ValueError(
            f"No Bloomberg tickers found in expression: {expression!r}\n"
            "Expected format: 'GDBR10 Index' or 'GDBR10 Index - GDBR2 Index'"
        )

    end = pd.Timestamp.today().strftime("%Y-%m-%d")

    # Fetch PX_LAST for all tickers at once
    df = blp.bdh(
        tickers=tickers,
        flds=["PX_LAST"],
        start_date=start,
        end_date=end,
    )
    if df.empty:
        raise ValueError(f"Bloomberg returned no data for tickers: {tickers}")

    # Flatten MultiIndex columns (ticker, field) → ticker
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = [str(c[0]) for c in df.columns]

    # Drop rows where any constituent is missing
    df = df[tickers].dropna()
    if df.empty:
        raise ValueError("No overlapping data across all tickers after dropping NaNs.")

    # Evaluate the arithmetic expression
    if len(tickers) == 1 and expression.strip() == tickers[0]:
        result_vals = df.iloc[:, 0].values
    else:
        # Build a variable namespace: replace each ticker with a safe variable name
        ns: dict[str, Any] = {}
        expr_eval = expression
        for i, ticker in enumerate(tickers):
            var = f"__v{i}__"
            ns[var] = df[ticker].values.astype(float)
            expr_eval = expr_eval.replace(ticker, var)

        # Evaluate with restricted builtins (arithmetic only)
        try:
            result_vals = eval(expr_eval, {"__builtins__": {}}, ns)  # noqa: S307
        except Exception as exc:
            raise ValueError(
                f"Could not evaluate expression after substitution.\n"
                f"Modified expr: {expr_eval!r}\nError: {exc}"
            ) from exc

    result_vals = np.asarray(result_vals, dtype=float)

    return {
        "expression": expression,
        "dates": [d.strftime("%Y-%m-%d") for d in df.index],
        "values": [round(float(v), 6) for v in result_vals],
        "n_obs": len(result_vals),
    }


# ---------------------------------------------------------------------------
# Core statistics helpers
# ---------------------------------------------------------------------------

def _bin_stats(vals: list[float], label: str, bin_val: int) -> dict:
    n = len(vals)
    if n < 2:
        return {
            "label": label, "bin": bin_val,
            "mean": 0.0, "std": 0.0, "t_stat": 0.0,
            "p_value": 1.0, "win_rate": 0.5, "n": n,
        }
    arr = np.asarray(vals)
    mean = float(arr.mean())
    std = float(arr.std(ddof=1))
    se = std / math.sqrt(n)
    t_stat = mean / se if se > 0 else 0.0
    p_value = float(2 * scipy_stats.t.sf(abs(t_stat), df=n - 1))
    win_rate = float((arr > 0).mean())
    return {
        "label": label, "bin": bin_val,
        "mean": round(mean, 6),
        "std": round(std, 6),
        "t_stat": round(t_stat, 3),
        "p_value": round(p_value, 4),
        "win_rate": round(win_rate, 4),
        "n": n,
    }


def _build_day_df(dates: list[str], values: list[float]) -> pd.DataFrame:
    """
    Turn raw dates + values into a DataFrame with all seasonal annotations.
    Returns only rows with a valid daily return (skips first row).
    """
    idx = pd.to_datetime(dates)
    s = pd.Series(values, index=idx)
    ret = s.diff().dropna()

    df = pd.DataFrame({
        "date": ret.index,
        "ret": ret.values,
        "dow": ret.index.dayofweek,         # 0=Mon, 4=Fri
        "month": ret.index.month,           # 1–12
        "dom": ret.index.day,               # 1–31
    })

    # Day-of-month quintile
    dom = df["dom"]
    df["domQ"] = 0
    df.loc[dom <= 6,  "domQ"] = 1
    df.loc[(dom > 6)  & (dom <= 12), "domQ"] = 2
    df.loc[(dom > 12) & (dom <= 18), "domQ"] = 3
    df.loc[(dom > 18) & (dom <= 23), "domQ"] = 4
    df.loc[dom > 23,  "domQ"] = 5

    # Turn-of-month offsets (last 3 / first 3 bdays of month)
    month_ends = s.resample("BME").last().index
    tom_map: dict[pd.Timestamp, int] = {}
    for me in month_ends:
        loc = idx.get_loc(me) if me in idx else None
        if loc is None:
            continue
        for off in range(-3, 0):
            t = loc + off
            if 0 <= t < len(idx):
                tom_map[idx[t]] = off
        for off in range(1, 4):
            t = loc + off
            if 0 <= t < len(idx):
                tom_map[idx[t]] = off
    df["tomOffset"] = df["date"].map(tom_map)

    # Quarter-end offsets (last 5 / first 5 bdays of quarter)
    qe_map: dict[pd.Timestamp, int] = {}
    quarter_ends = s.resample("BQ").last().index
    for qe in quarter_ends:
        loc = idx.get_loc(qe) if qe in idx else None
        if loc is None:
            continue
        for off in range(-5, 0):
            t = loc + off
            if 0 <= t < len(idx):
                qe_map[idx[t]] = off
        for off in range(1, 6):
            t = loc + off
            if 0 <= t < len(idx):
                qe_map[idx[t]] = off
    df["qeOffset"] = df["date"].map(qe_map)

    return df


# ---------------------------------------------------------------------------
# Public analysis functions
# ---------------------------------------------------------------------------

DOW_NAMES   = ["Mon", "Tue", "Wed", "Thu", "Fri"]
MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
DOM_LABELS  = ["1–6", "7–12", "13–18", "19–23", "24–31"]
TOM_BINS    = [-3, -2, -1, 1, 2, 3]
TOM_LABELS  = ["-3d", "-2d", "-1d", "+1d", "+2d", "+3d"]
QE_BINS     = [-5, -4, -3, -2, -1, 1, 2, 3, 4, 5]
QE_LABELS   = ["-5d", "-4d", "-3d", "-2d", "-1d", "+1d", "+2d", "+3d", "+4d", "+5d"]


def get_seasonality_stats(dates: list[str], values: list[float]) -> dict:
    df = _build_day_df(dates, values)

    dow = [
        _bin_stats(df[df["dow"] == i]["ret"].tolist(), DOW_NAMES[i], i)
        for i in range(5)
    ]
    month = [
        _bin_stats(df[df["month"] == m + 1]["ret"].tolist(), MONTH_NAMES[m], m + 1)
        for m in range(12)
    ]
    dom = [
        _bin_stats(df[df["domQ"] == q + 1]["ret"].tolist(), DOM_LABELS[q], q + 1)
        for q in range(5)
    ]
    tom = [
        _bin_stats(df[df["tomOffset"] == b]["ret"].tolist(), TOM_LABELS[i], b)
        for i, b in enumerate(TOM_BINS)
    ]
    quarter_end = [
        _bin_stats(df[df["qeOffset"] == b]["ret"].tolist(), QE_LABELS[i], b)
        for i, b in enumerate(QE_BINS)
    ]

    return {
        "n_obs": len(df),
        "date_range": [dates[0], dates[-1]],
        "dow": dow,
        "month": month,
        "dom": dom,
        "tom": tom,
        "quarter_end": quarter_end,
    }


def get_seasonality_heatmap(dates: list[str], values: list[float]) -> dict:
    df = _build_day_df(dates, values)

    rows = []
    for mi, mlabel in enumerate(MONTH_NAMES):
        row: dict[str, Any] = {"month": mlabel}
        for di, dlabel in enumerate(DOW_NAMES):
            mask = (df["month"] == mi + 1) & (df["dow"] == di)
            vals = df[mask]["ret"].values
            row[dlabel] = round(float(vals.mean()), 6) if len(vals) > 0 else 0.0
        rows.append(row)

    all_vals = [row[d] for row in rows for d in DOW_NAMES]
    return {
        "rows": rows,
        "vmin": round(min(all_vals), 6),
        "vmax": round(max(all_vals), 6),
    }


def run_seasonality_backtest(
    dates: list[str],
    values: list[float],
    rule: dict,
) -> dict:
    """
    rule = {
        "type": "dow" | "month" | "dom_quintile" | "tom" | "quarter_end",
        "bins": [int, ...],
        "direction": 1 | -1,
    }
    """
    df = _build_day_df(dates, values)
    bins: list[int] = rule.get("bins", [])
    direction: int = rule.get("direction", 1)
    rule_type: str = rule.get("type", "dow")

    # Build signal
    if rule_type == "dow":
        mask = df["dow"].isin(bins)
    elif rule_type == "month":
        mask = df["month"].isin(bins)
    elif rule_type == "dom_quintile":
        mask = df["domQ"].isin(bins)
    elif rule_type == "tom":
        mask = df["tomOffset"].isin(bins)
    elif rule_type == "quarter_end":
        mask = df["qeOffset"].isin(bins)
    else:
        mask = pd.Series(False, index=df.index)

    strat = np.where(mask.values, direction * df["ret"].values, 0.0)
    bnh   = df["ret"].values

    # Equity curves (subsample every 5 days for payload size)
    strat_cum = np.cumsum(strat)
    bnh_cum   = np.cumsum(bnh)
    run_max   = np.maximum.accumulate(strat_cum)
    dd        = strat_cum - run_max

    step = 5
    eq_dates = [d.strftime("%Y-%m-%d") for d in df["date"].values[::step]]
    eq_strat = [round(float(v), 4) for v in strat_cum[::step]]
    eq_bnh   = [round(float(v), 4) for v in bnh_cum[::step]]
    eq_dd    = [round(float(v), 4) for v in dd[::step]]

    # Annual breakdown
    years = pd.DatetimeIndex(df["date"]).year
    annual = []
    for yr in sorted(set(years)):
        ym = years == yr
        ys, yb = strat[ym], bnh[ym]
        active = ys[ys != 0]
        vol = float(active.std()) * math.sqrt(252) if len(active) > 1 else 0.0
        ann_ret = float(ys.mean()) * 252
        sharpe = ann_ret / vol if vol > 0 else 0.0
        annual.append({
            "year": int(yr),
            "strat_total": round(float(ys.sum()), 4),
            "bnh_total":   round(float(yb.sum()), 4),
            "sharpe":      round(sharpe, 3),
            "win_rate":    round(float((active > 0).mean()), 4) if len(active) > 0 else 0.5,
            "n_trades":    int((ys != 0).sum()),
        })

    # Overall metrics
    active_all = strat[strat != 0]
    ann_ret_all = float(strat.mean()) * 252
    vol_all = float(active_all.std()) * math.sqrt(252) if len(active_all) > 1 else 0.0
    sharpe_all = ann_ret_all / vol_all if vol_all > 0 else 0.0

    return {
        "rule": rule,
        "metrics": {
            "total_return":    round(float(strat_cum[-1]), 4),
            "ann_return":      round(ann_ret_all, 4),
            "sharpe":          round(sharpe_all, 3),
            "max_drawdown":    round(float(dd.min()), 4),
            "win_rate":        round(float((active_all > 0).mean()), 4) if len(active_all) > 0 else 0.5,
            "days_in_market":  int((strat != 0).sum()),
            "pct_in_market":   round(float((strat != 0).mean()), 4),
        },
        "equity_curve": {
            "dates":       eq_dates,
            "strategy":    eq_strat,
            "buy_and_hold": eq_bnh,
            "drawdown":    eq_dd,
        },
        "annual": annual,
    }
