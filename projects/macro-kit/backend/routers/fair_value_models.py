"""Rolling Elastic Net fair value models (HICPxT swaps) — API routes."""

from fastapi import APIRouter, Depends

from auth import get_current_user
from fair_value_models import get_fair_value_models_data

router = APIRouter(dependencies=[Depends(get_current_user)])


@router.get("/api/tools/fair-value-models")
def fair_value_models():
    """Rolling Elastic Net fair value models for HICPxT inflation swaps."""
    return get_fair_value_models_data()
