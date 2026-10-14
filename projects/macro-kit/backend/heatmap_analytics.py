"""
Pure analytics behind the regional heatmap dashboard (no I/O, no state).

Ported from the per-region frontend pages so that the backend is the single
source of truth: curve and breakeven regime classification, look-back
frequency tables, regime dispersion, scenario probabilities, curve fair-value
residuals and factor summary statistics. RegionalHeatmap.get_dashboard()
feeds these with the engine's yields, factors and regressions.

Conventions (unchanged from the pages):
- A day with |Δ long yield| < 1e-7 is unclassified and skipped.
- Curve regimes from Δ long yield and Δ(long − short) spread:
  bull_steep (Δy<0, Δs>0), bull_flat (Δy<0, Δs≤0),
  bear_steep (Δy>0, Δs>0), bear_flat (Δy>0, Δs≤0).
- Breakeven regimes from Δ nominal yield and Δ breakeven:
  expansion (Δy>0, ΔBE>0), slowdown (Δy<0, ΔBE<0),
  stagflation (Δy<0, ΔBE>0), goldilocks (otherwise).
- Percentages are rounded to whole numbers per regime.
"""
from __future__ import annotations

import math

import numpy as np

ROLL_DAYS = 63                       # ~3 months of business days
LOOKBACKS = (("2w", 10), ("1m", 21), ("2m", 42), ("3m", 63))
_EPS = 1e-7
_DISP_MAX = math.sqrt(1875)          # dispersion of (100, 0, 0, 0) around 25

CURVE_REGIMES = ("bull_steep", "bull_flat", "bear_steep", "bear_flat")
BE_REGIMES = ("expansion", "slowdown", "stagflation", "goldilocks")
SCENARIOS = ("hard_landing", "soft_landing", "no_landing", "reacceleration")


# ---------------------------------------------------------------------------
# Daily regime labels
# ---------------------------------------------------------------------------

def curve_regime_labels(long: np.ndarray, short: np.ndarray) -> np.ndarray:
    """Per-day regime index (0..3 in CURVE_REGIMES order, -1 = unclassified) for days 1..n-1."""
    d_long = np.diff(long)
    d_spread = np.diff(long - short)
    labels = np.where(d_long < 0,
                      np.where(d_spread > 0, 0, 1),
                      np.where(d_spread > 0, 2, 3))
    return np.where(np.abs(d_long) < _EPS, -1, labels)


def be_regime_labels(nominal: np.ndarray, breakeven: np.ndarray) -> np.ndarray:
    """Per-day regime index (0..3 in BE_REGIMES order, -1 = unclassified) for days 1..n-1."""
    d_y = np.diff(nominal)
    d_be = np.diff(breakeven)
    labels = np.where((d_y > 0) & (d_be > 0), 0,
                      np.where((d_y < 0) & (d_be < 0), 1,
                               np.where((d_y < 0) & (d_be > 0), 2, 3)))
    return np.where(np.abs(d_y) < _EPS, -1, labels)


def _shares(counts: np.ndarray) -> list[int]:
    total = counts.sum() or 1
    return [int(round(c / total * 100)) for c in counts]


def dispersion(shares: list[int] | tuple[int, ...]) -> float:
    """Normalised dispersion of four regime shares, 0 (uniform) .. 100 (one regime)."""
    sigma = math.sqrt(sum((p - 25) ** 2 for p in shares) / 4)
    return round(sigma / _DISP_MAX * 100, 1)


def rolling_shares(labels: np.ndarray, window: int = ROLL_DAYS) -> np.ndarray:
    """
    [n_points, 4] regime shares (%) over a trailing window of daily labels.

    Point j covers labels[j : j + window], i.e. price days j+1 .. j+window,
    matching the pages' loop `for t in ROLL_DAYS..n-1: i in t-ROLL_DAYS+1..t`.
    """
    onehot = np.stack([(labels == k).astype(int) for k in range(4)], axis=1)
    csum = np.vstack([np.zeros((1, 4), dtype=int), np.cumsum(onehot, axis=0)])
    counts = csum[window:] - csum[:-window]
    totals = counts.sum(axis=1, keepdims=True)
    totals[totals == 0] = 1
    # Same rounding as Math.round on non-negative values (half up).
    return np.floor(counts / totals * 100 + 0.5).astype(int)


def lookback_table(labels: np.ndarray, keys: tuple[str, ...]) -> list[dict]:
    """Regime shares over the last 2w/1m/2m/3m, plus dispersion."""
    rows = []
    for horizon, days in LOOKBACKS:
        window = labels[-days:]
        counts = np.array([(window == k).sum() for k in range(4)])
        shares = _shares(counts)
        rows.append({"horizon": horizon, **dict(zip(keys, shares)), "dispersion": dispersion(shares)})
    return rows


# ---------------------------------------------------------------------------
# Scenario probabilities
# ---------------------------------------------------------------------------

def _normalise(raw: list[float]) -> dict:
    total = sum(raw) or 1
    return {k: int(round(v / total * 100)) for k, v in zip(SCENARIOS, raw)}


def curve_scenarios(bull_steep: float, bull_flat: float, bear_steep: float, bear_flat: float) -> dict:
    """Bull steep → hard landing; bull flat → soft (0.7) / no landing (0.3);
    bear steep → no landing / reacceleration (0.5 each); bear flat → reacceleration."""
    return _normalise([bull_steep,
                       0.7 * bull_flat,
                       0.3 * bull_flat + 0.5 * bear_steep,
                       0.5 * bear_steep + bear_flat])


