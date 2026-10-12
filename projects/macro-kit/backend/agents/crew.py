"""
Crew assembly, background execution, and SSE event queue management.

run_crew_background() is the entry point called from FastAPI — it
starts the crew in a daemon thread and streams events via a queue.

The SSE endpoint in main.py reads from get_queue(run_id) asynchronously.
"""
import queue
import threading
from datetime import datetime, timezone
from typing import Optional

from crewai import Crew, Process, Task

from agents.agents import (
    macro_strategist,
    rv_analyst,
    inflation_watcher,
    positioning_monitor,
    crew_chief,
    AGENTS_BY_ID,
)
from agents.tasks import build_tasks
from agents.storage import (
    insert_event,
    update_run_status,
)

# ---------------------------------------------------------------------------
# Global queue registry:  run_id → Queue[dict]
# Queues are created at run start and held in memory.
# The SSE consumer reads until it receives a "done" or "error" event.
# ---------------------------------------------------------------------------
_run_queues: dict[str, queue.Queue] = {}


def get_queue(run_id: str) -> Optional[queue.Queue]:
    return _run_queues.get(run_id)


def _put(q: queue.Queue, run_id: str, event_type: str, agent: str, content: str) -> None:
    """Push one event to the queue and persist to DB."""
    event = {
        "type": event_type,
        "agent": agent,
        "content": content,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    q.put(event)
    try:
        insert_event(run_id, agent, event_type, content)
    except Exception:
        pass


def _build_crew(question: str, run_id: str, event_queue: queue.Queue) -> Crew:
    tasks = build_tasks(question)

    # ── step_callback: fires after each LLM agent step ──────────────────────
    def step_callback(step_output):
        try:
            # Extract tool use info if available
            if hasattr(step_output, "tool") and hasattr(step_output, "tool_input"):
                tool_name = getattr(step_output, "tool", "tool")
                content = f"Using tool: {tool_name}"
                evt_type = "tool_use"
            elif hasattr(step_output, "text"):
                content = str(step_output.text)[:600]
                evt_type = "thinking"
            elif hasattr(step_output, "return_values"):
                content = str(step_output.return_values.get("output", ""))[:600]
                evt_type = "step"
            else:
                content = str(step_output)[:600]
                evt_type = "step"
            _put(event_queue, run_id, evt_type, "Working…", content)
        except Exception:
            pass

    # ── task_callback: fires when a task completes ───────────────────────────
    def task_callback(task_output):
        try:
            agent_name = getattr(task_output, "agent", "Agent")
            raw = getattr(task_output, "raw", None) or str(task_output)
            content = str(raw)[:2000]
            _put(event_queue, run_id, "task_done", agent_name, content)
        except Exception:
            pass

    return Crew(
        agents=[macro_strategist, rv_analyst, inflation_watcher, positioning_monitor],
        tasks=tasks,
        process=Process.hierarchical,
        manager_agent=crew_chief,
        step_callback=step_callback,
        task_callback=task_callback,
        memory=False,   # disabled to avoid extra dependencies; history via our own DB
        verbose=True,
    )


def run_crew_background(run_id: str, question: str) -> None:
    """
    Called in a daemon thread from main.py.

    Lifecycle:
      pending → running → done | error
    """
    q: queue.Queue = queue.Queue()
    _run_queues[run_id] = q

    def _worker():
        try:
            update_run_status(run_id, "running")
            _put(q, run_id, "status", "system", "Crew assembling…")

            crew = _build_crew(question, run_id, q)

            _put(q, run_id, "status", "system", "Crew deployed — specialists working…")
            result = crew.kickoff()

            final_output = str(getattr(result, "raw", result))
            update_run_status(run_id, "done", final_output)

            _put(q, run_id, "synthesis", "Head of Fixed Income", final_output)
            q.put({"type": "done", "run_id": run_id, "content": ""})

        except Exception as exc:
            error_msg = f"{type(exc).__name__}: {exc}"
            try:
                update_run_status(run_id, "error", error_msg)
            except Exception:
                pass
            q.put({"type": "error", "run_id": run_id, "content": error_msg})

    thread = threading.Thread(target=_worker, daemon=True, name=f"crew-{run_id[:8]}")
    thread.start()


# ---------------------------------------------------------------------------
# Single-agent run
# ---------------------------------------------------------------------------

def run_single_agent_background(run_id: str, agent_id: str, question: str) -> None:
    """
    Run one specialist (or the Crew Chief) solo on a user question.
    Uses a single-task sequential Crew so callbacks fire the same way.
    """
    q: queue.Queue = queue.Queue()
    _run_queues[run_id] = q

    def _worker():
        agent = AGENTS_BY_ID.get(agent_id)
        if agent is None:
            q.put({"type": "error", "run_id": run_id, "content": f"Unknown agent: {agent_id}"})
            return

        try:
            update_run_status(run_id, "running")
            _put(q, run_id, "status", "system", f"{agent.role} engaged…")

            def step_callback(step_output):
                try:
                    if hasattr(step_output, "tool") and hasattr(step_output, "tool_input"):
                        content = f"Using tool: {getattr(step_output, 'tool', 'tool')}"
                        evt_type = "tool_use"
                    elif hasattr(step_output, "text"):
                        content = str(step_output.text)[:600]
                        evt_type = "thinking"
                    elif hasattr(step_output, "return_values"):
                        content = str(step_output.return_values.get("output", ""))[:600]
                        evt_type = "step"
                    else:
                        content = str(step_output)[:600]
                        evt_type = "step"
                    _put(q, run_id, evt_type, agent.role, content)
                except Exception:
                    pass

            def task_callback(task_output):
                try:
                    raw = getattr(task_output, "raw", None) or str(task_output)
                    content = str(raw)[:2000]
                    _put(q, run_id, "task_done", agent.role, content)
                except Exception:
                    pass

            task = Task(
                description=question,
                expected_output=(
                    "A detailed, expert analysis directly responding to the question. "
                    "Use your tools to gather the latest data, then provide a clear, "
                    "actionable response with specific levels, signals, or observations."
                ),
                agent=agent,
            )

            crew = Crew(
                agents=[agent],
                tasks=[task],
                process=Process.sequential,
                step_callback=step_callback,
                task_callback=task_callback,
                memory=False,
                verbose=True,
            )

            result = crew.kickoff()
            final_output = str(getattr(result, "raw", result))
            update_run_status(run_id, "done", final_output)

            _put(q, run_id, "synthesis", agent.role, final_output)
            q.put({"type": "done", "run_id": run_id, "content": ""})

        except Exception as exc:
            error_msg = f"{type(exc).__name__}: {exc}"
            try:
                update_run_status(run_id, "error", error_msg)
            except Exception:
                pass
            q.put({"type": "error", "run_id": run_id, "content": error_msg})

    thread = threading.Thread(
        target=_worker, daemon=True, name=f"agent-{agent_id[:8]}-{run_id[:6]}"
    )
    thread.start()
