"""
Model selection: parse "<provider>:<id>" specs, list what can be chosen, and
resolve which model an agent uses for a run.

Resolution order: run override > stored per-agent override > roster tier.

OpenRouter choices are limited to open-weight models that support tool
calling (OpenRouter lists a Hugging Face id for open-weight models). The
catalogue comes from OpenRouter's public /models endpoint, cached for an hour.
"""
import threading
import time
from dataclasses import dataclass
from typing import Optional

import httpx

from pod import storage
from pod.config import MODEL_LABELS, MODELS, OPENROUTER_BASE_URL
from pod.roster import AgentDef

PROVIDERS = ("anthropic", "openrouter")


@dataclass(frozen=True)
class ModelSpec:
    provider: str
    model: str

    @property
    def spec(self) -> str:
        return f"{self.provider}:{self.model}"

    @property
    def label(self) -> str:
        if self.provider == "anthropic":
            return MODEL_LABELS.get(self.model, self.model)
        return self.model.split("/", 1)[-1]


def parse(spec: str) -> ModelSpec:
    provider, sep, model = spec.partition(":")
    if not sep or provider not in PROVIDERS or not model.strip():
        raise ValueError(f"Model must look like 'anthropic:<id>' or 'openrouter:<org>/<model>', got {spec!r}")
    return ModelSpec(provider, model.strip())


# ── OpenRouter catalogue ─────────────────────────────────────────────────────

_CACHE: dict = {}
_LOCK = threading.Lock()
_TTL = 3600


def _fetch_openrouter() -> list[dict]:
    r = httpx.get(f"{OPENROUTER_BASE_URL}/models", timeout=20)
    r.raise_for_status()
    out = []
    for m in r.json().get("data", []):
        params = m.get("supported_parameters") or []
        if "tools" not in params or not m.get("hugging_face_id") or m["id"].endswith(":batch"):
            continue
        pricing = m.get("pricing") or {}
        out.append({
            "spec": f"openrouter:{m['id']}",
            "id": m["id"],
            "name": m.get("name", m["id"]),
            "context_length": m.get("context_length"),
            "input_per_mtok": round(float(pricing.get("prompt") or 0) * 1e6, 4),
            "output_per_mtok": round(float(pricing.get("completion") or 0) * 1e6, 4),
            "reasoning": "reasoning" in params,
            "created": m.get("created", 0),
        })
    return sorted(out, key=lambda m: m["created"], reverse=True)


def openrouter_models(refresh: bool = False) -> list[dict]:
    with _LOCK:
        if refresh or not _CACHE or time.time() - _CACHE["at"] > _TTL:
            _CACHE.update(at=time.time(), models=_fetch_openrouter())
        return _CACHE["models"]


def anthropic_models() -> list[dict]:
    return [{"spec": f"anthropic:{mid}", "id": mid, "name": f"Claude {MODEL_LABELS[mid]}", "tier": tier}
            for tier, mid in MODELS.items()]


def validate(spec: str) -> ModelSpec:
    """Parse and check the model is one we offer. Raises ValueError."""
    ms = parse(spec)
    if ms.provider == "anthropic":
        if ms.model not in MODELS.values():
            raise ValueError(f"Unknown Claude model {ms.model!r}")
    else:
        try:
            known = {m["id"] for m in openrouter_models()}
        except httpx.HTTPError:
            return ms   # catalogue unreachable: accept and let the API reject it if wrong
        if ms.model not in known:
            raise ValueError(f"{ms.model!r} is not an open-weight, tool-capable OpenRouter model")
    return ms


def resolve(agent: AgentDef, run_override: Optional[str] = None) -> ModelSpec:
    if run_override:
        return parse(run_override)
    stored = storage.get_model_override(agent.id)
    if stored:
        return parse(stored)
    return ModelSpec("anthropic", agent.model)
