"""
Inflation PCA — PCA-neutral butterfly analysis for EUR/GBP inflation-linked bond curves.

Four curves: BTPei (EUR), OATei (EUR), DBRei (EUR), UKi (GBP).
Three yield types per curve: real yield, breakeven, IOTA.

Live data path (ANALYTICS_DATA_SOURCE=bloomberg):
  - Real yields:  YLD_YTM_MID on individual ILB bond tickers
  - Breakeven:    inflation swap par rate (EUSWI/BPSWIS) interpolated at bond maturity
  - IOTA:         real_yield + infl_swap(mat) − OIS_swap(mat)

Simulation fallback: deterministic synthetic yields, port of frontend generateYieldLevels().
"""
from __future__ import annotations

import math
import os
import warnings

import numpy as np
import pandas as pd

# ─── Constants ────────────────────────────────────────────────────────────────

N_DAYS = 252          # 1 year of business days
_REF_YEAR = 2026      # base year for approximate duration calculation (matches frontend)


# ─── Bond / curve configuration ───────────────────────────────────────────────

_CURVES: dict[str, dict] = {
    "btpei": {
        "label": "BTPei", "ccy": "EUR",
        "bonds": [
            {"label": "BTPei 28", "maturity": 2028, "bbgTicker": "ITIL28 Index"},
            {"label": "BTPei 30", "maturity": 2030, "bbgTicker": "ITIL30 Index"},
            {"label": "BTPei 32", "maturity": 2032, "bbgTicker": "ITIL32 Index"},
            {"label": "BTPei 35", "maturity": 2035, "bbgTicker": "ITIL35 Index"},
            {"label": "BTPei 38", "maturity": 2038, "bbgTicker": "ITIL38 Index"},
            {"label": "BTPei 41", "maturity": 2041, "bbgTicker": "ITIL41 Index"},
            {"label": "BTPei 51", "maturity": 2051, "bbgTicker": "ITIL51 Index"},
        ],
        "base_real":      [0.80, 1.00, 1.20, 1.40, 1.52, 1.62, 1.82],
        "base_breakeven": [2.10, 2.15, 2.20, 2.25, 2.28, 2.30, 2.35],
        "base_iota":      [-0.05, 0.02, 0.08, 0.12, 0.15, 0.17, 0.20],
        "vol": 1.0,
    },
    "oatei": {
        "label": "OATei", "ccy": "EUR",
        "bonds": [
            {"label": "OATei 27", "maturity": 2027, "bbgTicker": "FROB27I Index"},
            {"label": "OATei 29", "maturity": 2029, "bbgTicker": "FROB29I Index"},
            {"label": "OATei 32", "maturity": 2032, "bbgTicker": "FROB32I Index"},
            {"label": "OATei 36", "maturity": 2036, "bbgTicker": "FROB36I Index"},
            {"label": "OATei 40", "maturity": 2040, "bbgTicker": "FROB40I Index"},
            {"label": "OATei 47", "maturity": 2047, "bbgTicker": "FROB47I Index"},
        ],
        "base_real":      [0.55, 0.75, 0.90, 1.05, 1.15, 1.30],
        "base_breakeven": [1.95, 2.05, 2.12, 2.18, 2.22, 2.28],
        "base_iota":      [-0.15, -0.10, -0.08, -0.05, -0.03, 0.00],
        "vol": 0.85,
    },
    "dbrei": {
        "label": "DBRei", "ccy": "EUR",
        "bonds": [
            {"label": "DBRei 26", "maturity": 2026, "bbgTicker": "DBIBL26 Index"},
            {"label": "DBRei 30", "maturity": 2030, "bbgTicker": "DBIBL30 Index"},
            {"label": "DBRei 33", "maturity": 2033, "bbgTicker": "DBIBL33 Index"},
            {"label": "DBRei 40", "maturity": 2040, "bbgTicker": "DBIBL40 Index"},
            {"label": "DBRei 46", "maturity": 2046, "bbgTicker": "DBIBL46 Index"},
        ],
        "base_real":      [0.25, 0.42, 0.58, 0.72, 0.85],
        "base_breakeven": [1.85, 1.95, 2.02, 2.08, 2.15],
        "base_iota":      [-0.25, -0.20, -0.15, -0.12, -0.08],
        "vol": 0.80,
    },
    "uki": {
        "label": "UKi", "ccy": "GBP",
        "bonds": [
            {"label": "UKi 27", "maturity": 2027, "bbgTicker": "UKTIIL27 Index"},
            {"label": "UKi 30", "maturity": 2030, "bbgTicker": "UKTIIL30 Index"},
            {"label": "UKi 32", "maturity": 2032, "bbgTicker": "UKTIIL32 Index"},
            {"label": "UKi 35", "maturity": 2035, "bbgTicker": "UKTIIL35 Index"},
            {"label": "UKi 40", "maturity": 2040, "bbgTicker": "UKTIIL40 Index"},
            {"label": "UKi 47", "maturity": 2047, "bbgTicker": "UKTIIL47 Index"},
            {"label": "UKi 55", "maturity": 2055, "bbgTicker": "UKTIIL55 Index"},
        ],
        "base_real":      [-0.20, 0.05, 0.20, 0.38, 0.60, 0.85, 1.05],
        "base_breakeven": [3.20, 3.35, 3.45, 3.55, 3.62, 3.68, 3.75],
        "base_iota":      [-0.40, -0.35, -0.30, -0.25, -0.20, -0.15, -0.10],
        "vol": 0.90,
    },
}

