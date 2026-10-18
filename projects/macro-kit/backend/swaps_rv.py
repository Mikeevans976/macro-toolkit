from pathlib import Path
from datetime import datetime
import threading
import time
import warnings

import numpy as np
import pandas as pd
from scipy import stats
from scipy.interpolate import CubicSpline
from curves_flies_config import CORE_CURVES, CORE_FLIES, EXTENDED_CURVES, EXTENDED_FLIES
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


def _discount_factor_matrix(par: np.ndarray) -> np.ndarray:
    """
    Vectorised _build_discount_factors for many days at once.
    par: (n_days, len(_SWAP_TENORS)) par rates in %; returns D: (n_days, _MAX_TENOR + 1).
    """
    rates = CubicSpline(_SWAP_TENORS, par, axis=1, bc_type="not-a-knot")(np.arange(1, _MAX_TENOR + 1, dtype=float))
    rates[:, 30:] = par[:, -1:]          # flat beyond 30y
    rates = rates / 100.0
    D = np.zeros((par.shape[0], _MAX_TENOR + 1))
    D[:, 0] = 1.0
    annuity = np.zeros(par.shape[0])
    for n in range(1, _MAX_TENOR + 1):
        D[:, n] = (1.0 - rates[:, n - 1] * annuity) / (1.0 + rates[:, n - 1])
        annuity += D[:, n]
    return D


def _fwd_rate_vec(s: int, t: int, D: np.ndarray, A: np.ndarray) -> np.ndarray:
    """Vectorised _fwd_rate (%) across days; A = np.cumsum(D, axis=1)."""
    return (D[:, s] - D[:, s + t]) / (A[:, s + t] - A[:, s]) * 100.0


def _parse_label(label: str):
    """'12y3y' -> (12, 3) forward; '10y' -> (0, 10) spot."""
    parts = label.split("y")
    if len(parts) == 2:          # "10y" -> ["10", ""]
        return 0, int(parts[0])
    return int(parts[0]), int(parts[1])


def _rolled(s: int, t: int) -> "tuple[int, int]":
    """Where a leg sits a year later on an unchanged curve: a forward's start moves one
    year closer (s -> s-1); a spot swap's tenor shortens (t -> t-1)."""
    return (s - 1, t) if s >= 1 else (0, t - 1)


def _rolled_label(s: int, t: int) -> str:
    rs, rt = _rolled(s, t)
    return f"{rs}y{rt}y" if rs >= 1 else f"{rt}y spot"


def _valid_leg(s: int, t: int) -> bool:
    """Legs the engine can price and roll: spot from 2y (a 1y spot rolls into an overnight rate)."""
    return (s >= 1 or t >= 2) and t >= 1 and s + t <= _MAX_TENOR


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
    f_now    = _fwd_rate(s, t, D)
    f_rolled = _fwd_rate(*_rolled(s, t), D)   # start 0 gives the spot par rate
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
# ATMF normal vols priced by ICAP; the default BGN source returns nothing on our
# Terminal, so the ICPL source must be explicit (EUR checked 2026-10-16, GBP/USD
# 2026-10-18 from tickers the user found in VCUB: GBNS0110, USSNA110).
_VOL_TICKERS: dict[str, dict[str, str]] = {
    "EUR": {"1m10y": "ENPS0A10 ICPL Curncy", "1y10y": "ENPS0110 ICPL Curncy"},
    "GBP": {"1m10y": "GBNS0A10 ICPL Curncy", "1y10y": "GBNS0110 ICPL Curncy"},
    "USD": {"1m10y": "USSNAA10 ICPL Curncy", "1y10y": "USSNA110 ICPL Curncy"},
}

_BETA_VARS = ["1y10y_fwd", "2y1y_fwd", "1m10y_vol", "1y10y_vol"]

# Central-bank policy decision dates, marked on the detail chart. ECB 2025-2027 checked against
# Bloomberg's EUORDEPO Index release calendar (2026-10-18); 2021-2024 from the ECB's published
# calendars. Extend each December. GBP (BoE) and USD (FOMC) not yet listed.
_POLICY_MEETINGS: dict[str, tuple[str, list[str]]] = {
    "EUR": ("ECB", [
        "2021-01-21", "2021-03-11", "2021-04-22", "2021-06-10", "2021-07-22", "2021-09-09", "2021-10-28", "2021-12-16",
        "2022-02-03", "2022-03-10", "2022-04-14", "2022-06-09", "2022-07-21", "2022-09-08", "2022-10-27", "2022-12-15",
        "2023-02-02", "2023-03-16", "2023-05-04", "2023-06-15", "2023-07-27", "2023-09-14", "2023-10-26", "2023-12-14",
        "2024-01-25", "2024-03-07", "2024-04-11", "2024-06-06", "2024-07-18", "2024-09-12", "2024-10-17", "2024-12-12",
        "2025-01-30", "2025-03-06", "2025-04-17", "2025-06-05", "2025-07-24", "2025-09-11", "2025-10-30", "2025-12-18",
        "2026-02-05", "2026-03-19", "2026-04-30", "2026-06-11", "2026-07-23", "2026-09-10", "2026-10-29", "2026-12-17",
        "2027-02-04", "2027-03-18", "2027-04-29", "2027-06-10", "2027-07-22", "2027-09-09", "2027-10-28", "2027-12-16",
    ]),
}


def _policy_meetings(ccy: str, first: str, as_of: str) -> "dict | None":
    """The currency's policy decisions from the first data date to the as-of date, plus the next one."""
    if ccy not in _POLICY_MEETINGS:
        return None
    bank, dates = _POLICY_MEETINGS[ccy]
    past = [d for d in dates if first <= d <= as_of]
    upcoming = [d for d in dates if d > as_of]
    return {"bank": bank, "dates": past, "next": upcoming[0] if upcoming else None}


