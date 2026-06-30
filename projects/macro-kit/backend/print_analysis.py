"""
Print Analysis — Bloomberg economic release fetcher.

Fetches a Bloomberg economic indicator's historical release history alongside
the corresponding Bloomberg survey (consensus) data, computes surprises, and
returns a structured response for the Print vs Consensus tab.

Bloomberg fields used
---------------------
  PX_LAST           — realised/actual release value
  ECO_SURVEY_AVG    — consensus average (pre-release Bloomberg survey)
  ECO_SURVEY_MEDIAN — consensus median
  ECO_SURVEY_HIGH   — high estimate
  ECO_SURVEY_LOW    — low estimate
  BN_SURVEY_NUMBER  — number of survey respondents

Note: field availability depends on the ticker and Bloomberg subscription.
Missing survey fields are returned as null and excluded from derived stats.
"""

from __future__ import annotations

import warnings
from typing import Any

import numpy as np
import pandas as pd


# Survey fields requested from Bloomberg (in addition to PX_LAST)
_SURVEY_FIELDS = {
    "avg":    "ECO_SURVEY_AVG",
    "median": "ECO_SURVEY_MEDIAN",
    "high":   "ECO_SURVEY_HIGH",
    "low":    "ECO_SURVEY_LOW",
    "n":      "BN_SURVEY_NUMBER",
}


def _safe_float(val: Any) -> float | None:
    """Return a Python float, or None for NaN / non-numeric values."""
    try:
        f = float(val)
        return None if np.isnan(f) else round(f, 6)
    except (TypeError, ValueError):
        return None


def _safe_int(val: Any) -> int | None:
    """Return a Python int, or None for NaN / non-numeric values."""
    try:
        f = float(val)
        return None if np.isnan(f) else int(round(f))
    except (TypeError, ValueError):
        return None


def _simulate_releases(ticker: str, start: str) -> dict:
    """
    Generate realistic synthetic monthly release data for UI testing.
    Seeded by ticker so different tickers produce different series.
    """
    rng = np.random.default_rng(abs(hash(ticker)) % (2**31))

    # Simulate a mean-reverting level series (e.g. CPI YoY, PMI, etc.)
    start_ts = pd.Timestamp(start)
    end_ts   = pd.Timestamp.today()
    dates    = pd.date_range(start_ts, end_ts, freq="MS")  # first of each month

    n = len(dates)
    if n == 0:
        return {"ticker": ticker, "releases": [], "summary": _empty_summary()}

    # Series level: AR(1) around a slowly drifting mean
    level = np.zeros(n)
    level[0] = rng.uniform(2.0, 5.0)
    drift = rng.uniform(-0.02, 0.02)
    ar    = 0.92
    for i in range(1, n):
        level[i] = ar * level[i - 1] + (1 - ar) * (level[0] + drift * i) + rng.normal(0, 0.15)

    # Consensus: level + small bias + noise
    consensus_bias = rng.uniform(-0.05, 0.05)
    avg    = level + consensus_bias + rng.normal(0, 0.08, n)
    median = avg    + rng.normal(0, 0.04, n)
    spread = np.abs(rng.normal(0.3, 0.1, n))
    high   = avg + spread
    low    = avg - spread
    n_surv = rng.integers(20, 55, n)

    surprise = level - avg

    # Z-score: full-sample normalisation
    surp_std = surprise.std()
    z_score  = (surprise - surprise.mean()) / surp_std if surp_std > 1e-9 else np.zeros(n)

    # Simulated release dates: reference period end + 30–55 days (typical lag)
    release_lags = rng.integers(30, 56, n)

    releases = []
    for i in range(n - 1, -1, -1):   # reverse-chronological
        ref_date     = dates[i]
        release_date = ref_date + pd.Timedelta(days=int(release_lags[i]))
        releases.append({
            "date":         ref_date.strftime("%Y-%m-%d"),
            "release_date": release_date.strftime("%Y-%m-%d"),
            "actual":       round(float(level[i]),   2),
            "avg":          round(float(avg[i]),      2),
            "median":       round(float(median[i]),   2),
            "high":         round(float(high[i]),     2),
            "low":          round(float(low[i]),      2),
            "n":            int(n_surv[i]),
            "surprise":     round(float(surprise[i]), 2),
            "z_score":      round(float(z_score[i]),  2),
        })

    surp_series = pd.Series(surprise)
    summary = _compute_summary(n, surp_series)
    return {"ticker": f"{ticker} [simulated]", "releases": releases, "summary": summary}


