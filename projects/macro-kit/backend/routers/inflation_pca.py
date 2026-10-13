"""Inflation-linked curve PCA — API routes."""

from fastapi import APIRouter, Depends

from auth import get_current_user
from inflation_pca import get_inflation_pca_data

router = APIRouter(dependencies=[Depends(get_current_user)])


@router.get("/api/tools/inflation-pca/{curve_id}")
def inflation_pca(curve_id: str):
    """PCA-neutral butterfly analysis for EUR/GBP ILB curves."""
    return get_inflation_pca_data(curve_id)
