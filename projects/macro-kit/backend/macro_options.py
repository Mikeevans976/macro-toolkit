"""
macro_options.py — live Euribor option data for the Macro Options Monitor.

The page's maths (Breeden–Litzenberger densities, the ECB-outcome mixture fit, the
open-interest views) runs in the browser. This module supplies the market it runs on:

  snapshot       the 12 live quarterly ER futures and, for every option expiry on them
                 (standard + serials): cleaned OTM premia, a smile fitted in normal-vol space
                 and call prices on a fine strike grid; plus DFR, €STR, the ECB calendar and
                 the €STR-OIS-implied meeting path.
  open interest  daily per-strike call / put open interest for one option expiry.

Without Bloomberg (`settings.data_source != "bloomberg"`, or the Terminal down) every payload
says `data_source: "simulation"` and the page falls back to its in-browser simulation.

Bloomberg conventions (checked on the Terminal 2026-10-18)
  futures   ER{month code}{year digit} Comdty (ERZ6); expired contracts keep their ticker
  options   "ER{code}{digit}{C|P} {strike} Comdty" (ERX6C 97.125); expired options still price
  chain     bds(<future>, OPT_CHAIN) lists the live standard and serial options on a future
  serials   the two months before each front quarterly, on the next quarterly future. They
            expire on the Friday before the third Wednesday; standard options on the Monday
            (the futures' last trading day)
  strikes   every 6.25 bp near the money, 12.5–50 bp in the wings
  rates     DFR EUORDEPO Index, €STR ESTRON Index (ECBDFR Index is invalid), €STR OIS
            EESWE{A..K,1,1C,1F,2,2F,3} Curncy (1m–3y)
  history   bdh PX_SETTLE / OPEN_INT; OPEN_INT is published a day late, IVOL_MID has no history

Snapshots: a past date uses that day's settlement prices (Bloomberg has no intraday history
here); today uses live mids where the quote is two-sided, else the last settlement re-struck
at the live futures price in normal-vol space.
"""
from __future__ import annotations

import json
import logging
import math
import re
import threading
import time
import warnings
from datetime import date, datetime, timedelta
from typing import Any, Optional
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
from scipy.interpolate import UnivariateSpline
from scipy.optimize import least_squares
from scipy.stats import norm

from runtime_paths import state_path
from settings import settings

logger = logging.getLogger(__name__)

MONTH_CODES = "FGHJKMNQUVXZ"
N_QUARTERLIES = 12
TICK = 0.0025              # ICE Euribor option tick, price points
GRID_H = 0.0125            # call grid spacing; every strike width on the page is a multiple
MAX_STRIKE_DIST = 2.5      # strikes further than this from the futures price are not requested
LISTED_STRIKE = 0.0625     # finest listed strike interval (used to build expired-option tickers)
EXPIRY_HOUR = 10           # options cease trading 10:00 London on their last trading day
SETTLE_TIME = (16, 15)     # ICE STIR daily settlement, London
SESSION = (1, 21)          # ICE Euribor futures & options trading hours, London
LONDON = ZoneInfo("Europe/London")

DFR_TICKER = "EUORDEPO Index"
ESTR_TICKER = "ESTRON Index"
OIS_TICKERS: dict[str, float] = {
    **{f"EESWE{c} Curncy": (i + 1) / 12 for i, c in enumerate("ABCDEFGHIJK")},
    "EESWE1 Curncy": 1.0, "EESWE1C Curncy": 1.25, "EESWE1F Curncy": 1.5,
    "EESWE2 Curncy": 2.0, "EESWE2F Curncy": 2.5, "EESWE3 Curncy": 3.0,
}

_LIVE_TTL_S = 5 * 60
_CHAIN_RE = re.compile(r"^(ER[FGHJKMNQUVXZ]\d)([CP])\s+([\d.]+)\s+Comdty$")


# ---------------------------------------------------------------------------
# Tickers and calendar
# ---------------------------------------------------------------------------

def _root(y: int, m: int) -> str:
    return f"ER{MONTH_CODES[m - 1]}{y % 10}"


def _fut_ticker(y: int, m: int) -> str:
    return f"{_root(y, m)} Comdty"


def _opt_ticker(root: str, cp: str, strike: float) -> str:
    return f"{root}{cp} {strike:g} Comdty"


def parse_option_ticker(ticker: str) -> Optional[tuple[str, str, float]]:
    """("ERX6", "C", 97.125) from "ERX6C    97.125 Comdty"; None for anything else."""
    m = _CHAIN_RE.match(ticker.strip())
    return (m.group(1), m.group(2), float(m.group(3))) if m else None


