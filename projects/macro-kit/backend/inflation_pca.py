"""
Inflation PCA — PCA-neutral butterfly analysis for EUR/GBP/USD inflation-linked bond curves.

Six curves: DBRei (EUR), OATei (EUR), BTPei (EUR), SPGBei (EUR), UKi (GBP), TIPS (USD).
Three yield types per curve: real yield, breakeven, IOTA.

Live data path (ANALYTICS_DATA_SOURCE=bloomberg):
  - Bond universe:  discovered at request time via Bloomberg SRCH (bsrch)
  - Real yields:    YLD_YTM_MID on discovered ILB bond tickers
  - Breakeven:      nominal_yield (YLD_YTM_MID on closest-maturity nominal) − real_yield
  - IOTA:           linker_asw (YAS_ASW_SPREAD) − nominal_asw (YAS_ASW_SPREAD)

Nominal comparators are matched bond-by-bond: for each linker, the nominal bond
with the closest remaining maturity is selected from the country's sovereign universe.

Simulation fallback: deterministic synthetic yields using hardcoded default bond lists.
"""
from __future__ import annotations

import warnings
from datetime import date

import math
import os

import numpy as np
import pandas as pd


# ─── Constants ────────────────────────────────────────────────────────────────

N_DAYS   = 252    # 1 year of business days
_REF_YEAR = 2026  # base year for approximate duration calculation (matches frontend)

# Minimum outstanding for nominal bond universe (filter out tiny lines)
_MIN_NOMINAL_MN = 5_000.0   # €/£/$ 5bn
_MIN_ILB_MN     = 1_000.0   # ILB markets are smaller — lower threshold


# ─── Bloomberg SRCH expressions ───────────────────────────────────────────────

# bsrch expressions for inflation-linked bond universes.
# ⚠️ = unverified — confirm the expression returns only ILBs (not nominal bonds)
#     by running blp.bsrch(expr) in Bloomberg Terminal / Python.
_ILB_SCREENS: dict[str, str] = {
    "Germany": "FI:DBIBL",    # DBRei — inflation-linked Bunds
    "France":  "FI:FROB",     # ⚠️ returns all OATs — filter via INFLATION_LINKED_IND
    "Italy":   "FI:ITIL",     # BTPei
    "Spain":   "FI:SPGBEI",   # ⚠️ SPGBei — unverified screen name
    "UK":      "FI:UKTIIL",   # UK index-linked gilts
    "US":      "FI:TII",      # ⚠️ US TIPS — unverified screen name
}

# bsrch expressions for nominal government bond universes.
# Reuses the same expressions as egb_bond_finder.COUNTRY_BSRCH where applicable.
_NOMINAL_SCREENS: dict[str, str] = {
    "Germany": "FI:DBR",
    "France":  "FI:FRTR",
    "Italy":   "FI:BTPS",
    "Spain":   "FI:SPGB",
    "UK":      "FI:UKT",
    "US":      "FI:T",        # ⚠️ US nominal Treasuries — confirm this covers all maturities
}


# ─── Curve configuration ──────────────────────────────────────────────────────
#
# default_bonds: used when Bloomberg discovery fails (simulation mode).
#   Must have 'label', 'maturity' (year int), 'bbgTicker'.
# base_real / base_breakeven / base_iota: simulation yield levels per bond.
# vol: scalar volatility multiplier for simulation noise.

