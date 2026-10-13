import asyncio
import json
import logging
import os
import threading
import queue as _queue_module
import uuid
from contextlib import asynccontextmanager
from datetime import timedelta
from pathlib import Path
from typing import Optional

import yaml
from fastapi import Depends, FastAPI, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.security import OAuth2PasswordRequestForm
from fastapi.staticfiles import StaticFiles

from auth import (
    ACCESS_TOKEN_EXPIRE_HOURS,
    authenticate_user,
    bootstrap_admin,
    create_access_token,
    get_current_user,
    verify_token,
)

# Create admin user from env vars on first deploy (no-op if users.json exists)
bootstrap_admin()

from agents.storage import init_db, create_run, get_runs, get_run, get_events
from pod.roster import AGENTS as POD_ALL_AGENTS, ENABLED as POD_AGENTS, roster_entry
from pod.workflows import WORKFLOWS as POD_WORKFLOWS, workflow_info
from pod.storage import (get_views as pod_get_views, get_usage as pod_get_usage,
                         get_model_overrides as pod_get_model_overrides,
                         set_model_override as pod_set_model_override)
from pod import models as pod_models
from pod import book as pod_book
from pod.config import anthropic_configured, openrouter_configured
from pod.engine import run_workflow_background, run_single_agent_background, get_queue

init_db()

from bbg import BloombergUnavailable
from fair_value_models import get_fair_value_models_data  # startup warm-up
from euribor_positioning_router import router as positioning_router
from routers import (
    correlation_regimes,
    egb_rv,
    fair_value_models,
    fitted_bond_curves,
    global_yields,
    heatmaps,
    inflation_fixings,
    inflation_pca,
    mean_reversion,
    momentum,
    option_cdf,
    pca_analysis,
    print_analysis,
    seasonality,
    swaps_rv,
)

# No-op if the host (e.g. a configured uvicorn/gunicorn) already set up logging.
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("analytics_hub")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Fair Value Models takes ~20 s to compute and is cached in-process; warm it
    # in the background so the first visitor after a restart doesn't wait.
    # Set PRECOMPUTE_ON_STARTUP=0 to skip (e.g. while iterating with --reload).
    if os.environ.get("PRECOMPUTE_ON_STARTUP", "1") != "0":
        def _warm() -> None:
            try:
                get_fair_value_models_data()
                logger.info("Fair Value Models cache warmed")
            except Exception:
                logger.exception("Fair Value Models warm-up failed; will compute on first request")
        threading.Thread(target=_warm, name="fvm-warmup", daemon=True).start()
    yield


app = FastAPI(title="Analytics Hub API", version="1.0.0", lifespan=lifespan)

# Compress large JSON payloads (Fair Value Models ~12 MB -> ~1.4 MB). Starlette
# skips text/event-stream, so agent SSE streams are not buffered.
app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=5)



@app.exception_handler(BloombergUnavailable)
def _bloomberg_unavailable(_request, exc: BloombergUnavailable):
    # Live-only endpoints (e.g. seasonality data) when no Bloomberg connection exists.
    return JSONResponse(status_code=503, content={
        "detail": "Bloomberg data is not available on this server (blpapi not installed / Terminal not running)."})


# Include routers
app.include_router(positioning_router)
for _tool in (
    correlation_regimes,
    egb_rv,
    fair_value_models,
    fitted_bond_curves,
    global_yields,
    heatmaps,
    inflation_fixings,
    inflation_pca,
    mean_reversion,
    momentum,
    option_cdf,
    pca_analysis,
    print_analysis,
    seasonality,
    swaps_rv,
):
    app.include_router(_tool.router)

# CORS for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173",
                   "http://localhost:5174", "http://127.0.0.1:5174"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Path to dashboard config (project root, one level above backend/)
CONFIG_PATH = Path(__file__).parent.parent / "dashboard_config.yaml"


def load_dashboard_config() -> dict:
    if not CONFIG_PATH.exists():
        raise HTTPException(
            status_code=500,
            detail=f"Dashboard config not found at {CONFIG_PATH}",
        )
    with open(CONFIG_PATH, "r") as f:
        return yaml.safe_load(f)


# ---------------------------------------------------------------------------
# Auth routes
# ---------------------------------------------------------------------------