# ─── Bloomberg ticker maps ─────────────────────────────────────────────────────

# EUR HICPxT zero-coupon inflation swaps, tenors 1–30y
_EUR_INFL_TICKERS: dict[int, str] = {n: f"EUSWI{n} Curncy"  for n in range(1, 31)}
# GBP RPI zero-coupon inflation swaps, tenors 1–30y
_GBP_INFL_TICKERS: dict[int, str] = {n: f"BPSWIS{n} Curncy" for n in range(1, 31)}
# EUR ESTR OIS par swap rates, tenors 1–30y
_EUR_OIS_TICKERS:  dict[int, str] = {n: f"EUSWF{n} Curncy"  for n in range(1, 31)}
# GBP SONIA OIS par swap rates, tenors 1–30y
_GBP_OIS_TICKERS:  dict[int, str] = {n: f"BPSWS{n} Curncy"  for n in range(1, 31)}


# ─── Simulation ───────────────────────────────────────────────────────────────

def _str_seed(s: str) -> int:
    """Deterministic integer seed matching the frontend strSeed() function."""
    h = 0
    for c in s:
        h = (31 * h + ord(c)) & 0xFFFFFFFF
    return h


def _simulate_yields(curve_id: str, yield_type: str, n_days: int = N_DAYS) -> np.ndarray:
    """
    Deterministic synthetic yield levels — port of frontend generateYieldLevels().

    Uses the same seed formula (strSeed) and the same AR(1) factor structure:
      level factor  (AR 0.998), slope factor (AR 0.996), curvature factor (AR 0.993).
    Returns np.ndarray [n_days, N_bonds] in % (e.g. 1.20 = 1.20%).
    """
    cfg = _CURVES[curve_id]
    bonds = cfg["bonds"]
    N = len(bonds)
    vol = cfg["vol"]

    vol_mul   = {"real": 1.00, "breakeven": 0.75, "iota": 0.40}[yield_type]
    slope_mul = {"real": 1.00, "breakeven": 0.50, "iota": 0.25}[yield_type]
    base_key  = {"real": "base_real", "breakeven": "base_breakeven", "iota": "base_iota"}[yield_type]
    base: list[float] = cfg[base_key]

    seed = _str_seed(f"{curve_id}_{yield_type}_lvl")
    rng  = np.random.default_rng(seed)

    lv = np.zeros(n_days)
    sl = np.zeros(n_days)
    cu = np.zeros(n_days)
    for t in range(1, n_days):
        lv[t] = lv[t - 1] * 0.998 + (rng.random() - 0.5) * 0.055 * vol * vol_mul
        sl[t] = sl[t - 1] * 0.996 + (rng.random() - 0.5) * 0.035 * vol * vol_mul
        cu[t] = cu[t - 1] * 0.993 + (rng.random() - 0.5) * 0.022 * vol * vol_mul

    levels = np.zeros((n_days, N))
    for t in range(n_days):
        for j in range(N):
            x = j / (N - 1) if N > 1 else 0.0
            levels[t, j] = (
                base[j]
                + lv[t]
                + sl[t] * (-1.0 + 2.0 * x) * slope_mul
                + cu[t] * (-math.sin(math.pi * x))
                + (rng.random() - 0.5) * 0.012 * vol * vol_mul
            )
    return levels


