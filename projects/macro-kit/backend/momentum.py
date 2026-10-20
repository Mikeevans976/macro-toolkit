"""
momentum.py — CTA trend-following model: signals, positioning, flows.

Signal (per market, per speed k)
--------------------------------
    r_t   = return (price series: p_t/p_{t-1}-1; level series such as yields
            and spreads: p_t - p_{t-1})
    σ_t   = EWMA daily vol of r (half-life VOL_HALFLIFE, zero mean)
    n_t   = r_t / σ_{t-1}                     vol-normalised return, clipped ±N_CLIP
    z_t   = Σ n                               vol-adjusted price
    x_k   = EMA_fast(z) - EMA_slow(z)         spans from SPEEDS
    y_k   = x_k / sqrt(V_k)                   V_k = variance of x_k when z is a
                                              unit random walk (closed form), so
                                              y_k ~ N(0,1) with no trend
    φ(y)  = response, |φ| ≤ 1: tanh (default), baz (y·e^{-y²/4}, peaks at √2
            then fades) or linear (capped at 2σ)
    s     = Σ_k w_k φ(y_k)                    position, -1..+1 (% of max ×100)

Everything is a linear recursion on z, so the next-day price at which a speed
(or the composite) flips, and the position after any hypothetical price path,
are exact (_State / _project).

Portfolio, sizing and calibration
---------------------------------
CTA markets carry risk weights w_i (momentum_universe.risk_weights). With
u = r/σ_ann (one unit of position = 100 % annual vol), the model portfolio
earns B · Σ_i w_i s_i u_i, so a full position in market i carries
AUM · B · w_i dollars of annual vol and

    notional_i = AUM · B · w_i · s_i / σ_ann,i

B (leverage) and the speed weights w_k come from regressing weekly SG Trend
Index returns on the four single-speed portfolios (non-negative least
squares, last CALIB_WEEKS weeks), for each response function; the best fit is
used. Without the index (or with a poor fit) the defaults are equal speed
weights, tanh, and B sized to DEFAULT_TARGET_VOL.

Data
----
Live only when settings.data_source == "bloomberg". Generic futures are
fetched ratio back-adjusted (`TY1 R:00_0_R Comdty`); the universe is cached
on disk and topped up incrementally. Otherwise every series is a
deterministic simulation (zlib.crc32 seeds) and the payload says so.
"""
from __future__ import annotations

import logging
import math
import re
import threading
import time
import zlib
from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd
from scipy.optimize import brentq, nnls
from scipy.signal import lfilter

import momentum_universe as mu
from mean_reversion import parse_expression
from runtime_paths import state_path
from settings import settings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SPEEDS: list[tuple[str, int, int]] = [
    ("8/24", 8, 24), ("16/48", 16, 48), ("32/96", 32, 96), ("64/192", 64, 192),
]
SPEED_NAMES = [s[0] for s in SPEEDS]
_A_FAST = np.array([2.0 / (f + 1) for _, f, _ in SPEEDS])
_A_SLOW = np.array([2.0 / (s + 1) for _, _, s in SPEEDS])

VOL_HALFLIFE = 20          # days, EWMA vol
N_CLIP = 10.0              # cap on one day's vol-normalised return
WARMUP = 300               # days dropped while the slow EMAs build memory
ER_WINDOW = 63             # efficiency ratio window (regime)
RESPONSES = ("tanh", "baz", "linear")
DEFAULT_RESPONSE = "tanh"
DEFAULT_TARGET_VOL = 0.12  # annual vol of the uncalibrated model CTA
DEFAULT_AUM_BN = 300.0     # trend-following AUM, $bn (user input)
CALIB_WEEKS = 156
UNIVERSE_START = "2012-01-01"
SIM_ORIGIN = "2000-01-03"   # simulations start here and are sliced, so every view agrees
HORIZONS = (5, 10)         # scenario horizons, business days
SHOCKS = (-2.0, -1.0, 0.0, 1.0, 2.0)  # scenario moves, in σ over the horizon
FLAT_FLIP_MAX_DAYS = 60
_CACHE_TTL_S = 15 * 60


def _ema_diff_var(a_f: np.ndarray, a_s: np.ndarray) -> np.ndarray:
    """Var(EMA_f(z) - EMA_s(z)) for z a random walk with unit-variance steps.

    EMA_a(z)_t = Σ_m n_{t-m} (1 - b^{m+1}), b = 1-a, so the difference has
    coefficients b_s^{m+1} - b_f^{m+1}; summing their squares gives the result.
    """
    bf, bs = 1 - a_f, 1 - a_s
    return bs**2 / (1 - bs**2) - 2 * bs * bf / (1 - bs * bf) + bf**2 / (1 - bf**2)


_SD_X = np.sqrt(_ema_diff_var(_A_FAST, _A_SLOW))
_BAZ_PEAK = math.sqrt(2) * math.exp(-0.5)


def response(y, kind: str = DEFAULT_RESPONSE):
    """Map normalised trend strength y to a position in [-1, 1]."""
    y = np.asarray(y, dtype=float)
    if kind == "tanh":
        return np.tanh(y / 1.5)
    if kind == "baz":
        return y * np.exp(-y * y / 4) / _BAZ_PEAK
    if kind == "linear":
        return np.clip(y / 2, -1, 1)
    raise ValueError(f"unknown response {kind!r}")


# ---------------------------------------------------------------------------
# Signal engine
# ---------------------------------------------------------------------------

@dataclass
class Signals:
    kind: str
    price: pd.Series        # input series (own calendar)
    r: pd.Series            # returns
    sigma: pd.Series        # daily vol through t
    n: pd.Series            # vol-normalised returns
    z: pd.Series
    ef: pd.DataFrame        # fast EMAs of z, one column per speed
    es: pd.DataFrame
    y: pd.DataFrame         # normalised trend strength per speed


