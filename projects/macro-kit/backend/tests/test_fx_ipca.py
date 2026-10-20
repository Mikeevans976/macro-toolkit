"""FX IPCA: ALS recovers a known model, identification and R² identities hold,
characteristics are causal, the alpha test has size and power, and the API
returns the simulated payload."""
from __future__ import annotations

import numpy as np
import pytest
from fastapi.testclient import TestClient

import fx_ipca as fx
import main
from auth import get_current_user


def _synthetic(T=240, N=30, L=4, K=2, noise=0.0, alpha=None, seed=0):
    """Panel from r = z'(Ga + Gb f) + e with Gaussian characteristics."""
    rng = np.random.default_rng(seed)
    Z = rng.standard_normal((T, N, L))
    Z[..., -1] = 1.0
    Gb = np.linalg.qr(rng.standard_normal((L, K)))[0]
    F = 0.02 * rng.standard_normal((T, K)) + 0.005
    R = np.einsum("tnl,lk,tk->tn", Z, Gb, F) + noise * rng.standard_normal((T, N))
    if alpha is not None:
        R += Z @ alpha
    mask = np.ones((T, N), dtype=bool)
    return Z, R, mask, Gb, F


def _span_distance(A, B):
    """Largest principal-angle sine between the column spaces of A and B."""
    qa, qb = np.linalg.qr(A)[0], np.linalg.qr(B)[0]
    s = np.linalg.svd(qa.T @ qb, compute_uv=False)
    return float(np.sqrt(max(0.0, 1 - s.min() ** 2)))


def test_als_recovers_noiseless_model():
    Z, R, mask, Gb, _ = _synthetic()
    m = fx.managed_moments(Z, R, mask)
    fit = fx.fit_ipca(m, 2)
    assert fit.converged
    assert _span_distance(fit.gamma_beta, Gb) < 1e-5
    assert fx.r2_stats(m, fit)["total_r2"] == pytest.approx(1.0, abs=1e-8)


def test_normalization_identifies_and_preserves_fit():
    Z, R, mask, _, _ = _synthetic(noise=0.01, alpha=np.array([0.0, 0.001, 0.0, 0.0]))
    m = fx.managed_moments(Z, R, mask)
    fit = fx.fit_ipca(m, 2, alpha=True)
    Gb, Ga, F = fit.gamma_beta, fit.gamma_alpha, fit.factors
    np.testing.assert_allclose(Gb.T @ Gb, np.eye(2), atol=1e-10)
    cov = F.T @ F
    assert abs(cov[0, 1]) < 1e-8 * cov[0, 0] and cov[0, 0] >= cov[1, 1]
    assert (F.mean(axis=0) > 0).all()
    np.testing.assert_allclose(Gb.T @ Ga, 0.0, atol=1e-10)
    # Rotating Gb and moving alpha into the factors leaves fitted values unchanged
    rng = np.random.default_rng(1)
    Q = np.linalg.qr(rng.standard_normal((2, 2)))[0]
    Gb2, Ga2, F2 = fx._normalize(Gb @ Q * 3.0, Ga + Gb @ np.array([0.01, -0.02]), F @ Q / 3.0
                                 - np.array([0.01, -0.02]) @ Q / 3.0)
    np.testing.assert_allclose(Ga2 + F2 @ Gb2.T, Ga + F @ Gb.T, atol=1e-10)


def test_r2_from_moments_matches_direct_computation():
    Z, R, mask, _, _ = _synthetic(noise=0.02, seed=3)
    mask[::7, ::5] = False
    m = fx.managed_moments(Z, R, mask)
    fit = fx.fit_ipca(m, 2)
    fitted = np.einsum("tnl,lk,tk->tn", Z, fit.gamma_beta, fit.factors)
    pred = Z @ (fit.gamma_beta @ fit.factors.mean(axis=0))
    denom = (R[mask] ** 2).sum()
    stats = fx.r2_stats(m, fit)
    assert stats["total_r2"] == pytest.approx(1 - ((R - fitted)[mask] ** 2).sum() / denom, rel=1e-10)
    assert stats["pred_r2"] == pytest.approx(1 - ((R - pred)[mask] ** 2).sum() / denom, rel=1e-10)


