"""
Correlation Regimes — cross-asset correlation-breakdown scanner.

Methodology
-----------
Goal: find pairs of variables whose recent strong relationship has broken down.

1. Universe: defined in data/series_catalogue_correlation_regimes.json.
   Each series has a transform — 'diff' (daily change, bp/pts) for yields,
   spreads and vol indices; 'logret' (daily log-return, %) for prices.
   Correlations are ALWAYS computed on transformed series, never levels
   (level correlations of trending series are spurious).

2. Dual-window design:
     regime window  — the `long_window` (default 126) business days that
                      PRECEDE the recent window. Establishes the "normal"
                      relationship rho_long.
     recent window  — the last `short_window` (default 21) business days.
                      Current relationship rho_short.
   The windows are disjoint so recent data cannot contaminate the regime
   estimate.

3. Qualification: only pairs with |rho_long| >= min_abs_corr (default 0.6)
   are candidates — these are the "recent strong relationships".

4. Breakdown score — Fisher z test for the difference of two correlations:

     z = (atanh(rho_short) - atanh(rho_long)) / sqrt(1/(n_s-3) + 1/(n_l-3))

   Signed such that positive z_break = weakening (movement of rho toward
   zero / opposite sign). This properly penalises short-window noise:
   0.8 -> 0.3 ranks above 0.65 -> 0.5.

5. Betas: OLS beta of y-changes on x-changes over each window. A pair can
   stay correlated while the beta shifts materially — also a regime change,
   reported alongside.

Data
----
Bloomberg daily PX_LAST when ANALYTICS_DATA_SOURCE=bloomberg, otherwise a
factor-model simulation with regime breaks deliberately embedded in the last
~8 weeks (so the tool demonstrates real breakdowns). Downstream analytics are
source-agnostic: both paths produce a levels DataFrame that is then
transformed per the catalogue.
"""
from __future__ import annotations

import json
import math
import os
import warnings
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd

# ─── Catalogue ────────────────────────────────────────────────────────────────

_CATALOGUE_PATH = Path(__file__).parent / "data" / "series_catalogue_correlation_regimes.json"
_CATALOGUE: dict | None = None


def _load_catalogue() -> dict:
    global _CATALOGUE
    if _CATALOGUE is None:
        with open(_CATALOGUE_PATH, "r") as fh:
            _CATALOGUE = json.load(fh)
    return _CATALOGUE


def _series_meta() -> list[dict]:
    return _load_catalogue()["series"]


def _defaults() -> dict:
    return _load_catalogue()["defaults"]


# ─── Bloomberg fetch ──────────────────────────────────────────────────────────


def _bloomberg_levels(history_days: int) -> Optional[pd.DataFrame]:
    """Fetch daily levels for the whole universe. Columns = series ids."""
    try:
        from bbg import blp  # type: ignore
    except ImportError:
        return None

    meta = _series_meta()
    tickers = [s["ticker"] for s in meta]
    end = pd.Timestamp.today().normalize()
    start = end - pd.Timedelta(days=int(history_days * 1.6))

    try:
        df = blp.bdh(tickers, "PX_LAST",
                     start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d"),
                     Per="D")
        if df is None or df.empty:
            return None
        if isinstance(df.columns, pd.MultiIndex):
            df = df.xs("PX_LAST", axis=1, level=1)
        missing = [t for t in tickers if t not in df.columns]
        if missing:
            warnings.warn(f"[correlation_regimes] Bloomberg missing: {missing}",
                          stacklevel=2)
            return None
        rename = {s["ticker"]: s["id"] for s in meta}
        df = df[tickers].rename(columns=rename).ffill().dropna()
        if len(df) < 200:
            return None
        return df.tail(history_days)
    except Exception as exc:
        warnings.warn(f"[correlation_regimes] Bloomberg bdh failed: {exc}",
                      stacklevel=2)
        return None


# ─── Simulation ───────────────────────────────────────────────────────────────

