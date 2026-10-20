"""CTA momentum: cross-asset monitor and single-series signals — API routes."""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query

from auth import get_current_user
from momentum import DEFAULT_AUM_BN, SeriesNotFound, compute_cta_signals, get_monitor
from schemas.momentum import MomentumMonitor, MomentumSeries

router = APIRouter(dependencies=[Depends(get_current_user)])


@router.get("/api/tools/momentum/monitor", response_model=MomentumMonitor)
def momentum_monitor(aum_bn: float = Query(DEFAULT_AUM_BN, gt=0, le=5000), refresh: bool = False):
    """Regime, model CTA position, triggers and flows for the default universe."""
    return get_monitor(aum_bn=aum_bn, refresh=refresh)


@router.get("/api/tools/momentum/cta-signals", response_model=MomentumSeries)
def cta_signals(
    ticker: str = Query(..., min_length=1, max_length=500),
    start: str = Query("2015-01-01", pattern=r"^\d{4}-\d{2}-\d{2}$"),
    kind: Literal["auto", "price", "level"] = "auto",
    aum_bn: float = Query(DEFAULT_AUM_BN, gt=0, le=5000),
    pctile_years: int = Query(0, ge=0, le=30),
    refresh: bool = False,
):
    """Signals for any ticker expression, e.g. 'TY1 Comdty' or 'USGG10YR Index - USGG2YR Index'."""
    try:
        return compute_cta_signals(ticker=ticker, start=start, kind=kind, aum_bn=aum_bn,
                                   pctile_years=pctile_years, refresh=refresh)
    except SeriesNotFound as e:
        raise HTTPException(404, str(e)) from e
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
