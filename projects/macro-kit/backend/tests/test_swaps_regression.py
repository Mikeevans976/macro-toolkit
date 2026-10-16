"""Swaps RV regression detail: consistent with the Beta Monitor and internally exact."""

import pytest

from swaps_rv import compute_regression, compute_rv

LABEL = "10y10y-5y10y"


@pytest.fixture(scope="module")
def rv():
    return compute_rv("EUR")


@pytest.fixture(scope="module")
def reg():
    return compute_regression("EUR", LABEL)


def test_matches_beta_monitor(rv, reg):
    row = next(b for b in rv["beta_monitor"] if b["label"] == LABEL)
    for f in reg["factors"]:
        assert f["beta"] == pytest.approx(row[f"beta_{f['name']}"], abs=1e-3)
    assert reg["r2"] == pytest.approx(row["r2"], abs=1e-3)
    assert reg["residual_zscore"] == pytest.approx(row["residual_zscore"], abs=1e-2)


def test_attribution_adds_up(reg):
    factors = [f["name"] for f in reg["factors"]]
    for row in reg["attribution"]:
        parts = sum(row[f] for f in factors) + row["intercept"] + row["residual"]
        assert parts == pytest.approx(row["actual"], abs=0.01)


def test_window_sizes(reg):
    assert reg["n_obs"] == len(reg["residuals"]) == len(reg["attribution"]) == 252
    assert reg["rolling_window"] == 63
    assert reg["rolling"][-1]["date"] == reg["residuals"][-1]["date"]


def test_full_window_rolling_point_equals_the_fit():
    r = compute_regression("EUR", LABEL, window=252)
    last = r["rolling"][-1]
    for f in r["factors"]:
        assert last[f["name"]] == pytest.approx(f["beta"], abs=1e-3)


def test_unknown_structure():
    with pytest.raises(KeyError):
        compute_regression("EUR", "not-a-structure")
