"""Response models for /api/tools/macro-options (see macro_options.py)."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel

Source = Literal["bloomberg", "simulation"]


class OptionQuote(BaseModel):
    strike: float
    type: Literal["C", "P"]
    price: float                       # premium, price points
    iv: Optional[float]                # normal vol, price units / yr; None when not invertible
    source: Literal["mid", "settle"]


class ExpiryChain(BaseModel):
    id: str                            # option month, "2026-11"
    code: str                          # "ERX6"
    kind: Literal["standard", "serial"]
    expiry: str                        # London wall-clock, ISO minutes
    T: float                           # years from the snapshot
    F: float
    atm_vol: float
    grid_lo: float                     # call grid: strikes grid_lo + i * grid_h
    grid_h: float
    calls: list[float]
    quotes: list[OptionQuote]          # OTM quotes, ascending strike
    n_fit: int
    fit_rmse_ticks: float
    flags: list[str]


class ContractRow(BaseModel):
    id: str                            # "ERZ6"
    ticker: str
    year: int
    month: int
    F: float
    ltd: str
    expiries: list[ExpiryChain]


class Meeting(BaseModel):
    decision: str
    effective: str
    estimated: bool


class PathMeeting(Meeting):
    rate: float                        # expected DFR after the meeting, %
    exp_bp: float                      # expected move at the meeting
    cumulative_bp: float


class OisPoint(BaseModel):
    tenor: float
    rate: float


class Rates(BaseModel):
    dfr: Optional[float]
    estr: Optional[float]
    ois: list[OisPoint]


class MacroOptionsSnapshot(BaseModel):
    data_source: Source
    live: bool
    as_of: Optional[str]
    note: Optional[str]
    contracts: list[ContractRow]
    meetings: list[Meeting]
    ois_path: list[PathMeeting]
    rates: Optional[Rates]


class OpenInterest(BaseModel):
    data_source: Source
    note: Optional[str]
    contract: str
    expiry: str
    dates: list[str]
    strikes: list[float]
    calls: list[list[int]]             # [day][strike], lots
    puts: list[list[int]]
    F: list[float]
