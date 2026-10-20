"""Quant Macro nowcasting engine (nowcast.py) and the /api/tools/quant-macro routes.

The model is fitted once per module on the simulated UK panel with few EM
iterations: the checks are identities of the state-space algebra (moments,
news, weights), which hold for any parameter values.
"""
from __future__ import annotations

import dataclasses
import warnings

import numpy as np
import pandas as pd
import pytest
import time_machine
from fastapi.testclient import TestClient

import nowcast as nc
import quant_macro as qm

AS_OF = pd.Timestamp("2026-10-19")
SPEC = dataclasses.replace(qm.MODELS["uk-gdp"], maxiter=25, backtest_from="2024Q1", horizons=(-60, -1))


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


def test_live_mode_falls_back_to_simulation_and_lists_missing(monkeypatch):
    def boom(*_a, **_k):
        raise RuntimeError("no Terminal")
    monkeypatch.setattr(nc, "fetch_live_panel", boom)
    p = nc.load_panel(SPEC, AS_OF, "bloomberg")
    assert p.source == "simulation"
    assert "gdp" in p.missing


# ---------------------------------------------------------------------------
# State-space algebra
# ---------------------------------------------------------------------------

def test_target_moments_match_statsmodels_prediction(fitted):
    months = pd.period_range("2026-05", "2027-03", freq="M")
    mean, cov = nc.target_moments(fitted.res, "gdp", months)
    pred = fitted.res.get_prediction(start=months[0], end=months[-1], information_set="smoothed")
    np.testing.assert_allclose(mean, pred.predicted_mean["gdp"].to_numpy(), atol=1e-9)
    np.testing.assert_allclose(np.sqrt(np.clip(np.diag(cov), 0, None)), pred.se_mean["gdp"].to_numpy(), atol=1e-7)
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


def test_news_impacts_add_up_to_the_change_in_the_nowcast(fitted):
    quarters = [pd.Period(q, "Q") for q in ("2026Q3", "2026Q4", "2027Q1")]
    r0, r1 = fitted.at(pd.Timestamp("2026-09-20")), fitted.at(AS_OF)
    news = nc.compute_news(r1, r0, "gdp", nc.quarter_months(quarters[0])[0], fitted.index[-1])
    impacts = nc.quarter_impacts(news, "gdp", quarters)
    assert len(impacts) > 5
    for q in quarters:
        delta = nc.quarter_nowcast(r1, "gdp", q)[0] - nc.quarter_nowcast(r0, "gdp", q)[0]
        assert impacts[str(q)].sum() == pytest.approx(delta, abs=1e-8)


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


def test_bridge_is_ols_of_quarterly_growth_on_quarterly_survey_average():
    v = nc.simulate_panel(SPEC, AS_OF).vintage(AS_OF)
    b = nc.fit_bridge(SPEC, v)
    y, x = [], []
    for q in pd.period_range("1998Q2", "2026Q2", freq="Q"):
        if pd.Period("2020Q1", "Q") <= q <= pd.Period("2021Q3", "Q"):   # 5-month windows touching 2020-03..2021-06
            continue
        y.append(nc.triangle_qoq(v["gdp"], q))
        x.append(v["pmi_comp"][q.asfreq("M", "start"):q.asfreq("M", "end")].mean())
    beta, alpha = np.polyfit(x, y, 1)
    assert b.n == len(y)
    assert (b.alpha, b.beta) == pytest.approx((alpha, beta), rel=1e-9)
    assert b.beta > 0 and 0.2 < b.r2 < 0.95
    q = pd.Period("2026Q3", "Q")
    assert b.predict(v, q) == pytest.approx(alpha + beta * v["pmi_comp"]["2026-07":"2026-09"].mean())


# ---------------------------------------------------------------------------
# Payload and API
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


def test_payload_evolution_ends_at_the_current_nowcast(payload):
    last = payload["evolution"][-1]
    assert last["date"] == "2026-10-19"
    for q in payload["quarters"][4:]:
        assert last["nowcasts"][q["quarter"]] == q["nowcast"]
    first, steps = payload["evolution"][0], payload["evolution"][1:]
    for q in ("2026Q3", "2026Q4"):
        moved = sum(sum(v for v in s["by_group"][q].values() if v) for s in steps)
        assert moved == pytest.approx(last["nowcasts"][q] - first["nowcasts"][q], abs=5e-3)


def test_payload_indicators_and_central_bank(payload):
    ind = {i["id"]: i for i in payload["indicators"]}
    assert ind["gdp"]["weights"]["2026Q3"] == pytest.approx(1 / 3, abs=1e-3)   # Sep enters Q3 with weight 1/3
    assert all(i["next_release"] >= "2026-10-19" for i in ind.values())
    cb = payload["central_bank"]
    assert cb["institution"] == "Bank of England"
    q3 = next(c for c in cb["comparisons"] if c["quarter"] == "2026Q3")
    assert q3["cb_value"] == 0.4 and q3["cb_published"] == "2026-09-17"
    assert q3["news_since"] == pytest.approx(q3["model_now"] - q3["model_at_publication"], abs=1e-4)


def test_backtest(fitted):
    bt = qm.build_backtest(fitted)
    assert bt["horizons"] == [-60, -1] and len(bt["rows"]) >= 8
    rmse = [s["dfm"]["rmse"] for s in bt["summary"]]
    assert rmse[1] < rmse[0]                         # more data, smaller errors


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


def test_api_routes(client):
    assert client.get("/api/tools/quant-macro").json()[0]["slug"] == "uk-gdp"
    r = client.get("/api/tools/quant-macro/uk-gdp")
    assert r.status_code == 200, r.text[:300]
    body = r.json()
    assert body["data_source"] == "simulation" and body["as_of"] == "2026-10-19"
    assert client.get("/api/tools/quant-macro/atlantis-gdp").status_code == 404
