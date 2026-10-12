"""
Tests for the pod runner (backend/pod/).

No network: the Anthropic client is replaced by a scripted fake, and the
SQLite DB is redirected to a temp file. Run with:
    cd backend && pytest tests/test_pod.py -v
"""
import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace as NS

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import agents.storage as runs_storage  # noqa: E402
from pod import storage  # noqa: E402
from pod.compact import compact  # noqa: E402
from pod.config import MAX_TURNS  # noqa: E402
from pod.roster import AGENTS, BASELINE_TOOLS, ENABLED, roster_entry, team_of  # noqa: E402
from pod.runner import Runner  # noqa: E402
from pod.tools import REGISTRY  # noqa: E402
from pod import workflows  # noqa: E402


# ── fakes ───────────────────────────────────────────────────────────────────

def text(t):
    return NS(type="text", text=t)


def tool_use(name, args, id_="tu_1"):
    return NS(type="tool_use", id=id_, name=name, input=args)


def message(content, stop_reason):
    return NS(content=content, stop_reason=stop_reason,
              usage=NS(input_tokens=100, output_tokens=20,
                       cache_read_input_tokens=50, cache_creation_input_tokens=0))


class FakeClient:
    """Mimics client.beta.messages.stream(...) -> async ctx -> get_final_message()."""

    def __init__(self, script):
        # script: list of messages, or a callable(params) -> message
        self.script = script
        self.calls = []
        self.beta = NS(messages=NS(stream=self._stream))

    def _stream(self, **params):
        # snapshot: the runner keeps appending to the same messages list
        self.calls.append({**params, "messages": list(params["messages"])})
        if callable(self.script):
            msg = self.script(params)
        else:
            msg = self.script[len(self.calls) - 1]

        class Ctx:
            async def __aenter__(self):
                return NS(get_final_message=self._final)

            async def __aexit__(self, *a):
                return False

            async def _final(self):
                return msg
        return Ctx()


@pytest.fixture(autouse=True)
def temp_db(tmp_path, monkeypatch):
    monkeypatch.setattr(runs_storage, "_DB_PATH", tmp_path / "test.db")
    storage.init_db()


def make_runner(client, events=None):
    events = events if events is not None else []
    return Runner("run-1", lambda t, a, c: events.append((t, a, c)), max_concurrent=4, client=client)


VIEW = {
    "market": "EUR 2s10s", "direction": "steepener", "conviction": 3, "horizon": "3m",
    "instrument": "EUR 2s10s swap steepener, DV01-neutral", "catalysts": ["ECB 30 Oct"],
    "invalidation": "2s10s below 20bp", "rationale": "Front end prices too many cuts.",
    "evidence": [{"tool": "swaps_rv", "as_of": "2026-10-08", "data_source": "simulation"}],
}


# ── compact ─────────────────────────────────────────────────────────────────

def test_compact_summarises_long_series():
    out = json.loads(compact({"dates": [f"d{i}" for i in range(500)], "y": list(range(500))}))
    assert out["y"]["n"] == 500 and out["y"]["last"] == 499 and len(out["y"]["tail"]) == 5
    assert out["dates"]["first"] == "d0"


def test_compact_respects_budget():
    big = {"rows": [{"a": i, "b": "x" * 50} for i in range(1000)]}
    assert len(compact(big, max_chars=2000)) <= 2100


def test_compact_handles_nan_and_matrices():
    out = json.loads(compact({"v": float("nan"), "m": [[1, 2], [3, 4]]}))
    assert out["v"] is None and "matrix 2x2" in out["m"]


# ── roster ──────────────────────────────────────────────────────────────────

def test_roster_tools_and_baseline_exist():
    for a in ENABLED.values():
        names = [t.name for t in a.all_tools()]
        assert set(BASELINE_TOOLS) <= set(names)
        assert len(names) == len(set(names))


def test_disabled_agents_name_their_blockers():
    for a in AGENTS.values():
        if not a.enabled:
            assert a.blocked_on, a.id
            assert a.system_prompt == ""


def test_hierarchy():
    assert ENABLED["deputy-pm"].reports_to == "pm"
    assert {a.id for a in team_of("head-of-rates")} == {
        "stir-strategist", "curve-strategist", "swaps-rv-analyst",
        "sovereign-spreads-analyst", "inflation-strategist"}
    assert "supply-funding-analyst" not in {a.id for a in team_of("head-of-rates")}  # disabled


def test_system_prompt_includes_skills_and_reporting_line():
    p = ENABLED["swaps-rv-analyst"].system_prompt
    assert "You report to Head of Rates" in p
    assert '<skill name="rv-screening-methodology">' in p and '<skill name="pod-view-format">' in p
    assert "---\nname:" not in p   # frontmatter stripped


def test_roster_entry_shape():
    e = roster_entry(ENABLED["head-of-rates"])
    assert {"id", "name", "role", "tools", "model", "is_manager"} <= set(e)


