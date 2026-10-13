> **Superseded.** The CrewAI implementation described here (`backend/agents/{agents,crew,tasks,tools,general_tools}.py`) was removed in October 2026. Only `backend/agents/storage.py` (run/event storage) remains, used by the Global Macro Pod in `backend/pod/` — see `GLOBAL_MACRO_POD_PROPOSAL.md`. Kept for historical context.

# Fixed Income Pod — AI Agents Documentation

**Last updated:** October 2026  
**Stack addition:** CrewAI 1.x · Anthropic API · claude-sonnet-4-6 · claude-opus-4-6

---

## Table of Contents

1. [Overview](#1-overview)
2. [Agent Roster](#2-agent-roster)
3. [How LLM Calls Are Made](#3-how-llm-calls-are-made)
4. [Backend Architecture](#4-backend-architecture)
   - 4.1 Package Layout
   - 4.2 Execution Flow — Individual Agent
   - 4.3 Execution Flow — Full Crew (Fixed Income Pod)
   - 4.4 Streaming (SSE)
   - 4.5 Persistence
5. [Tools — Analytics Wrappers](#5-tools--analytics-wrappers)
6. [API Reference](#6-api-reference)
7. [Frontend](#7-frontend)
8. [Configuration & Environment](#8-configuration--environment)
9. [Adding a New Agent or Tool](#9-adding-a-new-agent-or-tool)

---

## 1. Overview

The **Fixed Income Pod** is a crew of AI agents embedded in the analytics hub. Each agent is a specialist with a defined role, a set of analytics tools, and a backing LLM. Agents can be used in two modes:

| Mode | Entry point | Process |
|------|------------|---------|
| **Individual** | Click any specialist tile (e.g. *Macro Strategist*) | One agent, one task, sequential |
| **Full crew** | Click *Fixed Income Pod* tile | 5 agents, hierarchical, manager-driven |

In individual mode the user has a chat-style interface with pre-built workflow templates. In crew mode the user submits a single question and the Crew Chief orchestrates all four specialists before synthesising a final view.

---

## 2. Agent Roster

| Agent | ID | Model | Tools | Role |
|-------|----|-------|-------|------|
| Macro Strategist | `macro-strategist` | claude-sonnet-4-6 | Macro Factor Heatmap | Top-down macro factor analysis across EUR, GBP, USD, JPY |
| RV Analyst | `rv-analyst` | claude-sonnet-4-6 | Swaps RV Scanner, EGB RV Scanner | Relative value in EUR swaps and EGB curves/flies |
| Inflation Watcher | `inflation-watcher` | claude-sonnet-4-6 | Inflation Fixings Monitor | EUR HICP, GBP RPI, USD CPI implied fixing dynamics |
| Positioning Monitor | `positioning-monitor` | claude-sonnet-4-6 | CTA Momentum Signals, Correlation Regime Scanner | CTA trend signals and correlation regime breaks |
| Head of Fixed Income | `crew-chief` | claude-opus-4-6 | *(none — reads task outputs only)* | Crew manager; synthesises specialist inputs into trade ideas |

The Crew Chief runs on **claude-opus-4-6** (higher reasoning, used only for synthesis). All specialists run on **claude-sonnet-4-6** (faster, cost-efficient for data retrieval and analysis).

---

## 3. How LLM Calls Are Made

### 3.1 Call chain

```
Browser  →  POST /api/agents/{agent_id}/run
         →  FastAPI starts daemon thread
         →  run_single_agent_background(run_id, agent_id, question)
         →  CrewAI Crew.kickoff()
         →  LiteLLM  →  Anthropic API  (claude-sonnet-4-6 / claude-opus-4-6)
         →  Agent decides to use a tool
         →  Tool._run() called locally (no HTTP — direct Python import)
         →  Tool result fed back to LLM as context
         →  LLM produces final answer
         →  SSE queue  →  browser stream
```

### 3.2 LLM configuration

Defined in `backend/agents/agents.py`:

```python
from crewai import LLM

sonnet = LLM(
    model="anthropic/claude-sonnet-4-6",
    api_key=os.getenv("ANTHROPIC_API_KEY"),
    temperature=0.2,
)

opus = LLM(
    model="anthropic/claude-opus-4-6",
    api_key=os.getenv("ANTHROPIC_API_KEY"),
    temperature=0.3,
)
```

CrewAI uses **LiteLLM** as its LLM routing layer. LiteLLM translates the `anthropic/` prefix into a direct Anthropic API call using the `ANTHROPIC_API_KEY` environment variable. No other credential is needed.

### 3.3 Tool use within a single agent turn

When CrewAI calls the LLM, it passes the agent's tools in the system prompt. If the LLM responds with a tool call, CrewAI:

1. Intercepts the response before returning it to the caller
2. Instantiates the tool and calls `tool._run(input)`
3. Appends the tool output to the conversation context
4. Calls the LLM again with the updated context

This loop continues until the LLM produces a final answer (no tool call in the response). The `max_iter` setting on each agent caps the number of reasoning steps.

### 3.4 Tool calls are local — no HTTP

All six analytics tools **import and call the underlying Python functions directly** from the same process. They do not make HTTP requests back to the FastAPI server. This avoids authentication overhead and latency.

```python
# Example: SwapsRVTool._run()
from swaps_rv import compute_rv          # same module already loaded by main.py
data = compute_rv(currency="EUR")        # direct function call, in-process
```

---

## 4. Backend Architecture

### 4.1 Package layout

```
backend/
└── agents/
    ├── __init__.py
    ├── storage.py      SQLite persistence (runs + events tables)
    ├── tools.py        CrewAI BaseTool subclasses wrapping analytics functions
    ├── agents.py       Agent definitions, LLM instances, ROSTER, AGENTS_BY_ID
    ├── tasks.py        Task factory for full-crew runs (build_tasks)
    └── crew.py         Crew assembly, background runners, SSE queue registry
```

### 4.2 Execution flow — individual agent

```
POST /api/agents/{agent_id}/run
│
├── Validates agent_id against AGENTS_BY_ID
├── create_run(run_id, question, username, agent_id)   → DB status: pending
├── threading.Thread → run_single_agent_background(run_id, agent_id, question)
│   │
│   ├── _run_queues[run_id] = queue.Queue()
│   ├── update_run_status(run_id, "running")
│   ├── Build Task(description=question, agent=agent)
│   ├── Build Crew(agents=[agent], process=Process.sequential)
│   ├── crew.kickoff()   ← blocks until LLM finishes
│   │   ├── step_callback → _put(queue, "tool_use" | "thinking" | "step")
│   │   └── task_callback → _put(queue, "task_done")
│   ├── update_run_status(run_id, "done", final_output)
│   ├── _put(queue, "synthesis", agent.role, final_output)
│   └── queue.put({"type": "done"})
│
└── Returns {"run_id": "...", "status": "pending"}
```

### 4.3 Execution flow — full crew (Fixed Income Pod)

```
POST /api/agents/run
│
├── create_run(run_id, question, username, agent_id="fixed-income-pod")
├── threading.Thread → run_crew_background(run_id, question)
│   │
│   ├── build_tasks(question) → [task_macro, task_rv, task_inflation,
│   │                            task_positioning, task_synthesis]
│   ├── Crew(
│   │     agents=[macro_strategist, rv_analyst, inflation_watcher, positioning_monitor],
│   │     process=Process.hierarchical,
│   │     manager_agent=crew_chief,        ← opus-4-6
│   │   )
│   │
│   │   Hierarchical flow:
│   │   crew_chief reviews question → delegates task_macro to macro_strategist
│   │                               → delegates task_rv to rv_analyst
│   │                               → delegates task_inflation to inflation_watcher
│   │                               → delegates task_positioning to positioning_monitor
│   │                               → executes task_synthesis (context = all 4 outputs)
│   │
│   └── Final synthesis output → queue → SSE → browser
```

`task_synthesis` has `context=[task_macro, task_rv, task_inflation, task_positioning]` which passes all four specialist outputs to the Crew Chief before it writes the final view.

### 4.4 Streaming (SSE)

The browser opens a `GET /api/agents/stream/{run_id}?token=<jwt>` endpoint after receiving the `run_id`. Token is passed as a query parameter because the browser's `EventSource` API does not support custom request headers.

The SSE generator in `main.py`:

1. **Replays** any events already stored in the DB (handles late connections and page refreshes)
2. If the run is already `done`/`error`, sends the final state and closes immediately
3. Otherwise, polls `_run_queues[run_id]` every 300ms and yields each event as `data: {json}\n\n`
4. Closes when it receives a `"done"` or `"error"` event

Event shapes:

```json
{"type": "status",    "agent": "system",              "content": "Crew assembling…"}
{"type": "tool_use",  "agent": "Macro Strategist",    "content": "Using tool: Macro Factor Heatmap"}
{"type": "thinking",  "agent": "Working…",            "content": "…LLM intermediate text…"}
{"type": "task_done", "agent": "RV Analyst",          "content": "…full task output…"}
{"type": "synthesis", "agent": "Head of Fixed Income","content": "## Fixed Income Pod Briefing\n…"}
{"type": "done",      "run_id": "…",                  "content": ""}
{"type": "error",     "run_id": "…",                  "content": "ExceptionType: message"}
```

### 4.5 Persistence

Database: `backend/data/agent_runs.db` (SQLite, auto-created on startup via `init_db()`).

```sql
CREATE TABLE runs (
    run_id      TEXT PRIMARY KEY,
    created_at  TEXT NOT NULL,        -- ISO 8601 UTC
    question    TEXT NOT NULL,
    status      TEXT NOT NULL,        -- pending | running | done | error
    output      TEXT,                 -- final synthesis markdown, NULL until done
    username    TEXT,
    agent_id    TEXT NOT NULL DEFAULT 'fixed-income-pod'
);

CREATE TABLE events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      TEXT NOT NULL,
    timestamp   TEXT NOT NULL,
    agent_name  TEXT NOT NULL,
    event_type  TEXT NOT NULL,
    content     TEXT NOT NULL
);
```

`agent_id` links runs to the agent that handled them, enabling per-agent history filtering via `GET /api/agents/runs?agent_id=macro-strategist`.

---

## 5. Tools

### 5.1 Domain analytics tools (`backend/agents/tools.py`)

These tools call existing analytics functions directly (no HTTP). Each agent has a designated subset.

| Tool class | Agent | Underlying function | Output |
|------------|-------|---------------------|--------|
| `MacroHeatmapTool` | Macro Strategist | `get_daily_factors()` × 4 regions | DFM factor scores for EUR/GBP/USD/JPY |
| `SwapsRVTool` | RV Analyst | `compute_rv(currency="EUR")` | Top 12 curve/fly structures by z-score, carry, C/V ratio |
| `EGBRVTool` | RV Analyst | `compute_egb_rv()` | Top 12 EGB spread structures by z-score |
| `InflationTool` | Inflation Watcher | `get_hicp_fixings()`, `get_rpi_fixings()`, `get_us_cpi_fixings()` | Next 6 monthly fixings per currency |
| `MomentumTool` | Positioning Monitor | `compute_cta_signals(ticker)` × 5 tickers | 1M/3M/6M/12M signals + composite |
| `CorrelationRegimesTool` | Positioning Monitor | `run_scan()` | Top 10 correlation regime breaks |

### 5.2 General-purpose tools (`backend/agents/general_tools.py`)

All agents receive the full set of general tools in addition to their domain tools.

| Tool class | Capability | Notes |
|------------|------------|-------|
| `SandboxFileReadTool` | Read any file in the sandbox | Supports text, CSV, JSON, Markdown, Python, and PDF (via pdfplumber) |
| `SandboxFileWriteTool` | Create or overwrite a file in the sandbox | Parent directories created automatically |
| `SandboxFileEditTool` | Targeted patch in a sandbox file | Replaces an exact `old_text` block with `new_text`; fails if not unique |
| `SandboxDirectoryTool` | List sandbox contents | Shows filenames and sizes; traverses subdirectories |
| `SandboxSQLiteTool` | Run SQL against a `.db` file in the sandbox | Supports SELECT, INSERT, CREATE, UPDATE, DELETE; DB created if absent |
| `PythonCodeTool` | Execute arbitrary Python in a subprocess | `cwd=SANDBOX_ROOT`; 60 s timeout; full venv available |
| `WebSearchTool` | DuckDuckGo web search | Returns top N results (title, URL, snippet); no API key required |
| `WebFetchTool` | Fetch and read a URL as plain text | HTML stripped; 8 KB output cap; 15 s timeout |

#### Sandbox enforcement

All file and database operations are restricted to:
```
projects/macro-kit/sandbox/
```

The `_safe(path)` helper in `general_tools.py` resolves any input path to an absolute path and calls `.relative_to(SANDBOX_ROOT)`. If the resolved path is outside the sandbox (e.g. a `../../` traversal), the tool returns a `[SANDBOX ERROR]` string and the agent cannot proceed. The LLM sees the error and must stay within bounds.

The Python code executor runs with `cwd=SANDBOX_ROOT` and uses the server's Python interpreter, giving agents access to all installed packages (pandas, numpy, scipy, etc.). It does not impose import restrictions — code can import any available library. The 60-second timeout prevents runaway processes.

#### Not yet implemented

| Capability | How to add |
|---|---|
| Email / calendar | Wire an MCP server (Gmail or Outlook OAuth); expose as a `BaseTool` wrapper |
| Bloomberg API calls | Already available indirectly — analytics tools call Bloomberg if `ANALYTICS_DATA_SOURCE=bloomberg` |
| Real-time streaming data | Requires a separate streaming architecture (WebSocket or server push) |
| Interactive browser control | Not practical with current agent architecture |

---

## 6. API Reference

### Roster

```
GET  /api/agents/roster
Authorization: Bearer <jwt>

Response: { "roster": [ { id, name, role, tools, model, is_manager }, ... ] }
```

### Start a full crew run

```
POST /api/agents/run
Authorization: Bearer <jwt>
Body: { "question": "string" }

Response: { "run_id": "uuid", "status": "pending" }
```

### Start a single-agent run

```
POST /api/agents/{agent_id}/run
Authorization: Bearer <jwt>
Body: { "question": "string" }

agent_id: macro-strategist | rv-analyst | inflation-watcher |
          positioning-monitor | crew-chief

Response: { "run_id": "uuid", "status": "pending" }
```

### Stream run events (SSE)

```
GET  /api/agents/stream/{run_id}?token=<jwt>
(No Authorization header — EventSource limitation; token passed as query param)

Content-Type: text/event-stream
Events: see Section 4.4 for shapes
```

### Run history

```
GET  /api/agents/runs[?agent_id=<id>]
Authorization: Bearer <jwt>

Response: { "runs": [ { run_id, created_at, question, status, agent_id }, ... ] }
```

### Run detail

```
GET  /api/agents/runs/{run_id}
Authorization: Bearer <jwt>

Response: { "run": { ...all columns... }, "events": [ { timestamp, agent_name, event_type, content }, ... ] }
```

---

## 7. Frontend

### Pages

| File | Route | Purpose |
|------|-------|---------|
| `pages/AgentsPod.tsx` | `/tools/agents/fixed-income-pod` | Full-crew briefing room: pod grid, question input, SSE feed, synthesis card, past briefings |
| `pages/AgentPage.tsx` | `/tools/agents/:agentId` | Individual agent chat: sidebar with tools + workflow templates, chat bubbles, streaming, history |

`AgentPage.tsx` is a single parameterised component — the same file handles all five individual agents. It reads `agentId` from the URL via React Router's `useParams`, fetches the matching entry from `/api/agents/roster`, and adapts the UI accordingly.

React Router resolves `/tools/agents/fixed-income-pod` before the wildcard `:agentId` route because it is defined first in `App.tsx`.

### Workflow templates

Pre-built prompts per agent are defined as a static `TEMPLATES` record in `AgentPage.tsx`. Clicking a template pre-fills the input and focuses the textarea. They are intentionally hardcoded to keep the feature simple; no backend round-trip is needed.

### Streaming in the browser

```typescript
const es = new EventSource(`/api/agents/stream/${runId}?token=${encodeURIComponent(token)}`)

es.onmessage = (e) => {
  const ev = JSON.parse(e.data)
  if (ev.type === 'synthesis') { /* render final answer */ }
  if (ev.type === 'done')      { es.close(); refreshHistory() }
  if (ev.type === 'error')     { showError(ev.content); es.close() }
  else                         { appendToStreamFeed(ev) }
}
```

Intermediate events (`tool_use`, `thinking`, `step`, `task_done`) are shown in a compact stream feed with a blinking cursor while the agent is running. On completion the stream feed is replaced by the markdown-rendered synthesis card.

---

## 8. Configuration & Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key — used by LiteLLM for all LLM calls |

Set in shell before starting the backend:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
source .venv/bin/activate
cd backend && uvicorn main:app --reload --port 8000
```

No other agent-specific configuration is needed. Model IDs and temperatures are hardcoded in `backend/agents/agents.py` and can be changed there.

---

## 9. Adding a New Agent or Tool

### Add a new analytics tool

1. Create a `BaseTool` subclass in `backend/agents/tools.py`:

```python
class MyNewTool(BaseTool):
    name: str = "My Tool Name"
    description: str = "What this tool does and when the agent should use it."
    args_schema: Type[BaseModel] = _Query

    def _run(self, query: str = "current") -> str:
        from my_module import my_function
        data = my_function()
        return format_as_compact_text(data)   # keep under ~2 KB
```

2. Assign it to the relevant agent in `backend/agents/agents.py`:

```python
from agents.tools import MyNewTool

my_agent = Agent(
    ...
    tools=[..., MyNewTool()],
)
```

3. Update the `ROSTER` entry for that agent to include the new tool name.

### Add a new agent

1. Define it in `backend/agents/agents.py` following the existing pattern (role, goal, backstory, tools, llm, max_iter).
2. Add it to `AGENTS_BY_ID` and `ROSTER`.
3. Add workflow templates to the `TEMPLATES` record in `frontend/src/pages/AgentPage.tsx`.
4. Add a tile to `dashboard_config.yaml` under the `agents` category with `url: /tools/agents/<agent-id>`.
5. No route change needed — `AgentPage.tsx` handles any `:agentId` dynamically.
6. If the new agent should participate in full-crew runs, add it to the `agents` list in `_build_crew()` in `crew.py` and add a corresponding task in `tasks.py`.
