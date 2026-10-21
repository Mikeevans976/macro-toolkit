"""Debt sustainability monitor (Quant Macro section) — API routes.

Paths sit under /api/tools/quant-macro/dsa/{country}; they have one more segment than
the nowcast routes (/api/tools/quant-macro/{model}/...), so the two never collide.
"""
from fastapi import APIRouter, Depends, HTTPException, UploadFile

from auth import get_current_user
from debt_sustainability import COUNTRIES, get_dsa, get_status, save_upload, start_refresh
from schemas.debt_sustainability import DebtSustainability, DsaStatus, DsaUpload

router = APIRouter(dependencies=[Depends(get_current_user)])

MAX_UPLOAD = 40 * 1024 * 1024


def _check(country: str) -> None:
    if country not in COUNTRIES:
        raise HTTPException(status_code=404, detail=f"Unknown country {country!r}")


@router.get("/api/tools/quant-macro/dsa/{country}", response_model=DebtSustainability)
def dsa(country: str):
    """Debt sustainability monitor: OBR vs market baseline, live fiscal-rule headroom, fan charts,
    scenarios, debt interest, financing, the monthly borrowing tracker and market gauges.
    Refreshed in the background when over an hour old; computed here only on first use (~30 s)."""
    _check(country)
    return get_dsa(country)


@router.get("/api/tools/quant-macro/dsa/{country}/status", response_model=DsaStatus)
def dsa_status(country: str):
    """When the payload was computed, and the refresh job's progress."""
    _check(country)
    return get_status(country)


@router.post("/api/tools/quant-macro/dsa/{country}/refresh", response_model=DsaStatus)
def dsa_refresh(country: str):
    """Download the latest data and recompute (background job)."""
    _check(country)
    return start_refresh(country)


@router.post("/api/tools/quant-macro/dsa/{country}/upload", response_model=DsaUpload)
def dsa_upload(country: str, file: UploadFile):
    """Upload an OBR Economic and fiscal outlook (PDF) or the DMO gilts-in-issue report
    (D1A as CSV, XLSX or XML); then recompute in the background."""
    _check(country)
    data = file.file.read(MAX_UPLOAD + 1)
    if len(data) > MAX_UPLOAD:
        raise HTTPException(status_code=413, detail="File too large (40 MB maximum)")
    try:
        return save_upload(country, file.filename or "upload", data)
    except (ValueError, KeyError, StopIteration) as exc:
        raise HTTPException(status_code=422, detail=f"Could not read {file.filename}: {exc}") from exc
