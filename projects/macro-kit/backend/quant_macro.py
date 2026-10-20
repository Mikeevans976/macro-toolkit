"""
Quant Macro: nowcasts and forecasts of growth, inflation and labour-market
variables per G10 market, built to track the next prints and the central
bank's own staff estimates. One ``NowcastSpec`` per model in ``MODELS``;
the maths lives in ``nowcast.py``.

Payload of GET /api/tools/quant-macro/{model} (schemas/quant_macro.py):
quarters (released / backcast / nowcast / forecast), the monthly path, the
next print, the nowcast's evolution through the quarter with the news of each
release, every indicator's last surprise and next release (with its weight on
the nowcast), and the comparison with the central bank's published estimates.
The pseudo-real-time backtest is a separate, slower endpoint.
"""
from __future__ import annotations

import json
import logging
import math
import threading
from dataclasses import dataclass

import numpy as np
import pandas as pd

import nowcast as nc
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


def _today() -> pd.Timestamp:
    return pd.Timestamp.today().normalize()


def _r(x, d: int = 4):
    return None if x is None or (isinstance(x, float) and not math.isfinite(x)) else round(float(x), d)


def _iso(ts) -> str | None:
    return None if ts is None or pd.isna(ts) else pd.Timestamp(ts).strftime("%Y-%m-%d")


# ---------------------------------------------------------------------------
# Fitted model for one day's data (cached)
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


def fit(spec: nc.NowcastSpec, as_of: pd.Timestamp, data_source: str) -> Fitted:
    panel = nc.load_panel(spec, as_of, data_source)
    index = pd.period_range(spec.start, nc.horizon_end(as_of), freq="M")
    y = nc.model_data(spec, panel.vintage(as_of)).reindex(index)
    res = nc.fit_model(spec, y)
    cols = list(res.model.endog_names)
    return Fitted(spec, panel, as_of, index, res, cols, nc.fit_bridge(spec, panel.vintage(as_of)))


_cache: dict[tuple, object] = {}
_locks: dict[tuple, threading.Lock] = {}
_locks_guard = threading.Lock()


def _cached(key: tuple, build):
    with _locks_guard:
        lock = _locks.setdefault(key, threading.Lock())
    with lock:
        if key not in _cache:
            _cache[key] = build()
        return _cache[key]


def _fitted(slug: str) -> Fitted:
    as_of = _today()
    key = ("fit", slug, as_of, settings.data_source)
    return _cached(key, lambda: fit(MODELS[slug], as_of, settings.data_source))


def get_nowcast(slug: str) -> dict:
    m = _fitted(slug)
    return _cached(("payload", slug, m.as_of, settings.data_source), lambda: build_payload(m))


def get_backtest(slug: str) -> dict:
    m = _fitted(slug)
    return _cached(("backtest", slug, m.as_of, settings.data_source), lambda: build_backtest(m))


def list_models() -> list[dict]:
    return [{"slug": s.slug, "title": s.title, "country": s.country, "target_label": s.target_label}
            for s in MODELS.values()]


def warm_cache() -> None:
    for slug in MODELS:
        get_nowcast(slug)
        get_backtest(slug)


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


def _evolution(m: Fitted, quarters: list[pd.Period]) -> list[dict]:
    """Nowcast of each unreleased quarter after every release since the first one began."""
    target = m.spec.target
    series = m.series
    start = quarters[0].start_time.normalize()
    m0, m1 = nc.quarter_months(quarters[0])[0], m.index[-1]
    rel = m.panel.release[m.cols]
    dates = sorted({pd.Timestamp(d) for d in rel.stack().unique() if start <= d <= m.as_of})

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
        news = nc.compute_news(cur, prev, target, m0, m1)
        impacts = nc.quarter_impacts(news, target, quarters)
        releases = []
        for (period, sid), row in impacts.iterrows():
            releases.append({
                "series_id": sid,
                "period": str(period),
                "observed": _r(news.update_realized.get((period, sid))),
                "expected": _r(news.update_forecasts.get((period, sid))),
                "news": _r(news.news.get((period, sid))),
                "impacts": {q: _r(v, 5) for q, v in row.items()},
            })
        step = snapshot(cur, d, releases)
        for q in quarters:
            by: dict[str, float] = {}
            for rel_ in releases:
                grp = series[rel_["series_id"]]["group"]
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

    return {
        "slug": spec.slug,
        "title": spec.title,
        "country": spec.country,
        "target_label": spec.target_label,
        "as_of": _iso(as_of),
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
            "loglik": _r(res.llf, 2),
            "em_iterations": int((res.mle_retvals or {}).get("iter", 0)) if isinstance(res.mle_retvals, dict) else 0,
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
# Backtest
# ---------------------------------------------------------------------------

def build_backtest(m: Fitted) -> dict:
    """Pseudo-real-time nowcast errors at fixed days before each first estimate."""
    spec, target = m.spec, m.spec.target
    g_now = m.panel.vintage(m.as_of)[target]
    lq = _last_released_quarter(g_now)
    rows = []
    for q in pd.period_range(pd.Period(spec.backtest_from, "Q"), lq, freq="Q"):
        if nc._touches_exclusion(spec, q):
            continue
        rel = m.panel.release[target].get(q.asfreq("M", "end"))
        actual = nc.triangle_qoq(g_now, q)
        if rel is None or pd.isna(rel) or actual is None:
            continue
        dfm, bridge, naive = [], [], []
        for h in spec.horizons:
            d = pd.Timestamp(rel) + pd.Timedelta(days=h)
            r = m.at(d)
            dfm.append(_r(float(nc.TRIANGLE @ nc.target_means(r, target, nc.quarter_months(q)))))
            vint = m.panel.vintage(d)
            bridge.append(_r(m.bridge.predict(vint, q)) if m.bridge else None)
            gd = vint[target]
            naive.append(_r(nc.triangle_qoq(gd, _last_released_quarter(gd))))
        rows.append({"quarter": str(q), "release_date": _iso(rel), "actual": _r(actual),
                     "dfm": dfm, "bridge": bridge, "naive": naive})

    def stats(model: str, k: int) -> dict:
        e = np.array([r[model][k] - r["actual"] for r in rows if r[model][k] is not None])
        return {"rmse": _r(np.sqrt(np.mean(e ** 2))) if e.size else None,
                "bias": _r(e.mean()) if e.size else None, "n": int(e.size)}

    summary = [{"horizon": h, **{mdl: stats(mdl, k) for mdl in ("dfm", "bridge", "naive")}}
               for k, h in enumerate(spec.horizons)]
    return {"slug": spec.slug, "as_of": _iso(m.as_of), "data_source": m.panel.source,
            "horizons": list(spec.horizons), "rows": rows, "summary": summary,
            "note": "Pseudo-real-time: today's data masked by release date; parameters from the full sample; "
                    "no data revisions. COVID-affected quarters excluded."}
