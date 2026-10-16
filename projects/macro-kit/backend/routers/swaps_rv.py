"""Swap relative value (carry, roll, OIS) — API routes."""

from fastapi import APIRouter, Depends, HTTPException, Query

from auth import get_current_user
from swaps_rv import compute_carry_backtest, compute_history, compute_regression, compute_rv

router = APIRouter(dependencies=[Depends(get_current_user)])


@router.get("/api/tools/swaps-rv")
def get_swaps_rv(
    date: str | None = None,
    currency: str = "EUR",
    refresh: bool = False,
    universe: str = Query("core", pattern="^(core|extended)$"),
):
    return compute_rv(currency=currency, as_of_date=date, refresh=refresh, universe=universe)


@router.get("/api/tools/swaps-rv/history")
def get_swaps_rv_history(label: str, currency: str = "EUR", date: str | None = None):
    """Full daily history of one structure (bps) up to the as-of date."""
    try:
        return compute_history(currency=currency, label=label, as_of_date=date)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc.args[0])) from exc


@router.get("/api/tools/swaps-rv/regression")
def get_swaps_rv_regression(
    label: str,
    currency: str = "EUR",
    date: str | None = None,
    window: int = Query(63, ge=20, le=504),
):
    """Beta Monitor regression for one structure: coefficients, rolling betas, residuals, attribution."""
    try:
        return compute_regression(currency=currency, label=label, as_of_date=date, window=window)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc.args[0])) from exc


@router.get("/api/tools/swaps-rv/carry-backtest")
def get_swaps_rv_carry_backtest(
    currency: str = "EUR",
    date: str | None = None,
    label: str | None = None,
    window: str = Query("1y", pattern="^(1y|2y|all)$"),
    universe: str = Query("core", pattern="^(core|extended)$"),
):
    """How much predicted 1y roll-down was delivered: per currency, per structure, and one structure's history."""
    try:
        return compute_carry_backtest(currency=currency, as_of_date=date, label=label, window=window, universe=universe)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc.args[0])) from exc