def _third_wednesday(y: int, m: int) -> date:
    first = date(y, m, 1)
    return first + timedelta(days=(2 - first.weekday()) % 7 + 14)


def _rule_expiry(y: int, m: int, standard: bool) -> date:
    """Expiry by rule (no holidays): standard → Monday, serial → Friday before the third Wednesday.
    Only a fallback: Bloomberg's OPT_EXPIRE_DT / LAST_TRADEABLE_DT win when available."""
    return _third_wednesday(y, m) - timedelta(days=2 if standard else 5)


def _next_quarter(y: int, m: int) -> tuple[int, int]:
    m += 3
    return (y + 1, m - 12) if m > 12 else (y, m)


def london_now() -> datetime:
    return datetime.now(LONDON).replace(tzinfo=None)


def _last_session_close(now: datetime) -> datetime:
    """`now` while the market is open, else the close of the last weekday session."""
    d = now
    if d.weekday() < 5 and SESSION[0] <= d.hour + d.minute / 60 < SESSION[1]:
        return d.replace(second=0, microsecond=0)
    if d.weekday() < 5 and d.hour >= SESSION[1]:
        return d.replace(hour=SESSION[1], minute=0, second=0, microsecond=0)
    d = d - timedelta(days=1)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d.replace(hour=SESSION[1], minute=0, second=0, microsecond=0)


def _years(a: datetime, b: datetime) -> float:
    return max((b - a).total_seconds() / (365 * 86400), 1 / (365 * 24))


# ECB decisions: the calendar Swaps RV keeps (checked against Bloomberg through 2027), and
# beyond it the Thursday nearest the same day-of-month as in the last confirmed year.
def ecb_meetings(through_year: int) -> list[dict]:
    from swaps_rv import _POLICY_MEETINGS
    confirmed = [date.fromisoformat(d) for d in _POLICY_MEETINGS["EUR"][1]]
    last_year = max(d.year for d in confirmed)
    out = [(d, False) for d in confirmed]
    for y in range(last_year + 1, through_year + 1):
        for ref in (d for d in confirmed if d.year == last_year):
            r = date(y, ref.month, ref.day)
            shift = ((3 - r.weekday() + 10) % 7) - 3            # nearest Thursday, −3 … +3 days
            out.append((r + timedelta(days=shift), True))
    rows = []
    for d, est in sorted(out):
        decision = datetime(d.year, d.month, d.day, 13, 15)     # 14:15 CET
        effective = datetime.combine(d + timedelta(days=6), datetime.min.time())   # next MRO Wednesday
        rows.append({"decision": decision, "effective": effective, "estimated": est})
    return rows


# ---------------------------------------------------------------------------
# Option maths (Bachelier, undiscounted: ICE Euribor options are premium-margined futures-style)
# ---------------------------------------------------------------------------

def bachelier_call(F: float, K, T: float, vol):
    K = np.asarray(K, dtype=float)
    vol = np.asarray(vol, dtype=float)
    w = np.maximum(vol * math.sqrt(T), 1e-12)
    d = (F - K) / w
    return (F - K) * norm.cdf(d) + w * norm.pdf(d)


def bachelier_price(F: float, K: float, T: float, vol: float, cp: str) -> float:
    """Scalar call / put premium (math, not numpy: it runs inside the implied-vol solve)."""
    w = max(vol * math.sqrt(T), 1e-12)
    d = (F - K) / w
    c = (F - K) * 0.5 * (1 + math.erf(d / math.sqrt(2))) + w * math.exp(-0.5 * d * d) / math.sqrt(2 * math.pi)
    return c if cp == "C" else c - (F - K)


def implied_normal_vol(price: float, F: float, K: float, T: float, cp: str) -> Optional[float]:
    """Normal vol (price units / yr) reproducing `price`; None when no vol can (below intrinsic)."""
    intrinsic = max(F - K, 0.0) if cp == "C" else max(K - F, 0.0)
    if not price > intrinsic + 1e-9:
        return None
    lo, hi = 1e-5, 10.0
    if bachelier_price(F, K, T, hi, cp) < price:
        return None
    for _ in range(80):
        mid = 0.5 * (lo + hi)
        if bachelier_price(F, K, T, mid, cp) > price:
            hi = mid
        else:
            lo = mid
    return 0.5 * (lo + hi)


