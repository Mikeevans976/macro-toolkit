"""Yield-curve PCA analysis — API routes."""
from typing import Optional

from fastapi import APIRouter, Depends

from auth import get_current_user
from pca_analysis import get_pca_data

router = APIRouter(dependencies=[Depends(get_current_user)])


@router.get("/api/tools/pca-analysis")
def pca_analysis(
    curve: str = "bund",
    tenors: str = "2,5,7,10",
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    n_factors: int = 3,
    extra_tickers: str = "",
    use_changes: bool = False,
    roll_window_weeks: Optional[int] = None,
    custom_tickers: str = "",   # "TICKER:Label,TICKER:Label,..." — activates custom mode
):
    """PCA on yield curve — eigenvalues, eigenvectors, factor time series, residuals, OU model."""
    def _parse_ticker_list(raw: str) -> list[dict]:
        out: list[dict] = []
        for part in raw.split(","):
            part = part.strip()
            if not part:
                continue
            if ":" in part:
                ticker, label = part.split(":", 1)
                out.append({"ticker": ticker.strip(), "label": label.strip()})
            else:
                out.append({"ticker": part, "label": part})
        return out

    extra_list = _parse_ticker_list(extra_tickers)
    custom_list = _parse_ticker_list(custom_tickers)

    if custom_list:
        # Custom mode — ignore curve/tenors
        return get_pca_data(
            start_date=start_date,
            end_date=end_date,
            n_factors=n_factors,
            extra_tickers=extra_list or None,
            use_changes=use_changes,
            roll_window_weeks=roll_window_weeks,
            custom_tickers=custom_list,
        )

    tenor_list = [int(t.strip()) for t in tenors.split(",") if t.strip()]
    return get_pca_data(
        curve_id=curve,
        tenors=tenor_list,
        start_date=start_date,
        end_date=end_date,
        n_factors=n_factors,
        extra_tickers=extra_list or None,
        use_changes=use_changes,
        roll_window_weeks=roll_window_weeks,
    )