# Factor loadings [risk, rates, usd, inflation] per series, plus daily vol
# target in native transform units (bp, pts, or % logret).
_SIM_LOADINGS: dict[str, tuple[list[float], float]] = {
    "ust_2y":   ([ 0.15,  0.90,  0.10,  0.30], 4.5),
    "ust_10y":  ([ 0.10,  0.95,  0.05,  0.35], 6.0),
    "ust_30y":  ([ 0.05,  0.90,  0.00,  0.30], 6.5),
    "bund_2y":  ([ 0.10,  0.75,  0.00,  0.25], 4.0),
    "bund_10y": ([ 0.05,  0.85, -0.05,  0.30], 5.5),
    "btp_10y":  ([-0.20,  0.80, -0.05,  0.25], 6.5),
    "gilt_10y": ([ 0.05,  0.80,  0.00,  0.30], 6.0),
    "jgb_10y":  ([ 0.05,  0.45,  0.05,  0.15], 2.0),
    "eurusd":   ([ 0.25, -0.20, -0.90,  0.05], 0.55),
    "gbpusd":   ([ 0.30, -0.15, -0.80,  0.05], 0.60),
    "usdjpy":   ([ 0.30,  0.45,  0.55,  0.10], 0.65),
    "audusd":   ([ 0.50, -0.10, -0.70,  0.20], 0.70),
    "dxy":      ([-0.20,  0.20,  0.95, -0.05], 0.45),
    "spx":      ([ 0.95,  -0.15, -0.05,  0.00], 1.00),
    "ndx":      ([ 0.90, -0.35, -0.05, -0.05], 1.30),
    "sx5e":     ([ 0.90, -0.10, -0.15,  0.05], 1.10),
    "dax":      ([ 0.88, -0.12, -0.15,  0.05], 1.15),
    "nky":      ([ 0.80,  0.05,  0.30,  0.05], 1.20),
    "ftse":     ([ 0.85, -0.05, -0.05,  0.15], 0.95),
    "vix":      ([-0.90,  0.05,  0.05,  0.00], 1.60),
    "move":     ([-0.35,  0.55,  0.10,  0.15], 4.00),
    "wti":      ([ 0.35,  0.10, -0.15,  0.75], 2.20),
    "brent":    ([ 0.35,  0.10, -0.15,  0.75], 2.10),
    "gold":     ([-0.10, -0.55, -0.55,  0.35], 0.95),
    "copper":   ([ 0.55, -0.05, -0.35,  0.45], 1.40),
    "us_be10":  ([ 0.35,  0.30, -0.10,  0.85], 3.50),
    "eu_5y5y":  ([ 0.25,  0.25, -0.10,  0.75], 2.50),
    "itraxx":   ([-0.85,  0.10,  0.05, -0.05], 2.50),
}

# Regime breaks: in the last `break_days` the listed series switch to new
# loadings — deliberately decoupling them from their historical drivers so the
# scanner has genuine breakdowns to find.
_SIM_BREAK_DAYS = 40
_SIM_BREAK_LOADINGS: dict[str, list[float]] = {
    # Gold decouples from USD/rates — idiosyncratic safe-haven bid
    "gold":    [0.05, 0.05, -0.05, 0.10],
    # BTP decouples from the rates complex — idiosyncratic spread widening
    "btp_10y": [-0.15, 0.15, -0.05, 0.05],
    # EUR/USD loses its USD-factor beta and flips rates sensitivity
    "eurusd":  [0.10, 0.30, -0.20, 0.05],
    # Nasdaq sheds its rates sensitivity (duration trade unwinds)
    "ndx":     [0.85, 0.15, -0.05, -0.05],
    # MOVE decouples from the risk factor
    "move":    [0.05, 0.20, 0.05, 0.05],
}


