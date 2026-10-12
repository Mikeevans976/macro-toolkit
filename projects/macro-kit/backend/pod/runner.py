"""
The agent runner: one agent, one task, a manual tool-use loop.

Two providers:
- Anthropic (default): Claude via the Anthropic SDK.
- OpenRouter: open-weight models through OpenRouter's OpenAI-compatible
  chat-completions API. Anthropic-only features (server web tools, prompt
  caching controls, adaptive thinking, refusal fallback) are replaced or
  dropped: web search/fetch run locally instead (pod/tools/web_local.py).

Why a manual loop rather than an SDK tool runner: the pod needs per-step
events for the SSE feed, `pause_turn` resumption for server tools, and a hard
turn cap that asks for a final answer instead of cutting the agent off.

Anthropic request shape per turn:
- streaming (`.stream(...).get_final_message()`), so the 64K max_tokens
  never hits an HTTP timeout
- adaptive thinking with summarized display, so reasoning can be shown live
- effort from the roster (high for heads, medium for specialists)
- top-level automatic prompt caching; the system prompt and tool list are
  stable per agent, so later turns and later runs hit the cache
- server-side refusal fallback on Opus/Sonnet 5.5
"""
import asyncio
import json
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

import anthropic
import httpx

from pod import models, storage
from pod.config import (FALLBACK_BETA, FALLBACK_MODELS, MAX_PAUSE_CONTINUATIONS, MAX_TOKENS,
                        MAX_TURNS, OPENROUTER_APP_TITLE, OPENROUTER_BASE_URL, OPENROUTER_MAX_TOKENS)
from pod.roster import AgentDef
from pod.tools import Tool, ToolContext
from pod.tools.web_local import LOCAL_WEB_TOOLS

# emit(event_type, agent_name, content). Event types match the SSE feed:
# status | thinking | step | tool_use | task_done | synthesis
Emit = Callable[[str, str, str], None]

_USAGE_FIELDS = ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")
_CAP_NOTICE = ("You have reached the tool-call limit for this task. "
               "Give your final answer now using what you have.")
# OpenRouter's normalised reasoning effort accepts low | medium | high
_OPENROUTER_EFFORT = {"low": "low", "medium": "medium", "high": "high", "xhigh": "high", "max": "high"}


@dataclass
class AgentResult:
    agent_id: str
    name: str
    text: str
    turns: int
    stop_reason: Optional[str]
    model: str = ""
    usage: dict = field(default_factory=lambda: dict.fromkeys(_USAGE_FIELDS, 0))
    error: Optional[str] = None

    @property
    def ok(self) -> bool:
        return self.error is None


class OpenRouterError(Exception):
    pass


class OpenRouterClient:
    """Minimal async client for OpenRouter chat completions, with retries on 429/5xx."""

    def __init__(self, api_key: str, base_url: str = OPENROUTER_BASE_URL, max_retries: int = 3):
        self.api_key = api_key
        self.base_url = base_url
        self.max_retries = max_retries

    async def chat(self, body: dict) -> dict:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "HTTP-Referer": "http://localhost",
            "X-Title": OPENROUTER_APP_TITLE,
        }
        async with httpx.AsyncClient(timeout=httpx.Timeout(300, connect=15)) as client:
            for attempt in range(self.max_retries + 1):
                r = await client.post(f"{self.base_url}/chat/completions", json=body, headers=headers)
                if r.status_code == 429 or r.status_code >= 500:
                    if attempt < self.max_retries:
                        await asyncio.sleep(min(2 ** attempt * 2, 20))
                        continue
                if r.status_code >= 400:
                    raise OpenRouterError(f"OpenRouter error {r.status_code}: {r.text[:400]}")
                data = r.json()
                if "error" in data:   # some upstream failures arrive as 200 with an error object
                    raise OpenRouterError(f"OpenRouter error: {json.dumps(data['error'])[:400]}")
                return data
        raise OpenRouterError("OpenRouter: retries exhausted")


