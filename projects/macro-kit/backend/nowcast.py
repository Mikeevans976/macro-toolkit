"""
Nowcasting engine for the Quant Macro section: a mixed-frequency dynamic
factor model in the Bańbura & Modugno (2014) class, the family behind the NY
Fed Staff Nowcast and central-bank staff nowcasting suites.

Model (statsmodels ``DynamicFactorMQ``, estimated by EM on the monthly panel)
------------------------------------------------------------------------------
  x_it = Λ_i f_t + e_it          f_t = [Global, Soft | Real | Labour] blocks, VAR(p)
  e_it = ρ_i e_i,t-1 + ε_it      idiosyncratic AR(1), carried in the state

Missing data are native: the ragged edge, series that start late and the
excluded COVID window are all just NaN. The target is either

  monthly (UK: monthly GDP, % m/m): quarterly growth of the 3-month-average level is
      q_t = (g_t + 2 g_{t-1} + 3 g_{t-2} + 2 g_{t-3} + g_{t-4}) / 3
    so its mean and variance follow from the smoothed states, including the
    cross-month covariances (RTS: Cov(α_s, α_t | Y) = J_s Cov(α_{s+1}, α_t | Y),
    J_s = P_{s|s} T' P_{s+1|s}^-1); or
  quarterly (US: real GDP, % q/q saar): observed in the last month of each quarter.
    DynamicFactorMQ puts quarterly series last and builds the same triangle into
    their design rows (Mariano and Murasawa), so the quarter's value is that row
    times the state in its last month, with no cross-month terms.

News (Bańbura & Modugno): with the parameters fixed, the change in the
nowcast between two data vintages is Σ_j w_j (x_j − E_old[x_j]); computed by
statsmodels' ``news()`` and aggregated to the quarterly target here.

Vintages are real-time (vintages.py): every value is stored with the day it
became public, first prints and revisions alike, so ``Panel.vintage(d)`` is
the dataset as it stood on day d. Parameters are estimated on demand (Refit)
and saved; the backtest re-estimates them each quarter on that day's data.
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

import vintages as vt

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
    target_freq: str = "M"             # "M": monthly target aggregated to quarters; "Q": quarterly target
    target_units: str = "% q/q"        # units of the quarterly figure
    forecast_quarters: int = 1         # quarters after the current one carried in the model
    policy_file: str | None = None     # policymakers' projections (e.g. FOMC SEP), in data/


@dataclass
class Panel:
    """Every observation with the date it became public (first print, then each revision).

    ``vintage(d)`` rebuilds the monthly panel, in model units, exactly as it stood on day d."""
    obs: pd.DataFrame                  # series, period (Period[M]), known_from, value (ticker units), source
    transforms: dict[str, str]         # catalogue transform per series id, in catalogue order
    source: str                        # "live" | "simulation"
    missing: list[str] = field(default_factory=list)
    calendar: dict[str, dict] = field(default_factory=dict)   # live: next release date / consensus per id
    vintage_info: dict[str, str] = field(default_factory=dict)   # how each series' revisions are tracked

    def __post_init__(self) -> None:
        obs = self.obs.sort_values("known_from", kind="stable")
        present = set(obs["series"])
        self.ids = [s for s in self.transforms if s in present]
        self.index = pd.period_range(obs["period"].min(), obs["period"].max(), freq="M")
        s_pos = pd.Index(self.ids).get_indexer(obs["series"])
        p_pos = pd.PeriodIndex(obs["period"], freq="M").asi8 - self.index[0].ordinal
        self._cell = s_pos * len(self.index) + p_pos
        self._known = obs["known_from"].to_numpy("datetime64[ns]")
        self._value = obs["value"].to_numpy(float)
        self._cache: dict[pd.Timestamp, pd.DataFrame] = {}
        self._release: pd.DataFrame | None = None

    def _raw(self, k: int) -> np.ndarray:
        """Latest value of every (series, period) cell among the first k observations."""
        cell, val = self._cell[:k][::-1], self._value[:k][::-1]
        u, i = np.unique(cell, return_index=True)
        grid = np.full(len(self.ids) * len(self.index), np.nan)
        grid[u] = val[i]
        return grid.reshape(len(self.ids), len(self.index)).T

    def vintage(self, as_of: pd.Timestamp) -> pd.DataFrame:
        """Panel in model units as published on day as_of (transforms applied to that day's levels)."""
        as_of = pd.Timestamp(as_of)
        hit = self._cache.get(as_of)
        if hit is None:
            k = int(np.searchsorted(self._known, as_of.to_datetime64(), side="right"))
            raw = pd.DataFrame(self._raw(k), index=self.index, columns=self.ids)
            hit = pd.DataFrame({c: _apply_transform(raw[c], self.transforms[c]) for c in self.ids})
            if len(self._cache) > 256:
                self._cache.clear()
            self._cache[as_of] = hit
        return hit.copy()

    @property
    def values(self) -> pd.DataFrame:
        """Latest values (today's data, and in the simulation the future truth)."""
        return self.vintage(pd.Timestamp.max.normalize())

    @property
    def release(self) -> pd.DataFrame:
        """First-release date of every observation in model units (NaT = never observed)."""
        if self._release is None:
            first = (self.obs.groupby(["period", "series"])["known_from"].min().unstack()
                     .reindex(index=self.index, columns=self.ids))
            for c in self.ids:
                if self.transforms[c] in ("diff", "log_diff"):     # a change needs last month's level too
                    first[c] = pd.concat([first[c], first[c].shift(1)], axis=1).max(axis=1, skipna=False)
            self._release = first
        return self._release

    def change_dates(self, cols: list[str], start: pd.Timestamp, end: pd.Timestamp) -> list[pd.Timestamp]:
        """Days in [start, end] on which any of cols was released or revised."""
        rows = self.obs[self.obs["series"].isin(cols)]
        d = rows["known_from"]
        return sorted({pd.Timestamp(x) for x in d[(d >= start) & (d <= end)].unique()})


@lru_cache(maxsize=None)
def load_catalogue(name: str) -> tuple[dict, ...]:
    data = json.loads((DATA_DIR / name).read_text(encoding="utf-8"))
    return tuple(data["series"])


# ---------------------------------------------------------------------------
# Calendar helpers
# ---------------------------------------------------------------------------

def horizon_end(as_of: pd.Timestamp, ahead: int = 1) -> pd.Period:
    """Last month of the quarter ``ahead`` quarters after the current one."""
    return (pd.Period(as_of, "Q") + ahead).asfreq("M", "end")


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


def quarter_weights_of(q: pd.Period, freq: str) -> tuple[pd.PeriodIndex, np.ndarray]:
    """Months and weights that make quarter q from the target's model values: the triangle
    over five months for a monthly target, the last month alone for a quarterly one (whose
    design row already carries the triangle)."""
    if freq == "Q":
        return pd.PeriodIndex([q.asfreq("M", "end")], freq="M"), np.array([1.0])
    return quarter_months(q), TRIANGLE


def quarter_value(g: pd.Series, q: pd.Period, freq: str = "M") -> float | None:
    """Published quarterly growth of quarter q (monthly target: triangle; quarterly: its value)."""
    if freq == "Q":
        v = g.get(q.asfreq("M", "end"), np.nan)
        return None if pd.isna(v) else float(v)
    return triangle_qoq(g, q)


def is_quarterly(s: dict) -> bool:
    return s.get("frequency", "M") == "Q"


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

    # Revisions come from their own generator so the history above is unchanged by them.
    rev_rng = np.random.default_rng(zlib.crc32(f"{spec.slug}:revisions".encode()))
    end = horizon_end(as_of, spec.forecast_quarters)
    keep = idx <= end
    frames, info = [], {}
    for s in series:
        p = s["sim"]
        e = rng.standard_normal(n) * np.sqrt(1 - p["rho"] ** 2)
        u = np.zeros(n)
        for t in range(1, n):
            u[t] = p["rho"] * u[t - 1] + e[t]
        block = next((b for b in s["blocks"] if b != "Global"), None)
        x = p["mean"] + p["load"] * f + 0.4 * abs(p["load"]) * blocks.get(block, 0.0) + p["noise"] * u
        if is_quarterly(s):              # quarterly: the triangle of the latent monthly path, at quarter ends
            agg = np.full(n, np.nan)
            agg[4:] = np.convolve(x, TRIANGLE[::-1], mode="valid")
            x = np.where(np.asarray(idx.month) % 3 == 0, agg, np.nan)
        x = np.round(x, 2)
        ok = keep & (idx >= pd.Period(s["start"], "M")) & ~np.isnan(x)
        rel = typical_release(idx, s["release_lag_days"])
        cfg = s.get("vintages") or {}
        e1, e2 = rev_rng.standard_normal(n), rev_rng.standard_normal(n)
        sd, settle = cfg.get("sim_sd", 0.0), cfg.get("settle_days", 0)
        if sd and settle:
            # first print, a second estimate a month later when revisions run longer, then the final value
            parts = [(rel, np.round(x + sd * e1, 2))]
            if settle >= 60:
                parts.append((_next_weekday(rel + pd.Timedelta(days=30)), np.round(x + 0.5 * sd * e2, 2)))
            parts.append((_next_weekday(rel + pd.Timedelta(days=settle)), x))
            info[s["id"]] = f"Simulated revisions: first print ± {sd} ({s['units']}), final after {settle} days"
        else:
            parts = [(rel, x)]
            info[s["id"]] = "Simulated, not revised"
        for d, v in parts:
            frames.append(pd.DataFrame({"series": s["id"], "period": idx[ok], "known_from": d[ok],
                                        "value": v[ok], "source": "sim"}))
    obs = vt.dedupe(pd.concat(frames, ignore_index=True))
    return Panel(obs=obs, transforms={s["id"]: "none" for s in series}, source="simulation", vintage_info=info)


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


def _monthly(hist: pd.DataFrame, ticker: str, field_: str) -> pd.Series:
    if (ticker, field_) not in hist.columns:
        return pd.Series(dtype=float)
    x = hist[(ticker, field_)].dropna()
    x.index = pd.DatetimeIndex(x.index).to_period("M")
    return x.groupby(level=0).last()


def fetch_live_panel(spec: NowcastSpec, as_of: pd.Timestamp, store: vt.VintageStore, ons_dir: Path) -> Panel:
    """Real-time panel: Bloomberg (today's values, first prints, release dates), ONS revisions
    triangles and the stored daily snapshots. Raises if the target or most of the panel is missing."""
    import bbg

    series = load_catalogue(spec.catalogue)
    dataset = spec.catalogue.removesuffix(".json")
    tickers = [s["ticker_bloomberg"] for s in series]
    end = as_of.strftime("%Y-%m-%d")
    hist = bbg.bdh(tickers=tickers, flds=["PX_LAST"], start_date="1996-01-01", end_date=end, periodicity="MONTHLY")
    extra = {}
    for fld in ("ECO_RELEASE_DT", "ACTUAL_RELEASE"):   # release dates and first prints are nice-to-haves
        try:
            extra[fld] = bbg.bdh(tickers=tickers, flds=[fld], start_date="1996-01-01", end_date=end,
                                 periodicity="MONTHLY")
        except Exception:
            logger.warning("Nowcast %s: %s history unavailable", spec.slug, fld, exc_info=True)
            extra[fld] = pd.DataFrame()
    idx = pd.period_range("1996-01", horizon_end(as_of, spec.forecast_quarters), freq="M")

    latest, first, release, missing = {}, {}, {}, []
    for s in series:
        t, sid = s["ticker_bloomberg"], s["id"]
        x = _monthly(hist, t, "PX_LAST")
        if x.size < MIN_OBS:
            missing.append(sid)
            continue
        typical = pd.Series(typical_release(idx, s["release_lag_days"]), index=idx)
        if (t, "ECO_RELEASE_DT") in extra["ECO_RELEASE_DT"].columns:
            actual = _parse_release_dates(extra["ECO_RELEASE_DT"][(t, "ECO_RELEASE_DT")])
            actual.index = pd.DatetimeIndex(actual.index).to_period("M")
            typical.update(actual.groupby(level=0).last())
        # Everything Bloomberg returned is public today, whatever the estimated date says.
        latest[sid] = x
        release[sid] = typical.reindex(idx).where(x.reindex(idx).notna()).clip(upper=as_of)
        first[sid] = _monthly(extra["ACTUAL_RELEASE"], t, "ACTUAL_RELEASE").reindex(x.index)

    if spec.target in missing or len(missing) > 0.4 * len(series):
        raise RuntimeError(f"Live panel incomplete: missing {missing}")

    store.add(dataset, pd.DataFrame(
        [(sid, p, release[sid].get(p), v, "bbg_first") for sid, f in first.items() for p, v in f.dropna().items()
         if not pd.isna(release[sid].get(p))], columns=vt.COLUMNS))
    by_id = {s["id"]: s for s in series}
    ons_ok: set[str] = set()
    for sid in latest:
        key = (by_id[sid].get("vintages") or {}).get("ons")
        if not key:
            continue
        try:
            path = vt.download_ons(key, ons_dir, today=as_of)
            if path is None:
                continue
            lag = by_id[sid]["release_lag_days"]
            rel_fn = (lambda p, r=release[sid], lag=lag:
                      r.get(p) if not pd.isna(r.get(p, pd.NaT)) else typical_release(pd.PeriodIndex([p]), lag)[0])
            rows = vt.ons_rows(key, path, rel_fn)
            # Guard against a ticker in other units than the ONS series (e.g. 3m/3m vs m/m).
            last = rows.sort_values("known_from").groupby("period")["value"].last()
            common = last.index.intersection(latest[sid].index)
            gap = float((last[common] - latest[sid][common]).abs().median()) if len(common) else np.inf
            if gap > 0.15 * max(float(latest[sid].abs().median()), 1e-9) + 0.05:
                logger.warning("Nowcast %s: ONS %s disagrees with %s (median gap %.3f); ignoring ONS",
                               spec.slug, key, by_id[sid]["ticker_bloomberg"], gap)
                continue
            store.add(dataset, rows.assign(series=sid, source="ons"))
            ons_ok.add(sid)
        except Exception:
            logger.warning("Nowcast %s: ONS %s unusable", spec.slug, key, exc_info=True)
    store.snapshot(dataset, {sid: x for sid, x in latest.items() if sid not in ons_ok}, release, as_of)

    stored = store.read(dataset)
    stored = stored[(stored["source"] != "ons") | stored["series"].isin(ons_ok)]
    runs = store.runs(dataset)
    obs, info = vt.assemble(list(series), stored, latest, first, release, runs[0] if runs else None)

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

    return Panel(obs=obs, transforms={s["id"]: s["transform"] for s in series}, source="live",
                 missing=missing, calendar=calendar, vintage_info=info)


def load_panel(spec: NowcastSpec, as_of: pd.Timestamp, data_source: str,
               store: vt.VintageStore | None = None, ons_dir: Path | None = None) -> Panel:
    if data_source == "bloomberg":
        try:
            if store is None or ons_dir is None:
                raise RuntimeError("no vintage store")
            return fetch_live_panel(spec, as_of, store, ons_dir)
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


def order_columns(spec: NowcastSpec, cols: list[str]) -> list[str]:
    """Monthly series first, then quarterly ones (DynamicFactorMQ's convention)."""
    series = {s["id"]: s for s in load_catalogue(spec.catalogue)}
    return [c for c in cols if not is_quarterly(series[c])] + [c for c in cols if is_quarterly(series[c])]


def _dfm(spec: NowcastSpec, y: pd.DataFrame, standardize):
    from statsmodels.tsa.statespace.dynamic_factor_mq import DynamicFactorMQ

    series = {s["id"]: s for s in load_catalogue(spec.catalogue)}
    factors = {c: list(series[c]["blocks"]) for c in y.columns}
    n_monthly = sum(not is_quarterly(series[c]) for c in y.columns)
    kw = {"k_endog_monthly": n_monthly} if n_monthly < y.shape[1] else {}
    return DynamicFactorMQ(y, factors=factors, factor_orders=dict(spec.factor_orders),
                           idiosyncratic_ar1=True, standardize=standardize, **kw)


def fit_model(spec: NowcastSpec, y: pd.DataFrame, start: dict | None = None):
    """EM estimate of the DFM on frame y; series with too little data are left out.

    ``start``: a saved state (``model_state``) to start EM from when it has the same series."""
    cols = order_columns(spec, [c for c in y.columns if y[c].notna().sum() >= MIN_OBS])
    if spec.target not in cols:
        raise ValueError(f"target {spec.target!r} has too little data")
    mod = _dfm(spec, y[cols], True)
    start_params = None
    if start and start["columns"] == cols and start["param_names"] == list(mod.param_names):
        start_params = np.asarray(start["params"])
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return mod.fit(start_params=start_params, disp=False, maxiter=spec.maxiter, tolerance=1e-6)


def structure_key(spec: NowcastSpec, cols: list[str]) -> str:
    """Fingerprint of everything that fixes the parameter vector's meaning."""
    series = {s["id"]: s for s in load_catalogue(spec.catalogue)}
    blob = json.dumps({"cols": [(c, series[c]["blocks"], series[c]["transform"]) for c in cols],
                       "factor_orders": spec.factor_orders, "start": spec.start, "exclude": spec.exclude},
                      sort_keys=True)
    return f"{zlib.crc32(blob.encode()):08x}"


def model_state(spec: NowcastSpec, res) -> dict:
    """Fitted parameters plus what is needed to rebuild the model on new data (JSON-safe)."""
    import statsmodels

    model = res.model
    cols = list(model.endog_names)
    retvals = res.mle_retvals if isinstance(res.mle_retvals, dict) else {}
    return {
        "columns": cols,
        "param_names": list(model.param_names),
        "params": [float(v) for v in np.asarray(res.params)],
        "endog_mean": [float(v) for v in np.asarray(model._endog_mean)],
        "endog_std": [float(v) for v in np.asarray(model._endog_std)],
        "structure": structure_key(spec, cols),
        "loglik": float(res.llf),
        "em_iterations": int(retvals.get("iter", 0) or 0),
        "statsmodels": statsmodels.__version__,
    }


def restore_model(spec: NowcastSpec, y: pd.DataFrame, state: dict):
    """Saved parameters applied to frame y (same standardisation as at estimation): no EM."""
    cols = state["columns"]
    std = (pd.Series(state["endog_mean"], index=cols), pd.Series(state["endog_std"], index=cols))
    mod = _dfm(spec, y[cols], std)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return mod.smooth(np.asarray(state["params"]))


def apply_vintage(res, y: pd.DataFrame):
    """Same parameters, new data (pseudo-real-time vintage)."""
    model = res.model
    # apply() rebuilds the model from the frame alone: say again which columns are quarterly
    kw = {"k_endog_monthly": model.k_endog_M} if model.k_endog_M < model.k_endog else {}
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return res.apply(y[list(model.endog_names)], **kw)


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


def quarter_nowcast(res, target: str, q: pd.Period, freq: str = "M") -> tuple[float, float]:
    """Mean and standard deviation of growth in quarter q."""
    months, w = quarter_weights_of(q, freq)
    mean, cov = target_moments(res, target, months)
    return float(w @ mean), float(np.sqrt(max(w @ cov @ w, 0.0)))


def quarter_mean(res, target: str, q: pd.Period, freq: str = "M") -> float:
    """Mean only (cheap; used by the backtest)."""
    months, w = quarter_weights_of(q, freq)
    return float(w @ target_means(res, target, months))


def _to_quarters(w: pd.DataFrame, target: str, quarters: list[pd.Period], freq: str = "M") -> pd.DataFrame:
    """Monthly weights on the target (columns: impact date × impacted variable) → quarterly weights."""
    if w.empty:
        return pd.DataFrame(columns=[str(q) for q in quarters], index=w.index, dtype=float)
    w = w.xs(target, axis=1, level="impacted variable")
    out = {}
    for q in quarters:
        months, wq = quarter_weights_of(q, freq)
        tri = pd.Series(wq, index=months)
        cols = [c for c in w.columns if c in tri.index]
        out[str(q)] = w[cols].to_numpy() @ tri[cols].to_numpy() if cols else np.zeros(len(w))
    return pd.DataFrame(out, index=w.index)


def quarter_weights(news, target: str, quarters: list[pd.Period], freq: str = "M") -> pd.DataFrame:
    """Weight of each updated (period, series) on each quarter's growth: pp per unit of surprise."""
    return _to_quarters(news.weights, target, quarters, freq)


def quarter_impacts(news, target: str, quarters: list[pd.Period], freq: str = "M") -> pd.DataFrame:
    """News impacts on each quarter's growth (weight × news). Rows: (update date, updated variable)."""
    w = quarter_weights(news, target, quarters, freq)
    return w.mul(news.news.reindex(w.index).to_numpy(), axis=0)


def quarter_revision_impacts(news, target: str, quarters: list[pd.Period], freq: str = "M") -> pd.DataFrame:
    """Impacts of the individually tracked revisions (weight × revision). Rows: (period, series)."""
    if news.n_revisions_detailed == 0:
        return pd.DataFrame(columns=[str(q) for q in quarters], dtype=float)
    w = _to_quarters(news.revision_weights, target, quarters, freq)
    return w.mul(news.revisions.reindex(w.index).to_numpy(), axis=0)


def quarter_total_impacts(news, target: str, quarters: list[pd.Period], freq: str = "M") -> dict[str, float]:
    """Total change in each quarter's growth between the two vintages (news + revisions)."""
    tot = news.total_impacts[target]
    out = {}
    for q in quarters:
        months, wq = quarter_weights_of(q, freq)
        tri = pd.Series(wq, index=months)
        out[str(q)] = float(tot.reindex(tri.index).fillna(0.0).to_numpy() @ tri.to_numpy())
    return out


def compute_news(res_new, res_prev, target: str, start: pd.Period, end: pd.Period,
                 details_from: pd.Period | None = None):
    """News between two vintages. Revisions to periods from ``details_from`` on get their own
    weights; earlier ones are only reported as a group (they are rare and slow to decompose)."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return res_new.news(res_prev, start=start, end=end, impacted_variable=target,
                            comparison_type="previous",
                            revisions_details_start=details_from if details_from is not None else False)


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
        y = quarter_value(g, q, spec.target_freq)
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
