"""
Nowcasting engine for the Quant Macro section: a mixed-frequency dynamic
factor model in the Bańbura & Modugno (2014) class, the family behind the NY
Fed Staff Nowcast and central-bank staff nowcasting suites.

Model (statsmodels ``DynamicFactorMQ``, estimated by EM on the monthly panel)
------------------------------------------------------------------------------
  x_it = Λ_i f_t + e_it          f_t = [Global, Soft | Real | Labour] blocks, VAR(p)
  e_it = ρ_i e_i,t-1 + ε_it      idiosyncratic AR(1), carried in the state

Missing data are native: the ragged edge, series that start late and the
excluded COVID window are all just NaN. The target is a monthly growth rate
g_t (UK: monthly GDP, % m/m). Quarterly growth of the 3-month-average level is

  q_t = (g_t + 2 g_{t-1} + 3 g_{t-2} + 2 g_{t-3} + g_{t-4}) / 3

so its mean and variance follow from the smoothed states, including the
cross-month covariances (RTS: Cov(α_s, α_t | Y) = J_s Cov(α_{s+1}, α_t | Y),
J_s = P_{s|s} T' P_{s+1|s}^-1).

News (Bańbura & Modugno): with the parameters fixed, the change in the
nowcast between two data vintages is Σ_j w_j (x_j − E_old[x_j]); computed by
statsmodels' ``news()`` and aggregated to the quarterly target here.

Vintages are pseudo-real-time: today's data, masked by each observation's
release date (Bloomberg's when available, otherwise the catalogue's typical
lag). Data revisions are not modelled and the parameters are estimated once
on the full sample.
"""
from __future__ import annotations

import json
import logging
import warnings
import zlib
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

DATA_DIR = Path(__file__).resolve().parent / "data"
TRIANGLE = np.array([1.0, 2.0, 3.0, 2.0, 1.0]) / 3.0   # weights on g_{t-4} .. g_t
SIM_FIRST, SIM_LAST = "1997-01", "2040-12"            # fixed draw window: history is stable day to day
MIN_OBS = 24                                          # a series needs this many months to enter the model


@dataclass(frozen=True)
class NowcastSpec:
    slug: str
    title: str
    country: str                       # ISO code, for the flag
    target: str                        # catalogue id of the monthly target (growth rate)
    target_label: str                  # "GDP"
    catalogue: str                     # file in data/
    quarterly_ticker: str | None       # Bloomberg ticker of the quarterly first estimate (consensus)
    central_bank_file: str | None      # hand-maintained staff estimates, in data/
    bridge_series: str | None          # survey for the bridge equation (quarterly average)
    start: str = "1998-01"
    exclude: tuple[tuple[str, str], ...] = (("2020-03", "2021-06"),)
    factor_orders: tuple[tuple[str, int], ...] = (("Global", 2),)
    maxiter: int = 300
    backtest_from: str = "2012Q1"
    horizons: tuple[int, ...] = (-120, -90, -60, -30, -1)   # days before the first estimate


@dataclass
class Panel:
    """Monthly panel in model units, and the release date of every observation."""
    values: pd.DataFrame               # PeriodIndex[M] × series id
    release: pd.DataFrame              # same shape, datetime64 (NaT = no observation)
    source: str                        # "live" | "simulation"
    missing: list[str] = field(default_factory=list)
    calendar: dict[str, dict] = field(default_factory=dict)   # live: next release date / consensus per id

    def vintage(self, as_of: pd.Timestamp) -> pd.DataFrame:
        return self.values.where(self.release <= as_of)


@lru_cache(maxsize=None)
def load_catalogue(name: str) -> tuple[dict, ...]:
    data = json.loads((DATA_DIR / name).read_text(encoding="utf-8"))
    return tuple(data["series"])


# ---------------------------------------------------------------------------
# Calendar helpers
# ---------------------------------------------------------------------------

def horizon_end(as_of: pd.Timestamp) -> pd.Period:
    """Last month of the quarter after the current one."""
    return (pd.Period(as_of, "Q") + 1).asfreq("M", "end")


def _next_weekday(d: pd.DatetimeIndex) -> pd.DatetimeIndex:
    shift = np.where(d.dayofweek == 5, 2, np.where(d.dayofweek == 6, 1, 0))
    return d + pd.to_timedelta(shift, unit="D")


def typical_release(periods: pd.PeriodIndex, lag_days: int) -> pd.DatetimeIndex:
    ends = periods.to_timestamp(how="end").normalize()
    return _next_weekday(ends + pd.Timedelta(days=lag_days))


