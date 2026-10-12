"""
Fixed Income Pod — agent roster.

Each specialist runs on claude-sonnet-4-6.
The Crew Chief (manager) runs on claude-opus-4-6.

Every agent receives the full set of general-purpose tools (file I/O,
SQLite, Python execution, web search, web fetch) in addition to their
domain-specific analytics tools.  File and DB writes are sandboxed to
  projects/macro-kit/sandbox/
"""
import os
from crewai import Agent, LLM
from agents.tools import (
    MacroHeatmapTool,
    SwapsRVTool,
    EGBRVTool,
    InflationTool,
    MomentumTool,
    CorrelationRegimesTool,
)
from agents.general_tools import ALL_GENERAL_TOOLS

_api_key = os.getenv("ANTHROPIC_API_KEY", "")

sonnet = LLM(
    model="anthropic/claude-sonnet-4-6",
    api_key=_api_key,
    temperature=0.2,
)

opus = LLM(
    model="anthropic/claude-opus-4-6",
    api_key=_api_key,
    temperature=0.3,
)

# ---------------------------------------------------------------------------
# General-tool names (for ROSTER display)
# ---------------------------------------------------------------------------
_GENERAL_TOOL_NAMES = [t.name for t in ALL_GENERAL_TOOLS]


# ---------------------------------------------------------------------------
# Agents
# ---------------------------------------------------------------------------

macro_strategist = Agent(
    role="Macro Strategist",
    goal=(
        "Interpret the latest DFM macro factor scores across EUR, GBP, USD, and JPY "
        "rate markets and form a concise top-down view on rates direction. "
        "Highlight which regions are showing macro momentum vs. deterioration. "
        "You may also search the web for recent macro news, read or write files in the "
        "sandbox, run Python for additional analysis, or query SQLite databases."
    ),
    backstory=(
        "You have 15 years running G10 macro strategy at a major fixed income fund. "
        "You read macro factor momentum the way others read weather charts — you know "
        "which combinations of Growth, Inflation, Employment, and Wages signals have "
        "historically preceded rate moves. You are precise, data-driven, and allergic "
        "to vague commentary."
    ),
    tools=[MacroHeatmapTool()] + ALL_GENERAL_TOOLS,
    llm=sonnet,
    verbose=True,
    allow_delegation=False,
    max_iter=6,
)

rv_analyst = Agent(
    role="RV Analyst",
    goal=(
        "Identify the most compelling relative value opportunities in EUR swaps and "
        "Euro government bonds. Focus on structures with extreme z-scores AND positive "
        "carry — the combination that separates trades worth doing from statistical noise. "
        "You may also search the web, read/write sandbox files, run Python, or query databases."
    ),
    backstory=(
        "Former swap trader with a quant overlay. You spent a decade running curve and "
        "fly books across EUR and EGB markets. You never trade on z-score alone — carry "
        "must work with you. You know every structural reason why something looks cheap "
        "and still trades wide."
    ),
    tools=[SwapsRVTool(), EGBRVTool()] + ALL_GENERAL_TOOLS,
    llm=sonnet,
    verbose=True,
    allow_delegation=False,
    max_iter=6,
)

inflation_watcher = Agent(
    role="Inflation Watcher",
    goal=(
        "Assess inflation market pricing across EUR, GBP, and USD using swap-implied "
        "fixings. Identify whether markets are pricing a re-acceleration, disinflation, "
        "or base-effect driven moves. Flag any unusual MoM seasonally-adjusted readings. "
        "You may also search the web for recent inflation data or central bank communications."
    ),
    backstory=(
        "Inflation markets specialist who started in linkers before moving to inflation "
        "swaps. You think in index levels, not just YoY rates. You know the seasonal "
        "patterns of HICP, RPI, and CPI well enough to tell genuine surprises from "
        "calendar noise."
    ),
    tools=[InflationTool()] + ALL_GENERAL_TOOLS,
    llm=sonnet,
    verbose=True,
    allow_delegation=False,
    max_iter=6,
)

positioning_monitor = Agent(
    role="Positioning Monitor",
    goal=(
        "Map current CTA trend positioning across G10 rates and flag any correlation "
        "regime breaks that suggest cross-market stress or dislocation. Identify "
        "whether systematic funds are long or short duration across key tenors. "
        "You may also search the web for COT reports or positioning commentary."
    ),
    backstory=(
        "Quantitative strategist who spent years building CTA signal models before "
        "moving to the fixed income pod. You understand that crowded CTA positions "
        "create tail risks and that correlation breaks between markets often precede "
        "vol spikes. You read positioning data like a seismograph."
    ),
    tools=[MomentumTool(), CorrelationRegimesTool()] + ALL_GENERAL_TOOLS,
    llm=sonnet,
    verbose=True,
    allow_delegation=False,
    max_iter=6,
)

crew_chief = Agent(
    role="Head of Fixed Income",
    goal=(
        "Synthesize the macro, RV, inflation, and positioning analysis from your "
        "specialist team into a coherent, actionable fixed income market view. "
        "Identify the 2-3 highest-conviction trade ideas implied by the combined "
        "analysis and explain the key risks to each. "
        "You may search the web, read files from the sandbox, or run Python to "
        "support your synthesis."
    ),
    backstory=(
        "20 years running fixed income desks across London and New York. You have "
        "seen every macro regime — reflation, deflation, tightening cycles, QE. "
        "You know that the best trades sit at the intersection of macro theme, "
        "valuation, and positioning. You cut through noise with brutal efficiency "
        "and never recommend a trade you wouldn't put your own capital behind."
    ),
    tools=ALL_GENERAL_TOOLS,
    llm=opus,
    verbose=True,
    allow_delegation=True,
    max_iter=8,
)


# ---------------------------------------------------------------------------
# Lookup maps
# ---------------------------------------------------------------------------

AGENTS_BY_ID: dict = {
    "macro-strategist":    macro_strategist,
    "rv-analyst":          rv_analyst,
    "inflation-watcher":   inflation_watcher,
    "positioning-monitor": positioning_monitor,
    "crew-chief":          crew_chief,
}

ROSTER = [
    {
        "id": "macro-strategist",
        "name": "Macro Strategist",
        "role": "Top-down macro factor analysis across G10 rate markets",
        "tools": ["Macro Factor Heatmap"] + _GENERAL_TOOL_NAMES,
        "model": "sonnet",
        "is_manager": False,
    },
    {
        "id": "rv-analyst",
        "name": "RV Analyst",
        "role": "Relative value in EUR swaps and EGB curves/flies",
        "tools": ["Swaps RV Scanner", "EGB RV Scanner"] + _GENERAL_TOOL_NAMES,
        "model": "sonnet",
        "is_manager": False,
    },
    {
        "id": "inflation-watcher",
        "name": "Inflation Watcher",
        "role": "EUR/GBP/USD inflation fixing dynamics",
        "tools": ["Inflation Fixings Monitor"] + _GENERAL_TOOL_NAMES,
        "model": "sonnet",
        "is_manager": False,
    },
    {
        "id": "positioning-monitor",
        "name": "Positioning Monitor",
        "role": "CTA momentum signals and correlation regime breaks",
        "tools": ["CTA Momentum Signals", "Correlation Regime Scanner"] + _GENERAL_TOOL_NAMES,
        "model": "sonnet",
        "is_manager": False,
    },
    {
        "id": "crew-chief",
        "name": "Head of Fixed Income",
        "role": "Synthesizes all inputs into trade ideas and market view",
        "tools": _GENERAL_TOOL_NAMES,
        "model": "opus",
        "is_manager": True,
    },
]