# ATM normal swaption vol grid (bp/yr) behind the implied carry/vol, from ICPL (checked
# 2026-10-18). EUR/GBP: prefix + 2-char expiry code + 2-digit tenor (ENPS0110 = 1y10y).
# USD: USSNA + expiry code + unpadded tenor (USSNA110 = 1y10y). Gaps: GBP prices no 10y
# expiry on 10y+ tenors; for USD those tickers are ambiguous ("USSNA1010" returns the
# 10y×1y vol), so they are not requested. Interpolation works around missing cells.
_VOL_GRID_EXPIRY_YEARS = [1 / 12, 0.25, 0.5, 1.0, 2.0, 3.0, 5.0, 10.0]
_VOL_GRID_TENORS = [1, 2, 3, 5, 7, 10, 15, 20, 30]
_PADDED_EXPIRY_CODES = ["0A", "0C", "0F", "01", "02", "03", "05", "10"]


def _vol_grid_tickers(ccy: str) -> "dict[str, tuple[float, int]]":
    """{ticker: (expiry years, tenor years)} for the currency's swaption vol grid; empty if none."""
    out: dict[str, tuple[float, int]] = {}
    for code, (y, usd_code) in zip(_PADDED_EXPIRY_CODES,
                                   zip(_VOL_GRID_EXPIRY_YEARS, ["A", "C", "F", "1", "2", "3", "5", "10"])):
        for t in _VOL_GRID_TENORS:
            if ccy == "EUR":
                out[f"ENPS{code}{t:02d} ICPL Curncy"] = (y, t)
            elif ccy == "GBP":
                out[f"GBNS{code}{t:02d} ICPL Curncy"] = (y, t)
            elif ccy == "USD" and not (y == 10.0 and t >= 10):
                out[f"USSNA{usd_code}{t} ICPL Curncy"] = (y, t)
    return out

# ---------------------------------------------------------------------------
# BBG helpers
# ---------------------------------------------------------------------------

UNIVERSES = ("core", "extended")


def _structures(universe: str = "core") -> "list[tuple[str, str, tuple, tuple, str]]":
    """(label, group, legs, weights, set) for the core, or core + extended, universe;
    structures with a leg the engine cannot roll are left out."""
    if universe not in UNIVERSES:
        raise ValueError(f"universe must be one of {UNIVERSES}")
    sets = [("core", CORE_CURVES, CORE_FLIES)]
    if universe == "extended":
        sets.append(("extended", EXTENDED_CURVES, EXTENDED_FLIES))
    out = []
    for name, curves, flies in sets:
        out += [(lbl, "curve", (fr, bk), (-1, 1), name) for lbl, fr, bk in curves]
        out += [(lbl, "fly", (fr, bl, bk), (-1, 2, -1), name) for lbl, fr, bl, bk in flies]
    return [x for x in out if all(_valid_leg(*_parse_label(leg)) for leg in x[2])]


def _fwd_labels_for_ccy(ccy: str) -> list[str]:
    """Every leg label referenced by the full universe and the curve snapshot."""
    labels: set[str] = set()
    for group_info in FORWARD_GROUPS.values():
        labels.update(group_info["labels"])
    for _, _, legs, _, _ in _structures("extended"):
        labels.update(legs)
    return sorted(labels)


def _forward_columns(par: pd.DataFrame, labels) -> pd.DataFrame:
    """Forward (and spot) par rates in % for every day of `par`, all days at once."""
    D_all = _discount_factor_matrix(par.values.astype(float))
    A_all = np.cumsum(D_all, axis=1)
    cols: dict[str, np.ndarray] = {}
    for label in labels:
        s, t = _parse_label(label)
        if _valid_leg(s, t):
            cols[label] = _fwd_rate_vec(s, t, D_all, A_all)
    return pd.DataFrame(cols, index=par.index)


