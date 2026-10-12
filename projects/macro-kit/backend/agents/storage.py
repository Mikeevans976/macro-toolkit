"""
SQLite persistence for agent runs and streamed events.

DB lives at  backend/data/agent_runs.db  (created automatically on first use).
"""
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

_DB_PATH = Path(__file__).parent.parent / "data" / "agent_runs.db"


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(_DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    """Create tables and run any pending migrations. Safe to call on every startup."""
    with _connect() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS runs (
                run_id      TEXT PRIMARY KEY,
                created_at  TEXT NOT NULL,
                question    TEXT NOT NULL,
                status      TEXT NOT NULL DEFAULT 'pending',
                output      TEXT,
                username    TEXT,
                agent_id    TEXT NOT NULL DEFAULT 'fixed-income-pod'
            );

            CREATE TABLE IF NOT EXISTS events (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id      TEXT NOT NULL,
                timestamp   TEXT NOT NULL,
                agent_name  TEXT NOT NULL,
                event_type  TEXT NOT NULL,
                content     TEXT NOT NULL,
                FOREIGN KEY (run_id) REFERENCES runs(run_id)
            );

            CREATE INDEX IF NOT EXISTS idx_events_run_id ON events(run_id);
        """)
        # Migration: add agent_id to existing DBs that pre-date this column.
        # Must run before the index on agent_id is created.
        try:
            conn.execute(
                "ALTER TABLE runs ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'fixed-income-pod'"
            )
        except Exception:
            pass  # Column already exists — expected on fresh installs
        # Now safe to create the index (column guaranteed to exist)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_runs_agent_id ON runs(agent_id)"
        )


def create_run(
    run_id: str,
    question: str,
    username: str,
    agent_id: str = "fixed-income-pod",
) -> None:
    now = datetime.now(timezone.utc).isoformat()
    with _connect() as conn:
        conn.execute(
            "INSERT INTO runs (run_id, created_at, question, status, username, agent_id) "
            "VALUES (?,?,?,?,?,?)",
            (run_id, now, question, "pending", username, agent_id),
        )


def update_run_status(run_id: str, status: str, output: Optional[str] = None) -> None:
    with _connect() as conn:
        if output is not None:
            conn.execute(
                "UPDATE runs SET status=?, output=? WHERE run_id=?",
                (status, output, run_id),
            )
        else:
            conn.execute(
                "UPDATE runs SET status=? WHERE run_id=?",
                (status, run_id),
            )


def insert_event(
    run_id: str,
    agent_name: str,
    event_type: str,
    content: str,
) -> None:
    now = datetime.now(timezone.utc).isoformat()
    with _connect() as conn:
        conn.execute(
            "INSERT INTO events (run_id, timestamp, agent_name, event_type, content) "
            "VALUES (?,?,?,?,?)",
            (run_id, now, agent_name, event_type, content),
        )


def get_runs(
    username: Optional[str] = None,
    agent_id: Optional[str] = None,
    limit: int = 50,
) -> list[dict]:
    conditions = []
    params: list = []
    if username:
        conditions.append("username=?")
        params.append(username)
    if agent_id:
        conditions.append("agent_id=?")
        params.append(agent_id)
    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    params.append(limit)
    with _connect() as conn:
        rows = conn.execute(
            f"SELECT run_id, created_at, question, status, username, agent_id "
            f"FROM runs {where} ORDER BY created_at DESC LIMIT ?",
            params,
        ).fetchall()
    return [dict(r) for r in rows]


def get_run(run_id: str) -> Optional[dict]:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM runs WHERE run_id=?", (run_id,)
        ).fetchone()
    return dict(row) if row else None


def get_events(run_id: str) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT timestamp, agent_name, event_type, content FROM events "
            "WHERE run_id=? ORDER BY id ASC",
            (run_id,),
        ).fetchall()
    return [dict(r) for r in rows]