def fetch_print_vs_consensus(
    ticker: str,
    start: str = "2010-01-01",
) -> dict:
    """
    Fetch historical economic prints + Bloomberg survey consensus for a ticker.

    Parameters
    ----------
    ticker : Bloomberg ticker including yellow key, e.g. "UKPRIC YOY Index"
    start  : start date "YYYY-MM-DD"

    Returns
    -------
    {
        "ticker":   str,
        "releases": [
            {
                "date":     "YYYY-MM-DD",
                "actual":   float | null,
                "avg":      float | null,   # consensus average
                "median":   float | null,
                "high":     float | null,
                "low":      float | null,
                "n":        int   | null,   # number of survey respondents
                "surprise": float | null,   # actual − consensus avg
                "z_score":  float | null,   # surprise normalised by full-sample std
            },
            ...
        ],
        "summary": {
            "n_releases":     int,
            "mean_surprise":  float | null,
            "std_surprise":   float | null,
            "pct_beats":      float | null,   # surprise > 0
            "pct_misses":     float | null,   # surprise < 0
            "pct_inline":     float | null,   # surprise == 0
        }
    }
    """
    try:
        from bbg import blp
    except ImportError:
        # Bloomberg not available — fall back to simulated data for UI testing
        return _simulate_releases(ticker, start)

    today = pd.Timestamp.today().strftime("%Y-%m-%d")
    ticker = ticker.strip()

    all_fields = ["PX_LAST", "ECO_RELEASE_DT"] + list(_SURVEY_FIELDS.values())

    try:
        df = blp.bdh(
            tickers=[ticker],
            flds=all_fields,
            start_date=start,
            end_date=today,
        )
    except Exception:
        # Terminal not running or connection failed — fall back to simulated data
        return _simulate_releases(ticker, start)

    if df.empty:
        return {"ticker": ticker, "releases": [], "summary": _empty_summary()}

    # Normalise MultiIndex columns → flat field names
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = [col[1] for col in df.columns]

    if "PX_LAST" not in df.columns:
        raise RuntimeError(
            f"Bloomberg returned no PX_LAST data for '{ticker}'. "
            "Check the ticker spelling and yellow key."
        )

    # Keep only rows where an actual value was released
    df = df[df["PX_LAST"].notna()].copy()
    df.index = pd.to_datetime(df.index)

    if df.empty:
        return {"ticker": ticker, "releases": [], "summary": _empty_summary()}

    # Surprise = actual − consensus average
    avg_col = _SURVEY_FIELDS["avg"]
    if avg_col in df.columns and df[avg_col].notna().any():
        df["surprise"] = df["PX_LAST"] - df[avg_col]
    else:
        df["surprise"] = np.nan

    # Z-score: (surprise − full-sample mean) / full-sample std
    surp = df["surprise"].dropna()
    if len(surp) >= 3:
        df["z_score"] = (df["surprise"] - surp.mean()) / surp.std()
    else:
        df["z_score"] = np.nan

    # Build release records (reverse-chronological)
    releases = []
    for date, row in df.sort_index(ascending=False).iterrows():
        # ECO_RELEASE_DT may come back as a date string or Timestamp
        raw_rdt = row.get("ECO_RELEASE_DT")
        try:
            release_date = pd.Timestamp(raw_rdt).strftime("%Y-%m-%d") if pd.notna(raw_rdt) else None
        except Exception:
            release_date = None

        rec: dict[str, Any] = {
            "date":         date.strftime("%Y-%m-%d"),
            "release_date": release_date,
            "actual":       _safe_float(row.get("PX_LAST")),
            "surprise":     _safe_float(row.get("surprise")),
            "z_score":      _safe_float(row.get("z_score")),
        }
        for key, field in _SURVEY_FIELDS.items():
            col_val = row.get(field)
            rec[key] = _safe_int(col_val) if key == "n" else _safe_float(col_val)
        releases.append(rec)

    # Summary statistics
    summary = _compute_summary(len(df), surp)

    return {"ticker": ticker, "releases": releases, "summary": summary}