# ─── PCA ──────────────────────────────────────────────────────────────────────

def _compute_pca(levels: np.ndarray, n_pcs: int = 3) -> dict:
    """
    PCA on daily yield changes (not levels).

    Returns:
      loadings:     list of n_pcs lists, each of length N_bonds
      var_explained: list of n_pcs floats (% variance)
    """
    T, N = levels.shape
    dY = np.diff(levels, axis=0)          # [T-1, N]
    X  = dY - dY.mean(axis=0)            # centre columns
    C  = X.T @ X / max(T - 2, 1)        # [N, N] sample covariance

    # eigh returns eigenvalues ascending; we want descending
    eigenvalues, eigenvectors = np.linalg.eigh(C)
    order       = np.argsort(eigenvalues)[::-1]
    eigenvalues = eigenvalues[order]
    eigenvectors = eigenvectors[:, order]   # columns are eigenvectors

    total_var   = float(np.maximum(eigenvalues, 0.0).sum()) or 1e-12
    var_explained = (np.maximum(eigenvalues[:n_pcs], 0.0) / total_var * 100.0).tolist()

    loadings = []
    for pc_idx in range(min(n_pcs, N)):
        v = eigenvectors[:, pc_idx].copy()
        # Sign conventions matching the frontend:
        #   PC1 (level):    mean loading positive
        #   PC2 (slope):    last bond (longest) loading positive
        #   PC3 (curv):     no canonical sign — leave as-is
        if pc_idx == 0:
            flip = -1 if v.mean() < 0 else 1
        elif pc_idx == 1:
            flip = -1 if v[-1] < 0 else 1
        else:
            flip = 1
        loadings.append([round(float(x * flip), 5) for x in v])

    return {
        "loadings":     loadings,
        "var_explained": [round(v, 3) for v in var_explained],
    }


# ─── Butterflies ──────────────────────────────────────────────────────────────

