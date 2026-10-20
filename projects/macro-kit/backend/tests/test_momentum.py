"""Momentum / CTA model: signal maths, projections, regimes, calibration, sizing."""
from __future__ import annotations

import math

import numpy as np
import pandas as pd
import pytest

import momentum as m
import momentum_universe as mu


def _walk(n=1500, drift=0.0, seed=1):
    rng = np.random.default_rng(seed)
    r = drift + 0.01 * rng.standard_normal(n)
    return pd.Series(100 * np.cumprod(1 + r), index=pd.bdate_range("2015-01-01", periods=n))


W = np.full(4, 0.25)


def test_ema_diff_variance_matches_simulation():
    rng = np.random.default_rng(0)
    z = pd.Series(np.cumsum(rng.standard_normal(200_000)))
    for k, (_, f, s) in enumerate(m.SPEEDS):
        x = z.ewm(span=f, adjust=False).mean() - z.ewm(span=s, adjust=False).mean()
        assert x.iloc[5000:].std() == pytest.approx(m._SD_X[k], rel=0.05)


def test_responses_are_bounded_and_odd():
    y = np.linspace(-8, 8, 801)
    for r in m.RESPONSES:
        phi = m.response(y, r)
        assert np.abs(phi).max() <= 1 + 1e-12
        np.testing.assert_allclose(m.response(-y, r), -phi)
    assert m.response(math.sqrt(2), "baz") == pytest.approx(1.0)
    assert abs(m.response(6, "baz")) < 0.1     # baz cuts very extended trends


def test_trend_gives_long_signal_and_momentum_regime():
    sig = m.compute_signals(_walk(drift=0.004), "price")
    # a steady trend: every speed long on average (one day of noise can flip the fastest)
    assert (sig.y.iloc[m.WARMUP:].mean() > 0.5).all()
    y = sig.y.iloc[-1].to_numpy()
    label, direction, _ = m.classify(y, m.efficiency_ratio(sig.price))
    assert label in ("Momentum", "Strong momentum") and direction == 1


def test_level_kind_handles_negative_values():
    """Yields through zero: level differences, no percentage-change blow-ups."""
    t = np.arange(1500)
    s = pd.Series(0.8 * np.sin(t / 120) + 0.02 * np.random.default_rng(3).standard_normal(1500),
                  index=pd.bdate_range("2015-01-01", periods=1500))
    assert (s < 0).any() and (s > 0).any()
    sig = m.compute_signals(s, "level")
    assert np.isfinite(sig.y.iloc[m.WARMUP:].to_numpy()).all()
    with pytest.raises(ValueError):
        m.compute_signals(s, "price")


def test_one_step_projection_matches_recompute():
    s = _walk(seed=5)
    sig = m.compute_signals(s, "price")
    st = m._State.last(sig)
    q = st.move(1.7)
    s2 = pd.concat([s, pd.Series([q], index=[s.index[-1] + pd.offsets.BDay()])])
    y_re = m.compute_signals(s2, "price").y.iloc[-1].to_numpy()
    np.testing.assert_allclose(m._project(st, [q]), y_re, rtol=1e-9, atol=1e-9)


def test_flip_levels_zero_the_signal():
    for seed in (7, 8, 9):
        sig = m.compute_signals(_walk(seed=seed, drift=0.0005), "price")
        st = m._State.last(sig)
        k = m._flip_composite(st, W, "tanh")
        if k is not None:
            assert abs(m.composite(m._project(st, [st.move(k)]), W, "tanh")) < 1e-5
        for j, ks in enumerate(m._flip_speed(st)):
            if ks is not None:
                assert abs(m._project(st, [st.move(ks)])[j]) < 1e-9


def test_scenarios_are_monotone_in_the_shock():
    sig = m.compute_signals(_walk(seed=11), "price")
    st = m._State.last(sig)
    sc = [x for x in m.scenarios(st, W, "linear") if x["horizon_days"] == 5]
    pos = [x["position"] for x in sorted(sc, key=lambda x: x["shock_sigma"])]
    assert all(b >= a - 1e-9 for a, b in zip(pos, pos[1:]))


@pytest.mark.parametrize("y, er, label", [
    ([1.6, 1.8, 2.0, 2.1], 0.5, "Strong momentum"),
    ([0.6, 0.9, 1.0, 0.8], 0.3, "Momentum"),
    ([-1.4, -0.2, 1.0, 1.2], 0.2, "Reversal"),
    ([0.1, 0.6, 1.0, 0.9], 0.2, "Fading"),
    ([0.2, -0.1, 0.1, -0.2], 0.1, "Range"),
    ([0.6, -0.4, 0.2, -0.3], 0.4, "Mixed"),
])
def test_classify(y, er, label):
    assert m.classify(np.array(y), er)[0] == label


def test_generic_future_detection_and_roll_ticker():
    assert m.is_generic_future("TY1 Comdty") and m.is_generic_future("G 1 Comdty")
    assert m.is_generic_future("ES1 Index") and m.is_generic_future("EC1 Curncy")
    for t in ("USGG10YR Index", "GUKG2 Index", "DXY Curncy", "SPX Index", "BV100910 BVLI Index"):
        assert not m.is_generic_future(t), t
    assert m.adjusted_ticker("G 1 Comdty") == "G 1 R:00_0_R Comdty"


def test_kind_inference():
    px = _walk()
    assert m._infer_kind("TY1 Comdty", px) == "price"
    assert m._infer_kind("USGG10YR Index", px) == "level"
    assert m._infer_kind("USGG10YR Index - USGG2YR Index", px) == "level"
    assert m._infer_unit("USGG10YR Index - USGG2YR Index", "level") == "pct"


def test_merge_rescales_ratio_adjusted_history():
    idx = pd.bdate_range("2024-01-01", periods=10)
    old = pd.Series(np.arange(100.0, 110.0), index=idx)
    new = (old.iloc[6:] * 1.02).copy()
    new.loc[idx[-1] + pd.offsets.BDay()] = 113.0
    merged = m._merge(old, new, ratio_adjusted=True)
    assert merged.iloc[0] == pytest.approx(102.0)
    assert len(merged) == 11


def test_risk_weights_sum_to_one():
    w = mu.risk_weights()
    assert sum(w.values()) == pytest.approx(1.0)
    assert set(w) == {x.id for x in mu.UNIVERSE if x.cta}


def test_calibration_recovers_simulated_blend():
    state = m._universe_model()
    model = state["model"]
    assert model.calibration and model.calibration["ok"]
    assert model.calibration["r2"] > 0.5
    # the simulated index leans on the medium speeds
    assert model.weights[1] + model.weights[2] > 0.5


def test_monitor_shape_and_series_consistency():
    mon = m.get_monitor()
    assert mon["data_source"] == "simulation"
    assert len(mon["rows"]) == len(mu.UNIVERSE)
    ty = next(r for r in mon["rows"] if r["id"] == "ty")
    d = m.compute_cta_signals("TY1 Comdty")
    # the row and the detail view describe the same market
    assert d["current"]["position"] == pytest.approx(ty["position"], abs=0.5)
    assert d["sizing"]["basis"] == "universe"
    assert d["sizing"]["notional_usd"] == pytest.approx(ty["notional_usd"], rel=0.02)


def test_detail_spread_expression_sizes_in_dv01():
    d = m.compute_cta_signals("USGG10YR Index - USGG2YR Index")
    assert d["kind"] == "level" and d["unit"] == "pct"
    assert d["sizing"]["dv01_usd"] is not None and d["sizing"]["notional_usd"] is None
