"""Fitted bond curves (Huggins & Schaller ch. 8) — API routes."""
from typing import Optional

from fastapi import APIRouter, Depends

from auth import get_current_user
from fitted_bond_curves import (
    compute_fitted_curve,
    get_bond_detail as fbc_bond_detail,
    predict_new_issue as fbc_new_issue,
)

router = APIRouter(dependencies=[Depends(get_current_user)])


@router.get("/api/tools/fitted-bond-curves")
def fitted_bond_curves(
    functional_form: str = "cubic_spline",
    exponent: int = 2,
    weighting: str = "none",
    n_exp_splines: int = 7,
    custom_bonds: str = "",
    knots: str = "",
    external_vars: str = "",
    as_of: str = "",
):
    """Fitted discount curve + external regression: residuals, rich/cheap, benchmarks."""
    return compute_fitted_curve(
        functional_form=functional_form,
        exponent=exponent,
        weighting=weighting,
        n_exp_splines=n_exp_splines,
        custom_bonds=custom_bonds,
        knots=knots,
        external_vars=external_vars,
        as_of=as_of,
    )


@router.get("/api/tools/fitted-bond-curves/new-issue")
def fitted_bond_curves_new_issue(
    maturity: str,
    coupon: Optional[float] = None,
    size_bn: float = 20.0,
    extra_bp: float = 0.0,
    functional_form: str = "cubic_spline",
    exponent: int = 2,
    weighting: str = "none",
    n_exp_splines: int = 7,
    custom_bonds: str = "",
    knots: str = "",
    external_vars: str = "",
    as_of: str = "",
):
    """Predict pricing of a hypothetical new issue off the fitted curve (H&S p.180)."""
    return fbc_new_issue(
        maturity=maturity,
        coupon=coupon,
        size_bn=size_bn,
        extra_bp=extra_bp,
        functional_form=functional_form,
        exponent=exponent,
        weighting=weighting,
        n_exp_splines=n_exp_splines,
        custom_bonds=custom_bonds,
        knots=knots,
        external_vars=external_vars,
        as_of=as_of,
    )


@router.get("/api/tools/fitted-bond-curves/bond/{bond_id}")
def fitted_bond_curves_bond(
    bond_id: str,
    functional_form: str = "cubic_spline",
    exponent: int = 2,
    weighting: str = "none",
    n_exp_splines: int = 7,
    custom_bonds: str = "",
    knots: str = "",
    external_vars: str = "",
    as_of: str = "",
):
    """Residual history, OU mean-reversion analysis and fan chart for one bond."""
    return fbc_bond_detail(
        bond_id,
        functional_form=functional_form,
        exponent=exponent,
        weighting=weighting,
        n_exp_splines=n_exp_splines,
        custom_bonds=custom_bonds,
        knots=knots,
        external_vars=external_vars,
        as_of=as_of,
    )
