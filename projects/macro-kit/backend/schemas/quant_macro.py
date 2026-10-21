"""Response models for /api/tools/quant-macro (see quant_macro.py, nowcast.py)."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel

Source = Literal["live", "simulation"]
Status = Literal["released", "backcast", "nowcast", "forecast"]


class NowcastModelSummary(BaseModel):
    slug: str
    title: str
    country: str
    target_label: str


class NowcastMonth(BaseModel):
    month: str
    actual: Optional[float]
    model: Optional[float]
    sd: Optional[float]


class NowcastQuarter(BaseModel):
    quarter: str
    status: Status
    actual: Optional[float]
    nowcast: Optional[float]
    sd: Optional[float]
    lo68: Optional[float]
    hi68: Optional[float]
    lo90: Optional[float]
    hi90: Optional[float]
    bridge: Optional[float]
    consensus: Optional[float]
    release_date: Optional[str]
    months_observed: int
    months: list[NowcastMonth]


class NowcastPathPoint(BaseModel):
    month: str
    actual: Optional[float]
    model: Optional[float]
    lo68: Optional[float]
    hi68: Optional[float]
    lo90: Optional[float]
    hi90: Optional[float]


class NowcastNextQuarter(BaseModel):
    quarter: str
    model: Optional[float]
    sd: Optional[float]
    lo68: Optional[float]
    hi68: Optional[float]
    lo90: Optional[float]
    hi90: Optional[float]
    consensus: Optional[float]


class NowcastNextPrint(BaseModel):
    series_id: str
    label: str
    period: str
    release_date: Optional[str]
    model: Optional[float]
    sd: Optional[float]
    lo68: Optional[float]
    hi68: Optional[float]
    lo90: Optional[float]
    hi90: Optional[float]
    consensus: Optional[float]
    quarter: Optional[NowcastNextQuarter]


class NowcastRelease(BaseModel):
    series_id: str                     # catalogue id, or "older_revisions" (revisions to earlier periods, grouped)
    kind: Literal["release", "revision"]
    period: str
    observed: Optional[float]
    expected: Optional[float]
    news: Optional[float]
    impacts: dict[str, Optional[float]]


class NowcastStep(BaseModel):
    date: str
    nowcasts: dict[str, Optional[float]]
    sds: dict[str, Optional[float]]
    by_group: dict[str, dict[str, Optional[float]]]
    releases: list[NowcastRelease]


class NowcastIndicator(BaseModel):
    id: str
    name: str
    short: str
    group: str
    units: str
    ticker: str
    transform: str
    vintages: str                      # how this series' first prints and revisions are tracked
    global_loading: Optional[float]
    last_period: Optional[str]
    last_value: Optional[float]
    last_release: Optional[str]
    last_expected: Optional[float]
    last_news: Optional[float]
    last_impacts: dict[str, Optional[float]]
    next_period: Optional[str]
    next_release: Optional[str]
    next_expected: Optional[float]
    next_sd: Optional[float]
    consensus: Optional[float]
    weights: dict[str, Optional[float]]
    typical_surprise: Optional[float]
    typical_impacts: dict[str, Optional[float]]


class NowcastModelInfo(BaseModel):
    name: str
    n_series: int
    blocks: list[str]
    factor_orders: dict[str, int]
    sample_start: str
    last_data: str
    excluded: list[str]
    loglik: Optional[float]
    em_iterations: int
    fitted_at: Optional[str]
    fit_data_as_of: Optional[str]


class NowcastBridge(BaseModel):
    series_id: str
    alpha: Optional[float]
    beta: Optional[float]
    r2: Optional[float]
    resid_sd: Optional[float]
    n: int


class NowcastCbEstimate(BaseModel):
    published: str
    source: str
    quarter: str
    value: float
    url: Optional[str]
    note: Optional[str]
    actual: Optional[float]


class NowcastCbComparison(BaseModel):
    quarter: str
    cb_value: float
    cb_published: str
    cb_source: str
    model_now: Optional[float]
    model_at_publication: Optional[float]
    news_since: Optional[float]
    gap: Optional[float]


class NowcastCentralBank(BaseModel):
    institution: str
    label: str
    estimates: list[NowcastCbEstimate]
    comparisons: list[NowcastCbComparison]


class Nowcast(BaseModel):
    slug: str
    title: str
    country: str
    target_label: str
    as_of: str
    computed_at: str
    data_source: Source
    missing_series: list[str]
    model: NowcastModelInfo
    bridge: Optional[NowcastBridge]
    quarters: list[NowcastQuarter]
    monthly_path: list[NowcastPathPoint]
    next_print: NowcastNextPrint
    evolution: list[NowcastStep]
    indicators: list[NowcastIndicator]
    central_bank: Optional[NowcastCentralBank]


class NowcastBacktestStats(BaseModel):
    rmse: Optional[float]              # vs the first estimate
    bias: Optional[float]
    n: int
    rmse_latest: Optional[float]       # vs today's value


class NowcastBacktestSummary(BaseModel):
    horizon: int
    dfm: NowcastBacktestStats
    bridge: NowcastBacktestStats
    naive: NowcastBacktestStats


class NowcastBacktestRow(BaseModel):
    quarter: str
    release_date: Optional[str]
    actual: Optional[float]            # first estimate
    actual_latest: Optional[float]
    dfm: list[Optional[float]]
    bridge: list[Optional[float]]
    naive: list[Optional[float]]


class NowcastBacktest(BaseModel):
    slug: str
    as_of: str
    run_at: str
    duration_s: float
    data_source: Source
    horizons: list[int]
    n_fits: int
    first_estimate_revision_rmse: Optional[float]
    rows: list[NowcastBacktestRow]
    summary: list[NowcastBacktestSummary]
    note: str


class NowcastJob(BaseModel):
    kind: Literal["update", "refit", "backtest"]
    state: Literal["idle", "running", "done", "error"]
    step: Optional[str]
    progress: int
    total: int
    started_at: Optional[str]
    finished_at: Optional[str]
    error: Optional[str]


class NowcastJobs(BaseModel):
    update: NowcastJob
    refit: NowcastJob
    backtest: NowcastJob


class NowcastStatus(BaseModel):
    slug: str
    model_fitted_at: Optional[str]
    model_data_as_of: Optional[str]
    nowcast_as_of: Optional[str]
    nowcast_computed_at: Optional[str]
    backtest_run_at: Optional[str]
    jobs: NowcastJobs
