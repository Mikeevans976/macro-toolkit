"""Seasonality backtester — API routes."""

from fastapi import APIRouter, Depends

from auth import get_current_user
from seasonality_backtester import (
    fetch_bbg_expression,
    get_seasonality_heatmap,
    get_seasonality_stats,
    run_seasonality_backtest,
)

router = APIRouter(dependencies=[Depends(get_current_user)])


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
def seasonality_stats(
    payload: dict,
):
    """Seasonal statistics across all dimensions for a fetched time series."""
    dates  = payload["dates"]
    values = payload["values"]
    return get_seasonality_stats(dates, values)


@router.post("/api/tools/seasonality/heatmap")
def seasonality_heatmap(
    payload: dict,
):
    """Month × day-of-week mean return matrix."""
    dates  = payload["dates"]
    values = payload["values"]
    return get_seasonality_heatmap(dates, values)


@router.post("/api/tools/seasonality/backtest")
def seasonality_backtest(
    payload: dict,
):
    """Run a seasonality-driven backtest given a rule definition."""
    dates  = payload["dates"]
    values = payload["values"]
    rule   = payload.get("rule", {"type": "dow", "bins": [0], "direction": 1})
    return run_seasonality_backtest(dates, values, rule)
