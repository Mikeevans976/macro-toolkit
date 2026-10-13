"""
Stage 10 integration tests.
Uses FastAPI TestClient to verify endpoints respond correctly.
"""
import json

import bcrypt
import pytest
from fastapi.testclient import TestClient

import auth
from main import app

client = TestClient(app)


@pytest.fixture(scope="module")
def auth_headers(tmp_path_factory):
    """Log in through the real endpoint as a throwaway user (no real credentials in the repo)."""
    users = tmp_path_factory.mktemp("auth") / "users.json"
    hashed = bcrypt.hashpw(b"integration-test", bcrypt.gensalt()).decode()
    users.write_text(json.dumps({"it-user": {"username": "it-user", "full_name": "IT", "hashed_password": hashed}}))
    saved = auth.USERS_FILE, auth._users_cache
    auth.USERS_FILE, auth._users_cache = str(users), None
    try:
        resp = client.post("/api/auth/login", data={"username": "it-user", "password": "integration-test"})
        assert resp.status_code == 200, resp.text
        yield {"Authorization": f"Bearer {resp.json()['access_token']}"}
    finally:
        auth.USERS_FILE, auth._users_cache = saved


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
