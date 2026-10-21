"""Quant Macro nowcasting engine (nowcast.py), real-time vintages (vintages.py) and the
/api/tools/quant-macro routes.

The model is fitted once per module on the simulated UK panel with few EM
iterations: the checks are identities of the state-space algebra (moments,
news, weights), which hold for any parameter values. All saved state goes
to a temporary directory (quant_macro.ROOT).
"""
from __future__ import annotations

import dataclasses
import json
import sys
import time
import types
import warnings
from datetime import datetime

import numpy as np
import pandas as pd
import pytest
import time_machine
from fastapi.testclient import TestClient

import nowcast as nc
import quant_macro as qm
import vintages as vt

AS_OF = pd.Timestamp("2026-10-19")
SPEC = dataclasses.replace(qm.MODELS["uk-gdp"], maxiter=25, backtest_from="2024Q1", horizons=(-60, -1))


@pytest.fixture(scope="module", autouse=True)
def state_dir(tmp_path_factory):
    saved = qm.ROOT
    qm.ROOT = tmp_path_factory.mktemp("quant_macro")
    yield qm.ROOT
    qm.ROOT = saved


@pytest.fixture(scope="module")
def fitted() -> qm.Fitted:
    return qm.fit(SPEC, AS_OF, "csv")


# ---------------------------------------------------------------------------
# Data and calendar
# ---------------------------------------------------------------------------

def test_triangle_is_exact_growth_of_three_month_average_log_level():
    rng = np.random.default_rng(3)
    log_level = np.cumsum(rng.normal(0.1, 0.5, 30)) / 100
    idx = pd.period_range("2024-01", periods=30, freq="M")
    g = pd.Series(100 * np.diff(log_level, prepend=np.nan), index=idx)
    q = pd.Period("2025Q2", "Q")
    m = [idx.get_loc(p) for p in pd.period_range("2025-04", "2025-06", freq="M")]
    expected = 100 * (log_level[m].mean() - log_level[[i - 3 for i in m]].mean())
    assert nc.triangle_qoq(g, q) == pytest.approx(expected, abs=1e-12)
    assert nc.triangle_qoq(g.drop(idx[-1]), pd.Period("2026Q2", "Q")) is None


def test_simulated_panel_is_deterministic_and_history_is_stable_across_days():
    a = nc.simulate_panel(SPEC, AS_OF)
    b = nc.simulate_panel(SPEC, AS_OF + pd.Timedelta(days=40))
    common = a.values.index.intersection(b.values.index)
    pd.testing.assert_frame_equal(a.values.loc[common], b.values.loc[common])
    assert a.source == "simulation"


def test_vintage_masks_unreleased_observations():
    p = nc.simulate_panel(SPEC, AS_OF)
    v = p.vintage(AS_OF)
    released = p.release.to_numpy()[v.notna().to_numpy()]
    assert released.size > 1000 and (released <= AS_OF.to_datetime64()).all()
    assert v["gdp"].last_valid_index() == pd.Period("2026-08", "M")      # Aug GDP is out mid-October
    assert v["pmi_comp"].last_valid_index() == pd.Period("2026-09", "M")  # Oct flash not yet
    assert p.values["gdp"].loc["2026-09"] == p.values["gdp"].loc["2026-09"]  # the truth exists, masked


def test_simulated_revisions_follow_the_catalogue():
    p = nc.simulate_panel(SPEC, AS_OF)
    gdp = p.obs[(p.obs["series"] == "gdp") & (p.obs["period"] == pd.Period("2026-05", "M"))]
    assert list(gdp["source"].unique()) == ["sim"] and 2 <= len(gdp) <= 3   # first, second, final (dupes dropped)
    first_day, final_day = gdp["known_from"].min(), gdp["known_from"].max()
    assert p.vintage(first_day)["gdp"]["2026-05"] == gdp.iloc[0]["value"]
    assert p.vintage(final_day)["gdp"]["2026-05"] == p.values["gdp"]["2026-05"]
    assert (final_day - first_day).days >= 89                            # settle_days = 90
    surveys = p.obs[p.obs["series"] == "gfk"]
    assert not surveys.duplicated(["period"]).any()                       # unrevised


