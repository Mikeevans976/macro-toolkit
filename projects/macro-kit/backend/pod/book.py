"""
The trade ledger and alerts (§6.3 of docs/GLOBAL_MACRO_POD.md).

Every trade idea moves through a fixed status machine. Each transition is
owned by one role, so no gate can be skipped:

    proposed ──sponsor──▶ sponsored ──challenge──▶ challenged ──size──▶ sized
        ──risk_approve──▶ risk_approved ──pm_approve (human)──▶ pm_approved
        ──mark_live (human)──▶ live ──close (human)──▶ closed

    reject: the Red Team (verdict "reject"), the CRO (risk_block) or the PM
    can send any pre-live trade to `rejected`.

Agents act through pod/tools/book_tools.py; the human PM acts through the
API (main.py). Risk numbers use `pnl_per_bp_k`: P&L in thousands for a +1bp
move in the trade's rate risk factor (a long-duration trade is negative).
"""
from datetime import datetime, timezone
from typing import Optional

from agents.storage import _connect

STATUSES = ["proposed", "sponsored", "challenged", "sized", "risk_approved",
            "pm_approved", "live", "closed", "rejected"]

# action → (allowed from-statuses, to-status, roles allowed; "pm" = the human via the API)
TRANSITIONS: dict[str, tuple[set[str], str, set[str]]] = {
    "sponsor": ({"proposed"}, "sponsored",
                {"head-of-rates", "head-of-macro-research", "head-of-fx-cross-asset", "head-of-quant", "deputy-pm"}),
    "challenge": ({"sponsored"}, "challenged", {"red-team"}),
    "size": ({"challenged"}, "sized", {"sizing-analyst"}),
    "risk_approve": ({"sized"}, "risk_approved", {"cro"}),
    "risk_block": ({"sized", "risk_approved"}, "rejected", {"cro"}),
    "pm_approve": ({"risk_approved"}, "pm_approved", {"pm"}),
    "pm_reject": ({"proposed", "sponsored", "challenged", "sized", "risk_approved", "pm_approved"}, "rejected", {"pm"}),
    "mark_live": ({"pm_approved"}, "live", {"pm"}),
    "close": ({"live"}, "closed", {"pm"}),
}
RED_TEAM_VERDICTS = {"proceed", "proceed-smaller", "rework", "reject"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def init_db() -> None:
    with _connect() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS trades (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at      TEXT NOT NULL,
                updated_at      TEXT NOT NULL,
                run_id          TEXT,
                proposed_by     TEXT NOT NULL,
                status          TEXT NOT NULL,
                title           TEXT NOT NULL,
                thesis          TEXT NOT NULL,
                instrument      TEXT NOT NULL,
                direction       TEXT NOT NULL,
                risk_factor     TEXT NOT NULL,     -- e.g. 'EUR 10y swap rate', 'EURUSD'
                bucket          TEXT NOT NULL,     -- 2y | 5y | 10y | 30y | fx | other
                conviction      INTEGER NOT NULL,
                horizon         TEXT NOT NULL,
                entry_level     TEXT,
                target          TEXT,
                stop            TEXT,
                invalidation    TEXT NOT NULL,
                pnl_per_bp_k    REAL,              -- set at sizing; P&L (k) per +1bp in risk_factor
                max_loss_k      REAL,              -- set at sizing; loss at the stop
                red_team_verdict TEXT,
                kill_criteria   TEXT
            );
            CREATE TABLE IF NOT EXISTS trade_events (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                trade_id    INTEGER NOT NULL,
                created_at  TEXT NOT NULL,
                actor       TEXT NOT NULL,
                action      TEXT NOT NULL,
                from_status TEXT,
                to_status   TEXT,
                note        TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_trade_events ON trade_events(trade_id);
            CREATE TABLE IF NOT EXISTS alerts (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at  TEXT NOT NULL,
                run_id      TEXT,
                agent_id    TEXT NOT NULL,
                level       TEXT NOT NULL,         -- info | warning | critical
                message     TEXT NOT NULL,
                trade_id    INTEGER,
                acknowledged INTEGER NOT NULL DEFAULT 0
            );
        """)


class LedgerError(ValueError):
    pass


def propose(run_id: Optional[str], agent_id: str, t: dict) -> int:
    now = _now()
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO trades (created_at, updated_at, run_id, proposed_by, status, title, thesis, instrument, "
            "direction, risk_factor, bucket, conviction, horizon, entry_level, target, stop, invalidation) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (now, now, run_id, agent_id, "proposed", t["title"], t["thesis"], t["instrument"], t["direction"],
             t["risk_factor"], t["bucket"], int(t["conviction"]), t["horizon"], t.get("entry_level"),
             t.get("target"), t.get("stop"), t["invalidation"]),
        )
        trade_id = cur.lastrowid
        conn.execute("INSERT INTO trade_events (trade_id, created_at, actor, action, to_status, note) "
                     "VALUES (?,?,?,?,?,?)", (trade_id, now, agent_id, "propose", "proposed", t["thesis"][:500]))
    return trade_id


def get(trade_id: int) -> dict:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM trades WHERE id=?", (trade_id,)).fetchone()
        if not row:
            raise LedgerError(f"No trade #{trade_id}")
        events = conn.execute("SELECT created_at, actor, action, from_status, to_status, note FROM trade_events "
                              "WHERE trade_id=? ORDER BY id", (trade_id,)).fetchall()
    return {**dict(row), "events": [dict(e) for e in events]}


def list_trades(statuses: Optional[list[str]] = None, run_id: Optional[str] = None, limit: int = 50) -> list[dict]:
    cond, params = [], []
    if statuses:
        cond.append(f"status IN ({','.join('?' * len(statuses))})")
        params += statuses
    if run_id:
        cond.append("run_id = ?")
        params.append(run_id)
    where = f"WHERE {' AND '.join(cond)}" if cond else ""
    with _connect() as conn:
        rows = conn.execute(f"SELECT * FROM trades {where} ORDER BY updated_at DESC LIMIT ?", params + [limit]).fetchall()
    return [dict(r) for r in rows]


def advance(trade_id: int, action: str, actor: str, note: str = "", **fields) -> dict:
    """Apply one transition, enforcing the status machine and who may do it."""
    if action not in TRANSITIONS:
        raise LedgerError(f"Unknown action {action!r}. Options: {sorted(TRANSITIONS)}")
    allowed_from, to_status, roles = TRANSITIONS[action]
    if actor not in roles:
        raise LedgerError(f"{actor} may not {action}; allowed: {sorted(roles)}")
    trade = get(trade_id)
    if trade["status"] not in allowed_from:
        raise LedgerError(f"Trade #{trade_id} is {trade['status']}; {action} needs one of {sorted(allowed_from)}")

    updates: dict = {}
    if action == "challenge":
        verdict = fields.get("verdict")
        if verdict not in RED_TEAM_VERDICTS:
            raise LedgerError(f"challenge needs verdict in {sorted(RED_TEAM_VERDICTS)}")
        if not fields.get("kill_criteria"):
            raise LedgerError("challenge needs kill_criteria")
        updates = {"red_team_verdict": verdict, "kill_criteria": fields["kill_criteria"]}
        if verdict == "reject":
            to_status = "rejected"
    elif action == "size":
        if fields.get("pnl_per_bp_k") is None or fields.get("max_loss_k") is None:
            raise LedgerError("size needs pnl_per_bp_k and max_loss_k")
        if trade["red_team_verdict"] == "rework":
            raise LedgerError("Red Team verdict is 'rework': the idea must be re-proposed, not sized")
        updates = {"pnl_per_bp_k": float(fields["pnl_per_bp_k"]), "max_loss_k": abs(float(fields["max_loss_k"]))}

    now = _now()
    sets = ", ".join(f"{k}=?" for k in [*updates, "status", "updated_at"])
    with _connect() as conn:
        conn.execute(f"UPDATE trades SET {sets} WHERE id=?", [*updates.values(), to_status, now, trade_id])
        conn.execute("INSERT INTO trade_events (trade_id, created_at, actor, action, from_status, to_status, note) "
                     "VALUES (?,?,?,?,?,?,?)", (trade_id, now, actor, action, trade["status"], to_status, note[:2000]))
    return get(trade_id)


def add_note(trade_id: int, actor: str, note: str) -> dict:
    get(trade_id)
    with _connect() as conn:
        conn.execute("INSERT INTO trade_events (trade_id, created_at, actor, action, note) VALUES (?,?,?,?,?)",
                     (trade_id, _now(), actor, "note", note[:2000]))
    return get(trade_id)


def raise_alert(run_id: Optional[str], agent_id: str, level: str, message: str, trade_id: Optional[int] = None) -> int:
    if level not in ("info", "warning", "critical"):
        raise LedgerError("level must be info, warning or critical")
    with _connect() as conn:
        cur = conn.execute("INSERT INTO alerts (created_at, run_id, agent_id, level, message, trade_id) VALUES (?,?,?,?,?,?)",
                           (_now(), run_id, agent_id, level, message[:2000], trade_id))
    return cur.lastrowid


def list_alerts(include_acknowledged: bool = False, limit: int = 50) -> list[dict]:
    where = "" if include_acknowledged else "WHERE acknowledged = 0"
    with _connect() as conn:
        rows = conn.execute(f"SELECT * FROM alerts {where} ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]


def acknowledge_alert(alert_id: int) -> None:
    with _connect() as conn:
        conn.execute("UPDATE alerts SET acknowledged = 1 WHERE id = ?", (alert_id,))