def compute_signals(series: pd.Series, kind: str) -> Signals:
    p = series.dropna().astype(float)
    p = p[~p.index.duplicated(keep="last")].sort_index()
    if kind == "price":
        if (p <= 0).any():
            raise ValueError("price series must be positive; use kind='level'")
        r = p.pct_change()
    else:
        r = p.diff()
    sigma = np.sqrt((r * r).ewm(halflife=VOL_HALFLIFE, min_periods=20).mean())
    sigma = sigma.where(sigma > 0)
    n = (r / sigma.shift(1)).replace([np.inf, -np.inf], np.nan).clip(-N_CLIP, N_CLIP)
    first = n.first_valid_index()
    if first is None:
        raise ValueError("not enough history")
    keep = n.index >= first
    p, r, sigma, n = p[keep], r[keep], sigma[keep], n[keep].fillna(0.0)
    z = n.cumsum()
    ef = pd.DataFrame({nm: z.ewm(span=f, adjust=False).mean() for nm, f, _ in SPEEDS})
    es = pd.DataFrame({nm: z.ewm(span=s, adjust=False).mean() for nm, _, s in SPEEDS})
    y = (ef - es) / _SD_X
    return Signals(kind, p, r, sigma, n, z, ef, es, y)


def composite(y: pd.DataFrame | np.ndarray, weights: np.ndarray, resp: str):
    """Position s = Σ w_k φ(y_k); rows of a DataFrame or one vector."""
    if isinstance(y, pd.DataFrame):
        return pd.Series(response(y.values, resp) @ weights, index=y.index)
    return float(response(y, resp) @ weights)


def efficiency_ratio(p: pd.Series, window: int = ER_WINDOW) -> float | None:
    if len(p) <= window:
        return None
    path = p.diff().abs().iloc[-window:].sum()
    return None if path == 0 else float(abs(p.iloc[-1] - p.iloc[-1 - window]) / path)


def classify(y: np.ndarray, er: float | None) -> tuple[str, int, bool]:
    """Trend regime from the four speeds' y (fastest first) and the efficiency ratio.

    Returns (label, direction -1/0/+1, stretched). Direction is the series'
    own direction (yields up = +1).
    """
    y = np.asarray(y, dtype=float)
    fast, slow, avg = y[0], (y[2] + y[3]) / 2, y.mean()
    stretched = bool(abs(avg) > 2.0)
    sg = int(np.sign(avg))
    if np.sign(fast) != np.sign(slow) and abs(fast) >= 1.0 and abs(slow) >= 0.75:
        return "Reversal", int(np.sign(fast)), stretched
    if sg and (np.sign(y) == sg).all() and abs(avg) >= 1.5:
        return "Strong momentum", sg, stretched
    if sg and abs(avg) >= 0.75 and (np.sign(y) == sg).sum() >= 3:
        return "Momentum", sg, stretched
    if abs(slow) >= 0.75 and abs(fast) < 0.5:
        return "Fading", int(np.sign(slow)), stretched
    if er is not None and er < 0.2 and abs(avg) < 0.5:
        return "Range", 0, stretched
    return "Mixed", sg if abs(avg) >= 0.25 else 0, stretched


# ---------------------------------------------------------------------------
# Projection: triggers and scenarios
# ---------------------------------------------------------------------------

@dataclass
class _State:
    kind: str
    p: float
    z: float
    ef: np.ndarray
    es: np.ndarray
    sigma: float            # daily vol that normalises the next return

    @classmethod
    def last(cls, sig: Signals) -> "_State":
        return cls(sig.kind, float(sig.price.iloc[-1]), float(sig.z.iloc[-1]),
                   sig.ef.iloc[-1].to_numpy(copy=True), sig.es.iloc[-1].to_numpy(copy=True),
                   float(sig.sigma.iloc[-1]))

    def move(self, k):
        """Price after a move of k daily σ (scalar or array)."""
        return self.p * (1 + k * self.sigma) if self.kind == "price" else self.p + k * self.sigma


def _project(st: _State, path) -> np.ndarray:
    """y per speed after the closes in `path` (σ held at today's value)."""
    return _project_many(st, np.asarray(path, dtype=float).reshape(1, -1))[0]


def _project_many(st: _State, paths: np.ndarray) -> np.ndarray:
    """_project for many paths at once: paths (m, h) -> y (m, speeds)."""
    m = paths.shape[0]
    z = np.full(m, st.z)
    ef, es = np.tile(st.ef, (m, 1)), np.tile(st.es, (m, 1))
    p = np.full(m, st.p)
    for j in range(paths.shape[1]):
        q = paths[:, j]
        r = q / p - 1 if st.kind == "price" else q - p
        z = z + np.clip(r / st.sigma, -N_CLIP, N_CLIP)
        ef = (1 - _A_FAST) * ef + _A_FAST * z[:, None]
        es = (1 - _A_SLOW) * es + _A_SLOW * z[:, None]
        p = q
    return (ef - es) / _SD_X


def _flip_speed(st: _State) -> list[float | None]:
    """Next-close move, in daily σ, at which each speed's crossover hits zero."""
    out: list[float | None] = []
    for k in range(len(SPEEDS)):
        af, a_s = _A_FAST[k], _A_SLOW[k]
        z_star = ((1 - a_s) * st.es[k] - (1 - af) * st.ef[k]) / (af - a_s)
        nstar = z_star - st.z
        out.append(float(nstar) if abs(nstar) <= N_CLIP else None)
    return out


def _flip_composite(st: _State, w: np.ndarray, resp: str) -> float | None:
    """Smallest next-close move (daily σ) that sends the composite through zero."""
    f = lambda k: composite(_project(st, [st.move(k)]), w, resp)  # noqa: E731
    grid = np.linspace(-N_CLIP, N_CLIP, 201)
    vals = response(_project_many(st, st.move(grid)[:, None]), resp) @ w
    roots = []
    for i in np.nonzero(np.sign(vals[:-1]) * np.sign(vals[1:]) < 0)[0]:
        roots.append(brentq(f, grid[i], grid[i + 1], xtol=1e-6))
    return float(min(roots, key=abs)) if roots else None