def test_live_mode_falls_back_to_simulation_and_lists_missing(monkeypatch):
    def boom(*_a, **_k):
        raise RuntimeError("no Terminal")
    monkeypatch.setattr(nc, "fetch_live_panel", boom)
    p = qm.load_panel(SPEC, AS_OF, "bloomberg")
    assert p.source == "simulation"
    assert "gdp" in p.missing


# ---------------------------------------------------------------------------
# Vintage store, ONS triangles and assembly
# ---------------------------------------------------------------------------

def test_parse_triangle_reads_publication_rows_and_skips_summaries():
    rows = [
        ("Revisions triangle", None, None, None),
        ("Relating to Period", "2026 Jan", "2026 Feb", datetime(2026, 3, 1)),
        ("First Estimate [note 1]", 0.1, 0.2, 0.3),
        ("2026 Mar", 0.1, None, None),
        ("Apr-26", 0.2, 0.2, None),
        (datetime(2026, 5, 1), 0.2, 0.3, 0.3),
        ("Latest Estimate", 0.2, 0.3, 0.3),
    ]
    tri = vt.parse_triangle(rows)
    assert len(tri) == 6
    assert set(tri["vintage"].astype(str)) == {"2026-03", "2026-04", "2026-05"}
    rel = {pd.Period("2026-01", "M"): pd.Timestamp("2026-03-13"), pd.Period("2026-02", "M"): pd.Timestamp("2026-04-14"),
           pd.Period("2026-03", "M"): pd.Timestamp("2026-07-01")}          # outside May → mid-month
    out = vt.triangle_rows(tri, rel.get)
    jan = out[out["period"] == pd.Period("2026-01", "M")]
    assert list(jan["value"]) == [0.1, 0.2] and list(jan["known_from"]) == [pd.Timestamp("2026-03-13"), pd.Timestamp("2026-04-14")]
    mar = out[out["period"] == pd.Period("2026-03", "M")]
    assert list(mar["known_from"]) == [pd.Timestamp("2026-05-15")]


def test_triangle_levels_become_changes_within_each_vintage():
    tri = pd.DataFrame({"vintage": [pd.Period("2026-03", "M")] * 3 + [pd.Period("2026-04", "M")] * 3,
                        "period": list(pd.period_range("2026-01", periods=3, freq="M")) * 2,
                        "value": [1000.0, 1010.0, 1030.0, 1000.0, 1015.0, 1030.0]})
    out = vt.triangle_rows(tri, lambda p: p.to_timestamp(how="end").normalize() + pd.Timedelta(days=18), diff=True, scale=0.1)
    feb = out[out["period"] == pd.Period("2026-02", "M")]
    assert list(feb["value"]) == [1.0, 1.5]
    assert list(out[out["period"] == pd.Period("2026-03", "M")]["value"]) == [2.0, 1.5]


def test_snapshots_date_new_releases_by_release_and_revisions_by_run(tmp_path):
    store = vt.VintageStore(tmp_path / "v.db")
    p1, p2 = pd.Period("2026-08", "M"), pd.Period("2026-09", "M")
    rel = {"x": pd.Series({p1: pd.Timestamp("2026-09-20"), p2: pd.Timestamp("2026-10-20")})}
    store.snapshot("d", {"x": pd.Series({p1: 1.0})}, rel, pd.Timestamp("2026-10-01"))
    store.snapshot("d", {"x": pd.Series({p1: 1.2, p2: 2.0})}, rel, pd.Timestamp("2026-10-22"))
    store.snapshot("d", {"x": pd.Series({p1: 1.2, p2: 2.0})}, rel, pd.Timestamp("2026-10-23"))   # nothing new
    got = store.read("d").sort_values(["period", "known_from"])
    assert [(str(r.period), str(r.known_from.date()), r.value) for r in got.itertuples()] == [
        ("2026-08", "2026-10-01", 1.0),      # first run: dated by the run
        ("2026-08", "2026-10-22", 1.2),      # revision: dated by the run that saw it
        ("2026-09", "2026-10-20", 2.0),      # released between runs: dated by its release
    ]
    assert store.runs("d")[0] == pd.Timestamp("2026-10-01")


