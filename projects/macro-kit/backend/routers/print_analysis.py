"""Economic print vs consensus analysis — API routes."""

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from auth import get_current_user
from print_analysis import fetch_market_reaction, fetch_print_vs_consensus

router = APIRouter(dependencies=[Depends(get_current_user)])


class Release(BaseModel):
    period: str
    release_date: str
    surprise: float


class MarketReactionPayload(BaseModel):
    market_ticker: str = Field(min_length=1, max_length=100)
    releases: list[Release] = Field(default_factory=list, max_length=5_000)


@router.get("/api/tools/print-analysis/print-vs-consensus")
def print_vs_consensus(
    ticker: str,
    start: str = "2010-01-01",
):
    """
    Fetch historical economic prints + Bloomberg survey consensus for a ticker.
    ticker: Bloomberg ticker with yellow key, e.g. "UKPRIC YOY Index"
    """
    return fetch_print_vs_consensus(ticker=ticker, start=start)


@router.post("/api/tools/print-analysis/market-reaction")
def market_reaction(payload: MarketReactionPayload):
    """Compute day-of-release market moves for a given instrument."""
    return fetch_market_reaction(
        market_ticker=payload.market_ticker,
        releases=[r.model_dump() for r in payload.releases],
    )