def _flat_days_to_flip(st: _State, w: np.ndarray, resp: str) -> int | None:
    s = np.sign(composite(_project(st, []), w, resp))
    z, ef, es = st.z, st.ef.copy(), st.es.copy()   # flat price: z stays put
    for d in range(1, FLAT_FLIP_MAX_DAYS + 1):
        ef = (1 - _A_FAST) * ef + _A_FAST * z
        es = (1 - _A_SLOW) * es + _A_SLOW * z
        if np.sign(composite((ef - es) / _SD_X, w, resp)) != s:
            return d
    return None


def _scenario_paths(st: _State, horizon: int, shock: float) -> list[float]:
    """Straight-line path to a move of `shock` σ over `horizon` days."""
    k_total = shock * math.sqrt(horizon)
    return [st.move(k_total * j / horizon) for j in range(1, horizon + 1)]


def scenarios(st: _State, w: np.ndarray, resp: str) -> list[dict]:
    s0 = composite(_project(st, []), w, resp)
    out = []
    for h in HORIZONS:
        for k in SHOCKS:
            path = _scenario_paths(st, h, k)
            s1 = composite(_project(st, path), w, resp)
            out.append({"horizon_days": h, "shock_sigma": k, "price": path[-1],
                        "position": 100 * s1, "delta": 100 * (s1 - s0)})
    return out


def triggers(st: _State, w: np.ndarray, resp: str) -> dict:
    def lvl(k):
        if k is None:
            return None
        price = st.move(k)
        return {"price": price, "move": price - st.p, "sigma": k}
    return {
        "composite": lvl(_flip_composite(st, w, resp)),
        "speeds": [{"speed": nm, **(lvl(k) or {"price": None, "move": None, "sigma": None})}
                   for nm, k in zip(SPEED_NAMES, _flip_speed(st))],
        "flat_days_to_flip": _flat_days_to_flip(st, w, resp),
    }


# ---------------------------------------------------------------------------
# Data: simulation
# ---------------------------------------------------------------------------

def _seed(name: str) -> int:
    return zlib.crc32(name.encode())


def _regime_noise(name: str, n: int, trend: float) -> np.ndarray:
    """Unit-variance daily shocks with alternating trending / choppy regimes."""
    rng = np.random.default_rng(_seed(name))
    out = np.empty(n)
    i = 0
    while i < n:
        L = int(rng.integers(40, 161))
        drift = rng.choice([-1, 1]) * rng.uniform(0.04, trend) if rng.random() < 0.5 else 0.0
        m = min(L, n - i)
        out[i:i + m] = drift + rng.standard_normal(m)
        i += m
    return out


_SIM_VOL = {  # annual vol of simulated price series, by group
    "Bond futures": 0.06, "STIR futures": 0.012, "FX futures": 0.09,
    "Equity index futures": 0.18, "Commodity futures": 0.28,
}


def _simulate_ticker(ticker: str, dates: pd.DatetimeIndex) -> pd.Series:
    """Deterministic stand-in for one Bloomberg ticker.

    Yield-like tickers get yield levels in %, everything else a price.
    Universe members share a group factor so sectors co-move.
    """
    n = len(dates)
    m = mu.BY_EXPR.get(ticker)
    if _looks_like_yield(ticker):
        f = _regime_noise("sim-factor-rates", n, 0.12)
        e = _regime_noise(ticker, n, 0.08)
        dy = 0.065 * (0.75 * f + 0.66 * e)          # ~6.5bp/day
        return pd.Series(3.0 + _revert(dy, 750), index=dates, name=ticker)
    group = m.group if m else "other"
    vol = _SIM_VOL.get(group, 0.15) / math.sqrt(252)
    sign = -1.0 if group == "Bond futures" else 1.0  # bonds rally when yields fall
    f = _regime_noise("sim-factor-rates" if group == "Bond futures" else f"sim-factor-{group}", n, 0.12)
    e = _regime_noise(ticker, n, 0.08)
    r = vol * (sign * 0.6 * f + 0.8 * e)
    return pd.Series(100.0 * np.exp(_revert(r, 1000)), index=dates, name=ticker)


def _revert(steps: np.ndarray, days: float) -> np.ndarray:
    """Cumulate steps with a slow pull back to zero (time scale `days`), so
    simulated levels stay plausible over decades."""
    return lfilter([1.0], [1.0, -(1 - 1 / days)], steps)


# ---------------------------------------------------------------------------
# Data: Bloomberg
# ---------------------------------------------------------------------------

_GENERIC_FUT = re.compile(r"^([A-Z][A-Z ]{0,3}?)(\d{1,2}) (Comdty|Index|Curncy)$")
_YIELD_PATTERNS = re.compile(
    r"^(USGG|GT[A-Z]{3}\d|GDBR|GUKG|GJGB|GFRN|GBTPGR|GSPG|GCAN|GACGB|GNZGB|GSWISS|GSGB|"
    r"BV\d{6} BVLI|USSW|USOSFR|USSO|EUSA|EESWE|BPSW|BPSWS|JYSO|EUSWE|S0)", re.I)


def _looks_like_yield(ticker: str) -> bool:
    return ticker.endswith(" Govt") or bool(_YIELD_PATTERNS.match(ticker))


def is_generic_future(ticker: str) -> bool:
    """Generic futures tickers such as 'TY1 Comdty', 'G 1 Comdty', 'ES1 Index'."""
    return bool(_GENERIC_FUT.match(ticker)) and not _looks_like_yield(ticker)


def adjusted_ticker(ticker: str) -> str:
    """Ratio back-adjusted generic: 'TY1 Comdty' -> 'TY1 R:00_0_R Comdty'."""
    root, yk = ticker.rsplit(" ", 1)
    return f"{root} R:00_0_R {yk}"


def _bdh(tickers: list[str], start: str) -> dict[str, pd.Series]:
    import bbg
    end = pd.Timestamp.today().strftime("%Y-%m-%d")
    df = bbg.bdh(tickers, ["PX_LAST"], start, end)
    out: dict[str, pd.Series] = {}
    if df is None or df.empty:
        return out
    for t in tickers:
        if (t, "PX_LAST") in df.columns:
            s = df[(t, "PX_LAST")].dropna()
            if len(s):
                s.index = pd.to_datetime(s.index)
                out[t] = s.astype(float)
    return out