def _compute_flies(
    levels: np.ndarray,
    loadings: list[list[float]],
    bonds: list[dict],
) -> list[dict]:
    """
    All N-choose-3 PCA-neutral butterflies.  2×2 Cramér's rule to find PC1/PC2-neutral weights.
    Fly spread = wL·y[i] − y[j] + wR·y[k]  (in bps, levels in %).
    Z-score vs 63-day rolling window.  Sorted by |z-score| descending.
    """
    N   = len(bonds)
    T   = len(levels)
    pc1 = np.array(loadings[0])
    pc2 = np.array(loadings[1])

    MIN_DET = 1e-6
    results: list[dict] = []

    for i in range(N - 2):
        for j in range(i + 1, N - 1):
            for k in range(j + 1, N):
                det = pc1[i] * pc2[k] - pc1[k] * pc2[i]
                if abs(det) < MIN_DET:
                    continue

                wL = (pc1[j] * pc2[k] - pc1[k] * pc2[j]) / det
                wR = (pc1[i] * pc2[j] - pc2[i] * pc1[j]) / det

                spreads = (wL * levels[:, i] - levels[:, j] + wR * levels[:, k]) * 100.0
                current = float(spreads[-1])
                win63   = spreads[max(0, T - 63):]
                avg3m   = float(win63.mean())
                std3m   = max(float(win63.std(ddof=0)), 0.01)
                zscore  = (current - avg3m) / std3m

                mi = bonds[i]["maturity"] % 100
                mj = bonds[j]["maturity"] % 100
                mk = bonds[k]["maturity"] % 100

                # Approximate modified duration (matches frontend approxDuration)
                dur_i = max(0.5, bonds[i]["maturity"] - _REF_YEAR) * 0.92
                dur_j = max(0.5, bonds[j]["maturity"] - _REF_YEAR) * 0.92
                dur_k = max(0.5, bonds[k]["maturity"] - _REF_YEAR) * 0.92
                net_dv01 = (wL * dur_i - dur_j + wR * dur_k) * 100.0

                if zscore > 2:    signal = "Very Rich"
                elif zscore > 1:  signal = "Rich"
                elif zscore < -2: signal = "Very Cheap"
                elif zscore < -1: signal = "Cheap"
                else:             signal = "Neutral"

                results.append({
                    "name":     f"{mi}s{mj}s{mk}s",
                    "leftIdx":  i,
                    "bellyIdx": j,
                    "rightIdx": k,
                    "wLeft":    round(float(wL), 4),
                    "wRight":   round(float(wR), 4),
                    "spreads":  [round(float(v), 2) for v in spreads],
                    "current":  round(current, 2),
                    "avg3m":    round(avg3m, 2),
                    "std3m":    round(std3m, 2),
                    "zscore":   round(float(zscore), 3),
                    "signal":   signal,
                    "netDV01":  round(float(net_dv01), 1),
                })

    results.sort(key=lambda x: -abs(x["zscore"]))
    return results


# ─── Bloomberg data fetching ──────────────────────────────────────────────────

def _fetch_real_yields(bonds: list[dict], n_days: int = N_DAYS) -> pd.DataFrame | None:
    """
    Fetch YLD_YTM_MID for all ILB bond tickers.
    Returns DataFrame [T, N_bonds] with bond labels as columns, yields in %, or None.
    """
    try:
        from bbg import blp  # type: ignore
    except ImportError:
        return None

    tickers = [b["bbgTicker"] for b in bonds]
    today   = pd.Timestamp.today().strftime("%Y-%m-%d")
    start   = (pd.Timestamp.today() - pd.Timedelta(days=int(n_days * 1.6))).strftime("%Y-%m-%d")

    try:
        df = blp.bdh(tickers, "YLD_YTM_MID", start, today)
        if df is None or df.empty:
            return None

        if isinstance(df.columns, pd.MultiIndex):
            df = df.xs("YLD_YTM_MID", axis=1, level=1)

        # Rename tickers → bond labels
        ticker_to_label = {b["bbgTicker"]: b["label"] for b in bonds}
        df = df.rename(columns=ticker_to_label)

        # Ensure all bonds present and in order
        labels = [b["label"] for b in bonds]
        missing = [lbl for lbl in labels if lbl not in df.columns]
        if missing:
            warnings.warn(f"[inflation_pca] Missing bonds in BBG response: {missing}", stacklevel=1)
            return None

        df = df[labels].ffill().bfill().dropna().tail(n_days)
        return df if len(df) >= 63 else None

    except Exception as exc:
        warnings.warn(f"[inflation_pca] Real yield fetch failed: {exc}", stacklevel=1)
        return None


