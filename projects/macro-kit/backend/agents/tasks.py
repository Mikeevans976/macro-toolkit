"""
Task factory for the Fixed Income Pod crew.

build_tasks() creates 4 specialist tasks + 1 synthesis task,
all parameterised by the user's question.
"""
from crewai import Task
from agents.agents import (
    macro_strategist,
    rv_analyst,
    inflation_watcher,
    positioning_monitor,
    crew_chief,
)


def build_tasks(question: str) -> list[Task]:
    """
    Return the ordered task list for a crew run.

    The synthesis task has context=[all specialist tasks] so the
    Crew Chief sees every specialist's output before synthesizing.
    """

    task_macro = Task(
        description=(
            f"The pod has been asked: '{question}'\n\n"
            "Your job: use the Macro Factor Heatmap tool to retrieve the latest "
            "DFM factor scores for EUR, GBP, USD, and JPY rate markets. "
            "Analyse the factor levels and trends. Identify which regions show "
            "the strongest directional macro signals and which are in transition. "
            "Keep your output concise and focused — 3-5 bullet points maximum."
        ),
        expected_output=(
            "A bullet-point macro factor summary covering:\n"
            "1. Overall risk-on / risk-off tone across G10 rates\n"
            "2. Which region(s) have the clearest directional signal and why\n"
            "3. Any notable divergences between regions\n"
            "4. Implication for rates (higher / lower / rangebound) by region"
        ),
        agent=macro_strategist,
    )

    task_rv = Task(
        description=(
            f"The pod has been asked: '{question}'\n\n"
            "Your job: run both the Swaps RV Scanner and EGB RV Scanner. "
            "Identify the top 3 curve/fly structures that offer the best "
            "combination of extreme z-score AND positive carry. "
            "Flag any structures that are statistically cheap but carry-negative "
            "(bearish opportunities). Be specific about levels."
        ),
        expected_output=(
            "A structured RV summary covering:\n"
            "1. Top 2-3 long opportunities (cheap z-score + positive carry)\n"
            "2. Top 2-3 short opportunities (rich z-score + negative carry)\n"
            "3. Any notable EGB spread dislocations vs. swaps\n"
            "Format: Label | Current level | Z-score | Carry | View"
        ),
        agent=rv_analyst,
    )

    task_inflation = Task(
        description=(
            f"The pod has been asked: '{question}'\n\n"
            "Your job: use the Inflation Fixings Monitor to retrieve EUR HICP, "
            "GBP RPI, and USD CPI implied fixings. Identify: (a) whether markets "
            "are pricing re-acceleration or disinflation in the near-term fixings, "
            "(b) any unusual MoM SA readings that stand out vs seasonal norms, "
            "(c) the trend direction of each market over the next 6 months."
        ),
        expected_output=(
            "An inflation market assessment covering:\n"
            "1. EUR HICP: near-term trajectory and key fixing levels\n"
            "2. GBP RPI: near-term trajectory and key fixing levels\n"
            "3. USD CPI: near-term trajectory and key fixing levels\n"
            "4. Cross-market summary: where inflation is most / least supportive for bonds"
        ),
        agent=inflation_watcher,
    )

    task_positioning = Task(
        description=(
            f"The pod has been asked: '{question}'\n\n"
            "Your job: run the CTA Momentum Signals tool across the key G10 rate "
            "tickers and the Correlation Regime Scanner. Summarise: (a) whether "
            "CTA funds are broadly long or short duration, (b) which tenors have "
            "the strongest trend signal, (c) any correlation breaks that suggest "
            "stress or upcoming vol expansion."
        ),
        expected_output=(
            "A positioning and flow assessment covering:\n"
            "1. Overall CTA duration bias (net long / short / mixed)\n"
            "2. Top 2-3 tickers with strongest momentum signal and direction\n"
            "3. Any correlation regime breaks worth flagging\n"
            "4. Positioning risk: where are crowded trades that could unwind?"
        ),
        agent=positioning_monitor,
    )

    task_synthesis = Task(
        description=(
            f"The pod has been asked: '{question}'\n\n"
            "You have received analysis from four specialists:\n"
            "- Macro Strategist: top-down factor view\n"
            "- RV Analyst: curve/fly and EGB relative value\n"
            "- Inflation Watcher: inflation market dynamics\n"
            "- Positioning Monitor: CTA signals and correlation regimes\n\n"
            "Your job: synthesize these inputs into a coherent fixed income market "
            "view that directly addresses the question. Identify 2-3 high-conviction "
            "trade ideas where macro, valuation, and positioning all align. "
            "Be specific: name the instruments, direction, entry rationale, and key risks."
        ),
        expected_output=(
            "## Fixed Income Pod Briefing\n\n"
            "**Question:** {question}\n\n"
            "### Market View\n"
            "[3-4 sentence summary of the current rates environment]\n\n"
            "### Trade Ideas\n"
            "**Trade 1:** [Instrument] — [Long/Short] — [Rationale] — [Risk]\n"
            "**Trade 2:** [Instrument] — [Long/Short] — [Rationale] — [Risk]\n"
            "**Trade 3 (if applicable):** ...\n\n"
            "### Key Risks to Monitor\n"
            "[Bullet list of 2-3 macro / technical risks that could invalidate the view]"
        ).format(question=question),
        agent=crew_chief,
        context=[task_macro, task_rv, task_inflation, task_positioning],
    )

    return [task_macro, task_rv, task_inflation, task_positioning, task_synthesis]
