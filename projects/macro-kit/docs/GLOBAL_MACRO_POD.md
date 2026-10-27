# Global Macro Pod

**Status:** Built (all 45 agents runnable). Tool gaps tracked per agent in `roster.yaml` (§9).
**Last updated:** 2026-10-22
**Scope:** Agent roster, reporting structure, orchestration, tools/skills/MCPs per agent, and how to extend the pod.

The source of truth is the code. This document explains the design; when they disagree, the code wins.

| What | Where |
|---|---|
| Roster (agents, desks, tiers, tools, skills, gaps) | `backend/pod/roster.yaml`, loaded by `pod/roster.py` |
| Runner (tool-use loop, one agent per task) | `backend/pod/runner.py`; model ids in `pod/config.py` |
| Workflows | `backend/pod/workflows.py` (`WORKFLOWS`, `USE_WHEN`, `workflow_info()`) |
| Tools | `backend/pod/tools/` (`REGISTRY`; analytics wrappers in `analytics.py`) |
| Skills | `backend/pod/skills/<name>/SKILL.md` |
| Trade ledger, alerts | `backend/pod/book.py` |
| Risk engine, limits | `backend/pod/risk.py`, `pod/limits.yaml` |
| Research library | `backend/pod/research/` |
| Run and event storage | `backend/agents/storage.py`, `backend/pod/storage.py` |
| API | `backend/routers/agents.py` (`/api/agents/*`, `/api/pod/*`) |
| UI | `frontend/src/pages/AgentsPod.tsx` (pod page), `features/launchpad/AgentsView.tsx` (launchpad Agents tab), `components/podOrgChart.tsx` |
| Tests | `backend/tests/test_pod.py`, `test_agents_api.py` |

---

## 1. History

Until October 2026 the Agents section was a five-agent **Fixed Income pod** on CrewAI: a Head of Fixed Income (Opus) over a Macro Strategist, RV Analyst, Inflation Watcher and Positioning Monitor, with six analytics tools. It had no FX or cross-asset coverage, regional economists, independent risk, execution or challenge function, and CrewAI's hierarchical process could not guarantee mandatory gates (§6). It was replaced by this pod and its code removed; only the run/event storage (`backend/agents/storage.py`) remains.

| Old FI pod agent | Now |
|---|---|
| Head of Fixed Income | Head of Rates (Deputy PM above it) |
| Macro Strategist | Head of Macro Research + regional economists |
| RV Analyst | Swaps & Spreads RV Analyst + Sovereign Spreads Analyst |
| Inflation Watcher | Inflation Strategist |
| Positioning Monitor | Positioning & Flows + Regime & Correlation + Technicals & Momentum |

---

## 2. Design principles

1. **The human stays the PM.** The top agent is a *Deputy PM* that combines desk views and makes recommendations. Final approval stays with the human PM.
2. **Ideas, risk and execution are separate reporting lines**, as in a real pod. Risk doesn't report through the people generating ideas, so it can block a trade. This also helps counter LLM agents' habit of agreeing with each other.
3. **A dedicated Red Team.** Every trade idea gets argued against before it reaches sizing.
4. **No manager has more than about 6–9 direct reports.** Each desk runs as its own unit, and the Deputy PM level coordinates desks rather than individual agents (see §6).
5. **Specialists return a standard view format:** direction, conviction, horizon, catalysts, invalidation level and preferred instrument. That lets desk heads combine views mechanically.
6. **Model tiers:** Opus for synthesis and judgement (Deputy PM, Heads, Red Team, CRO), Sonnet for specialist analysis, Haiku for routing, scanning and formatting.

---

## 3. Hierarchy

```
Portfolio Manager (human, final approval)
│
├── Deputy PM / Synthesis                         [Opus]  owns house view, ranks ideas, chairs IC
│   ├── Pod Coordinator (Chief of Staff)          [Haiku] routes questions, schedules runs, minutes
│   ├── Red Team / Devil's Advocate               [Opus]  pre-mortems every idea; reports only to Deputy PM
│   ├── Macro Themes Strategist                   [Opus]  themes: identify, track, scenarios, trades, theme risk
│   │
│   ├── Head of Macro Research                    [Opus]
│   │   ├── US Economist (Fed)
│   │   ├── Euro Area Economist (ECB, periphery fiscal)
│   │   ├── UK Economist (BoE)
│   │   ├── Japan Economist (BoJ)
│   │   ├── Dollar-Bloc & Europe ex-EA Economist (CA, AU, NZ, SE, NO, CH)
│   │   ├── China & EM Economist
│   │   ├── Central Bank Communications Analyst (speech/minutes diffs, hawk-dove scoring)
│   │   └── Geopolitics & Policy Risk Analyst (elections, tariffs, sanctions)
│   │
│   ├── Head of Rates                             [Opus]
│   │   ├── Front-End / STIR Strategist (OIS, SOFR/Euribor futures, meeting pricing)
│   │   ├── Curve & Duration Strategist (level/slope, PCA, global yield factors)
│   │   ├── Swaps & Spreads RV Analyst (swap spreads, ASW, flies)
│   │   ├── Sovereign Spreads Analyst (EGB, Gilts, JGB, UST; fitted curves)
│   │   ├── Inflation Strategist (fixings, breakevens, linker fair value)
│   │   ├── Supply & Funding Analyst (issuance, auctions, QT, repo, xccy basis)
│   │   └── Rates Volatility Strategist (swaptions, caps/floors, STIR and bond options)
│   │
│   ├── Head of FX & Cross-Asset                  [Opus]
│   │   ├── G10 FX Strategist (rate differentials, valuation, carry)
│   │   ├── EM FX & Rates Strategist
│   │   ├── Commodities Strategist (energy/metals as macro drivers)
│   │   ├── Equity & Credit Macro Strategist (index, spreads as risk appetite)
│   │   └── FX & Cross-Asset Volatility Strategist (FX, commodity, equity vol)
│   │
│   ├── Head of Quant & Positioning               [Sonnet]
│   │   ├── Positioning & Flows Analyst (COT, CTA models, Euribor positioning, flows)
│   │   ├── Technicals & Momentum Analyst
│   │   ├── Regime & Correlation Analyst
│   │   ├── Model Backtest Analyst (forecasting and statistical models, in real time)
│   │   └── Trade & Strategy Backtest Analyst (specific trades and trading strategies)
│   │
│   ├── Head of Trading & Book                    [Sonnet]
│   │   ├── Execution Strategist (instrument choice, liquidity, cost, timing, rolls)
│   │   ├── Trade Monitor (blotter, stops/targets, "is the thesis still alive?")
│   │   └── Performance & Trade Journal Analyst (P&L attribution, lessons → memory)
│   │
│   └── Shared Services (serve all desks, managed by Coordinator)   [Haiku/Sonnet]
│       ├── News & Narrative Scanner
│       ├── Calendar & Data-Release Analyst (previews, consensus, surprise indices)
│       ├── Research Librarian (sell-side digest, internal IC/archive search)
│       ├── Data Quality Sentinel (BBG/Haver pipeline freshness, outliers)
│       └── Publisher (morning note, IC slides)
│
└── Chief Risk Officer                            [Opus]  independent, reports to PM, can block trades
    ├── Market Risk & Stress Analyst (DV01/vega aggregation, VaR, scenario P&L)
    └── Portfolio Construction & Sizing Analyst (risk budget, idea correlation, hedges)
```

