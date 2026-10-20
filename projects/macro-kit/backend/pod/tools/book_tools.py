"""
Book, risk and pod-operations tools: the trade ledger, risk engine, sizing,
alerts, consulting another agent, data health and report
publishing. Role checks for ledger transitions live in pod/book.py.
"""
import re
from datetime import date, datetime, timedelta

from pod import book, risk
from pod.tools import Tool, ToolContext, register, schema
from pod.tools.sandbox import SANDBOX_ROOT

_BUCKETS = ["2y", "5y", "10y", "30y", "fx", "other"]

# ── trade ledger ─────────────────────────────────────────────────────────────


def propose_trade(title: str, thesis: str, instrument: str, direction: str, risk_factor: str, bucket: str,
                  conviction: int, horizon: str, invalidation: str, entry_level: str = "", target: str = "",
                  stop: str = "", context: ToolContext | None = None) -> str:
    tid = book.propose(context.run_id, context.agent_id, dict(
        title=title, thesis=thesis, instrument=instrument, direction=direction, risk_factor=risk_factor,
        bucket=bucket, conviction=conviction, horizon=horizon, invalidation=invalidation,
        entry_level=entry_level or None, target=target or None, stop=stop or None))
    return f"Proposed trade #{tid} ({title}). Status: proposed. A desk head must sponsor it next."


register(Tool(
    name="propose_trade",
    description=(
        "Put a trade idea into the pod's trade ledger (status 'proposed'). It then needs, in order: a desk "
        "head's sponsorship, a Red Team challenge, sizing, CRO approval and the human PM's approval."
    ),
    input_schema=schema({
        "title": {"type": "string"},
        "thesis": {"type": "string", "description": "Why, in three or four sentences"},
        "instrument": {"type": "string", "description": "Exact expression, e.g. 'EUR 2s10s swap steepener, DV01-neutral'"},
        "direction": {"type": "string"},
        "risk_factor": {"type": "string", "description": "Main risk factor, e.g. 'EUR 10y swap rate'"},
        "bucket": {"type": "string", "enum": _BUCKETS},
        "conviction": {"type": "integer", "enum": [1, 2, 3, 4, 5]},
        "horizon": {"type": "string", "enum": ["1w", "1m", "3m", "6m", "12m+"]},
        "invalidation": {"type": "string"},
        "entry_level": {"type": "string"},
        "target": {"type": "string"},
        "stop": {"type": "string"},
    }, ["title", "thesis", "instrument", "direction", "risk_factor", "bucket", "conviction", "horizon", "invalidation"]),
    handler=propose_trade,
    writes=True,
))


def list_trades(statuses: list[str] | None = None, trade_id: int | None = None,
                current_run_only: bool = False, context: ToolContext | None = None) -> object:
    if trade_id is not None:
        return book.get(trade_id)
    rows = book.list_trades(statuses=statuses, run_id=context.run_id if (current_run_only and context) else None)
    return rows or "No trades match."


register(Tool(
    name="list_trades",
    description="Read the trade ledger: one trade with its full history (trade_id), or trades filtered by status.",
    input_schema=schema({
        "statuses": {"type": "array", "items": {"type": "string", "enum": book.STATUSES}},
        "trade_id": {"type": "integer"},
        "current_run_only": {"type": "boolean"},
    }),
    handler=list_trades,
))


def advance_trade(trade_id: int, action: str, note: str, verdict: str = "", kill_criteria: str = "",
                  pnl_per_bp_k: float | None = None, max_loss_k: float | None = None,
                  context: ToolContext | None = None) -> object:
    t = book.advance(trade_id, action, context.agent_id, note, verdict=verdict or None,
                     kill_criteria=kill_criteria or None, pnl_per_bp_k=pnl_per_bp_k, max_loss_k=max_loss_k)
    return {"trade_id": t["id"], "status": t["status"], "title": t["title"]}