_CURVES: dict[str, dict] = {
    "dbrei": {
        "label": "DBRei", "ccy": "EUR", "country": "Germany",
        "default_bonds": [
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
    "oatei": {
        "label": "OATei", "ccy": "EUR", "country": "France",
        "default_bonds": [
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
    "btpei": {
        "label": "BTPei", "ccy": "EUR", "country": "Italy",
        "default_bonds": [
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
    "spgbei": {
        "label": "SPGBei", "ccy": "EUR", "country": "Spain",
        "default_bonds": [
            {"label": "SPGBei 27", "maturity": 2027, "bbgTicker": None},
            {"label": "SPGBei 30", "maturity": 2030, "bbgTicker": None},
            {"label": "SPGBei 33", "maturity": 2033, "bbgTicker": None},
            {"label": "SPGBei 37", "maturity": 2037, "bbgTicker": None},
            {"label": "SPGBei 48", "maturity": 2048, "bbgTicker": None},
        ],
        "base_real":      [0.70, 0.90, 1.10, 1.28, 1.52],
        "base_breakeven": [2.05, 2.12, 2.18, 2.22, 2.30],
        "base_iota":      [-0.10, -0.05, 0.00, 0.04, 0.10],
        "vol": 0.95,
    },
    "uki": {
        "label": "UKi", "ccy": "GBP", "country": "UK",
        "default_bonds": [
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
    "tips": {
        "label": "TIPS", "ccy": "USD", "country": "US",
        "default_bonds": [
            {"label": "TIPS 27", "maturity": 2027, "bbgTicker": None},
            {"label": "TIPS 30", "maturity": 2030, "bbgTicker": None},
            {"label": "TIPS 32", "maturity": 2032, "bbgTicker": None},
            {"label": "TIPS 35", "maturity": 2035, "bbgTicker": None},
            {"label": "TIPS 46", "maturity": 2046, "bbgTicker": None},
        ],
        "base_real":      [0.30, 0.50, 0.65, 0.80, 1.00],
        "base_breakeven": [2.20, 2.30, 2.35, 2.40, 2.48],
        "base_iota":      [-0.20, -0.15, -0.10, -0.08, -0.05],
        "vol": 0.90,
    },
}


# ─── Bond universe cache ───────────────────────────────────────────────────────
#
# Keyed by (country, date_str) → (ilb_bonds, nominal_bonds)
# where each list is [{label, maturity (str YYYY-MM-DD), bbgTicker}, ...]
# ilb_bonds and nominal_bonds are aligned: nominal_bonds[i] is the closest-maturity
# nominal to ilb_bonds[i].

_BOND_UNIVERSE_CACHE: dict[tuple[str, str], tuple[list[dict], list[dict]]] = {}


def _fetch_bond_universe(screen: str, inflation_linked_only: bool = False) -> pd.DataFrame:
    """
    Query Bloomberg SRCH for all active bonds matching a screen expression.

    Returns a DataFrame indexed by Bloomberg ticker with columns:
        MATURITY (Timestamp), AMT_OUTSTANDING, CALLABLE, INFLATION_LINKED_IND, ytm_years.

    Filters applied:
        - CALLABLE != "Y"
        - Remaining maturity > 1 year
        - AMT_OUTSTANDING >= threshold (passed by caller)

    Returns empty DataFrame on any Bloomberg failure.
    """
    try:
        from bbg import blp  # type: ignore
    except ImportError:
        return pd.DataFrame()

    try:
        tickers = blp.bsrch(screen)
    except Exception as exc:
        warnings.warn(f"[inflation_pca] bsrch({screen!r}) failed: {exc}", stacklevel=2)
        return pd.DataFrame()

    if not tickers:
        warnings.warn(f"[inflation_pca] bsrch({screen!r}) returned no tickers", stacklevel=2)
        return pd.DataFrame()

    try:
        ref = blp.bdp(tickers, ["MATURITY", "AMT_OUTSTANDING", "CALLABLE", "INFLATION_LINKED_IND"])
    except Exception as exc:
        warnings.warn(f"[inflation_pca] bdp failed for {screen!r}: {exc}", stacklevel=2)
        return pd.DataFrame()

    if ref is None or ref.empty:
        return pd.DataFrame()

    today = pd.Timestamp.today().normalize()
    ref["MATURITY"] = pd.to_datetime(ref["MATURITY"], errors="coerce")
    ref["ytm_years"] = (ref["MATURITY"] - today).dt.days / 365.25

    mask = (
        (ref["CALLABLE"].astype(str).str.upper() != "Y")
        & (ref["ytm_years"] > 1.0)
    )
    if inflation_linked_only:
        mask &= (ref["INFLATION_LINKED_IND"].astype(str).str.upper() == "Y")

    return ref.loc[mask].copy().sort_values("ytm_years")


def _discover_ilb_and_nominals(country: str) -> tuple[list[dict], list[dict]]:
    """
    Discover all active inflation-linked bonds for `country` and match each one
    to the nominal government bond with the closest remaining maturity.

    Returns (ilb_bonds, nominal_bonds) where:
        - Each list is sorted by maturity ascending.
        - nominal_bonds[i] is the closest-maturity nominal to ilb_bonds[i].
        - Each bond dict: {label, maturity (str YYYY-MM-DD), bbgTicker}

    Returns ([], []) if either universe cannot be discovered.
    """
    ilb_screen     = _ILB_SCREENS.get(country)
    nominal_screen = _NOMINAL_SCREENS.get(country)
    if not ilb_screen or not nominal_screen:
        warnings.warn(f"[inflation_pca] No screen config for {country!r}", stacklevel=2)
        return [], []

    # France's FI:FROB screen returns all OATs — filter to inflation-linked only
    ilb_only = (country == "France")

    ilb_universe = _fetch_bond_universe(ilb_screen, inflation_linked_only=ilb_only)
    if ilb_universe.empty:
        warnings.warn(f"[inflation_pca] No ILB universe found for {country}", stacklevel=2)
        return [], []

    # Apply minimum outstanding filter for ILBs (smaller threshold than nominals)
    if "AMT_OUTSTANDING" in ilb_universe.columns:
        ilb_universe = ilb_universe[
            ilb_universe["AMT_OUTSTANDING"] >= _MIN_ILB_MN
        ]

    nominal_universe = _fetch_bond_universe(nominal_screen, inflation_linked_only=False)
    if nominal_universe.empty:
        warnings.warn(f"[inflation_pca] No nominal universe found for {country}", stacklevel=2)
        return [], []

    if "AMT_OUTSTANDING" in nominal_universe.columns:
        nominal_universe = nominal_universe[
            nominal_universe["AMT_OUTSTANDING"] >= _MIN_NOMINAL_MN
        ]

    # Build ILB bond list
    ilb_bonds: list[dict] = []
    for ticker, row in ilb_universe.iterrows():
        mat = row["MATURITY"]
        year = mat.year
        ilb_bonds.append({
            "label":     f"{_CURVES_LABEL.get(country, country)} {str(year)[2:]}",
            "maturity":  mat.strftime("%Y-%m-%d"),
            "bbgTicker": str(ticker),
        })

    # For each ILB, find the closest-maturity nominal
    nominal_bonds: list[dict] = []
    for ilb in ilb_bonds:
        ilb_mat = pd.Timestamp(ilb["maturity"])
        if nominal_universe.empty:
            nominal_bonds.append({"label": "N/A", "maturity": ilb["maturity"], "bbgTicker": None})
            continue
        idx = (nominal_universe["MATURITY"] - ilb_mat).abs().idxmin()
        nom_row = nominal_universe.loc[idx]
        nom_mat = nom_row["MATURITY"]
        nominal_bonds.append({
            "label":     f"{_NOMINAL_LABEL.get(country, country)} {str(nom_mat.year)[2:]}",
            "maturity":  nom_mat.strftime("%Y-%m-%d"),
            "bbgTicker": str(idx),
        })

    return ilb_bonds, nominal_bonds


# Short label maps used by _discover_ilb_and_nominals for bond names
_CURVES_LABEL = {
    "Germany": "DBRei",
    "France":  "OATei",
    "Italy":   "BTPei",
    "Spain":   "SPGBei",
    "UK":      "UKi",
    "US":      "TIPS",
}

_NOMINAL_LABEL = {
    "Germany": "DBR",
    "France":  "OAT",
    "Italy":   "BTP",
    "Spain":   "Bonos",
    "UK":      "UKT",
    "US":      "UST",
}


def _get_bond_pair(country: str) -> tuple[list[dict], list[dict]]:
    """Discover and cache (ilb_bonds, nominal_bonds) for today."""
    today_str = date.today().isoformat()
    key = (country, today_str)
    if key not in _BOND_UNIVERSE_CACHE:
        _BOND_UNIVERSE_CACHE[key] = _discover_ilb_and_nominals(country)
    return _BOND_UNIVERSE_CACHE[key]


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

    Uses AR(1) factor structure: level (AR 0.998), slope (AR 0.996), curvature (AR 0.993).
    N_bonds is taken from the curve's default_bonds list.
    Returns np.ndarray [n_days, N_bonds] in %.
    """
    cfg   = _CURVES[curve_id]
    bonds = cfg["default_bonds"]
    N     = len(bonds)
    vol   = cfg["vol"]

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
      loadings:      list of n_pcs lists, each of length N_bonds
      var_explained: list of n_pcs floats (% variance)
    """
    T, N = levels.shape
    dY = np.diff(levels, axis=0)
    X  = dY - dY.mean(axis=0)
    C  = X.T @ X / max(T - 2, 1)

    eigenvalues, eigenvectors = np.linalg.eigh(C)
    order        = np.argsort(eigenvalues)[::-1]
    eigenvalues  = eigenvalues[order]
    eigenvectors = eigenvectors[:, order]

    total_var    = float(np.maximum(eigenvalues, 0.0).sum()) or 1e-12
    var_explained = (np.maximum(eigenvalues[:n_pcs], 0.0) / total_var * 100.0).tolist()

    loadings = []
    for pc_idx in range(min(n_pcs, N)):
        v = eigenvectors[:, pc_idx].copy()
        if pc_idx == 0:
            flip = -1 if v.mean() < 0 else 1
        elif pc_idx == 1:
            flip = -1 if v[-1] < 0 else 1
        else:
            flip = 1
        loadings.append([round(float(x * flip), 5) for x in v])

    return {
        "loadings":      loadings,
        "var_explained": [round(v, 3) for v in var_explained],
    }


# ─── Butterflies ──────────────────────────────────────────────────────────────

def _compute_flies(
    levels: np.ndarray,
    loadings: list[list[float]],
    bonds: list[dict],
) -> list[dict]:
    """
    All N-choose-3 PCA-neutral butterflies.  2×2 Cramér's rule for PC1/PC2-neutral weights.
    Fly spread = wL·y[i] − y[j] + wR·y[k]  (bps).
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

                # Maturity year from bond dict — handle both int and "YYYY-MM-DD" str formats
                def _mat_year(b: dict) -> int:
                    m = b.get("maturity", b.get("maturityYear", 0))
                    if isinstance(m, int):
                        return m
                    return int(str(m)[:4])

                mi = _mat_year(bonds[i]) % 100
                mj = _mat_year(bonds[j]) % 100
                mk = _mat_year(bonds[k]) % 100

                dur_i = max(0.5, _mat_year(bonds[i]) - _REF_YEAR) * 0.92
                dur_j = max(0.5, _mat_year(bonds[j]) - _REF_YEAR) * 0.92
                dur_k = max(0.5, _mat_year(bonds[k]) - _REF_YEAR) * 0.92
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

def _fetch_bond_field(
    bonds: list[dict],
    field: str,
    n_days: int = N_DAYS,
    label: str = "fetch",
) -> pd.DataFrame | None:
    """
    Fetch a single Bloomberg field for a list of bonds via bdh.

    bonds  — list of dicts with 'bbgTicker' and 'label' keys.
             Returns None immediately if any bbgTicker is None.
    field  — Bloomberg field, e.g. 'YLD_YTM_MID' or 'YAS_ASW_SPREAD'.

    Returns DataFrame [T, N_bonds] with bond labels as columns, or None.
    """
    tickers = [b["bbgTicker"] for b in bonds]
    if any(t is None for t in tickers):
        return None

    try:
        from bbg import blp  # type: ignore
    except ImportError:
        return None

    today = pd.Timestamp.today().strftime("%Y-%m-%d")
    start = (pd.Timestamp.today() - pd.Timedelta(days=int(n_days * 1.6))).strftime("%Y-%m-%d")

    try:
        df = blp.bdh(tickers, field, start, today)
        if df is None or df.empty:
            return None

        if isinstance(df.columns, pd.MultiIndex):
            df = df.xs(field, axis=1, level=1)

        ticker_to_label = {b["bbgTicker"]: b["label"] for b in bonds}
        df = df.rename(columns=ticker_to_label)

        labels = [b["label"] for b in bonds]
        missing = [lbl for lbl in labels if lbl not in df.columns]
        if missing:
            warnings.warn(f"[inflation_pca] {label}: missing from BBG: {missing}", stacklevel=1)
            return None

        df = df[labels].ffill().bfill().dropna().tail(n_days)
        return df if len(df) >= 63 else None

    except Exception as exc:
        warnings.warn(f"[inflation_pca] {label} failed: {exc}", stacklevel=1)
        return None


def _build_breakeven_matrix(
    real_df: pd.DataFrame,
    nominal_df: pd.DataFrame,
) -> np.ndarray:
    """
    Breakeven[t, j] = nominal_yield[t, j] − real_yield[t, j]  (per bond, in %).
    Columns are aligned by position (nominal_bonds[i] matches ilb_bonds[i]).
    """
    nom_aligned = nominal_df.reindex(real_df.index).ffill().bfill()
    return nom_aligned.values - real_df.values


def _build_iota_matrix(
    linker_asw_df: pd.DataFrame,
    nominal_asw_df: pd.DataFrame,
) -> np.ndarray:
    """
    IOTA[t, j] = linker_asw[t, j] − nominal_asw[t, j]  (per bond, in bps).
    Columns are aligned by position.
    """
    nom_aligned = nominal_asw_df.reindex(linker_asw_df.index).ffill().bfill()
    return linker_asw_df.values - nom_aligned.values


# ─── Pack one yield type into API response dict ───────────────────────────────

def _pack(levels: np.ndarray, bonds: list[dict]) -> dict:
    """Run PCA + compute flies on a [T, N] levels matrix. Returns chart-ready dict."""
    pca   = _compute_pca(levels)
    flies = _compute_flies(levels, pca["loadings"], bonds)
    return {
        "levels":        [[round(float(v), 4) for v in row] for row in levels],
        "loadings":      pca["loadings"],
        "var_explained": pca["var_explained"],
        "flies":         flies,
    }


# ─── Public entry point ───────────────────────────────────────────────────────

def get_inflation_pca_data(curve_id: str) -> dict:
    """
    Compute (or simulate) real yields, breakevens, and IOTA for one curve.

    Live path (ANALYTICS_DATA_SOURCE=bloomberg):
      1. Discover all active ILBs for the country via Bloomberg SRCH.
      2. For each ILB, find the nominal bond with closest maturity.
      3. Fetch YLD_YTM_MID on ILBs → real yields.
      4. Fetch YLD_YTM_MID on nominals → breakeven = nominal − real.
      5. Fetch YAS_ASW_SPREAD on ILBs and nominals → IOTA = linker_asw − nominal_asw.

    Simulation path: uses hardcoded default_bonds and AR(1) synthetic yields.

    data_source field:
      "bloomberg" — all three yield types on live data
      "partial"   — at least one yield type on live data, rest simulated
      "simulation"— all three simulated

    Returns:
    {
      "curve":       str,
      "bonds":       [{label, maturity, bbgTicker}, ...],
      "dates":       [str, ...],
      "data_source": str,
      "real":        { levels, loadings, var_explained, flies },
      "breakeven":   { levels, loadings, var_explained, flies },
      "iota":        { levels, loadings, var_explained, flies },
    }
    """
    if curve_id not in _CURVES:
        raise ValueError(f"Unknown curve_id: {curve_id!r}. Must be one of {list(_CURVES)}")

    cfg     = _CURVES[curve_id]
    country = cfg["country"]
    source  = os.environ.get("ANALYTICS_DATA_SOURCE", "csv").lower()

    live_real: np.ndarray | None = None
    live_be:   np.ndarray | None = None
    live_iota: np.ndarray | None = None
    dates_list: list[str] | None = None
    bonds_used  = cfg["default_bonds"]   # overridden if discovery succeeds

    if source == "bloomberg":
        # ── Discover bond universe ────────────────────────────────────────────
        ilb_bonds, nominal_bonds = _get_bond_pair(country)

        if ilb_bonds and nominal_bonds:
            bonds_used = ilb_bonds

            # ── Real yields ───────────────────────────────────────────────────
            real_df = _fetch_bond_field(ilb_bonds, "YLD_YTM_MID", label="real yields")

            if real_df is not None:
                live_real  = real_df.values.astype(float)
                dates_list = [d.strftime("%Y-%m-%d") for d in real_df.index]

                # ── Breakeven: nominal yield − real yield ─────────────────────
                nominal_yield_df = _fetch_bond_field(
                    nominal_bonds, "YLD_YTM_MID", label="nominal yields"
                )
                if nominal_yield_df is not None:
                    try:
                        live_be = _build_breakeven_matrix(real_df, nominal_yield_df)
                    except Exception as exc:
                        warnings.warn(f"[inflation_pca] Breakeven build failed: {exc}", stacklevel=1)

                # ── IOTA: linker ASW − nominal ASW ───────────────────────────
                linker_asw_df  = _fetch_bond_field(ilb_bonds,     "YAS_ASW_SPREAD", label="linker ASW")
                nominal_asw_df = _fetch_bond_field(nominal_bonds, "YAS_ASW_SPREAD", label="nominal ASW")
                if linker_asw_df is not None and nominal_asw_df is not None:
                    try:
                        live_iota = _build_iota_matrix(linker_asw_df, nominal_asw_df)
                    except Exception as exc:
                        warnings.warn(f"[inflation_pca] IOTA build failed: {exc}", stacklevel=1)

    # ── Fallback dates ─────────────────────────────────────────────────────────
    if dates_list is None:
        bdr = pd.bdate_range(end=pd.Timestamp.today().normalize(), periods=N_DAYS)
        dates_list = [d.strftime("%Y-%m-%d") for d in bdr]

    n = len(dates_list)

    n_live = sum(x is not None for x in [live_real, live_be, live_iota])
    if n_live == 3:
        data_source = "bloomberg"
    elif n_live == 0:
        data_source = "simulation"
    else:
        data_source = "partial"

    sim_bonds = cfg["default_bonds"]   # always use default_bonds for simulation shape

    return {
        "curve":       curve_id,
        "bonds":       bonds_used,
        "dates":       dates_list,
        "data_source": data_source,
        "real":      _pack(
            live_real if live_real is not None else _simulate_yields(curve_id, "real", n),
            bonds_used if live_real is not None else sim_bonds,
        ),
        "breakeven": _pack(
            live_be if live_be is not None else _simulate_yields(curve_id, "breakeven", n),
            bonds_used if live_be is not None else sim_bonds,
        ),
        "iota":      _pack(
            live_iota if live_iota is not None else _simulate_yields(curve_id, "iota", n),
            bonds_used if live_iota is not None else sim_bonds,
        ),
    }