**Size:** 45 agents: 1 Deputy PM, 6 heads plus the CRO, and the rest specialists or services.

---

## 4. Agent roster

### 4.1 Leadership & governance

| Agent | Model | Reports to | Mandate |
|---|---|---|---|
| Deputy PM / Synthesis | Opus | PM (human) | Combines desk views into the house view, ranks trade ideas, chairs IC, recommends to PM |
| Pod Coordinator | Haiku | Deputy PM | Routes ad-hoc questions to the narrowest capable agent, schedules runs, keeps meeting minutes |
| Red Team / Devil's Advocate | Opus | Deputy PM | Argues against every proposed trade: pre-mortem, consensus check, crowding, what's already priced |
| Macro Themes Strategist | Opus | Deputy PM | Owns the book's macro themes end to end: identifies them, tracks each thesis against cross-asset prices and sell-side research, builds scenarios with probabilities, translates themes into trades, and manages risk across themes (recommends; the CRO stays independent) |
| Chief Risk Officer | Opus | PM (human) | Independent risk oversight. Owns limits and can block trades |

### 4.2 Macro Research

| Agent | Model | Mandate |
|---|---|---|
| Head of Macro Research | Opus | Regime call, global scenarios, house macro view |
| US Economist | Sonnet | US data, Fed reaction function, fiscal |
| Euro Area Economist | Sonnet | EA data, ECB reaction function, periphery/fiscal |
| UK Economist | Sonnet | UK data, BoE reaction function |
| Japan Economist | Sonnet | Japan data, BoJ / YCC / MoF |
| Dollar-Bloc & Europe ex-EA Economist | Sonnet | CA, AU, NZ, SE, NO, CH (matches existing heatmaps) |
| China & EM Economist | Sonnet | China credit impulse/policy, EM cycle spillovers |
| Central Bank Communications Analyst | Sonnet | Cross-CB text analytics: statement diffs, minutes, speeches, hawk-dove scoring |
| Geopolitics & Policy Risk Analyst | Sonnet | Elections, trade policy, sanctions, conflict risk → market scenarios |

### 4.3 Rates desk

| Agent | Model | Mandate |
|---|---|---|
| Head of Rates | Opus | Rates book view, sponsors rates trades (replaces Head of FI) |
| Front-End / STIR Strategist | Sonnet | CB meeting pricing, OIS, SOFR/Euribor futures, front-end positioning |
| Curve & Duration Strategist | Sonnet | Level/slope/curvature, PCA, global yield factor model |
| Swaps & Spreads RV Analyst | Sonnet | Swap curve RV, swap spreads, ASW, flies |
| Sovereign Spreads Analyst | Sonnet | EGB spreads, Gilts/JGB/UST cash RV, fitted curves, CTD |
| Inflation Strategist | Sonnet | Fixings, breakevens, real yields, linker fair value |
| Supply & Funding Analyst | Sonnet | Issuance/auction calendars, DMO remits, QT, repo, CB balance sheets, xccy basis |
| Rates Volatility Strategist | Sonnet | Swaptions, caps/floors, STIR and bond futures options: rich/cheap vol, skew, option-implied policy paths, option structures for the desk's views |

### 4.4 FX & Cross-Asset desk

| Agent | Model | Mandate |
|---|---|---|
| Head of FX & Cross-Asset | Opus | FX and cross-asset view, sponsors non-rates trades |
| G10 FX Strategist | Sonnet | Rate differentials, valuation (BEER/PPP), carry, flows |
| EM FX & Rates Strategist | Sonnet | EM FX and local rates, carry-to-risk |
| Commodities Strategist | Sonnet | Energy/metals/ags as macro and inflation drivers |
| Equity & Credit Macro Strategist | Sonnet | Index futures, credit spreads, risk-appetite signals |
| FX & Cross-Asset Volatility Strategist | Sonnet | FX, commodity and equity index vol, skew, option structures for non-rates views |

### 4.5 Quant & Positioning

| Agent | Model | Mandate |
|---|---|---|
| Head of Quant & Positioning | Sonnet | Combines systematic signals and positioning into a crowding/regime view |
| Positioning & Flows Analyst | Sonnet | CFTC COT, CTA model positioning, Euribor positioning, fund flows |
| Technicals & Momentum Analyst | Sonnet | Trend, momentum, print/level analysis |
| Regime & Correlation Analyst | Sonnet | Correlation regimes, cross-asset regime detection |
| Model Backtest Analyst | Sonnet | Real-time, out-of-sample tests of forecasting and statistical models (nowcasts, payrolls, inflation) against naive and consensus; checks other agents' statistical claims |
| Trade & Strategy Backtest Analyst | Sonnet | Backtests specific trades (entry/target/stop on analogues) and systematic strategies, with costs, carry, robustness and regime splits |

### 4.6 Trading & Book

| Agent | Model | Mandate |
|---|---|---|
| Head of Trading & Book | Sonnet | Oversees implementation and live book |
| Execution Strategist | Sonnet | Instrument choice (futures/swaps/bonds/options), liquidity, cost, timing, rolls |
| Trade Monitor | Sonnet | Blotter and trade watch: stops/targets, catalyst tracking, whether the thesis still holds |
| Performance & Trade Journal Analyst | Sonnet | P&L attribution, hit-rate stats, records lessons into pod memory |

### 4.7 Risk (independent line)

| Agent | Model | Mandate |
|---|---|---|
| Market Risk & Stress Analyst | Sonnet | DV01/vega/FX delta aggregation, VaR, historical and hypothetical stress P&L |
| Portfolio Construction & Sizing Analyst | Sonnet | Risk budget allocation, correlation between ideas, sizing, hedge suggestions |

