"""Auth: JWT round-trip/expiry/tamper handling and the users.json mtime cache."""
import json
import os
import sys
import time
from datetime import timedelta
from pathlib import Path

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import auth  # noqa: E402


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
