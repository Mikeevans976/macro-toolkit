"""Swap Spreads & Basis (H&S Ch 16-17) — API routes."""
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException

from auth import get_current_user
from schemas.swap_spreads import BondBreakdown, SwapSpreads
from swap_spreads import compute_swap_spreads, get_bond_breakdown

router = APIRouter(dependencies=[Depends(get_current_user)])

Target = Literal["USD", "EUR", "GBP", "JPY"]


@router.get("/api/tools/swap-spreads", response_model=SwapSpreads)
def swap_spreads(target: Target = "USD"):
    """Every benchmark bond asset-swapped and basis-swapped into the target currency."""
    return compute_swap_spreads(target)


@router.get("/api/tools/swap-spreads/bond", response_model=BondBreakdown)
def swap_spreads_bond(bond_id: str, target: Target = "USD"):
    """Step-by-step asset & basis-swap breakdown for one bond."""
    try:
        return get_bond_breakdown(bond_id, target)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Unknown bond {bond_id!r}")
