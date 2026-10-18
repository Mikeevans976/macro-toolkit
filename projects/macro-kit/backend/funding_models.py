"""
Funding and credit building blocks for asset-swap fair value.

Implements the small models of Huggins & Schaller, "Fixed Income Relative
Value Analysis" (2024), that the ASW fair-value model (Ch 12) is assembled
from:

  - CDS adjustment (Ch 13): only part of a sovereign CDS spread is priced into
    the bond's ASW. The book's factors are 0.45 (FX component, cash settled)
    and 0.39 (FX + delivery option, physically settled), and every trade
    should be checked under a low / mid / high case (30 / 45 / 60%).
  - Secured–unsecured basis (Ch 11): spread ≈ g · q · d, cost of equity ×
    risk weight × capital ratio (10% × 20% × 8% = 16bp).
  - Repo–term-rate model (Ch 11):
        L = R / (1 − p(1−c)) + p(1−c) / (1 − p(1−c)) + q·d·(g − b) / (1 − p(1−c))
    with repo R, default probability p, recovery c, risk weight q, capital
    ratio d, cost of equity g and b the return earned on the capital itself.
    Inverting it gives the cost of equity implied by the market term rate.
  - Haircut cost (Ch 18): yield drag ≈ haircut × excess funding cost, with the
    central banks' schedules in data/haircut_schedules.json.

All rates are decimals (0.02 = 2%) unless a name ends in _bp or _pct.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

import numpy as np

BP = 1e-4
SETTLEMENT_FACTORS = {'cash': 0.45, 'physical': 0.39}
CDS_SCENARIOS = {'low': 0.30, 'mid': 0.45, 'high': 0.60}

_SCHEDULES = Path(__file__).parent / 'data' / 'haircut_schedules.json'


# ── CDS adjustment ─────────────────────────────────────────────────────────────

def adjusted_cds(cds_bp: float, settlement: str = 'physical') -> dict:
    """The part of a CDS spread that feeds the ASW, centrally and under each scenario."""
    if settlement not in SETTLEMENT_FACTORS:
        raise ValueError(f"settlement must be one of {', '.join(SETTLEMENT_FACTORS)}")
    f = SETTLEMENT_FACTORS[settlement]
    return {
        'cds_bp': cds_bp,
        'settlement': settlement,
        'factor': f,
        'adjusted_bp': cds_bp * f,
        'scenarios': [{'case': k, 'factor': v, 'adjusted_bp': cds_bp * v} for k, v in CDS_SCENARIOS.items()],
    }


# ── Secured–unsecured basis ────────────────────────────────────────────────────

def secured_unsecured_basis_bp(g: float, q: float, d: float) -> float:
    """g · q · d in bp: the capital cost of lending unsecured rather than secured."""
    return g * q * d / BP


# ── Repo–term-rate model ───────────────────────────────────────────────────────

def term_rate(repo: float, pd: float, recovery: float, q: float, d: float, g: float, b: float) -> dict:
    """Fair unsecured term rate L and its three components (decimals)."""
    loss = pd * (1.0 - recovery)
    if not 0.0 <= loss < 1.0:
        raise ValueError("pd · (1 − recovery) must be in [0, 1)")
    den = 1.0 - loss
    funding, credit, capital = repo / den, loss / den, q * d * (g - b) / den
    return {
        'rate': funding + credit + capital,
        'funding': funding,
        'credit': credit,
        'capital': capital,
        'spread_to_repo_bp': (funding + credit + capital - repo) / BP,
    }


def implied_cost_of_equity(market_rate: float, repo: float, pd: float, recovery: float,
                           q: float, d: float, b: float) -> float:
    """The g that makes the model term rate equal the market term rate."""
    if q * d == 0:
        raise ValueError("q · d must be non-zero to imply a cost of equity")
    loss = pd * (1.0 - recovery)
    return b + (market_rate * (1.0 - loss) - repo - loss) / (q * d)


# ── Haircuts ───────────────────────────────────────────────────────────────────

@lru_cache(maxsize=1)
def load_schedules() -> dict:
    return json.loads(_SCHEDULES.read_text(encoding='utf-8'))


def haircut_pct(schedule: str, cls: str, maturity: float, duration: float | None = None,
                zero: bool = False) -> float:
    """
    Haircut (%) from a schedule. ECB and BoE buckets are by residual maturity;
    the Fed's are by duration (falls back to maturity if none is given).
    """
    s = load_schedules()['schedules'][schedule]
    x = duration if (s['basis'] == 'duration' and duration is not None) else maturity
    i = int(np.searchsorted(s['edges'], x, side='right')) - 1
    values = s['classes'][cls]['zero' if zero else 'coupon']
    return float(values[min(max(i, 0), len(values) - 1)])


def haircut_drag_bp(haircut: float, excess_funding_bp: float) -> float:
    """Yield drag ≈ haircut × excess funding cost (H&S Ch 18)."""
    return haircut / 100.0 * excess_funding_bp


def issuer_haircut_class(issuer: str, alternative: bool = False) -> tuple[str | None, str | None]:
    """(schedule, class) for an issuer; `alternative` picks the downgrade case where one exists."""
    meta = load_schedules()['issuers'].get(issuer)
    if not meta or not meta['schedule']:
        return None, None
    cls = meta.get('alternative_class') if alternative and meta.get('alternative_class') else meta['class']
    return meta['schedule'], cls