def test_submit_view_is_strict():
    spec = REGISTRY["submit_view"].api_spec()
    assert spec["strict"] is True
    item = spec["input_schema"]["properties"]["views"]["items"]
    assert set(item["required"]) == set(item["properties"])


# ── runner ──────────────────────────────────────────────────────────────────

def test_runner_executes_tools_and_records_views():
    client = FakeClient([
        message([tool_use("submit_view", {"views": [VIEW]}, "a"),
                 tool_use("swaps_rv_not_mine", {}, "b")], "tool_use"),
        message([text("Steepener, conviction 3.")], "end_turn"),
    ])
    events = []
    r = asyncio.run(make_runner(client, events).run(ENABLED["swaps-rv-analyst"], "task"))

    assert r.ok and r.text == "Steepener, conviction 3." and r.turns == 2
    # all tool results go back in ONE user message, matched by id
    results = client.calls[1]["messages"][-1]["content"]
    assert [x["tool_use_id"] for x in results] == ["a", "b"]
    assert results[1]["is_error"] is True and "not available" in results[1]["content"]
    assert storage.get_views(run_id="run-1")[0]["market"] == "EUR 2s10s"
    assert storage.get_usage("run-1")[0]["cache_read_tokens"] == 100
    assert ("task_done", "Swaps & Spreads RV Analyst", "Steepener, conviction 3.") in events


def test_runner_request_shape():
    client = FakeClient([message([text("ok")], "end_turn")])
    asyncio.run(make_runner(client).run(ENABLED["head-of-rates"], "task"))
    p = client.calls[0]
    assert p["model"] == "claude-opus-5-5"
    assert p["thinking"] == {"type": "adaptive", "display": "summarized"}
    assert p["output_config"] == {"effort": "high"}
    assert p["cache_control"] == {"type": "ephemeral"}
    assert p["fallbacks"] == "default"
    assert {"type": "web_search_20260209", "name": "web_search", "max_uses": 5} in p["tools"]
    assert "tool_choice" not in p


def test_runner_resumes_pause_turn_without_extra_user_message():
    client = FakeClient([
        message([NS(type="server_tool_use", id="s1", name="web_search", input={"query": "ECB"})], "pause_turn"),
        message([text("done")], "end_turn"),
    ])
    r = asyncio.run(make_runner(client).run(ENABLED["stir-strategist"], "task"))
    assert r.text == "done"
    assert client.calls[1]["messages"][-1]["role"] == "assistant"


def test_runner_turn_cap_forces_final_answer():
    def script(params):
        if params.get("tool_choice") == {"type": "none"}:
            return message([text("final")], "end_turn")
        return message([tool_use("sandbox_list", {})], "tool_use")
    client = FakeClient(script)
    r = asyncio.run(make_runner(client).run(ENABLED["swaps-rv-analyst"], "task"))
    assert r.text == "final" and r.turns == MAX_TURNS
    assert "tool-call limit" in client.calls[-1]["messages"][-1]["content"][-1]["text"]


def test_runner_reports_tool_exceptions_to_agent():
    client = FakeClient([
        message([tool_use("sandbox_read", {"path": "../../etc/passwd"})], "tool_use"),
        message([text("could not read")], "end_turn"),
    ])
    asyncio.run(make_runner(client).run(ENABLED["swaps-rv-analyst"], "task"))
    result = client.calls[1]["messages"][-1]["content"][0]
    assert result["is_error"] is True and "outside the sandbox" in result["content"]


def test_runner_handles_refusal():
    client = FakeClient([NS(**vars(message([], "refusal")), stop_details=NS(category="cyber"))])
    r = asyncio.run(make_runner(client).run(ENABLED["swaps-rv-analyst"], "task"))
    assert not r.ok and "cyber" in r.error


# ── workflows ───────────────────────────────────────────────────────────────

def _echo_script(params):
    """Each agent answers with its own name, so we can see who saw whose report."""
    first_line = params["system"].split(" in a global macro", 1)[0]
    return message([text(f"report by {first_line.removeprefix('You are the ')}")], "end_turn")


def test_desk_briefing_gives_head_every_report():
    client = FakeClient(_echo_script)
    r = asyncio.run(workflows.desk_briefing(make_runner(client), "head-of-rates", "Where is value?"))
    head_task = client.calls[-1]["messages"][0]["content"]
    for a in team_of("head-of-rates"):
        assert f'<report from="{a.name}">' in head_task
    assert r.text == "report by Head of Rates"
    assert len(client.calls) == len(team_of("head-of-rates")) + 1


def test_morning_briefing_order():
    client = FakeClient(_echo_script)
    r = asyncio.run(workflows.morning_briefing(make_runner(client), "Morning view?"))
    assert r.name == "Deputy PM"
    red_team_task = client.calls[-2]["messages"][0]["content"]
    deputy_task = client.calls[-1]["messages"][0]["content"]
    assert '<report from="Head of Rates">' in red_team_task
    assert '<report from="Red Team">' in deputy_task
    assert '<report from="Swaps & Spreads RV Analyst">' not in deputy_task   # heads summarise their teams