### 4.8 Shared Services

| Agent | Model | Mandate |
|---|---|---|
| News & Narrative Scanner | Haiku | Real-time news triage, narrative tracking, routes items to relevant desks |
| Calendar & Data-Release Analyst | Sonnet | Weekly calendar, previews, consensus vs. pod view, surprise scoring |
| Research Librarian | Sonnet | Sell-side research digest, search over internal IC notes and past runs |
| Data Quality Sentinel | Haiku | BBG/Haver pipeline health, stale/outlier data detection |
| Publisher | Sonnet | Morning note, IC slides, weekly review |

---

## 5. Workflows

Eleven workflows are built (`WORKFLOWS` in `pod/workflows.py`). `GET /api/agents/workflows` serves each one's stages (which agents run in parallel, in which order), the agent that writes the answer, and when to use it (`USE_WHEN`); the launchpad's Agents tab and the pod page show the same.

| Workflow | Id | Use when | Path |
|---|---|---|---|
| **Ask the Pod** | `ask-pod` | A quick or narrow question and you don't know which specialist owns it | Coordinator routes it to the narrowest agent or desk, consults it, returns the answer |
| **Trade Review** | `trade-review` | You have a specific trade idea and want it through the ledger gates | Coordinator picks the sponsoring desk head → head sponsors → Red Team challenges → Sizing Analyst → CRO → Deputy PM summary → **PM approves or rejects on the pod page** |
| **Theme Review** | `theme-review` | Checking whether the themes are playing out, the probabilities are right, the trades are still the best ones, and how theme risks add up | Macro Themes Strategist reads `trade_themes`, tracks each theme, updates scenarios, reviews trades and cross-theme risk, consulting specialists as needed; publishes the review |
| **Morning Briefing** | `morning-briefing` | Start of the day: what changed, house view, morning note. The most expensive run (~37 agent runs) | News Scanner + Calendar Analyst (plus a two-day research digest) → all four research desks' specialists in parallel → desk heads → Red Team → Market Risk + Sizing → CRO → Deputy PM house view → Publisher |
| **Macro Research Briefing** | `macro-desk` | The economic outlook: cycle, CB reaction functions, politics | Desk specialists in parallel → Head of Macro Research |
| **Rates Desk Briefing** | `rates-desk` | Where the risk/reward is in rates | Desk specialists in parallel → Head of Rates |
| **FX & Cross-Asset Briefing** | `fx-desk` | Currencies, commodities, equity and credit, or options to express a view | Desk specialists in parallel → Head of FX & Cross-Asset |
| **Quant & Positioning Briefing** | `quant-desk` | Whether ideas are crowded, fighting the trend or regime, or statistically backed | Desk specialists in parallel → Head of Quant & Positioning |
| **Book Review** | `book-review` | Checking live and approved trades: implementation, theses, lessons | Trading & Book desk → Head of Trading & Book |
| **Risk Review** | `risk-review` | Before adding risk, after a large move, or when trades await sizing and the CRO | Risk desk → CRO |
| **Research Sweep** | `research-sweep` | New sell-side research has arrived (inbox, drop folder, portals) | Research Librarian ingests the inbox and drop folder, browses each logged-in portal, summarises and records each bank's calls |

Not built: an event-driven **data/CB release** workflow (Calendar flags a release → Economist + STIR → Head → alert above a surprise threshold) and scheduled runs. Both need `schedule_run` (§10).

---

## 6. Orchestration architecture

**Decision (implemented):** a thin in-house runner on the Anthropic SDK (`pod/runner.py`) with workflows as plain Python. LangGraph remains the fallback if workflows become highly dynamic. The runner also supports open-weight models through OpenRouter (web search/fetch then run locally, `pod/tools/web_local.py`); the model per agent can be changed from the UI (`PUT /api/agents/{agent_id}/model`).

### 6.1 What the pod needs from a framework

- **About 40 agents in nested desks.** Most workflows (morning meeting, event response) are fixed fan-out/fan-in pipelines, not open-ended agent conversations.
- **A trade lifecycle with hard gates:** Red Team → Sizing → CRO → PM approval. These steps must happen in order and can't be skipped. A trade's state lasts for days or weeks while it's live.
- **Rich tool access:** MCP, web search, code execution, structured outputs and prompt caching.
- **Debuggability.** For every recommendation, it must be clear which agent said what, based on which data.

### 6.2 Options considered

| | Fit | Main problem for this pod |
|---|---|---|
| **CrewAI** (the old FI pod) | Fastest to prototype | In `Process.hierarchical` the manager LLM decides who runs and when. Agents can be skipped or re-delegated, so mandatory gates aren't guaranteed. Execution was opaque (callback probing, output truncation), and Claude features arrive late through LiteLLM. |
| **LangGraph** | Strongest fit for workflows: explicit state graph, checkpointing, human-in-the-loop interrupts | Heavier abstraction and a learning curve. Most of its power is for dynamic, branching graphs, and these workflows are mostly fixed. |
| **OpenAI Agents SDK** | Clean handoff model with good tracing | Built OpenAI-first; Claude goes through an adapter. Handoffs suit routing (the Coordinator) but not gated pipelines. Ruled out for a Claude-based pod. |
| **No framework** (Anthropic SDK directly) — **chosen** | Full control. Native access to MCP, server-side web search and code execution, structured outputs and prompt caching | Agent loop, retries and tracing must be built in-house. That turned out small (`runner.py`, ~340 lines). |

### 6.3 Design as built

- **An agent is just data:** an entry in `roster.yaml` (desk, `reports_to`, tier, effort, mandate, tools, skills, `missing_tools`). `pod/roster.py` builds the system prompt from it plus the agent's skills, and adds the baseline kit (§7.2).
- **One runner** (`pod/runner.py`) runs one agent on one task: a manual tool-use loop (streamed, adaptive thinking, prompt caching, `pause_turn` resumption, a hard turn cap that asks for a final answer, refusal fallback to another model), logging every step to the SQLite `events` table. The SSE endpoint tails that table, authenticated by a 60 s run-scoped ticket.
- **Workflows are explicit Python** (`pod/workflows.py`): desks fan out with `asyncio.gather`, then each Head summarises, then the Deputy PM synthesises. `consult_agent` lets a manager call a report mid-run.
- **The trade lifecycle is a status machine in the database** (`pod/book.py`):
  `proposed → sponsored → challenged → sized → risk_approved → pm_approved → live → closed` (or `rejected`)
  Each transition is allowed only from given states and only for given roles (e.g. only `red-team` can `challenge`, only `cro` can `risk_approve` or `risk_block`, only the human `pm` can `pm_approve`). The gates can't be skipped, and state survives restarts.
