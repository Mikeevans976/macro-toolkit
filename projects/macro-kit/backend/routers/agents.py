"""
Global Macro Pod API (backend/pod/; design in docs/GLOBAL_MACRO_POD.md).

    /api/agents/...   roster, models, workflows, runs and their SSE streams
    /api/pod/...      trade ledger and risk alerts (the human PM's actions)

Runs belong to the user who started them: run detail and streams 404 for anyone
else. The SSE stream authenticates with a 60-second, run-scoped ticket from
``POST /api/agents/stream/{run_id}/ticket``, never the session token.
"""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from agents.storage import create_run, get_events, get_events_after, get_run, get_runs
from auth import create_stream_ticket, get_current_user, verify_stream_ticket
from pod import book as pod_book
from pod import models as pod_models
from pod.config import anthropic_configured, openrouter_configured
from pod.engine import run_single_agent_background, run_workflow_background
from pod.roster import AGENTS as POD_ALL_AGENTS, ENABLED as POD_AGENTS, roster_entry
from pod.storage import (get_model_overrides as pod_get_model_overrides,
                         get_usage as pod_get_usage, get_views as pod_get_views,
                         set_model_override as pod_set_model_override)
from pod.workflows import WORKFLOWS as POD_WORKFLOWS, workflow_info

router = APIRouter(tags=["agents"])
_authed = [Depends(get_current_user)]

MAX_QUESTION_CHARS = 20_000
STREAM_POLL_SECONDS = 0.3
STREAM_HEARTBEAT_SECONDS = 15
# A run that writes nothing for this long is treated as dead (e.g. the server
# restarted mid-run, leaving its status at "running" forever).
STREAM_STALL_SECONDS = 30 * 60


class RunRequest(BaseModel):
    question: str = Field("", max_length=MAX_QUESTION_CHARS)
    workflow: str = "rates-desk"
    model: Optional[str] = None


class SingleRunRequest(BaseModel):
    question: str = Field("", max_length=MAX_QUESTION_CHARS)
    model: Optional[str] = None


class ModelOverrideRequest(BaseModel):
    model: Optional[str] = None


class TradeDecisionRequest(BaseModel):
    action: Literal["pm_approve", "pm_reject", "mark_live", "close"]
    note: str = Field("", max_length=2_000)


def _pod_model_or_400(model: Optional[str]) -> Optional[str]:
    if not model:
        return None
    try:
        spec = pod_models.validate(model)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if spec.provider == "openrouter" and not openrouter_configured():
        raise HTTPException(status_code=400, detail="OPENROUTER_API_KEY is not set (add it to backend/.env).")
    return spec.spec


def _question_or_400(question: str) -> str:
    question = question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="question is required")
    return question


def _own_run_or_404(run_id: str, username: str) -> dict:
    run = get_run(run_id)
    if not run or run.get("username") != username:
        raise HTTPException(status_code=404, detail="Run not found")
    return run


def _username(user: dict) -> str:
    return user.get("username", "unknown")


# ---------------------------------------------------------------------------
# Roster, models, workflows
# ---------------------------------------------------------------------------

@router.get("/api/agents/roster", dependencies=_authed)
def agents_roster(desk: Optional[str] = None, include_planned: bool = False):
    pool = POD_ALL_AGENTS if include_planned else POD_AGENTS
    agents = [a for a in pool.values() if desk is None or a.desk == desk]
    overrides = pod_get_model_overrides()
    entries = []
    for a in agents:
        e = roster_entry(a)
        e["model_override"] = overrides.get(a.id)
        e["model_label"] = pod_models.resolve(a).label if a.enabled else e["model_id"]
        entries.append(e)
    return {"roster": entries}


@router.get("/api/agents/models", dependencies=_authed)
def agents_models(refresh: bool = False):
    """Models the pod can run on: Claude tiers plus open-weight, tool-capable OpenRouter models."""
    try:
        openrouter = pod_models.openrouter_models(refresh)
        openrouter_error = None
    except Exception as exc:
        openrouter, openrouter_error = [], f"Could not load the OpenRouter catalogue: {exc}"
    return {
        "anthropic": pod_models.anthropic_models(),
        "openrouter": openrouter,
        "anthropic_configured": anthropic_configured(),
        "openrouter_configured": openrouter_configured(),
        "openrouter_error": openrouter_error,
    }


@router.put("/api/agents/{agent_id}/model", dependencies=_authed)
def agents_set_model(agent_id: str, body: ModelOverrideRequest):
    """Set (or clear, with model=null) the stored model override for one agent."""
    if agent_id not in POD_AGENTS:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' not found")
    model = _pod_model_or_400(body.model)
    pod_set_model_override(agent_id, model)
    return {"agent_id": agent_id, "model_override": model}


@router.get("/api/agents/workflows", dependencies=_authed)
def agents_workflows():
    return {"workflows": workflow_info()}


# ---------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------

@router.post("/api/agents/run")
def agents_run(body: RunRequest, current_user: dict = Depends(get_current_user)):
    question = _question_or_400(body.question)
    if body.workflow not in POD_WORKFLOWS:
        raise HTTPException(status_code=400, detail=f"Unknown workflow '{body.workflow}'")
    model = _pod_model_or_400(body.model)

    run_id = str(uuid.uuid4())
    create_run(run_id, question, _username(current_user), agent_id=body.workflow)
    run_workflow_background(run_id, body.workflow, question, model)   # returns immediately
    return {"run_id": run_id, "status": "pending"}


