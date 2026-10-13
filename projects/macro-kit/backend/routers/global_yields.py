"""Global yields PCA factor model — API routes."""

from fastapi import APIRouter, Depends

from auth import get_current_user
from global_yields import get_global_yields_data

router = APIRouter(dependencies=[Depends(get_current_user)])


@router.get("/api/tools/global-yields")
def global_yields():
    """PCA factor model on global 10y yields: factors, residuals, fair-value table."""
    return get_global_yields_data()
