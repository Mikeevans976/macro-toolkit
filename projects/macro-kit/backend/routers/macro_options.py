"""Macro Options Monitor (Euribor options) — API routes."""

from fastapi import APIRouter, Depends, Query

from auth import get_current_user
from macro_options import get_open_interest, get_snapshot
from schemas.macro_options import MacroOptionsSnapshot, OpenInterest

router = APIRouter(dependencies=[Depends(get_current_user)])

_DATE = r"^\d{4}-\d{2}-\d{2}$"


@router.get("/api/tools/macro-options/snapshot", response_model=MacroOptionsSnapshot)
def get_macro_options_snapshot(date: str | None = Query(None, pattern=_DATE), refresh: bool = False):
    """Futures, option chains (fitted smile + call grid) and the OIS meeting path: live, or a past day's settlement."""
    return get_snapshot(date, refresh=refresh)


@router.get("/api/tools/macro-options/open-interest", response_model=OpenInterest)
def get_macro_options_open_interest(
    contract: str = Query(..., pattern=r"^ER[HMUZ]\d$"),
    expiry: str = Query(..., pattern=r"^\d{4}-\d{2}$"),
    through: str | None = Query(None, pattern=_DATE),
):
    """Daily per-strike call / put open interest of one option expiry."""
    return get_open_interest(contract, expiry, through)