def _fetch_from_bbg(
    ccy: str, start: str, end: str
) -> "tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame] | None":
    """
    Fetch par OIS rates + swaption vols from Bloomberg; bootstrap all forward rates.
    Returns (fwd_df, beta_df, swap_df, grid_df) or None if the rates are unavailable.

    fwd_df  — columns = forward labels (e.g. "1y10y"), values in %
    beta_df — columns: 1y10y_fwd, 2y1y_fwd (%), plus 1m10y_vol, 1y10y_vol
              (bps normal vol) when Bloomberg returns them
    swap_df — columns = tenor ints in _SWAP_TENORS order, values = par rates in %
    grid_df — ATM normal swaption vols (bp/yr), columns (expiry years, tenor years);
              empty when the currency has no grid
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
        #    All days at once: one spline + bootstrap over the (days × tenors) matrix
        fwd_df = _forward_columns(par, _fwd_labels_for_ccy(ccy))   # already in %

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

        # ── 5. Swaption vol grid for the implied carry/vol (optional) ───────
        #    Columns (expiry in years, tenor in years); empty when the currency has none
        grid_df = pd.DataFrame()
        codes = _vol_grid_tickers(ccy)
        if codes:
            raw_grid = blp.bdh(list(codes), "PX_LAST", start, end)
            if raw_grid is not None and not raw_grid.empty:
                g = raw_grid.xs("PX_LAST", axis=1, level=1) if isinstance(raw_grid.columns, pd.MultiIndex) else raw_grid
                g = g[[c for c in codes if c in g.columns]]
                g.columns = pd.MultiIndex.from_tuples([codes[c] for c in g.columns], names=["expiry", "tenor"])
                grid_df = g.sort_index(axis=1)
            else:
                warnings.warn(f"[swaps_rv] No swaption vol grid from BBG for {ccy}; implied carry/vol unavailable")

        return fwd_df, beta_df, swap_df, grid_df

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
    # The core views of every currency first (what a visitor opens), then the extended universe;
    # a failed step is left to compute on first request.
    steps = [(compute_rv, ccy, {}) for ccy in _OIS_TICKERS]
    steps += [(compute_carry_backtest, ccy, {}) for ccy in _OIS_TICKERS]
    steps += [(compute_candidates, ccy, {}) for ccy in _OIS_TICKERS]
    steps += [(fn, ccy, {"universe": "extended"}) for fn in (compute_rv, compute_candidates) for ccy in _OIS_TICKERS]
    for fn, ccy, kwargs in steps:
        try:
            fn(ccy, **kwargs)
        except Exception as exc:  # noqa: BLE001
            warnings.warn(f"[swaps_rv] warm-up {fn.__name__}({ccy}, {kwargs}) failed: {exc}")


def _load_frames(ccy: str, as_of_date: str | None, fetched: "tuple | None"):
    """(fwd_df, beta_df, swap_df, min_date, max_date): live frames when fetched, else the CSVs,
    aligned on common dates and sliced to the as-of date."""
    if fetched is not None:
        fwd_df, beta_df, swap_df = fetched[1][:3]
    else:
        files   = _CCY_FILES[ccy]
        fwd_df  = pd.read_csv(DATA_DIR / files["forwards"], parse_dates=["date"], index_col="date")
        beta_df = pd.read_csv(DATA_DIR / files["betas"],    parse_dates=["date"], index_col="date")
        swap_df = pd.read_csv(DATA_DIR / files["swaps"],    parse_dates=["date"], index_col="date")
        missing = [lbl for lbl in _fwd_labels_for_ccy(ccy) if lbl not in fwd_df.columns]
        if missing:
            derived = _forward_columns(swap_df.sort_index(), missing).reindex(fwd_df.index)
            fwd_df = pd.concat([fwd_df, derived], axis=1)

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


# ---------------------------------------------------------------------------
# Factor-neutral weights
# ---------------------------------------------------------------------------
# The curve factors are the first three principal components of daily par swap changes (bp)
# over the 1y window: level, slope, curvature. A leg's exposure to them is its regression on
# the standardised PC scores (bp per 1σ day), so spot and forward legs are treated alike.
# Neutral weights keep a curve's back leg (+1) or a fly's belly (+2) and re-solve the others:
# curves are made level-neutral, flies level- and slope-neutral. The weights are estimated on
# the last year and applied to the whole history.

_PC_NAMES = ("level", "slope", "curvature")


def _curve_factors(swap_df: pd.DataFrame, dates: pd.Index):
    """(dates, standardised scores n×3, loadings 3×tenors, variance shares) of the par curve's first 3 PCs."""
    chg = (swap_df.sort_index().diff() * 100).reindex(dates).dropna()
    X = chg.values - chg.values.mean(axis=0)
    _, S, Vt = np.linalg.svd(X, full_matrices=False)
    load = Vt[:3].copy()
    # Signs: level = rates up, slope = long end up vs short end, curvature = belly up vs wings
    mid = load.shape[1] // 2
    signs = np.array([load[0].sum(), load[1][-1] - load[1][0], load[2][mid] - (load[2][0] + load[2][-1]) / 2])
    load *= np.where(signs < 0, -1.0, 1.0)[:, None]
    scores = X @ load.T
    scores /= scores.std(axis=0, ddof=1)
    return chg.index, scores, load, (S ** 2 / (S ** 2).sum())[:3]


def _leg_exposure(fwd_df: pd.DataFrame, leg: str, dates: pd.Index, scores: np.ndarray) -> np.ndarray:
    """A leg's exposure to each factor, bp per 1σ day (length 3)."""
    y = (fwd_df[leg].diff() * 100).reindex(dates).values
    ok = ~np.isnan(y)
    A = np.hstack([np.ones((int(ok.sum()), 1)), scores[ok]])
    return np.linalg.lstsq(A, y[ok], rcond=None)[0][1:]


def _neutral_weights(group: str, E: np.ndarray) -> "tuple | None":
    """Neutral weights from the legs' exposures E (3 × legs); None when they cannot be solved."""
    if group == "curve":
        if abs(E[0, 0]) < 1e-6:
            return None
        return (float(-E[0, 1] / E[0, 0]), 1.0)
    M = E[:2][:, [0, 2]]
    if np.linalg.cond(M) > 1e6:
        return None
    a, c = np.linalg.solve(M, 2 * E[:2, 1])
    return (float(-a), 2.0, float(-c))


def _neutral_unstable(group: str, neutral: tuple) -> bool:
    """A hedge leg flips sign or scales outside 0.25–2.5× its standard size: the factors
    barely separate the legs, so the 'neutral' structure is close to an outright position."""
    hedge_legs = [neutral[0]] if group == "curve" else [neutral[0], neutral[2]]
    return any(not (-2.5 <= w <= -0.25) for w in hedge_legs)


def _factor_share(group: str, weights: tuple, E: np.ndarray, series: pd.Series, dates: pd.Index) -> float:
    """Share of the structure's daily variance explained by the factors the neutral version hedges."""
    k = 1 if group == "curve" else 2
    e = E @ np.asarray(weights, float)
    var = float(series.diff().reindex(dates).var(ddof=1))
    return min(float((e[:k] ** 2).sum()) / var, 1.0) if var > 0 else 0.0


