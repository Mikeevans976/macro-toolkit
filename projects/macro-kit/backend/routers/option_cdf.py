"""Option-implied CDF swaption parameters — API routes."""

from fastapi import APIRouter, Depends

from auth import get_current_user
from option_derived_cdf import get_option_cdf_params

router = APIRouter(dependencies=[Depends(get_current_user)])


@router.get("/api/tools/option-cdf/{ccy}/{tail}")
def option_cdf_params(ccy: str, tail: str):
    """Swaption market parameters for Option-Implied CDF tool."""
    return get_option_cdf_params(ccy, tail)
