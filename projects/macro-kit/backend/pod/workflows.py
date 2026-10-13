"""
Pod workflows as plain async Python (§5 and §6.3 of the proposal).

single_agent      — one agent answers a question
ask_pod           — the Pod Coordinator routes a question to the right agents
desk_briefing     — a desk head's team works in parallel, then the head synthesises
trade_review      — an idea goes through the ledger gates: desk head proposes and
                    sponsors → Red Team → sizing → CRO → Deputy PM summary; the
                    human PM then approves or rejects in the UI
morning_briefing  — shared services → research desks in parallel → Red Team →
                    risk review → Deputy PM house view → Publisher

Each workflow returns the AgentResult whose text is the run's final output.
"""
import asyncio
from datetime import date

from pod import book
from pod.roster import ENABLED, AgentDef, team_of
from pod.runner import AgentResult, Runner

RESEARCH_DESK_HEADS = ["head-of-macro-research", "head-of-rates", "head-of-fx-cross-asset", "head-of-quant"]


def _header(question: str) -> str:
    return f"Today's date: {date.today().isoformat()}\n\nThe pod's question: {question}"


def _specialist_task(question: str, context: str = "") -> str:
    parts = [_header(question)]
    if context:
        parts.append(context)
    parts.append(
        "Do your part of the analysis from your area of coverage using your tools. Record your "
        "views with submit_view (use direction 'neutral' if you see no edge). Then write your "
        "answer: lead with the conclusion, at most ten bullets, specific levels and dates."
    )
    return "\n\n".join(parts)


def _format_reports(results: list[AgentResult]) -> str:
    blocks = []
    for r in results:
        body = r.text if r.ok else f"(No report: {r.error})"
        blocks.append(f'<report from="{r.name}">\n{body}\n</report>')
    return "\n\n".join(blocks)


def _synthesis_task(question: str, results: list[AgentResult], instructions: str, context: str = "") -> str:
    parts = [_header(question)]
    if context:
        parts.append(context)
    parts += [
        "Reports from your team (their structured views are also available with "
        "read_desk_views, current_run_only=true):",
        _format_reports(results),
        instructions,
    ]
    return "\n\n".join(parts)


# ── single agent / ask the pod ───────────────────────────────────────────────

async def single_agent(runner: Runner, agent_id: str, question: str) -> AgentResult:
    return await runner.run(ENABLED[agent_id], _specialist_task(question))


async def ask_pod(runner: Runner, question: str) -> AgentResult:
    return await runner.run(ENABLED["pod-coordinator"], "\n\n".join([
        _header(question),
        "Route this question: consult the narrowest agent (or two or three if it genuinely spans "
        "areas), then give their answer with a one-line note on who answered.",
    ]))


# ── desks ────────────────────────────────────────────────────────────────────

async def desk_briefing(runner: Runner, head_id: str, question: str, context: str = "") -> AgentResult:
    head = ENABLED[head_id]
    team = team_of(head_id)
    reports = list(await asyncio.gather(*(runner.run(a, _specialist_task(question, context)) for a in team)))
    return await runner.run(head, _synthesis_task(question, reports, (
        "Combine your team's work into the desk view using the IC memo template. Test any claim "
        "the conclusion depends on with your own tools. Record the desk's views with submit_view. "
        "If the desk has a trade it would back, put it on the ledger with propose_trade and "
        "sponsor it with advance_trade(action='sponsor')."), context))


async def book_review(runner: Runner, question: str) -> AgentResult:
    return await desk_briefing(runner, "head-of-trading", question,
                               "Focus on the trade ledger: approved and live trades, their theses, and implementation.")


async def risk_review(runner: Runner, question: str, context: str = "") -> AgentResult:
    cro = ENABLED["cro"]
    team = team_of(cro.id)
    reports = list(await asyncio.gather(*(runner.run(a, _specialist_task(question, context)) for a in team)))
    return await runner.run(cro, _synthesis_task(question, reports, (
        "Give the risk view on the book and on any trades awaiting your decision (status 'sized'): "
        "approve or block each with advance_trade, and raise alerts for limit breaches."), context))


# ── trade review (the ledger gates) ──────────────────────────────────────────

def _trade_context(trade_id: int) -> str:
    t = book.get(trade_id)
    keys = ["id", "status", "title", "thesis", "instrument", "direction", "risk_factor", "bucket", "conviction",
            "horizon", "entry_level", "target", "stop", "invalidation", "red_team_verdict", "kill_criteria",
            "pnl_per_bp_k", "max_loss_k"]
    lines = [f"{k}: {t[k]}" for k in keys if t.get(k) is not None]
    return "Trade under review (from the ledger):\n" + "\n".join(lines)


