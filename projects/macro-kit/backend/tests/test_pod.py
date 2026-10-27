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
    assert len(AGENTS) == 45 and len(ENABLED) == 45
    assert ENABLED["deputy-pm"].reports_to == "pm"
    assert ENABLED["cro"].reports_to == "pm"            # independent risk line
    assert ENABLED["red-team"].reports_to == "deputy-pm"
    assert ENABLED["macro-themes-strategist"].reports_to == "deputy-pm"
    assert {a.id for a in team_of("head-of-rates")} == {
        "stir-strategist", "curve-strategist", "swaps-rv-analyst", "sovereign-spreads-analyst",
        "inflation-strategist", "supply-funding-analyst", "rates-vol-strategist"}
    assert len(team_of("head-of-macro-research")) == 8
    assert len(team_of("head-of-fx-cross-asset")) == 5
    assert {a.id for a in team_of("head-of-quant")} == {
        "positioning-flows-analyst", "technicals-analyst", "regime-correlation-analyst",
        "model-backtest-analyst", "strategy-backtest-analyst"}
    assert {a.id for a in team_of("cro")} == {"market-risk-analyst", "sizing-analyst"}
    assert len(team_of("pod-coordinator")) == 5


def test_routing_map_ids_exist():
    from pod.roster import _read_skill
    rows = [l for l in _read_skill("routing-map").splitlines() if l.startswith("|") and "---" not in l][1:]
    ids = {i.strip() for row in rows for i in row.strip("|").split("|")[-1].split(",")}
    unknown = {i for i in ids if i not in AGENTS}
    assert not unknown, unknown


def test_missing_tools_reach_the_prompt():
    p = ENABLED["g10-fx-strategist"].system_prompt
    assert "Data limits:" in p and "fx_valuation" in p
    assert "Agents you can consult" in ENABLED["pod-coordinator"].system_prompt
    assert "Agents you can consult" not in ENABLED["swaps-rv-analyst"].system_prompt


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


def _calls_for(client, name):
    return [c for c in client.calls if c["system"].startswith(f"You are the {name} in")]


def test_morning_briefing_order():
    client = FakeClient(_echo_script)
    r = asyncio.run(workflows.morning_briefing(make_runner(client), "Morning view?"))
    assert r.name == "Deputy PM"
    order = [c["system"].split(" in a global macro", 1)[0].removeprefix("You are the ") for c in client.calls]
    assert order[:2] == ["News & Narrative Scanner", "Calendar & Data-Release Analyst"]
    assert order[-4:] == ["Chief Risk Officer", "Deputy PM", "Publisher"][-3:] or order[-3:] == ["Chief Risk Officer", "Deputy PM", "Publisher"]
    assert order.index("Red Team") > max(order.index(h) for h in
                                         ["Head of Rates", "Head of Macro Research", "Head of FX & Cross-Asset", "Head of Quant & Positioning"])
    red_team_task = _calls_for(client, "Red Team")[0]["messages"][0]["content"]
    deputy_task = _calls_for(client, "Deputy PM")[0]["messages"][0]["content"]
    assert '<report from="Head of Rates">' in red_team_task
    assert '<report from="Red Team">' in deputy_task and '<report from="Chief Risk Officer">' in deputy_task
    assert '<report from="Swaps & Spreads RV Analyst">' not in deputy_task   # heads summarise their teams
    # shared services context reaches the desks
    assert "News & Narrative Scanner" in _calls_for(client, "US Economist")[0]["messages"][0]["content"]


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


# ── ledger, risk, consult, trade review ─────────────────────────────────────

from pod import book, risk  # noqa: E402

IDEA = dict(title="Pay EUR 2y", thesis="ECB done cutting.", instrument="EUR 2y swap, pay fixed",
            direction="short duration", risk_factor="EUR 2y swap rate", bucket="2y", conviction=3,
            horizon="3m", invalidation="2y below 1.80%", stop="1.80%")