# ---------------------------------------------------------------------------
# Implied vol of a structure
# ---------------------------------------------------------------------------
# A leg's implied vol is the ATM normal swaption vol at expiry = the forward's start (1y
# for a spot leg, the carry horizon; capped at the grid's 10y) and tenor = the leg's tenor,
# interpolated linearly on the grid. The structure's vol combines the legs' implied vols
# with their realised correlations over the last year: σ = √(wᵀ D C D), D = diag(leg vols).

def _vol_grid(fetched: "tuple | None", as_of: pd.Timestamp) -> "tuple[np.ndarray, np.ndarray, np.ndarray, str] | None":
    """(expiries, tenors, vols[expiry, tenor], grid date) on or before the as-of date; vols may
    have gaps (NaN). None when the currency has no grid, it is more than a week old, or some
    tenor has no vol at any expiry."""
    if fetched is None or len(fetched[1]) < 4 or fetched[1][3].empty:
        return None
    grid = fetched[1][3].loc[:as_of].ffill()
    if grid.empty or grid.index[-1] < as_of - pd.Timedelta(days=7):
        return None
    row = grid.iloc[-1]
    exps = np.array(sorted({e for e, _ in row.index}))
    tens = np.array(sorted({t for _, t in row.index}))
    vols = np.array([[row.get((e, t), np.nan) for t in tens] for e in exps], dtype=float)
    if np.isnan(vols).all(axis=0).any():
        return None
    return exps, tens, vols, grid.index[-1].strftime("%Y-%m-%d")


def _leg_implied_vol(s: int, t: int, grid: tuple) -> float:
    """ATM normal vol (bp/yr) for a leg starting in s years with tenor t. Interpolates across
    tenors within each expiry, using only expiries that price the leg's tenor range, then
    across those expiries (flat beyond the last one, e.g. a GBP 10y10y leg uses 5y expiry)."""
    exps, tens, vols = grid[:3]
    tenor = min(max(float(t), float(tens[0])), float(tens[-1]))
    lo, hi = np.searchsorted(tens, tenor, side="right") - 1, np.searchsorted(tens, tenor, side="left")
    rows = [i for i in range(len(exps)) if not np.isnan(vols[i, [lo, hi]]).any()] or \
           [i for i in range(len(exps)) if not np.isnan(vols[i]).all()]
    by_expiry = np.array([np.interp(tenor, tens[~np.isnan(vols[i])], vols[i][~np.isnan(vols[i])]) for i in rows])
    usable = exps[rows]
    expiry = min(max(float(s), 1.0), float(usable[-1]))
    return float(np.interp(expiry, usable, by_expiry))


def _implied_vol_setup(fwd_df: pd.DataFrame, legs: "set[str] | list[str]", grid: tuple,
                       n: int) -> "tuple[dict[str, float], pd.DataFrame]":
    """Each leg's implied vol and the legs' realised correlation matrix over the last n days."""
    legs = sorted(set(legs))
    leg_iv = {leg: _leg_implied_vol(*_parse_label(leg), grid) for leg in legs}
    corr = fwd_df[legs].diff().iloc[-n:].corr()
    return leg_iv, corr


def _implied_structure_vol(legs: tuple, weights: tuple, leg_iv: dict, corr: pd.DataFrame) -> "float | None":
    """Implied vol (bp/yr) of Σ w·leg."""
    sig = np.array([leg_iv[leg] for leg in legs]) * np.asarray(weights, float)
    C = corr.loc[list(legs), list(legs)].values
    if np.isnan(C).any():
        return None
    return float(np.sqrt(max(sig @ C @ sig, 0.0)))


def _zscore(series: pd.Series, n: int) -> float:
    window = series.iloc[-n:]
    std = float(window.std())
    return (float(window.iloc[-1]) - float(window.mean())) / std if std > 0 else 0.0