register(Tool(
    name="advance_trade",
    description=(
        "Move a trade through the ledger. Each action is allowed only for its role: sponsor (desk heads, "
        "Deputy PM), challenge (Red Team: needs verdict and kill_criteria; verdict 'reject' rejects the "
        "trade), size (Sizing Analyst: needs pnl_per_bp_k and max_loss_k), risk_approve / risk_block (CRO). "
        "PM approval is human-only."
    ),
    input_schema=schema({
        "trade_id": {"type": "integer"},
        "action": {"type": "string", "enum": ["sponsor", "challenge", "size", "risk_approve", "risk_block"]},
        "note": {"type": "string", "description": "Reasoning for this step"},
        "verdict": {"type": "string", "enum": sorted(book.RED_TEAM_VERDICTS)},
        "kill_criteria": {"type": "string"},
        "pnl_per_bp_k": {"type": "number", "description": "P&L in k for +1bp in the risk factor (negative = long duration)"},
        "max_loss_k": {"type": "number", "description": "Loss at the stop, in k"},
    }, ["trade_id", "action", "note"]),
    handler=advance_trade,
    writes=True,
))


def trade_note(trade_id: int, note: str, context: ToolContext | None = None) -> str:
    book.add_note(trade_id, context.agent_id, note)
    return f"Note added to trade #{trade_id}."


register(Tool(
    name="trade_note",
    description="Add a note to a trade's history without changing its status (e.g. monitoring observations).",
    input_schema=schema({"trade_id": {"type": "integer"}, "note": {"type": "string"}}, ["trade_id", "note"]),
    handler=trade_note,
    writes=True,
))

# ── risk and sizing ──────────────────────────────────────────────────────────


def risk_engine(statuses: list[str] | None = None, include_trade_ids: list[int] | None = None) -> dict:
    return risk.book_risk(statuses, include_trade_ids)


register(Tool(
    name="risk_engine",
    description=(
        "Book risk from the trade ledger: P&L per bp by tenor bucket, parametric scenario P&L, worst "
        "scenario and limit breaches. Defaults to live + PM-approved trades; add include_trade_ids to see "
        "the book with a trade under review."
    ),
    input_schema=schema({
        "statuses": {"type": "array", "items": {"type": "string", "enum": book.STATUSES}},
        "include_trade_ids": {"type": "array", "items": {"type": "integer"}},
    }),
    handler=risk_engine,
))


def scenario_library() -> dict:
    return {"units": "bp by tenor bucket, positive = yields up", "type": "hypothetical parametric",
            "scenarios": risk.SCENARIOS, "limits": risk.limits()}


register(Tool(
    name="scenario_library",
    description="The pod's parametric rate scenarios (bp shocks by bucket) and its risk limits.",
    input_schema=schema(),
    handler=scenario_library,
))


def sizing_engine(method: str, direction_sign: int, max_loss_k: float | None = None,
                  stop_distance_bp: float | None = None, target_daily_vol_k: float | None = None,
                  daily_vol_bp: float | None = None) -> dict:
    if method == "stop":
        if max_loss_k is None or stop_distance_bp is None:
            raise ValueError("method 'stop' needs max_loss_k and stop_distance_bp")
        return risk.size_from_stop(max_loss_k, stop_distance_bp, direction_sign)
    if target_daily_vol_k is None or daily_vol_bp is None:
        raise ValueError("method 'vol' needs target_daily_vol_k and daily_vol_bp")
    return risk.size_from_vol(target_daily_vol_k, daily_vol_bp, direction_sign)


register(Tool(
    name="sizing_engine",
    description=(
        "Size a rate trade. method='stop': loss at the stop equals max_loss_k. method='vol': daily P&L vol "
        "equals target_daily_vol_k. direction_sign = -1 if the trade gains when yields fall, +1 if it gains "
        "when they rise. Returns pnl_per_bp_k to record with advance_trade(action='size')."
    ),
    input_schema=schema({
        "method": {"type": "string", "enum": ["stop", "vol"]},
        "direction_sign": {"type": "integer", "enum": [-1, 1]},
        "max_loss_k": {"type": "number"},
        "stop_distance_bp": {"type": "number"},
        "target_daily_vol_k": {"type": "number"},
        "daily_vol_bp": {"type": "number"},
    }, ["method", "direction_sign"]),
    handler=sizing_engine,
))

# ── alerts ───────────────────────────────────────────────────────────────────


def alert(level: str, message: str, trade_id: int | None = None, context: ToolContext | None = None) -> str:
    aid = book.raise_alert(context.run_id, context.agent_id, level, message, trade_id)
    return f"Alert #{aid} raised ({level}). It appears on the pod page for the PM."