def quarter_months(q: pd.Period) -> pd.PeriodIndex:
    """The five months entering q/q growth of quarter q (oldest first)."""
    last = q.asfreq("M", "end")
    return pd.period_range(last - 4, last, freq="M")


def triangle_qoq(g: pd.Series, q: pd.Period) -> float | None:
    """Quarterly growth of quarter q from monthly growth rates, if all five months are known."""
    vals = g.reindex(quarter_months(q))
    return None if vals.isna().any() else float(TRIANGLE @ vals.to_numpy())


# ---------------------------------------------------------------------------
# Data: simulation and Bloomberg
# ---------------------------------------------------------------------------

def simulate_panel(spec: NowcastSpec, as_of: pd.Timestamp) -> Panel:
    """Deterministic synthetic panel from the catalogue's DGP (seeded by the slug)."""
    series = load_catalogue(spec.catalogue)
    rng = np.random.default_rng(zlib.crc32(spec.slug.encode()))
    idx = pd.period_range(SIM_FIRST, SIM_LAST, freq="M")
    n = len(idx)

    shocks = rng.standard_normal(n)
    recession = (idx >= pd.Period("2008-06", "M")) & (idx <= pd.Period("2009-01", "M"))
    shocks[recession] -= 1.6
    f = np.zeros(n)
    for t in range(2, n):
        f[t] = 0.55 * f[t - 1] + 0.25 * f[t - 2] + shocks[t]
    f /= f.std()

    blocks: dict[str, np.ndarray] = {}
    for name in ("Soft", "Real", "Labour"):
        e = rng.standard_normal(n)
        b = np.zeros(n)
        for t in range(1, n):
            b[t] = 0.7 * b[t - 1] + e[t]
        blocks[name] = b / b.std()

    values, release = {}, {}
    for s in series:
        p = s["sim"]
        e = rng.standard_normal(n) * np.sqrt(1 - p["rho"] ** 2)
        u = np.zeros(n)
        for t in range(1, n):
            u[t] = p["rho"] * u[t - 1] + e[t]
        block = next((b for b in s["blocks"] if b != "Global"), None)
        x = p["mean"] + p["load"] * f + 0.4 * abs(p["load"]) * blocks.get(block, 0.0) + p["noise"] * u
        x = pd.Series(np.round(x, 2), index=idx)
        x[idx < pd.Period(s["start"], "M")] = np.nan
        values[s["id"]] = x
        release[s["id"]] = pd.Series(typical_release(idx, s["release_lag_days"]), index=idx).where(x.notna())

    end = horizon_end(as_of)
    vals = pd.DataFrame(values).loc[:end]
    rel = pd.DataFrame(release).loc[:end]
    return Panel(values=vals, release=rel, source="simulation")


def _apply_transform(x: pd.Series, how: str) -> pd.Series:
    if how == "diff":
        return x.diff()
    if how == "log_diff":
        return 100 * np.log(x.where(x > 0)).diff()
    return x


def _parse_release_dates(raw: pd.Series) -> pd.Series:
    """ECO_RELEASE_DT comes back as YYYYMMDD numbers."""
    s = pd.to_numeric(raw, errors="coerce").dropna().astype("int64").astype(str)
    return pd.to_datetime(s, format="%Y%m%d", errors="coerce")


