"""
Pod tables, stored in the same SQLite file as agents/storage.py (runs, events).

views  — structured views submitted by agents (the standard view format, §2 of
         docs/GLOBAL_MACRO_POD_PROPOSAL.md)
usage  — token usage per agent per run, for cost tracking
agent_models — per-agent model overrides chosen in the UI
"""
import json
from datetime import datetime, timedelta, timezone
from typing import Optional

from agents.storage import _connect, init_db as _init_runs_db


def init_db() -> None:
    _init_runs_db()
    from pod import book
    book.init_db()
    with _connect() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS views (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id        TEXT NOT NULL,
                agent_id      TEXT NOT NULL,
                created_at    TEXT NOT NULL,
                market        TEXT NOT NULL,
                direction     TEXT NOT NULL,
                conviction    INTEGER NOT NULL,
                horizon       TEXT NOT NULL,
                instrument    TEXT NOT NULL,
                catalysts     TEXT NOT NULL,   -- JSON list
                invalidation  TEXT NOT NULL,
                rationale     TEXT NOT NULL,
                evidence      TEXT NOT NULL    -- JSON list of {tool, as_of, data_source}
            );
            CREATE INDEX IF NOT EXISTS idx_views_agent ON views(agent_id, created_at);

            CREATE TABLE IF NOT EXISTS usage (
                id                 INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id             TEXT NOT NULL,
                agent_id           TEXT NOT NULL,
                model              TEXT NOT NULL,
                created_at         TEXT NOT NULL,
                turns              INTEGER NOT NULL,
                input_tokens       INTEGER NOT NULL,
                output_tokens      INTEGER NOT NULL,
                cache_read_tokens  INTEGER NOT NULL,
                cache_write_tokens INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_usage_run ON usage(run_id);

            CREATE TABLE IF NOT EXISTS agent_models (
                agent_id    TEXT PRIMARY KEY,
                model       TEXT NOT NULL,     -- "<provider>:<model id>"
                updated_at  TEXT NOT NULL
            );
        """)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def insert_views(run_id: str, agent_id: str, views: list[dict]) -> int:
    now = _now()
    with _connect() as conn:
        conn.executemany(
            "INSERT INTO views (run_id, agent_id, created_at, market, direction, conviction, horizon, "
            "instrument, catalysts, invalidation, rationale, evidence) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            [(run_id, agent_id, now, v["market"], v["direction"], int(v["conviction"]), v["horizon"],
              v["instrument"], json.dumps(v["catalysts"]), v["invalidation"], v["rationale"],
              json.dumps(v["evidence"])) for v in views],
        )
    return len(views)


def get_views(agent_ids: Optional[list[str]] = None, since_days: int = 7,
              run_id: Optional[str] = None, limit: int = 50) -> list[dict]:
    cond, params = ["created_at >= ?"], [(datetime.now(timezone.utc) - timedelta(days=since_days)).isoformat()]
    if agent_ids:
        cond.append(f"agent_id IN ({','.join('?' * len(agent_ids))})")
        params += agent_ids
    if run_id:
        cond.append("run_id = ?")
        params.append(run_id)
    params.append(limit)
    with _connect() as conn:
        rows = conn.execute(
            f"SELECT * FROM views WHERE {' AND '.join(cond)} ORDER BY created_at DESC LIMIT ?", params
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["catalysts"] = json.loads(d["catalysts"])
        d["evidence"] = json.loads(d["evidence"])
        out.append(d)
    return out


def insert_usage(run_id: str, agent_id: str, model: str, turns: int, usage: dict) -> None:
    with _connect() as conn:
        conn.execute(
            "INSERT INTO usage (run_id, agent_id, model, created_at, turns, input_tokens, output_tokens, "
            "cache_read_tokens, cache_write_tokens) VALUES (?,?,?,?,?,?,?,?,?)",
            (run_id, agent_id, model, _now(), turns, usage["input_tokens"], usage["output_tokens"],
             usage["cache_read_input_tokens"], usage["cache_creation_input_tokens"]),
        )


def get_usage(run_id: str) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM usage WHERE run_id=? ORDER BY id", (run_id,)).fetchall()
    return [dict(r) for r in rows]


def latest_output(agent_ids: list[str]) -> Optional[dict]:
    with _connect() as conn:
        row = conn.execute(
            f"SELECT run_id, created_at, question, output FROM runs WHERE status='done' "
            f"AND agent_id IN ({','.join('?' * len(agent_ids))}) ORDER BY created_at DESC LIMIT 1",
            agent_ids,
        ).fetchone()
    return dict(row) if row else None


def search_runs(query: str, limit: int = 5) -> list[dict]:
    like = f"%{query}%"
    with _connect() as conn:
        rows = conn.execute(
            "SELECT run_id, created_at, agent_id, question, output FROM runs WHERE status='done' "
            "AND (question LIKE ? OR output LIKE ?) ORDER BY created_at DESC LIMIT ?",
            (like, like, limit),
        ).fetchall()
    return [dict(r) for r in rows]


def get_model_override(agent_id: str) -> Optional[str]:
    with _connect() as conn:
        row = conn.execute("SELECT model FROM agent_models WHERE agent_id=?", (agent_id,)).fetchone()
    return row["model"] if row else None


def get_model_overrides() -> dict[str, str]:
    with _connect() as conn:
        return {r["agent_id"]: r["model"] for r in conn.execute("SELECT agent_id, model FROM agent_models")}


def set_model_override(agent_id: str, model: Optional[str]) -> None:
    with _connect() as conn:
        if model is None:
            conn.execute("DELETE FROM agent_models WHERE agent_id=?", (agent_id,))
        else:
            conn.execute(
                "INSERT INTO agent_models (agent_id, model, updated_at) VALUES (?,?,?) "
                "ON CONFLICT(agent_id) DO UPDATE SET model=excluded.model, updated_at=excluded.updated_at",
                (agent_id, model, _now()),
            )
