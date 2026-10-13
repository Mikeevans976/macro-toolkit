"""
Background execution for pod runs.

A run executes in a daemon thread and writes every event to SQLite; the SSE
endpoint (routers/agents.py) tails the events table, so there is no in-memory
queue to leak, late or reconnecting clients get each event exactly once, and
the stream works across worker processes.
"""
import asyncio
import logging
import threading
from typing import Awaitable, Callable, Optional

from agents.storage import insert_event, update_run_status
from pod import storage
from pod.config import MAX_CONCURRENT_AGENTS
from pod.roster import ENABLED
from pod.runner import AgentResult, Runner
from pod.workflows import WORKFLOWS, single_agent

storage.init_db()

logger = logging.getLogger(__name__)


def _start(run_id: str, label: str, make: Callable[[Runner], Awaitable[AgentResult]],
           model: Optional[str] = None) -> None:
    def emit(event_type: str, agent: str, content: str) -> None:
        try:
            insert_event(run_id, agent, event_type, content)
        except Exception:
            logger.exception("Could not store %s event for run %s", event_type, run_id)

    def worker() -> None:
        try:
            update_run_status(run_id, "running")
            emit("status", "system", f"{label} started")
            result = asyncio.run(make(Runner(run_id, emit, MAX_CONCURRENT_AGENTS, model_override=model)))
            if not result.ok and not result.text:
                raise RuntimeError(result.error)
            # Synthesis event before the status flip: the stream drains events
            # after it sees a terminal status, so it cannot miss the synthesis.
            emit("synthesis", result.name, result.text)
            update_run_status(run_id, "done", result.text)
        except Exception as exc:
            msg = f"{type(exc).__name__}: {exc}"
            try:
                update_run_status(run_id, "error", msg)
            except Exception:
                logger.exception("Could not mark run %s as failed", run_id)

    threading.Thread(target=worker, daemon=True, name=f"pod-{run_id[:8]}").start()


def run_workflow_background(run_id: str, workflow: str, question: str, model: Optional[str] = None) -> None:
    """model: optional "<provider>:<id>" applied to every agent in the run."""
    label, fn = WORKFLOWS[workflow]
    _start(run_id, label, lambda runner: fn(runner, question), model)


def run_single_agent_background(run_id: str, agent_id: str, question: str, model: Optional[str] = None) -> None:
    agent = ENABLED[agent_id]
    _start(run_id, agent.name, lambda runner: single_agent(runner, agent_id, question), model)
