# Global Macro Pod — Agent Roster & Hierarchy Proposal

**Status:** Draft for review
**Date:** 2026-10-09
**Scope:** Agent roster, reporting structure, orchestration architecture, and tools/skills/MCPs per agent.

---

## 1. Starting point

The current Agents section (`backend/agents/`) is a **Fixed Income pod**: one Head of Fixed Income (Opus) managing four Sonnet specialists in a single hierarchical CrewAI crew.

| Current agent | Tools |
|---|---|
| Head of Fixed Income (manager) | general tools only |
| Macro Strategist | Macro Factor Heatmap |
| RV Analyst | Swaps RV Scanner, EGB RV Scanner |
| Inflation Watcher | Inflation Fixings Monitor |
| Positioning Monitor | CTA Momentum Signals, Correlation Regime Scanner |

This is a solid core. For a global macro pod it lacks:

- FX and cross-asset coverage
- regional economists
- independent risk
- execution and book management
- a function whose job is to challenge ideas

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
│   ├── Head of Rates                             [Opus]   ← today's "Head of Fixed Income"
│   │   ├── Front-End / STIR Strategist (OIS, SOFR/Euribor futures, meeting pricing)
│   │   ├── Curve & Duration Strategist (level/slope, PCA, global yield factors)
│   │   ├── Swaps & Spreads RV Analyst (swap spreads, ASW, flies)
│   │   ├── Sovereign Spreads Analyst (EGB, Gilts, JGB, UST; fitted curves)
│   │   ├── Inflation Strategist (fixings, breakevens, linker fair value)
│   │   └── Supply & Funding Analyst (issuance, auctions, QT, repo, xccy basis)
│   │
│   ├── Head of FX & Cross-Asset                  [Opus]
│   │   ├── G10 FX Strategist (rate differentials, valuation, carry)
│   │   ├── EM FX & Rates Strategist
│   │   ├── Commodities Strategist (energy/metals as macro drivers)
│   │   ├── Equity & Credit Macro Strategist (index, spreads as risk appetite)
│   │   └── Volatility & Options Strategist (swaption/FX vol; also serves Rates)
│   │
│   ├── Head of Quant & Positioning               [Sonnet]
│   │   ├── Positioning & Flows Analyst (COT, CTA models, Euribor positioning, flows)
│   │   ├── Technicals & Momentum Analyst
│   │   ├── Regime & Correlation Analyst
│   │   └── Signal Research & Backtest Analyst (statistically checks other agents' claims)
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

**Size:** about 40 agents: 1 Deputy PM, 6 heads plus the CRO, and the rest specialists or services.

---

## 4. Agent roster

### 4.1 Leadership & governance

| Agent | Model | Reports to | Mandate |
|---|---|---|---|
| Deputy PM / Synthesis | Opus | PM (human) | Combines desk views into the house view, ranks trade ideas, chairs IC, recommends to PM |
| Pod Coordinator | Haiku | Deputy PM | Routes ad-hoc questions to the narrowest capable agent, schedules runs, keeps meeting minutes |
| Red Team / Devil's Advocate | Opus | Deputy PM | Argues against every proposed trade: pre-mortem, consensus check, crowding, what's already priced |
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

### 4.4 FX & Cross-Asset desk

| Agent | Model | Mandate |
|---|---|---|
| Head of FX & Cross-Asset | Opus | FX and cross-asset view, sponsors non-rates trades |
| G10 FX Strategist | Sonnet | Rate differentials, valuation (BEER/PPP), carry, flows |
| EM FX & Rates Strategist | Sonnet | EM FX and local rates, carry-to-risk |
| Commodities Strategist | Sonnet | Energy/metals/ags as macro and inflation drivers |
| Equity & Credit Macro Strategist | Sonnet | Index futures, credit spreads, risk-appetite signals |
| Volatility & Options Strategist | Sonnet | Swaption/FX/cross-asset vol, skew, option-implied scenarios (serves all desks) |

### 4.5 Quant & Positioning

| Agent | Model | Mandate |
|---|---|---|
| Head of Quant & Positioning | Sonnet | Combines systematic signals and positioning into a crowding/regime view |
| Positioning & Flows Analyst | Sonnet | CFTC COT, CTA model positioning, Euribor positioning, fund flows |
| Technicals & Momentum Analyst | Sonnet | Trend, momentum, print/level analysis |
| Regime & Correlation Analyst | Sonnet | Correlation regimes, cross-asset regime detection |
| Signal Research & Backtest Analyst | Sonnet | Statistically checks other agents' claims (seasonality, mean reversion, event studies) |

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

| Workflow | Path |
|---|---|
| **Morning meeting** | Shared Services (news, calendar, data QA) → desks in parallel → Heads summarise → Deputy PM house view → Publisher |
| **Data or CB event** | Calendar flags a release → relevant Economist + STIR → Head of Rates/FX → alert to Deputy PM if the surprise exceeds a threshold |
| **Trade lifecycle** | Any specialist proposes → desk Head sponsors → Red Team challenges → Sizing → CRO approves or blocks → PM decides → Execution → Trade Monitor → Journal |
| **Ad-hoc question** | Coordinator routes it to the narrowest agent or desk that can answer, and only goes up the chain if needed |

---

## 6. Orchestration architecture

**Decision (proposed):** replace CrewAI with a thin in-house runner on the Anthropic SDK, and write workflows as plain Python. LangGraph is the fallback if workflows become highly dynamic.

### 6.1 What the pod needs from a framework

- **About 40 agents in nested desks.** Most workflows (morning meeting, event response) are fixed fan-out/fan-in pipelines, not open-ended agent conversations.
- **A trade lifecycle with hard gates:** Red Team → Sizing → CRO → PM approval. These steps must happen in order and can't be skipped. A trade's state lasts for days or weeks while it's live.
- **Rich tool access:** MCP, web search, code execution, structured outputs and prompt caching.
- **Debuggability.** For every recommendation, it must be clear which agent said what, based on which data.

### 6.2 Options considered

| | Fit | Main problem for this pod |
|---|---|---|
| **CrewAI** (current) | Fastest to prototype, which is why the FI pod exists | In `Process.hierarchical` the manager LLM decides who runs and when. Agents can be skipped or re-delegated, so mandatory gates aren't guaranteed. The callback code in `crew.py` (`hasattr` probing, output truncation) shows how opaque execution is. Claude features arrive late through LiteLLM. |
| **LangGraph** | Strongest fit for workflows: explicit state graph, checkpointing, human-in-the-loop interrupts | Heavier abstraction and a learning curve. Most of its power is for dynamic, branching graphs, and these workflows are mostly fixed. |
| **OpenAI Agents SDK** | Clean handoff model with good tracing | Built OpenAI-first; Claude goes through an adapter. Handoffs suit routing (the Coordinator) but not gated pipelines. Ruled out for a Claude-based pod. |
| **No framework** (Anthropic SDK directly) | Full control. Native access to MCP, server-side web search and code execution, structured outputs and prompt caching | Agent loop, retries and tracing must be built in-house. That's small, and `storage.py` and SSE streaming already exist. |

### 6.3 Proposed design

- **An agent is just data:** a model, a system prompt, a tool list and an output schema (the standard view format from §2). Agent definitions can live in config rather than code.
- **One runner** (roughly 200–300 lines) handles the tool-use loop, retries, cost and token accounting, logging to the existing SQLite `events` table, and SSE streaming.
- **Workflows are explicit Python.** For example, the morning meeting runs desks in parallel with `asyncio.gather`, then has each Head summarise, then has the Deputy PM synthesise.
- **The trade lifecycle is a status machine in the database:**
  `proposed → sponsored → challenged → sized → risk_approved → pm_approved → live → closed`
  Each transition is triggered by a specific agent or by the PM in the UI. The gates can't be skipped, and state survives restarts.
- **Dynamic routing is limited to the Coordinator.** It uses one Haiku call to choose which agent or desk handles an ad-hoc question.

### 6.4 Migration

- The six analytics tools are already plain Python functions. The CrewAI `BaseTool` wrappers in `tools.py` become plain tool schemas plus handlers.
- The general tools (sandbox files, SQLite, Python, web) port the same way. Web search and fetch may be replaced by Anthropic's server-side tools.
- `storage.py`, the SSE endpoints and the frontend pages remain unchanged. The event shapes stay compatible.
- Update the model IDs: `claude-sonnet-4-6` / `claude-opus-4-6` become Opus 5.5, Sonnet 5.5 and Haiku 5.5, per the tiers in §2.

---

## 7. Tools, skills & MCPs

### 7.1 Definitions and placement rules

| Type | What it is | Where it lives | Rule of thumb |
|---|---|---|---|
| **Tool** | A function the agent calls that returns data or a computation | In-process Python in `backend/`, called by the runner (§6) | Computation on our own data and models. Analytics are tools. |
| **Server tool** | Anthropic-hosted tool (web search, web fetch, code execution) | Anthropic API | Generic capabilities we shouldn't build ourselves |
| **Skill** | Packaged methodology: a `SKILL.md` playbook plus reference files and optional scripts, loaded only when relevant | `backend/agents/skills/<name>/` | Know-how the agent needs to *interpret* data correctly: frameworks, checklists, templates, house rules |
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
| Tools | `submit_view` (standard view schema from §2), `get_house_view`, `read_desk_views`, `search_pod_memory` (past runs, IC notes, trade journal), `sandbox_files`, `sqlite_sandbox` |
| Server tools | `web_search`, `web_fetch`, `code_execution` (replaces the current `PythonCodeTool`) |
| Skills | `pod-view-format` (schema, conviction scale, house style), `evidence-and-citation` (every number cites its tool and as-of time; stale data is flagged) |

### 7.3 Tool catalogue

Status key:
- **exists:** already a CrewAI tool in `tools.py`
- **wrap:** backend module and API route exist; needs a thin agent wrapper
- **backend:** a dashboard page exists but has no backend function yet (synthetic frontend data)
- **new:** must be built

| Tool | Status | Source / notes |
|---|---|---|
| `macro_factors` | exists | DFM factors. Extend from 4 regions to all 10 heatmaps (EA, UK, US, JP, CA, SE, NO, CH, AU, NZ) |
| `swaps_rv` | exists | `swaps_rv.py` |
| `egb_rv` | exists | `egb_rv.py` |
| `inflation_fixings` | exists | `hicp_fixings.py`, `rpi_fixings.py`, `us_cpi_fixings.py` |
| `cta_momentum` | exists | `momentum.py` |
| `correlation_regimes` | exists | `correlation_regimes.py` (scan + pair) |
| `macro_fair_value` | wrap | Regional `fair-value`, `pc-regressions`, `yield-pca` routes |
| `pca_analysis` | wrap | `pca_analysis.py` |
| `mean_reversion` | wrap | `mean_reversion.py` (OU fit, forward distribution, Sharpe MC, Stanton) |
| `fitted_bond_curves` | wrap | `fitted_bond_curves.py` (curve, bond lookup, new-issue pricing) |
| `egb_bond_finder` | wrap | `egb_bond_finder.py` |
| `global_yields` | wrap | `global_yields.py` |
| `option_implied_cdf` | wrap | `option_derived_cdf.py` |
| `seasonality_backtest` | wrap | `seasonality_backtester.py` |
| `fair_value_models` | wrap | `fair_value_models.py` |
| `inflation_pca` | wrap | `inflation_pca.py` |
| `print_analysis` | wrap | `print_analysis.py` (print vs consensus, market reaction) |
| `euribor_positioning` | wrap | `euribor_positioning_router.py` |
| `macro_options_monitor` | backend | Page `MacroOptionsMonitor.tsx` only |
| `trade_blotter` | backend | Page only; becomes the read view on `trade_ledger` |
| `trade_ledger` | new | Trade status machine (§6.3); transitions permissioned by role |
| `route_question`, `schedule_run`, `consult_agent`, `alert` | new | Orchestration tools for the Coordinator and Heads |
| `cb_pricing` | new | OIS-implied meeting-by-meeting path for G10 (and later EM) central banks |
| `econ_calendar` | new | Releases, consensus and prior values (from the Bloomberg ECO screen via `bloomberg-mcp`) |
| `surprise_index` | new | Data surprise indices by region |
| `cot_positioning` | new | CFTC COT across rates, FX, commodities and equity index futures (generalises Euribor positioning) |
| `supply_calendar` | new | Auction and syndication calendar, DMO remits, net supply |
| `funding_monitor` | new | Repo, CB balance sheets, reserves, xccy basis. Fills the empty Funding section |
| `cb_text_diff` | new | Statement and minutes diffs plus hawk-dove scoring over the `cb-comms-mcp` corpus |
| `fx_valuation` | new | Rate differentials, BEER/PPP, REER |
| `fx_carry_screen` | new | G10 and EM carry, carry-to-vol |
| `commodity_curves` | new | Futures curves, roll yield, inventories |
| `cross_asset_snapshot` | new | Equity index, credit spreads, VIX/MOVE, DXY, oil, gold: one-call market state |
| `vol_surface` | new | Swaption and FX vol surfaces, skew |
| `options_pricer` | new | Black/Bachelier pricing and greeks for structuring |
| `technicals` | new | Levels, ranges, moving averages, RSI |
| `regime_model` | new | HMM or clustering regime classifier |
| `event_study` | new | Generic event study: market reaction around a list of dates |
| `risk_engine` | new | DV01/vega/FX-delta aggregation, VaR, scenario P&L on the live book |
| `scenario_library` | new | Historical and hypothetical stress scenarios as shock vectors |
| `sizing_engine` | new | Vol targeting, risk budget, correlation between ideas, hedge ratios |
| `execution_cost` | new | Compares futures, swaps, cash and options; bid-offer, liquidity windows, roll calendar, CTD |
| `pnl_attribution` | new | P&L by trade, factor and desk; hit rate |
| `data_health` | new | Freshness, gaps and outliers per series catalogue |
| `research_search` | new | Vector search over sell-side PDFs and internal notes |
| `publish_report` | new | Markdown to PDF/HTML, plus a wrapper around `docs/build_ic_slides.py` |

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
| `backtest-hygiene` | Look-ahead, multiple testing, real-time vintages, minimum t-stats | Signal Research, Red Team |
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
| `bloomberg-mcp` | In-house | BDH/BDP/BDS, ECO calendar, headlines if licensed | Extends `backend/bbg.py` (only `bdh` today). Main market data source for most desks |
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

Everything below is **in addition to** the baseline kit in §7.2.

#### Leadership & governance

| Agent | Tools | Skills | MCPs |
|---|---|---|---|
| Deputy PM | `read_desk_views`, `consult_agent`, `trade_ledger` (rank/recommend), `cross_asset_snapshot`, `risk_engine` (read) | `ic-memo-template`, `regime-playbook`, `sizing-framework` | `google-drive`, `oms-pms-mcp` |
| Pod Coordinator | `route_question`, `schedule_run`, `consult_agent`, `alert` | `routing-map` | `google-calendar`, `slack`/`gmail` |
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

China & EM has no heatmap today. An EM/China data set is a tools gap.

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

#### FX & Cross-Asset desk

| Agent | Tools | Skills | MCPs |
|---|---|---|---|
| Head of FX & Cross-Asset | `cross_asset_snapshot`, `fx_valuation`, `risk_engine` (desk book), `trade_ledger` (sponsor) | `regime-playbook`, `ic-memo-template` | `bloomberg-mcp` |
| G10 FX Strategist | `fx_valuation`, `fx_carry_screen`, `cb_pricing`, `cot_positioning`, `cta_momentum`, `correlation_regimes` | `fx-valuation-framework`, `cb-reaction-functions` | `bloomberg-mcp`, `public-stats-mcp` (BIS REER) |
| EM FX & Rates Strategist | `fx_carry_screen`, `cb_pricing` (EM), `cross_asset_snapshot` | `em-risk-checklist`, `china-macro` | `bloomberg-mcp`, `public-stats-mcp` (IMF, BIS) |
| Commodities Strategist | `commodity_curves`, `cot_positioning`, `seasonality_backtest` | `commodity-macro-linkages`, `china-macro` | `bloomberg-mcp`, `public-stats-mcp` (EIA) |
| Equity & Credit Macro Strategist | `cross_asset_snapshot`, `correlation_regimes` | `risk-appetite-indicators` | `bloomberg-mcp` |
| Volatility & Options Strategist | `macro_options_monitor`, `option_implied_cdf`, `vol_surface`, `options_pricer` | `options-structuring` | `bloomberg-mcp` |

#### Quant & Positioning

| Agent | Tools | Skills | MCPs |
|---|---|---|---|
| Head of Quant & Positioning | Read access to all tools below | `regime-playbook`, `backtest-hygiene` | — |
| Positioning & Flows Analyst | `cot_positioning`, `euribor_positioning`, `cta_momentum` | `positioning-interpretation` | `public-stats-mcp` (CFTC), `bloomberg-mcp` |
| Technicals & Momentum Analyst | `technicals`, `cta_momentum`, `print_analysis` | `technical-analysis-rules` | `bloomberg-mcp` |
| Regime & Correlation Analyst | `correlation_regimes`, `regime_model`, `pca_analysis` | `regime-playbook` | `bloomberg-mcp` |
| Signal Research & Backtest Analyst | `seasonality_backtest`, `mean_reversion`, `event_study` | `backtest-hygiene` | `bloomberg-mcp`, `haver-mcp`, `public-stats-mcp` (ALFRED vintages) |

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

### 7.7 Build backlog, ordered for Phase 1 (§9)

1. **Port the 6 existing tools and the general tools** to the new runner (§6.4).
2. **Wrap the existing backend modules** (status `wrap`, 12 tools). Each is a thin wrapper over a module that already has an API route.
3. **Pod infrastructure:** `trade_ledger`, `submit_view`, `read_desk_views`, `search_pod_memory`, `route_question`, `alert`.
4. **`bloomberg-mcp`**, by extending `bbg.py` with BDP/BDS/ECO. Most new tools depend on it.
5. **Phase 1 analytics:** `cb_pricing`, `risk_engine`, `scenario_library`, `supply_calendar`, `cot_positioning`, `econ_calendar`.
6. **Phase 1 skills:** baseline skills, plus `red-team-protocol`, `risk-limits-policy`, `cb-reaction-functions`, `rv-screening-methodology`, `curve-trade-construction`, `stir-mechanics`, `inflation-seasonality`, `routing-map`.
7. **`news-mcp`** (depends on licence) and `public-stats-mcp`.
8. **Later phases:** FX/commodity/vol tools, `sizing_engine`, `execution_cost`, `cb-comms-mcp`, `oms-pms-mcp`, and backends for Macro Options Monitor and Trade Blotter.

---

## 8. Mapping from the current pod

| Current | Proposed |
|---|---|
| Head of Fixed Income | Head of Rates (new Deputy PM above it) |
| Macro Strategist | Head of Macro Research + regional economists (matching the 10 country heatmaps) |
| RV Analyst | Swaps & Spreads RV Analyst + Sovereign Spreads Analyst |
| Inflation Watcher | Inflation Strategist |
| Positioning Monitor | Positioning & Flows + Regime & Correlation + Technicals & Momentum |

### New agents with existing dashboard tools

| Agent | Existing tools |
|---|---|
| Front-End / STIR Strategist | Euribor Positioning, Option-Implied Macro Scenario Probabilities |
| Volatility & Options Strategist | Macro Options Monitor |
| Curve & Duration Strategist | Fitted Bond Curves, PCA Analysis, Factor Model for Global Yields |
| Signal Research & Backtest Analyst | Seasonality Backtester, Mean Reversion (OU) |
| Trade Monitor | Trade Blotter and Trade Watch |
| Inflation Strategist | Fair Value Models, Inflation PCA (in addition to Fixings Monitor) |

### Main gap

The FX & Cross-Asset desk, the Risk line and Execution have **no tools yet**. That's the main gap to plan for at the tools stage.

---

## 9. Build phases

| Phase | Agents | Notes |
|---|---|---|
| **1 — Core** (~13) | Deputy PM, Coordinator, Red Team, CRO, Head of Macro Research, Head of Rates, 6 Rates specialists, Positioning & Flows, News Scanner, Trade Monitor | Mostly reuses existing tools |
| **2 — Research depth** | Regional economists, CB Communications Analyst, Calendar & Data-Release Analyst, Quant desk | |
| **3 — Multi-asset** | FX & Cross-Asset desk, rest of Risk, Execution | Needs new data and tools |

### Build status (2026-10-13)

**All 42 agents are built and runnable** (`backend/pod/roster.yaml`), with all 35 skills (`backend/pod/skills/`). The phases above now apply to the **tools**, not the agents.

- **Built tools:** the 20 analytics wrappers, sandbox and web tools, views, and:
  - the trade ledger with role-checked gates (`pod/book.py`)
  - the risk engine with parametric scenarios and placeholder limits (`pod/risk.py`, `pod/limits.yaml`)
  - the sizing engine and alerts
  - `consult_agent`, `data_health`, `research_search` and `publish_report`
- **Workflows:** ask-pod, trade-review, morning-briefing, one briefing per research desk, book-review, risk-review (`pod/workflows.py`).
- **Not built yet:** each agent lists its gaps as `missing_tools`. It is told about them, uses primary web sources instead, and shows as "limited" in the UI (36 of 42). The main gaps:
  - `bloomberg-mcp` and its dependants: `econ_calendar`, `cb_pricing`, FX, commodity and vol analytics, `execution_cost`
  - `news-mcp`, `oms-pms-mcp` and `pnl_attribution`
  - EM/China data and the CB communications corpus
- **Risk limits in `pod/limits.yaml` are placeholders** until the PM sets them.

---

## 10. Open questions

1. **Scope:** full multi-asset (FX, commodities, equity/credit as tradeable books), or rates-centric macro where FX and cross-asset are mainly inputs? If it's rates-centric, the FX & Cross-Asset desk shrinks to 2–3 agents.
2. **Should the current FI pod tile stay** as the Rates desk crew, or be replaced by the full pod?
3. **How much autonomy:** should agents only ever advise, or may the Trade Monitor, Coordinator and similar agents run on a schedule and send alerts (for example by email or push notification)?

---

## 11. Reviewer notes

<!-- Add suggestions below, or inline anywhere above -->
