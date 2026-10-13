"""Swap relative value (carry, roll, OIS) — API routes."""

from fastapi import APIRouter, Depends

from auth import get_current_user
from swaps_rv import compute_rv

router = APIRouter(dependencies=[Depends(get_current_user)])


@router.get("/api/tools/swaps-rv")
def get_swaps_rv(
    date: str | None = None,
    currency: str = "EUR",
):
    return compute_rv(currency=currency, as_of_date=date)
