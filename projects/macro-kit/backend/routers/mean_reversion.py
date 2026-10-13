"""
Mean Reversion API routes.

Handlers are plain ``def`` so FastAPI runs the CPU-bound fitting / Monte-Carlo
work in its threadpool instead of blocking the event loop. Request bodies are
validated and bounded (e.g. ``n_sims``) so a single request cannot pin a CPU
indefinitely or crash with a 500 on malformed input.
"""
from __future__ import annotations

from typing import Literal, Optional

import pandas as pd
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from auth import get_current_user
from mean_reversion import (
    _add_horizon_dates,
    analyse,
    build_series,
    forward_histogram,
    parse_expression,
    sharpe_profile_mc,
    stanton_diagnostic,
    transition_densities_mc,
)

router = APIRouter(
    prefix="/api/tools/mean-reversion",
    tags=["mean-reversion"],
    dependencies=[Depends(get_current_user)],
)

SdeType = Literal["linear_ou", "polynomial", "inverse_polynomial"]
MAX_SIMS = 50_000


class _SeriesRequest(BaseModel):
    expression: str = Field(min_length=1, max_length=500)
    start_date: str = "2018-01-01"
    end_date: Optional[str] = None
    fit_start: Optional[str] = None
    fit_end: Optional[str] = None


class AnalyseRequest(_SeriesRequest):
    model_type: SdeType = "linear_ou"
    target: Optional[float] = None
    stop: Optional[float] = None
    n_sims: int = Field(5_000, ge=100, le=MAX_SIMS)


class StantonRequest(_SeriesRequest):
    n_buckets: int = Field(20, ge=2, le=200)
    sim_sde: Optional[SdeType] = None


class ForwardDistRequest(_SeriesRequest):
    sim_sde: SdeType
    n_sims: int = Field(10_000, ge=100, le=MAX_SIMS)


class SharpeMcRequest(_SeriesRequest):
    sim_sde: SdeType
    n_sims: int = Field(10_000, ge=100, le=MAX_SIMS)


class ForwardHistRequest(_SeriesRequest):
    sim_sde: SdeType = "linear_ou"
    n_sims: int = Field(10_000, ge=100, le=MAX_SIMS)
    target_date: str


def _load(req: _SeriesRequest) -> tuple[pd.Series, pd.Series]:
    """Build the expression series and slice the fit window. Returns (series, fit_series)."""
    end_date = req.end_date or pd.Timestamp.today().strftime("%Y-%m-%d")
    series, _ = build_series(parse_expression(req.expression), req.start_date, end_date)
    fit_series = series.loc[
        (req.fit_start or series.index[0].strftime("%Y-%m-%d")):
        (req.fit_end or series.index[-1].strftime("%Y-%m-%d"))
    ]
    return series, fit_series


@router.post("/analyse")
def mean_reversion_analyse(req: AnalyseRequest):
    return analyse(
        expression=req.expression,
        start_date=req.start_date,
        end_date=req.end_date,
        fit_start=req.fit_start,
        fit_end=req.fit_end,
        model_type=req.model_type,
        target=req.target,
        stop=req.stop,
        n_sims=req.n_sims,
    )


@router.post("/stanton")
def mean_reversion_stanton(req: StantonRequest):
    """Lightweight endpoint: re-computes only the Stanton diagnostic buckets."""
    _, fit_series = _load(req)
    return stanton_diagnostic(fit_series, n_buckets=req.n_buckets, sim_sde=req.sim_sde)


@router.post("/forward-dist")
def mean_reversion_forward_dist(req: ForwardDistRequest):
    """MC forward distributions for a chosen SDE spec (user-triggered)."""
    series, fit_series = _load(req)
    # Estimate on fit window but start simulation from current actual level
    current_level = float(series.dropna().iloc[-1])
    td = transition_densities_mc(
        fit_series, sim_sde=req.sim_sde, n_sims=req.n_sims, x_now=current_level,
    )
    _add_horizon_dates(td, series.index[-1])
    return td


@router.post("/sharpe-mc")
def mean_reversion_sharpe_mc(req: SharpeMcRequest):
    """MC Sharpe profile for polynomial / inverse-polynomial SDEs."""
    series, fit_series = _load(req)
    current_level = float(series.dropna().iloc[-1])
    return sharpe_profile_mc(fit_series, req.sim_sde, x_now=current_level, n_sims=req.n_sims)


@router.post("/forward-hist")
def mean_reversion_forward_hist(req: ForwardHistRequest):
    """Terminal distribution histogram + KDE at a user-specified future date."""
    series, fit_series = _load(req)
    current_level = float(series.dropna().iloc[-1])
    last_date = series.index[-1]

    # Convert target calendar date → number of business days from last_date
    target_ts = pd.Timestamp(req.target_date)
    horizon_days = max(1, len(pd.bdate_range(last_date, target_ts)) - 1)

    result = forward_histogram(
        fit_series, req.sim_sde, horizon_days,
        n_sims=req.n_sims, x_now=current_level,
    )
    result["horizon_date"] = target_ts.strftime("%Y-%m-%d")
    return result