def test_ledger_enforces_order_and_roles():
    tid = book.propose("run-1", "swaps-rv-analyst", IDEA)
    with pytest.raises(book.LedgerError, match="may not"):
        book.advance(tid, "sponsor", "swaps-rv-analyst")
    with pytest.raises(book.LedgerError, match="is proposed"):
        book.advance(tid, "size", "sizing-analyst", pnl_per_bp_k=10, max_loss_k=200)
    book.advance(tid, "sponsor", "head-of-rates")
    with pytest.raises(book.LedgerError, match="kill_criteria"):
        book.advance(tid, "challenge", "red-team", verdict="proceed")
    book.advance(tid, "challenge", "red-team", verdict="proceed-smaller", kill_criteria="2y < 1.80%")
    book.advance(tid, "size", "sizing-analyst", pnl_per_bp_k=12.5, max_loss_k=250)
    book.advance(tid, "risk_approve", "cro")
    with pytest.raises(book.LedgerError, match="may not"):
        book.advance(tid, "pm_approve", "deputy-pm")       # only the human PM
    t = book.advance(tid, "pm_approve", "pm")
    assert t["status"] == "pm_approved"
    assert [e["action"] for e in t["events"]] == ["propose", "sponsor", "challenge", "size", "risk_approve", "pm_approve"]


def test_red_team_reject_kills_trade():
    tid = book.propose("run-1", "head-of-rates", IDEA)
    book.advance(tid, "sponsor", "head-of-rates")
    assert book.advance(tid, "challenge", "red-team", verdict="reject", kill_criteria="n/a")["status"] == "rejected"


def test_risk_engine_scenarios_and_breaches():
    tid = book.propose("run-1", "head-of-rates", IDEA)
    for action, actor, kw in [("sponsor", "head-of-rates", {}),
                              ("challenge", "red-team", {"verdict": "proceed", "kill_criteria": "x"}),
                              ("size", "sizing-analyst", {"pnl_per_bp_k": 80, "max_loss_k": 900})]:
        book.advance(tid, action, actor, **kw)
    r = risk.book_risk(extra_trade_ids=[tid])
    assert r["pnl_per_bp_k_by_bucket"]["2y"] == 80
    assert r["scenario_pnl_k"]["parallel_up_100"] == 8000
    assert r["worst_scenario"]["name"] in ("parallel_down_100", "bull_steepener", "front_end_repricing_dovish",
                                          "parallel_down_50")
    assert any("2y" in b for b in r["limit_breaches"]) and any("max loss" in b for b in r["limit_breaches"])
    assert r["limits_are_placeholders"] is True


def test_sizing_math():
    assert risk.size_from_stop(300, 20, -1) == {"pnl_per_bp_k": -15.0, "max_loss_k": 300.0,
                                                "method": "loss at stop = |P&L per bp| x stop distance"}
    assert risk.size_from_vol(50, 5, 1)["pnl_per_bp_k"] == 10.0


def test_consult_agent_runs_target_once_and_blocks_nesting():
    def script(params):
        name = params["system"].split(" in a global macro", 1)[0].removeprefix("You are the ")
        msgs = params["messages"]
        if name == "Pod Coordinator" and len(msgs) == 1:
            return message([tool_use("consult_agent", {"agent_id": "stir-strategist", "question": "ECB pricing?"})], "tool_use")
        if name == "Front-End / STIR Strategist" and len(msgs) == 1:
            # tries to consult further: must be refused (it doesn't hold the tool anyway)
            return message([tool_use("consult_agent", {"agent_id": "us-economist", "question": "x"})], "tool_use")
        return message([text(f"{name} answer")], "end_turn")
    client = FakeClient(script)
    r = asyncio.run(workflows.ask_pod(make_runner(client), "What is priced for the ECB?"))
    assert r.text == "Pod Coordinator answer"
    coord_result = _calls_for(client, "Pod Coordinator")[1]["messages"][-1]["content"][0]
    assert coord_result["content"] == "Front-End / STIR Strategist answer"
    stir_second = _calls_for(client, "Front-End / STIR Strategist")[1]["messages"][-1]["content"][0]
    assert stir_second["is_error"] is True


