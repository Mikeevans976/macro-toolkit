"""
Fitted Bond Curves — rich/cheap analysis via cross-sectional regression.

Implements Chapter 8 of Huggins & Schaller, "Fixed Income Relative Value
Analysis" (2024):

    P_i = A(Θ_i; α) + B(Ψ_i; γ) + ε_i

  - A(Θ_i; α)  : Σ_l C_il · φ(τ_il) — cash flows discounted with a fitted
                 discount function φ(τ) = exp(−h(τ)·τ)
  - h(τ)       : zero-coupon yield curve, parameterised either as a natural
                 cubic spline on knot points (H&S box, p.175) or as
                 exponential splines df(t) = Σ β_j e^{−jtα}
  - B(Ψ_i; γ)  : external conditioning variables — issue size, age, and
                 deliverability (scaled by BPV so coefficients read as bp)
  - ε_i        : the rich/cheap indicator (positive = rich)

Joint optimisation of curve parameters AND regression coefficients at the
same time (H&S p.171), minimising Σ_i w_i |ε_i|^p with p ∈ {1, 2}
(H&S recommend trying p = 1 to stop outliers dominating).

Residual time series per bond are analysed with the Ornstein–Uhlenbeck
machinery of Chapter 2 (half-life, z-score, ex-ante Sharpe) rather than
naked Z-scores, per H&S §"Z-Scores and T-Stats" (p.177-178).

Data layer: synthetic German bond universe (Bunds / OBLs / Schatze) with
known pricing effects, so the optimiser can be validated by recovering the
true coefficients.  Replace `build_universe` + `price_universe` with a live
(Bloomberg) loader when available — downstream analytics are source-agnostic.

Entry points
------------
  compute_fitted_curve(functional_form, exponent, weighting, n_exp_splines)
  get_bond_detail(bond_id, ...)
"""

from __future__ import annotations

import re
import zlib
from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from scipy.interpolate import CubicSpline
from scipy.optimize import brentq, minimize

from mean_reversion import estimate_ou, transition_densities, _add_horizon_dates

# ── Constants ──────────────────────────────────────────────────────────────────

AS_OF = pd.Timestamp.today().normalize()

# Cubic-spline knots (years) — H&S p.174 example, trimmed to universe span
CUBIC_KNOTS = [0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 5.0, 7.0, 10.0, 15.0, 20.0, 30.0, 33.0]

# Futures baskets (time-to-maturity windows, years) for deliverability flags
DELIV_WINDOWS = {
    'Schatz': (1.75, 2.25),
    'Bobl':   (4.5, 5.5),
    'Bund':   (8.5, 10.5),
    'Buxl':   (24.0, 35.0),
}

# True pricing effects used by the synthetic data generator
TRUE_COEFFS = {
    'size':   0.025,   # EUR per EUR 1bn outstanding (benchmark effect)
    'age':    -0.027,  # EUR per year of age (bonds cheapen with age)
    'Schatz': 3.5,     # bp of richness for the deliverable issues
    'Bobl':   2.8,
    'Bund':   2.2,
    'Buxl':   2.4,
}
NOISE_STD_EUR = 0.06   # idiosyncratic mispricing, EUR per 100 nominal

EXTERNAL_VARS = ['size', 'age', 'Schatz', 'Bobl', 'Bund', 'Buxl']


# ── Bond universe ──────────────────────────────────────────────────────────────

@dataclass
class Bond:
    bond_id: str
    name: str
    sector: str            # BKO | OBL | DBR
    coupon: float          # % annual
    maturity: pd.Timestamp
    issue_date: pd.Timestamp
    size_bn: float         # amount outstanding, EUR bn
    ttm: float = 0.0       # years to maturity
    age: float = 0.0       # years since issuance
    deliverable: str = ''  # '' | Schatz | Bobl | Bund | Buxl
    cf_times: np.ndarray = field(default_factory=lambda: np.array([]))
    cf_amounts: np.ndarray = field(default_factory=lambda: np.array([]))
    accrued: float = 0.0
    dirty: float = 0.0     # observed dirty price (synthetic)
    residual_path: np.ndarray = field(default_factory=lambda: np.array([]))


def _true_zero_curve(tau: np.ndarray | float) -> np.ndarray | float:
    """'True' zero curve used by the generator — Nelson-Siegel-ish shape."""
    tau = np.asarray(tau, dtype=float)
    lam = 1.8
    x = np.maximum(tau, 1e-9) / lam
    slope_term = (1 - np.exp(-x)) / x
    curv_term = slope_term - np.exp(-x)
    y = 0.031 - 0.011 * slope_term + 0.009 * curv_term  # decimal
    return y


def _cashflows(coupon: float, maturity: pd.Timestamp,
               as_of: pd.Timestamp = AS_OF) -> tuple[np.ndarray, np.ndarray, float]:
    """Annual coupon schedule (German convention). Returns (times, amounts, accrued)."""
    dates = []
    d = maturity
    while d > as_of:
        dates.append(d)
        d = d - pd.DateOffset(years=1)
    dates = sorted(dates)
    times = np.array([(dt - as_of).days / 365.25 for dt in dates])
    amounts = np.full(len(dates), coupon)
    amounts[-1] += 100.0
    # Accrued: fraction of the current coupon period elapsed
    prev_coupon = dates[0] - pd.DateOffset(years=1)
    frac = (as_of - prev_coupon).days / (dates[0] - prev_coupon).days
    return times, amounts, coupon * frac


