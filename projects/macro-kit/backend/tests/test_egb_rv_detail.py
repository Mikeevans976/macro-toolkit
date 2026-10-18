"""EGB RV detail view: each analysis agrees with the monitor and does what it says (simulated data)."""

import pytest

import egb_rv


@pytest.fixture(scope="module")
def monitor():
    out = egb_rv._compute_egb_rv()
    return {r["label"]: r for r in out["rv_monitor"]}, {r["label"]: r for r in out["beta_monitor"]}, out


@pytest.mark.parametrize("label", ["BTP 2s5s10s", "Box OAT/Bund 2s10s", "Bund ASW 10y", "BTP-Bonos 10y"])
def test_regression_is_the_beta_monitor_regression(monitor, label):
    _, beta, _ = monitor
    reg = egb_rv.compute_regression(label)
    assert reg["r2"] == pytest.approx(beta[label]["r2"], abs=1e-3)
    assert reg["residual_zscore"] == pytest.approx(beta[label]["residual_zscore"], abs=0.01)
    assert reg["factors"][0]["beta"] == pytest.approx(beta[label]["beta_bund10y"], abs=1e-3)
    # attribution adds up to the actual cumulative move
    last = reg["attribution"][-1]
    parts = last["intercept"] + last["residual"] + sum(last[f["name"]] for f in reg["factors"])
    assert parts == pytest.approx(last["actual"], abs=0.01)


@pytest.mark.parametrize("label,factor,key", [
    ("OAT-Bund 10y", "OAT-Bund 10y", "beta_spread10y"),
    ("Bund 2s10s", "Bund 2s10s", "beta_slope"),
])
def test_expression_is_not_regressed_on_itself(monitor, label, factor, key):
    _, beta, _ = monitor
    assert beta[label][key] is None and beta[label]["r2"] < 0.999
    reg = egb_rv.compute_regression(label)
    assert reg["excluded_factors"] == [factor]
    assert factor not in [f["name"] for f in reg["factors"]]
    assert reg["r2"] == pytest.approx(beta[label]["r2"], abs=1e-3)
    # every other expression keeps all four factors
    assert all(v is not None for v in (beta["BTP-Bund 10y"][k] for k in
               ("beta_bund10y", "beta_spread10y", "beta_slope", "beta_vol1m10y")))


@pytest.mark.parametrize("label,hedged", [
    ("Bund 2s10s", ["level"]),
    ("BTP-Bund 10y", ["level"]),
    ("OAT 5s10s30s", ["level", "slope"]),
    ("Box BTP/Bund 2s10s", ["level", "slope"]),
])
def test_neutral_version_has_no_hedged_exposure(label, hedged):
    out = egb_rv.compute_neutral(label)
    assert out["hedged"] == hedged
    for f in hedged:
        assert abs(out["neutral"]["exposure"][f]) < 1e-3
    kept = {"Bund 2s10s": [0], "BTP-Bund 10y": [0], "OAT 5s10s30s": [1], "Box BTP/Bund 2s10s": [0, 1]}[label]
    for i in kept:
        assert out["legs"][i]["neutral_weight"] == out["legs"][i]["weight"]


def test_single_leg_has_no_neutral_version():
    with pytest.raises(KeyError):
        egb_rv.compute_neutral("Bund ASW 10y")


@pytest.mark.parametrize("label", ["OAT-Bund 10y", "BTP 2s5s10s", "Bund ASW 10y"])
def test_rolldown_carry_matches_monitor(monitor, label):
    rv, _, _ = monitor
    out = egb_rv.compute_rolldown(label)
    assert out["carry1y_bps"] == pytest.approx(rv[label]["carry1y_bps"], abs=0.05)
    assert sum(lg["roll_bps"] * lg["weight"] for lg in out["legs"]) == pytest.approx(rv[label]["roll_bps"], abs=0.05)


@pytest.mark.parametrize("label", ["OAT-Bund 10y", "Box BTP/Bund 2s10s", "Bonos-PGB 10y"])
def test_repo_assumptions_match_the_tables_adjustment(monitor, label):
    rv, _, _ = monitor
    spreads = {"Bund": -30.0, "OAT": -5.0, "BTP": 10.0, "Bonos": 4.0}
    row = rv[label]
    # the page: carry + Σ bloc sensitivity × spread / 100
    expected = row["carry1y_bps"] + sum(row[f"{b.lower()}_repo_sens"] * s / 100 for b, s in spreads.items())
    assert egb_rv.compute_rolldown(label, repo_spreads_bp=spreads)["carry1y_bps"] == pytest.approx(expected, abs=0.05)
    assert egb_rv.compute_neutral(label, repo_spreads_bp=spreads)["standard"]["carry1y_bps"] == pytest.approx(expected, abs=0.05)


def test_backtest_promised_roll_is_todays_roll(monitor):
    rv, _, out = monitor
    bt = egb_rv.compute_carry_backtest(label="Bund 2s10s")
    assert bt["series"][-1]["start"] == out["as_of"]
    assert bt["series"][-1]["carry"] == pytest.approx(rv["Bund 2s10s"]["roll_bps"], abs=0.05)
    assert bt["series"][-1]["realised"] is None             # outcome not known yet
    done = [p for p in bt["series"] if p["realised"] is not None]
    assert done and all(p["fwd_err"] == pytest.approx(p["realised"] - p["carry"], abs=0.02) for p in done)
    assert [s["label"] for s in bt["structures"]] == ["Bund 2s10s"]


def test_backtest_skips_asw():
    with pytest.raises(KeyError, match="ASW"):
        egb_rv.compute_carry_backtest(label="Bund ASW 10y")


def test_monitor_rows_carry_legs_and_meetings(monitor):
    rv, _, out = monitor
    assert rv["BTP 2s5s10s"]["legs"] == [
        {"country": "BTP", "tenor": 2, "weight": -1}, {"country": "BTP", "tenor": 5, "weight": 2},
        {"country": "BTP", "tenor": 10, "weight": -1},
    ]
    assert out["policy_meetings"]["bank"] == "ECB"
