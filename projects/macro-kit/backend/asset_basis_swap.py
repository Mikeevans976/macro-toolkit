"""
Asset-swap and cross-currency basis-swap engine.

Implements Huggins & Schaller, "Fixed Income Relative Value Analysis" (2024),
Ch 16-17: converting any government bond into a floater (or a synthetic
fixed-coupon bond) in any currency, so that bonds of different issuers can be
compared on one yardstick.

  1. Par asset swap in the home currency. The investor pays the dirty price,
     swaps the bond's fixed flows for RFR + s on 100 nominal, and pays or
     receives the up-front 100 − dirty so the package costs par:
         s = (PV_swap(bond flows) − dirty) / (100 · A_float)
     A richening bond has a lower (more negative) ASW.
  2. Cross-currency basis swap into the target currency on the same notional.
     The CCBS is quoted on the non-USD leg against SOFR flat
     (RFR_X + b_X vs SOFR), so going via USD:
         s_USD = (s_X + ICBS_X − b_X) · A_X / A_USD
         s_Y   = s_USD · A_USD / A_Y + b_Y
     With CF = A_USD / A_X = BPV_USD / BPV_local this is the book's
     USD_ASW = (local ASW − CCBS) / CF (H&S p.275).
  3. Reverse asset swap in the target currency: the RFR_Y + s_Y floater on
     par is worth the same as a par fixed bond paying
         c = par swap rate_Y + s_Y · A_float_Y / A_fixed_Y.

Curves are passed as discount functions `discount(t) -> DF(t)` (t in years),
so the engine runs the same on simulated curves and on live OIS curves.
Schedules are regular periods counted back from maturity with a short first
stub accruing from today; no holiday calendars or spot lags.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

import numpy as np

from bond_math import DiscountFn, price_from_curve, ytm

BP = 1e-4


@dataclass
class Market:
    """One currency's swap market."""
    ccy: str
    rfr: str                                   # e.g. SOFR, ESTR, SONIA, TONA
    discount: DiscountFn                       # RFR OIS discount function
    float_freq: int = 1                        # RFR leg payments per year
    fixed_freq: int = 1                        # fixed leg payments per year
    ccbs_bp: Callable[[float], float] = field(default=lambda T: 0.0)   # b_X(T) vs SOFR; 0 for USD
    icbs_bp: Callable[[float], float] = field(default=lambda T: 0.0)   # bond's ASW leg → RFR leg


# ── Schedules and annuities ────────────────────────────────────────────────────

def leg_times(maturity: float, freq: int) -> np.ndarray:
    """Payment times (years) counted back from maturity in steps of 1/freq."""
    if maturity <= 0:
        return np.array([])
    step = 1.0 / freq
    n = int(np.ceil(maturity / step - 1e-9))
    return np.array([maturity - step * k for k in range(n - 1, -1, -1)])


def annuity(discount: DiscountFn, maturity: float, freq: int) -> float:
    """Σ τ_j · DF(t_j) per unit notional; the first period accrues from today."""
    t = leg_times(maturity, freq)
    tau = np.diff(np.r_[0.0, t])
    return float(np.sum(tau * np.asarray(discount(t), dtype=float)))


def par_swap_rate(discount: DiscountFn, maturity: float, freq: int = 1) -> float:
    """Spot-starting par swap rate (decimal): (1 − DF(T)) / A_fixed."""
    return (1.0 - float(discount(np.array([maturity]))[0])) / annuity(discount, maturity, freq)


# ── Step 1: asset-swap spreads ─────────────────────────────────────────────────

def par_asw(times, amounts, dirty: float, discount: DiscountFn,
            maturity: float, float_freq: int = 1) -> float:
    """Par-par asset-swap spread (bp) over the RFR leg."""
    pv = price_from_curve(times, amounts, discount)
    return (pv - dirty) / (100.0 * annuity(discount, maturity, float_freq)) / BP


def market_value_asw(times, amounts, dirty: float, discount: DiscountFn,
                     maturity: float, float_freq: int = 1) -> float:
    """Proceeds ('full', market-value) ASW (bp): floating leg on the dirty price instead of par."""
    pv = price_from_curve(times, amounts, discount)
    return (pv - dirty) / (dirty * annuity(discount, maturity, float_freq)) / BP