- **Dynamic routing is limited to the Coordinator.** One Haiku call picks the agent or desk for an ad-hoc question or the sponsoring head for a trade idea.

---

## 7. Tools, skills & MCPs

### 7.1 Definitions and placement rules

| Type | What it is | Where it lives | Rule of thumb |
|---|---|---|---|
| **Tool** | A function the agent calls that returns data or a computation | In-process Python in `backend/`, called by the runner (§6) | Computation on our own data and models. Analytics are tools. |
| **Server tool** | Anthropic-hosted tool (web search, web fetch, code execution) | Anthropic API | Generic capabilities we shouldn't build ourselves |
| **Skill** | Packaged methodology: a `SKILL.md` playbook plus reference files and optional scripts, loaded only when relevant | `backend/pod/skills/<name>/` | Know-how the agent needs to *interpret* data correctly: frameworks, checklists, templates, house rules |
| **MCP server** | A standard connector to an external system | Separate process; the runner connects as an MCP client | Raw data or services outside `macro-kit`: Bloomberg, Haver, public statistics, news, email, drive, the real book |

**Permissions** follow the reporting lines in §3:

- All tools and MCPs are **read-only by default**.
- Write actions are limited by role:
  - trade-ledger transitions: each agent may only make the transitions its role owns (§6.3)
  - alerts
  - email *drafts* only, never auto-send
  - writes to pod memory
- **No agent ever gets an order-placement tool.** Execution stays human.

### 7.2 Baseline kit (every agent)

| Type | Items |
|---|---|
| Tools | `submit_view` (standard view schema from §2), `get_house_view`, `read_desk_views`, `search_pod_memory` (past runs, IC notes, trade journal), `list_trades`, `research_search`, `research_calls`, `sandbox_read` / `sandbox_write` / `sandbox_edit` / `sandbox_list`, `sqlite_sandbox`, `python_sandbox` (`BASELINE_TOOLS` in `pod/roster.py`) |
| Server tools | `web_search`, `web_fetch` (Anthropic server tools; run locally for OpenRouter models) |
| Skills | `pod-view-format` (schema, conviction scale, house style), `evidence-and-citation` (every number cites its tool and as-of time; stale data is flagged) |

### 7.3 Tool catalogue

Status key:
- **built:** registered in `pod/tools/` (the name in brackets is the registered name where it differs)
- **wrap:** backend module exists; needs a thin agent wrapper
- **missing:** not built; agents that need it list it under `missing_tools` in `roster.yaml`

| Tool | Status | Source / notes |
|---|---|---|
| `macro_factors` | built | DFM factors for all 30 heatmap regions (10 DM, 20 EM) |
| `swaps_rv` | built | `swaps_rv.py` |
| `egb_rv` | built | `egb_rv.py` |
| `inflation_fixings` | built | `hicp_fixings.py`, `rpi_fixings.py`, `us_cpi_fixings.py` |
| `cta_momentum` | built | `momentum.py` |
| `correlation_regimes` | built (+ `correlation_pair`) | `correlation_regimes.py` (scan + pair) |
| `macro_fair_value` | built | Regional fair value, PC regressions, yield PCA |
| `pca_analysis` | built | `pca_analysis.py` |
| `mean_reversion` | built | `mean_reversion.py` (OU fit, forward distribution, Sharpe MC, Stanton) |
| `fitted_bond_curves` | built (+ `fitted_bond_detail`, `new_issue_pricing`) | `fitted_bond_curves.py` |
| `egb_bond_finder` | built | `egb_bond_finder.py` |
| `global_yields` | built | `global_yields.py` |
| `option_implied_cdf` | built | `option_derived_cdf.py` |
| `seasonality_backtest` | built (`seasonality`) | `seasonality_backtester.py` |
| `fair_value_models` | built | `fair_value_models.py` |
| `inflation_pca` | built | `inflation_pca.py` |
| `print_analysis` | built (`print_vs_consensus`) | `print_analysis.py` (print vs consensus, market reaction) |
| `euribor_positioning` | built | `euribor_positioning_router.py` |
| `macro_options_monitor` | built (`macro_options`) | Euribor options per expiry (ATM vol, smile in bp) and the €STR OIS-implied ECB meeting path; needs Bloomberg (empty in simulation) |
| `nowcast_backtest` | built | Quant Macro models and their last saved real-time backtest (`quant_macro.get_backtest`) |
| `trade_themes` | built | The book's themes, scenarios, trades and scenario P&L from `data/trade_themes.json` (read-only) |
| `price_history` | missing | Generic historical prices for any instrument, for strategy backtests |
| `trade_blotter` | built (`list_trades`, `trade_note`) | Read view on the ledger |
| `trade_ledger` | built (`propose_trade`, `advance_trade`) | Trade status machine (§6.3), transitions permissioned by role |
| `consult_agent`, `alert` | built | Orchestration tools for the Coordinator and Heads |
| `route_question` | built differently | A routing call inside the workflows rather than a tool |
| `schedule_run` | missing | Scheduled and event-driven runs |
| `cb_pricing` | missing | OIS-implied meeting-by-meeting path for G10 (and later EM) central banks. The most-requested gap (12 agents) |
| `econ_calendar` | built | Bloomberg ECO over the release tickers in `pod/econ_universe.yaml` (verify tickers on the Terminal) |
| `bloomberg_news`, `bloomberg_reference` | built | B-PIPE headlines (stored by a news subscriber, `pod/bloomberg.py`) and ad hoc reference data |
| `surprise_index` | missing | Data surprise indices by region (7 agents) |
| `cot_positioning` | missing | CFTC COT across rates, FX, commodities and equity index futures (5 agents) |
| `supply_calendar` | missing | Auction and syndication calendar, DMO remits, net supply |
| `funding_monitor` | missing | Repo, CB balance sheets, reserves, xccy basis |
| `cb_text_diff` | missing | Statement and minutes diffs plus hawk-dove scoring over the `cb-comms-mcp` corpus |
| `fx_valuation` | missing | Rate differentials, BEER/PPP, REER |
| `fx_carry_screen` | missing | G10 and EM carry, carry-to-vol |
| `commodity_curves` | missing | Futures curves, roll yield, inventories |
| `cross_asset_snapshot` | missing | Equity index, credit spreads, VIX/MOVE, DXY, oil, gold: one-call market state |
| `vol_surface` | missing | Swaption and FX vol surfaces, skew |
| `options_pricer` | missing | Black/Bachelier pricing and greeks for structuring |
| `technicals` | missing | Levels, ranges, moving averages, RSI |
| `regime_model` | missing | HMM or clustering regime classifier |
| `event_study` | missing | Generic event study: market reaction around a list of dates |
| `risk_engine` | built | `pod/risk.py`: P&L per bp by tenor bucket, parametric scenario P&L and limit breaches on the ledger; limits in `pod/limits.yaml` (placeholders). Historical VaR (`var_model`) missing |
| `scenario_library` | built | Parametric rate scenarios (bp shocks by bucket) and the risk limits |
| `sizing_engine` | built | Sizes rate trades to a loss at the stop or a target daily P&L vol |
| `execution_cost` | missing | Compares futures, swaps, cash and options; bid-offer, liquidity windows, roll calendar, CTD |
| `pnl_attribution` | missing | P&L by trade, factor and desk; hit rate |
| `data_health` | built | Freshness, gaps and outliers per series catalogue |
| `research_search` | built (+ `research_document`, `research_list`, `research_calls`, `research_stats`, `record_research_calls`, `research_update`, `research_sweep_inputs`) | Full-text search and tracked bank calls over `var/research.db` (§9) |
| `portal_*` | built (`portal_list`, `portal_open`, `portal_fetch`, `portal_click`) | Playwright browsing of bank research portals for the Research Librarian |
| `publish_report` | built | Saves a finished report (morning note, IC memo) as Markdown in `sandbox/reports/` |
| `submit_view`, `read_desk_views`, `get_house_view`, `search_pod_memory` | built | Pod infrastructure (baseline kit) |

