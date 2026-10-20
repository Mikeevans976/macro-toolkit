"""Quant Macro (nowcasts per G10 market) — API routes."""
from fastapi import APIRouter, Depends, HTTPException

from auth import get_current_user
from quant_macro import MODELS, get_backtest, get_nowcast, list_models
from schemas.quant_macro import NowcastBacktest, NowcastModelSummary, Nowcast

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
    """Nowcast, next print, news since the quarter began, catalysts and the central bank's estimates."""
    _check(model)
    return get_nowcast(model)


@router.get("/api/tools/quant-macro/{model}/backtest", response_model=NowcastBacktest)
def quant_macro_backtest(model: str):
    """Pseudo-real-time nowcast errors at fixed days before each first estimate (slow on first call)."""
    _check(model)
    return get_backtest(model)
