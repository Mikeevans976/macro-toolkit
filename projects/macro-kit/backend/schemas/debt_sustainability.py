"""Response models for /api/tools/quant-macro/dsa (see debt_sustainability.py)."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel

F = Optional[float]


class DsaSources(BaseModel):
    pusf_release: Optional[str]
    pusf_next_release: Optional[str]
    pusf_latest_month: str
    pusf_editions: list[str]
    obr_edition: str
    obr_source: Optional[str]
    obr_cutoff: str
    curves_cutoff: str
    curves_latest: str
    register_source: Literal["dmo", "reconstructed"]
    register_note: str
    register_upload: Optional[dict]


class DsaAttribution(BaseModel):
    time: F
    bank_rate: F
    gilts: F
    inflation: F


class DsaHistoryPoint(BaseModel):
    date: str
    value: F


class DsaRule(BaseModel):
    id: str
    name: str
    measure: str
    description: str
    unit: str
    obr_bn: F
    market_bn: F
    change_bn: F
    obr_pp: F
    market_pp: F
    attribution: DsaAttribution
    probability: F
    history: list[DsaHistoryPoint]


class DsaProjectionRow(BaseModel):
    year: str
    kind: Literal["outturn", "forecast", "extension"]
    psnfl_pct: F
    psnd_pct: F
    psnb_pct: F
    cbd_bn: F
    interest_bn: F
    interest_receipts: F
    obr_psnfl_pct: F
    obr_psnd_pct: F
    obr_psnb_pct: F
    obr_cbd_bn: F
    obr_interest_bn: F


class DsaFanRow(BaseModel):
    year: str
    p5: F
    p10: F
    p25: F
    p50: F
    p75: F
    p90: F
    p95: F


class DsaFan(BaseModel):
    psnfl_pct: list[DsaFanRow]
    psnd_pct: list[DsaFanRow]
    psnb_pct: list[DsaFanRow]
    interest_receipts: list[DsaFanRow]


class DsaProbabilities(BaseModel):
    stability: F
    investment: F
    both: F
    debt_falling_end: F
    debt_above_100: F
    end_year: str
    from_year: str


class DsaDynamicsRow(BaseModel):
    year: str
    debt: F
    change: F
    growth: F
    interest: F
    primary: F
    other: F
    effective_rate: F
    nominal_growth: F
    r_minus_g: F
    stabilising_primary: F


class DsaDynamics(BaseModel):
    history: list[DsaDynamicsRow]
    obr: list[DsaDynamicsRow]
    market: list[DsaDynamicsRow]


class DsaInterestRow(BaseModel):
    year: str
    kind: Literal["forecast", "extension"]
    obr: F
    market: F
    change: F
    conventional: F
    index_linked: F
    floating: F
    apf_offset: F
    model_total: F
    model_obr_curves: F
    effective_rate: F
    sens_rates_100: F
    sens_bank_rate_100: F
    sens_gilts_100: F
    sens_rpi_100: F


class DsaInterestHistory(BaseModel):
    year: str
    interest: F
    uplift: F
    apf: F


class DsaReckoner(BaseModel):
    rates_1pp_bn: F
    rpi_1pp_bn: F
    year: Optional[str]


class DsaInterest(BaseModel):
    rows: list[DsaInterestRow]
    history: list[DsaInterestHistory]
    obr_reckoner: DsaReckoner


class DsaMaturity(BaseModel):
    year: str
    conventional: F
    index_linked: F


class DsaGross(BaseModel):
    year: str
    redemptions: F
    net_need: F
    gross: F
    gross_pct: F


class DsaFinancing(BaseModel):
    profile: list[DsaMaturity]
    gross: list[DsaGross]
    gilts_bn: F
    linker_share: F
    avg_maturity_conventional: F
    avg_maturity_linkers: F
    bills_bn: F
    nsandi_bn: F
    reserves_bn: F
    apf_bn: F
    apf_share: F
    floating_share: F
    repricing_1y_bn: F
    debt_bn: F
    as_of: str


class DsaScenarioPoint(BaseModel):
    year: str
    psnfl_pct: F
    psnd_pct: F
    psnb_pct: F
    interest_bn: F


class DsaScenario(BaseModel):
    id: str
    name: str
    description: str
    stability_bn: F
    investment_pp: F
    psnd_end: F
    interest_end: F
    paths: list[DsaScenarioPoint]


class DsaTrackerMonth(BaseModel):
    month: str
    current: F
    previous: F
    obr_profile: F


class DsaTracker(BaseModel):
    year: str
    months_observed: int
    latest_month: str
    ytd_bn: F
    ytd_previous_bn: F
    ytd_obr_profile_bn: F
    obr_full_year_bn: F
    implied_full_year_bn: F
    previous_full_year_bn: F
    typical_share: F
    next_release: Optional[str]
    next_month: str
    next_month_forecast_bn: F
    months: list[DsaTrackerMonth]


class DsaGauge(BaseModel):
    id: str
    label: str
    unit: str
    latest: F
    obr_window: F
    year_ago: F


class DsaMarketPoint(BaseModel):
    date: str
    gilt_10y: F
    gilt_30y: F
    gilt_ois_10y: F


class DsaCurvePoint(BaseModel):
    maturity: float
    latest: F
    obr_window: F
    ois_latest: F


class DsaMarket(BaseModel):
    gauges: list[DsaGauge]
    series: list[DsaMarketPoint]
    curve: list[DsaCurvePoint]


class DsaModel(BaseModel):
    var: dict
    bohn: dict
    paths: int
    cyclical: dict
    issuance_mix: dict
    apf: dict
    rules_note: str
    extension_note: str


class DebtSustainability(BaseModel):
    slug: str
    title: str
    country: str
    as_of: str
    computed_at: str
    target_year: str
    sources: DsaSources
    rules: list[DsaRule]
    projection: list[DsaProjectionRow]
    fan: DsaFan
    probabilities: DsaProbabilities
    dynamics: DsaDynamics
    interest: DsaInterest
    financing: DsaFinancing
    scenarios: list[DsaScenario]
    tracker: DsaTracker
    market: DsaMarket
    model: DsaModel


class DsaJob(BaseModel):
    kind: str
    state: Literal["idle", "running", "done", "error"]
    step: Optional[str]
    started_at: Optional[str]
    finished_at: Optional[str]
    error: Optional[str]


class DsaStatus(BaseModel):
    slug: str
    computed_at: Optional[str]
    as_of: Optional[str]
    job: DsaJob


class DsaUpload(BaseModel):
    kind: Literal["obr", "dmo"]
    detail: str
    status: DsaStatus