# ── model selection / OpenRouter ────────────────────────────────────────────

from pod import models  # noqa: E402


class FakeOpenRouter:
    def __init__(self, replies):
        self.replies, self.bodies = replies, []

    async def chat(self, body):
        self.bodies.append({**body, "messages": list(body["messages"])})
        return self.replies[len(self.bodies) - 1]


def or_reply(content=None, tool_calls=None, finish="stop"):
    msg = {"role": "assistant", "content": content}
    if tool_calls:
        msg["tool_calls"] = tool_calls
    return {"choices": [{"message": msg, "finish_reason": finish}],
            "usage": {"prompt_tokens": 200, "completion_tokens": 30, "prompt_tokens_details": {"cached_tokens": 40}}}


def or_call(name, args, id_="c1"):
    return {"id": id_, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}


def test_model_resolution_order():
    agent = ENABLED["swaps-rv-analyst"]
    assert models.resolve(agent).spec == "anthropic:claude-sonnet-5-5"
    storage.set_model_override(agent.id, "openrouter:qwen/qwen3.7-plus")
    assert models.resolve(agent).spec == "openrouter:qwen/qwen3.7-plus"
    assert models.resolve(agent, "anthropic:claude-opus-5-5").spec == "anthropic:claude-opus-5-5"
    storage.set_model_override(agent.id, None)
    assert models.resolve(agent).provider == "anthropic"


def test_parse_rejects_bad_specs():
    for bad in ["qwen/qwen3", "openai:gpt", "openrouter:"]:
        with pytest.raises(ValueError):
            models.parse(bad)
    with pytest.raises(ValueError):
        models.validate("anthropic:claude-unknown")


def test_openrouter_loop_runs_tools_and_swaps_web_tools():
    fake = FakeOpenRouter([
        or_reply(tool_calls=[or_call("submit_view", {"views": [VIEW]}, "a"),
                             or_call("not_mine", {}, "b")], finish="tool_calls"),
        or_reply(content="Steepener on Qwen."),
    ])
    runner = Runner("run-1", lambda *a: None, 4, client=None, openrouter=fake,
                    model_override="openrouter:qwen/qwen3.7-plus")
    r = asyncio.run(runner.run(ENABLED["swaps-rv-analyst"], "task"))
    assert r.ok and r.text == "Steepener on Qwen." and r.model == "openrouter:qwen/qwen3.7-plus"

    first = fake.bodies[0]
    assert first["model"] == "qwen/qwen3.7-plus" and first["messages"][0]["role"] == "system"
    names = {t["function"]["name"] for t in first["tools"]}
    assert {"web_search", "web_fetch", "submit_view", "swaps_rv"} <= names
    web = next(t for t in first["tools"] if t["function"]["name"] == "web_search")
    assert "query" in web["function"]["parameters"]["properties"]      # local tool, not the server spec

    tool_msgs = [m for m in fake.bodies[1]["messages"] if m["role"] == "tool"]
    assert [m["tool_call_id"] for m in tool_msgs] == ["a", "b"]
    assert "not available" in tool_msgs[1]["content"]
    assert storage.get_views(run_id="run-1")[0]["agent_id"] == "swaps-rv-analyst"
    u = storage.get_usage("run-1")[0]
    assert u["model"] == "openrouter:qwen/qwen3.7-plus" and u["input_tokens"] == 400


def test_openrouter_bad_arguments_go_back_to_agent():
    bad = {"id": "x", "type": "function", "function": {"name": "sandbox_list", "arguments": "{not json"}}
    fake = FakeOpenRouter([or_reply(tool_calls=[bad], finish="tool_calls"), or_reply(content="ok")])
    runner = Runner("run-1", lambda *a: None, 4, openrouter=fake, model_override="openrouter:qwen/qwen3.7-plus")
    asyncio.run(runner.run(ENABLED["swaps-rv-analyst"], "task"))
    tool_msg = [m for m in fake.bodies[1]["messages"] if m["role"] == "tool"][0]
    assert tool_msg["content"].startswith("Invalid tool arguments")


def test_openrouter_error_becomes_agent_error():
    from pod.runner import OpenRouterError

    class Failing:
        async def chat(self, body):
            raise OpenRouterError("OpenRouter error 402: insufficient credits")
    runner = Runner("run-1", lambda *a: None, 4, openrouter=Failing(), model_override="openrouter:x/y")
    r = asyncio.run(runner.run(ENABLED["swaps-rv-analyst"], "task"))
    assert not r.ok and "402" in r.error


def test_run_override_applies_to_whole_workflow():
    fake = FakeOpenRouter([or_reply(content=f"r{i}") for i in range(10)])
    runner = Runner("run-1", lambda *a: None, 4, openrouter=fake, model_override="openrouter:qwen/qwen3.7-plus")
    asyncio.run(workflows.desk_briefing(runner, "head-of-rates", "q"))
    assert len(fake.bodies) == len(team_of("head-of-rates")) + 1
    assert {b["model"] for b in fake.bodies} == {"qwen/qwen3.7-plus"}