def _simulate_universe(history_days: int, seed: int = 20260903) -> pd.DataFrame:
    """
    Simulate daily LEVELS for the whole universe via a 4-factor model on
    daily changes, with regime breaks in the final _SIM_BREAK_DAYS days.
    """
    meta = _series_meta()
    ids = [s["id"] for s in meta]
    n = history_days
    rng = np.random.default_rng(seed)

    # Factor paths: AR(1) daily shocks with mild persistence
    n_factors = 4
    phi = np.array([0.10, 0.15, 0.10, 0.20])
    factors = np.zeros((n, n_factors))
    shocks = rng.standard_normal((n, n_factors))
    for t in range(1, n):
        factors[t] = phi * factors[t - 1] + shocks[t]

    changes = np.zeros((n, len(ids)))
    for j, sid in enumerate(ids):
        loadings, vol = _SIM_LOADINGS.get(sid, ([0.0, 0.0, 0.0, 0.0], 1.0))
        L_pre = np.array(loadings)
        L_post = np.array(_SIM_BREAK_LOADINGS.get(sid, loadings))

        idio = rng.standard_normal(n)
        raw = np.empty(n)
        brk = n - _SIM_BREAK_DAYS
        # systematic + idiosyncratic; idio weight keeps R2 realistic (~50-80%)
        for t in range(n):
            L = L_pre if t < brk else L_post
            sys = float(factors[t] @ L)
            sys_scale = float(np.linalg.norm(L))
            idio_w = max(0.35, math.sqrt(max(1e-6, 1.0 - min(sys_scale, 0.95) ** 2)))
            raw[t] = sys + idio_w * idio[t]
        raw = raw / max(np.std(raw), 1e-9) * vol
        changes[:, j] = raw

    # Business-day index ending today
    end = pd.Timestamp.today().normalize()
    dates = pd.bdate_range(end=end, periods=n)
    chg = pd.DataFrame(changes, index=dates, columns=ids)

    # Build levels from changes per transform
    base_levels = {
        "ust_2y": 3.9, "ust_10y": 4.2, "ust_30y": 4.5, "bund_2y": 2.2,
        "bund_10y": 2.5, "btp_10y": 3.6, "gilt_10y": 4.1, "jgb_10y": 1.0,
        "eurusd": 1.09, "gbpusd": 1.27, "usdjpy": 148.0, "audusd": 0.66,
        "dxy": 103.0, "spx": 5600.0, "ndx": 19800.0, "sx5e": 4900.0,
        "dax": 18500.0, "nky": 38500.0, "ftse": 8200.0, "vix": 15.0,
        "move": 95.0, "wti": 78.0, "brent": 82.0, "gold": 2400.0,
        "copper": 4.3, "us_be10": 2.3, "eu_5y5y": 2.2, "itraxx": 55.0,
    }
    levels = pd.DataFrame(index=dates, columns=ids, dtype=float)
    tmap = {s["id"]: s["transform"] for s in meta}
    for sid in ids:
        base = base_levels.get(sid, 100.0)
        if tmap[sid] == "logret":
            # changes are % log-returns
            levels[sid] = base * np.exp(np.cumsum(chg[sid].values) / 100.0)
        else:
            # changes are bp (rates/spreads) or pts (vol) — levels in % / pts
            unit = 0.01 if sid not in ("vix", "move") else 1.0
            levels[sid] = base + np.cumsum(chg[sid].values) * unit
    return levels


# ─── Data loading + transforms ────────────────────────────────────────────────

_LEVELS_CACHE: pd.DataFrame | None = None
_CACHE_SOURCE: str = ""


def _load_levels(history_days: int) -> tuple[pd.DataFrame, str]:
    global _LEVELS_CACHE, _CACHE_SOURCE
    if _LEVELS_CACHE is not None and len(_LEVELS_CACHE) >= min(history_days, 200):
        return _LEVELS_CACHE, _CACHE_SOURCE

    source = "simulation"
    levels: pd.DataFrame | None = None
    if os.environ.get("ANALYTICS_DATA_SOURCE", "csv").lower() == "bloomberg":
        levels = _bloomberg_levels(history_days)
        if levels is not None:
            source = "bloomberg"
    if levels is None:
        levels = _simulate_universe(history_days)
        source = "simulation"

    _LEVELS_CACHE, _CACHE_SOURCE = levels, source
    return levels, source


def _transform(levels: pd.DataFrame) -> pd.DataFrame:
    """Levels -> daily changes per catalogue transform."""
    meta = _series_meta()
    out = {}
    for s in meta:
        sid = s["id"]
        if sid not in levels.columns:
            continue
        x = levels[sid]
        if s["transform"] == "logret":
            out[sid] = np.log(x / x.shift(1)) * 100.0          # % log-return
        else:
            unit = 100.0 if s["units"] == "bp" else 1.0
            out[sid] = x.diff() * unit                          # bp or pts
    return pd.DataFrame(out).dropna()


# ─── Statistics ───────────────────────────────────────────────────────────────