def _vega(F: float, K: float, T: float, vol: float) -> float:
    d = (F - K) / max(vol * math.sqrt(T), 1e-12)
    return math.sqrt(T) * math.exp(-0.5 * d * d) / math.sqrt(2 * math.pi)


def _isotonic(y: np.ndarray) -> np.ndarray:
    """Least-squares non-decreasing fit (pool adjacent violators)."""
    vals: list[float] = []
    sizes: list[int] = []
    for v in y:
        vals.append(float(v))
        sizes.append(1)
        while len(vals) > 1 and vals[-2] > vals[-1]:
            n = sizes[-2] + sizes[-1]
            vals[-2] = (vals[-2] * sizes[-2] + vals[-1] * sizes[-1]) / n
            sizes[-2] = n
            vals.pop()
            sizes.pop()
    return np.repeat(vals, sizes)


def convex_calls(calls: np.ndarray, h: float) -> np.ndarray:
    """Nearest arbitrage-free call curve on an even grid: slopes non-decreasing and in [-1, 0]
    (so density ≥ 0 and CDF in [0, 1]), anchored at the last (deep OTM) price."""
    s = np.clip(_isotonic(np.diff(calls) / h), -1.0, 0.0)
    return np.concatenate([np.cumsum((-s * h)[::-1])[::-1], [0.0]]) + calls[-1]


def fit_chain(F: float, T: float, quotes: list[dict]) -> Optional[dict]:
    """Smile and fine call grid from one expiry's quotes [{strike, type, price, source}].

    Out-of-the-money quotes only (calls at or above F, puts below). Each becomes a normal
    implied vol; a smoothing spline through them, weighted by vega / half a tick (the price
    error of a settlement), gives vol at any strike. The calls it prices on the fine grid are
    then projected onto the nearest convex curve, so the page's density is never negative
    (checked on live chains 2026-10-18: the repair moves quoted prices by under ~2 ticks).
    Quotes of a single tick are kept for the outcome fit but not the smile: a one-tick price
    only bounds the vol. Returns None with fewer than 3 usable quotes.
    """
    otm = sorted((q for q in quotes if (q["type"] == "C") == (q["strike"] >= F) and q["price"] >= TICK - 1e-9),
                 key=lambda q: q["strike"])
    for q in otm:
        q["iv"] = implied_normal_vol(q["price"], F, q["strike"], T, q["type"])
    fit = [q for q in otm if q["iv"] is not None and q["price"] >= 2 * TICK - 1e-9]
    if len(fit) < 3:
        return None
    K = np.array([q["strike"] for q in fit])
    iv = np.array([q["iv"] for q in fit])
    w = np.array([max(_vega(F, k, T, v), 1e-6) / (TICK / 2) for k, v in zip(K, iv)])
    w = np.minimum(w, np.median(w) * 10)                 # near-expiry ATM vega would dominate
    deg = 3 if len(fit) >= 5 else 1
    spline = UnivariateSpline(K, iv, w=w, k=deg, s=len(fit))
    slope = spline.derivative()
    a, b = float(K[0]), float(K[-1])
    sa, sb = float(slope(a)), float(slope(b))
    taper = max(0.25, float(np.mean(iv)) * math.sqrt(T))
    floor = max(0.1 * float(np.median(iv)), 0.002)

    def vol_at(k):
        # Beyond the quotes the smile keeps its edge slope, tapering off (tanh): flat vol there
        # would kink the smile at the last quote and put a spike of negative density on it
        k = np.asarray(k, dtype=float)
        v = spline(np.clip(k, a, b))
        v = v + np.where(k < a, sa * taper * np.tanh((k - a) / taper), 0.0)
        v = v + np.where(k > b, sb * taper * np.tanh((k - b) / taper), 0.0)
        return np.maximum(v, floor)

    atm = float(vol_at(F))
    half = min(max(0.5, 6.5 * atm * math.sqrt(T)), 8.0)
    lo = math.floor((F - half) / GRID_H) * GRID_H
    n = int(round(2 * half / GRID_H)) + 2
    grid = np.round(lo + GRID_H * np.arange(n + 1), 6)
    raw_calls = bachelier_call(F, grid, T, vol_at(grid))
    calls = convex_calls(raw_calls, GRID_H)

    ks = [q["strike"] for q in fit]
    model = np.array([bachelier_price(F, q["strike"], T, float(vol_at(q["strike"])), q["type"]) for q in fit])
    model = model + np.interp(ks, grid, calls - raw_calls)          # the repair, as put or call (parity)
    rmse = float(np.sqrt(np.mean(((model - np.array([q["price"] for q in fit])) / TICK) ** 2)))
    shift = float(np.abs(np.interp(ks, grid, calls - raw_calls)).max() / TICK)
    flags = []
    if shift > 1.0:
        flags.append(f"Quotes are not fully arbitrage-free: removing negative density moved a price by {shift:.1f} ticks.")
    if rmse > 1.0:
        flags.append(f"The smile misses the quotes by {rmse:.1f} ticks RMS.")
    return {
        "atm_vol": atm, "grid_lo": float(grid[0]), "grid_h": GRID_H,
        "calls": [round(float(c), 10) for c in calls],
        "quotes": [{"strike": q["strike"], "type": q["type"], "price": q["price"],
                    "iv": q["iv"], "source": q.get("source", "settle")} for q in otm],
        "n_fit": len(fit), "fit_rmse_ticks": rmse, "flags": flags,
    }


