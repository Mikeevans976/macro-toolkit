"""
Background execution and SSE queues for pod runs.

Same interface main.py used with the CrewAI engine (agents/crew.py):
start a run in a daemon thread, push events to an in-memory queue that the
SSE endpoint drains, and persist every event to SQLite for replay.
"""
import asyncio
import queue
import threading
from datetime import datetime, timezone
from typing import Awaitable, Callable, Optional

from agents.storage import insert_event, update_run_status
from pod import storage
from pod.config import MAX_CONCURRENT_AGENTS
from pod.roster import ENABLED
from pod.runner import AgentResult, Runner
from pod.workflows import WORKFLOWS, single_agent

storage.init_db()

_run_queues: dict[str, queue.Queue] = {}


def get_queue(run_id: str) -> Optional[queue.Queue]:
    return _run_queues.get(run_id)


def _start(run_id: str, label: str, make: Callable[[Runner], Awaitable[AgentResult]],
           model: Optional[str] = None) -> None:
    q: queue.Queue = queue.Queue()
    _run_queues[run_id] = q

    def emit(event_type: str, agent: str, content: str) -> None:
        q.put({"type": event_type, "agent": agent, "content": content,
               "timestamp": datetime.now(timezone.utc).isoformat()})
        try:
            insert_event(run_id, agent, event_type, content)
        except Exception:
            pass   # the live feed matters more than the replay copy

    def worker() -> None:
        try:
            update_run_status(run_id, "running")
            emit("status", "system", f"{label} started")
            result = asyncio.run(make(Runner(run_id, emit, MAX_CONCURRENT_AGENTS, model_override=model)))
            if not result.ok and not result.text:
                raise RuntimeError(result.error)
            update_run_status(run_id, "done", result.text)
            emit("synthesis", result.name, result.text)
            q.put({"type": "done", "run_id": run_id, "content": ""})
        except Exception as exc:
            msg = f"{type(exc).__name__}: {exc}"
            try:
                update_run_status(run_id, "error", msg)
            except Exception:
                pass
            q.put({"type": "error", "run_id": run_id, "content": msg})

    threading.Thread(target=worker, daemon=True, name=f"pod-{run_id[:8]}").start()


def run_workflow_background(run_id: str, workflow: str, question: str, model: Optional[str] = None) -> None:
    """model: optional "<provider>:<id>" applied to every agent in the run."""
    label, fn = WORKFLOWS[workflow]
    _start(run_id, label, lambda runner: fn(runner, question), model)


def run_single_agent_background(run_id: str, agent_id: str, question: str, model: Optional[str] = None) -> None:
    agent = ENABLED[agent_id]
    _start(run_id, agent.name, lambda runner: single_agent(runner, agent_id, question), model)
