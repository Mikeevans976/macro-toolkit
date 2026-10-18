"""Response models for /api/tools/swap-spreads (see swap_spreads.py)."""
from __future__ import annotations

from typing import Literal

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


class SwapSpreads(BaseModel):
    as_of: str
    data_source: Source
    target_ccy: str
    target_rfr: str
    markets: list[MarketRow]
    bonds: list[BondRow]


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