# ---------------------------------------------------------------------------
# €STR OIS → expected ECB path
# ---------------------------------------------------------------------------

def ois_meeting_path(as_of: datetime, estr: float, dfr: float, ois: dict[float, float],
                     meetings: list[dict], smooth: float = 0.1) -> list[dict]:
    """Expected DFR after each ECB meeting from €STR OIS par rates {tenor years: %}.

    €STR is piecewise flat, stepping on each meeting's effective date; the steps are the
    least-squares fit to the OIS quotes (daily-compounded ACT/360 overnight leg; one payment
    up to 1y, annual beyond) with a light penalty on consecutive changes. €STR − DFR is held at
    today's spread. Meetings after the longest OIS tenor are not identified and are left out.
    """
    if not ois:
        return []
    start = pd.Timestamp(as_of.date())
    tenors = sorted(ois)
    # Payment days (from start) of each swap: one at maturity up to 1y, else annual back from it
    schedules = []
    for T in tenors:
        end = start + pd.DateOffset(months=int(round(T * 12)))
        pays = [end]
        if T > 1.0 + 1e-9:
            while (p := pays[-1] - pd.DateOffset(years=1)) > start:
                pays.append(p)
        schedules.append(sorted((p - start).days for p in pays))
    days = schedules[-1][-1]
    ms = [m for m in meetings if m["decision"] > as_of and (m["effective"] - start.to_pydatetime()).days < days]
    if not ms:
        return []
    idx = np.zeros(days, dtype=int)                          # regime of each calendar day
    for k, m in enumerate(ms):
        idx[max(0, (m["effective"] - start.to_pydatetime()).days):] = k + 1

    def model(x: np.ndarray) -> np.ndarray:
        r = np.concatenate([[estr], x])[idx] / 100
        D = np.exp(-np.concatenate([[0.0], np.cumsum(np.log1p(r / 360))]))    # D at each day start
        out = []
        for pays in schedules:
            e = pays[-1]
            if len(pays) == 1:
                out.append((1 / D[e] - 1) * 360 / e * 100)
            else:
                annuity = sum((p - q) / 360 * D[p] for q, p in zip([0, *pays[:-1]], pays))
                out.append((1 - D[e]) / annuity * 100)
        return np.array(out)

    target = np.array([ois[T] for T in tenors])

    def resid(x):
        steps = np.diff(np.concatenate([[estr], x]))
        return np.concatenate([(model(x) - target) * 100, smooth * steps * 100])

    sol = least_squares(resid, np.full(len(ms), estr))
    spread = estr - dfr
    rows, prev = [], estr
    for m, x in zip(ms, sol.x):
        rows.append({**m, "rate": float(x - spread), "exp_bp": float((x - prev) * 100),
                     "cumulative_bp": float((x - estr) * 100)})
        prev = x
    return rows


# ---------------------------------------------------------------------------
# Bloomberg access and caches
# ---------------------------------------------------------------------------

def _blp():
    from bbg import blp
    return blp


_META_PATH = None
_meta: dict[str, dict] = {}
_meta_lock = threading.Lock()