def compute_rv(currency: str = "EUR", as_of_date: str | None = None, refresh: bool = False,
               universe: str = "core") -> dict:
    ccy = currency.upper()
    if ccy not in _CCY_FILES:
        raise ValueError(f"Unsupported currency: {currency}")
    structures = _structures(universe)

    # 1. Load data — Bloomberg when it is the configured source, else (or on failure) CSV.
    #    The live window is the 5y to today; an as-of date slices it below.
    fetched = _load_bbg(ccy, refresh) if settings.data_source == "bloomberg" else None
    data_source = "bloomberg" if fetched is not None else "csv"
    if fetched is not None:
        cached = _rv_cache.get((ccy, as_of_date, universe))
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

    # 5. Build curve and fly time series (bps): curve = back − front, fly = 2·belly − wings
    all_series = []
    set_of: dict[str, str] = {}
    for label, group, legs, weights, which in structures:
        if any(leg not in fwd_df.columns for leg in legs):
            continue
        series = sum(w * fwd_df[leg] for w, leg in zip(weights, legs)) * 100
        all_series.append((label, group, series, legs, weights))
        set_of[label] = which

    n = len(fwd_df)
    win_1y = min(252, n)
    win_3m = min(63, n)

    # Curve factors and every leg's exposure to them, for the factor-neutral versions
    pc_dates, pc_scores, _, _ = _curve_factors(swap_df, fwd_df.index[-win_1y:])
    all_legs = {leg for _, _, _, legs, _ in all_series for leg in legs}
    exposure = {leg: _leg_exposure(fwd_df, leg, pc_dates, pc_scores) for leg in all_legs}

    # Implied vols from the swaption grid, when the currency has one
    grid = _vol_grid(fetched, fwd_df.index[-1])
    leg_iv, leg_corr = _implied_vol_setup(fwd_df, all_legs, grid, win_1y) if grid else ({}, None)

    rv_monitor = []
    for label, group, series, legs, weights in all_series:
        E = np.column_stack([exposure[leg] for leg in legs])
        neutral = _neutral_weights(group, E)
        if neutral is not None:
            neutral_series = sum(w * fwd_df[leg] for w, leg in zip(neutral, legs)) * 100
            neutral_z = round(_zscore(neutral_series, win_1y), 2)
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
        ivol = _implied_structure_vol(legs, weights, leg_iv, leg_corr) if grid else None
        ivol_bps = round(ivol, 2) if ivol is not None else None
        carry_ivol_ratio = round(carry1y_bps / ivol, 2) if ivol else None
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
                "rolled_label": _rolled_label(s, t),
                "rolled_rate": round(float(_fwd_rate(*_rolled(s, t), D)), 4),
                "contribution_bps": round(float(w * _carry_fwd_bps(leg, D)), 2),
                "ivol_bps": round(leg_iv[leg], 2) if leg in leg_iv else None,
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
            "ivol_bps": ivol_bps,                    # implied vol of the structure, bp/yr (None: no grid)
            "carry_ivol_ratio": carry_ivol_ratio,
            "legs": leg_detail,
            "set": set_of[label],
            # Factor-neutral version: curves level-neutral, flies level- and slope-neutral
            "neutral_weights": [round(w, 3) for w in neutral] if neutral else None,
            "neutral_zscore_1y": neutral_z if neutral else None,
            "neutral_unstable": _neutral_unstable(group, neutral) if neutral else None,
            "factor_share": round(_factor_share(group, weights, E, series, pc_dates), 3),
        })

    # Curve the carry is computed on: par quotes, the fitted par curve, and a forward
    # curve f(s, t) by start s for every leg tenor t (s = 0 is the spot par rate).
    leg_tenors = sorted({t for _, _, _, legs, _ in all_series for s, t in map(_parse_label, legs) if s >= 1})
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
            "set": set_of[label],
        })

    # Each structure's full history is served on demand (compute_history) when its detail
    # view opens, so the payload stays small however large the universe.

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
        "universe": universe,
        # Where the implied vols come from; None when the currency has no swaption grid
        "implied_vol": {"source": "ATM normal swaption vols (ICAP)", "grid_date": grid[3]} if grid else None,
        "policy_meetings": _policy_meetings(ccy, fwd_df.index[0].strftime("%Y-%m-%d"), as_of),
    }
    if fetched is not None:
        # Drop this currency's payloads built from older data, then remember this one
        for key in [k for k, v in _rv_cache.items() if k[0] == ccy and v[0] != fetched[0]]:
            del _rv_cache[key]
        _rv_cache[(ccy, as_of_date, universe)] = (fetched[0], payload)
    return payload


# ---------------------------------------------------------------------------
# Regression detail for one structure (detail view)
# ---------------------------------------------------------------------------

def _expression(ccy: str, label: str) -> "tuple[str, tuple, tuple]":
    """(group, legs, weights) for a curve or fly label in the full universe."""
    for lbl, group, legs, weights, _ in _structures("extended"):
        if lbl == label:
            return group, legs, weights
    raise KeyError(f"Unknown {ccy} structure: {label}")


def compute_history(currency: str, label: str, as_of_date: str | None = None) -> dict:
    """Full daily history (bps) of one structure up to the as-of date, for its detail view."""
    ccy = currency.upper()
    if ccy not in _CCY_FILES:
        raise ValueError(f"Unsupported currency: {currency}")
    _, legs, weights = _expression(ccy, label)
    fetched = _load_bbg(ccy) if settings.data_source == "bloomberg" else None
    fwd_df, _, _, _, _ = _load_frames(ccy, as_of_date, fetched)
    if any(leg not in fwd_df.columns for leg in legs):
        raise KeyError(f"No data for {label}")
    series = (sum(w * fwd_df[leg] for w, leg in zip(weights, legs)) * 100).dropna().round(2)
    return {
        "label": label,
        "points": [{"date": d.strftime("%Y-%m-%d"), "value": float(v)} for d, v in series.items()],
    }


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


