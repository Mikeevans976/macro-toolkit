"""Swaps RV factor-neutral versions: hedged exposures vanish and the monitor agrees with the detail view."""

import pytest

from swaps_rv import compute_neutral, compute_rv


@pytest.fixture(scope="module")
def rv():
    return compute_rv("EUR")


@pytest.fixture(scope="module", params=["10y10y-5y10y", "2s10s", "1y1y|2y1y|3y1y", "2s5s10s"])
def neutral(request):
    return compute_neutral("EUR", request.param)


def test_hedged_exposures_are_zero(neutral):
    assert neutral["neutral"] is not None
    for f in neutral["hedged"]:
        assert neutral["neutral"]["exposure"][f] == pytest.approx(0, abs=1e-3)


def test_anchor_leg_is_kept(neutral):
    weights = [leg["neutral_weight"] for leg in neutral["legs"]]
    if neutral["group"] == "curve":
        assert neutral["hedged"] == ["level"] and weights[1] == 1.0
    else:
        assert neutral["hedged"] == ["level", "slope"] and weights[1] == 2.0


def test_factors_are_ordered_principal_components(neutral):
    shares = [f["variance_share"] for f in neutral["factors"]]
    assert [f["name"] for f in neutral["factors"]] == ["level", "slope", "curvature"]
    assert shares == sorted(shares, reverse=True) and sum(shares) <= 1 + 1e-9
    level = [p["loading"] for p in neutral["factors"][0]["loadings"]]
    assert sum(level) > 0   # level means rates up


def test_monitor_matches_detail(rv, neutral):
    row = next(r for r in rv["rv_monitor"] if r["label"] == neutral["label"])
    assert row["neutral_zscore_1y"] == pytest.approx(neutral["neutral"]["zscore_1y"], abs=0.01)
    assert row["factor_share"] == pytest.approx(neutral["factor_share"], abs=1e-3)
    assert row["neutral_weights"] == pytest.approx([leg["neutral_weight"] for leg in neutral["legs"]], abs=1e-3)
    assert row["zscore_1y"] == pytest.approx(neutral["standard"]["zscore_1y"], abs=0.01)


def test_carry_is_weighted_leg_carry(neutral):
    for key, wkey in (("standard", "weight"), ("neutral", "neutral_weight")):
        expected = sum(leg[wkey] * leg["carry1y_bps"] for leg in neutral["legs"])
        assert neutral[key]["carry1y_bps"] == pytest.approx(expected, abs=0.05)


def test_every_row_has_a_factor_share(rv):
    for r in rv["rv_monitor"]:
        assert 0 <= r["factor_share"] <= 1
        assert (r["neutral_weights"] is None) == (r["neutral_zscore_1y"] is None)


def test_unknown_label_is_a_key_error():
    with pytest.raises(KeyError):
        compute_neutral("EUR", "nope")