@app.post("/api/auth/login")
def login(form_data: OAuth2PasswordRequestForm = Depends()):
    user = authenticate_user(form_data.username, form_data.password)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    access_token = create_access_token(
        data={"sub": user["username"]},
        expires_delta=timedelta(hours=ACCESS_TOKEN_EXPIRE_HOURS),
    )
    return {"access_token": access_token, "token_type": "bearer"}


# ---------------------------------------------------------------------------
# Protected API routes (tool routes live in routers/)
# ---------------------------------------------------------------------------


@app.get("/api/me")
def read_me(current_user: dict = Depends(get_current_user)):
    return {
        "username": current_user["username"],
        "full_name": current_user.get("full_name", ""),
    }


@app.get("/api/dashboard")
def get_dashboard(current_user: dict = Depends(get_current_user)):
    config = load_dashboard_config()
    return config


# ---------------------------------------------------------------------------
# Agents — Global Macro Pod (backend/pod/; design in docs/GLOBAL_MACRO_POD_PROPOSAL.md)
# ---------------------------------------------------------------------------

@app.get("/api/agents/roster")
async def agents_roster(
    desk: Optional[str] = None,
    include_planned: bool = False,
    current_user: dict = Depends(get_current_user),
):
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


@app.get("/api/agents/models")
async def agents_models(refresh: bool = False, current_user: dict = Depends(get_current_user)):
    """Models the pod can run on: Claude tiers plus open-weight, tool-capable OpenRouter models."""
    try:
        openrouter = await asyncio.to_thread(pod_models.openrouter_models, refresh)
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


@app.get("/api/pod/trades")
async def pod_trades(status: Optional[str] = None, current_user: dict = Depends(get_current_user)):
    statuses = [x for x in (status or "").split(",") if x] or None
    return {"trades": pod_book.list_trades(statuses=statuses, limit=200)}


@app.get("/api/pod/trades/{trade_id}")
async def pod_trade(trade_id: int, current_user: dict = Depends(get_current_user)):
    try:
        return {"trade": pod_book.get(trade_id)}
    except pod_book.LedgerError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.post("/api/pod/trades/{trade_id}/decision")
async def pod_trade_decision(trade_id: int, body: dict, current_user: dict = Depends(get_current_user)):
    """The human PM's ledger actions: pm_approve, pm_reject, mark_live, close."""
    action = body.get("action")
    if action not in ("pm_approve", "pm_reject", "mark_live", "close"):
        raise HTTPException(status_code=400, detail="action must be pm_approve, pm_reject, mark_live or close")
    note = (body.get("note") or "").strip()
    try:
        trade = pod_book.advance(trade_id, action, "pm", f"{current_user.get('username', 'pm')}: {note}".strip(": "))
    except pod_book.LedgerError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"trade": trade}


@app.get("/api/pod/alerts")
async def pod_alerts(include_acknowledged: bool = False, current_user: dict = Depends(get_current_user)):
    return {"alerts": pod_book.list_alerts(include_acknowledged)}


@app.post("/api/pod/alerts/{alert_id}/ack")
async def pod_alert_ack(alert_id: int, current_user: dict = Depends(get_current_user)):
    pod_book.acknowledge_alert(alert_id)
    return {"ok": True}


@app.put("/api/agents/{agent_id}/model")
async def agents_set_model(agent_id: str, body: dict, current_user: dict = Depends(get_current_user)):
    """Set (or clear, with model=null) the stored model override for one agent."""
    if agent_id not in POD_AGENTS:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' not found")
    model = _pod_model_or_400(body.get("model"))
    pod_set_model_override(agent_id, model)
    return {"agent_id": agent_id, "model_override": model}


@app.get("/api/agents/workflows")
async def agents_workflows(current_user: dict = Depends(get_current_user)):
    return {"workflows": workflow_info()}