def test_assemble_prefers_ons_then_first_prints_then_snapshots():
    series = [{"id": "g", "vintages": {"ons": "rsi_mom", "settle_days": 60}},
              {"id": "s", "vintages": {"settle_days": 30}},
              {"id": "u"}]
    P = lambda m: pd.Period(m, "M")                                                       # noqa: E731
    T = pd.Timestamp
    rel = {k: pd.Series({P("2020-01"): T("2020-02-20"), P("2026-08"): T("2026-09-20"), P("2026-09"): T("2026-10-20")})
           for k in ("g", "s", "u")}
    latest = {k: pd.Series({P("2020-01"): 1.0, P("2026-08"): 2.0, P("2026-09"): 3.0}) for k in ("g", "s", "u")}
    first = {k: pd.Series({P("2020-01"): 0.5, P("2026-08"): 1.5, P("2026-09"): 3.0}) for k in ("g", "s")}
    stored = pd.DataFrame([
        ("g", P("2020-01"), T("2021-01-15"), 0.9, "ons"), ("g", P("2026-08"), T("2026-09-20"), 1.8, "ons"),
        ("g", P("2026-08"), T("2026-10-20"), 2.0, "ons"),
        ("s", P("2026-08"), T("2026-10-01"), 2.0, "snapshot"), ("s", P("2026-09"), T("2026-10-20"), 3.0, "snapshot"),
    ], columns=["series", "period", "known_from", "value", "source"])
    obs, info = vt.assemble(series, stored, latest, first, rel, first_run=T("2026-10-01"))
    panel = nc.Panel(obs=obs, transforms={"g": "none", "s": "none", "u": "none"}, source="live")
    v = lambda d: panel.vintage(T(d))                                                       # noqa: E731
    # g: Bloomberg first print before the ONS triangle starts, then ONS vintages, then a newer Bloomberg release
    assert v("2020-03-01")["g"]["2020-01"] == 0.5
    assert v("2021-02-01")["g"]["2020-01"] == 0.9
    assert v("2026-10-01")["g"]["2026-08"] == 1.8 and v("2026-10-21")["g"]["2026-08"] == 2.0
    assert v("2026-10-21")["g"]["2026-09"] == 3.0
    # s: first print + settle before the first snapshot; snapshots after
    assert v("2020-03-01")["s"]["2020-01"] == 0.5 and v("2020-03-25")["s"]["2020-01"] == 1.0
    assert v("2026-09-25")["s"]["2026-08"] == 1.5 and v("2026-10-02")["s"]["2026-08"] == 2.0
    # u: unrevised
    assert v("2020-02-20")["u"]["2020-01"] == 1.0
    assert "ONS" in info["g"] and "first print" in info["s"] and "Not revised" in info["u"]


