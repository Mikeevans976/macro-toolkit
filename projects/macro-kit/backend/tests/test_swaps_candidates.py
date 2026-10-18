"""Swaps RV trade candidates: direction, carry sign and score follow from the monitor's numbers."""

import pytest

from swaps_rv import compute_candidates, compute_rv


@pytest.fixture(scope="module")
def rv():
    return {r["label"]: r for r in compute_rv("EUR")["rv_monitor"]}


@pytest.fixture(scope="module", params=["standard", "neutral"])
def cands(request):
    return compute_candidates("EUR", basis=request.param)


def test_one_row_per_structure(rv, cands):
    assert sorted(c["label"] for c in cands["candidates"]) == sorted(rv)


def test_trade_direction_follows_z(cands):
    for c in cands["candidates"]:
        down = c["zscore_1y"] > 0
        expected = {"curve": ("Flattener", "Steepener"), "fly": ("Receive belly", "Pay belly")}[c["group"]]
        assert c["trade"] == expected[0 if down else 1], c["label"]
        assert (c["deviation_bp"] > 0) == down or c["deviation_bp"] == 0


def test_standard_basis_matches_monitor(rv):
    for c in compute_candidates("EUR", basis="standard")["candidates"]:
        r = rv[c["label"]]
        assert c["zscore_1y"] == pytest.approx(r["zscore_1y"], abs=0.01)
        # carry1y_bps is quoted for the side that profits when the structure falls
        sign = 1 if c["zscore_1y"] > 0 else -1
        assert c["carry_bp"] == pytest.approx(sign * r["carry1y_bps"], abs=0.02)
        assert c["vol3m_bp"] == pytest.approx(r["vol3m_bps"], abs=0.02)


def test_neutral_basis_uses_neutral_weights(rv):
    for c in compute_candidates("EUR", basis="neutral")["candidates"]:
        r = rv[c["label"]]
        if r["neutral_weights"] is None:
            assert c["basis"] == "standard"
            continue
        assert c["basis"] == "neutral" and c["weights"] == pytest.approx(r["neutral_weights"], abs=1e-3)
        assert c["zscore_1y"] == pytest.approx(r["neutral_zscore_1y"], abs=0.01)
        assert c["checks"]["stable"] == (not r["neutral_unstable"])


def test_expected_pnl_and_score(cands):
    for c in cands["candidates"]:
        assert 0 <= c["expected_reversion_bp"] <= abs(c["deviation_bp"]) + 0.01
        assert c["expected_bp"] == pytest.approx(c["expected_reversion_bp"] + c["carry_bp"], abs=0.02)
        if c["vol3m_bp"] > 0:
            # everything is rounded to 0.01, so check score × vol ≈ expected within that rounding
            assert abs(c["score"] * c["vol3m_bp"] - c["expected_bp"]) <= 0.005 * c["vol3m_bp"] + 0.01 * (1 + abs(c["score"]))
            assert type(c["score"]) is float
        if c["half_life_days"] is None:
            assert c["expected_reversion_bp"] == 0


def test_agreement_count(cands):
    for c in cands["candidates"]:
        assert c["n_agree"] == sum(c["checks"][k] for k in ("carry", "residual", "reversion", "delivered"))
        assert c["checks"]["carry"] == (c["carry_bp"] >= 0)


def test_bad_basis_is_rejected():
    with pytest.raises(ValueError):
        compute_candidates("EUR", basis="nope")