def compute_neutral(currency: str, label: str, as_of_date: str | None = None) -> dict:
    """
    One structure next to its factor-neutral version: the curve factors, each leg's exposure,
    the neutral weights, both structures' factor exposures and statistics, and both histories.
    """
    ccy = currency.upper()
    if ccy not in _CCY_FILES:
        raise ValueError(f"Unsupported currency: {currency}")
    group, legs, weights = _expression(ccy, label)

    fetched = _load_bbg(ccy) if settings.data_source == "bloomberg" else None
    fwd_df, _, swap_df, _, _ = _load_frames(ccy, as_of_date, fetched)
    if any(leg not in fwd_df.columns for leg in legs):
        raise KeyError(f"No forward data for {label}")

    n = len(fwd_df)
    win_1y, win_3m = min(252, n), min(63, n)
    dates, scores, load, share = _curve_factors(swap_df, fwd_df.index[-win_1y:])
    E = np.column_stack([_leg_exposure(fwd_df, leg, dates, scores) for leg in legs])
    neutral = _neutral_weights(group, E)

    as_of_ts = fwd_df.index[-1]
    D = _build_discount_factors(swap_df.loc[swap_df.index <= as_of_ts].iloc[-1].values.astype(float))
    leg_carry = [_carry_fwd_bps(leg, D) for leg in legs]
    grid = _vol_grid(fetched, as_of_ts)
    leg_iv, leg_corr = _implied_vol_setup(fwd_df, legs, grid, win_1y) if grid else ({}, None)

    def build(w: tuple) -> pd.Series:
        return sum(wi * fwd_df[leg] for wi, leg in zip(w, legs)) * 100

    def stats_of(w: tuple, s: pd.Series) -> dict:
        window = s.iloc[-win_1y:]
        e = E @ np.asarray(w, float)
        carry = float(sum(wi * c for wi, c in zip(w, leg_carry)))
        vol = float(s.diff().iloc[-win_3m:].std()) * 252 ** 0.5
        ivol = _implied_structure_vol(legs, w, leg_iv, leg_corr) if grid else None
        return {
            "value_bps": round(float(s.iloc[-1]), 2),
            "zscore_1y": round(_zscore(s, win_1y), 2),
            "pctile_1y": round(float(stats.percentileofscore(window.values, float(s.iloc[-1]))), 1),
            "vol3m_bps": round(vol, 2),
            "ivol_bps": round(ivol, 2) if ivol is not None else None,
            "carry1y_bps": round(carry, 2),
            "carry_vol_ratio": round(carry / vol, 2) if vol > 0 else None,
            "carry_ivol_ratio": round(carry / ivol, 2) if ivol else None,
            "exposure": {name: round(float(v), 3) for name, v in zip(_PC_NAMES, e)},
        }

    standard = build(weights)
    neutral_series = build(neutral) if neutral else None
    hist = pd.DataFrame({"standard": standard, "neutral": neutral_series}).dropna(subset=["standard"]).round(2)

    return {
        "label": label,
        "group": group,
        "currency": ccy,
        "as_of": as_of_ts.strftime("%Y-%m-%d"),
        "data_source": "bloomberg" if fetched is not None else "csv",
        "window_days": len(dates),
        "hedged": list(_PC_NAMES[: 1 if group == "curve" else 2]),
        "factors": [{
            "name": name,
            "variance_share": round(float(share[k]), 4),
            "loadings": [{"tenor": int(str(t).rstrip("y")), "loading": round(float(v), 4)} for t, v in zip(swap_df.columns, load[k])],
        } for k, name in enumerate(_PC_NAMES)],
        "legs": [{
            "label": leg,
            "weight": weights[i],
            "neutral_weight": round(neutral[i], 4) if neutral else None,
            "carry1y_bps": round(float(leg_carry[i]), 2),
            "exposure": {name: round(float(E[k, i]), 3) for k, name in enumerate(_PC_NAMES)},
        } for i, leg in enumerate(legs)],
        "factor_share": round(_factor_share(group, weights, E, standard, dates), 3),
        "unstable": _neutral_unstable(group, neutral) if neutral else None,
        "standard": stats_of(weights, standard),
        "neutral": stats_of(neutral, neutral_series) if neutral else None,
        "history": [{
            "date": d.strftime("%Y-%m-%d"),
            "standard": float(r.standard),
            "neutral": None if pd.isna(r.neutral) else float(r.neutral),
        } for d, r in hist.iterrows()],
    }


# ---------------------------------------------------------------------------
# Carry realisation backtest
# ---------------------------------------------------------------------------
# For every past day t and structure: the 1y carry an unchanged curve predicted on t,
# and the P&L of holding it for a year (receive at f_t(s, T), mark at f_{t+1y}(s-1, T)).
# realised = carry + forward error, where forward error = f_t(s-1, T) - f_{t+1y}(s-1, T):
# how far the rolled point moved from where t's curve put it. All days and structures are
# computed in one vectorised pass and cached until the data changes.

_BT_WINDOWS = {"1y": pd.DateOffset(years=1), "2y": pd.DateOffset(years=2), "all": None}
_bt_cache: dict[str, tuple] = {}   # ccy -> (data stamp, core arrays)


def _carry_backtest_core(ccy: str, swap_df: pd.DataFrame) -> dict:
    dates = swap_df.index
    D = _discount_factor_matrix(swap_df.values.astype(float))
    A = np.cumsum(D, axis=1)
    fwd_cache: dict[tuple, np.ndarray] = {}

    def f(s: int, t: int) -> np.ndarray:   # forward in bp for every day
        if (s, t) not in fwd_cache:
            fwd_cache[(s, t)] = _fwd_rate_vec(s, t, D, A) * 100.0
        return fwd_cache[(s, t)]

    # Day t's holding period ends on the last business day on or before t + 1y
    targets = dates + pd.DateOffset(years=1)
    has_end = targets <= dates[-1]
    end_idx = np.clip(dates.searchsorted(targets, side="right") - 1, 0, len(dates) - 1)

    labels, groups, sets, carry_cols, real_cols = [], [], [], [], []
    for lbl, group, legs, weights, which in _structures("extended"):
        st = [_parse_label(leg) for leg in legs]
        carry = sum(w * (f(s, t) - f(*_rolled(s, t))) for w, (s, t) in zip(weights, st))
        realised = sum(w * (f(s, t) - f(*_rolled(s, t))[end_idx]) for w, (s, t) in zip(weights, st))
        labels.append(lbl)
        groups.append(group)
        sets.append(which)
        carry_cols.append(carry)
        real_cols.append(np.where(has_end, realised, np.nan))
    return {
        "dates": dates, "end_dates": dates[end_idx], "has_end": has_end,
        "labels": labels, "groups": groups, "sets": np.array(sets),
        "carry": np.column_stack(carry_cols), "realised": np.column_stack(real_cols),
    }


