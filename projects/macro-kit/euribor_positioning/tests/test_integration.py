"""
Stage 10 integration tests.
Uses FastAPI TestClient to verify endpoints respond correctly.
"""
import pytest
from fastapi.testclient import TestClient

# Add backend to path
# test file: euribor_positioning/tests/test_integration.py
# backend:   macro-kit/backend/  (2 levels up from euribor_positioning, then into backend)
from main import app

client = TestClient(app)


# Get a valid token for auth
def get_token():
    resp = client.post(
        "/api/auth/login",
        data={"username": "gerardo", "password": "gerardo123"},
    )
    if resp.status_code != 200:
        pytest.skip(f"Auth failed ({resp.status_code}) — user 'gerardo' may not exist in this environment")
    return resp.json().get("access_token", "")


@pytest.fixture(scope="module")
def auth_headers():
    token = get_token()
    if not token:
        pytest.skip("Could not obtain auth token")
    return {"Authorization": f"Bearer {token}"}


def test_status_endpoint(auth_headers):
    resp = client.get("/api/positioning/status", headers=auth_headers)
    assert resp.status_code == 200
    data = resp.json()
    assert "initialised" in data


def test_init_endpoint(auth_headers):
    resp = client.post("/api/positioning/init", headers=auth_headers)
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"


def test_status_after_init(auth_headers):
    client.post("/api/positioning/init", headers=auth_headers)
    resp = client.get("/api/positioning/status", headers=auth_headers)
    assert resp.status_code == 200
    data = resp.json()
    assert data["initialised"] is True
    assert data["euribor_contract_count"] > 0


def test_dashboard_endpoint_after_init(auth_headers):
    client.post("/api/positioning/init", headers=auth_headers)
    resp = client.get("/api/positioning/dashboard", headers=auth_headers)
    assert resp.status_code == 200
    data = resp.json()
    assert "panels" in data
    assert "dv01_by_bucket" in data["panels"]


def test_panel_endpoint(auth_headers):
    client.post("/api/positioning/init", headers=auth_headers)
    for panel in [
        "dv01_by_bucket",
        "crowding",
        "centre_of_gravity",
        "quadrant_mix",
        "curve_positioning",
        "cot_reconciliation",
    ]:
        resp = client.get(f"/api/positioning/panel/{panel}", headers=auth_headers)
        assert resp.status_code == 200, f"Panel {panel} returned {resp.status_code}: {resp.text}"


def test_panel_unknown_returns_404(auth_headers):
    resp = client.get("/api/positioning/panel/nonexistent", headers=auth_headers)
    assert resp.status_code == 404


def test_diagnostics_endpoint(auth_headers):
    client.post("/api/positioning/init", headers=auth_headers)
    resp = client.get("/api/positioning/diagnostics", headers=auth_headers)
    assert resp.status_code == 200


def test_unauthenticated_returns_401():
    resp = client.get("/api/positioning/dashboard")
    assert resp.status_code == 401
