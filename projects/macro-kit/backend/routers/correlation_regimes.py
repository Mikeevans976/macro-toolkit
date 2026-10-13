"""Cross-asset correlation regimes — API routes."""

from fastapi import APIRouter, Depends

from auth import get_current_user
from correlation_regimes import get_pair_detail as cr_pair_detail, run_scan as cr_run_scan

router = APIRouter(dependencies=[Depends(get_current_user)])


@router.get("/api/tools/correlation-regimes/scan")
def correlation_regimes_scan(
    long_window: int = 126,
    short_window: int = 21,
    min_abs_corr: float = 0.6,
):
    """Cross-asset correlation-breakdown scan (dual-window Fisher-z)."""
    return cr_run_scan(
        long_window=long_window,
        short_window=short_window,
        min_abs_corr=min_abs_corr,
    )


@router.get("/api/tools/correlation-regimes/pair")
def correlation_regimes_pair(
    x: str,
    y: str,
    long_window: int = 126,
    short_window: int = 21,
):
    """Pair drilldown — rolling correlation/beta timeline + regime-vs-recent scatter."""
    return cr_pair_detail(x=x, y=y, long_window=long_window, short_window=short_window)