@router.post("/api/agents/{agent_id}/run")
def agent_single_run(agent_id: str, body: SingleRunRequest, current_user: dict = Depends(get_current_user)):
    if agent_id not in POD_AGENTS:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' not found")
    question = _question_or_400(body.question)
    model = _pod_model_or_400(body.model)

    run_id = str(uuid.uuid4())
    create_run(run_id, question, _username(current_user), agent_id=agent_id)
    run_single_agent_background(run_id, agent_id, question, model)   # returns immediately
    return {"run_id": run_id, "status": "pending"}


@router.get("/api/agents/runs")
def agents_runs(agent_id: Optional[str] = None, current_user: dict = Depends(get_current_user)):
    return {"runs": get_runs(username=_username(current_user), agent_id=agent_id)}


@router.get("/api/agents/runs/{run_id}")
def agents_run_detail(run_id: str, current_user: dict = Depends(get_current_user)):
    run = _own_run_or_404(run_id, _username(current_user))
    return {
        "run": run,
        "events": get_events(run_id),
        "views": pod_get_views(run_id=run_id, since_days=3650, limit=200),
        "usage": pod_get_usage(run_id),
    }


@router.post("/api/agents/stream/{run_id}/ticket")
def agents_stream_ticket(run_id: str, current_user: dict = Depends(get_current_user)):
    username = _username(current_user)
    _own_run_or_404(run_id, username)
    return {"ticket": create_stream_ticket(username, run_id)}


def _sse(payload: dict, event_id: Optional[int] = None) -> str:
    head = f"id: {event_id}\n" if event_id is not None else ""
    return f"{head}data: {json.dumps(payload)}\n\n"


@router.get("/api/agents/stream/{run_id}")
async def agents_stream(
    run_id: str,
    request: Request,
    ticket: str = Query(..., description="Stream ticket from POST /api/agents/stream/{run_id}/ticket"),
):
    """
    Server-sent events for one run: every stored event (each sent once, with
    its row id as the SSE id), then live events as the worker writes them,
    then a final ``done``/``error``. Honours ``Last-Event-ID`` on reconnect.
    """
    _own_run_or_404(run_id, verify_stream_ticket(ticket, run_id))
    try:
        last_id = int(request.headers.get("last-event-id") or 0)
    except ValueError:
        last_id = 0

    async def event_generator():
        nonlocal last_id
        seen_synthesis = last_id > 0      # resumed: an earlier connection got it
        last_activity = last_beat = time.monotonic()
        while True:
            # Read the status *before* draining: the worker writes its last
            # event before flipping the status, so a terminal status here means
            # the drain below sees everything.
            run = await asyncio.to_thread(get_run, run_id)
            events = await asyncio.to_thread(get_events_after, run_id, last_id)
            for ev in events:
                last_id = ev["id"]
                seen_synthesis = seen_synthesis or ev["event_type"] == "synthesis"
                yield _sse({"type": ev["event_type"], "agent": ev["agent_name"],
                            "content": ev["content"], "timestamp": ev["timestamp"]}, last_id)

            status = run["status"] if run else "error"
            if status in ("done", "error"):
                if status == "done" and run.get("output") and not seen_synthesis:
                    # Runs stored before the synthesis event was persisted.
                    yield _sse({"type": "synthesis", "agent": "Head of Fixed Income", "content": run["output"]})
                content = ((run or {}).get("output") or "") if status == "error" else ""
                yield _sse({"type": status, "run_id": run_id, "content": content})
                return

            now = time.monotonic()
            if events:
                last_activity = now
            elif now - last_activity > STREAM_STALL_SECONDS:
                yield _sse({"type": "error", "run_id": run_id,
                            "content": "The run stopped reporting progress (the server may have restarted)."})
                return
            if now - last_beat > STREAM_HEARTBEAT_SECONDS:
                last_beat = now
                yield ": keep-alive\n\n"
            await asyncio.sleep(STREAM_POLL_SECONDS)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


# ---------------------------------------------------------------------------
# Trade ledger and alerts
# ---------------------------------------------------------------------------

@router.get("/api/pod/trades", dependencies=_authed)
def pod_trades(status: Optional[str] = None):
    statuses = [x for x in (status or "").split(",") if x] or None
    return {"trades": pod_book.list_trades(statuses=statuses, limit=200)}


@router.get("/api/pod/trades/{trade_id}", dependencies=_authed)
def pod_trade(trade_id: int):
    try:
        return {"trade": pod_book.get(trade_id)}
    except pod_book.LedgerError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.post("/api/pod/trades/{trade_id}/decision")
def pod_trade_decision(trade_id: int, body: TradeDecisionRequest, current_user: dict = Depends(get_current_user)):
    """The human PM's ledger actions: pm_approve, pm_reject, mark_live, close."""
    note = f"{current_user.get('username', 'pm')}: {body.note.strip()}".strip(": ")
    try:
        trade = pod_book.advance(trade_id, body.action, "pm", note)
    except pod_book.LedgerError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"trade": trade}


@router.get("/api/pod/alerts", dependencies=_authed)
def pod_alerts(include_acknowledged: bool = False):
    return {"alerts": pod_book.list_alerts(include_acknowledged)}


@router.post("/api/pod/alerts/{alert_id}/ack", dependencies=_authed)
def pod_alert_ack(alert_id: int):
    pod_book.acknowledge_alert(alert_id)
    return {"ok": True}