def test_consult_depth_blocks_heads_consulting_from_inside_a_consult():
    def script(params):
        name = params["system"].split(" in a global macro", 1)[0].removeprefix("You are the ")
        if len(params["messages"]) == 1 and name in ("Deputy PM", "Head of Rates"):
            target = "head-of-rates" if name == "Deputy PM" else "stir-strategist"
            return message([tool_use("consult_agent", {"agent_id": target, "question": "q"})], "tool_use")
        return message([text(f"{name} answer")], "end_turn")
    client = FakeClient(script)
    asyncio.run(make_runner(client).run(ENABLED["deputy-pm"], "task"))
    head_followup = _calls_for(client, "Head of Rates")[1]["messages"][-1]["content"][0]
    assert head_followup["is_error"] is True and "cannot consult further" in head_followup["content"]
    assert not _calls_for(client, "Front-End / STIR Strategist")


def test_trade_review_walks_the_gates():
    def script(params):
        name = params["system"].split(" in a global macro", 1)[0].removeprefix("You are the ")
        first = len(params["messages"]) == 1
        task = params["messages"][0]["content"]
        tid = None
        import re as _re
        m = _re.search(r"trade #(\d+)", task)
        if m:
            tid = int(m.group(1))
        if name == "Pod Coordinator":
            return message([text("head-of-rates")], "end_turn")
        if name == "Head of Rates" and first:
            return message([tool_use("propose_trade", IDEA, "p")], "tool_use")
        if name == "Head of Rates" and len(params["messages"]) == 3:
            t = book.list_trades(run_id="run-1")[0]
            return message([tool_use("advance_trade", {"trade_id": t["id"], "action": "sponsor", "note": "backing it"}, "s")], "tool_use")
        if name == "Red Team" and first:
            return message([tool_use("advance_trade", {"trade_id": tid, "action": "challenge", "note": "crowded",
                                                       "verdict": "proceed-smaller", "kill_criteria": "2y < 1.8%"})], "tool_use")
        if name == "Portfolio Construction & Sizing Analyst" and first:
            return message([tool_use("advance_trade", {"trade_id": tid, "action": "size", "note": "half size",
                                                       "pnl_per_bp_k": 10, "max_loss_k": 200})], "tool_use")
        if name == "Chief Risk Officer" and first:
            return message([tool_use("advance_trade", {"trade_id": tid, "action": "risk_approve", "note": "within limits"})], "tool_use")
        return message([text(f"{name} done")], "end_turn")
    client = FakeClient(script)
    r = asyncio.run(workflows.trade_review(make_runner(client), "Pay EUR 2y"))
    t = book.list_trades(run_id="run-1")[0]
    assert t["status"] == "risk_approved" and t["red_team_verdict"] == "proceed-smaller" and t["pnl_per_bp_k"] == 10
    assert r.name == "Deputy PM" and "awaits the PM" in _calls_for(client, "Deputy PM")[0]["messages"][0]["content"]


def test_workflow_info_ids_resolve():
    for w in workflows.workflow_info():
        assert w["id"] in workflows.WORKFLOWS
        assert w["use_when"]
        for stage in w["stages"]:
            for aid in stage:
                assert aid in AGENTS or aid.startswith("("), (w["id"], aid)


def test_trade_themes_tool_matches_the_launchpad():
    out = REGISTRY["trade_themes"].handler()
    assert out["totals"]["themes"] == len(out["themes"]) > 0
    for t in out["themes"]:
        assert abs(sum(s["prob"] for s in t["scenarios"]) - 1) < 1e-6


def test_nowcast_backtest_tool_lists_models_and_rejects_unknown():
    import quant_macro
    out = REGISTRY["nowcast_backtest"].handler()
    assert {m["slug"] for m in out["models"]} == set(quant_macro.MODELS)
    with pytest.raises(ValueError):
        REGISTRY["nowcast_backtest"].handler(model="nope")


def test_theme_review_runs_the_themes_strategist():
    client = FakeClient([message([text("Themes reviewed")], "end_turn")])
    r = asyncio.run(workflows.theme_review(make_runner(client), "Review the themes"))
    assert r.name == "Macro Themes Strategist"
