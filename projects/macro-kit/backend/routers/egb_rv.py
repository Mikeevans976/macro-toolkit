"""EGB relative value monitor — API routes."""

from fastapi import APIRouter, Depends, HTTPException, Query

from auth import get_current_user
from egb_rv import (
    compute_carry_backtest,
    compute_egb_rv,
    compute_neutral,
    compute_regression,
    compute_rolldown,
    get_egb_series,
)

router = APIRouter(dependencies=[Depends(get_current_user)])


@router.get("/api/tools/egb-rv")
def get_egb_rv(
    date: str | None = None,
    use_individual_bonds: bool = False,
    refresh: bool = False,
):
    return compute_egb_rv(as_of_date=date, use_individual_bonds=use_individual_bonds, refresh=refresh)


@router.get("/api/tools/egb-rv/series")
def get_egb_rv_series(
    label: str,
    date: str | None = None,
    use_individual_bonds: bool = False,
):
    """Full daily history for a single EGB expression (detail view)."""
    try:
        return get_egb_series(label, as_of_date=date, use_individual_bonds=use_individual_bonds)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Unknown expression: {label}")


@router.get("/api/tools/egb-rv/regression")
def get_egb_rv_regression(
    label: str,
    date: str | None = None,
    use_individual_bonds: bool = False,
    window: int = Query(63, ge=20, le=504),
):
    """Beta Monitor regression for one expression: coefficients, rolling betas, residuals, attribution."""
    try:
        return compute_regression(label, as_of_date=date, use_individual_bonds=use_individual_bonds, window=window)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc.args[0])) from exc


class RepoSpreads:
    """The page's repo assumptions: each repo bloc's repo in bp over €STR."""

    def __init__(
        self,
        repo_bund: float = Query(0.0, ge=-500, le=500),
        repo_oat: float = Query(0.0, ge=-500, le=500),
        repo_btp: float = Query(0.0, ge=-500, le=500),
        repo_bonos: float = Query(0.0, ge=-500, le=500),
    ):
        self.bp = {"Bund": repo_bund, "OAT": repo_oat, "BTP": repo_btp, "Bonos": repo_bonos}


@router.get("/api/tools/egb-rv/neutral")
def get_egb_rv_neutral(label: str, date: str | None = None, use_individual_bonds: bool = False,
                       repo: RepoSpreads = Depends()):
    """One expression next to its level- (or level- and slope-) neutral version."""
    try:
        return compute_neutral(label, as_of_date=date, use_individual_bonds=use_individual_bonds,
                               repo_spreads_bp=repo.bp)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc.args[0])) from exc


@router.get("/api/tools/egb-rv/rolldown")
def get_egb_rv_rolldown(label: str, date: str | None = None, use_individual_bonds: bool = False,
                        repo: RepoSpreads = Depends()):
    """Each leg's income carry and roll-down along its country's curve on the as-of date."""
    try:
        return compute_rolldown(label, as_of_date=date, use_individual_bonds=use_individual_bonds,
                                repo_spreads_bp=repo.bp)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc.args[0])) from exc


@router.get("/api/tools/egb-rv/carry-backtest")
def get_egb_rv_carry_backtest(
    date: str | None = None,
    label: str | None = None,
    window: str = Query("1y", pattern="^(1y|2y|all)$"),
    use_individual_bonds: bool = False,
):
    """How much predicted 1y roll-down was delivered: all expressions, per expression, and one expression's history."""
    try:
        return compute_carry_backtest(as_of_date=date, label=label, window=window,
                                      use_individual_bonds=use_individual_bonds)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc.args[0])) from exc