class Runner:
    """Runs agents for one pod run. Shares clients and one concurrency limit."""

    def __init__(self, run_id: str, emit: Emit, max_concurrent: int,
                 client: Optional[anthropic.AsyncAnthropic] = None,
                 openrouter: Optional[OpenRouterClient] = None,
                 model_override: Optional[str] = None):
        self.run_id = run_id
        self.emit = emit
        self.model_override = model_override
        self._client = client
        self._openrouter = openrouter
        self._sem = asyncio.Semaphore(max_concurrent)

    @property
    def client(self) -> anthropic.AsyncAnthropic:
        if self._client is None:
            self._client = anthropic.AsyncAnthropic(max_retries=4)
        return self._client

    @property
    def openrouter(self) -> OpenRouterClient:
        if self._openrouter is None:
            import os
            key = os.getenv("OPENROUTER_API_KEY")
            if not key:
                raise OpenRouterError("OPENROUTER_API_KEY is not set (add it to backend/.env).")
            self._openrouter = OpenRouterClient(key)
        return self._openrouter

    async def run(self, agent: AgentDef, task: str) -> AgentResult:
        spec = models.resolve(agent, self.model_override)
        result = AgentResult(agent.id, agent.name, text="", turns=0, stop_reason=None, model=spec.spec)
        self.emit("status", agent.name, f"{agent.name} started on {spec.label}")
        try:
            if spec.provider == "anthropic":
                await self._loop_anthropic(agent, spec.model, task, result)
            else:
                await self._loop_openrouter(agent, spec.model, task, result)
        except anthropic.APIStatusError as exc:
            result.error = f"Anthropic API error {exc.status_code}: {exc.message}"
        except anthropic.APIConnectionError as exc:
            result.error = f"Connection error: {exc}"
        except OpenRouterError as exc:
            result.error = str(exc)
        except httpx.HTTPError as exc:
            result.error = f"OpenRouter connection error: {exc}"
        except TypeError as exc:
            # the SDK raises TypeError when it finds no credentials at all
            if "api_key" not in str(exc) and "auth" not in str(exc).lower():
                raise
            result.error = "ANTHROPIC_API_KEY is not set (add it to backend/.env)."

        storage.insert_usage(self.run_id, agent.id, spec.spec, result.turns, result.usage)
        if result.error:
            self.emit("step", agent.name, f"Error: {result.error}")
        self.emit("task_done", agent.name, result.text or f"(no output: {result.error})")
        return result

    # ── Anthropic ────────────────────────────────────────────────────────────

    async def _loop_anthropic(self, agent: AgentDef, model: str, task: str, result: AgentResult) -> None:
        params: dict[str, Any] = dict(
            model=model,
            max_tokens=MAX_TOKENS,
            system=agent.system_prompt,
            tools=[t.api_spec() for t in agent.all_tools()],
            thinking={"type": "adaptive", "display": "summarized"},
            output_config={"effort": agent.effort},
            cache_control={"type": "ephemeral"},
        )
        if model in FALLBACK_MODELS:
            params.update(betas=[FALLBACK_BETA], fallbacks="default")

        messages: list[dict] = [{"role": "user", "content": task}]
        pauses = 0
        while True:
            last_turn = result.turns >= MAX_TURNS - 1
            extra = {"tool_choice": {"type": "none"}} if last_turn else {}
            async with self._sem:
                async with self.client.beta.messages.stream(messages=messages, **params, **extra) as stream:
                    msg = await stream.get_final_message()
            result.turns += 1
            result.stop_reason = msg.stop_reason
            for f in _USAGE_FIELDS:
                result.usage[f] += getattr(msg.usage, f, 0) or 0
            self._emit_blocks(agent, msg.content)
            messages.append({"role": "assistant", "content": msg.content})

            if msg.stop_reason == "pause_turn" and pauses < MAX_PAUSE_CONTINUATIONS:
                pauses += 1            # server tool hit its iteration limit; re-send to resume
                continue
            if msg.stop_reason == "tool_use" and not last_turn:
                calls = [b for b in msg.content if b.type == "tool_use"]
                outcomes = await asyncio.gather(*(
                    self._execute(agent, "anthropic", b.name, b.input if isinstance(b.input, dict) else {})
                    for b in calls))
                results: list[dict] = []
                for b, (content, is_error) in zip(calls, outcomes):
                    block = {"type": "tool_result", "tool_use_id": b.id, "content": content}
                    if is_error:
                        block["is_error"] = True
                    results.append(block)
                if result.turns >= MAX_TURNS - 1:
                    results.append({"type": "text", "text": _CAP_NOTICE})
                messages.append({"role": "user", "content": results})
                continue

            result.text = "\n\n".join(b.text for b in msg.content if b.type == "text").strip()
            if msg.stop_reason == "refusal":
                category = getattr(getattr(msg, "stop_details", None), "category", None)
                result.error = f"Request declined by safety classifier (category: {category})."
            elif msg.stop_reason == "max_tokens":
                result.text += "\n\n[Output truncated at the token limit.]"
            return

    def _emit_blocks(self, agent: AgentDef, content: list) -> None:
        for b in content:
            if b.type == "thinking" and getattr(b, "thinking", ""):
                self.emit("thinking", agent.name, b.thinking[:600])
            elif b.type in ("tool_use", "server_tool_use"):
                self.emit("tool_use", agent.name, f"Using tool: {b.name} {json.dumps(b.input)[:300]}")
            elif b.type == "fallback":
                self.emit("status", agent.name, "Request re-run on a fallback model")

    # ── OpenRouter ───────────────────────────────────────────────────────────

    async def _loop_openrouter(self, agent: AgentDef, model: str, task: str, result: AgentResult) -> None:
        tools = [{"type": "function", "function": {
            "name": t.name, "description": t.description, "parameters": t.input_schema}}
            for t in self._tools_for(agent, "openrouter")]
        messages: list[dict] = [
            {"role": "system", "content": agent.system_prompt},
            {"role": "user", "content": task},
        ]
        while True:
            last_turn = result.turns >= MAX_TURNS - 1
            body: dict[str, Any] = {
                "model": model,
                "messages": messages,
                "tools": tools,
                "max_tokens": OPENROUTER_MAX_TOKENS,
                "reasoning": {"effort": _OPENROUTER_EFFORT.get(agent.effort, "medium")},
            }
            if last_turn:
                body["tool_choice"] = "none"
            async with self._sem:
                data = await self.openrouter.chat(body)
            result.turns += 1
            choice = (data.get("choices") or [{}])[0]
            msg = choice.get("message") or {}
            result.stop_reason = choice.get("finish_reason")
            usage = data.get("usage") or {}
            result.usage["input_tokens"] += usage.get("prompt_tokens") or 0
            result.usage["output_tokens"] += usage.get("completion_tokens") or 0
            result.usage["cache_read_input_tokens"] += (usage.get("prompt_tokens_details") or {}).get("cached_tokens") or 0

            if msg.get("reasoning"):
                self.emit("thinking", agent.name, str(msg["reasoning"])[:600])
            tool_calls = msg.get("tool_calls") or []
            for tc in tool_calls:
                fn = tc.get("function") or {}
                self.emit("tool_use", agent.name, f"Using tool: {fn.get('name')} {str(fn.get('arguments'))[:300]}")

            assistant: dict[str, Any] = {"role": "assistant", "content": msg.get("content") or ""}
            if tool_calls:
                assistant["tool_calls"] = tool_calls
            messages.append(assistant)

            if tool_calls and not last_turn:
                async def run_call(tc: dict) -> tuple[str, bool]:
                    fn = tc.get("function") or {}
                    try:
                        args = json.loads(fn.get("arguments") or "{}")
                        if not isinstance(args, dict):
                            raise ValueError("arguments must be a JSON object")
                    except ValueError as exc:
                        return f"Invalid tool arguments: {exc}", True
                    return await self._execute(agent, "openrouter", fn.get("name", ""), args)

                outcomes = await asyncio.gather(*(run_call(tc) for tc in tool_calls))
                for tc, (content, _is_error) in zip(tool_calls, outcomes):
                    messages.append({"role": "tool", "tool_call_id": tc.get("id"), "content": content})
                if result.turns >= MAX_TURNS - 1:
                    messages.append({"role": "user", "content": _CAP_NOTICE})
                continue

            result.text = (msg.get("content") or "").strip()
            if result.stop_reason == "length":
                result.text += "\n\n[Output truncated at the token limit.]"
            return

    # ── shared ───────────────────────────────────────────────────────────────

    @staticmethod
    def _tools_for(agent: AgentDef, provider: str) -> list[Tool]:
        tools = agent.all_tools()
        if provider == "anthropic":
            return tools
        # server tools only exist on Anthropic; swap in local equivalents with the same names
        return [LOCAL_WEB_TOOLS.get(t.name, t) if t.server_spec else t for t in tools]

    async def _execute(self, agent: AgentDef, provider: str, name: str, args: dict) -> tuple[str, bool]:
        """Run one tool call. Returns (content, is_error); failures go back to the agent."""
        allowed = {t.name: t for t in self._tools_for(agent, provider)}
        ctx = ToolContext(run_id=self.run_id, agent_id=agent.id)
        try:
            tool = allowed.get(name)
            if tool is None:
                raise PermissionError(f"Tool {name!r} is not available to {agent.name}.")
            return await asyncio.to_thread(tool.call, args, ctx), False
        except Exception as exc:
            self.emit("step", agent.name, f"{name} failed: {type(exc).__name__}: {exc}")
            return f"{type(exc).__name__}: {exc}", True