def test_fetch_live_panel_with_fake_bloomberg_and_ons(tmp_path, monkeypatch):
    import openpyxl

    cat = {"series": [
        {"id": "g", "name": "G", "short": "G", "group": "Activity", "blocks": ["Global"], "ticker_bloomberg": "G Index",
         "units": "% m/m", "transform": "none", "release_lag_days": 20, "start": "2015-01",
         "vintages": {"ons": "rsi_mom", "settle_days": 60, "sim_sd": 0.1}},
        {"id": "lv", "name": "L", "short": "L", "group": "Labour", "blocks": ["Global"], "ticker_bloomberg": "L Index",
         "units": "% m/m", "transform": "log_diff", "release_lag_days": 18, "start": "2015-01",
         "vintages": {"settle_days": 30, "sim_sd": 0.1}},
    ]}
    (tmp_path / "cat_test.json").write_text(json.dumps(cat), encoding="utf-8")
    monkeypatch.setattr(nc, "DATA_DIR", tmp_path)
    nc.load_catalogue.cache_clear()
    spec = dataclasses.replace(SPEC, catalogue="cat_test.json", target="g", quarterly_ticker=None)
    as_of = pd.Timestamp("2026-10-19")
    months = pd.period_range("2015-01", "2026-09", freq="M")
    g = pd.Series(np.round(np.sin(np.arange(len(months))) / 2, 1), index=months)
    lvl = pd.Series(100 * np.exp(np.cumsum(np.full(len(months), 0.01))), index=months)
    ix = months.to_timestamp(how="end").normalize()

    def bdh(tickers, flds, **_k):
        f = flds[0]
        cols = {}
        if f == "PX_LAST":
            cols = {("G Index", f): g.to_numpy(), ("L Index", f): lvl.to_numpy()}
        elif f == "ACTUAL_RELEASE":
            cols = {("G Index", f): (g + 0.1).to_numpy(), ("L Index", f): (lvl * 0.99).to_numpy()}
        else:
            raise RuntimeError("no release dates")
        return pd.DataFrame(cols, index=ix)

    monkeypatch.setitem(sys.modules, "bbg", types.SimpleNamespace(bdh=bdh, bdp=lambda *a, **k: {}))
    # ONS triangle for g: two publications of Jul/Aug 2026
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "triangle"
    ws.append(["Relating to Period", "Jul-26", "Aug-26"])
    ws.append(["First Estimate", 9, 9])
    ws.append(["Aug-26", 0.7, None])
    ws.append(["Sep-26", 0.6, float(g["2026-08"])])
    ws.append(["Oct-26", float(g["2026-07"]), float(g["2026-08"])])
    path = tmp_path / "rsi.xlsx"
    wb.save(path)
    monkeypatch.setattr(vt, "download_ons", lambda *a, **k: path)

    store = vt.VintageStore(tmp_path / "v.db")
    try:
        panel = nc.fetch_live_panel(spec, as_of, store, tmp_path / "ons")
    finally:
        nc.load_catalogue.cache_clear()
    assert panel.source == "live" and set(panel.ids) == {"g", "lv"}
    jul = panel.obs[(panel.obs["series"] == "g") & (panel.obs["period"] == pd.Period("2026-07", "M"))]
    assert list(jul["value"]) == [0.7, 0.6, float(g["2026-07"])][: len(jul)] and len(jul) >= 2
    assert panel.vintage(pd.Timestamp("2026-08-21"))["g"]["2026-07"] == 0.7
    # before the triangle: first print, then today's value after settle_days
    assert panel.vintage(pd.Timestamp("2020-02-21"))["g"]["2020-01"] == pytest.approx(g["2020-01"] + 0.1)
    assert panel.vintage(pd.Timestamp("2020-06-01"))["g"]["2020-01"] == pytest.approx(g["2020-01"])
    # log_diff of the level as published that day
    v = panel.vintage(pd.Timestamp("2020-02-19"))["lv"]
    assert v["2020-01"] == pytest.approx(100 * np.log(lvl["2020-01"] * 0.99 / lvl["2019-12"]), abs=1e-9)
    assert store.runs("cat_test") == [as_of]
    assert "ONS" in panel.vintage_info["g"]


# ---------------------------------------------------------------------------
# State-space algebra
# ---------------------------------------------------------------------------

def test_target_moments_match_statsmodels_prediction(fitted):
    months = pd.period_range("2026-05", "2027-03", freq="M")
    mean, cov = nc.target_moments(fitted.res, "gdp", months)
    pred = fitted.res.get_prediction(start=months[0], end=months[-1], information_set="smoothed")
    np.testing.assert_allclose(mean, pred.predicted_mean["gdp"].to_numpy(), atol=1e-9)
    se = np.nan_to_num(pred.se_mean["gdp"].to_numpy())           # observed months: variance ~0, NaN from rounding
    np.testing.assert_allclose(np.sqrt(np.clip(np.diag(cov), 0, None)), se, atol=1e-7)
    assert np.all(np.linalg.eigvalsh(cov) > -1e-9)
    observed = fitted.frame(AS_OF)["gdp"].reindex(months).notna().to_numpy()
    np.testing.assert_allclose(mean[observed], fitted.frame(AS_OF)["gdp"].reindex(months)[observed], atol=1e-9)