def fetch_live_panel(spec: NowcastSpec, as_of: pd.Timestamp) -> Panel:
    """Monthly panel from Bloomberg. Raises if the target or most of the panel is missing."""
    import bbg

    series = load_catalogue(spec.catalogue)
    tickers = [s["ticker_bloomberg"] for s in series]
    end = as_of.strftime("%Y-%m-%d")
    hist = bbg.bdh(tickers=tickers, flds=["PX_LAST"], start_date="1996-01-01", end_date=end, periodicity="MONTHLY")
    try:
        rel_hist = bbg.bdh(tickers=tickers, flds=["ECO_RELEASE_DT"], start_date="1996-01-01", end_date=end,
                           periodicity="MONTHLY")
    except Exception:                                  # release dates are a nice-to-have
        rel_hist = pd.DataFrame()
    idx = pd.period_range("1996-01", horizon_end(as_of), freq="M")

    values, release, missing = {}, {}, []
    for s in series:
        t = s["ticker_bloomberg"]
        if (t, "PX_LAST") not in hist.columns or hist[(t, "PX_LAST")].dropna().size < MIN_OBS:
            missing.append(s["id"])
            continue
        raw = hist[(t, "PX_LAST")].dropna()
        raw.index = pd.DatetimeIndex(raw.index).to_period("M")
        x = _apply_transform(raw.groupby(level=0).last(), s["transform"]).reindex(idx)
        typical = pd.Series(typical_release(idx, s["release_lag_days"]), index=idx)
        if (t, "ECO_RELEASE_DT") in rel_hist.columns:
            actual = _parse_release_dates(rel_hist[(t, "ECO_RELEASE_DT")])
            actual.index = pd.DatetimeIndex(actual.index).to_period("M")
            typical.update(actual.groupby(level=0).last())
        # Everything Bloomberg returned is public today, whatever the estimated date says.
        values[s["id"]] = x
        release[s["id"]] = typical.where(x.notna()).clip(upper=as_of)

    if spec.target in missing or len(missing) > 0.4 * len(series):
        raise RuntimeError(f"Live panel incomplete: missing {missing}")

    calendar: dict[str, dict] = {}
    try:
        ref = bbg.bdp(tickers + ([spec.quarterly_ticker] if spec.quarterly_ticker else []),
                      ["ECO_RELEASE_DT", "BN_SURVEY_MEDIAN"])
        by_ticker = {s["ticker_bloomberg"]: s for s in series}
        for t, row in ref.items():
            s = by_ticker.get(t)
            key = s["id"] if s else "_quarterly"
            dt = _parse_release_dates(pd.Series([row.get("ECO_RELEASE_DT")]))
            cons = row.get("BN_SURVEY_MEDIAN")
            calendar[key] = {
                "release": dt.iloc[0] if len(dt) else None,
                # consensus is in the ticker's own units: comparable only for untransformed series
                "consensus": float(cons) if cons is not None and (s is None or s["transform"] == "none") else None,
            }
    except Exception:
        logger.warning("Nowcast %s: release calendar / consensus unavailable", spec.slug, exc_info=True)

    return Panel(values=pd.DataFrame(values), release=pd.DataFrame(release), source="live",
                 missing=missing, calendar=calendar)


def load_panel(spec: NowcastSpec, as_of: pd.Timestamp, data_source: str) -> Panel:
    if data_source == "bloomberg":
        try:
            return fetch_live_panel(spec, as_of)
        except Exception as exc:
            logger.warning("Nowcast %s: live data unavailable (%s); using simulation", spec.slug, exc)
            panel = simulate_panel(spec, as_of)
            panel.missing = [s["id"] for s in load_catalogue(spec.catalogue)]
            return panel
    return simulate_panel(spec, as_of)


# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------

def model_data(spec: NowcastSpec, vintage: pd.DataFrame, columns: list[str] | None = None) -> pd.DataFrame:
    """Vintage → estimation frame: sample start, excluded windows blanked."""
    y = vintage.loc[pd.Period(spec.start, "M"):].copy()
    for a, b in spec.exclude:
        y.loc[pd.Period(a, "M"):pd.Period(b, "M")] = np.nan
    return y if columns is None else y[columns]


def fit_model(spec: NowcastSpec, y: pd.DataFrame):
    """EM estimate of the DFM on frame y; series with too little data are left out."""
    from statsmodels.tsa.statespace.dynamic_factor_mq import DynamicFactorMQ

    series = {s["id"]: s for s in load_catalogue(spec.catalogue)}
    cols = [c for c in y.columns if y[c].notna().sum() >= MIN_OBS]
    if spec.target not in cols:
        raise ValueError(f"target {spec.target!r} has too little data")
    factors = {c: list(series[c]["blocks"]) for c in cols}
    mod = DynamicFactorMQ(y[cols], factors=factors, factor_orders=dict(spec.factor_orders),
                          idiosyncratic_ar1=True, standardize=True)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return mod.fit(disp=False, maxiter=spec.maxiter, tolerance=1e-6)


