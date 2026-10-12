"""
Shrink analytics payloads to an LLM-sized summary.

Most analytics functions return full time series (thousands of points) and
large tables. Agents need the latest state plus enough history to judge a
level, so long numeric series collapse to {n, last, min, max, mean, tail},
long tables keep their leading rows, and matrices collapse to their shape.
If the result is still over budget, the limits tighten and it is re-rendered.
"""
import dataclasses
import json
import math
from typing import Any


def _to_plain(obj: Any) -> Any:
    if hasattr(obj, "model_dump"):
        return obj.model_dump()
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return dataclasses.asdict(obj)
    if hasattr(obj, "tolist"):          # numpy arrays / scalars
        return obj.tolist()
    if hasattr(obj, "isoformat"):       # dates, timestamps
        return obj.isoformat()
    return obj


def _num(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def _round(x: float) -> Any:
    if isinstance(x, float):
        if math.isnan(x) or math.isinf(x):
            return None
        return round(x, 4)
    return x


def _series_summary(values: list, tail: int) -> dict:
    clean = [v for v in values if _num(v) and not (isinstance(v, float) and math.isnan(v))]
    out: dict = {"n": len(values)}
    if clean:
        out.update(
            last=_round(clean[-1]),
            min=_round(min(clean)),
            max=_round(max(clean)),
            mean=_round(sum(clean) / len(clean)),
        )
    out["tail"] = [_round(v) if _num(v) else v for v in values[-tail:]]
    return out


def _walk(obj: Any, rows: int, tail: int, depth: int) -> Any:
    obj = _to_plain(obj)
    if isinstance(obj, dict):
        if depth > 6:
            return f"<dict with {len(obj)} keys>"
        return {str(k): _walk(v, rows, tail, depth + 1) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        obj = [_to_plain(v) for v in obj]
        if not obj:
            return []
        if all(_num(v) or v is None for v in obj):
            if len(obj) <= tail * 2:
                return [_round(v) if _num(v) else v for v in obj]
            return _series_summary(obj, tail)
        if all(isinstance(v, str) for v in obj):
            if len(obj) <= rows * 2:
                return obj
            # e.g. a date axis: keep first and last points
            return {"n": len(obj), "first": obj[0], "tail": obj[-tail:]}
        if all(isinstance(v, (list, tuple)) for v in obj):
            width = len(obj[0]) if obj else 0
            return f"<matrix {len(obj)}x{width} omitted>"
        kept = [_walk(v, rows, tail, depth + 1) for v in obj[:rows]]
        if len(obj) > rows:
            kept.append(f"... {len(obj) - rows} more rows omitted")
        return kept
    if isinstance(obj, float):
        return _round(obj)
    return obj


def compact(obj: Any, max_chars: int = 6000) -> str:
    """Return a JSON string summary of *obj* no longer than about *max_chars*."""
    rows, tail = 15, 5
    text = ""
    for _ in range(6):
        text = json.dumps(_walk(obj, rows, tail, 0), default=str, separators=(",", ":"))
        if len(text) <= max_chars:
            return text
        rows, tail = max(3, rows // 2), max(2, tail - 1)
    return text[:max_chars] + f'..."[truncated: {len(text) - max_chars} chars]"'
