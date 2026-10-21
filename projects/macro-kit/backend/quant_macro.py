"""
Quant Macro: nowcasts and forecasts of growth, inflation and labour-market
variables per G10 market, built to track the next prints and the central
bank's own staff estimates. One ``NowcastSpec`` per model in ``MODELS``;
the maths lives in ``nowcast.py``, the real-time data in ``vintages.py``.

Nothing heavy runs on a page load. State lives under var/quant_macro/:

  vintages.db                every value with the day it became public (all models)
  sources/ons/<dataset>/     ONS revisions triangles as downloaded
  <slug>/model.json          last fit: parameters, standardisation, bridge, fit date
  <slug>/nowcast.json        last payload of GET /api/tools/quant-macro/{slug}
  <slug>/backtests/          one file per backtest run, latest.json, fits/<quarter>.json

Jobs (background threads, one per kind per model; status at .../{slug}/status):
  update    new data with the saved parameters (on a new day, or hourly with live data)
  refit     re-estimate the parameters on today's data, then update   (Refit button)
  backtest  real-time backtest, re-estimating each quarter             (Run full backtest)
The only automatic fit is when no saved model fits today's data (first run, a
change of data source or of the series list).
"""
from __future__ import annotations

import dataclasses
import json
import logging
import math
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

import nowcast as nc
import vintages as vt
from runtime_paths import state_path
from settings import settings

logger = logging.getLogger(__name__)

MODELS: dict[str, nc.NowcastSpec] = {
    "uk-gdp": nc.NowcastSpec(
        slug="uk-gdp",
        title="UK GDP Nowcast",
        country="GB",
        target="gdp",
        target_label="GDP",
        catalogue="series_catalogue_nowcast_uk.json",
        quarterly_ticker="UKGRABIQ Index",
        central_bank_file="central_bank_nowcasts_uk.json",
        bridge_series="pmi_comp",
    ),
}

Z68, Z90 = 0.9945, 1.6449
LIVE_REFRESH_MINUTES = 60        # with live data, re-read Bloomberg at most this often
BACKTESTS_KEPT = 10

ROOT: Path | None = None         # tests point this at a temporary directory


def _today() -> pd.Timestamp:
    return pd.Timestamp.today().normalize()


def _now() -> str:
    return pd.Timestamp.now().isoformat(timespec="seconds")


def _r(x, d: int = 4):
    return None if x is None or (isinstance(x, float) and not math.isfinite(x)) else round(float(x), d)


def _iso(ts) -> str | None:
    return None if ts is None or pd.isna(ts) else pd.Timestamp(ts).strftime("%Y-%m-%d")


# ---------------------------------------------------------------------------
# Files
# ---------------------------------------------------------------------------

def _root() -> Path:
    root = ROOT if ROOT is not None else state_path("quant_macro")
    root.mkdir(parents=True, exist_ok=True)
    return root


