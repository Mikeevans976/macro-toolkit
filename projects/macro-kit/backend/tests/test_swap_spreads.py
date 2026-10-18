"""Swap Spreads & Basis endpoints: payload shape and agreement between the two routes."""
import pytest
from fastapi.testclient import TestClient

import main
from auth import get_current_user


@pytest.fixture(scope="module")
def client():
    main.app.dependency_overrides[get_current_user] = lambda: {"username": "t", "full_name": "T"}
    yield TestClient(main.app)
    main.app.dependency_overrides.clear()


@pytest.mark.parametrize("target", ["USD", "EUR", "GBP", "JPY"])
def test_payload(client, target):
    r = client.get(f"/api/tools/swap-spreads?target={target}")
    assert r.status_code == 200
    d = r.json()
    assert d["data_source"] == "simulation"
    assert d["target_ccy"] == target
    assert len(d["bonds"]) == 24
    assert {m["ccy"] for m in d["markets"]} == {"USD", "EUR", "GBP", "JPY"}
    for b in d["bonds"]:
        if b["ccy"] == target:          # no basis swap in the home currency
            assert b["conversion_factor"] == 1.0
            assert b["target_spread_bp"] == pytest.approx(b["par_asw_bp"], abs=0.01)


def test_breakdown_matches_table(client):
    table = {b["bond_id"]: b for b in client.get("/api/tools/swap-spreads?target=GBP").json()["bonds"]}
    r = client.get("/api/tools/swap-spreads/bond?bond_id=UST-10Y&target=GBP")
    assert r.status_code == 200
    d = r.json()
    assert d["home_rfr"] == "SOFR" and d["target_rfr"] == "SONIA"
    assert d["steps"]["target_spread_bp"] == pytest.approx(table["UST-10Y"]["target_spread_bp"], abs=0.01)
    assert sum(cf["pv"] for cf in d["cashflows"]) == pytest.approx(d["steps"]["pv_on_swap_curve"], abs=1e-3)


def test_unknown_bond_is_404(client):
    assert client.get("/api/tools/swap-spreads/bond?bond_id=NOPE").status_code == 404


def test_unknown_target_is_422(client):
    assert client.get("/api/tools/swap-spreads?target=CHF").status_code == 422


def test_issuer_curves_fit_their_bonds(client):
    d = client.get("/api/tools/swap-spreads?target=USD").json()
    assert [c["issuer"] for c in d["issuer_curves"]] == ["UST", "Bund", "OAT", "BTP", "Gilt", "JGB"]
    for c in d["issuer_curves"]:
        bonds = [b for b in d["bonds"] if b["issuer"] == c["issuer"]]
        tenors = [p["tenor"] for p in c["points"]]
        assert tenors == sorted(tenors)
        assert tenors[0] == pytest.approx(min(b["ttm"] for b in bonds), abs=1e-3)
        assert tenors[-1] == pytest.approx(max(b["ttm"] for b in bonds), abs=1e-3)
        # 3-parameter fit through 4 bonds: close to each bond, not through it
        for b in bonds:
            nearest = min(c["points"], key=lambda p: abs(p["tenor"] - b["ttm"]))
            assert abs(nearest["bp"] - b["target_spread_bp"]) < 15
