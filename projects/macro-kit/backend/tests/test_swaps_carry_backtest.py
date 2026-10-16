"""Swaps RV: vectorised curve bootstrap and the carry realisation backtest."""

import numpy as np
import pandas as pd
import pytest

import swaps_rv as sr


@pytest.fixture(scope="module")
def par():
    return pd.read_csv(sr.DATA_DIR / "eur_estr_swaps.csv", parse_dates=["date"], index_col="date").sort_index()


def test_vectorised_bootstrap_matches_scalar(par):
    rows = par.values.astype(float)
    D = sr._discount_factor_matrix(rows)
    A = np.cumsum(D, axis=1)
    for i in (0, len(rows) // 2, len(rows) - 1):
        Ds = sr._build_discount_factors(rows[i])
        np.testing.assert_allclose(D[i], Ds, atol=1e-14)
        for s, t in [(1, 1), (5, 10), (10, 10), (30, 20)]:
            assert sr._fwd_rate_vec(s, t, D, A)[i] == pytest.approx(sr._fwd_rate(s, t, Ds), abs=1e-12)


def test_latest_carry_matches_monitor():
    bt = sr.compute_carry_backtest("EUR", label="10y10y-5y10y", window="all")
    rv = {r["label"]: r for r in sr.compute_rv("EUR")["rv_monitor"]}
    assert bt["series"][-1]["carry"] == pytest.approx(rv["10y10y-5y10y"]["carry1y_bps"], abs=0.01)


def test_realised_is_carry_plus_forward_error(par):
    bt = sr.compute_carry_backtest("EUR", label="2y1y|3y1y|4y1y", window="all")
    done = [p for p in bt["series"] if p["realised"] is not None]
    assert done, "CSV history should hold at least one completed 1y period"
    for p in done:
        assert p["realised"] == pytest.approx(p["carry"] + p["fwd_err"], abs=0.02)

    # One period by hand: receive the fly at entry, mark the rolled legs a year later
    p = done[0]
    D0 = sr._build_discount_factors(par.loc[p["start"]].values.astype(float))
    D1 = sr._build_discount_factors(par.loc[p["end"]].values.astype(float))
    legs = [((2, 1), -1), ((3, 1), 2), ((4, 1), -1)]
    manual = sum(w * (sr._fwd_rate(s, t, D0) - sr._fwd_rate(s - 1, t, D1)) for (s, t), w in legs) * 100
    assert p["realised"] == pytest.approx(manual, abs=0.01)


def test_unknown_structure_and_window():
    with pytest.raises(KeyError):
        sr.compute_carry_backtest("EUR", label="not-a-structure")
    with pytest.raises(ValueError):
        sr.compute_carry_backtest("EUR", window="5y")
