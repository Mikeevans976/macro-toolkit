"""FX IPCA (instrumented principal components on currency excess returns) — API routes."""

from fastapi import APIRouter, Depends, HTTPException, Query

from auth import get_current_user
from fx_ipca import K_MAX, get_currency_detail, get_fx_ipca

router = APIRouter(
    prefix="/api/tools/fx-ipca",
    tags=["fx-ipca"],
    dependencies=[Depends(get_current_user)],
)


@router.get("")
def fx_ipca(
    k: int = Query(2, ge=1, le=K_MAX),
    n_boot: int = Query(100, ge=0, le=1000),
    refresh: bool = False,
):
    """Model fit, Gamma_beta, factors, alpha test, current cross-section and OOS backtest."""
    return get_fx_ipca(k=k, n_boot=n_boot, refresh=refresh)


@router.get("/currency/{code}")
def fx_ipca_currency(
    code: str,
    k: int = Query(2, ge=1, le=K_MAX),
    n_boot: int = Query(100, ge=0, le=1000),
):
    """Monthly conditional betas and realised vs fitted returns for one currency."""
    try:
        return get_currency_detail(code.upper(), k=k, n_boot=n_boot)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Unknown currency {code!r}")