@app.post("/api/agents/run")
async def agents_run(
    body: dict,
    current_user: dict = Depends(get_current_user),
):
    question = (body.get("question") or "").strip()
    if not question:
        raise HTTPException(status_code=400, detail="question is required")
    workflow = body.get("workflow") or "rates-desk"
    if workflow not in POD_WORKFLOWS:
        raise HTTPException(status_code=400, detail=f"Unknown workflow '{workflow}'")

    model = _pod_model_or_400(body.get("model"))

    run_id = str(uuid.uuid4())
    username = current_user.get("username", "unknown")
    create_run(run_id, question, username, agent_id=workflow)
    run_workflow_background(run_id, workflow, question, model)   # returns immediately

    return {"run_id": run_id, "status": "pending"}


@app.get("/api/agents/stream/{run_id}")
async def agents_stream(
    run_id: str,
    token: str = Query(..., description="JWT bearer token (EventSource can't send headers)"),
):
    # Validate token manually (EventSource can't send Authorization header)
    try:
        username = verify_token(token)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    run = get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")

    async def event_generator():
        # 1. Replay already-stored events so late consumers catch up
        stored = get_events(run_id)
        for ev in stored:
            payload = {
                "type": ev["event_type"],
                "agent": ev["agent_name"],
                "content": ev["content"],
                "timestamp": ev["timestamp"],
            }
            yield f"data: {json.dumps(payload)}\n\n"

        # 2. If run already finished, send final state and close
        current_run = get_run(run_id)
        if current_run and current_run["status"] in ("done", "error"):
            replayed_synthesis = any(ev["event_type"] == "synthesis" for ev in stored)
            if current_run["status"] == "done" and current_run.get("output") and not replayed_synthesis:
                yield f"data: {json.dumps({'type': 'synthesis', 'agent': 'Head of Fixed Income', 'content': current_run['output']})}\n\n"
            yield f"data: {json.dumps({'type': current_run['status'], 'run_id': run_id, 'content': ''})}\n\n"
            return

        # 3. Stream live events from the in-memory queue
        q = get_queue(run_id)
        if q is None:
            # Queue not yet created (race condition on fast connections) — wait briefly
            for _ in range(20):
                await asyncio.sleep(0.2)
                q = get_queue(run_id)
                if q is not None:
                    break

        if q is None:
            yield f"data: {json.dumps({'type': 'error', 'run_id': run_id, 'content': 'Queue not found — run may have already completed'})}\n\n"
            return

        while True:
            try:
                event = q.get_nowait()
                yield f"data: {json.dumps(event)}\n\n"
                if event.get("type") in ("done", "error"):
                    break
            except _queue_module.Empty:
                await asyncio.sleep(0.3)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@app.post("/api/agents/{agent_id}/run")
async def agent_single_run(
    agent_id: str,
    body: dict,
    current_user: dict = Depends(get_current_user),
):
    if agent_id not in POD_AGENTS:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' not found")
    question = (body.get("question") or "").strip()
    if not question:
        raise HTTPException(status_code=400, detail="question is required")

    model = _pod_model_or_400(body.get("model"))

    run_id = str(uuid.uuid4())
    username = current_user.get("username", "unknown")
    create_run(run_id, question, username, agent_id=agent_id)
    run_single_agent_background(run_id, agent_id, question, model)   # returns immediately

    return {"run_id": run_id, "status": "pending"}


@app.get("/api/agents/runs")
async def agents_runs(
    agent_id: Optional[str] = None,
    current_user: dict = Depends(get_current_user),
):
    username = current_user.get("username", "unknown")
    runs = get_runs(username=username, agent_id=agent_id)
    return {"runs": runs}


@app.get("/api/agents/runs/{run_id}")
async def agents_run_detail(
    run_id: str,
    current_user: dict = Depends(get_current_user),
):
    run = get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    events = get_events(run_id)
    return {
        "run": run,
        "events": events,
        "views": pod_get_views(run_id=run_id, since_days=3650, limit=200),
        "usage": pod_get_usage(run_id),
    }


# ---------------------------------------------------------------------------
# Serve React build (static files) — mount last so API routes take priority
# ---------------------------------------------------------------------------

FRONTEND_DIST = Path(__file__).parent.parent / "frontend" / "dist"

if FRONTEND_DIST.exists():
    # Serve static assets (JS, CSS, images) first
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIST / "assets")), name="assets")

    # Catch-all: serve index.html for any non-API path so React Router handles routing
    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str):
        index = FRONTEND_DIST / "index.html"
        return FileResponse(str(index))


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