def be_scenarios(expansion: float, slowdown: float, stagflation: float, goldilocks: float) -> dict:
    """Slowdown → hard (0.6) / soft (0.4); goldilocks → soft / no landing (0.5 each);
    expansion → no landing (0.4) / reacceleration (0.6); stagflation → hard / reacceleration (0.5 each)."""
    return _normalise([0.6 * slowdown + 0.5 * stagflation,
                       0.4 * slowdown + 0.5 * goldilocks,
                       0.4 * expansion + 0.5 * goldilocks,
                       0.6 * expansion + 0.5 * stagflation])


# ---------------------------------------------------------------------------
# Curve regime and breakeven sections
# ---------------------------------------------------------------------------

def curve_regime_section(dates: list[str], long: np.ndarray, short: np.ndarray, name: str) -> dict:
    labels = curve_regime_labels(long, short)
    shares = rolling_shares(labels)
    disp = [dispersion(tuple(row)) for row in shares]
    return {
        "name": name,
        "dates": dates[ROLL_DAYS:],
        **{k: shares[:, i].tolist() for i, k in enumerate(CURVE_REGIMES)},
        "dispersion": disp,
        "dispersion_avg": round(float(np.mean(disp)), 1),
        "lookbacks": lookback_table(labels, CURVE_REGIMES),
    }


def breakeven_section(dates: list[str], nominal: np.ndarray, breakeven: np.ndarray, source: str) -> dict:
    labels = be_regime_labels(nominal, breakeven)
    shares = rolling_shares(labels)
    disp = [dispersion(tuple(row)) for row in shares]
    return {
        "source": source,
        "dates": dates,
        "breakeven": np.round(breakeven, 4).tolist(),
        "regime_dates": dates[ROLL_DAYS:],
        **{k: shares[:, i].tolist() for i, k in enumerate(BE_REGIMES)},
        "dispersion": disp,
        "dispersion_avg": round(float(np.mean(disp)), 1),
        "lookbacks": lookback_table(labels, BE_REGIMES),
    }


def scenario_section(curve: dict, be: dict) -> dict:
    """Current (3m look-back) and rolling scenario probabilities from both signals."""
    c3 = next(r for r in curve["lookbacks"] if r["horizon"] == "3m")
    b3 = next(r for r in be["lookbacks"] if r["horizon"] == "3m")
    rolling_curve = [curve_scenarios(*(curve[k][i] for k in CURVE_REGIMES)) for i in range(len(curve["dates"]))]
    rolling_be = [be_scenarios(*(be[k][i] for k in BE_REGIMES)) for i in range(len(be["regime_dates"]))]
    return {
        "current": {"curve": curve_scenarios(*(c3[k] for k in CURVE_REGIMES)),
                    "breakeven": be_scenarios(*(b3[k] for k in BE_REGIMES))},
        "dates": curve["dates"],
        "curve": {s: [p[s] for p in rolling_curve] for s in SCENARIOS},
        "breakeven": {s: [p[s] for p in rolling_be] for s in SCENARIOS},
    }


# ---------------------------------------------------------------------------
# Fair value and factor summaries
# ---------------------------------------------------------------------------

def _resid_stats(resid_bp: np.ndarray) -> tuple[float, float]:
    last = float(resid_bp[-1])
    std = float(resid_bp.std())          # population std, as in the pages
    return last, std


def curve_fair_value_table(tenors: list[str], yields: np.ndarray, fair: np.ndarray,
                           outrights: tuple[str, ...] = ("2y", "5y", "10y", "30y"),
                           spreads: tuple[tuple[str, str], ...] = (("2y", "10y"), ("5y", "30y"))) -> list[dict]:
    """
    Current level, macro fair value, residual (bp), residual std (bp) and
    z-score for outright tenors and curve spreads present in ``tenors``.
    ``yields`` / ``fair`` are [T, n_tenors] in percent.
    """
    rows = []
    for t in outrights:
        if t not in tenors:
            continue
        j = tenors.index(t)
        resid = (yields[:, j] - fair[:, j]) * 100
        last, std = _resid_stats(resid)
        rows.append({"label": t, "is_spread": False,
                     "current": round(float(yields[-1, j]), 4), "fair_value": round(float(fair[-1, j]), 4),
                     "resid_bp": round(last, 2), "std_bp": round(std, 2),
                     "zscore": round(last / std, 3) if std > 0 else 0.0})
    for short, long in spreads:
        if short not in tenors or long not in tenors:
            continue
        s, l = tenors.index(short), tenors.index(long)
        actual = (yields[:, l] - yields[:, s]) * 100
        fv = (fair[:, l] - fair[:, s]) * 100
        resid = actual - fv
        last, std = _resid_stats(resid)
        rows.append({"label": f"{short[:-1]}s{long[:-1]}s", "is_spread": True,
                     "current": round(float(actual[-1]), 2), "fair_value": round(float(fv[-1]), 2),
                     "resid_bp": round(last, 2), "std_bp": round(std, 2),
                     "zscore": round(last / std, 3) if std > 0 else 0.0})
    return rows


def factor_summary(series: np.ndarray, days_1m: int = 21) -> dict:
    """Latest level, 1m/3m/12m changes and z-score (vs sample) of a daily factor."""
    cur = float(series[-1])

    def change(months: int) -> float | None:
        lag = days_1m * months
        return round(cur - float(series[-1 - lag]), 4) if len(series) > lag else None

    std = float(series.std())
    return {"current": round(cur, 4), "d1m": change(1), "d3m": change(3), "d12m": change(12),
            "zscore": round((cur - float(series.mean())) / std, 3) if std > 0 else 0.0}
