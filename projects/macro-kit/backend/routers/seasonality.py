"""Seasonality backtester — API routes."""

from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, model_validator

from auth import get_current_user
from seasonality_backtester import (
    fetch_bbg_expression,
    get_seasonality_heatmap,
    get_seasonality_stats,
    run_seasonality_backtest,
)

router = APIRouter(dependencies=[Depends(get_current_user)])

MAX_POINTS = 50_000   # ~200 years of business days


class SeriesPayload(BaseModel):
    dates: list[str] = Field(min_length=2, max_length=MAX_POINTS)
    values: list[float] = Field(min_length=2, max_length=MAX_POINTS)

    @model_validator(mode="after")
    def _same_length(self):
        if len(self.dates) != len(self.values):
            raise ValueError("dates and values must have the same length")
        return self


class BacktestRule(BaseModel):
    type: Literal["dow", "month", "dom_quintile", "tom", "quarter_end"] = "dow"
    bins: list[int] = Field(default_factory=lambda: [0], max_length=64)
    direction: Literal[1, -1] = 1


class BacktestPayload(SeriesPayload):
    rule: BacktestRule = Field(default_factory=BacktestRule)


@router.get("/api/tools/seasonality/data")
def seasonality_data(
    expression: str,
    start: str = "2010-01-01",
):
    """
    Fetch and evaluate a Bloomberg expression, returning a daily time series.
    expression examples:
      'GDBR10 Index'
      'GDBR10 Index - GDBR2 Index'
      'GDBR30 Index - 2 * GDBR10 Index + GDBR2 Index'
    """
    return fetch_bbg_expression(expression, start=start)


@router.post("/api/tools/seasonality/stats")
def seasonality_stats(payload: SeriesPayload):
    """Seasonal statistics across all dimensions for a fetched time series."""
    return get_seasonality_stats(payload.dates, payload.values)


@router.post("/api/tools/seasonality/heatmap")
def seasonality_heatmap(payload: SeriesPayload):
    """Month × day-of-week mean return matrix."""
    return get_seasonality_heatmap(payload.dates, payload.values)


@router.post("/api/tools/seasonality/backtest")
def seasonality_backtest(payload: BacktestPayload):
    """Run a seasonality-driven backtest given a rule definition."""
    return run_seasonality_backtest(payload.dates, payload.values, payload.rule.model_dump())
