"""Trade themes for the launchpad Summary: scenarios, probabilities and the trades under each theme."""

import json
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException

from auth import get_current_user

router = APIRouter(dependencies=[Depends(get_current_user)])

# Edited by hand from the quarterly review; read on every request, like dashboard_config.yaml.
THEMES_PATH = Path(__file__).resolve().parent.parent / "data" / "trade_themes.json"


def build_themes(raw: dict) -> dict:
    """Add expected P&L (probability-weighted scenario P&L) and totals per trade, theme and book."""
    themes = []
    for theme in raw["themes"]:
        probs = [s["prob"] for s in theme["scenarios"]]
        if abs(sum(probs) - 1) > 1e-6:
            raise ValueError(f"Theme {theme['id']}: scenario probabilities sum to {sum(probs):.3f}")
        trades = []
        for t in theme["trades"]:
            if len(t["scenario_pnl_k"]) != len(probs):
                raise ValueError(f"{t['id']}: {len(t['scenario_pnl_k'])} scenario P&Ls for {len(probs)} scenarios")
            trades.append({**t, "expected_pnl_k": sum(p * x for p, x in zip(probs, t["scenario_pnl_k"]))})
        scenario_pnl = [sum(t["scenario_pnl_k"][i] for t in trades) for i in range(len(probs))]
        themes.append({
            **theme,
            "trades": trades,
            "scenarios": [{**s, "pnl_k": pnl} for s, pnl in zip(theme["scenarios"], scenario_pnl)],
            "max_loss_k": sum(t["max_loss_k"] for t in trades),
            "expected_pnl_k": sum(t["expected_pnl_k"] for t in trades),
        })
    return {
        **raw,
        "themes": themes,
        "totals": {
            "themes": len(themes),
            "trades": sum(len(t["trades"]) for t in themes),
            "max_loss_k": sum(t["max_loss_k"] for t in themes),
            "expected_pnl_k": sum(t["expected_pnl_k"] for t in themes),
        },
    }


@router.get("/api/themes")
def get_themes():
    try:
        return build_themes(json.loads(THEMES_PATH.read_text(encoding="utf-8")))
    except (OSError, ValueError, KeyError) as e:
        raise HTTPException(500, f"Could not load {THEMES_PATH.name}: {e}") from e
