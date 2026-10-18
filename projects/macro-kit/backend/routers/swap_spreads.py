"""Swap Spreads & Basis (H&S Ch 16-17) — API routes."""
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query

from auth import get_current_user
from schemas.swap_spreads import BondBreakdown, FundingInputs, SwapSpreads
from swap_spreads import compute_swap_spreads, get_bond_breakdown, get_funding_inputs

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


@router.get("/api/tools/swap-spreads/funding", response_model=FundingInputs)
def swap_spreads_funding(
    cds_bp: float = Query(60.0, ge=0, le=5000),
    settlement: Literal["cash", "physical"] = "physical",
    g: float = Query(0.10, ge=-0.5, le=1.0, description="cost of equity"),
    q: float = Query(0.20, ge=0, le=1.5, description="risk weight"),
    d: float = Query(0.08, ge=0, le=0.5, description="capital ratio"),
    d_new: float = Query(0.12, ge=0, le=0.5, description="what-if capital ratio"),
    repo: float = Query(0.019, ge=-0.05, le=0.5),
    pd: float = Query(0.0025, ge=0, le=0.5, description="default probability"),
    recovery: float = Query(0.40, ge=0, le=1),
    b: float = Query(0.019, ge=-0.05, le=0.5, description="return earned on the capital"),
    market_term_rate: float = Query(0.0215, ge=-0.05, le=0.5),
    excess_funding_bp: float = Query(600.0, ge=0, le=5000),
    zero: bool = False,
    btp_downgrade: bool = False,
):
    """Fair-value building blocks: CDS adjustment, secured-unsecured basis, repo-term rate, haircut cost."""
    return get_funding_inputs(
        cds_bp=cds_bp, settlement=settlement, g=g, q=q, d=d, d_new=d_new,
        repo=repo, pd_=pd, recovery=recovery, b=b, market_term_rate=market_term_rate,
        excess_funding_bp=excess_funding_bp, zero=zero, btp_downgrade=btp_downgrade,
    )