def apply_vintage(res, y: pd.DataFrame):
    """Same parameters, new data (pseudo-real-time vintage)."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return res.apply(y[list(res.model.endog_names)])


def _matrix(res, name: str) -> np.ndarray:
    m = np.asarray(res.model[name])
    return m[..., 0] if m.ndim == 3 else m


def target_moments(res, target: str, months: pd.PeriodIndex) -> tuple[np.ndarray, np.ndarray]:
    """Smoothed mean and covariance of the target over contiguous months (original units)."""
    model = res.model
    names = list(model.endog_names)
    i = names.index(target)
    z = _matrix(res, "design")[i]
    T = _matrix(res, "transition")
    mu = float(np.asarray(model._endog_mean)[i])
    sd = float(np.asarray(model._endog_std)[i])

    index = res.model._index
    pos = [index.get_loc(m) for m in months]
    a = res.smoothed_state
    Ps, Pf, Pp = res.smoothed_state_cov, res.filtered_state_cov, res.predicted_state_cov

    gains = {s: Pf[:, :, s] @ T.T @ np.linalg.pinv(Pp[:, :, s + 1], rcond=1e-12)
             for s in range(pos[0], pos[-1])}
    k = len(pos)
    cov = np.zeros((k, k))
    for b, t in enumerate(pos):
        C = Ps[:, :, t]
        cov[b, b] = z @ C @ z
        s = t
        for j in range(b - 1, -1, -1):
            while s > pos[j]:
                s -= 1
                C = gains[s] @ C
            cov[j, b] = cov[b, j] = z @ C @ z
    mean = mu + sd * (z @ a[:, pos])
    cov = sd ** 2 * cov
    return mean, 0.5 * (cov + cov.T)


def target_means(res, target: str, months: pd.PeriodIndex) -> np.ndarray:
    """Smoothed mean only (cheap; used by the backtest)."""
    model = res.model
    i = list(model.endog_names).index(target)
    z = _matrix(res, "design")[i]
    pos = [model._index.get_loc(m) for m in months]
    return (float(np.asarray(model._endog_mean)[i])
            + float(np.asarray(model._endog_std)[i]) * (z @ res.smoothed_state[:, pos]))


def quarter_nowcast(res, target: str, q: pd.Period) -> tuple[float, float]:
    """Mean and standard deviation of q/q growth in quarter q."""
    mean, cov = target_moments(res, target, quarter_months(q))
    return float(TRIANGLE @ mean), float(np.sqrt(max(TRIANGLE @ cov @ TRIANGLE, 0.0)))


def quarter_impacts(news, target: str, quarters: list[pd.Period]) -> pd.DataFrame:
    """News impacts on each quarter's q/q (weight × news). Rows: (update date, updated variable)."""
    w = quarter_weights(news, target, quarters)
    return w.mul(news.news.reindex(w.index).to_numpy(), axis=0)


def quarter_weights(news, target: str, quarters: list[pd.Period]) -> pd.DataFrame:
    """Weight of each updated (period, series) on each quarter's q/q: pp per unit of surprise."""
    w = news.weights
    if w.empty:
        return pd.DataFrame(columns=[str(q) for q in quarters])
    w = w.xs(target, axis=1, level="impacted variable")
    out = {}
    for q in quarters:
        tri = pd.Series(TRIANGLE, index=quarter_months(q))
        cols = [c for c in w.columns if c in tri.index]
        out[str(q)] = w[cols].to_numpy() @ tri[cols].to_numpy() if cols else np.zeros(len(w))
    return pd.DataFrame(out, index=w.index)


def compute_news(res_new, res_prev, target: str, start: pd.Period, end: pd.Period):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return res_new.news(res_prev, start=start, end=end, impacted_variable=target,
                            comparison_type="previous")


# ---------------------------------------------------------------------------
# Bridge equation (survey → quarterly GDP)
# ---------------------------------------------------------------------------

@dataclass
class Bridge:
    series: str
    alpha: float
    beta: float
    r2: float
    resid_sd: float
    n: int

    def predict(self, vintage: pd.DataFrame, q: pd.Period) -> float | None:
        months = pd.period_range(q.asfreq("M", "start"), q.asfreq("M", "end"), freq="M")
        x = vintage[self.series].reindex(months).dropna()
        return None if x.empty else float(self.alpha + self.beta * x.mean())


def fit_bridge(spec: NowcastSpec, vintage: pd.DataFrame) -> Bridge | None:
    """OLS of q/q GDP on the quarterly average of a survey, COVID quarters excluded."""
    if not spec.bridge_series or spec.bridge_series not in vintage:
        return None
    g, x = vintage[spec.target], vintage[spec.bridge_series]
    first = max(pd.Period(spec.start, "M"), x.first_valid_index()).asfreq("Q") + 1
    last = g.last_valid_index().asfreq("Q")
    rows = []
    for q in pd.period_range(first, last, freq="Q"):
        if _touches_exclusion(spec, q):
            continue
        y = triangle_qoq(g, q)
        xm = x.reindex(pd.period_range(q.asfreq("M", "start"), q.asfreq("M", "end"), freq="M"))
        if y is not None and xm.notna().all():
            rows.append((y, xm.mean()))
    if len(rows) < 12:
        return None
    y, xv = np.array(rows).T
    X = np.column_stack([np.ones_like(xv), xv])
    beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    resid = y - X @ beta
    r2 = 1 - resid.var() / y.var()
    return Bridge(spec.bridge_series, float(beta[0]), float(beta[1]), float(r2),
                  float(resid.std(ddof=2)), len(y))


def _touches_exclusion(spec: NowcastSpec, q: pd.Period) -> bool:
    months = quarter_months(q)
    return any(((months >= pd.Period(a, "M")) & (months <= pd.Period(b, "M"))).any() for a, b in spec.exclude)
