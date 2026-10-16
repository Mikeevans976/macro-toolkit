"""Swap relative value (carry, roll, OIS) — API routes."""

from fastapi import APIRouter, Depends, HTTPException, Query

from auth import get_current_user
from swaps_rv import compute_regression, compute_rv

router = APIRouter(dependencies=[Depends(get_current_user)])


@router.get("/api/tools/swaps-rv")
def get_swaps_rv(
    date: str | None = None,
    currency: str = "EUR",
    refresh: bool = False,
):
    return compute_rv(currency=currency, as_of_date=date, refresh=refresh)


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