def test_quarterly_variance_includes_cross_month_covariance(fitted):
    q = pd.Period("2026Q4", "Q")
    mean, cov = nc.target_moments(fitted.res, "gdp", nc.quarter_months(q))
    _, sd = nc.quarter_nowcast(fitted.res, "gdp", q)
    diag_only = np.sqrt(nc.TRIANGLE ** 2 @ np.diag(cov))
    assert sd == pytest.approx(np.sqrt(nc.TRIANGLE @ cov @ nc.TRIANGLE))
    assert abs(sd - diag_only) > 1e-3


def test_news_and_revisions_add_up_to_the_change_in_the_nowcast(fitted):
    quarters = [pd.Period(q, "Q") for q in ("2026Q3", "2026Q4", "2027Q1")]
    r0, r1 = fitted.at(pd.Timestamp("2026-09-20")), fitted.at(AS_OF)
    m0 = nc.quarter_months(quarters[0])[0]
    news = nc.compute_news(r1, r0, "gdp", m0, fitted.index[-1], m0 - 24)
    impacts = nc.quarter_impacts(news, "gdp", quarters)
    revisions = nc.quarter_revision_impacts(news, "gdp", quarters)
    assert len(impacts) > 5 and len(revisions) > 0          # the simulated panel revises GDP, IP, retail…
    for q in quarters:
        delta = nc.quarter_nowcast(r1, "gdp", q)[0] - nc.quarter_nowcast(r0, "gdp", q)[0]
        assert impacts[str(q)].sum() + revisions[str(q)].sum() == pytest.approx(delta, abs=1e-8)
        assert nc.quarter_total_impacts(news, "gdp", quarters)[str(q)] == pytest.approx(delta, abs=1e-8)


def test_weights_equal_the_effect_of_a_unit_surprise(fitted):
    q = pd.Period("2026Q4", "Q")
    frame = fitted.frame(AS_OF)
    p = frame["pmi_comp"].last_valid_index() + 1
    pred = fitted.res.get_prediction(start=p, end=p, information_set="smoothed").predicted_mean
    base = frame.copy()
    base.loc[p, "pmi_comp"] = pred.loc[p, "pmi_comp"]
    bumped = base.copy()
    bumped.loc[p, "pmi_comp"] += 1.0
    r_base, r_bump = nc.apply_vintage(fitted.res, base), nc.apply_vintage(fitted.res, bumped)
    news = nc.compute_news(r_base, fitted.res, "gdp", nc.quarter_months(q)[0], fitted.index[-1])
    w = nc.quarter_weights(news, "gdp", [q]).loc[(p, "pmi_comp"), str(q)]
    effect = nc.quarter_nowcast(r_bump, "gdp", q)[0] - nc.quarter_nowcast(r_base, "gdp", q)[0]
    assert w == pytest.approx(effect, rel=1e-6)
    # an in-line release leaves the nowcast where it was
    assert nc.quarter_nowcast(r_base, "gdp", q)[0] == pytest.approx(nc.quarter_nowcast(fitted.res, "gdp", q)[0], abs=1e-9)


def test_saved_model_reproduces_the_fit_and_runs_new_data(fitted):
    state = json.loads(json.dumps(fitted.state))                 # through JSON, as on disk
    m = qm.restore(SPEC, state, AS_OF, fitted.panel)
    for q in ("2026Q3", "2026Q4", "2027Q1"):
        assert nc.quarter_nowcast(m.res, "gdp", pd.Period(q, "Q")) == pytest.approx(
            nc.quarter_nowcast(fitted.res, "gdp", pd.Period(q, "Q")), abs=1e-9)
    later = AS_OF + pd.Timedelta(days=30)                         # new data, same parameters
    m2 = qm.restore(SPEC, state, later, nc.simulate_panel(SPEC, later))
    assert m2.frame(later)["gdp"].last_valid_index() > m.frame(AS_OF)["gdp"].last_valid_index()
    assert qm.restore(SPEC, {**state, "structure": "changed"}, AS_OF, fitted.panel) is None
    assert qm.restore(SPEC, {**state, "source": "live"}, AS_OF, fitted.panel) is None


