"""UK Labour Market Nowcast (Quant Macro section) — API routes.

Paths sit under /api/tools/quant-macro/labour/{country}; the nowcast routes'
second segment is always a literal (status, refit, backtest), so they never collide.
"""
from fastapi import APIRouter, Depends, HTTPException

from auth import get_current_user
from labour_nowcast import COUNTRIES, get_labour, get_status, start_job
from schemas.labour_nowcast import LabourNowcast, LabourStatus

router = APIRouter(dependencies=[Depends(get_current_user)])


def _check(country: str) -> None:
    if country not in COUNTRIES:
        raise HTTPException(status_code=404, detail=f"Unknown country {country!r}")


@router.get("/api/tools/quant-macro/labour/{country}", response_model=LabourNowcast)
def labour(country: str):
    """Underlying employment growth (Bank of England staff method), indicator contributions,
    next LFS / payroll / unemployment prints and the Bank's companion analyses.
    Refreshed in the background on a new day; computed here only on first use."""
    _check(country)
    return get_labour(country)


@router.get("/api/tools/quant-macro/labour/{country}/status", response_model=LabourStatus)
def labour_status(country: str):
    """When the model was fitted and the payload computed, and job progress."""
    _check(country)
    return get_status(country)


@router.post("/api/tools/quant-macro/labour/{country}/refresh", response_model=LabourStatus)
def labour_refresh(country: str):
    """Download the latest data and run it through the saved parameters (background job)."""
    _check(country)
    return start_job(country, "update")


@router.post("/api/tools/quant-macro/labour/{country}/refit", response_model=LabourStatus)
def labour_refit(country: str):
    """Re-estimate the factor model and its scaling on today's data (background job)."""
    _check(country)
    return start_job(country, "refit")
