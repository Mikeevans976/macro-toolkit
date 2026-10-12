"""
Pod workflows as plain async Python (§6.3 of the proposal).

single_agent     — one agent answers a question
desk_briefing    — a desk head's team works in parallel, then the head synthesises
morning_briefing — desks in parallel → Red Team challenges → Deputy PM house view

Each workflow returns the AgentResult whose text is the run's final output.
"""
import asyncio
from datetime import date

from pod.roster import ENABLED, AgentDef, team_of
from pod.runner import AgentResult, Runner


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


def _synthesis_task(question: str, results: list[AgentResult], instructions: str) -> str:
    return "\n\n".join([
        _header(question),
        "Reports from your team (their structured views are also available with "
        "read_desk_views, current_run_only=true):",
        _format_reports(results),
        instructions,
    ])


async def single_agent(runner: Runner, agent_id: str, question: str) -> AgentResult:
    agent = ENABLED[agent_id]
    return await runner.run(agent, _specialist_task(question))


async def desk_briefing(runner: Runner, head_id: str, question: str, context: str = "") -> AgentResult:
    head = ENABLED[head_id]
    team = team_of(head_id)
    reports = list(await asyncio.gather(*(runner.run(a, _specialist_task(question, context)) for a in team)))
    return await runner.run(head, _synthesis_task(question, reports, (
        "Combine your team's work into the desk view using the IC memo template. Test any claim "
        "the conclusion depends on with your own tools. Record the desk's views with submit_view.")))


async def _desk_or_solo(runner: Runner, agent: AgentDef, question: str) -> AgentResult:
    if team_of(agent.id):
        return await desk_briefing(runner, agent.id, question)
    return await runner.run(agent, _specialist_task(question))


async def morning_briefing(runner: Runner, question: str) -> AgentResult:
    deputy = ENABLED["deputy-pm"]
    red_team = ENABLED["red-team"]
    units = [a for a in team_of(deputy.id) if a.id != red_team.id]

    desk_reports = list(await asyncio.gather(*(_desk_or_solo(runner, a, question) for a in units)))

    challenge = await runner.run(red_team, _synthesis_task(question, desk_reports, (
        "These are the desks' reports. Apply the red team protocol to every trade idea in them. "
        "Use your own tools for the checks rather than the desks' numbers.")))

    return await runner.run(deputy, _synthesis_task(question, desk_reports + [challenge], (
        "Produce the pod's house view using the IC memo template. Include the Red Team verdict "
        "for each ranked idea. Record the house view's ideas with submit_view.")))


# Workflow ids accepted by POST /api/agents/run
WORKFLOWS = {
    "rates-desk": ("Rates Desk Briefing", lambda r, q: desk_briefing(r, "head-of-rates", q)),
    "morning-briefing": ("Morning Briefing", morning_briefing),
}


def workflow_info() -> list[dict]:
    """Served by GET /api/agents/workflows: who takes part, in which stage order."""
    rates_team = [a.id for a in team_of("head-of-rates")]
    units = [a for a in team_of("deputy-pm") if a.id != "red-team"]
    desk_stage = [m.id for u in units for m in team_of(u.id)] + [u.id for u in units]
    return [
        {
            "id": "rates-desk",
            "label": WORKFLOWS["rates-desk"][0],
            "description": "The rates specialists work in parallel; the Head of Rates writes the desk view.",
            "stages": [rates_team, ["head-of-rates"]],
            "final_agent": "head-of-rates",
        },
        {
            "id": "morning-briefing",
            "label": WORKFLOWS["morning-briefing"][0],
            "description": "Desks work in parallel, the Red Team challenges their ideas, "
                           "and the Deputy PM writes the house view.",
            "stages": [desk_stage, ["red-team"], ["deputy-pm"]],
            "final_agent": "deputy-pm",
        },
    ]
