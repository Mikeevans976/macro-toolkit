"""EUR / GBP / USD inflation fixings — API routes."""

from fastapi import APIRouter, Depends

from auth import get_current_user
from hicp_fixings import get_hicp_fixings
from rpi_fixings import get_rpi_fixings
from us_cpi_fixings import get_us_cpi_fixings

router = APIRouter(dependencies=[Depends(get_current_user)])


@router.get("/api/tools/inflation-fixings/eur")
def hicp_fixings(
    date: str | None = None,
):
    """HICP monthly fixing prices — 24 contracts (EUSWIF1-12, EUSWIT1-12)."""
    return get_hicp_fixings(as_of_date=date)


@router.get("/api/tools/inflation-fixings/gbp")
def inflation_fixings_gbp(
    date: str | None = None,
):
    """UK RPI monthly fixing prices — 24 contracts (UKRPIF1-12, UKRPIT1-12)."""
    return get_rpi_fixings(as_of_date=date)


@router.get("/api/tools/inflation-fixings/usd")
def inflation_fixings_usd(
    date: str | None = None,
):
    """US CPI monthly fixing prices — 24 contracts (USCPIF1-12, USCPIT1-12)."""
    return get_us_cpi_fixings(as_of_date=date)