def _simulate_market_reaction(ticker: str, valid: list[tuple]) -> dict:
    """Generate synthetic market moves correlated with surprises (for UI testing)."""
    rng = np.random.default_rng(abs(hash(ticker)) % (2**31))
    surprises = np.array([r[2] for r in valid])
    n = len(surprises)

    slope     = rng.uniform(2.0, 5.0)   # market units per unit surprise
    noise_std = rng.uniform(2.5, 7.0)
    intercept = rng.uniform(-0.5, 0.5)

    moves = slope * surprises + intercept + rng.normal(0, noise_std, n)

    reactions = [
        {"period": period, "release_date": rdate, "market_move": round(float(moves[i]), 3)}
        for i, (rdate, period, _) in enumerate(valid)
    ]
    return {"market_ticker": f"{ticker} [simulated]", "reactions": reactions}


def fetch_market_reaction(market_ticker: str, releases: list[dict]) -> dict:
    """
    For each release, compute the market instrument's day-of-release move
    (close on release_date minus close on prior business day).

    Parameters
    ----------
    market_ticker : Bloomberg ticker, e.g. "GDBR10 Index"
    releases      : list of {"period": str, "release_date": str, "surprise": float}

    Returns
    -------
    {
        "market_ticker": str,
        "reactions": [
            {"period": str, "release_date": str, "market_move": float},
            ...
        ]
    }
    """
    ticker = market_ticker.strip()

    valid = [
        (r["release_date"], r["period"], float(r["surprise"]))
        for r in releases
        if r.get("release_date") and r.get("surprise") is not None
    ]
    if not valid:
        return {"market_ticker": ticker, "reactions": []}

    try:
        from bbg import blp
    except ImportError:
        return _simulate_market_reaction(ticker, valid)

    try:
        release_dates = [pd.Timestamp(r[0]) for r in valid]
        start = (min(release_dates) - pd.Timedelta(days=10)).strftime("%Y-%m-%d")
        end   = min(pd.Timestamp.today(), max(release_dates) + pd.Timedelta(days=5)).strftime("%Y-%m-%d")

        df = blp.bdh(tickers=[ticker], flds=["PX_LAST"], start_date=start, end_date=end)
        if df.empty:
            return _simulate_market_reaction(ticker, valid)

        if isinstance(df.columns, pd.MultiIndex):
            df.columns = [col[1] for col in df.columns]

        prices = df["PX_LAST"].dropna()
        prices.index = pd.to_datetime(prices.index)
        trading_days = prices.index.sort_values()

        reactions = []
        for rdate_str, period_str, _ in valid:
            rd_ts = pd.Timestamp(rdate_str)
            fwd = trading_days[trading_days >= rd_ts]
            if not len(fwd):
                continue
            rd = fwd[0]
            bwd = trading_days[trading_days < rd]
            if not len(bwd):
                continue
            prev_rd = bwd[-1]
            move = float(prices[rd] - prices[prev_rd])
            reactions.append({"period": period_str, "release_date": rdate_str,
                               "market_move": round(move, 4)})

        return {"market_ticker": ticker, "reactions": reactions}

    except Exception:
        return _simulate_market_reaction(ticker, valid)


def _empty_summary() -> dict:
    return {
        "n_releases":    0,
        "mean_surprise": None,
        "std_surprise":  None,
        "pct_beats":     None,
        "pct_misses":    None,
        "pct_inline":    None,
    }


def _compute_summary(n_releases: int, surp: pd.Series) -> dict:
    if surp.empty:
        return {**_empty_summary(), "n_releases": n_releases}

    n = len(surp)
    n_beats  = int((surp > 0).sum())
    n_misses = int((surp < 0).sum())
    n_inline = int((surp == 0).sum())

    return {
        "n_releases":    n_releases,
        "mean_surprise": _safe_float(surp.mean()),
        "std_surprise":  _safe_float(surp.std()),
        "pct_beats":     round(100 * n_beats  / n, 1),
        "pct_misses":    round(100 * n_misses / n, 1),
        "pct_inline":    round(100 * n_inline / n, 1),
    }