def test_alpha_test_size_and_power():
    Z, R, mask, _, _ = _synthetic(T=180, N=25, noise=0.03, seed=5)
    null = fx.alpha_test(fx.managed_moments(Z, R, mask), 2, n_boot=49, seed=11)
    alt_alpha = np.array([0.0, 0.0, 0.01, 0.0])
    Z, R, mask, _, _ = _synthetic(T=180, N=25, noise=0.03, alpha=alt_alpha, seed=5)
    alt = fx.alpha_test(fx.managed_moments(Z, R, mask), 2, n_boot=49, seed=11)
    assert null["pvalue"] > 0.05
    assert alt["pvalue"] <= 0.04


def test_characteristics_use_only_past_returns():
    rng = np.random.default_rng(2)
    T, N = 90, 4
    R = rng.standard_normal((T, N)) * 0.02
    flat = np.zeros((T, N))
    base = fx.build_characteristics(R, flat, flat, flat)
    t = 70
    R2 = R.copy()
    R2[t:] += 1.0        # returns realised at t+1 or later
    moved = fx.build_characteristics(R2, flat, flat, flat)
    for c in ("mom_3m", "mom_12m", "value"):
        np.testing.assert_array_equal(base[c][:t + 1], moved[c][:t + 1])
        assert not np.allclose(np.nan_to_num(base[c][t + 1:]), np.nan_to_num(moved[c][t + 1:]))
    np.testing.assert_allclose(base["mom_3m"][10], R[7:10].sum(axis=0))
    np.testing.assert_allclose(base["mom_12m"][20], R[8:19].sum(axis=0))


def test_rank_cross_section_bounds_and_missing():
    X = np.array([[3.0, 1.0, np.nan, 2.0], [1.0, 1.0, 1.0, 1.0]])
    alive = np.array([[True, True, True, False], [True, True, True, True]])
    out = fx.rank_cross_section(X, alive)
    np.testing.assert_allclose(out[0], [0.5, -0.5, 0.0, 0.0])
    np.testing.assert_allclose(out[1], 0.0)


def test_rank_weights_are_dollar_neutral():
    w = fx.rank_weights(np.array([0.3, -0.1, 0.2, 0.0, 9.0]), np.array([True, True, True, True, False]))
    assert w.sum() == pytest.approx(0.0, abs=1e-12)
    assert np.abs(w).sum() == pytest.approx(2.0)
    assert w[4] == 0.0 and w[0] > w[2] > w[3] > w[1]


@pytest.fixture(scope="module")
def client():
    main.app.dependency_overrides[get_current_user] = lambda: {"username": "test"}
    yield TestClient(main.app)
    main.app.dependency_overrides.pop(get_current_user, None)


def test_api_payload(client):
    res = client.get("/api/tools/fx-ipca", params={"k": 2, "n_boot": 19})
    assert res.status_code == 200
    d = res.json()
    assert d["data_source"] == "simulation"
    assert [r["k"] for r in d["model_selection"]] == [1, 2, 3, 4]
    assert len(d["gamma_beta"]) == len(fx.CHAR_IDS) and len(d["gamma_beta"][0]) == 2
    assert 0 < d["alpha_test"]["pvalue"] <= 1
    # The simulation is a two-factor model: K=2 explains far more than K=1, then flattens
    r2 = [r["total_r2"] for r in d["model_selection"]]
    assert r2[1] - r2[0] > 0.05 > r2[2] - r2[1]
    assert {r["code"] for r in d["cross_section"]} >= {"EUR", "JPY", "TRY"}
    assert d["oos"]["available"] and len(d["oos"]["strategies"]) == 4

    detail = client.get("/api/tools/fx-ipca/currency/try", params={"k": 2, "n_boot": 19})
    assert detail.status_code == 200
    s = detail.json()["series"]
    assert "beta_F1" in s[-1] and "beta_F2" in s[-1]
    assert client.get("/api/tools/fx-ipca/currency/XXX", params={"n_boot": 19}).status_code == 404
