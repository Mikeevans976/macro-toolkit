"""Auth: JWT round-trip/expiry/tamper handling and the users.json mtime cache."""
import json
import os
import time
from datetime import timedelta

import pytest
from fastapi import HTTPException

import auth


def test_token_round_trip():
    token = auth.create_access_token({"sub": "alice"})
    assert auth.verify_token(token) == "alice"


def test_expired_token_rejected():
    token = auth.create_access_token({"sub": "alice"}, expires_delta=timedelta(seconds=-1))
    with pytest.raises(HTTPException) as exc:
        auth.verify_token(token)
    assert exc.value.status_code == 401


def test_tampered_token_rejected():
    token = auth.create_access_token({"sub": "alice"})
    head, payload, sig = token.split(".")
    bad = f"{head}.{payload}.{sig[:-2]}{'AA' if sig[-2:] != 'AA' else 'BB'}"
    with pytest.raises(HTTPException):
        auth.verify_token(bad)


def test_token_without_subject_rejected():
    token = auth.create_access_token({"role": "x"})
    with pytest.raises(HTTPException):
        auth.verify_token(token)


def test_secret_is_never_the_old_hardcoded_default():
    assert not auth.SECRET_KEY.startswith("dev-secret-key")


def test_users_cache_reloads_on_change(tmp_path, monkeypatch):
    users = tmp_path / "users.json"
    monkeypatch.setattr(auth, "USERS_FILE", str(users))
    monkeypatch.setattr(auth, "_users_cache", None)
    assert auth.load_users() == {}

    users.write_text(json.dumps({"a": {"username": "a"}}))
    assert set(auth.load_users()) == {"a"}

    users.write_text(json.dumps({"a": {"username": "a"}, "b": {"username": "b"}}))
    future = time.time() + 5          # force a distinct mtime on coarse filesystems
    os.utime(users, (future, future))
    assert set(auth.load_users()) == {"a", "b"}


def test_login_and_me_end_to_end(tmp_path, monkeypatch):
    import bcrypt
    from fastapi.testclient import TestClient
    import main

    users = tmp_path / "users.json"
    hashed = bcrypt.hashpw(b"pw", bcrypt.gensalt()).decode()
    users.write_text(json.dumps({"bob": {"username": "bob", "full_name": "Bob", "hashed_password": hashed}}))
    monkeypatch.setattr(auth, "USERS_FILE", str(users))
    monkeypatch.setattr(auth, "_users_cache", None)

    client = TestClient(main.app)
    assert client.post("/api/auth/login", data={"username": "bob", "password": "nope"}).status_code == 401
    resp = client.post("/api/auth/login", data={"username": "bob", "password": "pw"})
    assert resp.status_code == 200
    token = resp.json()["access_token"]
    me = client.get("/api/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200 and me.json()["username"] == "bob"
    assert client.get("/api/me").status_code == 401


def _protected_routes():
    """(method, concrete path) for every API route except login and the SSE stream
    (which authenticates with a stream ticket; see test_agents_api.py).

    Enumerated from the OpenAPI schema: newer FastAPI keeps included routers as
    nested entries in app.routes, so walking app.routes would miss them.
    """
    import re
    import main
    for path, ops in main.app.openapi()["paths"].items():
        if not path.startswith(("/api/tools", "/api/positioning", "/api/agents", "/api/pod")) \
                or path == "/api/agents/stream/{run_id}":
            continue
        for method in ops:
            yield method.upper(), re.sub(r"\{[^}]+\}", "x", path)
    yield "GET", "/api/tools/uk-heatmap/factors"   # legacy alias, hidden from the schema


def test_every_api_route_requires_auth():
    from fastapi.testclient import TestClient
    import main
    client = TestClient(main.app)
    routes = list(_protected_routes())
    assert len(routes) >= 50
    unprotected = [(m, p) for m, p in routes
                   if client.request(m, p, json={}).status_code != 401]
    assert not unprotected, f"routes reachable without a token: {unprotected}"


def test_stream_ticket_is_not_a_session_token():
    ticket = auth.create_stream_ticket("alice", "run-1")
    assert auth.verify_stream_ticket(ticket, "run-1") == "alice"
    with pytest.raises(HTTPException):
        auth.verify_token(ticket)                      # can't be used as a bearer token
    with pytest.raises(HTTPException):
        auth.verify_stream_ticket(ticket, "run-2")     # scoped to one run
    with pytest.raises(HTTPException):
        auth.verify_stream_ticket(auth.create_access_token({"sub": "alice"}), "run-1")


def test_stream_ticket_expires(monkeypatch):
    monkeypatch.setattr(auth, "STREAM_TICKET_SECONDS", -1)
    with pytest.raises(HTTPException):
        auth.verify_stream_ticket(auth.create_stream_ticket("alice", "run-1"), "run-1")


def test_dev_secret_key_is_persisted(tmp_path, monkeypatch):
    import runtime_paths
    monkeypatch.setattr(runtime_paths, "STATE_DIR", tmp_path)
    monkeypatch.setattr(auth, "settings", auth.settings.__class__(**{**auth.settings.__dict__, "secret_key": ""}))
    first = auth._resolve_secret_key()
    assert len(first) >= 32 and (tmp_path / "dev_secret_key").read_text() == first
    assert oct((tmp_path / "dev_secret_key").stat().st_mode & 0o777) == "0o600"
    assert auth._resolve_secret_key() == first          # same key after a "restart"


def test_explicit_secret_key_wins(monkeypatch):
    monkeypatch.setattr(auth, "settings", auth.settings.__class__(**{**auth.settings.__dict__, "secret_key": "k" * 40}))
    assert auth._resolve_secret_key() == "k" * 40


def test_login_rate_limiter_window():
    now = [0.0]
    lim = auth.LoginRateLimiter(max_failures=3, window_seconds=60, clock=lambda: now[0])
    for _ in range(3):
        assert lim.retry_after("ip:a") == 0
        lim.record_failure("ip:a")
    assert lim.retry_after("ip:a") == 61               # blocked until the oldest failure expires
    assert lim.retry_after("ip:b") == 0                 # other keys unaffected
    now[0] = 30.0
    assert lim.retry_after("ip:a") == 31
    now[0] = 60.0
    assert lim.retry_after("ip:a") == 0                 # window passed
    lim.record_failure("user:x"); lim.record_failure("user:x"); lim.record_failure("user:x")
    lim.reset("user:x")
    assert lim.retry_after("user:x") == 0


def test_login_returns_429_after_repeated_failures(tmp_path, monkeypatch):
    import bcrypt
    from fastapi.testclient import TestClient
    import main

    users = tmp_path / "users.json"
    hashed = bcrypt.hashpw(b"pw", bcrypt.gensalt()).decode()
    users.write_text(json.dumps({"bob": {"username": "bob", "hashed_password": hashed}}))
    monkeypatch.setattr(auth, "USERS_FILE", str(users))
    monkeypatch.setattr(auth, "_users_cache", None)
    monkeypatch.setattr(main, "login_limiter", auth.LoginRateLimiter(max_failures=3, window_seconds=300))

    client = TestClient(main.app)
    for _ in range(3):
        assert client.post("/api/auth/login", data={"username": "bob", "password": "nope"}).status_code == 401
    blocked = client.post("/api/auth/login", data={"username": "bob", "password": "pw"})
    assert blocked.status_code == 429 and int(blocked.headers["Retry-After"]) > 0
    assert "Too many failed login attempts" in blocked.json()["detail"]