def _fetch_rate_curve(ticker_map: dict[int, str], n_days: int = N_DAYS) -> pd.DataFrame | None:
    """
    Fetch a full 1–30y par rate curve (PX_LAST).
    Returns DataFrame [T, 30] with integer tenor columns (1..30), rates in %, or None.
    """
    try:
        from bbg import blp  # type: ignore
    except ImportError:
        return None

    tickers = list(ticker_map.values())
    today   = pd.Timestamp.today().strftime("%Y-%m-%d")
    start   = (pd.Timestamp.today() - pd.Timedelta(days=int(n_days * 1.6))).strftime("%Y-%m-%d")

    try:
        df = blp.bdh(tickers, "PX_LAST", start, today)
        if df is None or df.empty:
            return None

        if isinstance(df.columns, pd.MultiIndex):
            df = df.xs("PX_LAST", axis=1, level=1)

        rev_map = {v: k for k, v in ticker_map.items()}
        df = df.rename(columns=rev_map)
        df = df.ffill().bfill().tail(n_days)
        return df if len(df) >= 63 else None

    except Exception as exc:
        warnings.warn(f"[inflation_pca] Rate curve fetch failed: {exc}", stacklevel=1)
        return None


def _interp_at_maturity(row: pd.Series, maturity_year: int, date_year: int) -> float | None:
    """
    Linearly interpolate a tenor-indexed rate row at (maturity_year − date_year) years.
    Clamps to [1, 30].
    """
    ytm = float(max(1, min(30, maturity_year - date_year)))
    avail = sorted([(int(t), float(v)) for t, v in row.items() if pd.notna(v)])
    if not avail:
        return None

    tenors = [t for t, _ in avail]
    rates  = [r for _, r in avail]

    if ytm <= tenors[0]:
        return rates[0]
    if ytm >= tenors[-1]:
        return rates[-1]

    lo_i = max(i for i, t in enumerate(tenors) if t <= ytm)
    hi_i = lo_i + 1
    alpha = (ytm - tenors[lo_i]) / (tenors[hi_i] - tenors[lo_i])
    return rates[lo_i] * (1.0 - alpha) + rates[hi_i] * alpha


def _build_breakeven_matrix(
    real_df: pd.DataFrame,
    infl_df: pd.DataFrame,
    bonds: list[dict],
) -> np.ndarray:
    """
    Breakeven[t, j] = infl_swap par rate interpolated at bond j's maturity on date t.
    Returns [T, N] in %.
    """
    T = len(real_df)
    N = len(bonds)
    be = np.full((T, N), np.nan)
    infl_aligned = infl_df.reindex(real_df.index).ffill().bfill()

    for ti, date in enumerate(real_df.index):
        row = infl_aligned.loc[date]
        for bi, bond in enumerate(bonds):
            val = _interp_at_maturity(row, bond["maturity"], date.year)
            if val is not None:
                be[ti, bi] = val

    # Forward-fill any remaining NaN (e.g. early dates where short tenors lag)
    be = pd.DataFrame(be).ffill().bfill().values
    return be


def _build_iota_matrix(
    real_df: pd.DataFrame,
    infl_df: pd.DataFrame,
    ois_df: pd.DataFrame,
    bonds: list[dict],
) -> np.ndarray:
    """
    IOTA[t, j] = real_yield[t,j] + infl_swap(mat_j)[t] − OIS_swap(mat_j)[t]
    All in %.  Returns [T, N].
    """
    T = len(real_df)
    N = len(bonds)
    iota = np.full((T, N), np.nan)

    infl_aligned = infl_df.reindex(real_df.index).ffill().bfill()
    ois_aligned  = ois_df.reindex(real_df.index).ffill().bfill()

    labels = [b["label"] for b in bonds]

    for ti, date in enumerate(real_df.index):
        infl_row = infl_aligned.loc[date]
        ois_row  = ois_aligned.loc[date]
        for bi, bond in enumerate(bonds):
            rv = real_df.loc[date, labels[bi]]
            iv = _interp_at_maturity(infl_row, bond["maturity"], date.year)
            ov = _interp_at_maturity(ois_row,  bond["maturity"], date.year)
            if pd.notna(rv) and iv is not None and ov is not None:
                iota[ti, bi] = float(rv) + iv - ov

    iota = pd.DataFrame(iota).ffill().bfill().values
    return iota


