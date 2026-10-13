"""
Tool registry for the pod runner.

A tool is a plain Python handler plus the JSON schema Claude sees. Handlers
take keyword arguments matching the schema and return a string (or any
object, which is compacted to JSON). Raising an exception produces an
`is_error` tool result, so the agent sees the failure and can adapt.

Server tools (web search / web fetch) are declared here too, but they run
on Anthropic's side and have no handler.
"""
import inspect
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from pod.compact import compact


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    input_schema: dict
    handler: Optional[Callable[..., Any]] = None
    # Server tools are passed to the API as-is (e.g. {"type": "web_search_20260209", ...})
    server_spec: Optional[dict] = None
    # Write tools mutate shared pod state; roster validation checks who holds them
    writes: bool = False
    # strict=True makes the API guarantee inputs match the schema (all fields required)
    strict: bool = False
    max_chars: int = 6000

    def api_spec(self) -> dict:
        if self.server_spec is not None:
            return self.server_spec
        spec = {
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_schema,
        }
        if self.strict:
            spec["strict"] = True
        return spec

    def call(self, args: dict, context: "ToolContext") -> str:
        if self.handler is None:
            raise RuntimeError(f"{self.name} is a server tool and runs on Anthropic's side")
        result = self.handler(context=context, **args) if _wants_context(self.handler) else self.handler(**args)
        if isinstance(result, str):
            return result if len(result) <= self.max_chars else result[: self.max_chars] + "\n[...truncated]"
        return compact(result, self.max_chars)


@dataclass
class ToolContext:
    """Per-call information handlers may need (who is calling, in which run)."""
    run_id: str
    agent_id: str
    extra: dict = field(default_factory=dict)


def _wants_context(fn: Callable) -> bool:
    return "context" in inspect.signature(fn).parameters


REGISTRY: dict[str, Tool] = {}


def register(tool: Tool) -> Tool:
    if tool.name in REGISTRY:
        raise ValueError(f"Duplicate tool name: {tool.name}")
    REGISTRY[tool.name] = tool
    return tool


def schema(properties: dict | None = None, required: list[str] | None = None) -> dict:
    """Build an object input schema. Properties not listed in *required* are optional."""
    return {
        "type": "object",
        "properties": properties or {},
        "required": required or [],
        "additionalProperties": False,
    }


def load_all() -> dict[str, Tool]:
    """Import every tool module so they register themselves."""
    from pod.tools import analytics, sandbox, pod_state, server, book_tools  # noqa: F401
    return REGISTRY
