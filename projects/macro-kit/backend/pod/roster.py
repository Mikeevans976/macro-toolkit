"""
Load agent definitions from roster.yaml, validate them, and build each
agent's system prompt.

Validation runs at import, so a typo in a tool or skill name fails at server
start rather than mid-run.
"""
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import yaml

from pod.config import MODELS
from pod.tools import REGISTRY, Tool, load_all

_HERE = Path(__file__).parent
SKILLS_DIR = _HERE / "skills"

BASELINE_TOOLS = [
    "submit_view", "read_desk_views", "get_house_view", "search_pod_memory", "list_trades",
    "research_search", "research_calls",
    "sandbox_read", "sandbox_write", "sandbox_edit", "sandbox_list", "sqlite_sandbox",
    "python_sandbox", "web_search", "web_fetch",
]
BASELINE_SKILLS = ["pod-view-format", "evidence-and-citation"]


@dataclass(frozen=True)
class AgentDef:
    id: str
    name: str
    desk: str
    reports_to: str
    tier: str
    effort: str
    role: str
    mandate: str
    tools: tuple[str, ...]
    skills: tuple[str, ...]
    is_manager: bool = False
    enabled: bool = True
    blocked_on: tuple[str, ...] = ()
    missing_tools: tuple[str, ...] = ()
    max_turns: Optional[int] = None     # overrides config.MAX_TURNS for long tasks (e.g. portal sweeps)
    system_prompt: str = field(default="", compare=False, repr=False)

    @property
    def model(self) -> str:
        return MODELS[self.tier]

    def all_tools(self) -> list[Tool]:
        names = list(dict.fromkeys(list(self.tools) + BASELINE_TOOLS))   # dedupe, keep order
        return [REGISTRY[n] for n in names]


def _read_skill(name: str) -> str:
    path = SKILLS_DIR / name / "SKILL.md"
    text = path.read_text(encoding="utf-8")
    return re.sub(r"\A---\n.*?\n---\n", "", text, flags=re.DOTALL).strip()   # drop frontmatter


def _directory(by_id: dict, exclude: str) -> str:
    rows = [f"- {x['id']}: {x['name']} ({x['role']})" for x in by_id.values()
            if x.get("enabled", True) and x["id"] != exclude]
    return "Agents you can consult with consult_agent (id: name, role):\n" + "\n".join(rows)


def _system_prompt(a: dict, desks: dict, by_id: dict) -> str:
    reports = [x["name"] for x in by_id.values() if x["reports_to"] == a["id"] and x.get("enabled", True)]
    boss = "the human Portfolio Manager" if a["reports_to"] == "pm" else by_id[a["reports_to"]]["name"]
    skills = list(dict.fromkeys(BASELINE_SKILLS + list(a.get("skills", []))))
    parts = [
        f"You are the {a['name']} in a global macro hedge fund pod "
        f"({desks[a['desk']]} desk). You report to {boss}."
        + (f" Your team: {', '.join(reports)}." if reports else ""),
        a["mandate"].strip(),
        "How you work:\n"
        "- Use your tools to get data before forming a view; don't rely on memory for market levels.\n"
        "- The user message gives today's date and your task. Other agents' work, when relevant, "
        "is included in it or available through read_desk_views.\n"
        "- When you have views, record them with submit_view, then give your written answer.\n"
        "- Your output is advisory. Nothing you say places or changes a trade.",
    ]
    if a.get("missing_tools"):
        parts.append(
            "Data limits: these planned tools or data sources are not built yet: "
            + ", ".join(a["missing_tools"])
            + ". Where your work needs them, use primary sources via web_search / web_fetch, say "
            "that you did, and lower conviction accordingly."
        )
    if "consult_agent" in a.get("tools", []):
        parts.append(_directory(by_id, a["id"]))
    for s in skills:
        parts.append(f'<skill name="{s}">\n{_read_skill(s)}\n</skill>')
    return "\n\n".join(parts)


def _load() -> tuple[dict[str, AgentDef], dict[str, str]]:
    load_all()
    raw = yaml.safe_load((_HERE / "roster.yaml").read_text(encoding="utf-8"))
    desks: dict[str, str] = raw["desks"]
    by_id = {a["id"]: a for a in raw["agents"]}
    if len(by_id) != len(raw["agents"]):
        raise ValueError("roster.yaml: duplicate agent id")

    errors = []
    for a in raw["agents"]:
        aid = a["id"]
        if a["desk"] not in desks:
            errors.append(f"{aid}: unknown desk {a['desk']!r}")
        if a["reports_to"] != "pm" and a["reports_to"] not in by_id:
            errors.append(f"{aid}: reports_to unknown agent {a['reports_to']!r}")
        if a["tier"] not in MODELS:
            errors.append(f"{aid}: unknown tier {a['tier']!r}")
        if a.get("enabled", True):
            for t in a.get("tools", []):
                if t not in REGISTRY:
                    errors.append(f"{aid}: unknown tool {t!r}")
            for s in a.get("skills", []):
                if not (SKILLS_DIR / s / "SKILL.md").exists():
                    errors.append(f"{aid}: missing skill {s!r}")
    for t in BASELINE_TOOLS:
        if t not in REGISTRY:
            errors.append(f"baseline: unknown tool {t!r}")
    if errors:
        raise ValueError("roster.yaml is invalid:\n  " + "\n  ".join(errors))

    agents = {}
    for a in raw["agents"]:
        enabled = a.get("enabled", True)
        agents[a["id"]] = AgentDef(
            id=a["id"], name=a["name"], desk=a["desk"], reports_to=a["reports_to"],
            tier=a["tier"], effort=a["effort"], role=a["role"], mandate=a["mandate"],
            tools=tuple(a.get("tools", [])), skills=tuple(a.get("skills", [])),
            is_manager=a.get("is_manager", False), enabled=enabled,
            blocked_on=tuple(a.get("blocked_on", [])),
            missing_tools=tuple(a.get("missing_tools", [])),
            max_turns=a.get("max_turns"),
            system_prompt=_system_prompt(a, desks, by_id) if enabled else "",
        )
    return agents, desks


AGENTS, DESKS = _load()
ENABLED = {k: v for k, v in AGENTS.items() if v.enabled}


def team_of(manager_id: str) -> list[AgentDef]:
    return [a for a in ENABLED.values() if a.reports_to == manager_id]


def roster_entry(a: AgentDef) -> dict:
    """Shape served by GET /api/agents/roster (superset of the old CrewAI ROSTER)."""
    return {
        "id": a.id,
        "name": a.name,
        "role": a.role,
        "desk": a.desk,
        "desk_name": DESKS[a.desk],
        "reports_to": a.reports_to,
        "tools": [t.name for t in a.all_tools()] if a.enabled else [],
        "specialist_tools": list(a.tools),
        "skills": list(dict.fromkeys(BASELINE_SKILLS + list(a.skills))),
        "model": a.tier,
        "model_id": a.model,
        "effort": a.effort,
        "is_manager": a.is_manager,
        "enabled": a.enabled,
        "blocked_on": list(a.blocked_on),
        "missing_tools": list(a.missing_tools),
    }