def test_bridge_is_ols_of_quarterly_growth_on_quarterly_survey_average():
    v = nc.simulate_panel(SPEC, AS_OF).values
    b = nc.fit_bridge(SPEC, v.loc[:"2026-09"])
    y, x = [], []
    for q in pd.period_range("1998Q2", "2026Q3", freq="Q"):
        if pd.Period("2020Q1", "Q") <= q <= pd.Period("2021Q3", "Q"):   # 5-month windows touching 2020-03..2021-06
            continue
        y.append(nc.triangle_qoq(v["gdp"], q))
        x.append(v["pmi_comp"][q.asfreq("M", "start"):q.asfreq("M", "end")].mean())
    beta, alpha = np.polyfit(x, y, 1)
    assert b.n == len(y)
    assert (b.alpha, b.beta) == pytest.approx((alpha, beta), rel=1e-9)
    assert b.beta > 0 and 0.2 < b.r2 < 0.95


# ---------------------------------------------------------------------------
# Payload, backtest and API
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def payload(fitted):
    return qm.build_payload(fitted)


def test_payload_quarters_and_next_print(payload):
    status = [q["status"] for q in payload["quarters"]]
    assert status == ["released"] * 4 + ["backcast", "nowcast", "forecast"]
    back = payload["quarters"][4]
    assert back["quarter"] == "2026Q3" and back["months_observed"] == 2
    assert back["lo90"] < back["lo68"] < back["nowcast"] < back["hi68"] < back["hi90"]
    widths = [q["hi68"] - q["lo68"] for q in payload["quarters"][4:]]
    assert widths == sorted(widths)                      # less data → wider bands
    nxt = payload["next_print"]
    assert nxt["period"] == "2026-09" and nxt["quarter"]["quarter"] == "2026Q3"
    assert nxt["quarter"]["model"] == back["nowcast"]
    assert payload["model"]["fitted_at"] and payload["model"]["fit_data_as_of"] == "2026-10-19"


def test_payload_evolution_ends_at_the_current_nowcast_and_shows_revisions(payload):
    last = payload["evolution"][-1]
    assert last["date"] == "2026-10-19"
    for q in payload["quarters"][4:]:
        assert last["nowcasts"][q["quarter"]] == q["nowcast"]
    first, steps = payload["evolution"][0], payload["evolution"][1:]
    for q in ("2026Q3", "2026Q4"):
        moved = sum(sum(v for v in s["by_group"][q].values() if v) for s in steps)
        assert moved == pytest.approx(last["nowcasts"][q] - first["nowcasts"][q], abs=5e-3)
    kinds = {r["kind"] for s in steps for r in s["releases"]}
    assert kinds == {"release", "revision"}
    rev = next(r for s in steps for r in s["releases"] if r["kind"] == "revision" and r["series_id"] == "gdp")
    assert rev["news"] == pytest.approx(rev["observed"] - rev["expected"], abs=1e-3)


def test_payload_indicators_and_central_bank(payload):
    ind = {i["id"]: i for i in payload["indicators"]}
    assert ind["gdp"]["weights"]["2026Q3"] == pytest.approx(1 / 3, abs=1e-3)   # Sep enters Q3 with weight 1/3
    assert all(i["next_release"] >= "2026-10-19" for i in ind.values())
    assert "revisions" in ind["gdp"]["vintages"] and "not revised" in ind["gfk"]["vintages"]
    cb = payload["central_bank"]
    assert cb["institution"] == "Bank of England"
    q3 = next(c for c in cb["comparisons"] if c["quarter"] == "2026Q3")
    assert q3["cb_value"] == 0.4 and q3["cb_published"] == "2026-09-17"
    assert q3["news_since"] == pytest.approx(q3["model_now"] - q3["model_at_publication"], abs=1e-4)


