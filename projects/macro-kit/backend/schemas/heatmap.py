"""Response models for /api/tools/heatmap (see regional_heatmap.get_dashboard)."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel

Source = Literal["live", "simulation"]


class Period(BaseModel):
    start: str
    end: str


class DataSources(BaseModel):
    macro: Source
    yields: Source
    breakeven: Source


class FactorSummary(BaseModel):
    current: float
    d1m: Optional[float]
    d3m: Optional[float]
    d12m: Optional[float]
    zscore: float


class DailyFactors(BaseModel):
    dates: list[str]
    factors: dict[str, list[float]]
    smoothed: bool = True


class DashboardFactors(DailyFactors):
    summary: dict[str, FactorSummary]


class YieldPCA(BaseModel):
    dates: list[str]
    pc_scores: dict[str, list[float]]
    loadings: dict[str, list[float]]
    explained_var: dict[str, float]
    tenor_names: list[str]


class RegressionStats(BaseModel):
    beta: list[float]
    tstat: list[float]
    r2: float
    adj_r2: float


class PCRegressions(BaseModel):
    factor_names: list[str]
    pc1: RegressionStats
    pc2: RegressionStats


class FittedRegression(RegressionStats):
    fitted: list[float]


class DashboardRegressions(BaseModel):
    factor_names: list[str]
    pc1: FittedRegression
    pc2: FittedRegression


class FairValue(BaseModel):
    dates: list[str]
    actual: list[float]
    pca_fitted: list[float]
    macro_fair_value: list[float]
    rich_cheap_bps: list[float]


class CurveFVRow(BaseModel):
    label: str
    is_spread: bool
    current: float
    fair_value: float
    resid_bp: float
    std_bp: float
    zscore: float


class DashboardFairValue(FairValue):
    curve_table: list[CurveFVRow]


class CurveLookback(BaseModel):
    horizon: str
    bull_steep: int
    bull_flat: int
    bear_steep: int
    bear_flat: int
    dispersion: float


class CurveRegimes(BaseModel):
    name: str
    dates: list[str]
    bull_steep: list[int]
    bull_flat: list[int]
    bear_steep: list[int]
    bear_flat: list[int]
    dispersion: list[float]
    dispersion_avg: float
    lookbacks: list[CurveLookback]


class BreakevenLookback(BaseModel):
    horizon: str
    expansion: int
    slowdown: int
    stagflation: int
    goldilocks: int
    dispersion: float


class Breakeven(BaseModel):
    source: Source
    dates: list[str]
    breakeven: list[float]
    regime_dates: list[str]
    expansion: list[int]
    slowdown: list[int]
    stagflation: list[int]
    goldilocks: list[int]
    dispersion: list[float]
    dispersion_avg: float
    lookbacks: list[BreakevenLookback]


class ScenarioProbs(BaseModel):
    hard_landing: int
    soft_landing: int
    no_landing: int
    reacceleration: int


class ScenarioSeries(BaseModel):
    hard_landing: list[int]
    soft_landing: list[int]
    no_landing: list[int]
    reacceleration: list[int]


class CurrentScenarios(BaseModel):
    curve: ScenarioProbs
    breakeven: ScenarioProbs


class Scenarios(BaseModel):
    current: CurrentScenarios
    dates: list[str]
    curve: ScenarioSeries
    breakeven: ScenarioSeries


class Indicator(BaseModel):
    id: str
    name: str
    units: str
    factor: str
    zscores: list[Optional[float]]
    latest: Optional[float]
    last_obs: Optional[str]


class IndicatorGroup(BaseModel):
    name: str
    indicators: list[Indicator]


class Indicators(BaseModel):
    months: list[str]
    raw_values: bool
    groups: list[IndicatorGroup]


class HeatmapDashboard(BaseModel):
    region: str
    display_name: str
    bond_name: str
    tenors: list[str]
    period: Period
    data_source: DataSources
    factors: DashboardFactors
    yield_pca: YieldPCA
    regressions: DashboardRegressions
    fair_value: DashboardFairValue
    curve_regimes: list[CurveRegimes]
    breakeven: Breakeven
    scenarios: Scenarios
    indicators: Indicators