### 7.4 Skill catalogue

| Skill | Contents | Used by |
|---|---|---|
| `pod-view-format` | View schema, conviction scale (1–5), horizon buckets, house style | All |
| `evidence-and-citation` | Citation format, as-of timestamps, staleness thresholds | All |
| `cb-reaction-functions` | One reference file per CB (Fed, ECB, BoE, BoJ, BoC, RBA, RBNZ, Riksbank, Norges, SNB): mandate, current guidance, reaction to data, communication calendar | Economists, STIR, CB Comms, G10 FX |
| `data-release-playbook` | Per indicator: what matters, seasonal quirks, revision patterns, market beta to surprise | Economists, Calendar Analyst |
| `cb-text-analysis` | Diffing method, hawk-dove lexicon, scoring rubric | CB Comms |
| `china-macro` | Credit impulse, PBoC toolkit, data caveats | China & EM, Commodities |
| `em-risk-checklist` | Balance of payments, reserves, politics, liquidity, contagion channels | China & EM, EM FX |
| `geopolitical-scenario-mapping` | Event → scenario tree → market transmission → what's priced | Geopolitics, Red Team |
| `rv-screening-methodology` | Z-score + carry/roll + half-life + structural-reason checklist (CTD, supply, index events) | Swaps RV, Sovereign Spreads, Curve |
| `curve-trade-construction` | DV01-neutral, PCA- and beta-weighted curves and flies | Rates desk |
| `stir-mechanics` | IMM dates, convexity, turn effects, €STR–Euribor and SOFR basis | STIR |
| `sovereign-credit-checklist` | Ratings calendar, fiscal metrics, ECB TPI/QT, index eligibility | Sovereign Spreads |
| `inflation-seasonality` | HICP/RPI/CPI seasonals, base effects, energy pass-through, linker carry | Inflation |
| `supply-playbook` | Auction concessions, syndication patterns, DMO remits, month-end extension | Supply & Funding, Sovereign Spreads |
| `funding-plumbing` | Reserves, RRP/TGA, repo specials, month-end and quarter-end dynamics | Supply & Funding |
| `fx-valuation-framework` | BEER/PPP, rate-differential models, when valuation matters | FX desk |
| `commodity-macro-linkages` | Oil/gas → inflation, metals → China, OPEC+ calendar | Commodities, Inflation |
| `risk-appetite-indicators` | Equity–bond correlation, credit as a leading signal | Equity & Credit |
| `options-structuring` | Structure choice (spreads, mid-curves, conditionals), vol regime rules | Vol & Options, Execution |
| `positioning-interpretation` | COT quirks, CTA trigger levels, crowding score | Positioning, Red Team |
| `technical-analysis-rules` | Pod-approved indicators and how much weight to give them | Technicals |
| `regime-playbook` | Regime definitions and what has worked in each | Heads, Regime, Deputy PM |
| `backtest-hygiene` | Look-ahead, multiple testing, real-time vintages, minimum t-stats | Both backtesters, Red Team |
| `forecast-evaluation` | Real-time set-up, benchmarks (naive, consensus), RMSE/bias by horizon, Diebold–Mariano, surprise-sign accuracy, verdict | Model Backtest |
| `strategy-backtest-protocol` | Rule written first, costs/carry/roll, trade analogues vs unconditional, walk-forward, deflated Sharpe, regime splits | Trade & Strategy Backtest |
| `macro-themes-framework` | Theme criteria, tracking scorecard, scenario and probability rules, theme → trades with scenario P&L, cross-theme risk | Macro Themes Strategist |
| `red-team-protocol` | Pre-mortem, what's priced, consensus and crowding check, asymmetry; must output kill criteria | Red Team |
| `risk-limits-policy` | DV01 per bucket, VaR, stop-loss, concentration limits, escalation | CRO, Market Risk, Sizing |
| `stress-scenario-library` | 2013 taper tantrum, March 2020, 2022 gilt/LDI, March 2023 SVB, Aug 2024 JPY carry unwind, plus hypotheticals | Market Risk, CRO |
| `sizing-framework` | Risk-budget allocation, conviction → size mapping | Sizing, Deputy PM |
| `execution-playbook` | Instrument choice, liquidity hours, roll and delivery dates | Execution |
| `thesis-tracking` | How to judge whether a thesis is still alive; when to escalate | Trade Monitor |
| `trade-review` | Post-mortem format, lesson extraction for pod memory | Performance & Journal |
| `ic-memo-template` | IC memo and trade proposal format | Deputy PM, Heads |
| `routing-map` | Which agent or desk handles which question type | Coordinator |
| `news-triage-rules` | Relevance scoring, which desk gets which headline, alert thresholds | News Scanner |
| `data-quality-rules` | Staleness and outlier thresholds by series type | Data Quality Sentinel |
| `house-style-publishing` | Morning note and IC deck templates (based on existing `docs/slides`) | Publisher |