def _fetch_live(tickers: list[str], start: str) -> tuple[dict[str, pd.Series], dict[str, bool]]:
    """PX_LAST histories, keyed by the plain ticker. Generic futures come back
    roll-adjusted when Bloomberg accepts the R: syntax, unadjusted otherwise."""
    fut = [t for t in tickers if is_generic_future(t)]
    plain = [t for t in tickers if t not in fut]
    got = _bdh(plain, start) if plain else {}
    adjusted: dict[str, bool] = {}
    if fut:
        adj = _bdh([adjusted_ticker(t) for t in fut], start)
        missing = []
        for t in fut:
            s = adj.get(adjusted_ticker(t))
            if s is not None:
                got[t], adjusted[t] = s, True
            else:
                missing.append(t)
        if missing:
            raw = _bdh(missing, start)
            for t in missing:
                if t in raw:
                    got[t], adjusted[t] = raw[t], False
    return got, adjusted


# ---------------------------------------------------------------------------
# Universe data (disk cache, incremental)
# ---------------------------------------------------------------------------

def _universe_tickers() -> list[str]:
    out: list[str] = []
    for m in mu.UNIVERSE:
        for _, t in parse_expression(m.expr):
            if t not in out:
                out.append(t)
    return out + [mu.CTA_INDEX]


_STATIC_FIELDS = ["FUT_VAL_PT", "CRNCY", "VOLUME_AVG_20D", "OPEN_INT", "PX_LAST"]


def _fetch_static(tickers: list[str]) -> dict[str, dict]:
    """Contract value per point, currency, 20d volume, open interest (unadjusted price)."""
    import bbg
    ref = bbg.bdp(tickers, _STATIC_FIELDS)
    ccys = sorted({str(v.get("CRNCY")).upper() for v in ref.values()
                   if v.get("CRNCY") and str(v.get("CRNCY")).upper() != "USD"})
    fx = bbg.bdp([f"{c}USD Curncy" for c in ccys], ["PX_LAST"]) if ccys else {}
    out = {}
    for t in tickers:
        v = ref.get(t, {})
        ccy = str(v.get("CRNCY") or "USD").upper()
        rate = 1.0 if ccy == "USD" else (fx.get(f"{ccy}USD Curncy", {}).get("PX_LAST"))
        out[t] = {"val_pt": _num(v.get("FUT_VAL_PT")), "ccy": ccy, "fx_usd": _num(rate),
                  "adv": _num(v.get("VOLUME_AVG_20D")), "oi": _num(v.get("OPEN_INT")),
                  "px": _num(v.get("PX_LAST"))}
    return out