def _dir(slug: str, *parts: str) -> Path:
    d = _root().joinpath(slug, *parts)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _read(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except Exception:
        logger.warning("Quant Macro: unreadable %s", path, exc_info=True)
        return None


def _write(path: Path, obj: dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)


_stores: dict[Path, vt.VintageStore] = {}


def _store() -> vt.VintageStore:
    path = _root() / "vintages.db"
    if path not in _stores:
        _stores[path] = vt.VintageStore(path)
    return _stores[path]


def load_panel(spec: nc.NowcastSpec, as_of: pd.Timestamp, data_source: str) -> nc.Panel:
    return nc.load_panel(spec, as_of, data_source, _store(), _root() / "sources" / "ons")


# ---------------------------------------------------------------------------
# Fitted model on one day's data
# ---------------------------------------------------------------------------

@dataclass
class Fitted:
    spec: nc.NowcastSpec
    panel: nc.Panel
    as_of: pd.Timestamp
    index: pd.PeriodIndex
    res: object
    cols: list[str]
    bridge: nc.Bridge | None
    state: dict = field(default_factory=dict)     # saved model (model.json)

    @property
    def series(self) -> dict[str, dict]:
        return {s["id"]: s for s in nc.load_catalogue(self.spec.catalogue)}

    def frame(self, d: pd.Timestamp) -> pd.DataFrame:
        return nc.model_data(self.spec, self.panel.vintage(d)).reindex(self.index)[self.cols]

    def at(self, d: pd.Timestamp):
        return nc.apply_vintage(self.res, self.frame(d))

    def release_date(self, sid: str, period: pd.Period) -> pd.Timestamp:
        """Known release date of an observation, else Bloomberg's next date, else the typical lag."""
        rel = self.panel.release[sid].get(period) if sid in self.panel.release else None
        if rel is not None and not pd.isna(rel):
            return pd.Timestamp(rel)
        cal = self.panel.calendar.get(sid, {}).get("release")
        if cal is not None and not pd.isna(cal) and cal >= self.as_of:
            return pd.Timestamp(cal)
        lag = self.series[sid]["release_lag_days"]
        return nc.typical_release(pd.PeriodIndex([period]), lag)[0]


def _frame(spec: nc.NowcastSpec, panel: nc.Panel, as_of: pd.Timestamp) -> tuple[pd.PeriodIndex, pd.DataFrame]:
    index = pd.period_range(spec.start, nc.horizon_end(as_of), freq="M")
    return index, nc.model_data(spec, panel.vintage(as_of)).reindex(index)


def fit(spec: nc.NowcastSpec, as_of: pd.Timestamp, data_source: str, panel: nc.Panel | None = None,
        start: dict | None = None) -> Fitted:
    """Estimate the parameters on as_of's data (EM from ``start``'s parameters when compatible)."""
    panel = panel or load_panel(spec, as_of, data_source)
    index, y = _frame(spec, panel, as_of)
    res = nc.fit_model(spec, y, start)
    bridge = nc.fit_bridge(spec, panel.vintage(as_of))
    state = {**nc.model_state(spec, res), "fitted_at": _now(), "data_as_of": _iso(as_of), "source": panel.source,
             "bridge": dataclasses.asdict(bridge) if bridge else None}
    return Fitted(spec, panel, as_of, index, res, list(res.model.endog_names), bridge, state)


def restore(spec: nc.NowcastSpec, state: dict, as_of: pd.Timestamp, panel: nc.Panel) -> Fitted | None:
    """Saved parameters on as_of's data; None if they no longer fit it (source or series changed)."""
    cols = state.get("columns", [])
    if (state.get("source") != panel.source or not set(cols) <= set(panel.ids)
            or state.get("structure") != nc.structure_key(spec, cols)):
        return None
    index, y = _frame(spec, panel, as_of)
    res = nc.restore_model(spec, y, state)
    bridge = nc.Bridge(**state["bridge"]) if state.get("bridge") else None
    return Fitted(spec, panel, as_of, index, res, cols, bridge, state)


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------

@dataclass
class Job:
    kind: str
    state: str = "idle"                # idle | running | done | error
    step: str | None = None
    progress: int = 0
    total: int = 0
    started_at: str | None = None
    finished_at: str | None = None
    error: str | None = None


_jobs: dict[tuple[str, str], Job] = {}
_jobs_lock = threading.Lock()
_model_locks: dict[str, threading.Lock] = {}
_payloads: dict[str, dict] = {}


def _job(slug: str, kind: str) -> Job:
    with _jobs_lock:
        return _jobs.setdefault((slug, kind), Job(kind))


def _model_lock(slug: str) -> threading.Lock:
    with _jobs_lock:
        return _model_locks.setdefault(slug, threading.Lock())


def _start(slug: str, kind: str, work) -> Job:
    """Run work(job) in a background thread unless that job is already running."""
    with _jobs_lock:
        job = _jobs.get((slug, kind))
        if job and job.state == "running":
            return job
        job = _jobs[(slug, kind)] = Job(kind, state="running", started_at=_now(), step="Queued")

    def run() -> None:
        try:
            work(job)
            job.state = "done"
        except Exception as exc:
            logger.exception("Quant Macro %s %s failed", slug, kind)
            job.state, job.error = "error", f"{type(exc).__name__}: {exc}"
        finally:
            job.finished_at = _now()

    threading.Thread(target=run, name=f"quant-macro-{slug}-{kind}", daemon=True).start()
    return job


def _update(slug: str, job: Job | None, refit: bool = False) -> dict:
    """Today's data → (re-estimate if asked or needed) → payload, saved to disk."""
    spec = MODELS[slug]

    def step(text: str) -> None:
        if job:
            job.step = text

    with _model_lock(slug):
        as_of = _today()
        step("Loading data")
        panel = load_panel(spec, as_of, settings.data_source)
        saved = _read(_dir(slug) / "model.json")
        m = None if refit or saved is None else restore(spec, saved, as_of, panel)
        if m is None:
            step("Estimating the model")
            start = saved if saved and saved.get("source") == panel.source else None
            m = fit(spec, as_of, settings.data_source, panel=panel, start=start)
            _write(_dir(slug) / "model.json", m.state)
        step("Computing the nowcast")
        payload = build_payload(m)
        _write(_dir(slug) / "nowcast.json", payload)
        _payloads[slug] = payload
        return payload


def _stale(payload: dict) -> bool:
    if payload.get("as_of") != _iso(_today()):
        return True
    if settings.data_source == "bloomberg":
        age = pd.Timestamp.now() - pd.Timestamp(payload.get("computed_at") or "1970-01-01")
        return age > pd.Timedelta(minutes=LIVE_REFRESH_MINUTES)
    return False


def get_nowcast(slug: str) -> dict:
    """Saved payload; refreshed in the background when stale, computed here only on first use."""
    payload = _payloads.get(slug) or _read(_dir(slug) / "nowcast.json")
    if payload is None:
        with _model_lock(slug):                  # another request may be computing it already
            payload = _payloads.get(slug)
        if payload is None:
            return _update(slug, _job(slug, "update"))
    _payloads[slug] = payload
    if _stale(payload) and _job(slug, "refit").state != "running":
        _start(slug, "update", lambda job: _update(slug, job))
    return payload


def start_refit(slug: str) -> dict:
    _start(slug, "refit", lambda job: _update(slug, job, refit=True))
    return get_status(slug)


def get_backtest(slug: str) -> dict | None:
    return _read(_dir(slug, "backtests") / "latest.json")


def start_backtest(slug: str) -> dict:
    _start(slug, "backtest", lambda job: _run_backtest(slug, job))
    return get_status(slug)


def get_status(slug: str) -> dict:
    model = _read(_dir(slug) / "model.json") or {}
    payload = _payloads.get(slug) or _read(_dir(slug) / "nowcast.json") or {}
    bt = get_backtest(slug) or {}
    return {
        "slug": slug,
        "model_fitted_at": model.get("fitted_at"),
        "model_data_as_of": model.get("data_as_of"),
        "nowcast_as_of": payload.get("as_of"),
        "nowcast_computed_at": payload.get("computed_at"),
        "backtest_run_at": bt.get("run_at"),
        "jobs": {k: dataclasses.asdict(_job(slug, k)) for k in ("update", "refit", "backtest")},
    }


def list_models() -> list[dict]:
    return [{"slug": s.slug, "title": s.title, "country": s.country, "target_label": s.target_label}
            for s in MODELS.values()]


def warm_cache() -> None:
    """Startup: make sure each model has a nowcast (no refit, no backtest unless there is no saved fit)."""
    for slug in MODELS:
        get_nowcast(slug)


# ---------------------------------------------------------------------------
# Payload
# ---------------------------------------------------------------------------

def _last_released_quarter(g: pd.Series) -> pd.Period:
    last = g.last_valid_index()
    q = last.asfreq("Q")
    return q if last == q.asfreq("M", "end") else q - 1


def _status(q: pd.Period, q_now: pd.Period, released: bool) -> str:
    if released:
        return "released"
    return "backcast" if q < q_now else "nowcast" if q == q_now else "forecast"


def _band(mean: float, sd: float) -> dict:
    return {"lo68": _r(mean - Z68 * sd), "hi68": _r(mean + Z68 * sd),
            "lo90": _r(mean - Z90 * sd), "hi90": _r(mean + Z90 * sd)}


OLDER_REVISIONS = "older_revisions"


def _evolution(m: Fitted, quarters: list[pd.Period]) -> list[dict]:
    """Nowcast of each unreleased quarter after every release or revision since the first one began.

    Each step's change splits exactly into new releases (weight × surprise), tracked revisions
    (weight × revision) and, if any, revisions to older periods reported as one item."""
    target = m.spec.target
    series = m.series
    start = quarters[0].start_time.normalize()
    m0, m1 = nc.quarter_months(quarters[0])[0], m.index[-1]
    details_from = m0 - 24
    dates = m.panel.change_dates(m.cols, start, m.as_of)

    def snapshot(r, d, releases):
        out = {"date": _iso(d), "nowcasts": {}, "sds": {}, "by_group": {}, "releases": releases}
        for q in quarters:
            mean, sd = nc.quarter_nowcast(r, target, q)
            out["nowcasts"][str(q)] = _r(mean)
            out["sds"][str(q)] = _r(sd)
        return out

    prev = m.at(start - pd.Timedelta(days=1))
    steps = [snapshot(prev, start - pd.Timedelta(days=1), [])]
    for d in dates:
        cur = m.at(d)
        news = nc.compute_news(cur, prev, target, m0, m1, details_from)
        total = nc.quarter_total_impacts(news, target, quarters)
        releases = []
        for (period, sid), row in nc.quarter_impacts(news, target, quarters).iterrows():
            releases.append({
                "series_id": sid, "kind": "release", "period": str(period),
                "observed": _r(news.update_realized.get((period, sid))),
                "expected": _r(news.update_forecasts.get((period, sid))),
                "news": _r(news.news.get((period, sid))),
                "impacts": {q: _r(v, 5) for q, v in row.items()},
            })
        for (period, sid), row in nc.quarter_revision_impacts(news, target, quarters).iterrows():
            releases.append({
                "series_id": sid, "kind": "revision", "period": str(period),
                "observed": _r(news.revised.get((period, sid))),
                "expected": _r(news.revised_prev.get((period, sid))),
                "news": _r(news.revisions.get((period, sid))),
                "impacts": {q: _r(v, 5) for q, v in row.items()},
            })
        rest = {q: total[q] - sum(r["impacts"][q] or 0.0 for r in releases) for q in total}
        if news.n_revisions_grouped and any(abs(v) > 1e-6 for v in rest.values()):
            releases.append({"series_id": OLDER_REVISIONS, "kind": "revision", "period": str(details_from - 1),
                             "observed": None, "expected": None, "news": None,
                             "impacts": {q: _r(v, 5) for q, v in rest.items()}})
        step = snapshot(cur, d, releases)
        for q in quarters:
            by: dict[str, float] = {}
            for rel_ in releases:
                grp = series[rel_["series_id"]]["group"] if rel_["series_id"] in series else "Older revisions"
                by[grp] = by.get(grp, 0.0) + (rel_["impacts"][str(q)] or 0.0)
            step["by_group"][str(q)] = {k: _r(v, 5) for k, v in by.items()}
        steps.append(step)
        prev = cur
    return steps


def _one_step_sd(m: Fitted) -> dict[str, float]:
    """Typical surprise: sd of one-step-ahead prediction errors since 2010 (excluded window dropped)."""
    y = m.res.model.data.orig_endog
    pred = m.res.get_prediction(start=0, end=len(m.index) - 1).predicted_mean
    err = (y - pred).loc[pd.Period("2010-01", "M"):]
    return {c: float(err[c].std()) for c in m.cols if err[c].notna().sum() > 12}


def _catalysts(m: Fitted, quarters: list[pd.Period]) -> dict[str, dict]:
    """Next release of every series: model expectation and its weight on each quarter's nowcast.

    Releases are walked in date order with each earlier one filled at its model expectation,
    so each weight is the impact of a surprise given everything due before it came in line."""
    target = m.spec.target
    vint = m.frame(m.as_of)
    nxt = {c: vint[c].last_valid_index() + 1 for c in m.cols if vint[c].last_valid_index() is not None}
    nxt = {c: p for c, p in nxt.items() if p <= m.index[-1]}
    if not nxt:
        return {}
    pred = m.res.get_prediction(start=min(nxt.values()), end=max(nxt.values()), information_set="smoothed")
    mean, se = pred.predicted_mean, pred.se_mean
    typical = _one_step_sd(m)

    rows = {}
    for c, p in nxt.items():
        rows[c] = {"period": p, "date": m.release_date(c, p), "expected": float(mean.loc[p, c]),
                   "sd": float(se.loc[p, c])}
    order = sorted(rows, key=lambda c: (rows[c]["date"], c))
    m0, m1 = nc.quarter_months(quarters[0])[0], m.index[-1]
    frame, prev = vint.copy(), m.res
    for date in sorted({rows[c]["date"] for c in order}):
        batch = [c for c in order if rows[c]["date"] == date]
        for c in batch:
            frame.loc[rows[c]["period"], c] = rows[c]["expected"]
        cur = nc.apply_vintage(m.res, frame)
        w = nc.quarter_weights(nc.compute_news(cur, prev, target, m0, m1), target, quarters)
        for c in batch:
            key = (rows[c]["period"], c)
            rows[c]["weights"] = {str(q): float(w.loc[key, str(q)]) if key in w.index else 0.0 for q in quarters}
            rows[c]["typical_surprise"] = typical.get(c)
        prev = cur
    return rows


def build_payload(m: Fitted) -> dict:
    spec, panel, as_of, res = m.spec, m.panel, m.as_of, m.res
    target = spec.target
    series = m.series
    vint = panel.vintage(as_of)
    g = vint[target]
    q_now = pd.Period(as_of, "Q")
    lq = _last_released_quarter(g)
    released = list(pd.period_range(lq - 3, lq, freq="Q"))
    unreleased = list(pd.period_range(lq + 1, q_now + 1, freq="Q"))

    path_start = min(pd.Period(as_of, "M") - 24, nc.quarter_months(released[0])[0])
    months = pd.period_range(path_start, m.index[-1], freq="M")
    mu, cov = nc.target_moments(res, target, months)
    pos = {p: i for i, p in enumerate(months)}

    def q_moments(q: pd.Period) -> tuple[float, float]:
        ix = [pos[p] for p in nc.quarter_months(q)]
        return float(nc.TRIANGLE @ mu[ix]), float(np.sqrt(max(nc.TRIANGLE @ cov[np.ix_(ix, ix)] @ nc.TRIANGLE, 0)))

    q_cons = panel.calendar.get("_quarterly", {}).get("consensus")
    quarter_rows = []
    for q in released + unreleased:
        is_rel = q in released
        mean, sd = q_moments(q)
        qm = pd.period_range(q.asfreq("M", "start"), q.asfreq("M", "end"), freq="M")
        quarter_rows.append({
            "quarter": str(q),
            "status": _status(q, q_now, is_rel),
            "actual": _r(nc.triangle_qoq(g, q)) if is_rel else None,
            "nowcast": None if is_rel else _r(mean),
            "sd": None if is_rel else _r(sd),
            **({k: None for k in ("lo68", "hi68", "lo90", "hi90")} if is_rel else _band(mean, sd)),
            "bridge": None if is_rel or m.bridge is None else _r(m.bridge.predict(vint, q)),
            "consensus": _r(q_cons) if (not is_rel and q == unreleased[0]) else None,
            "release_date": _iso(m.release_date(target, q.asfreq("M", "end"))),
            "months_observed": int(g.reindex(qm).notna().sum()),
            "months": [{
                "month": str(p),
                "actual": _r(g.get(p)) if not pd.isna(g.get(p, np.nan)) else None,
                "model": _r(mu[pos[p]]),
                "sd": _r(np.sqrt(max(cov[pos[p], pos[p]], 0))),
            } for p in qm],
        })

    monthly_path = []
    for p in months[months >= pd.Period(as_of, "M") - 24]:
        sd = float(np.sqrt(max(cov[pos[p], pos[p]], 0)))
        actual = g.get(p, np.nan)
        monthly_path.append({"month": str(p), "actual": None if pd.isna(actual) else _r(actual),
                             "model": _r(mu[pos[p]]), **_band(float(mu[pos[p]]), sd)})

    p_next = g.last_valid_index() + 1
    nm, ns = float(mu[pos[p_next]]), float(np.sqrt(max(cov[pos[p_next], pos[p_next]], 0)))
    q_of_next = p_next.asfreq("Q")
    next_q = None
    if p_next == q_of_next.asfreq("M", "end"):
        qm_, qs_ = q_moments(q_of_next)
        next_q = {"quarter": str(q_of_next), "model": _r(qm_), "sd": _r(qs_), **_band(qm_, qs_), "consensus": _r(q_cons)}
    next_print = {
        "series_id": target, "label": f"{spec.target_label} {p_next.strftime('%b %Y')} (m/m)",
        "period": str(p_next), "release_date": _iso(m.release_date(target, p_next)),
        "model": _r(nm), "sd": _r(ns), **_band(nm, ns),
        "consensus": _r(panel.calendar.get(target, {}).get("consensus")),
        "quarter": next_q,
    }

    evolution = _evolution(m, unreleased)
    catalysts = _catalysts(m, unreleased)

    last_news: dict[str, dict] = {}
    for step in evolution:
        for rel in step["releases"]:
            if rel["kind"] == "release":
                last_news[rel["series_id"]] = {**rel, "date": step["date"]}

    params = res.params
    indicators = []
    for c in m.cols:
        s = series[c]
        col = vint[c]
        lp = col.last_valid_index()
        cat = catalysts.get(c)
        ln = last_news.get(c)
        typical = cat.get("typical_surprise") if cat else None
        indicators.append({
            "id": c, "name": s["name"], "short": s["short"], "group": s["group"], "units": s["units"],
            "ticker": s["ticker_bloomberg"], "transform": s["transform"],
            "vintages": panel.vintage_info.get(c, ""),
            "global_loading": _r(params.get(f"loading.Global->{c}")),
            "last_period": str(lp) if lp is not None else None,
            "last_value": _r(col.get(lp)) if lp is not None else None,
            "last_release": _iso(panel.release[c].get(lp)) if lp is not None else None,
            "last_expected": ln["expected"] if ln and ln["period"] == str(lp) else None,
            "last_news": ln["news"] if ln and ln["period"] == str(lp) else None,
            "last_impacts": ln["impacts"] if ln and ln["period"] == str(lp) else {},
            "next_period": str(cat["period"]) if cat else None,
            "next_release": _iso(cat["date"]) if cat else None,
            "next_expected": _r(cat["expected"]) if cat else None,
            "next_sd": _r(cat["sd"]) if cat else None,
            "consensus": _r(panel.calendar.get(c, {}).get("consensus")),
            "weights": {q: _r(v, 5) for q, v in cat.get("weights", {}).items()} if cat else {},
            "typical_surprise": _r(typical),
            "typical_impacts": ({q: _r(abs(v) * typical, 5) for q, v in cat.get("weights", {}).items()}
                                if cat and typical else {}),
        })

    st = m.state
    return {
        "slug": spec.slug,
        "title": spec.title,
        "country": spec.country,
        "target_label": spec.target_label,
        "as_of": _iso(as_of),
        "computed_at": _now(),
        "data_source": panel.source,
        "missing_series": panel.missing,
        "model": {
            "name": "Mixed-frequency dynamic factor model (Bańbura–Modugno EM)",
            "n_series": len(m.cols),
            "blocks": sorted({b for c in m.cols for b in series[c]["blocks"]}, key=lambda b: (b != "Global", b)),
            "factor_orders": dict(spec.factor_orders),
            "sample_start": spec.start,
            "last_data": str(max(vint[c].last_valid_index() for c in m.cols if vint[c].last_valid_index() is not None)),
            "excluded": [f"{a} to {b}" for a, b in spec.exclude],
            "loglik": _r(st.get("loglik"), 2),
            "em_iterations": int(st.get("em_iterations", 0)),
            "fitted_at": st.get("fitted_at"),
            "fit_data_as_of": st.get("data_as_of"),
        },
        "bridge": None if m.bridge is None else {
            "series_id": m.bridge.series, "alpha": _r(m.bridge.alpha), "beta": _r(m.bridge.beta),
            "r2": _r(m.bridge.r2), "resid_sd": _r(m.bridge.resid_sd), "n": m.bridge.n,
        },
        "quarters": quarter_rows,
        "monthly_path": monthly_path,
        "next_print": next_print,
        "evolution": evolution,
        "indicators": indicators,
        "central_bank": _central_bank(m, g, unreleased, evolution, quarter_rows),
    }


def _central_bank(m: Fitted, g: pd.Series, unreleased: list[pd.Period], evolution: list[dict],
                  quarter_rows: list[dict]) -> dict | None:
    if not m.spec.central_bank_file:
        return None
    data = json.loads((nc.DATA_DIR / m.spec.central_bank_file).read_text(encoding="utf-8"))
    now = {r["quarter"]: r["nowcast"] for r in quarter_rows}

    def model_on(day: str, quarter: str) -> float | None:
        steps = [s for s in evolution if s["date"] <= day and quarter in s["nowcasts"]]
        return steps[-1]["nowcasts"][quarter] if steps and steps[0]["date"] <= day else None

    estimates = []
    for e in sorted(data["estimates"], key=lambda e: (e["published"], e["quarter"])):
        q = pd.Period(e["quarter"], "Q")
        estimates.append({**e, "actual": _r(nc.triangle_qoq(g, q))})
    comparisons = []
    for q in unreleased:
        mine = [e for e in estimates if e["quarter"] == str(q)]
        if not mine:
            continue
        latest = mine[-1]
        at_pub = model_on(latest["published"], str(q))
        model_now = now.get(str(q))
        comparisons.append({
            "quarter": str(q), "cb_value": latest["value"], "cb_published": latest["published"],
            "cb_source": latest["source"], "model_now": model_now, "model_at_publication": at_pub,
            "news_since": _r(model_now - at_pub) if model_now is not None and at_pub is not None else None,
            "gap": _r(model_now - latest["value"]) if model_now is not None else None,
        })
    return {"institution": data["institution"], "label": data["label"], "estimates": estimates,
            "comparisons": comparisons}


# ---------------------------------------------------------------------------
# Real-time backtest
# ---------------------------------------------------------------------------

def build_backtest(spec: nc.NowcastSpec, panel: nc.Panel, as_of: pd.Timestamp, progress=None,
                   fits_dir: Path | None = None) -> dict:
    """Nowcast errors at fixed days before each first estimate, as they would have been made.

    Every origin uses only the data public that day (first prints and revisions as published),
    and parameters re-estimated on the first day of its calendar quarter with the data public
    then. Scored against the first estimate (the print markets trade) and today's value."""
    target = spec.target
    t0 = time.monotonic()
    g_now = panel.vintage(as_of)[target]
    lq = _last_released_quarter(g_now)
    rel = panel.release[target]

    quarters, origins = [], {}
    for q in pd.period_range(pd.Period(spec.backtest_from, "Q"), lq, freq="Q"):
        r = rel.get(q.asfreq("M", "end"))
        if nc._touches_exclusion(spec, q) or r is None or pd.isna(r):
            continue
        quarters.append(q)
        origins[q] = [pd.Timestamp(r) + pd.Timedelta(days=h) for h in spec.horizons]
    fit_quarters = sorted({pd.Period(d, "Q") for ds in origins.values() for d in ds})

    fits: dict[pd.Period, tuple] = {}
    prev_state = None
    for i, c in enumerate(fit_quarters):
        if progress:
            progress(i, len(fit_quarters), f"Re-estimating on data public on {c.start_time:%d %b %Y}")
        day = c.start_time.normalize()
        vint = panel.vintage(day)
        index, y = _frame(spec, panel, day)
        res = nc.fit_model(spec, y, prev_state)
        prev_state = nc.model_state(spec, res)
        bridge = nc.fit_bridge(spec, vint)
        fits[c] = (index, res, bridge)
        if fits_dir is not None:
            _write(fits_dir / f"{c}.json", {**prev_state, "data_as_of": _iso(day),
                                            "bridge": dataclasses.asdict(bridge) if bridge else None})
    if progress:
        progress(len(fit_quarters), len(fit_quarters), "Scoring")

    rows = []
    for q in quarters:
        r = pd.Timestamp(rel[q.asfreq("M", "end")])
        first = nc.triangle_qoq(panel.vintage(r)[target], q)
        latest = nc.triangle_qoq(g_now, q)
        dfm, bridge, naive = [], [], []
        for d in origins[q]:
            index, res, br = fits[pd.Period(d, "Q")]
            vint = panel.vintage(d)
            frame = nc.model_data(spec, vint).reindex(index)[list(res.model.endog_names)]
            out = nc.apply_vintage(res, frame)
            dfm.append(_r(float(nc.TRIANGLE @ nc.target_means(out, target, nc.quarter_months(q)))))
            bridge.append(_r(br.predict(vint, q)) if br else None)
            gd = vint[target]
            naive.append(_r(nc.triangle_qoq(gd, _last_released_quarter(gd))))
        rows.append({"quarter": str(q), "release_date": _iso(r), "actual": _r(first), "actual_latest": _r(latest),
                     "dfm": dfm, "bridge": bridge, "naive": naive})

    def stats(model: str, k: int) -> dict:
        pairs = [(r_[model][k], r_["actual"], r_["actual_latest"]) for r_ in rows if r_[model][k] is not None]
        e = np.array([p - a for p, a, _ in pairs if a is not None])
        el = np.array([p - a for p, _, a in pairs if a is not None])
        return {"rmse": _r(np.sqrt(np.mean(e ** 2))) if e.size else None,
                "bias": _r(e.mean()) if e.size else None, "n": int(e.size),
                "rmse_latest": _r(np.sqrt(np.mean(el ** 2))) if el.size else None}

    summary = [{"horizon": h, **{mdl: stats(mdl, k) for mdl in ("dfm", "bridge", "naive")}}
               for k, h in enumerate(spec.horizons)]
    revised = [r_ for r_ in rows if r_["actual"] is not None and r_["actual_latest"] is not None]
    rev_sd = (float(np.sqrt(np.mean([(r_["actual_latest"] - r_["actual"]) ** 2 for r_ in revised])))
              if revised else None)
    return {
        "slug": spec.slug, "as_of": _iso(as_of), "run_at": _now(), "duration_s": round(time.monotonic() - t0, 1),
        "data_source": panel.source, "horizons": list(spec.horizons), "n_fits": len(fit_quarters),
        "first_estimate_revision_rmse": _r(rev_sd),
        "rows": rows, "summary": summary,
        "note": ("Real time: each nowcast uses only the data public that day, first prints and revisions as "
                 "published, and parameters re-estimated at the start of each quarter on the data public then. "
                 "Errors are against the first estimate; 'vs latest' uses today's value. COVID-affected "
                 "quarters excluded."),
    }


def _run_backtest(slug: str, job: Job) -> dict:
    spec = MODELS[slug]
    as_of = _today()
    job.step = "Loading data"
    panel = load_panel(spec, as_of, settings.data_source)
    folder = _dir(slug, "backtests")

    def progress(i: int, n: int, text: str) -> None:
        job.progress, job.total, job.step = i, n, text

    bt = build_backtest(spec, panel, as_of, progress, fits_dir=_dir(slug, "backtests", "fits"))
    _write(folder / f"{pd.Timestamp.now():%Y-%m-%dT%H%M%S}.json", bt)
    _write(folder / "latest.json", bt)
    runs = sorted(p for p in folder.glob("20*.json"))
    for old in runs[:-BACKTESTS_KEPT]:
        old.unlink(missing_ok=True)
    return bt
