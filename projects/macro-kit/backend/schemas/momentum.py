"""Response models for /api/tools/momentum (see momentum.py)."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel

Source = Literal["bloomberg", "simulation"]
Regime = Literal["Strong momentum", "Momentum", "Fading", "Reversal", "Range", "Mixed"]


class MomModelInfo(BaseModel):
    response: str                       # tanh | baz | linear
    speed_weights: dict[str, float]     # "8/24" -> weight, sum 1
    calibrated: bool
    aum_bn: float
    leverage: Optional[float] = None    # B: full-position $ vol per market = AUM·B·w_i


class MomFitTested(BaseModel):
    response: str
    r2: float
    r2_oos: Optional[float] = None


class MomCalibration(BaseModel):
    ok: bool
    reason: Optional[str] = None
    index: Optional[str] = None
    weeks: Optional[int] = None
    r2: Optional[float] = None
    r2_oos: Optional[float] = None      # fit on the prior 3y, scored on the last 52 weeks
    corr: Optional[float] = None
    tracking_error: Optional[float] = None
    index_vol: Optional[float] = None
    tested: list[MomFitTested] = []


class MomMonitorRow(BaseModel):
    id: str
    label: str
    group: str
    ticker: str
    kind: Literal["price", "level"]
    unit: str                           # price | pct | bp
    cta: bool
    sector: Optional[str]
    last: Optional[float]
    chg_1w: Optional[float]             # % for prices, bp for yields/spreads
    regime: Regime
    direction: int                      # series direction: +1 up, -1 down, 0 none
    stretched: bool
    er: Optional[float]
    signals: dict[str, Optional[float]] # y per speed, σ units
    position: float                     # % of max, -100..100
    position_chg_1w: Optional[float]
    flip_price: Optional[float]         # next close that flips the composite
    flip_sigma: Optional[float]         # that move in daily σ
    flow_flat_1w: float                 # position change in 1w if price is flat, % of max
    spark: list[Optional[float]]        # position, weekly, last ~6 months
    risk_usd: Optional[float]
    notional_usd: Optional[float]
    contracts: Optional[float]
    flow_flat_1w_usd: Optional[float]
    flow_flat_1w_contracts: Optional[float]
    flow_adv_pct: Optional[float]       # |flat 1w flow| as % of 20d average volume


class MomMissing(BaseModel):
    id: str
    label: str
    reason: str


class MomSectorFlows(BaseModel):
    sector: str
    markets: int
    net_risk_usd: float
    gross_risk_usd: float
    net_notional_usd: float
    position: float                     # risk-weighted average, % of max
    flows_1w: dict[str, float]          # uniform move in σ ("-2".."+2") -> $ notional traded


class MomPnl(BaseModel):
    dates: list[str]
    model: list[Optional[float]]        # cumulative %, weekly
    drawdown: list[Optional[float]]
    index: Optional[list[Optional[float]]]
    model_1m: Optional[float]
    model_3m: Optional[float]


class MomentumMonitor(BaseModel):
    as_of: str
    data_source: Source
    note: Optional[str]
    roll_adjusted: dict[str, Optional[bool]]
    groups: list[str]
    speeds: list[str]
    model: MomModelInfo
    calibration: Optional[MomCalibration]
    rows: list[MomMonitorRow]
    missing: list[MomMissing]
    sectors: list[MomSectorFlows]
    pnl: MomPnl


class MomCurrent(BaseModel):
    date: str
    series_value: Optional[float]
    chg_1w: Optional[float]
    regime: Regime
    direction: int
    stretched: bool
    er: Optional[float]
    vol_ann: Optional[float]            # % for prices, bp for yields
    position: float
    position_1w_ago: Optional[float]
    position_pctile: float
    signals: dict[str, Optional[float]]
    responses: dict[str, Optional[float]]


class MomLevel(BaseModel):
    price: Optional[float]
    move: Optional[float]
    sigma: Optional[float]


class MomSpeedLevel(MomLevel):
    speed: str


class MomTriggers(BaseModel):
    composite: Optional[MomLevel]
    speeds: list[MomSpeedLevel]
    flat_days_to_flip: Optional[int]


class MomScenario(BaseModel):
    horizon_days: int
    shock_sigma: float
    price: float
    position: float
    delta: float                        # % of max
    delta_usd: Optional[float] = None   # notional (prices) or DV01 (yields)
    delta_contracts: Optional[float] = None


class MomSizing(BaseModel):
    basis: Literal["universe", "typical"]
    risk_usd: float
    full_risk_usd: float
    notional_usd: Optional[float]
    dv01_usd: Optional[float]
    contracts: Optional[float]
    contract_usd: Optional[float]
    adv: Optional[float]
    oi: Optional[float]


class MomentumSeries(BaseModel):
    ticker: str
    label: str
    kind: Literal["price", "level"]
    unit: str                           # price | pct | level
    data_source: Source
    roll_adjusted: Optional[bool]
    model: MomModelInfo
    speeds: list[str]
    dates: list[str]
    series: list[Optional[float]]
    position: list[Optional[float]]
    signals: dict[str, list[Optional[float]]]
    current: MomCurrent
    triggers: MomTriggers
    scenarios: list[MomScenario]
    sizing: Optional[MomSizing]