Skills can run through Anthropic's Agent Skills support (requires the code execution tool), or the runner can inject `SKILL.md` into context when relevant. The content is the same either way.

### 7.5 MCP catalogue

| MCP server | Status | Provides | Notes |
|---|---|---|---|
| `bloomberg-mcp` | Partly built, in-process | BDH/BDP/BDS, ECO calendar, headlines | Built as in-process tools over B-PIPE (`econ_calendar`, `bloomberg_news`, `bloomberg_reference`; §9) rather than an MCP server. Six agents still list it as missing for wider market data |
| `haver-mcp` | In-house | Haver macro series | Wraps the Haver path in `macro_data_loader.py` |
| `public-stats-mcp` | In-house (community servers exist for some sources) | FRED/ALFRED (real-time vintages), ECB Data Portal, Eurostat, BoE, ONS, BIS, IMF, OECD, CFTC, EIA, DMO/TreasuryDirect auctions, Fed H.4.1 | One server, many free APIs. ALFRED vintages matter for backtest hygiene |
| `cb-comms-mcp` | In-house | Corpus of CB statements, minutes, speeches and press conferences, with search | Scraped from CB websites and indexed |
| `news-mcp` | Depends on licence | Bloomberg/Reuters news, or RSS/newswire fallback | Feeds the News Scanner |
| `oms-pms-mcp` | In-house / vendor | Live positions, fills and P&L from the real book (read-only) | Until it exists, `trade_ledger` is the source of truth |
| `gmail` | Available | Sell-side research inbox (read), alert *drafts* | Draft-only for the pod |
| `google-drive` | Available | IC decks, research archive, published notes | |
| `google-calendar` | Available | Pod meetings, IC schedule | Low priority |
| `slack` / `teams` | If used | Alerts and morning-note distribution | Alternative to email for alerts |
| `macro-kit-mcp` | Optional | Exposes the hub's analytics as an MCP server | Lets humans use the same tools from Claude Code or Claude.ai |

### 7.6 Per-agent assignments

Everything below is **in addition to** the baseline kit in §7.2. These tables are the target design; `roster.yaml` is what each agent actually has, with the gaps under `missing_tools`. Built tools use the registered names in §7.3 (e.g. `seasonality`, `print_vs_consensus`, `propose_trade`/`advance_trade` for `trade_ledger`).

#### Leadership & governance

| Agent | Tools | Skills | MCPs |
|---|---|---|---|
| Deputy PM | `read_desk_views`, `consult_agent`, `trade_ledger` (rank/recommend), `cross_asset_snapshot`, `risk_engine` (read) | `ic-memo-template`, `regime-playbook`, `sizing-framework` | `google-drive`, `oms-pms-mcp` |
| Pod Coordinator | `route_question`, `schedule_run`, `consult_agent`, `alert` | `routing-map` | `google-calendar`, `slack`/`gmail` |
| Macro Themes Strategist | `trade_themes`, `consult_agent`, `propose_trade`, `risk_engine`, `scenario_library`, `sizing_engine`, `correlation_regimes`, `macro_factors`, `option_implied_cdf`, `macro_options`, `cross_asset_snapshot`, `event_study` | `macro-themes-framework`, `geopolitical-scenario-mapping`, `regime-playbook`, `sizing-framework` | `bloomberg-mcp`, `oms-pms-mcp` |
| Red Team | `option_implied_cdf`, `cb_pricing`, `cot_positioning`, `cta_momentum`, `correlation_regimes`, `seasonality_backtest`, `event_study` | `red-team-protocol`, `backtest-hygiene`, `positioning-interpretation`, `geopolitical-scenario-mapping` | `bloomberg-mcp` |
| Chief Risk Officer | `risk_engine`, `scenario_library`, `trade_ledger` (approve/block), `alert` | `risk-limits-policy`, `stress-scenario-library` | `oms-pms-mcp` |

The Red Team has its **own data access** on purpose, so it checks a proposal against fresh data rather than the proposer's numbers.

#### Macro Research

| Agent | Tools | Skills | MCPs |
|---|---|---|---|
| Head of Macro Research | `macro_factors` (all regions), `macro_fair_value`, `global_yields`, `surprise_index`, `option_implied_cdf` | `regime-playbook`, `cb-reaction-functions`, `ic-memo-template` | `bloomberg-mcp`, `public-stats-mcp` |
| US / Euro Area / UK / Japan / Dollar-Bloc & Europe ex-EA Economists | `macro_factors` (own regions), `macro_fair_value`, `print_analysis`, `econ_calendar`, `surprise_index`, `cb_pricing` | `cb-reaction-functions` (own CBs), `data-release-playbook` | `haver-mcp`, `bloomberg-mcp`, `public-stats-mcp`. Regional sources: FRED/ALFRED (US), ECB/Eurostat (EA), ONS/BoE (UK), BoJ/e-Stat (JP) |
| China & EM Economist | `econ_calendar`, `surprise_index`, `cross_asset_snapshot` | `china-macro`, `em-risk-checklist` | `bloomberg-mcp`, `public-stats-mcp` (IMF, BIS) |
| Central Bank Communications Analyst | `cb_text_diff`, `cb_pricing` | `cb-text-analysis`, `cb-reaction-functions` | `cb-comms-mcp` |
| Geopolitics & Policy Risk Analyst | `option_implied_cdf`, `cross_asset_snapshot`, `event_study` | `geopolitical-scenario-mapping` | `news-mcp` |

The 20 EM heatmaps (`docs/EM_HEATMAPS_PLAN.md`) now cover China and EM through `macro_factors`, but the China & EM Economist and EM FX & Rates Strategist are not yet given that tool in `roster.yaml`; both still list `em-china-data` as missing.

#### Rates desk

