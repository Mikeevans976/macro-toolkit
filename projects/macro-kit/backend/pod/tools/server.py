"""
Anthropic server tools. These run on Anthropic's infrastructure; the runner
only declares them. The 20260209 variants include dynamic filtering, so the
standalone code_execution tool is deliberately not declared alongside them
(local analysis goes through `python_sandbox` instead).
"""
from pod.tools import Tool, register

register(Tool(
    name="web_search",
    description="Search the web (Anthropic server tool).",
    input_schema={},
    server_spec={"type": "web_search_20260209", "name": "web_search", "max_uses": 5},
))

register(Tool(
    name="web_fetch",
    description="Fetch a URL already present in the conversation (Anthropic server tool).",
    input_schema={},
    server_spec={"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": 5},
))