def _row_rank_corr(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Spearman correlation across structures, one value per start date (rows)."""
    rx = stats.rankdata(x, axis=1)
    ry = stats.rankdata(y, axis=1)
    rx -= rx.mean(axis=1, keepdims=True)
    ry -= ry.mean(axis=1, keepdims=True)
    den = np.sqrt((rx ** 2).sum(axis=1) * (ry ** 2).sum(axis=1))
    return np.divide((rx * ry).sum(axis=1), den, out=np.full(len(rx), np.nan), where=den > 0)


def _bt_stats(carry: np.ndarray, realised: np.ndarray) -> dict:
    """Pooled stats; the 'strategy' receives a structure when its carry is positive, pays when negative."""
    c, r = carry.ravel(), realised.ravel()
    sgn = np.sign(c)
    pred, real = float(np.mean(sgn * c)), float(np.mean(sgn * r))
    return {
        "predicted_bp": round(pred, 2),
        "realised_bp": round(real, 2),
        "delivered": round(real / pred, 3) if pred > 0 else None,
        "hit_rate": round(float(np.mean(np.sign(r) == sgn)), 3),
        "slope": round(float(np.polyfit(c, r, 1)[0]), 3) if len(c) > 2 and np.ptp(c) > 0 else None,
    }


def compute_carry_backtest(currency: str = "EUR", as_of_date: str | None = None,
                           label: str | None = None, window: str = "1y", universe: str = "core") -> dict:
    """
    How much of the predicted 1y roll-down was delivered, for holding periods ending in
    `window` before the as-of date: per currency (all structures) and per structure; with
    `label`, that structure's full predicted-vs-realised history.
    """
    ccy = currency.upper()
    if ccy not in _CCY_FILES:
        raise ValueError(f"Unsupported currency: {currency}")
    if window not in _BT_WINDOWS:
        raise ValueError(f"window must be one of {list(_BT_WINDOWS)}")
    if universe not in UNIVERSES:
        raise ValueError(f"universe must be one of {UNIVERSES}")

    fetched = _load_bbg(ccy) if settings.data_source == "bloomberg" else None
    stamp = fetched[0] if fetched is not None else "csv"
    hit = _bt_cache.get(ccy)
    if hit and hit[0] == stamp:
        core = hit[1]
    else:
        swap_df = fetched[1][2] if fetched is not None else \
            pd.read_csv(DATA_DIR / _CCY_FILES[ccy]["swaps"], parse_dates=["date"], index_col="date")
        core = _carry_backtest_core(ccy, swap_df.sort_index())
        _bt_cache[ccy] = (stamp, core)

    dates, end_dates = core["dates"], core["end_dates"]
    as_of = min(pd.Timestamp(as_of_date), dates[-1]) if as_of_date else dates[-1]
    known = core["has_end"] & (end_dates <= as_of)           # outcome observable by the as-of date
    span = _BT_WINDOWS[window]
    in_window = known & ((end_dates > as_of - span) if span is not None else True)

    labels = core["labels"]
    cols = np.flatnonzero(core["sets"] == "core") if universe == "core" else np.arange(len(labels))
    carry = core["carry"][in_window][:, cols]
    realised = core["realised"][in_window][:, cols]
    n_starts = int(in_window.sum())

    result: dict = {
        "currency": ccy,
        "as_of": as_of.strftime("%Y-%m-%d"),
        "data_source": "bloomberg" if fetched is not None else "csv",
        "window": window,
        "universe": universe,
        "n_starts": n_starts,
        "first_end": end_dates[in_window][0].strftime("%Y-%m-%d") if n_starts else None,
        "last_end": end_dates[in_window][-1].strftime("%Y-%m-%d") if n_starts else None,
        "summary": None,
        "structures": [],
    }
    if n_starts >= 2:
        result["summary"] = {
            **_bt_stats(carry, realised),
            "rank_corr": round(float(np.nanmean(_row_rank_corr(carry, realised))), 3),
        }
        for j, k in enumerate(cols):
            st = _bt_stats(carry[:, j], realised[:, j])
            result["structures"].append({
                "label": labels[k], "group": core["groups"][k], "set": str(core["sets"][k]),
                "avg_carry_bp": round(float(carry[:, j].mean()), 2),
                "avg_realised_bp": round(float(realised[:, j].mean()), 2),
                "hit_rate": st["hit_rate"], "delivered": st["delivered"], "slope": st["slope"],
            })

    if label is not None:
        if label not in labels:
            raise KeyError(f"Unknown {ccy} structure: {label}")
        k = labels.index(label)
        upto = dates <= as_of
        series = []
        for i in np.flatnonzero(upto):
            done = bool(known[i])
            c = float(core["carry"][i, k])
            r = float(core["realised"][i, k]) if done else None
            series.append({
                "start": dates[i].strftime("%Y-%m-%d"),
                "end": end_dates[i].strftime("%Y-%m-%d") if done else None,
                "carry": round(c, 2),
                "realised": round(r, 2) if r is not None else None,
                "fwd_err": round(r - c, 2) if r is not None else None,
            })
        result["series"] = series
    return result


# ---------------------------------------------------------------------------
# Trade candidates
# ---------------------------------------------------------------------------
# Every structure's mean-reversion trade, in one direction: rich (Z > 0) is expected to fall,
# so the trade is the flattener / receive-belly position, which is the side carry1y_bps is
# quoted for; cheap (Z < 0) is the opposite. Expected 1y P&L = the part of today's deviation
# from the 1y mean an AR(1) fitted to the last year says reverts within a year, plus carry in
# the trade direction; score = expected P&L / 3m realised vol. The checks say which signals
# agree with the trade; the page filters on them.

_CAND_BASES = ("neutral", "standard")
_cand_cache: dict[tuple, tuple] = {}   # (ccy, as_of, universe, basis) -> (data stamp, payload)


def _ar1_reversion(series: pd.Series, n: int) -> "tuple[float | None, float]":
    """(half-life in days, share of a deviation expected to revert within a year) from an
    AR(1) on the last n days' levels; no mean reversion gives (None, 0)."""
    x = series.iloc[-n:].values
    if len(x) < 20:
        return None, 0.0
    b = float(np.polyfit(x[:-1], x[1:], 1)[0])
    if not 0 < b < 1:
        return None, 0.0
    return float(np.log(2) / -np.log(b)), float(1 - b ** 252)


def compute_candidates(currency: str = "EUR", as_of_date: str | None = None,
                       universe: str = "core", basis: str = "neutral") -> dict:
    ccy = currency.upper()
    if ccy not in _CCY_FILES:
        raise ValueError(f"Unsupported currency: {currency}")
    if basis not in _CAND_BASES:
        raise ValueError(f"basis must be one of {_CAND_BASES}")

    rv = compute_rv(ccy, as_of_date, universe=universe)
    fetched = _load_bbg(ccy) if settings.data_source == "bloomberg" else None
    stamp = fetched[0] if fetched is not None else "csv"
    key = (ccy, as_of_date, universe, basis)
    hit = _cand_cache.get(key)
    if hit and hit[0] == stamp:
        return hit[1]

    fwd_df, _, swap_df, _, _ = _load_frames(ccy, as_of_date, fetched)
    n = len(fwd_df)
    win_1y, win_3m = min(252, n), min(63, n)
    D = _build_discount_factors(swap_df.loc[swap_df.index <= fwd_df.index[-1]].iloc[-1].values.astype(float))
    # Exact neutral weights (the monitor's are rounded, and a near-cancelling structure is sensitive to that)
    pc_dates, pc_scores, _, _ = _curve_factors(swap_df, fwd_df.index[-win_1y:])
    leg_exposure: dict[str, np.ndarray] = {}
    grid = _vol_grid(fetched, fwd_df.index[-1])
    leg_iv, leg_corr = (_implied_vol_setup(fwd_df, {leg for r in rv["rv_monitor"] for leg in _expression(ccy, r["label"])[1]},
                                           grid, win_1y) if grid else ({}, None))
    resid_z = {b["label"]: b["residual_zscore"] for b in rv["beta_monitor"]}
    bt = compute_carry_backtest(ccy, as_of_date, window="2y", universe=universe)
    hit_rate = {s["label"]: s["hit_rate"] for s in bt["structures"]}

    rows = []
    for r in rv["rv_monitor"]:
        group, legs, std_w = _expression(ccy, r["label"])
        neutral = None
        if basis == "neutral":
            for leg in legs:
                if leg not in leg_exposure:
                    leg_exposure[leg] = _leg_exposure(fwd_df, leg, pc_dates, pc_scores)
            neutral = _neutral_weights(group, np.column_stack([leg_exposure[leg] for leg in legs]))
        use_neutral = neutral is not None
        weights = neutral if use_neutral else std_w
        series = sum(w * fwd_df[leg] for w, leg in zip(weights, legs)) * 100
        window = series.iloc[-win_1y:]
        value, mean, std = float(series.iloc[-1]), float(window.mean()), float(window.std())
        z = (value - mean) / std if std > 0 else 0.0
        down = z > 0                                    # rich: expect the structure to fall
        sign = 1.0 if down else -1.0
        carry = sign * float(sum(w * _carry_fwd_bps(leg, D) for w, leg in zip(weights, legs)))
        vol = float(series.diff().iloc[-win_3m:].std()) * 252 ** 0.5
        ivol = _implied_structure_vol(legs, weights, leg_iv, leg_corr) if grid else None
        half_life, revert_share = _ar1_reversion(series, win_1y)
        reversion = abs(value - mean) * revert_share
        expected = reversion + carry
        rz = resid_z.get(r["label"])
        hr = hit_rate.get(r["label"])
        checks = {
            "carry": carry >= 0,
            "residual": rz is not None and rz * z > 0 and abs(rz) >= 1,
            "reversion": half_life is not None and half_life <= 252,
            "delivered": hr is not None and hr >= 0.5,
            "stable": not (use_neutral and _neutral_unstable(group, neutral)),
        }
        rows.append({
            "label": r["label"],
            "group": group,
            "set": r["set"],
            "basis": "neutral" if use_neutral else "standard",
            "weights": [round(float(w), 3) for w in weights],
            "trade": ("Flattener" if down else "Steepener") if group == "curve"
                     else ("Receive belly" if down else "Pay belly"),
            "zscore_1y": round(z, 2),
            "residual_zscore": rz,
            "deviation_bp": round(value - mean, 2),
            "half_life_days": round(half_life, 1) if half_life is not None else None,
            "expected_reversion_bp": round(reversion, 2),
            "carry_bp": round(carry, 2),
            "expected_bp": round(expected, 2),
            "vol3m_bp": round(vol, 2),
            "score": round(expected / vol, 2) if vol > 0 else None,          # on 3m realised vol
            "ivol_bp": round(ivol, 2) if ivol is not None else None,
            "score_implied": round(expected / ivol, 2) if ivol else None,    # on implied vol
            "factor_share": r["factor_share"],
            "carry_hit_rate_2y": hr,
            "checks": checks,
            "n_agree": sum(checks[k] for k in ("carry", "residual", "reversion", "delivered")),
        })

    payload = {
        "currency": ccy,
        "as_of": rv["as_of"],
        "data_source": rv["data_source"],
        "universe": universe,
        "basis": basis,
        "candidates": rows,
    }
    _cand_cache[key] = (stamp, payload)
    return payload