def build_universe(seed: int = 7, as_of: pd.Timestamp = AS_OF) -> list[Bond]:
    """
    Synthetic Bund/OBL/Schatz universe (~45 bonds, ttm 1y–33y).

    Identification notes for the external variables:
    - Original tenors alternate within maturity buckets (e.g. an 8y-ttm bond
      may be a recent 10y or an old 15y), so age is not collinear with ttm.
    - Only some bonds inside each futures window are flagged deliverable, so
      deliverability is not collinear with the local curve level.
    """
    rng = np.random.default_rng(seed)
    bonds: list[Bond] = []

    def add(sector: str, orig_tenors: list[float], ttm_grid: list[float]):
        for j, ttm in enumerate(ttm_grid):
            orig_tenor = orig_tenors[j % len(orig_tenors)]
            if orig_tenor < ttm:
                orig_tenor = max(orig_tenors)
            maturity = as_of + pd.DateOffset(days=int(ttm * 365.25))
            issue = maturity - pd.DateOffset(days=int(orig_tenor * 365.25))
            age = (as_of - issue).days / 365.25
            if age < 0:
                continue
            # Coupon ≈ true par yield at issuance ± idiosyncratic rounding
            y_issue = float(_true_zero_curve(orig_tenor)) + rng.normal(0.004, 0.008)
            coupon = max(0.0, round(y_issue * 100 * 4) / 4)
            size = float(np.clip(rng.normal(20, 5), 5, 33))
            n = len(bonds)
            bond = Bond(
                bond_id=f'{sector}{n:03d}',
                name=f'{sector} {coupon:.2f}% {maturity.strftime("%b-%y")}',
                sector=sector, coupon=coupon, maturity=maturity,
                issue_date=issue, size_bn=size, ttm=ttm, age=age,
            )
            bond.cf_times, bond.cf_amounts, bond.accrued = _cashflows(coupon, maturity, as_of)
            bonds.append(bond)

    add('BKO', [2.0], [round(1.0 + 0.15 * i, 3) for i in range(9)])            # 1.0–2.2y
    add('OBL', [5.0, 5.0, 10.0], [round(2.3 + 0.4 * i, 3) for i in range(8)])  # 2.3–5.1y
    add('DBR', [10.0, 15.0], [round(5.5 + 0.35 * i, 3) for i in range(15)])    # 5.5–10.4y
    add('DBR', [30.0, 15.0, 30.0], [11.5, 13.0, 15.0, 17.5, 20.0, 22.5, 24.5,
                                    26.5, 28.5, 30.5, 32.0, 33.0])             # long end

    # Deliverability: flag only the issues nearest the window centre, leaving
    # non-deliverable neighbours inside the window for identification.
    _flag_deliverables(bonds)
    return bonds


def _flag_deliverables(bonds: list[Bond]) -> None:
    """Flag the issues nearest each futures window centre as deliverable."""
    n_flag = {'Schatz': 2, 'Bobl': 2, 'Bund': 3, 'Buxl': 3}
    for fut, (lo, hi) in DELIV_WINDOWS.items():
        centre = (lo + hi) / 2
        in_window = sorted((b for b in bonds if lo <= b.ttm <= hi),
                           key=lambda b: abs(b.ttm - centre))
        for b in in_window[:n_flag[fut]]:
            b.deliverable = fut


# ── Custom bond universe from Bloomberg tickers ────────────────────────────────

_TICKER_RE = re.compile(
    r'^\s*([A-Za-z]{2,10})\s+'                 # issuer prefix, e.g. DBR / OBL / BKO / OAT / BTPS
    r'(\d+(?:\.\d+)?)(?:\s+(\d+)/(\d+))?\s+'   # coupon, optional fraction e.g. "0 1/2"
    r'(\d{1,2})/(\d{1,2})/(\d{2,4})'           # maturity MM/DD/YY(YY)
    r'(?:\s+(?:Govt|Corp))?\s*$',              # optional yellow key
    re.IGNORECASE,
)

_STD_TENORS = [2.0, 5.0, 7.0, 10.0, 15.0, 20.0, 30.0, 50.0]


def parse_bond_ticker(ticker: str) -> tuple[str, float, pd.Timestamp]:
    """
    Parse a Bloomberg govt ticker like "DBR 2.6 08/15/34 Govt" or
    "BKO 0 1/2 09/16/27" into (sector, coupon %, maturity).
    """
    m = _TICKER_RE.match(ticker)
    if not m:
        raise ValueError(
            f'Cannot parse bond ticker {ticker!r} — expected format like '
            f'"DBR 2.6 08/15/34 Govt"'
        )
    sector = m.group(1).upper()
    coupon = float(m.group(2))
    if m.group(3):
        coupon += float(m.group(3)) / float(m.group(4))
    month, day, year = int(m.group(5)), int(m.group(6)), int(m.group(7))
    if year < 100:
        year += 2000 if year < 70 else 1900
    maturity = pd.Timestamp(year=year, month=month, day=day)
    return sector, coupon, maturity


