"""
Pod-state tools: how agents publish views and read what the rest of the pod
thinks. These are the baseline kit (§7.2) every agent receives.
"""
from pod import storage
from pod.tools import Tool, ToolContext, register, schema

_VIEW_ITEM = {
    "type": "object",
    "properties": {
        "market": {"type": "string", "description": "Market or theme, e.g. 'EUR 2s10s', 'BTP-Bund 10y', 'ECB path'"},
        "direction": {"type": "string", "description": "e.g. long, short, steepener, flattener, wider, tighter, neutral"},
        "conviction": {"type": "integer", "enum": [1, 2, 3, 4, 5], "description": "1 = weak, 5 = highest"},
        "horizon": {"type": "string", "enum": ["1w", "1m", "3m", "6m", "12m+"]},
        "instrument": {"type": "string", "description": "Preferred expression, e.g. 'EUR 2s10s swap steepener, DV01-neutral'"},
        "catalysts": {"type": "array", "items": {"type": "string"}},
        "invalidation": {"type": "string", "description": "Level or event that proves the view wrong"},
        "rationale": {"type": "string", "description": "Two or three sentences"},
        "evidence": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "tool": {"type": "string"},
                    "as_of": {"type": "string"},
                    "data_source": {"type": "string", "description": "e.g. bloomberg, simulation, web"},
                },
                "required": ["tool", "as_of", "data_source"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["market", "direction", "conviction", "horizon", "instrument",
                 "catalysts", "invalidation", "rationale", "evidence"],
    "additionalProperties": False,
}


def submit_view(views: list[dict], context: ToolContext) -> str:
    n = storage.insert_views(context.run_id, context.agent_id, views)
    return f"Recorded {n} view(s)."


register(Tool(
    name="submit_view",
    description=(
        "Record your structured view(s) in the standard pod format so desk heads and the "
        "Deputy PM can aggregate them. Call once with all views when you have finished your analysis."
    ),
    input_schema=schema({"views": {"type": "array", "items": _VIEW_ITEM}}, ["views"]),
    handler=submit_view,
    writes=True,
    strict=True,
))


def read_desk_views(agent_ids: list[str] | None = None, since_days: int = 7,
                    current_run_only: bool = False, context: ToolContext | None = None) -> object:
    views = storage.get_views(agent_ids=agent_ids, since_days=since_days,
                              run_id=context.run_id if (current_run_only and context) else None)
    return {"views": views} if views else "No views recorded for that filter."


register(Tool(
    name="read_desk_views",
    description=(
        "Read structured views other agents have submitted (newest first). Filter by agent ids, "
        "look-back days, or only this run."
    ),
    input_schema=schema({
        "agent_ids": {"type": "array", "items": {"type": "string"}},
        "since_days": {"type": "integer", "minimum": 1, "maximum": 90},
        "current_run_only": {"type": "boolean"},
    }),
    handler=read_desk_views,
))

# Workflows whose final output is the pod's house view
HOUSE_VIEW_SOURCES = ["morning-briefing", "deputy-pm"]


def get_house_view() -> str:
    row = storage.latest_output(HOUSE_VIEW_SOURCES)
    if not row:
        return "No house view yet (no completed morning briefing)."
    return f"House view as of {row['created_at']} (run {row['run_id']}):\n\n{row['output']}"


register(Tool(
    name="get_house_view",
    description="The latest pod house view (output of the most recent morning briefing).",
    input_schema=schema(),
    handler=get_house_view,
    max_chars=8000,
))


def search_pod_memory(query: str, limit: int = 5) -> object:
    rows = storage.search_runs(query, limit)
    if not rows:
        return f"No past runs mention {query!r}."
    return [{**r, "output": (r["output"] or "")[:1200]} for r in rows]


register(Tool(
    name="search_pod_memory",
    description="Search past pod runs (questions and outputs) for a phrase, newest first.",
    input_schema=schema({"query": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 10}},
                        ["query"]),
    handler=search_pod_memory,
))