def test_real_time_backtest_refits_each_quarter_on_that_days_data(fitted, tmp_path):
    steps = []
    bt = qm.build_backtest(SPEC, fitted.panel, AS_OF, lambda i, n, s: steps.append((i, n)), fits_dir=tmp_path)
    assert bt["horizons"] == [-60, -1] and len(bt["rows"]) >= 8
    assert bt["n_fits"] == len(list(tmp_path.glob("*.json"))) >= len(bt["rows"])
    assert steps[-1][0] == steps[-1][1] == bt["n_fits"]
    # each saved fit only saw data public on the first day of its quarter
    fit = json.loads((tmp_path / "2025Q1.json").read_text())
    assert fit["data_as_of"] == "2025-01-01"
    rmse = [s["dfm"]["rmse"] for s in bt["summary"]]
    assert rmse[1] < rmse[0]                                 # more data, smaller errors
    # scored against the first estimate, which differs from today's value after revisions
    assert any(r["actual"] != r["actual_latest"] for r in bt["rows"])
    first = bt["rows"][0]
    q = pd.Period(first["quarter"], "Q")
    assert first["actual"] == pytest.approx(nc.triangle_qoq(fitted.panel.vintage(pd.Timestamp(first["release_date"]))["gdp"], q), abs=1e-4)


@pytest.fixture(scope="module")
def client():
    import main
    from auth import get_current_user
    main.app.dependency_overrides[get_current_user] = lambda: {"username": "t", "full_name": "T"}
    saved = dict(qm.MODELS)
    qm.MODELS["uk-gdp"] = SPEC
    with warnings.catch_warnings(), time_machine.travel("2026-10-19T12:00:00+00:00", tick=False):
        warnings.simplefilter("ignore")
        yield TestClient(main.app)
    qm.MODELS.clear()
    qm.MODELS.update(saved)
    main.app.dependency_overrides.clear()


def _wait(client, kind: str, timeout: float = 300) -> dict:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        st = client.get("/api/tools/quant-macro/uk-gdp/status").json()
        if st["jobs"][kind]["state"] != "running":
            return st
        time.sleep(0.5)
    raise AssertionError(f"{kind} still running")


def test_api_routes_and_jobs(client, state_dir):
    assert client.get("/api/tools/quant-macro").json()[0]["slug"] == "uk-gdp"
    assert client.get("/api/tools/quant-macro/atlantis-gdp").status_code == 404
    r = client.get("/api/tools/quant-macro/uk-gdp")          # first use: fits and saves
    assert r.status_code == 200, r.text[:300]
    body = r.json()
    assert body["data_source"] == "simulation" and body["as_of"] == "2026-10-19"
    assert (state_dir / "uk-gdp" / "model.json").exists() and (state_dir / "uk-gdp" / "nowcast.json").exists()
    fitted_at = body["model"]["fitted_at"]
    # a second load reads the saved payload: same fit, nothing re-estimated
    assert client.get("/api/tools/quant-macro/uk-gdp").json()["model"]["fitted_at"] == fitted_at
    st = client.get("/api/tools/quant-macro/uk-gdp/status").json()
    assert st["model_fitted_at"] == fitted_at and st["backtest_run_at"] is None
    assert client.get("/api/tools/quant-macro/uk-gdp/backtest").json() is None

    assert client.post("/api/tools/quant-macro/uk-gdp/refit").json()["jobs"]["refit"]["state"] in ("running", "done")
    st = _wait(client, "refit")
    assert st["jobs"]["refit"]["state"] == "done", st["jobs"]["refit"]["error"]
    assert st["model_fitted_at"] >= fitted_at

    client.post("/api/tools/quant-macro/uk-gdp/backtest")
    st = _wait(client, "backtest")
    assert st["jobs"]["backtest"]["state"] == "done", st["jobs"]["backtest"]["error"]
    bt = client.get("/api/tools/quant-macro/uk-gdp/backtest").json()
    assert bt["n_fits"] > 0 and bt["rows"] and st["backtest_run_at"] == bt["run_at"]
    assert len(list((state_dir / "uk-gdp" / "backtests").glob("20*.json"))) == 1
