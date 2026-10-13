"""Agent run API: ownership, stream tickets and the DB-tailing SSE stream."""
import json

import pytest
from fastapi.testclient import TestClient

import auth
from agents import storage


@pytest.fixture
def api(tmp_path, monkeypatch):
    """TestClient with a temp runs DB and two users, alice and bob."""
    monkeypatch.setattr(storage, "_DB_PATH", tmp_path / "runs.db")
    users = tmp_path / "users.json"
    users.write_text(json.dumps({u: {"username": u, "hashed_password": "x"} for u in ("alice", "bob")}))
    monkeypatch.setattr(auth, "USERS_FILE", str(users))
    monkeypatch.setattr(auth, "_users_cache", None)
    from pod import storage as pod_storage
    pod_storage.init_db()
    import main
    return TestClient(main.app)


def _h(user):
    return {"Authorization": f"Bearer {auth.create_access_token({'sub': user})}"}


def _sse_events(text):
    return [json.loads(line[len("data: "):]) for line in text.splitlines() if line.startswith("data: ")]


def _finished_run(run_id="r1", user="alice"):
    storage.create_run(run_id, "q?", user, agent_id="rates-desk")
    storage.insert_event(run_id, "system", "status", "started")
    storage.insert_event(run_id, "Rates", "agent_done", "view")
    storage.insert_event(run_id, "Head", "synthesis", "final answer")
    storage.update_run_status(run_id, "done", "final answer")


def test_run_detail_and_ticket_are_owner_only(api):
    _finished_run()
    assert api.get("/api/agents/runs/r1", headers=_h("alice")).status_code == 200
    assert api.get("/api/agents/runs/r1", headers=_h("bob")).status_code == 404
    assert api.post("/api/agents/stream/r1/ticket", headers=_h("bob")).status_code == 404
    assert api.post("/api/agents/stream/r1/ticket").status_code == 401


def test_stream_requires_a_ticket_for_that_run(api):
    _finished_run("r1")
    _finished_run("r2")
    session_token = auth.create_access_token({"sub": "alice"})
    assert api.get("/api/agents/stream/r1", params={"ticket": session_token}).status_code == 401
    other = api.post("/api/agents/stream/r2/ticket", headers=_h("alice")).json()["ticket"]
    assert api.get("/api/agents/stream/r1", params={"ticket": other}).status_code == 401
    assert api.get("/api/agents/stream/r1").status_code == 422


def test_stream_sends_each_stored_event_once_then_done(api):
    _finished_run()
    ticket = api.post("/api/agents/stream/r1/ticket", headers=_h("alice")).json()["ticket"]
    resp = api.get("/api/agents/stream/r1", params={"ticket": ticket})
    assert resp.status_code == 200
    events = _sse_events(resp.text)
    assert [e["type"] for e in events] == ["status", "agent_done", "synthesis", "done"]
    assert "id: 3" in resp.text


def test_stream_resumes_after_last_event_id(api):
    _finished_run()
    ticket = api.post("/api/agents/stream/r1/ticket", headers=_h("alice")).json()["ticket"]
    resp = api.get("/api/agents/stream/r1", params={"ticket": ticket}, headers={"Last-Event-ID": "2"})
    assert [e["type"] for e in _sse_events(resp.text)] == ["synthesis", "done"]


def test_stream_error_carries_the_message(api):
    storage.create_run("r1", "q?", "alice")
    storage.update_run_status("r1", "error", "RuntimeError: boom")
    ticket = api.post("/api/agents/stream/r1/ticket", headers=_h("alice")).json()["ticket"]
    events = _sse_events(api.get("/api/agents/stream/r1", params={"ticket": ticket}).text)
    assert events[-1] == {"type": "error", "run_id": "r1", "content": "RuntimeError: boom"}


def test_stream_tails_a_live_run(api, monkeypatch):
    """Events written while the client is connected arrive, in order, then done."""
    from routers import agents as agents_router
    storage.create_run("r1", "q?", "alice")
    storage.update_run_status("r1", "running")
    real_get_run, polls = storage.get_run, {"n": 0}

    def get_run_and_progress(run_id):
        # Simulate the worker: one new event per poll, then synthesis + done.
        polls["n"] += 1
        if polls["n"] <= 2:
            storage.insert_event(run_id, "A", "agent_step", f"step {polls['n']}")
        elif polls["n"] == 3:
            storage.insert_event(run_id, "Head", "synthesis", "answer")
            storage.update_run_status(run_id, "done", "answer")
        return real_get_run(run_id)

    monkeypatch.setattr(agents_router, "get_run", get_run_and_progress)
    monkeypatch.setattr(agents_router, "STREAM_POLL_SECONDS", 0)
    ticket = auth.create_stream_ticket("alice", "r1")
    events = _sse_events(api.get("/api/agents/stream/r1", params={"ticket": ticket}).text)
    assert [(e["type"], e.get("content")) for e in events] == [
        ("agent_step", "step 1"), ("agent_step", "step 2"), ("synthesis", "answer"), ("done", "")]


def test_trade_decision_validates_action(api):
    resp = api.post("/api/pod/trades/1/decision", json={"action": "yolo"}, headers=_h("alice"))
    assert resp.status_code == 422


def test_empty_question_is_400(api):
    resp = api.post("/api/agents/run", json={"question": "  "}, headers=_h("alice"))
    assert resp.status_code == 400 and resp.json()["detail"] == "question is required"