| Agent | Tools | Skills | MCPs |
|---|---|---|---|
| Head of Rates | `swaps_rv`, `egb_rv`, `pca_analysis`, `cb_pricing`, `global_yields`, `risk_engine` (rates book), `trade_ledger` (sponsor) | `curve-trade-construction`, `rv-screening-methodology`, `ic-memo-template` | `bloomberg-mcp` |
| Front-End / STIR Strategist | `cb_pricing`, `euribor_positioning`, `option_implied_cdf`, `cot_positioning`, `print_analysis` | `stir-mechanics`, `cb-reaction-functions` | `bloomberg-mcp`, `cb-comms-mcp` |
| Curve & Duration Strategist | `pca_analysis`, `fitted_bond_curves`, `global_yields`, `macro_fair_value`, `mean_reversion`, `seasonality_backtest` | `curve-trade-construction`, `regime-playbook` | `bloomberg-mcp` |
| Swaps & Spreads RV Analyst | `swaps_rv`, `mean_reversion`, `pca_analysis`, `egb_rv` (ASW) | `rv-screening-methodology`, `curve-trade-construction` | `bloomberg-mcp` |
| Sovereign Spreads Analyst | `egb_rv`, `egb_bond_finder`, `fitted_bond_curves`, `mean_reversion`, `supply_calendar` | `rv-screening-methodology`, `sovereign-credit-checklist`, `supply-playbook` | `bloomberg-mcp`, `public-stats-mcp` (DMOs) |
| Inflation Strategist | `inflation_fixings`, `fair_value_models`, `inflation_pca`, `seasonality_backtest`, `commodity_curves` | `inflation-seasonality`, `commodity-macro-linkages` | `bloomberg-mcp`, `haver-mcp`, `public-stats-mcp` (Eurostat, ONS, BLS) |
| Supply & Funding Analyst | `supply_calendar`, `funding_monitor` | `supply-playbook`, `funding-plumbing` | `public-stats-mcp` (DMOs, TreasuryDirect, H.4.1, ECB), `bloomberg-mcp` |
| Rates Volatility Strategist | `macro_options`, `option_implied_cdf`, `vol_surface`, `options_pricer`, `cb_pricing` | `options-structuring`, `stir-mechanics` | `bloomberg-mcp` |

#### FX & Cross-Asset desk

| Agent | Tools | Skills | MCPs |
|---|---|---|---|
| Head of FX & Cross-Asset | `cross_asset_snapshot`, `fx_valuation`, `risk_engine` (desk book), `trade_ledger` (sponsor) | `regime-playbook`, `ic-memo-template` | `bloomberg-mcp` |
| G10 FX Strategist | `fx_valuation`, `fx_carry_screen`, `cb_pricing`, `cot_positioning`, `cta_momentum`, `correlation_regimes` | `fx-valuation-framework`, `cb-reaction-functions` | `bloomberg-mcp`, `public-stats-mcp` (BIS REER) |
| EM FX & Rates Strategist | `fx_carry_screen`, `cb_pricing` (EM), `cross_asset_snapshot` | `em-risk-checklist`, `china-macro` | `bloomberg-mcp`, `public-stats-mcp` (IMF, BIS) |
| Commodities Strategist | `commodity_curves`, `cot_positioning`, `seasonality_backtest` | `commodity-macro-linkages`, `china-macro` | `bloomberg-mcp`, `public-stats-mcp` (EIA) |
| Equity & Credit Macro Strategist | `cross_asset_snapshot`, `correlation_regimes` | `risk-appetite-indicators` | `bloomberg-mcp` |
| FX & Cross-Asset Volatility Strategist | `option_implied_cdf`, `vol_surface`, `options_pricer` | `options-structuring` | `bloomberg-mcp` |

#### Quant & Positioning

| Agent | Tools | Skills | MCPs |
|---|---|---|---|
| Head of Quant & Positioning | Read access to all tools below | `regime-playbook`, `backtest-hygiene` | — |
| Positioning & Flows Analyst | `cot_positioning`, `euribor_positioning`, `cta_momentum` | `positioning-interpretation` | `public-stats-mcp` (CFTC), `bloomberg-mcp` |
| Technicals & Momentum Analyst | `technicals`, `cta_momentum`, `print_analysis` | `technical-analysis-rules` | `bloomberg-mcp` |
| Regime & Correlation Analyst | `correlation_regimes`, `regime_model`, `pca_analysis` | `regime-playbook` | `bloomberg-mcp` |
| Model Backtest Analyst | `nowcast_backtest`, `print_analysis`, `seasonality_backtest`, `mean_reversion`, `event_study` | `backtest-hygiene`, `forecast-evaluation` | `haver-mcp`, `public-stats-mcp` (ALFRED vintages) |
| Trade & Strategy Backtest Analyst | `seasonality_backtest`, `mean_reversion`, `cta_momentum`, `swaps_rv`, `egb_rv`, `price_history`, `event_study`, `execution_cost` | `backtest-hygiene`, `strategy-backtest-protocol` | `bloomberg-mcp` |

#### Trading & Book

| Agent | Tools | Skills | MCPs |
|---|---|---|---|
| Head of Trading & Book | `trade_ledger`, `trade_blotter`, `pnl_attribution`, `risk_engine` (read) | `execution-playbook` | `oms-pms-mcp` |
| Execution Strategist | `execution_cost`, `egb_bond_finder`, `options_pricer` | `execution-playbook`, `options-structuring` | `bloomberg-mcp`, `oms-pms-mcp` |
| Trade Monitor | `trade_blotter`, `trade_ledger` (flag/escalate), `econ_calendar`, `cb_pricing`, `alert` | `thesis-tracking` | `bloomberg-mcp`, `oms-pms-mcp`, `slack`/`gmail` (alerts) |
| Performance & Trade Journal Analyst | `pnl_attribution`, `trade_ledger` (history), `search_pod_memory` (write lessons) | `trade-review` | `oms-pms-mcp` |

#### Risk (independent line)

| Agent | Tools | Skills | MCPs |
|---|---|---|---|
| Market Risk & Stress Analyst | `risk_engine`, `scenario_library`, `correlation_regimes` | `stress-scenario-library`, `risk-limits-policy` | `oms-pms-mcp`, `bloomberg-mcp` |
| Portfolio Construction & Sizing Analyst | `sizing_engine`, `risk_engine`, `mean_reversion` (half-life → horizon), `correlation_regimes` | `sizing-framework`, `risk-limits-policy` | `oms-pms-mcp` |

#### Shared Services

