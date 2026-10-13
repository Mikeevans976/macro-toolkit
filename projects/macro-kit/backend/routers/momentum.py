"""CTA momentum signals — API routes."""

from fastapi import APIRouter, Depends

from auth import get_current_user
from momentum import compute_cta_signals

router = APIRouter(dependencies=[Depends(get_current_user)])


@router.get("/api/tools/momentum/cta-signals")
def cta_signals(
    ticker: str,
    start: str = "2010-01-01",
):
    return compute_cta_signals(ticker=ticker, start=start)