def _fisher_z_stat(rho_short: float, rho_long: float,
                   n_short: int, n_long: int) -> float:
    """Fisher z test statistic for the difference of two correlations."""
    r_s = float(np.clip(rho_short, -0.9999, 0.9999))
    r_l = float(np.clip(rho_long, -0.9999, 0.9999))
    se = math.sqrt(1.0 / max(n_short - 3, 1) + 1.0 / max(n_long - 3, 1))
    return (math.atanh(r_s) - math.atanh(r_l)) / se


def _ols_beta(x: np.ndarray, y: np.ndarray) -> tuple[float, float]:
    """Return (slope, intercept) of y ~ x."""
    vx = float(np.var(x))
    if vx < 1e-12:
        return 0.0, float(np.mean(y))
    slope = float(np.cov(x, y, ddof=1)[0, 1] / np.var(x, ddof=1))
    intercept = float(np.mean(y) - slope * np.mean(x))
    return slope, intercept


# ─── Public API: scan ─────────────────────────────────────────────────────────


def run_scan(
    long_window: Optional[int] = None,
    short_window: Optional[int] = None,
    min_abs_corr: Optional[float] = None,
) -> dict:
    """
    Scan every pair in the universe for correlation breakdowns.

    Regime window = `long_window` days preceding the recent window (disjoint).
    Recent window = last `short_window` days.
    """
    d = _defaults()
    long_window = int(long_window or d["long_window"])
    short_window = int(short_window or d["short_window"])
    min_abs_corr = float(min_abs_corr if min_abs_corr is not None else d["min_abs_corr"])
    history_days = int(d["history_days"])

    levels, source = _load_levels(history_days)
    chg = _transform(levels)

    need = long_window + short_window
    if len(chg) < need + 5:
        raise ValueError(
            f"Not enough history: need {need + 5} obs, have {len(chg)}"
        )

    meta = [s for s in _series_meta() if s["id"] in chg.columns]
    ids = [s["id"] for s in meta]
    meta_by_id = {s["id"]: s for s in meta}
    chg = chg[ids]

    recent = chg.iloc[-short_window:]
    regime = chg.iloc[-(short_window + long_window):-short_window]

    C_long = np.corrcoef(regime.values, rowvar=False)
    C_short = np.corrcoef(recent.values, rowvar=False)

    # Rolling short-window correlations for days_since_breakdown
    roll = chg.iloc[-(short_window + 90):]  # enough tail for the count

    pairs = []
    n_ids = len(ids)
    for i in range(n_ids):
        for j in range(i + 1, n_ids):
            rho_l = float(C_long[i, j])
            if abs(rho_l) < min_abs_corr or not np.isfinite(rho_l):
                continue
            rho_s = float(C_short[i, j])

            z = _fisher_z_stat(rho_s, rho_l, short_window, long_window)
            # Breakdown score: positive when correlation weakened toward
            # zero or flipped sign, regardless of the sign of rho_long
            z_break = -z if rho_l > 0 else z

            xi, yj = chg[ids[i]], chg[ids[j]]
            beta_l, _ = _ols_beta(regime[ids[i]].values, regime[ids[j]].values)
            beta_s, _ = _ols_beta(recent[ids[i]].values, recent[ids[j]].values)

            # Consecutive days (from today) that the rolling short-window
            # corr has been below the qualification threshold
            rc = xi.rolling(short_window).corr(yj).reindex(roll.index).dropna()
            days_since = 0
            for v in rc.values[::-1]:
                if np.isfinite(v) and abs(v) < min_abs_corr:
                    days_since += 1
                else:
                    break

            mi, mj = meta_by_id[ids[i]], meta_by_id[ids[j]]
            pairs.append({
                "x": ids[i], "y": ids[j],
                "x_label": mi["label"], "y_label": mj["label"],
                "x_class": mi["asset_class"], "y_class": mj["asset_class"],
                "rho_long": round(rho_l, 4),
                "rho_short": round(rho_s, 4),
                "delta": round(rho_s - rho_l, 4),
                "z_break": round(z_break, 3),
                "sign_flip": bool(rho_l * rho_s < 0),
                "beta_long": round(beta_l, 4),
                "beta_short": round(beta_s, 4),
                "days_since": days_since,
            })

    pairs.sort(key=lambda p: p["z_break"], reverse=True)

    dates = chg.index
    return {
        "data_source": source,
        "as_of": dates[-1].strftime("%Y-%m-%d"),
        "n_obs": len(chg),
        "long_window": long_window,
        "short_window": short_window,
        "min_abs_corr": min_abs_corr,
        "windows": {
            "regime": {
                "start": dates[-(short_window + long_window)].strftime("%Y-%m-%d"),
                "end": dates[-short_window - 1].strftime("%Y-%m-%d"),
            },
            "recent": {
                "start": dates[-short_window].strftime("%Y-%m-%d"),
                "end": dates[-1].strftime("%Y-%m-%d"),
            },
        },
        "series": [
            {"id": s["id"], "label": s["label"],
             "asset_class": s["asset_class"], "units": s["units"],
             "transform": s["transform"]}
            for s in meta
        ],
        "n_pairs_total": n_ids * (n_ids - 1) // 2,
        "n_pairs_qualified": len(pairs),
        "pairs": pairs,
        "matrix": {
            "ids": ids,
            "labels": [meta_by_id[s]["label"] for s in ids],
            "rho_long": [[round(float(v), 3) for v in row] for row in C_long],
            "rho_short": [[round(float(v), 3) for v in row] for row in C_short],
        },
    }