def _num(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _merge(old: pd.Series, new: pd.Series, ratio_adjusted: bool) -> pd.Series:
    """Append a fresh fetch to the cached history. A roll since the last fetch
    rescales a ratio-adjusted history, so bring the cache onto the new basis."""
    overlap = old.index.intersection(new.index)
    if ratio_adjusted and len(overlap):
        k = float(np.median(new.loc[overlap] / old.loc[overlap]))
        if math.isfinite(k) and abs(k - 1) > 1e-9:
            old = old * k
    return new.combine_first(old)


_uni_lock = threading.Lock()
_uni_mem: dict[str, Any] = {}


def _cache_file():
    return state_path("momentum/universe.pkl")


def load_universe(refresh: bool = False) -> dict:
    """{'prices': {ticker: Series}, 'adjusted': {...}, 'static': {...},
    'data_source', 'note'}. Live data are cached on disk and topped up."""
    if settings.data_source != "bloomberg":
        return _simulated_universe()
    with _uni_lock:
        hit = _uni_mem.get("live")
        if hit and not refresh and time.monotonic() - hit[0] < _CACHE_TTL_S:
            return hit[1]
        try:
            data = _refresh_live_universe()
        except Exception as e:  # Bloomberg down / refused: say so, don't pretend
            logger.exception("Momentum universe fetch failed; using simulation")
            data = _simulated_universe()
            data["note"] = f"Bloomberg fetch failed ({type(e).__name__}: {e}); showing simulated data"
        _uni_mem["live"] = (time.monotonic(), data)
        return data


def _refresh_live_universe() -> dict:
    path = _cache_file()
    cache: dict = {}
    if path.exists():
        try:
            cache = pd.read_pickle(path)
        except Exception:
            logger.warning("Momentum cache unreadable, refetching from scratch")
    prices: dict[str, pd.Series] = dict(cache.get("prices", {}))
    adjusted: dict[str, bool] = dict(cache.get("adjusted", {}))
    tickers = _universe_tickers()

    have = [t for t in tickers if t in prices]
    new_t = [t for t in tickers if t not in prices]
    if new_t:
        got, adj = _fetch_live(new_t, UNIVERSE_START)
        prices.update(got)
        adjusted.update(adj)
    if have:
        # a dead ticker must not drag every top-up back to its last print
        last = max(min(prices[t].index[-1] for t in have), pd.Timestamp.today() - pd.Timedelta(days=30))
        since = (last - pd.Timedelta(days=10)).strftime("%Y-%m-%d")
        got, adj = _fetch_live(have, since)
        for t, s in got.items():
            prices[t] = _merge(prices[t], s, adjusted.get(t, False) and adj.get(t, False))
            adjusted[t] = adj.get(t, adjusted.get(t, False))
    if not prices:
        raise RuntimeError("Bloomberg returned no data for the momentum universe")

    today = pd.Timestamp.today().strftime("%Y-%m-%d")
    static = cache.get("static", {})
    if cache.get("static_date") != today:
        try:
            static = _fetch_static([m.expr for m in mu.UNIVERSE if m.cta])
        except Exception:
            logger.exception("Momentum static fields fetch failed; keeping cached values")
    pd.to_pickle({"prices": prices, "adjusted": adjusted, "static": static,
                  "static_date": today if static else None}, path)
    missing = [t for t in tickers if t not in prices]
    note = f"No Bloomberg data for {len(missing)} ticker(s): {', '.join(missing)}" if missing else None
    return {"prices": prices, "adjusted": adjusted, "static": static,
            "data_source": "bloomberg", "note": note}


_sim_universe: dict | None = None


def _simulated_universe() -> dict:
    global _sim_universe
    today = pd.Timestamp.today().normalize()
    if _sim_universe is None or _sim_universe["_day"] != today:
        dates = pd.bdate_range(SIM_ORIGIN, today)
        prices = {t: _simulate_ticker(t, dates).loc[UNIVERSE_START:]
                  for t in _universe_tickers() if t != mu.CTA_INDEX}
        static = {m.expr: {"val_pt": 1000.0, "ccy": "USD", "fx_usd": 1.0, "adv": 150_000.0,
                           "oi": 1_000_000.0, "px": 100.0} for m in mu.UNIVERSE if m.cta}
        _sim_universe = {"_day": today, "prices": prices, "adjusted": {}, "static": static,
                         "data_source": "simulation", "note": None}
    return {k: v for k, v in _sim_universe.items() if k != "_day"}


def build_expression(expr: str, prices: dict[str, pd.Series], scale: float = 1.0) -> pd.Series:
    terms = parse_expression(expr)
    legs = [prices[t] for _, t in terms]
    if len(legs) == 1:
        s = terms[0][0] * legs[0]
    else:
        df = pd.concat(legs, axis=1).ffill(limit=3).dropna()
        s = sum(w * df.iloc[:, i] for i, (w, _) in enumerate(terms))
    return (scale * s).rename(expr)


# ---------------------------------------------------------------------------
# Model portfolio and calibration
# ---------------------------------------------------------------------------

@dataclass
class Model:
    response: str
    weights: np.ndarray        # speed weights, sum 1
    leverage: float            # B: full-position $ vol per market = AUM · B · w_i
    calibration: dict | None


def _unit_returns(sigs: dict[str, Signals], resp: str) -> pd.DataFrame:
    """Daily return of each single-speed model portfolio, unit leverage."""
    rw = mu.risk_weights()
    idx = sorted(set().union(*(sig.y.index for sig in sigs.values())))
    idx = pd.DatetimeIndex(idx)
    tot = np.zeros((len(idx), len(SPEEDS)))
    for mid, sig in sigs.items():
        phi = response(sig.y.values, resp)
        contrib = np.zeros_like(phi)
        contrib[1:] = phi[:-1] * (sig.n.values[1:, None] / math.sqrt(252)) * rw[mid]
        tot[idx.get_indexer(sig.y.index)] += contrib
    return pd.DataFrame(tot, index=idx, columns=SPEED_NAMES)


def _weekly(daily: pd.DataFrame | pd.Series):
    return daily.resample("W-FRI").sum()


def _index_weekly(index_px: pd.Series) -> pd.Series:
    return index_px.resample("W-FRI").last().pct_change().dropna()


def _fit(A: np.ndarray, b: np.ndarray) -> tuple[np.ndarray, float]:
    Ac, bc = A - A.mean(0), b - b.mean()
    beta, _ = nnls(Ac, bc)
    sst = float(bc @ bc)
    r2 = 1 - float(((bc - Ac @ beta) ** 2).sum()) / sst if sst > 0 else 0.0
    return beta, r2


def _r2(A: np.ndarray, b: np.ndarray, beta: np.ndarray) -> float:
    Ac, bc = A - A.mean(0), b - b.mean()
    sst = float(bc @ bc)
    return 1 - float(((bc - Ac @ beta) ** 2).sum()) / sst if sst > 0 else 0.0


def calibrate(sigs: dict[str, Signals], index_px: pd.Series | None) -> Model:
    """Speed weights, response and leverage that best replicate the CTA index."""
    unit = {r: _unit_returns(sigs, r) for r in RESPONSES}
    default_w = np.full(len(SPEEDS), 1 / len(SPEEDS))
    port = unit[DEFAULT_RESPONSE] @ default_w
    vol = float(port.iloc[-CALIB_WEEKS * 5:].std() * math.sqrt(252))
    default = Model(DEFAULT_RESPONSE, default_w, DEFAULT_TARGET_VOL / vol if vol > 0 else 1.0, None)
    if index_px is None or len(index_px.dropna()) < 60:
        return default

    idx = _index_weekly(index_px)
    fits = []
    for r in RESPONSES:
        wk = _weekly(unit[r]).reindex(idx.index).dropna()
        b = idx.reindex(wk.index)
        if len(wk) < 80:
            continue
        A, bv = wk.values[-CALIB_WEEKS:], b.values[-CALIB_WEEKS:]
        beta, r2 = _fit(A, bv)
        # out of sample: fit on the year before the last, score the last 52 weeks
        r2_oos = None
        if len(wk) >= CALIB_WEEKS + 52:
            beta_is, _ = _fit(wk.values[-CALIB_WEEKS - 52:-52], b.values[-CALIB_WEEKS - 52:-52])
            r2_oos = _r2(wk.values[-52:], b.values[-52:], beta_is)
        fits.append({"response": r, "beta": beta, "r2": r2, "r2_oos": r2_oos, "A": A, "b": bv,
                     "weekly": wk})
    if not fits:
        return default
    best = max(fits, key=lambda f: f["r2"])
    B = float(best["beta"].sum())
    if B <= 0 or best["r2"] < 0.05:
        default.calibration = {"ok": False, "reason": f"best R² {best['r2']:.2f} too low",
                               "tested": [{"response": f["response"], "r2": f["r2"]} for f in fits]}
        return default
    fitted = best["A"] @ best["beta"]
    resid = best["b"] - best["b"].mean() - (fitted - fitted.mean())
    calib = {
        "ok": True, "index": mu.CTA_INDEX, "weeks": len(best["b"]),
        "r2": best["r2"], "r2_oos": best["r2_oos"],
        "corr": float(np.corrcoef(fitted, best["b"])[0, 1]),
        "tracking_error": float(resid.std() * math.sqrt(52)),
        "index_vol": float(best["b"].std() * math.sqrt(52)),
        "tested": [{"response": f["response"], "r2": f["r2"], "r2_oos": f["r2_oos"]} for f in fits],
    }
    return Model(best["response"], best["beta"] / B, B, calib)


def _sim_index(sigs: dict[str, Signals]) -> pd.Series:
    """Simulated CTA index: a known blend of the speeds plus noise, so the
    calibration has something to recover."""
    true_w = np.array([0.1, 0.3, 0.35, 0.25])
    port = (_unit_returns(sigs, "tanh") @ true_w) * 0.6
    rng = np.random.default_rng(_seed(mu.CTA_INDEX))
    noisy = port + rng.normal(0, 0.003, len(port))
    return 100 * (1 + noisy).cumprod()


# ---------------------------------------------------------------------------
# Payload helpers
# ---------------------------------------------------------------------------

def _safe(val: Any) -> float | None:
    if val is None:
        return None
    try:
        f = float(val)
    except (TypeError, ValueError):
        return None
    return None if (math.isnan(f) or math.isinf(f)) else f


def _to_list(s: pd.Series) -> list[float | None]:
    return [_safe(v) for v in s]


def _chg(sig: Signals, unit: str, days: int = 5) -> float | None:
    """Change over `days`: % for prices, bp for yields (stored in %) and spreads."""
    p = sig.price
    if len(p) <= days:
        return None
    if unit == "price":
        return _safe(100 * (p.iloc[-1] / p.iloc[-1 - days] - 1))
    d = p.iloc[-1] - p.iloc[-1 - days]
    return _safe(d * 100 if unit == "pct" else d)


def _infer_kind(expr: str, series: pd.Series) -> str:
    terms = parse_expression(expr)
    if len(terms) > 1 or any(_looks_like_yield(t) for _, t in terms) or (series <= 0).any():
        return "level"
    return "price"


def _infer_unit(expr: str, kind: str) -> str:
    """price | pct (yields and yield spreads, quoted in %) | level (anything else)."""
    if kind == "price":
        return "price"
    return "pct" if all(_looks_like_yield(t) for _, t in parse_expression(expr)) else "level"


def _full_risk(model: Model, aum_bn: float, w_i: float) -> float:
    """Dollar annual vol of a full position in a market with risk weight w_i."""
    return aum_bn * 1e9 * model.leverage * w_i


def _sizing(sig: Signals, st: _State, s: float, full_risk: float, static: dict | None,
            unit: str) -> dict:
    sigma_ann = st.sigma * math.sqrt(252)
    out: dict[str, Any] = {"risk_usd": s * full_risk, "full_risk_usd": full_risk,
                           "notional_usd": None, "dv01_usd": None, "contracts": None,
                           "contract_usd": None, "adv": None, "oi": None}
    if sig.kind == "price":
        out["notional_usd"] = s * full_risk / sigma_ann
        if static and static.get("val_pt") and static.get("px") and static.get("fx_usd"):
            cv = static["px"] * static["val_pt"] * static["fx_usd"]
            out["contract_usd"] = cv
            out["contracts"] = out["notional_usd"] / cv
            out["adv"], out["oi"] = static.get("adv"), static.get("oi")
    else:
        bp = sigma_ann * (100 if unit == "pct" else 1)   # annual vol in bp
        out["dv01_usd"] = s * full_risk / bp if bp > 0 else None
    return out


# ---------------------------------------------------------------------------
# Model state shared by the monitor and the single-series view
# ---------------------------------------------------------------------------

_model_lock = threading.Lock()
_model_mem: dict[str, Any] = {}


def _universe_model(refresh: bool = False) -> dict:
    """Signals for every universe row plus the calibrated model."""
    uni = load_universe(refresh)
    key = id(uni["prices"])
    with _model_lock:
        hit = _model_mem.get("m")
        if hit and hit["key"] == key and not refresh:
            return hit
        sigs: dict[str, Signals] = {}
        errors: dict[str, str] = {}
        for m in mu.UNIVERSE:
            try:
                s = build_expression(m.expr, uni["prices"], m.scale)
                if len(s) < WARMUP + 60:
                    raise ValueError("not enough history")
                sigs[m.id] = compute_signals(s, m.kind)
            except KeyError:
                errors[m.id] = "no data"
            except ValueError as e:
                errors[m.id] = str(e)
        cta = {k: v for k, v in sigs.items() if mu.BY_ID[k].cta}
        if uni["data_source"] == "simulation":
            index_px = _sim_index(cta)
        else:
            index_px = uni["prices"].get(mu.CTA_INDEX)
        model = calibrate(cta, index_px)
        hit = {"key": key, "uni": uni, "sigs": sigs, "errors": errors, "model": model,
               "index_px": index_px}
        _model_mem["m"] = hit
        return hit


def _pnl(state: dict) -> dict:
    model: Model = state["model"]
    cta = {k: v for k, v in state["sigs"].items() if mu.BY_ID[k].cta}
    port = (_unit_returns(cta, model.response) @ model.weights) * model.leverage
    wk = _weekly(port).iloc[-260:]
    out = {"dates": [d.strftime("%Y-%m-%d") for d in wk.index]}
    cum = (1 + wk).cumprod()
    out["model"] = _to_list(100 * (cum - 1))
    out["drawdown"] = _to_list(100 * (cum / cum.cummax() - 1))
    idx = state["index_px"]
    if idx is not None:
        iw = _index_weekly(idx).reindex(wk.index).fillna(0.0)
        out["index"] = _to_list(100 * ((1 + iw).cumprod() - 1))
    else:
        out["index"] = None
    out["model_1m"] = _safe(100 * ((1 + wk.iloc[-4:]).prod() - 1))
    out["model_3m"] = _safe(100 * ((1 + wk.iloc[-13:]).prod() - 1))
    return out


# ---------------------------------------------------------------------------
# Public: monitor
# ---------------------------------------------------------------------------

def _row(m: mu.Market, sig: Signals, model: Model, aum_bn: float, static: dict) -> dict:
    w, resp = model.weights, model.response
    st = _State.last(sig)
    pos = composite(sig.y, w, resp)
    y_now = sig.y.iloc[-1].to_numpy()
    er = efficiency_ratio(sig.price)
    label, direction, stretched = classify(y_now, er)
    trig = _flip_composite(st, w, resp)
    s_now = float(pos.iloc[-1])
    flat = composite(_project(st, [st.p] * 5), w, resp) - s_now
    row: dict[str, Any] = {
        "id": m.id, "label": m.label, "group": m.group, "ticker": m.expr, "kind": m.kind,
        "unit": m.unit, "cta": m.cta, "sector": m.sector,
        "last": _safe(sig.price.iloc[-1]), "chg_1w": _chg(sig, m.unit),
        "regime": label, "direction": direction, "stretched": stretched, "er": _safe(er),
        "signals": {nm: _safe(v) for nm, v in zip(SPEED_NAMES, y_now)},
        "position": 100 * s_now,
        "position_chg_1w": _safe(100 * (s_now - pos.iloc[-6])) if len(pos) > 6 else None,
        "flip_price": _safe(st.move(trig)) if trig is not None else None,
        "flip_sigma": trig,
        "flow_flat_1w": 100 * flat,
        "spark": _to_list(100 * pos.iloc[-130::5]),
        "risk_usd": None, "notional_usd": None, "contracts": None,
        "flow_flat_1w_usd": None, "flow_flat_1w_contracts": None, "flow_adv_pct": None,
    }
    if m.cta:
        full = _full_risk(model, aum_bn, mu.risk_weights()[m.id])
        size = _sizing(sig, st, s_now, full, static.get(m.expr), m.unit)
        flow = _sizing(sig, st, flat, full, static.get(m.expr), m.unit)
        row.update(risk_usd=size["risk_usd"], notional_usd=size["notional_usd"],
                   contracts=size["contracts"], flow_flat_1w_usd=flow["notional_usd"],
                   flow_flat_1w_contracts=flow["contracts"])
        if flow["contracts"] is not None and size["adv"]:
            row["flow_adv_pct"] = 100 * abs(flow["contracts"]) / size["adv"]
    return row


def _sector_flows(state: dict, aum_bn: float) -> list[dict]:
    """Aggregate CTA risk and 1w flows per sector under uniform moves."""
    model: Model = state["model"]
    rw = mu.risk_weights()
    out = []
    for sector in mu.SECTOR_RISK:
        mids = [mid for mid, sig in state["sigs"].items() if mu.BY_ID[mid].sector == sector]
        if not mids:
            continue
        agg = {"sector": sector, "markets": len(mids), "net_risk_usd": 0.0, "gross_risk_usd": 0.0,
               "net_notional_usd": 0.0, "position": 0.0,
               "flows_1w": {f"{k:+g}": 0.0 for k in SHOCKS}}
        wsum = sum(rw[mid] for mid in mids)
        for mid in mids:
            sig, m = state["sigs"][mid], mu.BY_ID[mid]
            st = _State.last(sig)
            s0 = composite(_project(st, []), model.weights, model.response)
            full = _full_risk(model, aum_bn, rw[mid])
            agg["net_risk_usd"] += s0 * full
            agg["gross_risk_usd"] += abs(s0) * full
            agg["net_notional_usd"] += _sizing(sig, st, s0, full, None, m.unit)["notional_usd"] or 0.0
            agg["position"] += 100 * s0 * rw[mid] / wsum
            for k in SHOCKS:
                s1 = composite(_project(st, _scenario_paths(st, 5, k)), model.weights, model.response)
                agg["flows_1w"][f"{k:+g}"] += _sizing(sig, st, s1 - s0, full, None, m.unit)["notional_usd"] or 0.0
        out.append(agg)
    return out


_mon_lock = threading.Lock()
_mon_mem: dict[tuple, tuple[int, dict]] = {}


def get_monitor(aum_bn: float = DEFAULT_AUM_BN, refresh: bool = False) -> dict:
    state = _universe_model(refresh)
    key = (round(aum_bn, 3),)
    with _mon_lock:
        hit = _mon_mem.get(key)
        if hit and hit[0] == state["key"] and not refresh:
            return hit[1]
    model: Model = state["model"]
    uni = state["uni"]
    rows = [_row(m, state["sigs"][m.id], model, aum_bn, uni["static"])
            for m in mu.UNIVERSE if m.id in state["sigs"]]
    as_of = max(sig.price.index[-1] for sig in state["sigs"].values())
    out = {
        "as_of": as_of.strftime("%Y-%m-%d"),
        "data_source": uni["data_source"],
        "note": uni.get("note"),
        "roll_adjusted": {m.id: uni["adjusted"].get(m.expr) for m in mu.UNIVERSE
                          if m.cta and uni["data_source"] == "bloomberg"},
        "groups": mu.GROUPS,
        "speeds": SPEED_NAMES,
        "model": {"response": model.response,
                  "speed_weights": {nm: float(v) for nm, v in zip(SPEED_NAMES, model.weights)},
                  "leverage": model.leverage, "aum_bn": aum_bn,
                  "calibrated": bool(model.calibration and model.calibration.get("ok"))},
        "calibration": model.calibration,
        "rows": rows,
        "missing": [{"id": k, "label": mu.BY_ID[k].label, "reason": v} for k, v in state["errors"].items()],
        "sectors": _sector_flows(state, aum_bn),
        "pnl": _pnl(state),
    }
    with _mon_lock:
        _mon_mem[key] = (state["key"], out)
    return out


def warm_cache() -> None:
    get_monitor()


# ---------------------------------------------------------------------------
# Public: single series (any ticker expression)
# ---------------------------------------------------------------------------

_series_lock = threading.Lock()
_series_mem: dict[tuple, tuple[float, pd.Series, str, bool | None]] = {}


class SeriesNotFound(LookupError):
    pass


def _series_for(expr: str, start: str, refresh: bool) -> tuple[pd.Series, str, bool | None]:
    """(series, data_source, roll_adjusted) for a user expression."""
    terms = parse_expression(expr)
    tickers = [t for _, t in terms]
    if settings.data_source != "bloomberg":
        dates = pd.bdate_range(SIM_ORIGIN, pd.Timestamp.today().normalize())
        prices = {t: _simulate_ticker(t, dates).loc[min(start, UNIVERSE_START):] for t in tickers}
        return build_expression(expr, prices), "simulation", None

    uni = load_universe(refresh) if all(t in _universe_tickers() for t in tickers) else None
    if uni and uni["data_source"] == "bloomberg" and start >= UNIVERSE_START \
            and all(t in uni["prices"] for t in tickers):
        s = build_expression(expr, uni["prices"])
        adj = [uni["adjusted"].get(t) for t in tickers if is_generic_future(t)]
        return s, "bloomberg", (all(adj) if adj else None)

    key = (expr, start)
    with _series_lock:
        hit = _series_mem.get(key)
        if hit and not refresh and time.monotonic() - hit[0] < _CACHE_TTL_S:
            return hit[1], hit[2], hit[3]
        prices, adjusted = _fetch_live(tickers, start)
        missing = [t for t in tickers if t not in prices]
        if missing:
            raise SeriesNotFound(f"No Bloomberg data for {', '.join(missing)} (check the ticker "
                                 "and yellow key, e.g. 'TY1 Comdty', 'USGG10YR Index')")
        s = build_expression(expr, prices)
        adj = [adjusted.get(t) for t in tickers if is_generic_future(t)]
        roll = all(adj) if adj else None
        _series_mem[key] = (time.monotonic(), s, "bloomberg", roll)
        return s, "bloomberg", roll


def compute_cta_signals(ticker: str, start: str = "2015-01-01", kind: str = "auto",
                        aum_bn: float = DEFAULT_AUM_BN, pctile_years: int = 0,
                        refresh: bool = False) -> dict:
    """Trend signals, regime, triggers, scenarios and sizing for any expression."""
    expr = ticker.strip()
    series, source, roll = _series_for(expr, start, refresh)
    if kind == "auto":
        kind = _infer_kind(expr, series)
    unit = _infer_unit(expr, kind)
    if len(series.dropna()) < WARMUP + 60:
        raise ValueError(f"Not enough history: need {WARMUP + 60} days from {start}, "
                         f"got {len(series.dropna())}")
    # signals run on everything fetched (a universe series may start before
    # `start`); the charts start at `start`, after the EMA warm-up
    sig = compute_signals(series, kind)

    state = _universe_model(False)
    model: Model = state["model"]
    w, resp = model.weights, model.response
    pos = composite(sig.y, w, resp)
    st = _State.last(sig)
    y_now = sig.y.iloc[-1].to_numpy()
    er = efficiency_ratio(sig.price)
    label, direction, stretched = classify(y_now, er)

    # Charts skip the EMA warm-up and plot every 5th day (always the last)
    first = max(pd.Timestamp(start), sig.price.index[WARMUP])
    y_out, pos_out, px_out = sig.y.loc[first:], pos.loc[first:], sig.price.loc[first:]
    keep = sorted(set(range(0, len(px_out), 5)) | {len(px_out) - 1})

    hist = pos_out
    if pctile_years > 0:
        hist = hist[hist.index >= hist.index[-1] - pd.DateOffset(years=pctile_years)]
    s_now = float(pos.iloc[-1])
    pctile = float((hist < s_now).mean() * 100 + (hist == s_now).mean() * 50)

    # Sizing: universe futures use their own risk weight; other futures and
    # yields a typical market's; cash indices, spot and other levels none.
    member = mu.BY_EXPR.get(expr)
    tickers = [t for _, t in parse_expression(expr)]
    basis, w_i = None, None
    if member and member.cta:
        basis, w_i = "universe", mu.risk_weights()[member.id]
    elif (kind == "price" and len(tickers) == 1 and is_generic_future(tickers[0])) or unit == "pct":
        basis, w_i = "typical", float(np.median(list(mu.risk_weights().values())))
    sizing = None
    scen = scenarios(st, w, resp)
    if basis:
        full = _full_risk(model, aum_bn, w_i)
        static = state["uni"]["static"].get(expr) if member else None
        sizing = {"basis": basis, **_sizing(sig, st, s_now, full, static, unit)}
        for sc in scen:
            fl = _sizing(sig, st, sc["delta"] / 100, full, static, unit)
            sc["delta_usd"] = fl["notional_usd"] if kind == "price" else fl["dv01_usd"]
            sc["delta_contracts"] = fl["contracts"]

    return {
        "ticker": expr,
        "label": member.label if member else expr,
        "kind": kind, "unit": unit,
        "data_source": source, "roll_adjusted": roll,
        "model": {"response": resp, "speed_weights": {nm: float(v) for nm, v in zip(SPEED_NAMES, w)},
                  "calibrated": bool(model.calibration and model.calibration.get("ok")),
                  "aum_bn": aum_bn},
        "speeds": SPEED_NAMES,
        "dates": [px_out.index[i].strftime("%Y-%m-%d") for i in keep],
        "series": _to_list(px_out.iloc[keep]),
        "position": _to_list(100 * pos_out.iloc[keep]),
        "signals": {nm: _to_list(y_out[nm].iloc[keep]) for nm in SPEED_NAMES},
        "current": {
            "date": sig.price.index[-1].strftime("%Y-%m-%d"),
            "series_value": _safe(sig.price.iloc[-1]),
            "chg_1w": _chg(sig, unit),
            "regime": label, "direction": direction, "stretched": stretched,
            "er": _safe(er),
            # annual vol in display units: % for prices, bp for yields
            "vol_ann": _safe(st.sigma * math.sqrt(252) * (1 if unit == "level" else 100)),
            "position": 100 * s_now,
            "position_1w_ago": _safe(100 * pos.iloc[-6]) if len(pos) > 6 else None,
            "position_pctile": pctile,
            "signals": {nm: _safe(v) for nm, v in zip(SPEED_NAMES, y_now)},
            "responses": {nm: _safe(v) for nm, v in zip(SPEED_NAMES, response(y_now, resp))},
        },
        "triggers": triggers(st, w, resp),
        "scenarios": scen,
        "sizing": sizing,
    }