register(Tool(
    name="alert",
    description="Raise an alert for the PM (shown on the pod page). Use 'critical' only for thesis breaks or limit breaches.",
    input_schema=schema({
        "level": {"type": "string", "enum": ["info", "warning", "critical"]},
        "message": {"type": "string"},
        "trade_id": {"type": "integer"},
    }, ["level", "message"]),
    handler=alert,
    writes=True,
))

# ── consult another agent (executed by the runner, which owns the async loop) ─


def _runner_only(**_):
    raise RuntimeError("consult_agent is executed by the runner")


register(Tool(
    name="consult_agent",
    description=(
        "Ask another pod agent a question and get its written answer. Use the narrowest agent that can "
        "answer. Consulted agents cannot consult further. Agent ids are listed in your instructions."
    ),
    input_schema=schema({"agent_id": {"type": "string"}, "question": {"type": "string"}}, ["agent_id", "question"]),
    handler=_runner_only,
))

# ── data health ──────────────────────────────────────────────────────────────

_HEALTH_CHECKS = {   # tool name → cheap arguments
    "swaps_rv": {"top_n": 1}, "egb_rv": {"top_n": 1}, "inflation_fixings": {"n_months": 1},
    "macro_factors": {"regions": ["EA", "US", "UK", "JP"]}, "cta_momentum": {"group": "Bond"},
    "correlation_regimes": {"top_n": 1}, "option_implied_cdf": {"ccy": "EUR", "tail": "10y"},
    "fitted_bond_curves": {}, "euribor_positioning": {},
}


def _business_days_since(d: date) -> int:
    days, cur = 0, d
    while cur < date.today():
        cur += timedelta(days=1)
        if cur.weekday() < 5:
            days += 1
    return days


def data_health() -> dict:
    from pod.tools import REGISTRY
    report = []
    for name, args in _HEALTH_CHECKS.items():
        try:
            raw = REGISTRY[name].call(args, ToolContext("health", "data-quality-sentinel"))
            sources = sorted(set(re.findall(r'"data_source":"([^"]+)"', raw)))
            dates = re.findall(r'"as_of(?:_date)?":"(\d{4}-\d{2}-\d{2})', raw)
            latest = max(dates) if dates else None
            stale = _business_days_since(date.fromisoformat(latest)) if latest else None
            report.append({"tool": name, "ok": True, "data_source": sources or ["unknown"], "as_of": latest,
                           "business_days_old": stale,
                           "flags": [f for f in [
                               "simulated" if any("simul" in s for s in sources) else None,
                               "stale" if stale is not None and stale > 2 else None,
                               "no as_of date" if latest is None else None] if f]})
        except Exception as exc:
            report.append({"tool": name, "ok": False, "error": f"{type(exc).__name__}: {exc}"[:300]})
    return {"checked_at": datetime.now().isoformat(timespec="seconds"), "checks": report,
            "note": "fair_value_models and seasonality are skipped (slow / Bloomberg-only)."}


register(Tool(
    name="data_health",
    description="Check the analytics data feeding the pod: which tools work, their as-of dates, staleness, and whether data is simulated.",
    input_schema=schema(),
    handler=data_health,
    max_chars=8000,
))

# ── publishing ───────────────────────────────────────────────────────────────
# (research search lives in pod/tools/research_tools.py, over the research library)

REPORTS_DIR = SANDBOX_ROOT / "reports"


def publish_report(title: str, markdown: str, kind: str = "note") -> str:
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:60] or "report"
    path = REPORTS_DIR / f"{date.today().isoformat()}-{kind}-{slug}.md"
    path.write_text(f"# {title}\n\n_{kind} · {date.today().isoformat()}_\n\n{markdown}\n", encoding="utf-8")
    return f"Published to sandbox/{path.relative_to(SANDBOX_ROOT)}"


register(Tool(
    name="publish_report",
    description="Save a finished report (morning note, IC memo, weekly review) as Markdown in sandbox/reports/.",
    input_schema=schema({
        "title": {"type": "string"},
        "markdown": {"type": "string"},
        "kind": {"type": "string", "enum": ["morning-note", "ic-memo", "weekly-review", "note"]},
    }, ["title", "markdown"]),
    handler=publish_report,
    writes=True,
))