# ─── Package one yield type into API response dict ────────────────────────────

def _pack(levels: np.ndarray, bonds: list[dict]) -> dict:
    """Run PCA + compute flies on a [T, N] levels matrix. Returns chart-ready dict."""
    pca  = _compute_pca(levels)
    flies = _compute_flies(levels, pca["loadings"], bonds)
    return {
        "levels":       [[round(float(v), 4) for v in row] for row in levels],
        "loadings":     pca["loadings"],
        "var_explained": pca["var_explained"],
        "flies":        flies,
    }


# ─── Public entry point ───────────────────────────────────────────────────────

def get_inflation_pca_data(curve_id: str) -> dict:
    """
    Compute (or simulate) real yields, breakevens, and IOTA for one curve.

    Returns:
    {
      "curve":       str,
      "bonds":       [{label, maturity, bbgTicker}, ...],
      "dates":       [str, ...],        # YYYY-MM-DD, length T
      "data_source": "bloomberg" | "simulation",
      "real":        { levels, loadings, var_explained, flies },
      "breakeven":   { levels, loadings, var_explained, flies },
      "iota":        { levels, loadings, var_explained, flies },
    }
    """
    if curve_id not in _CURVES:
        raise ValueError(f"Unknown curve_id: {curve_id!r}. Must be one of {list(_CURVES)}")

    cfg   = _CURVES[curve_id]
    bonds = cfg["bonds"]
    ccy   = cfg["ccy"]

    source = os.environ.get("ANALYTICS_DATA_SOURCE", "csv").lower()

    live_real: np.ndarray | None = None
    live_be:   np.ndarray | None = None
    live_iota: np.ndarray | None = None
    dates_list: list[str] | None = None
    data_source = "simulation"

    if source == "bloomberg":
        real_df = _fetch_real_yields(bonds)

        if real_df is not None and not real_df.empty:
            infl_tickers = _EUR_INFL_TICKERS if ccy == "EUR" else _GBP_INFL_TICKERS
            ois_tickers  = _EUR_OIS_TICKERS  if ccy == "EUR" else _GBP_OIS_TICKERS

            infl_df = _fetch_rate_curve(infl_tickers)
            ois_df  = _fetch_rate_curve(ois_tickers)

            if infl_df is not None:
                live_real = real_df.values.astype(float)
                live_be   = _build_breakeven_matrix(real_df, infl_df, bonds)
                dates_list = [d.strftime("%Y-%m-%d") for d in real_df.index]
                data_source = "bloomberg"

                if ois_df is not None:
                    try:
                        live_iota = _build_iota_matrix(real_df, infl_df, ois_df, bonds)
                    except Exception as exc:
                        warnings.warn(f"[inflation_pca] IOTA computation failed: {exc}", stacklevel=1)

    # Fallback dates: last N_DAYS business days
    if dates_list is None:
        bdr = pd.bdate_range(end=pd.Timestamp.today().normalize(), periods=N_DAYS)
        dates_list = [d.strftime("%Y-%m-%d") for d in bdr]

    n = len(dates_list)

    return {
        "curve":       curve_id,
        "bonds":       bonds,
        "dates":       dates_list,
        "data_source": data_source,
        "real":      _pack(live_real if live_real is not None else _simulate_yields(curve_id, "real",      n), bonds),
        "breakeven": _pack(live_be   if live_be   is not None else _simulate_yields(curve_id, "breakeven", n), bonds),
        "iota":      _pack(live_iota if live_iota is not None else _simulate_yields(curve_id, "iota",      n), bonds),
    }
