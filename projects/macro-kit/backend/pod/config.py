"""
Pod-wide settings.

Secrets come from the environment. For local use, put them in backend/.env or
projects/macro-kit/.env (gitignored), loaded by settings.py without overriding
variables already set:

    ANTHROPIC_API_KEY=...
    OPENROUTER_API_KEY=...

Model specs are "<provider>:<model id>", e.g. "anthropic:claude-sonnet-5-5" or
"openrouter:qwen/qwen3.7-plus". Roster tiers map to Anthropic models; an agent
can be overridden per agent (stored) or per run.
"""
import os

import settings  # noqa: F401  (loads the .env files before the getenv calls below)

MODELS = {
    "opus": os.getenv("POD_MODEL_OPUS", "claude-opus-5-5"),
    "sonnet": os.getenv("POD_MODEL_SONNET", "claude-sonnet-5-5"),
    "haiku": os.getenv("POD_MODEL_HAIKU", "claude-haiku-5-5"),
}
MODEL_LABELS = {MODELS["opus"]: "Opus 5.5", MODELS["sonnet"]: "Sonnet 5.5", MODELS["haiku"]: "Haiku 5.5"}

# Models that accept the server-side refusal fallback (`fallbacks: "default"`)
FALLBACK_MODELS = {"claude-opus-5-5", "claude-sonnet-5-5"}
FALLBACK_BETA = "server-side-fallback-2026-07-01"

OPENROUTER_BASE_URL = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
OPENROUTER_APP_TITLE = "Analytics Hub Macro Pod"

MAX_TOKENS = 64000          # Anthropic requests stream, so no HTTP timeout concern
OPENROUTER_MAX_TOKENS = 16000
MAX_TURNS = 16              # model round-trips per agent per task
MAX_PAUSE_CONTINUATIONS = 5 # server-tool pause_turn resumes per agent per task
MAX_CONCURRENT_AGENTS = int(os.getenv("POD_MAX_CONCURRENT_AGENTS", "6"))


def anthropic_configured() -> bool:
    return bool(os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_AUTH_TOKEN"))


def openrouter_configured() -> bool:
    return bool(os.getenv("OPENROUTER_API_KEY"))
