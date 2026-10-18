"""Response models for /api/tools/swap-spreads (see swap_spreads.py)."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel

Source = Literal["live", "simulation"]


class CurvePoint(BaseModel):
    tenor: float
    rate: float


class BasisPoint(BaseModel):
    tenor: float
    bp: float


class MarketRow(BaseModel):
    ccy: str
    rfr: str
    float_freq: int
    fixed_freq: int
    par_curve: list[CurvePoint]
    ccbs: list[BasisPoint]


class BondRow(BaseModel):
    bond_id: str
    issuer: str
    ccy: str
    name: str
    coupon: float
    coupon_freq: int
    maturity: str
    ttm: float
    dirty: float
    clean: float
    ytm: float
    par_asw_bp: float
    market_value_asw_bp: float
    interpolated_asw_bp: float
    conversion_factor: float
    target_spread_bp: float
    synthetic_coupon: float
    fw_duration: float
    bpv: float


class SpreadPoint(BaseModel):
    tenor: float
    bp: float


class IssuerCurve(BaseModel):
    issuer: str
    ccy: str
    points: list[SpreadPoint]


class SwapSpreads(BaseModel):
    as_of: str
    data_source: Source
    target_ccy: str
    target_rfr: str
    markets: list[MarketRow]
    bonds: list[BondRow]
    issuer_curves: list[IssuerCurve]


class SwapSteps(BaseModel):
    home_ccy: str
    target_ccy: str
    maturity: float
    dirty: float
    ytm: float
    upfront: float
    pv_on_swap_curve: float
    home_float_annuity: float
    home_par_swap_rate: float
    par_asw_bp: float
    market_value_asw_bp: float
    interpolated_asw_bp: float
    home_icbs_bp: float
    home_ccbs_bp: float
    target_ccbs_bp: float
    home_rfr_spread_bp: float
    conversion_factor: float
    target_float_annuity: float
    target_spread_bp: float
    target_fixed_annuity: float
    target_par_swap_rate: float
    synthetic_coupon: float


class CashFlow(BaseModel):
    time: float
    amount: float
    df: float
    pv: float


class BondBreakdown(BaseModel):
    as_of: str
    data_source: Source
    bond: BondRow
    home_rfr: str
    target_ccy: str
    target_rfr: str
    steps: SwapSteps
    cashflows: list[CashFlow]


class CdsScenario(BaseModel):
    case: Literal["low", "mid", "high"]
    factor: float
    adjusted_bp: float


class CdsAdjustment(BaseModel):
    cds_bp: float
    settlement: Literal["cash", "physical"]
    factor: float
    adjusted_bp: float
    scenarios: list[CdsScenario]


class SecuredUnsecured(BaseModel):
    g: float
    q: float
    d: float
    basis_bp: float
    d_new: float
    basis_new_bp: float
    change_bp: float


class TermRateInputs(BaseModel):
    repo: float
    pd: float
    recovery: float
    q: float
    d: float
    g: float
    b: float


class TermRateModel(BaseModel):
    rate: float
    funding: float
    credit: float
    capital: float
    spread_to_repo_bp: float


class TermRate(BaseModel):
    inputs: TermRateInputs
    model: TermRateModel
    market_rate_pct: float
    market_spread_to_repo_bp: float
    implied_g_pct: Optional[float]


class HaircutPoint(BaseModel):
    tenor: float
    haircut_pct: float
    drag_bp: float


class HaircutCurve(BaseModel):
    issuer: str
    schedule: str
    haircut_class: str
    class_label: str
    rating_basis: str
    points: list[HaircutPoint]


class HaircutBond(BaseModel):
    bond_id: str
    issuer: str
    name: str
    ttm: float
    duration: float
    haircut_pct: float
    drag_bp: float


class HaircutSource(BaseModel):
    schedule: str
    name: str
    source: str
    url: str
    as_of: str
    basis: Literal["residual_maturity", "duration"]


class Haircuts(BaseModel):
    excess_funding_bp: float
    zero_coupon: bool
    btp_downgrade: bool
    curves: list[HaircutCurve]
    bonds: list[HaircutBond]
    sources: list[HaircutSource]


class FundingInputs(BaseModel):
    data_source: Source
    cds: CdsAdjustment
    secured_unsecured: SecuredUnsecured
    term_rate: TermRate
    haircuts: Haircuts