| Agent | Tools | Skills | MCPs |
|---|---|---|---|
| News & Narrative Scanner | `route_question`, `alert` | `news-triage-rules` | `news-mcp`, `bloomberg-mcp` |
| Calendar & Data-Release Analyst | `econ_calendar`, `surprise_index`, `print_analysis` | `data-release-playbook` | `bloomberg-mcp` (ECO), `public-stats-mcp` |
| Research Librarian | `research_search`, `search_pod_memory` | `evidence-and-citation` (baseline) | `gmail` (read research), `google-drive` |
| Data Quality Sentinel | `data_health`, `alert` | `data-quality-rules` | `bloomberg-mcp`, `haver-mcp` |
| Publisher | `publish_report` | `house-style-publishing`, `ic-memo-template` | `google-drive`, `gmail` (drafts only) |

### 7.7 Remaining tool gaps, by demand

Counted from `missing_tools` in `roster.yaml` (number of agents waiting on each):

1. **`cb_pricing`** (14): OIS-implied meeting paths beyond the ECB (which `macro_options` covers). The single most useful next tool.
2. **`surprise_index`** (7).
3. **`bloomberg-mcp`** wider market data (6), **`haver-mcp`** (6) and **`oms-pms-mcp`** (6).
4. **`event_study`** (5) and **`cot_positioning`** (5).
5. **`cross_asset_snapshot`** (4) and **`options_pricer`** (3).
6. `vol_surface`, `supply_calendar`, `pnl_attribution`, `fx_valuation`, `fx_carry_screen`, `commodity_curves`, `execution_cost`, EM/China data (2 each).
7. Single requests: `price_history`, `schedule_run`, `funding_monitor`, `cb_text_diff` + `cb-comms-mcp`, `technicals`, `regime_model`, `var_model`, `news-mcp`, the `public-stats-mcp` sources, Bloomberg research (BRES).

---

## 8. Build phases (historical)

The pod was planned in three phases (core ~13 agents, research depth, multi-asset). All 42 original agents were built at once on 2026-10-13, so the phases now apply only to the tools: §7.7 is the remaining backlog.

---

## 9. Build status (2026-10-22)

**All 45 agents are built and runnable** (`backend/pod/roster.yaml`), with all 39 skills (`backend/pod/skills/`). On 2026-10-22 the Rates Volatility Strategist, the Macro Themes Strategist and two backtesters (models; trades and strategies) were added. The backtesters replace the Signal Research & Backtest Analyst, and the Volatility & Options Strategist became the FX & Cross-Asset Volatility Strategist.

- **Built tools:** 23 analytics wrappers (`pod/tools/analytics.py`, incl. `macro_options` and `nowcast_backtest`), the baseline kit (views, sandbox, web), and:
  - the trade ledger with role-checked gates (`pod/book.py`)
  - the risk engine with parametric scenarios and placeholder limits (`pod/risk.py`, `pod/limits.yaml`)
  - the sizing engine and alerts
  - `consult_agent`, `data_health`, `publish_report`, `trade_themes`
  - Bloomberg (`econ_calendar`, `bloomberg_news`, `bloomberg_reference`) and the research library (`research_*`, `portal_*`), below
- **Workflows:** all eleven in §5 (`pod/workflows.py`).
- **Not built yet:** 38 of 45 agents list gaps under `missing_tools` (§7.7). They are told about them, use primary web sources instead, and show as "limited" in the UI.
- **Risk limits in `pod/limits.yaml` are placeholders** until the PM sets them.

### Bloomberg and the research library

- **Bloomberg over B-PIPE** (`bbg.py`): host, application authentication and TLS come from the environment.
  - `econ_calendar` runs over the release tickers in `pod/econ_universe.yaml`; **verify the tickers and fields on the Terminal before relying on it**.
  - `bloomberg_news` searches headlines stored by a B-PIPE news subscriber (`pod/bloomberg.py`). Its subscription strings come from the Bloomberg admin.
  - `bloomberg_reference` gives ad hoc reference-data lookups.
  - The News Scanner and Calendar Analyst use these first, and fall back to web sources if Bloomberg isn't connected.
- **Research library** (`pod/research/`, `var/research.db`): full-text search over documents, plus a calls table that tracks each bank's forecasts and trade recommendations over time.
  - Sources: bank portals (Playwright, with a dedicated browser profile you log into by hand; `pod/research/portals.yaml`), a research inbox over IMAP, uploads and a drop folder.
  - The **Research Sweep** workflow collects, summarises and records calls. The Morning Briefing gets a digest of the last two days.
  - Every agent can search the library and read the tracked calls.
- **Not built:** programmatic Bloomberg research (BRES), pending confirmation from Bloomberg that an API exists for it; scheduled sweeps.

---

## 10. Open questions

1. **Scope:** full multi-asset (FX, commodities, equity/credit as tradeable books), or rates-centric macro where FX and cross-asset are mainly inputs? *Built as full multi-asset* (the FX & Cross-Asset desk has six agents), but its tools are mostly missing (§7.7). If the book stays rates-centric, those tools can stay low priority.
2. ~~Should the old FI pod tile stay as the Rates desk crew?~~ *Settled:* the FI pod was removed; the Rates Desk Briefing workflow covers it.
3. **How much autonomy:** should agents only ever advise, or may the Trade Monitor, Coordinator and similar agents run on a schedule and send alerts (for example by email or push notification)? *Still open.* Agents only advise today: runs start from the UI, alerts appear on the pod page, and `schedule_run` is not built.

---

## 11. Extending the pod

**Add an agent.** Add an entry to `agents:` in `backend/pod/roster.yaml` (`id`, `name`, `desk`, `reports_to`, `tier`, `effort`, `role`, `mandate`, `tools`, `skills`, optionally `is_manager` and `missing_tools`). The baseline kit is added automatically. If it should join a workflow, its desk head picks it up through `team_of()`; otherwise add it to a stage in `pod/workflows.py`. Update `routing-map` so the Coordinator can find it.

**Add a tool.** `register(Tool(name=..., description=..., input_schema=..., ...))` in a module under `backend/pod/tools/` (analytics wrappers go in `analytics.py`, calling the backend module in-process). Add the name to each agent's `tools` in `roster.yaml` and remove it from their `missing_tools`.

**Add a skill.** Create `backend/pod/skills/<name>/SKILL.md` and list it under the agents' `skills`.

**Add a workflow.** Write an `async def` taking `(runner, question)` in `pod/workflows.py`, add it to `WORKFLOWS` and `USE_WHEN` (and `HUMAN_STEP` if the PM must act), and describe its stages in `workflow_info()`. The launchpad and pod page pick it up from `/api/agents/workflows`.

Tests: `backend/tests/test_pod.py` (roster, runner, ledger gates, risk, sizing, workflows) and `test_agents_api.py` (run ownership, stream tickets, SSE tailing).