async def _pick_desk_head(runner: Runner, idea: str) -> str:
    """Cheap routing call: the Coordinator names the desk head that should own the idea."""
    res = await runner.run(ENABLED["pod-coordinator"], "\n\n".join([
        f"Trade idea: {idea}",
        "Which desk head should own this idea? Do not use any tools. Reply with exactly one id: "
        + ", ".join(RESEARCH_DESK_HEADS),
    ]))
    for head in RESEARCH_DESK_HEADS:
        if head in (res.text or ""):
            return head
    return "head-of-rates"


async def trade_review(runner: Runner, idea: str) -> AgentResult:
    head = ENABLED[await _pick_desk_head(runner, idea)]
    sponsor = await runner.run(head, "\n\n".join([
        _header(idea),
        "This is a trade idea for review. Analyse it with your tools (consult your team if useful). "
        "If you would back it, record it with propose_trade (make the instrument, risk_factor, "
        "bucket, stop and invalidation specific) and then advance_trade(action='sponsor'). If not, "
        "do not record it and explain why.",
    ]))
    trades = [t for t in book.list_trades(run_id=runner.run_id) if t["status"] == "sponsored"]
    if not trades:
        return AgentResult("trade-review", head.name, sponsor.text or "The desk did not sponsor the idea.",
                           sponsor.turns, sponsor.stop_reason, model=sponsor.model, error=sponsor.error)
    tid = trades[0]["id"]

    await runner.run(ENABLED["red-team"], "\n\n".join([
        _header(idea), _trade_context(tid),
        f"Apply the red team protocol to trade #{tid} and record your verdict and kill criteria with "
        "advance_trade(action='challenge').",
    ]))
    if book.get(tid)["status"] == "challenged" and book.get(tid)["red_team_verdict"] != "rework":
        await runner.run(ENABLED["sizing-analyst"], "\n\n".join([
            _header(idea), _trade_context(tid),
            f"Size trade #{tid} per the sizing framework and record it with advance_trade(action='size').",
        ]))
    if book.get(tid)["status"] == "sized":
        await runner.run(ENABLED["cro"], "\n\n".join([
            _header(idea), _trade_context(tid),
            f"Decide on trade #{tid}: check it against the limits and the book with risk_engine "
            f"(include_trade_ids=[{tid}]), then risk_approve or risk_block it with your reasoning.",
        ]))
    final = book.get(tid)
    summary = await runner.run(ENABLED["deputy-pm"], "\n\n".join([
        _header(idea), _trade_context(tid),
        "Ledger history for this trade:\n" + "\n".join(
            f"- {e['created_at'][:16]} {e['actor']} {e['action']}: {(e['note'] or '')[:400]}" for e in final["events"]),
        "Write a short recommendation for the PM on this trade: the case, the Red Team's objection, "
        "the size and risk, the CRO's decision, and your recommendation. "
        + ("The trade awaits the PM's approval in the UI." if final["status"] == "risk_approved"
           else f"The trade ended at status '{final['status']}'."),
    ]))
    return summary


# ── morning briefing ─────────────────────────────────────────────────────────

async def morning_briefing(runner: Runner, question: str) -> AgentResult:
    services = list(await asyncio.gather(
        runner.run(ENABLED["news-scanner"], _specialist_task(question)),
        runner.run(ENABLED["calendar-analyst"], _specialist_task(question)),
    ))
    context = "Shared services input for today:\n\n" + _format_reports(services)

    desk_reports = list(await asyncio.gather(*(desk_briefing(runner, h, question, context)
                                               for h in RESEARCH_DESK_HEADS)))

    challenge = await runner.run(ENABLED["red-team"], _synthesis_task(question, desk_reports, (
        "These are the desks' reports. Apply the red team protocol to every trade idea in them, "
        "using your own tools. For sponsored trades on the ledger (list_trades current_run_only), "
        "record your verdict with advance_trade(action='challenge').")))

    risk = await risk_review(runner, question, "Desk reports and Red Team challenge:\n\n"
                             + _format_reports(desk_reports + [challenge]))

    house_view = await runner.run(ENABLED["deputy-pm"], _synthesis_task(
        question, desk_reports + [challenge, risk], (
            "Produce the pod's house view using the IC memo template. Include the Red Team verdict "
            "and the CRO's view for each ranked idea. Record the house view's ideas with submit_view."),
        context))

    await runner.run(ENABLED["publisher"], "\n\n".join([
        _header(question),
        "The Deputy PM's house view:\n\n" + (house_view.text or "(none)"),
        "Write today's morning note in house style and publish it with publish_report (kind 'morning-note').",
    ]))
    return house_view