def build_universe_custom(tickers: list[str],
                          as_of: pd.Timestamp = AS_OF) -> list[Bond]:
    """
    Build a universe from user-supplied Bloomberg tickers.  Coupon and maturity
    come from the ticker; reference data not encoded in the ticker (issue date,
    amount outstanding) is simulated deterministically per ticker until a live
    (Bloomberg) reference-data loader replaces this.
    """
    if len(tickers) < 5:
        raise ValueError(
            f'Need at least 5 bonds to fit a curve, got {len(tickers)}.'
        )
    bonds: list[Bond] = []
    seen: set[str] = set()
    for i, ticker in enumerate(tickers):
        if ticker in seen:
            continue
        seen.add(ticker)
        sector, coupon, maturity = parse_bond_ticker(ticker)
        if maturity <= as_of:
            raise ValueError(f'Bond {ticker!r} already matured on {maturity.date()} (as of {as_of.date()})')
        ttm = (maturity - as_of).days / 365.25
        rng = np.random.default_rng(zlib.crc32(ticker.encode()))
        candidates = [t for t in _STD_TENORS if t >= ttm - 0.05] or [_STD_TENORS[-1]]
        orig_tenor = float(candidates[int(rng.integers(0, min(2, len(candidates))))])
        issue = maturity - pd.DateOffset(days=int(orig_tenor * 365.25))
        age = max((as_of - issue).days / 365.25, 0.0)
        size = float(np.clip(rng.normal(20, 5), 5, 33))
        bond = Bond(
            bond_id=f'C{i:03d}',
            name=ticker.strip(),
            sector=sector, coupon=coupon, maturity=maturity,
            issue_date=issue, size_bn=size, ttm=round(ttm, 3), age=age,
        )
        bond.cf_times, bond.cf_amounts, bond.accrued = _cashflows(coupon, maturity, as_of)
        bonds.append(bond)
    bonds.sort(key=lambda b: b.ttm)
    _flag_deliverables(bonds)
    return bonds


