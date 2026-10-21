"""Quant Macro (nowcasts per G10 market) — API routes."""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

from auth import get_current_user
from quant_macro import MODELS, get_backtest, get_nowcast, get_status, list_models, start_backtest, start_refit
from schemas.quant_macro import Nowcast, NowcastBacktest, NowcastModelSummary, NowcastStatus

router = APIRouter(dependencies=[Depends(get_current_user)])


def _check(model: str) -> None:
    if model not in MODELS:
        raise HTTPException(status_code=404, detail=f"Unknown model {model!r}")


@router.get("/api/tools/quant-macro", response_model=list[NowcastModelSummary])
def quant_macro_models():
    """Every nowcasting model in the Quant Macro section."""
    return list_models()


@router.get("/api/tools/quant-macro/{model}", response_model=Nowcast)
def quant_macro_nowcast(model: str):
    """Last computed nowcast (refreshed in the background when stale; computed here only on first use)."""
    _check(model)
    return get_nowcast(model)


@router.get("/api/tools/quant-macro/{model}/status", response_model=NowcastStatus)
def quant_macro_status(model: str):
    """When the model was fitted, the nowcast computed and the backtest run, and any running jobs."""
    _check(model)
    return get_status(model)


@router.post("/api/tools/quant-macro/{model}/refit", response_model=NowcastStatus)
def quant_macro_refit(model: str):
    """Re-estimate the parameters on today's data, then recompute the nowcast (background job)."""
    _check(model)
    return start_refit(model)


@router.get("/api/tools/quant-macro/{model}/backtest", response_model=Optional[NowcastBacktest])
def quant_macro_backtest(model: str):
    """Last saved real-time backtest (null if none has been run)."""
    _check(model)
    return get_backtest(model)


@router.post("/api/tools/quant-macro/{model}/backtest", response_model=NowcastStatus)
def quant_macro_run_backtest(model: str):
    """Run the full real-time backtest, re-estimating every quarter (background job, ~5–10 min)."""
    _check(model)
    return start_backtest(model)