def interpolated_asw(times, amounts, dirty: float, discount: DiscountFn,
                     maturity: float, bond_freq: int = 1, swap_freq: int = 1) -> float:
    """Yield spread (bp): the bond's YTM minus the par swap rate at its maturity.
    Carries the coupon effect, so H&S warn against it as an RV measure. The
    yield is first restated at the swap's compounding frequency."""
    y = ytm(times, amounts, dirty, bond_freq)
    y_swap = swap_freq * ((1.0 + y / bond_freq) ** (bond_freq / swap_freq) - 1.0)
    return (y_swap - par_swap_rate(discount, maturity, swap_freq)) / BP


# ── Step 2: cross-currency conversion ──────────────────────────────────────────

def conversion_factor(home: Market, target: Market, maturity: float) -> float:
    """CF = A_target / A_home: BPV of the target floating leg per BPV of the home one."""
    return annuity(target.discount, maturity, target.float_freq) / annuity(home.discount, maturity, home.float_freq)


def usd_asw(local_asw_bp: float, ccbs_bp: float, cf: float, icbs_bp: float = 0.0) -> float:
    """Book shortcut (H&S p.275): USD ASW = (local ASW + ICBS − CCBS) / CF, CF = BPV_USD / BPV_local."""
    return (local_asw_bp + icbs_bp - ccbs_bp) / cf


def convert_spread(spread_bp: float, home: Market, target: Market, maturity: float) -> float:
    """Spread over the home RFR (on the bond's ASW leg) → spread over the target RFR, via USD."""
    if home.ccy == target.ccy:
        return spread_bp
    adj = spread_bp + home.icbs_bp(maturity) - home.ccbs_bp(maturity)
    return adj / conversion_factor(home, target, maturity) + target.ccbs_bp(maturity)


# ── Step 3: reverse asset swap ─────────────────────────────────────────────────

def synthetic_fixed_coupon(spread_bp: float, target: Market, maturity: float) -> float:
    """Fixed coupon (%) of a par bond in the target currency equivalent to RFR + s on par."""
    a_float = annuity(target.discount, maturity, target.float_freq)
    a_fixed = annuity(target.discount, maturity, target.fixed_freq)
    par = par_swap_rate(target.discount, maturity, target.fixed_freq)
    return (par + spread_bp * BP * a_float / a_fixed) * 100.0


# ── Full pipeline ──────────────────────────────────────────────────────────────

def asset_and_basis_swap(times, amounts, dirty: float, maturity: float,
                         home: Market, target: Market, bond_freq: int = 1) -> dict:
    """All three steps for one bond; every intermediate is returned for display."""
    t = np.asarray(times, dtype=float)
    a = np.asarray(amounts, dtype=float)
    s_home = par_asw(t, a, dirty, home.discount, maturity, home.float_freq)
    s_home_rfr = s_home + home.icbs_bp(maturity)
    cross = home.ccy != target.ccy
    cf = conversion_factor(home, target, maturity) if cross else 1.0
    s_target = convert_spread(s_home, home, target, maturity)
    return {
        'home_ccy': home.ccy,
        'target_ccy': target.ccy,
        'maturity': maturity,
        'dirty': dirty,
        'ytm': ytm(t, a, dirty, bond_freq) * 100.0,
        # step 1
        'upfront': 100.0 - dirty,
        'pv_on_swap_curve': price_from_curve(t, a, home.discount),
        'home_float_annuity': annuity(home.discount, maturity, home.float_freq),
        'home_par_swap_rate': par_swap_rate(home.discount, maturity, home.fixed_freq) * 100.0,
        'par_asw_bp': s_home,
        'market_value_asw_bp': market_value_asw(t, a, dirty, home.discount, maturity, home.float_freq),
        'interpolated_asw_bp': interpolated_asw(t, a, dirty, home.discount, maturity, bond_freq, home.fixed_freq),
        # step 2
        'home_icbs_bp': home.icbs_bp(maturity),
        'home_ccbs_bp': home.ccbs_bp(maturity) if cross else 0.0,
        'target_ccbs_bp': target.ccbs_bp(maturity) if cross else 0.0,
        'home_rfr_spread_bp': s_home_rfr,
        'conversion_factor': cf,
        'target_float_annuity': annuity(target.discount, maturity, target.float_freq),
        'target_spread_bp': s_target,
        # step 3
        'target_fixed_annuity': annuity(target.discount, maturity, target.fixed_freq),
        'target_par_swap_rate': par_swap_rate(target.discount, maturity, target.fixed_freq) * 100.0,
        'synthetic_coupon': synthetic_fixed_coupon(s_target, target, maturity),
    }