def _meta_file():
    global _META_PATH
    if _META_PATH is None:
        _META_PATH = state_path("macro_options/meta.json")
        try:
            _meta.update(json.loads(_META_PATH.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            pass
    return _META_PATH


def _static(tickers: list[str], fields: list[str]) -> dict[str, dict]:
    """Static reference fields (expiry dates, underlyings), cached on disk: they never change."""
    path = _meta_file()
    with _meta_lock:
        need = [t for t in tickers if t not in _meta]
        if need:
            got = _blp().bdp(need, fields)
            for t in need:
                row = got.get(t, {})
                _meta[t] = {f: row[f] for f in fields if f in row} or {"_invalid": True}
            try:
                path.write_text(json.dumps(_meta, default=str), encoding="utf-8")
            except OSError:
                logger.warning("Could not write %s", path)
        return {t: _meta[t] for t in tickers}


_chain_cache: dict[str, tuple[date, list[str]]] = {}


def _live_chain(fut: str) -> list[str]:
    """Live option tickers on a future (refreshed daily); [] for an expired future."""
    hit = _chain_cache.get(fut)
    if hit and hit[0] == date.today():
        return hit[1]
    rows = _blp().bds(fut, "OPT_CHAIN")
    tickers = [r.get("Security Description", "") for r in rows]
    tickers = [" ".join(t.split()) for t in tickers if parse_option_ticker(t)]
    _chain_cache[fut] = (date.today(), tickers)
    return tickers


def _quarterlies(as_of: date) -> list[dict]:
    """The 12 quarterly contracts live at `as_of`: the first whose last trading day is after it, on."""
    y, m = as_of.year, math.ceil(as_of.month / 3) * 3
    cands = []
    for _ in range(N_QUARTERLIES + 2):
        cands.append((y, m))
        y, m = _next_quarter(y, m)
    meta = _static([_fut_ticker(*c) for c in cands], ["LAST_TRADEABLE_DT"])
    out = []
    for y, m in cands:
        row = meta[_fut_ticker(y, m)]
        ltd = row.get("LAST_TRADEABLE_DT")
        ltd = date.fromisoformat(str(ltd)[:10]) if ltd else _rule_expiry(y, m, True)
        if ltd > as_of:
            out.append({"year": y, "month": m, "id": _root(y, m), "ticker": _fut_ticker(y, m), "ltd": ltd})
    return out[:N_QUARTERLIES]


def _expiry_roots(c: dict) -> list[tuple[str, int, int, bool]]:
    """(root, year, month, standard) of the option months that can sit on a quarterly:
    its own month and the two serial months before it."""
    y, m = c["year"], c["month"]
    out = [(_root(y, m), y, m, True)]
    for back in (1, 2):
        yy, mm = (y, m - back) if m - back >= 1 else (y - 1, m - back + 12)
        out.append((_root(yy, mm), yy, mm, False))
    return out


def _strike_grid(F: float) -> list[float]:
    lo = math.floor((F - MAX_STRIKE_DIST) / LISTED_STRIKE) * LISTED_STRIKE
    n = int(round(2 * MAX_STRIKE_DIST / LISTED_STRIKE))
    return [round(lo + i * LISTED_STRIKE, 4) for i in range(n + 1)]


def _option_universe(contracts: list[dict], F: dict[str, float]) -> dict[str, list[str]]:
    """Option tickers per option root: the live chain's (strikes near the futures price), and
    for options that have already expired, tickers built on the listed strike grid (the
    invalid ones simply return nothing). Serials only ever sit on the first two quarterlies."""
    out: dict[str, list[str]] = {}
    today = london_now().date()
    for i, c in enumerate(contracts):
        f = F.get(c["id"])
        if f is None:
            continue
        for t in _live_chain(c["ticker"]):
            r, _, k = parse_option_ticker(t)
            if abs(k - f) <= MAX_STRIKE_DIST:
                out.setdefault(r, []).append(t)
        for root, y, m, standard in _expiry_roots(c):
            if root not in out and (standard or i < 2) and _rule_expiry(y, m, standard) < today:
                out[root] = [_opt_ticker(root, cp, k) for k in _strike_grid(f) for cp in "CP"]
    return out


def _bdh_day(tickers: list[str], field: str, start: date, end: date) -> pd.DataFrame:
    """bdh of one field, columns = tickers present (Bloomberg drops unknown / empty ones)."""
    if not tickers:
        return pd.DataFrame()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")      # one warning per invalid constructed ticker otherwise
        df = _blp().bdh(tickers, field, start.isoformat(), end.isoformat())
    if df is None or df.empty:
        return pd.DataFrame()
    df.columns = [c[0] if isinstance(c, tuple) else c for c in df.columns]
    return df.apply(pd.to_numeric, errors="coerce")


def _num(v: Any) -> Optional[float]:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def _fetch_raw(as_of_date: Optional[date]) -> dict:
    """Everything the snapshot needs from Bloomberg, as plain numbers (cacheable as JSON).
    as_of_date None → live; else the settlement of that day (or the last trading day before)."""
    live = as_of_date is None
    now = london_now()
    if live:
        as_of = _last_session_close(now)
        day = as_of.date()
    else:
        day = as_of_date
    contracts = _quarterlies(day)
    futs = [c["ticker"] for c in contracts]
    rate_tickers = [DFR_TICKER, ESTR_TICKER, *OIS_TICKERS]

    if live:
        blp = _blp()
        fq = blp.bdp(futs, ["PX_BID", "PX_ASK", "PX_LAST", "PX_SETTLE"])
        F, F_settle = {}, {}
        for c in contracts:
            row = fq.get(c["ticker"], {})
            bid, ask = _num(row.get("PX_BID")), _num(row.get("PX_ASK"))
            mid = (bid + ask) / 2 if bid and ask and ask >= bid else None
            F[c["id"]] = mid or _num(row.get("PX_LAST")) or _num(row.get("PX_SETTLE"))
            F_settle[c["id"]] = _num(row.get("PX_SETTLE")) or F[c["id"]]
        rq = blp.bdp(rate_tickers, ["PX_LAST"])
        rates = {t: _num(rq.get(t, {}).get("PX_LAST")) for t in rate_tickers}
    else:
        fs = _bdh_day(futs, "PX_SETTLE", day - timedelta(days=10), day)
        fs = fs.dropna(how="all")
        if fs.empty:
            raise RuntimeError(f"No ER futures settlements on or before {day}")
        day = fs.index[-1].date()
        if day != as_of_date:
            contracts = [c for c in contracts if c["ltd"] > day]
        as_of = datetime(day.year, day.month, day.day, *SETTLE_TIME)
        F = {c["id"]: _num(fs[c["ticker"]].iloc[-1]) if c["ticker"] in fs else None for c in contracts}
        F_settle = dict(F)
        rs = _bdh_day(rate_tickers, "PX_LAST", day - timedelta(days=10), day).ffill()
        rates = {t: _num(rs[t].iloc[-1]) if t in rs and len(rs) else None for t in rate_tickers}

    universe = _option_universe(contracts, F)
    tickers = [t for ts in universe.values() for t in ts]
    quotes: dict[str, dict] = {}
    if live:
        oq = _blp().bdp(tickers, ["PX_BID", "PX_ASK", "PX_SETTLE"])
        for t in tickers:
            row = oq.get(t, {})
            quotes[t] = {"bid": _num(row.get("PX_BID")), "ask": _num(row.get("PX_ASK")),
                         "settle": _num(row.get("PX_SETTLE"))}
    else:
        os_ = _bdh_day(tickers, "PX_SETTLE", day, day)
        for t in os_.columns:
            v = _num(os_[t].iloc[-1])
            if v is not None:
                quotes[t] = {"settle": v}

    # Expiry date and underlying of each option root, from one priced ticker per root
    probe: dict[str, str] = {}
    for root, ts in universe.items():
        hit = next((t for t in ts if t in quotes), None)
        if hit:
            probe[root] = hit
    meta = _static(list(probe.values()), ["OPT_EXPIRE_DT", "OPT_UNDL_TICKER"])
    expiries = {}
    for root, t in probe.items():
        e = meta.get(t, {}).get("OPT_EXPIRE_DT")
        if e:
            expiries[root] = str(e)[:10]

    return {
        "live": live, "as_of": as_of.isoformat(timespec="minutes"),
        "contracts": [{**c, "ltd": c["ltd"].isoformat()} for c in contracts],
        "F": F, "F_settle": F_settle, "rates": rates,
        "universe": universe, "quotes": quotes, "expiries": expiries,
    }


def _build(raw: dict) -> dict:
    """The snapshot payload from raw Bloomberg numbers (pure: no Bloomberg calls)."""
    as_of = datetime.fromisoformat(raw["as_of"])
    live = raw["live"]
    contracts_out = []
    for c in raw["contracts"]:
        F = raw["F"].get(c["id"])
        Fs = raw["F_settle"].get(c["id"]) or F
        if F is None:
            continue
        exps = []
        for root, y, m, standard in _expiry_roots(c):
            e = raw["expiries"].get(root)
            if not e or root not in raw["universe"]:
                continue
            exp_dt = datetime.fromisoformat(e).replace(hour=EXPIRY_HOUR)
            if exp_dt <= as_of:
                continue
            T = _years(as_of, exp_dt)
            qs = []
            for t in raw["universe"][root]:
                q = raw["quotes"].get(t)
                if not q:
                    continue
                _, cp, k = parse_option_ticker(t)
                bid, ask, settle = q.get("bid"), q.get("ask"), q.get("settle")
                if live and bid and ask and ask >= bid and ask - bid <= 4 * TICK:
                    qs.append({"strike": k, "type": cp, "price": (bid + ask) / 2, "source": "mid"})
                elif settle and settle > 0:
                    price = settle
                    if live and Fs and abs(F - Fs) > 1e-9:
                        # Settlement struck at yesterday's futures price: carry its vol to the live price
                        iv = implied_normal_vol(settle, Fs, k, T, cp)
                        if iv is None:
                            continue
                        price = bachelier_price(F, k, T, iv, cp)
                    qs.append({"strike": k, "type": cp, "price": price, "source": "settle"})
            fit = fit_chain(F, T, qs)
            if fit is None:
                continue
            exps.append({
                "id": f"{y}-{m:02d}", "code": root, "kind": "standard" if standard else "serial",
                "expiry": exp_dt.isoformat(timespec="minutes"), "T": T, "F": F, **fit,
            })
        exps.sort(key=lambda x: x["expiry"])
        contracts_out.append({"id": c["id"], "ticker": c["ticker"], "year": c["year"], "month": c["month"],
                              "F": F, "ltd": c["ltd"], "expiries": exps})

    rates = raw["rates"]
    dfr, estr = rates.get(DFR_TICKER), rates.get(ESTR_TICKER)
    ois = {T: rates[t] for t, T in OIS_TICKERS.items() if rates.get(t) is not None}
    last_year = max((c["year"] for c in raw["contracts"]), default=as_of.year) + 1
    meetings = [m for m in ecb_meetings(last_year) if m["decision"].year >= as_of.year - 1]
    path = ois_meeting_path(as_of, estr, dfr, ois, meetings) if dfr is not None and estr is not None else []

    def fmt(m: dict) -> dict:
        return {**m, "decision": m["decision"].isoformat(timespec="minutes"),
                "effective": m["effective"].isoformat(timespec="minutes")}

    notes = []
    if not path:
        notes.append("€STR OIS unavailable: no OIS meeting path.")
    return {
        "data_source": "bloomberg", "live": live, "as_of": raw["as_of"], "note": " ".join(notes) or None,
        "contracts": contracts_out,
        "meetings": [fmt(m) for m in meetings],
        "ois_path": [fmt(m) for m in path],
        "rates": {"dfr": dfr, "estr": estr, "ois": [{"tenor": T, "rate": r} for T, r in sorted(ois.items())]},
    }


_live_cache: Optional[tuple[float, dict]] = None
_live_lock = threading.Lock()
_hist_lock = threading.Lock()


def _simulation(note: str) -> dict:
    return {"data_source": "simulation", "live": False, "as_of": None, "note": note,
            "contracts": [], "meetings": [], "ois_path": [], "rates": None}


def get_snapshot(date_str: Optional[str] = None, refresh: bool = False) -> dict:
    """Snapshot payload for a past date (its settlement) or, with no / today's date, live."""
    if settings.data_source != "bloomberg":
        return _simulation("Bloomberg is not the configured data source.")
    global _live_cache
    today = london_now().date()
    req = date.fromisoformat(date_str) if date_str else None
    try:
        if req is None or req >= today:
            with _live_lock:
                if _live_cache and not refresh and time.monotonic() - _live_cache[0] < _LIVE_TTL_S:
                    return _live_cache[1]
                payload = _build(_fetch_raw(None))
                _live_cache = (time.monotonic(), payload)
                return payload
        # Settlements are final once the day is over: cache the raw numbers on disk
        path = state_path(f"macro_options/snapshot_{req.isoformat()}.json")
        with _hist_lock:
            raw = None
            if path.exists() and not refresh:
                try:
                    raw = json.loads(path.read_text(encoding="utf-8"))
                except ValueError:
                    raw = None
            if raw is None:
                raw = _fetch_raw(req)
                path.write_text(json.dumps(raw), encoding="utf-8")
        return _build(raw)
    except Exception as exc:  # noqa: BLE001 — any Bloomberg failure falls back to the simulation
        logger.exception("Macro Options snapshot failed")
        return _simulation(f"Bloomberg request failed: {exc}")


# ---------------------------------------------------------------------------
# Open interest
# ---------------------------------------------------------------------------

_oi_cache: dict[str, tuple[date, pd.DataFrame, pd.Series, date]] = {}
_oi_lock = threading.Lock()


def _parse_expiry_id(expiry_id: str) -> tuple[int, int]:
    y, m = expiry_id.split("-")
    return int(y), int(m)


def _oi_frames(contract: str, expiry_id: str) -> tuple[pd.DataFrame, pd.Series, date]:
    """(OI by ticker, futures settlement, expiry) from listing to today, cached per day."""
    y, m = _parse_expiry_id(expiry_id)
    root = _root(y, m)
    key = f"{contract}|{root}"
    with _oi_lock:
        hit = _oi_cache.get(key)
        if hit and hit[0] == date.today():
            return hit[1], hit[2], hit[3]
        cm = MONTH_CODES.index(contract[2]) + 1
        cy = y + (int(contract[3]) - y % 10) % 10           # the contract's year: first on or after the option's
        fut = _fut_ticker(cy, cm)
        standard = (cy, cm) == (y, m)
        chain = [t for t in _live_chain(fut) if parse_option_ticker(t)[0] == root]
        meta = _static([chain[0]] if chain else [], ["OPT_EXPIRE_DT"])
        exp = meta.get(chain[0], {}).get("OPT_EXPIRE_DT") if chain else None
        expiry = date.fromisoformat(str(exp)[:10]) if exp else _rule_expiry(y, m, standard)
        start = expiry - timedelta(days=400 if standard else 160)
        end = min(date.today(), expiry)
        fs = _bdh_day([fut], "PX_SETTLE", start, end)
        if fs.empty:
            raise RuntimeError(f"No settlements for {fut}")
        F = fs[fut].dropna()
        tickers = chain or [_opt_ticker(root, cp, k) for k in _strike_grid(float(F.iloc[-1])) for cp in "CP"]
        if not chain:   # widen the built grid to the futures' range over the option's life
            ks = sorted({k for f in (F.min(), F.max()) for k in _strike_grid(float(f))})
            tickers = [_opt_ticker(root, cp, k) for k in ks for cp in "CP"]
        oi = _bdh_day(tickers, "OPEN_INT", start, end)
        _oi_cache[key] = (date.today(), oi, F, expiry)
        return oi, F, expiry


def get_open_interest(contract: str, expiry_id: str, through: Optional[str] = None) -> dict:
    """Daily per-strike call / put open interest for one option expiry, up to `through`."""
    base = {"contract": contract, "expiry": expiry_id, "dates": [], "strikes": [], "calls": [], "puts": [], "F": []}
    if settings.data_source != "bloomberg":
        return {"data_source": "simulation", "note": "Bloomberg is not the configured data source.", **base}
    try:
        oi, F, _ = _oi_frames(contract, expiry_id)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Macro Options open interest failed")
        return {"data_source": "simulation", "note": f"Bloomberg request failed: {exc}", **base}
    if through:
        cut = pd.Timestamp(through)
        oi, F = oi.loc[oi.index <= cut], F.loc[F.index <= cut]
    oi = oi.dropna(how="all")                      # OPEN_INT lags a day: the last date is often empty
    if oi.empty:
        return {"data_source": "bloomberg", "note": "No open interest published yet.", **base}
    dates = oi.index.intersection(F.index)
    oi = oi.loc[dates].ffill().fillna(0.0)
    parsed = {t: parse_option_ticker(t) for t in oi.columns}
    strikes = sorted({p[2] for p in parsed.values() if p})
    pos = {k: i for i, k in enumerate(strikes)}
    calls = np.zeros((len(dates), len(strikes)))
    puts = np.zeros_like(calls)
    for t, p in parsed.items():
        if p:
            (calls if p[1] == "C" else puts)[:, pos[p[2]]] = oi[t].to_numpy()
    keep = (calls.max(axis=0) > 0) | (puts.max(axis=0) > 0)
    strikes = [k for k, ok in zip(strikes, keep) if ok]
    calls, puts = calls[:, keep], puts[:, keep]
    return {
        "data_source": "bloomberg", "note": None, **base,
        "dates": [d.strftime("%Y-%m-%d") for d in dates],
        "strikes": strikes,
        "calls": calls.round().astype(int).tolist(),
        "puts": puts.round().astype(int).tolist(),
        "F": [float(F.loc[d]) for d in dates],
    }


def warm_cache() -> None:
    """Fetch the live snapshot once at startup so the first visitor doesn't wait."""
    if settings.data_source == "bloomberg":
        get_snapshot()
