"""Response models for /api/tools/quant-macro/labour (see labour_nowcast.py)."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel

F = Optional[float]


class LabourLatest(BaseModel):
    month: str
    underlying: F
    lo: F
    hi: F
    previous_month: str
    previous: F
    three_months_ago: F
    boe_report: Optional[str]
    boe_text: Optional[str]
    boe_value: F


class LabourPoint(BaseModel):
    month: str
    kind: Literal["estimate", "projection", "pandemic"]
    underlying: F
    lo: F
    hi: F
    lfs: F
    payrolls: F


class LabourContribution(BaseModel):
    month: str
    constant: F
    total: F
    contributions: dict[str, Optional[float]]


class LabourIndicator(BaseModel):
    id: str
    name: str
    short: str
    group: str
    source: str
    units: str
    transform: str
    notes: str
    in_model: bool
    missing: Optional[str]
    latest_month: Optional[str]
    latest: F
    latest_transformed: F
    z: F
    loading: F
    contribution: F
    first_month: Optional[str]


class LabourLfsNext(BaseModel):
    period: str
    release: Optional[str]
    forecast: F
    sd: F
    lo: F
    hi: F
    latest_period: str
    latest: F
    noise_sd: F
    noise_sd_2000_19: F


class LabourBoeProjection(BaseModel):
    report: str
    value: float


class LabourUnemployment(BaseModel):
    period: str
    month: str
    projection: F
    lo: F
    hi: F
    employment_growth: F
    boe: Optional[LabourBoeProjection]


class LabourUnemploymentLatest(BaseModel):
    period: str
    value: F


class LabourPayrollNext(BaseModel):
    period: str
    change_k: F
    lo_k: F
    hi_k: F
    growth3: F
    latest_period: str
    latest_change_k: F
    latest_growth3: F


class LabourNextPrints(BaseModel):
    lfs_employment: LabourLfsNext
    unemployment: list[LabourUnemployment]
    unemployment_latest: LabourUnemploymentLatest
    labour_force_growth: F
    payrolls: Optional[LabourPayrollNext]


class LabourGdpRow(BaseModel):
    quarter: str
    implied: F
    underlying: F


class LabourGdpImplied(BaseModel):
    r2: float
    lags: int
    sample: str
    latest_gdp_quarter: str
    rows: list[LabourGdpRow]


class LabourSvarRow(BaseModel):
    month: str
    employment: float
    baseline: float
    demand: float
    supply: float


class LabourSvar(BaseModel):
    ok: bool
    lags: int
    accepted: int
    sample: str
    impact: dict[str, list[float]]
    rows: list[LabourSvarRow]


class LabourStaffProjection(BaseModel):
    period: str
    value: float
    text: str


class LabourStaffReport(BaseModel):
    report: str
    data_through: Optional[str]
    underlying_text: str
    underlying_value: F
    unemployment: list[LabourStaffProjection]
    url: str


class LabourSource(BaseModel):
    name: str
    file: Optional[str]
    latest: Optional[str]
    release: Optional[str]
    next_release: Optional[str]
    error: Optional[str]


class LabourModel(BaseModel):
    fitted_at: str
    data_through: str
    n_indicators: int
    ids: list[str]
    phi: list[Optional[float]]
    q: F
    a: F
    b: F
    r2: F
    resid_sd: F
    scale_window: list[str]
    exclude: list[list[str]]
    missing: int


class LabourNews(BaseModel):
    month: str
    previous_computed_at: Optional[str]
    previous: F
    current: F
    change: F
    by_indicator: dict[str, Optional[float]]
    same_model: bool
    new_month: Optional[str]


class LabourRun(BaseModel):
    computed_at: str
    month: str
    underlying: F
    fitted_at: str


class LabourNowcast(BaseModel):
    slug: str
    title: str
    country: str
    as_of: str
    computed_at: str
    data_source: str
    latest: LabourLatest
    series: list[LabourPoint]
    contributions: list[LabourContribution]
    indicators: list[LabourIndicator]
    next_prints: LabourNextPrints
    gdp_implied: Optional[LabourGdpImplied]
    svar: Optional[LabourSvar]
    staff: list[LabourStaffReport]
    staff_method: str
    sources: dict[str, LabourSource]
    model: LabourModel
    news: Optional[LabourNews] = None
    runs: list[LabourRun] = []


class LabourJob(BaseModel):
    kind: str
    state: Literal["idle", "running", "done", "error"]
    step: Optional[str]
    started_at: Optional[str]
    finished_at: Optional[str]
    error: Optional[str]


class LabourJobs(BaseModel):
    update: LabourJob
    refit: LabourJob


class LabourStatus(BaseModel):
    slug: str
    computed_at: Optional[str]
    as_of: Optional[str]
    model_fitted_at: Optional[str]
    model_data_through: Optional[str]
    jobs: LabourJobs