# ─── Public API: pair drilldown ───────────────────────────────────────────────


def get_pair_detail(
    x: str,
    y: str,
    long_window: Optional[int] = None,
    short_window: Optional[int] = None,
) -> dict:
    """
    Detail for one pair: rolling correlation/beta timeline and the
    regime-vs-recent scatter with OLS fits.
    """
    d = _defaults()
    long_window = int(long_window or d["long_window"])
    short_window = int(short_window or d["short_window"])
    history_days = int(d["history_days"])

    levels, source = _load_levels(history_days)
    chg = _transform(levels)

    meta_by_id = {s["id"]: s for s in _series_meta()}
    for sid in (x, y):
        if sid not in chg.columns:
            valid = list(chg.columns)
            raise ValueError(f"Unknown series id {sid!r}. Valid: {valid}")

    sx, sy = chg[x], chg[y]

    roll_s = sx.rolling(short_window).corr(sy)
    roll_l = sx.rolling(long_window).corr(sy)
    cov = sx.rolling(short_window).cov(sy)
    var = sx.rolling(short_window).var()
    roll_beta = cov / var.replace(0.0, np.nan)

    # Timeline: last ~1.5 long windows for context, subsampled if long
    tail = min(len(chg), long_window * 2 + short_window)
    idx = chg.index[-tail:]
    rolling = []
    for ts in idx:
        rs, rl, rb = roll_s.get(ts), roll_l.get(ts), roll_beta.get(ts)
        rolling.append({
            "date": ts.strftime("%Y-%m-%d"),
            "rho_short": round(float(rs), 4) if pd.notna(rs) else None,
            "rho_long": round(float(rl), 4) if pd.notna(rl) else None,
            "beta_short": round(float(rb), 4) if pd.notna(rb) else None,
        })

    recent = chg.iloc[-short_window:]
    regime = chg.iloc[-(short_window + long_window):-short_window]

    slope_l, int_l = _ols_beta(regime[x].values, regime[y].values)
    slope_s, int_s = _ols_beta(recent[x].values, recent[y].values)

    def _pts(df: pd.DataFrame) -> list[dict]:
        return [
            {"x": round(float(a), 4), "y": round(float(b), 4)}
            for a, b in zip(df[x].values, df[y].values)
        ]

    mx, my = meta_by_id[x], meta_by_id[y]
    return {
        "data_source": source,
        "x": x, "y": y,
        "x_label": mx["label"], "y_label": my["label"],
        "x_units": mx["units"], "y_units": my["units"],
        "long_window": long_window,
        "short_window": short_window,
        "rolling": rolling,
        "scatter": {
            "regime": _pts(regime),
            "recent": _pts(recent),
            "fit_regime": {"slope": round(slope_l, 4), "intercept": round(int_l, 4)},
            "fit_recent": {"slope": round(slope_s, 4), "intercept": round(int_s, 4)},
        },
    }
