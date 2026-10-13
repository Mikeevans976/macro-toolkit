"""EGB relative value monitor — API routes."""

from fastapi import APIRouter, Depends, HTTPException

from auth import get_current_user
from egb_rv import compute_egb_rv, get_egb_series

router = APIRouter(dependencies=[Depends(get_current_user)])


@router.get("/api/tools/egb-rv")
def get_egb_rv(
    date: str | None = None,
    use_individual_bonds: bool = False,
    refresh: bool = False,
):
    return compute_egb_rv(as_of_date=date, use_individual_bonds=use_individual_bonds, refresh=refresh)


@router.get("/api/tools/egb-rv/series")
def get_egb_rv_series(
    label: str,
    date: str | None = None,
    use_individual_bonds: bool = False,
):
    """Full daily history for a single EGB expression (detail view)."""
    try:
        return get_egb_series(label, as_of_date=date, use_individual_bonds=use_individual_bonds)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Unknown expression: {label}")