# Workflow ids accepted by POST /api/agents/run → (label, coroutine factory)
WORKFLOWS = {
    "ask-pod": ("Ask the Pod", ask_pod),
    "trade-review": ("Trade Review", trade_review),
    "morning-briefing": ("Morning Briefing", morning_briefing),
    "macro-desk": ("Macro Research Briefing", lambda r, q: desk_briefing(r, "head-of-macro-research", q)),
    "rates-desk": ("Rates Desk Briefing", lambda r, q: desk_briefing(r, "head-of-rates", q)),
    "fx-desk": ("FX & Cross-Asset Briefing", lambda r, q: desk_briefing(r, "head-of-fx-cross-asset", q)),
    "quant-desk": ("Quant & Positioning Briefing", lambda r, q: desk_briefing(r, "head-of-quant", q)),
    "book-review": ("Book Review", book_review),
    "risk-review": ("Risk Review", risk_review),
}


def _desk(head: str) -> list[list[str]]:
    return [[a.id for a in team_of(head)], [head]]


def workflow_info() -> list[dict]:
    """Served by GET /api/agents/workflows: who takes part, in which stage order."""
    research_members = [a.id for h in RESEARCH_DESK_HEADS for a in team_of(h)]
    info = {
        "ask-pod": ("The Pod Coordinator routes your question to the right agents and returns their answer.",
                    [["pod-coordinator"]], "pod-coordinator", "Ask anything, e.g. 'What is priced for the ECB in December?'"),
        "trade-review": ("Your idea goes through the ledger gates: desk head sponsors, Red Team challenges, "
                         "sizing, CRO decision, Deputy PM summary. You approve or reject it below.",
                         [["pod-coordinator"], ["(desk head)"], ["red-team"], ["sizing-analyst"], ["cro"], ["deputy-pm"]],
                         "deputy-pm", "Describe the trade idea, e.g. 'Pay 2y EUR swaps: the ECB is done cutting'"),
        "morning-briefing": ("The whole pod: shared services, all four research desks in parallel, Red Team, "
                             "risk review, Deputy PM house view, then the Publisher's note. About 35 agent runs.",
                             [["news-scanner", "calendar-analyst"], research_members, RESEARCH_DESK_HEADS,
                              ["red-team"], ["market-risk-analyst", "sizing-analyst"], ["cro"], ["deputy-pm"], ["publisher"]],
                             "deputy-pm", "e.g. 'Morning briefing: what has changed and what should we do?'"),
        "macro-desk": ("The macro research team works in parallel; the Head of Macro Research writes the view.",
                       _desk("head-of-macro-research"), "head-of-macro-research", "e.g. 'Where is the G10 cycle heading?'"),
        "rates-desk": ("The rates specialists work in parallel; the Head of Rates writes the desk view.",
                       _desk("head-of-rates"), "head-of-rates", "e.g. 'Where is the best risk/reward in EUR rates?'"),
        "fx-desk": ("The FX and cross-asset team works in parallel; the desk head writes the view.",
                    _desk("head-of-fx-cross-asset"), "head-of-fx-cross-asset", "e.g. 'What do FX and commodities say about rates?'"),
        "quant-desk": ("Positioning, technicals, regime and signal research in parallel; the Head of Quant writes the view.",
                       _desk("head-of-quant"), "head-of-quant", "e.g. 'Which pod ideas are crowded or fighting the regime?'"),
        "book-review": ("The trading desk reviews the ledger: implementation, live trades and lessons.",
                        _desk("head-of-trading"), "head-of-trading", "e.g. 'Review the live book.'"),
        "risk-review": ("Market risk and sizing analysts report; the CRO decides on sized trades and flags breaches.",
                        _desk("cro"), "cro", "e.g. 'Risk check on the book and pending trades.'"),
    }
    return [{"id": wid, "label": WORKFLOWS[wid][0], "description": d, "stages": stages,
             "final_agent": final, "placeholder": ph} for wid, (d, stages, final, ph) in info.items()]