def _knots_for(bonds: list[Bond]) -> list[float]:
    """
    Adapt the cubic-spline knots to the universe: trim to the maturity span and
    thin interior knots so the curve never has more parameters than roughly
    half the number of bonds (avoids overfitting small custom universes).
    """
    max_ttm = max(b.ttm for b in bonds)
    knots = [k for k in CUBIC_KNOTS if k <= max_ttm + 2.0]
    if not knots or knots[-1] < max_ttm:
        knots = knots + [round(max_ttm + 0.5, 2)]
    max_knots = max(4, len(bonds) // 2)
    while len(knots) > max_knots:
        knots = [knots[0]] + knots[1:-1:2] + [knots[-1]]
    return knots


def _bpv(bond: Bond, dirty: float) -> float:
    """EUR price change per 1bp yield move (from cash flow PV weighted times)."""
    y = _ytm(bond, dirty)
    disc = (1 + y) ** (-bond.cf_times)
    dur = float(np.sum(bond.cf_times * bond.cf_amounts * disc)) / (1 + y)
    return dur * 1e-4


def _ytm(bond: Bond, dirty: float) -> float:
    """Annual-compounding yield to maturity from a dirty price."""
    def f(y):
        return float(np.sum(bond.cf_amounts * (1 + y) ** (-bond.cf_times))) - dirty
    try:
        return brentq(f, -0.05, 0.30, xtol=1e-10)
    except ValueError:
        return 0.0


def price_universe(bonds: list[Bond], seed: int = 11) -> None:
    """
    Generate observed dirty prices = true curve PV + external effects + noise,
    and a 3-year daily residual history per bond (OU paths ending at today's
    residual) for the time-series mean-reversion analysis.
    """
    rng = np.random.default_rng(seed)
    n_hist = 756

    for bond in bonds:
        zc = np.asarray(_true_zero_curve(bond.cf_times))
        pv = float(np.sum(bond.cf_amounts * np.exp(-zc * bond.cf_times)))
        bpv0 = _bpv(bond, pv)

        effect = (
            TRUE_COEFFS['size'] * bond.size_bn
            + TRUE_COEFFS['age'] * bond.age
            + (TRUE_COEFFS[bond.deliverable] * bpv0 if bond.deliverable else 0.0)
        )
        noise = rng.normal(0, NOISE_STD_EUR)
        bond.dirty = pv + effect + noise

        # Residual history: OU path with per-bond half-life 10–60 bdays,
        # pinned to end at today's noise (the current residual).
        k = np.log(2) / rng.uniform(10, 60) * 252          # annualised speed
        sig = NOISE_STD_EUR * np.sqrt(2 * k)               # stationary std = noise std
        dt = 1 / 252
        exp_k = np.exp(-k * dt)
        std_step = sig * np.sqrt((1 - np.exp(-2 * k * dt)) / (2 * k))
        path = np.empty(n_hist)
        path[0] = rng.normal(0, NOISE_STD_EUR)
        eps = rng.standard_normal(n_hist)
        for t in range(1, n_hist):
            path[t] = path[t - 1] * exp_k + std_step * eps[t]
        path += np.linspace(0, noise - path[-1], n_hist)   # pin endpoint
        bond.residual_path = path


# ── Discount-curve functional forms ────────────────────────────────────────────

def _h_cubic(knot_yields: np.ndarray, tau: np.ndarray, knots: list[float]) -> np.ndarray:
    """Natural cubic spline through (knots, knot_yields), h(τ) in decimal."""
    cs = CubicSpline(knots, knot_yields, bc_type='natural')
    return cs(np.clip(tau, knots[0], knots[-1]))


def _df_from_params(params: np.ndarray, tau: np.ndarray,
                    functional_form: str, n_exp: int,
                    knots: list[float] = CUBIC_KNOTS) -> np.ndarray:
    """Discount factors at times tau for the given curve parameterisation."""
    tau = np.asarray(tau, dtype=float)
    if functional_form == 'cubic_spline':
        h = _h_cubic(params, tau, knots)
        return np.exp(-h * tau)
    # Exponential splines: df(t) = Σ_j β_j e^{−j·t·α}, α > 0 via exp-param
    alpha = np.exp(params[0])
    betas = params[1:1 + n_exp]
    j = np.arange(1, n_exp + 1)
    return np.sum(betas[None, :] * np.exp(-np.outer(tau, j) * alpha), axis=1)


def _zero_curve_from_params(params: np.ndarray, tau: np.ndarray,
                            functional_form: str, n_exp: int,
                            knots: list[float] = CUBIC_KNOTS) -> np.ndarray:
    """Zero yield h(τ) (decimal) implied by the fitted parameters."""
    tau = np.asarray(tau, dtype=float)
    if functional_form == 'cubic_spline':
        return _h_cubic(params, tau, knots)
    df = _df_from_params(params, tau, functional_form, n_exp)
    df = np.clip(df, 1e-8, None)
    return -np.log(df) / np.maximum(tau, 1e-9)


# ── Joint optimisation ─────────────────────────────────────────────────────────

def _external_matrix(bonds: list[Bond], bpvs: np.ndarray,
                     ext_vars: list[str] = EXTERNAL_VARS) -> np.ndarray:
    """
    Design matrix for the selected external variables (deliverability scaled
    by BPV).  Column order follows ext_vars.
    """
    X = np.zeros((len(bonds), len(ext_vars)))
    for j, var in enumerate(ext_vars):
        for i, b in enumerate(bonds):
            if var == 'size':
                X[i, j] = b.size_bn
            elif var == 'age':
                X[i, j] = b.age
            elif b.deliverable == var:      # Schatz | Bobl | Bund | Buxl
                X[i, j] = bpvs[i]
    return X


def fit_curve(
    bonds: list[Bond],
    functional_form: str = 'cubic_spline',
    exponent: int = 2,
    weighting: str = 'none',
    n_exp: int = 7,
    user_knots: list[float] | None = None,
    ext_vars: list[str] = EXTERNAL_VARS,
) -> dict:
    """
    Joint optimisation of curve parameters and regression coefficients γ,
    minimising Σ_i w_i |Σ_l C_il·df(τ_il) + Σ_k γ_k·X_ik − DirtyPrice_i|^p.

    user_knots overrides the automatic knot placement for the cubic spline
    (H&S p.174: knot choice is an analyst decision — e.g. widen the spacing
    with maturity since first-derivative changes concentrate at the front end).
    ext_vars selects which external conditioning variables enter the
    regression; effects not included end up in the residuals.
    """
    prices = np.array([b.dirty for b in bonds])
    bpvs = np.array([_bpv(b, b.dirty) for b in bonds])
    X = _external_matrix(bonds, bpvs, ext_vars)
    n_ext = X.shape[1]

    weights = 1.0 / bpvs if weighting == 'bpv' else np.ones(len(bonds))
    weights = weights / weights.mean()

    # Initial curve guess: interpolate bond YTMs onto the knots
    ytms = np.array([_ytm(b, b.dirty) for b in bonds])
    ttms = np.array([b.ttm for b in bonds])
    order = np.argsort(ttms)
    if user_knots is not None and functional_form == 'cubic_spline':
        knots = sorted(set(round(float(k), 4) for k in user_knots))
        if len(knots) < 4:
            raise ValueError(
                f'Need at least 4 knot points for a cubic spline, got {len(knots)}.'
            )
        if knots[0] < 0:
            raise ValueError('Knot points must be non-negative.')
        n_ext_active = int((np.abs(X).sum(axis=0) > 0).sum())
        if len(knots) + n_ext_active >= len(bonds):
            raise ValueError(
                f'{len(knots)} knots + {n_ext_active} regression variables ≥ '
                f'{len(bonds)} bonds — the fit would be underdetermined. '
                'Remove knots or add bonds.'
            )
    else:
        knots = _knots_for(bonds)
    if functional_form == 'cubic_spline':
        knot_init = np.interp(knots, ttms[order], ytms[order])
        curve_init = knot_init
        n_curve = len(knots)
    else:
        # α init ~ 0.05; β init from lstsq on discount factors implied by YTMs
        alpha0 = 0.05
        df_target = np.exp(-np.interp(ttms, ttms[order], ytms[order]) * ttms)
        j = np.arange(1, n_exp + 1)
        E = np.exp(-np.outer(ttms, j) * alpha0)
        beta0, *_ = np.linalg.lstsq(E, df_target, rcond=None)
        curve_init = np.concatenate([[np.log(alpha0)], beta0])
        n_curve = 1 + n_exp

    # Stack all cash flows so each objective evaluation builds the discount
    # curve exactly once (H&S p.175 stress numerical speed for exactly this
    # reason — the curve is re-evaluated at every optimisation step).
    all_times = np.concatenate([b.cf_times for b in bonds])
    all_amounts = np.concatenate([b.cf_amounts for b in bonds])
    splits = np.cumsum([len(b.cf_times) for b in bonds])[:-1]

    def _pv(curve_p: np.ndarray) -> np.ndarray:
        df = _df_from_params(curve_p, all_times, functional_form, n_exp, knots)
        return np.array([s.sum() for s in np.split(all_amounts * df, splits)])

    def _solve_gamma(y: np.ndarray) -> np.ndarray:
        """
        Profile out the (linear) regression coefficients: given curve-implied
        PVs, solve min_γ Σ w_i |y_i − X_i·γ|^p.  Exact WLS for p = 2; IRLS
        approximation of the L1 solution for p = 1.  This sidesteps the vast
        scale differences between curve and γ parameters while still fitting
        both "at the same time and in the same optimization" (H&S p.171).
        """
        gamma = np.zeros(X.shape[1])
        if X.shape[1] == 0:          # pure curve fit, no external regression
            return gamma
        w = weights.copy()
        n_irls = 1 if exponent == 2 else 6
        for _ in range(n_irls):
            sw = np.sqrt(w)
            gamma, *_ = np.linalg.lstsq(X * sw[:, None], y * sw, rcond=None)
            if exponent == 1:
                w = weights / np.maximum(np.abs(y - X @ gamma), 1e-4)
        return gamma

    def objective(curve_p: np.ndarray) -> float:
        y = prices - _pv(curve_p)
        resid = y - X @ _solve_gamma(y)
        return float(np.sum(weights * np.abs(resid) ** exponent))

    if exponent == 1:
        res = minimize(objective, curve_init, method='Powell',
                       options={'maxiter': 20000, 'xtol': 1e-8, 'ftol': 1e-10})
    else:
        res = minimize(objective, curve_init, method='L-BFGS-B',
                       options={'maxiter': 20000, 'ftol': 1e-14, 'gtol': 1e-10})

    curve_p = res.x
    gamma = _solve_gamma(prices - _pv(curve_p))
    fitted = _pv(curve_p) + X @ gamma
    residuals = prices - fitted            # positive = rich

    return {
        'curve_params': curve_p,
        'gamma': gamma,
        'fitted': fitted,
        'residuals': residuals,
        'bpvs': bpvs,
        'ytms': ytms,
        'converged': bool(res.success),
        'n_iter': int(res.get('nit', 0)),
        'objective': float(res.fun),
        'knots': knots,
        'ext_vars': list(ext_vars),
    }


# ── Smoothness ─────────────────────────────────────────────────────────────────

def curve_smoothness(curve_p: np.ndarray, functional_form: str, n_exp: int,
                     knots: list[float], max_ttm: float) -> float:
    """
    Smoothness functional ∫ h″(τ)² dτ over the fitted range (H&S p.174 —
    "maximum smoothness, defined as the integral of the square of the second
    derivative of the function"; lower = smoother).  h is measured in percent,
    τ in years, so units are %²/yr³.
    """
    lo, hi = 0.25, max(max_ttm, 1.0)
    tau = np.arange(lo, hi + 1e-9, 0.02)
    h = np.asarray(_zero_curve_from_params(curve_p, tau, functional_form,
                                           n_exp, knots)) * 100.0   # in %
    d2 = np.gradient(np.gradient(h, tau), tau)
    return float(np.trapezoid(d2 ** 2, tau))


# ── Notional par benchmarks ────────────────────────────────────────────────────

def par_benchmarks(curve_p: np.ndarray, functional_form: str, n_exp: int,
                   knots: list[float] = CUBIC_KNOTS,
                   max_tenor: float = 30.0) -> list[dict]:
    """
    Notional par coupon at standard tenors: C = 100·(1 − Z_T) / A_T
    where Z_T is the fitted T-year discount factor and A_T the fitted annuity
    (H&S p.180-181, 'Creating Generic Notional Benchmarks').
    """
    out = []
    for T in [2, 3, 5, 7, 10, 15, 20, 30]:
        if T > max_tenor + 2:
            continue
        times = np.arange(1, T + 1, dtype=float)
        dfs = _df_from_params(curve_p, times, functional_form, n_exp, knots)
        Z, A = float(dfs[-1]), float(np.sum(dfs))
        C = 100.0 * (1.0 - Z) / A
        out.append({'tenor': T, 'discount_factor': round(Z, 6),
                    'annuity': round(A, 6), 'par_coupon': round(C, 4)})
    return out


# ── API entry points ───────────────────────────────────────────────────────────

_CACHE: dict[tuple, tuple[list[Bond], dict]] = {}


def _parse_custom_bonds(custom_bonds: str) -> list[str]:
    """Split a comma/newline-separated ticker list into clean entries."""
    return [t.strip() for t in re.split(r'[,\n]+', custom_bonds) if t.strip()]


def _parse_knots(knots: str) -> list[float] | None:
    """Parse a comma-separated knot list; empty string → automatic placement."""
    vals = [v.strip() for v in knots.split(',') if v.strip()]
    if not vals:
        return None
    try:
        return [float(v) for v in vals]
    except ValueError:
        raise ValueError(f'Knot points must be numeric, got {knots!r}') from None


def _parse_ext_vars(external_vars: str) -> list[str]:
    """
    Parse the external-variable selection; empty string → all variables.
    Preserves the canonical EXTERNAL_VARS order regardless of input order.
    """
    if not external_vars.strip():
        return list(EXTERNAL_VARS)
    requested = {v.strip() for v in external_vars.split(',') if v.strip()}
    unknown = requested - set(EXTERNAL_VARS) - {'none'}
    if unknown:
        raise ValueError(
            f'Unknown external variable(s): {sorted(unknown)} — '
            f'valid options: {EXTERNAL_VARS}'
        )
    return [v for v in EXTERNAL_VARS if v in requested]


def _parse_as_of(as_of: str) -> pd.Timestamp:
    """Parse the as-of date; empty string → today."""
    if not as_of.strip():
        return AS_OF
    try:
        return pd.Timestamp(as_of).normalize()
    except ValueError:
        raise ValueError(f'Cannot parse as-of date {as_of!r} — use YYYY-MM-DD') from None


def _get_fit(functional_form: str, exponent: int, weighting: str,
             n_exp_splines: int, custom_bonds: str = '',
             knots: str = '', external_vars: str = '',
             as_of: str = '') -> tuple[list[Bond], dict]:
    """Build + price + fit, cached per configuration (data is deterministic)."""
    tickers = tuple(_parse_custom_bonds(custom_bonds))
    user_knots = _parse_knots(knots)
    ext_vars = _parse_ext_vars(external_vars)
    ts = _parse_as_of(as_of)
    key = (functional_form, exponent, weighting, n_exp_splines, tickers,
           tuple(user_knots) if user_knots else None, tuple(ext_vars), ts)
    if key not in _CACHE:
        bonds = (build_universe_custom(list(tickers), ts) if tickers
                 else build_universe(as_of=ts))
        # Seed the pricing noise by date so each as-of date has its own
        # rich/cheap pattern (deterministic per date until live data).
        price_universe(bonds, seed=11 + (zlib.crc32(ts.strftime('%Y%m%d').encode()) % 100_000))
        fit = fit_curve(bonds, functional_form, exponent, weighting,
                        n_exp_splines, user_knots, ext_vars)
        if len(_CACHE) > 8:     # keep at most a handful of configs in memory
            _CACHE.clear()
        _CACHE[key] = (bonds, fit)
    return _CACHE[key]


def compute_fitted_curve(
    functional_form: str = 'cubic_spline',
    exponent: int = 2,
    weighting: str = 'none',
    n_exp_splines: int = 7,
    custom_bonds: str = '',
    knots: str = '',
    external_vars: str = '',
    as_of: str = '',
) -> dict:
    """Full Chapter-8 analysis consumed by the FittedBondCurves frontend page."""
    if functional_form not in ('cubic_spline', 'exponential_splines'):
        raise ValueError(f'Unknown functional form: {functional_form}')
    exponent = 1 if int(exponent) == 1 else 2

    ts = _parse_as_of(as_of)
    bonds, fit = _get_fit(functional_form, exponent, weighting, n_exp_splines,
                          custom_bonds, knots, external_vars, as_of)

    curve_p = fit['curve_params']
    residuals = fit['residuals']
    resid_bp = residuals / fit['bpvs']

    # Per-bond OU analysis of residual history (Ch. 2 applied per Ch. 8 p.178)
    dates = pd.bdate_range(end=ts, periods=len(bonds[0].residual_path))
    bond_rows = []
    for i, b in enumerate(bonds):
        hist = pd.Series(b.residual_path, index=dates)
        # Shift history so it ends exactly at today's fitted residual
        hist = hist + (residuals[i] - hist.iloc[-1])
        ou = estimate_ou(hist)
        # Ex-ante 2-week Sharpe of the convergence trade (H&S p.178)
        tau = 10 / 252
        exp_ret = abs(ou['mu'] - residuals[i]) * (1 - np.exp(-ou['k'] * tau))
        cs = ou['sigma'] * np.sqrt((1 - np.exp(-2 * ou['k'] * tau)) / (2 * ou['k']))
        sharpe_2w = float(exp_ret / cs * np.sqrt(252 / 10)) if cs > 1e-12 else 0.0

        # Trailing averages of the residual, in bp (21 / 63 business days)
        bpv_i = float(fit['bpvs'][i])
        avg_1m_bp = float(hist.iloc[-21:].mean() / bpv_i)
        avg_3m_bp = float(hist.iloc[-63:].mean() / bpv_i)

        fitted_ytm = _ytm(b, float(fit['fitted'][i]))
        bond_rows.append({
            'bond_id': b.bond_id,
            'name': b.name,
            'sector': b.sector,
            'coupon': b.coupon,
            'maturity': b.maturity.strftime('%Y-%m-%d'),
            'ttm': round(b.ttm, 2),
            'age': round(b.age, 2),
            'size_bn': round(b.size_bn, 1),
            'deliverable': b.deliverable or None,
            'dirty_price': round(b.dirty, 4),
            'clean_price': round(b.dirty - b.accrued, 4),
            'fitted_price': round(float(fit['fitted'][i]), 4),
            'residual_eur': round(float(residuals[i]), 4),
            'residual_bp': round(float(resid_bp[i]), 2),
            'avg_resid_1m_bp': round(avg_1m_bp, 2),
            'avg_resid_3m_bp': round(avg_3m_bp, 2),
            'ytm': round(float(fit['ytms'][i]) * 100, 4),
            'fitted_ytm': round(fitted_ytm * 100, 4),
            'bpv': round(float(fit['bpvs'][i]), 5),
            'ou_half_life': round(ou['half_life_days'], 1),
            'ou_zscore': round(ou['current_zscore'], 2),
            'sharpe_2w': round(sharpe_2w, 2),
        })

    # Fitted zero curve + discount factors for charting
    max_ttm = max(b.ttm for b in bonds)
    tau_grid = np.round(np.arange(0.25, max_ttm + 0.26, 0.25), 2)
    zero = _zero_curve_from_params(curve_p, tau_grid, functional_form,
                                   n_exp_splines, fit['knots'])
    dfs = _df_from_params(curve_p, tau_grid, functional_form,
                          n_exp_splines, fit['knots'])

    # Coefficients table: estimated vs the generator's true values,
    # only for the variables included in this fit
    gamma = fit['gamma']
    coef_meta = {
        'size':   ('Amount outstanding (EUR bn)', 'EUR/bn'),
        'age':    ('Issue age (years)', 'EUR/yr'),
        'Schatz': ('Schatz deliverable', 'bp'),
        'Bobl':   ('Bobl deliverable', 'bp'),
        'Bund':   ('Bund deliverable', 'bp'),
        'Buxl':   ('Buxl deliverable', 'bp'),
    }
    coefficients = [
        {'variable': v, 'label': coef_meta[v][0], 'units': coef_meta[v][1],
         'estimate': round(float(g), 4), 'true_value': TRUE_COEFFS[v]}
        for v, g in zip(fit['ext_vars'], gamma)
    ]

    abs_eur = np.abs(residuals)
    abs_bp = np.abs(resid_bp)
    return {
        'as_of': ts.strftime('%Y-%m-%d'),
        'simulation_mode': True,
        'config': {
            'functional_form': functional_form,
            'exponent': exponent,
            'weighting': weighting,
            'n_exp_splines': n_exp_splines,
            'knots': fit['knots'] if functional_form == 'cubic_spline' else None,
            'knots_source': ('manual' if _parse_knots(knots) else 'auto'),
            'custom_bonds': _parse_custom_bonds(custom_bonds) or None,
            'external_vars': fit['ext_vars'],
        },
        'fit_quality': {
            'converged': fit['converged'],
            'n_iter': fit['n_iter'],
            'mean_abs_eur': round(float(abs_eur.mean()), 4),
            'max_abs_eur': round(float(abs_eur.max()), 4),
            'mean_abs_bp': round(float(abs_bp.mean()), 2),
            'max_abs_bp': round(float(abs_bp.max()), 2),
            'n_bonds': len(bonds),
            'smoothness': round(curve_smoothness(
                curve_p, functional_form, n_exp_splines, fit['knots'], max_ttm), 4),
        },
        'curve': {
            'tau': tau_grid.tolist(),
            'zero_yield': [round(float(z) * 100, 4) for z in zero],
            'discount_factor': [round(float(d), 6) for d in dfs],
        },
        'coefficients': coefficients,
        'bonds': bond_rows,
        'benchmarks': par_benchmarks(curve_p, functional_form, n_exp_splines,
                                     fit['knots'], max_tenor=max_ttm),
    }


def predict_new_issue(
    maturity: str,
    coupon: float | None = None,
    size_bn: float = 20.0,
    extra_bp: float = 0.0,
    functional_form: str = 'cubic_spline',
    exponent: int = 2,
    weighting: str = 'none',
    n_exp_splines: int = 7,
    custom_bonds: str = '',
    knots: str = '',
    external_vars: str = '',
    as_of: str = '',
) -> dict:
    """
    Predict the pricing of a bond that doesn't exist yet (H&S p.180,
    'Predicting New Issue Pricing').

    maturity  : ISO date "YYYY-MM-DD" or a tenor in years (e.g. "10")
    coupon    : % — if None, the fitted par coupon for that maturity is used
                (the typical choice for forecasting an unannounced issue)
    size_bn   : expected issue size, EUR bn (feeds the size coefficient)
    extra_bp  : analyst's anticipatory richness/cheapness on top of the
                systematic effects (+ = rich), in basis points

    Predicted price = curve PV + γ̂·X_new + extra_bp × BPV, using the SAME
    fitted curve and coefficients as the main fit (age = 0 for a new issue;
    deliverability auto-detected from the futures windows).
    """
    exponent = 1 if int(exponent) == 1 else 2
    ts = _parse_as_of(as_of)
    bonds, fit = _get_fit(functional_form, exponent, weighting, n_exp_splines,
                          custom_bonds, knots, external_vars, as_of)

    # Parse maturity: tenor in years or explicit date
    try:
        ttm = float(maturity)
        mat_date = ts + pd.DateOffset(days=int(ttm * 365.25))
    except ValueError:
        mat_date = pd.Timestamp(maturity)
        if mat_date <= ts:
            raise ValueError(f'Maturity {maturity!r} is on or before the as-of date.')
        ttm = (mat_date - ts).days / 365.25
    max_ttm = max(b.ttm for b in bonds)
    if ttm > max_ttm + 2:
        raise ValueError(
            f'Maturity {ttm:.1f}y is beyond the fitted range ({max_ttm:.1f}y) — '
            'extrapolation that far is unreliable (H&S recommend exponential '
            'splines and caution even then).'
        )

    def _df(t):
        return _df_from_params(fit['curve_params'], np.atleast_1d(t),
                               functional_form, n_exp_splines, fit['knots'])

    # Coupon: user's forecast, or the fitted par coupon C = 100(1 − Z)/A
    par_times = np.arange(1, int(np.floor(ttm)) + 1, dtype=float)
    par_times = par_times if len(par_times) else np.array([ttm])
    dfs_par = _df(par_times)
    par_coupon = float(100.0 * (1.0 - dfs_par[-1]) / dfs_par.sum())
    coupon_used = float(coupon) if coupon is not None else round(par_coupon, 2)

    # Build the notional bond and price it off the fitted curve
    nb = Bond(bond_id='NEW', name=f'NEW {coupon_used:.2f}% {mat_date.strftime("%b-%y")}',
              sector='NEW', coupon=coupon_used, maturity=mat_date,
              issue_date=ts, size_bn=size_bn, ttm=round(ttm, 3), age=0.0)
    nb.cf_times, nb.cf_amounts, nb.accrued = _cashflows(coupon_used, mat_date, ts)
    curve_pv = float(np.sum(nb.cf_amounts * _df(nb.cf_times)))
    bpv = _bpv(nb, curve_pv)

    # Deliverability from the futures windows
    deliverable = next((fut for fut, (lo, hi) in DELIV_WINDOWS.items()
                        if lo <= ttm <= hi), None)

    # External effects with the FITTED coefficients (only those in this fit)
    gamma = {v: float(g) for v, g in zip(fit['ext_vars'], fit['gamma'])}
    effects = []
    if 'size' in gamma:
        eur = gamma['size'] * size_bn
        effects.append({'label': f'Issue size ({size_bn:g}bn × γ_size)',
                        'eur': round(eur, 4), 'bp': round(eur / bpv, 2)})
    if 'age' in gamma:
        effects.append({'label': 'Issue age (0y — new issue)', 'eur': 0.0, 'bp': 0.0})
    if deliverable and deliverable in gamma:
        eur = gamma[deliverable] * bpv
        effects.append({'label': f'{deliverable} deliverable (γ × BPV)',
                        'eur': round(eur, 4), 'bp': round(gamma[deliverable], 2)})
    extra_eur = extra_bp * bpv
    if abs(extra_bp) > 1e-9:
        effects.append({'label': f'Anticipatory richness ({extra_bp:+g} bp)',
                        'eur': round(extra_eur, 4), 'bp': round(extra_bp, 2)})

    predicted = curve_pv + sum(e['eur'] for e in effects) + 0.0
    ytm_curve = _ytm(nb, curve_pv)
    ytm_pred = _ytm(nb, predicted)

    # Nearest existing bonds for context
    nearest = sorted(range(len(bonds)), key=lambda i: abs(bonds[i].ttm - ttm))[:3]
    neighbours = [{
        'name': bonds[i].name,
        'ttm': round(bonds[i].ttm, 2),
        'ytm': round(float(fit['ytms'][i]) * 100, 3),
        'residual_bp': round(float(fit['residuals'][i] / fit['bpvs'][i]), 2),
    } for i in nearest]

    return {
        'name': nb.name,
        'maturity': mat_date.strftime('%Y-%m-%d'),
        'ttm': round(ttm, 2),
        'coupon': round(coupon_used, 4),
        'coupon_is_par': coupon is None,
        'par_coupon': round(par_coupon, 4),
        'size_bn': size_bn,
        'deliverable': deliverable,
        'curve_pv': round(curve_pv, 4),
        'effects': effects,
        'predicted_price': round(predicted, 4),
        'predicted_ytm': round(ytm_pred * 100, 4),
        'curve_ytm': round(ytm_curve * 100, 4),
        'spread_to_curve_bp': round((predicted - curve_pv) / bpv, 2),
        'bpv': round(bpv, 5),
        'neighbours': neighbours,
    }


def get_bond_detail(
    bond_id: str,
    functional_form: str = 'cubic_spline',
    exponent: int = 2,
    weighting: str = 'none',
    n_exp_splines: int = 7,
    custom_bonds: str = '',
    knots: str = '',
    external_vars: str = '',
    as_of: str = '',
) -> dict:
    """Residual history + OU analysis + forward fan chart for a single bond."""
    exponent = 1 if int(exponent) == 1 else 2
    ts = _parse_as_of(as_of)
    bonds, fit = _get_fit(functional_form, exponent, weighting, n_exp_splines,
                          custom_bonds, knots, external_vars, as_of)

    idx = next((i for i, b in enumerate(bonds) if b.bond_id == bond_id), None)
    if idx is None:
        raise ValueError(f'Unknown bond_id: {bond_id}')
    b = bonds[idx]
    residual = float(fit['residuals'][idx])
    bpv = float(fit['bpvs'][idx])

    # Rich/cheap history in BASIS POINTS (ε_t / BPV): bp removes the
    # mechanical EUR-residual decay as the bond rolls down the curve (BPV
    # shrinks with maturity), making the series comparable through time and
    # across bonds — the right space for the OU mean-reversion analysis.
    dates = pd.bdate_range(end=ts, periods=len(b.residual_path))
    hist = pd.Series(b.residual_path, index=dates)
    hist = (hist + (residual - hist.iloc[-1])) / bpv
    ou = estimate_ou(hist)

    td = transition_densities(ou, n_days=126)
    _add_horizon_dates(td, dates[-1])

    return {
        'bond_id': b.bond_id,
        'name': b.name,
        'units': 'bp',
        'residual_eur': round(residual, 4),
        'residual_bp': round(residual / bpv, 2),
        'history': {
            'dates': dates.strftime('%Y-%m-%d').tolist(),
            'values': [round(float(v), 3) for v in hist],
        },
        'ou_params': {k: (round(v, 6) if isinstance(v, float) else v)
                      for k, v in ou.items()},
        'transition_densities': td,
    }
