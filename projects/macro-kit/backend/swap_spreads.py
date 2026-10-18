"""
Swap Spreads & Basis — asset & basis-swap calculator (H&S Ch 16-17).

Runs every benchmark bond (UST, Bund, OAT, BTP, Gilt, JGB) through
asset_basis_swap: par ASW against its home RFR, conversion into a floater
over the target currency's RFR via the cross-currency basis, and the
equivalent synthetic fixed coupon in that currency.

Data layer: simulated. RFR OIS zero curves are Nelson-Siegel shapes, CCBS
term structures are hand-set to plausible levels, and bond prices are the
issuer's curve (OIS zero + issuer spread + a small per-bond deviation). Swap
in live OIS / CCBS / bond prices later by replacing `_markets` and
`build_bonds`; the payload carries `data_source` for the page badge.

Entry points
------------
  compute_swap_spreads(target)   bond table + fitted spread curve per issuer
  get_bond_breakdown(bond_id, target)
  get_funding_inputs(...)          CDS adjustment, secured-unsecured basis,
                                   repo-term rate, haircut cost (H&S Ch 11-13, 18)
"""

from __future__ import annotations

import zlib
from dataclasses import dataclass
from typing import Callable

import numpy as np
import pandas as pd

from asset_basis_swap import Market, asset_and_basis_swap, leg_times, par_swap_rate
from bond_math import DiscountFn, curve_bpv, fisher_weil_duration, macaulay_duration
import funding_models as fm

CURVE_TENORS = [1, 2, 3, 5, 7, 10, 15, 20, 30]
BENCHMARK_TENORS = [2, 5, 10, 30]


def _today() -> pd.Timestamp:
    return pd.Timestamp.today().normalize()


def _ns_zero(b0: float, b1: float, b2: float, lam: float):
    """Nelson-Siegel continuously compounded zero curve (decimal)."""
    def z(t):
        x = np.maximum(np.asarray(t, dtype=float), 1e-9) / lam
        slope = (1 - np.exp(-x)) / x
        return b0 + b1 * slope + b2 * (slope - np.exp(-x))
    return z


def _interp_bp(points: dict[float, float]):
    """Linear interpolation in maturity, flat beyond the ends."""
    xs, ys = list(points), list(points.values())
    return lambda T: float(np.interp(T, xs, ys))


# ── Simulated markets ──────────────────────────────────────────────────────────

# ccy: (RFR, float freq, fixed freq, Nelson-Siegel params, CCBS vs SOFR in bp by tenor)
_MARKET_SPEC = {
    'USD': ('SOFR',  1, 1, (0.0405, -0.0045, 0.0000, 2.0), None),
    'EUR': ('ESTR',  1, 1, (0.0265, -0.0065, 0.0030, 2.5), {1: -9, 2: -11, 5: -14, 10: -13, 30: -6}),
    'GBP': ('SONIA', 1, 1, (0.0420, -0.0030, 0.0020, 2.0), {1: -4, 2: -7, 5: -12, 10: -19, 30: -14}),
    'JPY': ('TONA',  1, 1, (0.0170, -0.0115, 0.0010, 3.0), {1: -28, 2: -38, 5: -55, 10: -64.5, 30: -52}),
}


def _markets() -> dict[str, tuple[Market, Callable]]:
    out = {}
    for ccy, (rfr, ffl, ffx, ns, ccbs) in _MARKET_SPEC.items():
        z = _ns_zero(*ns)

        def disc(t, z=z):
            t = np.asarray(t, dtype=float)
            return np.exp(-z(t) * t)
        m = Market(ccy, rfr, disc, float_freq=ffl, fixed_freq=ffx,
                   ccbs_bp=_interp_bp(ccbs) if ccbs else (lambda T: 0.0))
        out[ccy] = (m, z)
    return out


# ── Simulated bond universe ────────────────────────────────────────────────────

# issuer: (ccy, coupon freq, coupon rounding, spread to OIS zero in bp at 2/5/10/30y)
_ISSUERS = {
    'UST':  ('USD', 2, 0.125, {2: 18, 5: 28, 10: 38, 30: 48}),
    'Bund': ('EUR', 1, 0.10,  {2: -4, 5: 2, 10: 9, 30: 14}),
    'OAT':  ('EUR', 1, 0.25,  {2: 18, 5: 38, 10: 62, 30: 78}),
    'BTP':  ('EUR', 2, 0.05,  {2: 42, 5: 82, 10: 118, 30: 142}),
    'Gilt': ('GBP', 2, 0.125, {2: 12, 5: 30, 10: 52, 30: 72}),
    'JGB':  ('JPY', 2, 0.10,  {2: -6, 5: -2, 10: 8, 30: 40}),
}


@dataclass
class SimBond:
    bond_id: str
    issuer: str
    ccy: str
    name: str
    coupon: float           # % per annum
    coupon_freq: int
    maturity: pd.Timestamp
    ttm: float
    times: np.ndarray
    amounts: np.ndarray
    dirty: float
    accrued: float
    discount: DiscountFn    # issuer's own curve, for BPV / duration


def build_bonds(markets: dict, as_of: pd.Timestamp | None = None) -> list[SimBond]:
    as_of = _today() if as_of is None else as_of
    bonds = []
    for issuer, (ccy, freq, rnd, spr_pts) in _ISSUERS.items():
        _, z = markets[ccy]
        spr_x, spr_y = list(spr_pts), list(spr_pts.values())
        for tenor in BENCHMARK_TENORS:
            bond_id = f'{issuer}-{tenor}Y'
            u = zlib.crc32(bond_id.encode()) / 2**32          # deterministic per bond
            months_short = int(u * 9)                           # 0–8 months seasoned
            maturity = as_of + pd.DateOffset(years=tenor) - pd.DateOffset(months=months_short)
            ttm = (maturity - as_of).days / 365.25
            dev_bp = (u - 0.5) * 8.0                            # ±4bp off the issuer curve

            def disc(t, z=z, spr_x=spr_x, spr_y=spr_y, dev_bp=dev_bp):
                t = np.asarray(t, dtype=float)
                s = np.interp(t, spr_x, spr_y) + dev_bp
                return np.exp(-(z(t) + s * 1e-4) * t)

            # Coupon ≈ issuer par yield, rounded to the market's convention
            par = (1 - float(disc(np.array([ttm]))[0])) / float(np.sum(disc(leg_times(ttm, freq)) / freq))
            coupon = max(round(par * 100 / rnd) * rnd, rnd)
            times = leg_times(ttm, freq)
            amounts = np.full(len(times), coupon / freq)
            amounts[-1] += 100.0
            dirty = float(np.sum(amounts * disc(times)))
            accrued = coupon / freq * (1.0 - times[0] * freq)
            bonds.append(SimBond(
                bond_id=bond_id, issuer=issuer, ccy=ccy,
                name=f'{issuer} {coupon:g}% {maturity:%b-%y}',
                coupon=coupon, coupon_freq=freq, maturity=maturity, ttm=ttm,
                times=times, amounts=amounts, dirty=dirty, accrued=accrued, discount=disc,
            ))
    return bonds


# ── Payload ────────────────────────────────────────────────────────────────────

def _market_rows(markets: dict) -> list[dict]:
    rows = []
    for ccy, (m, _) in markets.items():
        rows.append({
            'ccy': ccy,
            'rfr': m.rfr,
            'float_freq': m.float_freq,
            'fixed_freq': m.fixed_freq,
            'par_curve': [{'tenor': T, 'rate': round(par_swap_rate(m.discount, T, m.fixed_freq) * 100, 4)}
                          for T in CURVE_TENORS],
            'ccbs': [{'tenor': T, 'bp': round(m.ccbs_bp(T), 2)} for T in CURVE_TENORS],
        })
    return rows


def _check_target(target: str, markets: dict) -> str:
    target = target.upper()
    if target not in markets:
        raise ValueError(f"Unknown target currency {target!r}; choose from {', '.join(markets)}")
    return target


def _bond_row(b: SimBond, res: dict) -> dict:
    return {
        'bond_id': b.bond_id,
        'issuer': b.issuer,
        'ccy': b.ccy,
        'name': b.name,
        'coupon': b.coupon,
        'coupon_freq': b.coupon_freq,
        'maturity': b.maturity.strftime('%Y-%m-%d'),
        'ttm': round(b.ttm, 4),
        'dirty': round(b.dirty, 4),
        'clean': round(b.dirty - b.accrued, 4),
        'ytm': round(res['ytm'], 4),
        'par_asw_bp': round(res['par_asw_bp'], 2),
        'market_value_asw_bp': round(res['market_value_asw_bp'], 2),
        'interpolated_asw_bp': round(res['interpolated_asw_bp'], 2),
        'conversion_factor': round(res['conversion_factor'], 4),
        'target_spread_bp': round(res['target_spread_bp'], 2),
        'synthetic_coupon': round(res['synthetic_coupon'], 4),
        'fw_duration': round(fisher_weil_duration(b.times, b.amounts, b.discount), 3),
        'bpv': round(curve_bpv(b.times, b.amounts, b.discount), 5),
    }


def issuer_curves(rows: list[dict], n_points: int = 30) -> list[dict]:
    """
    Smooth line per issuer through its bonds' target-currency spreads
    (H&S Fig 16.1): least squares on s = a + b·ln T + c·(ln T)², drawn
    between the issuer's shortest and longest bond.
    """
    out = []
    for issuer in dict.fromkeys(r['issuer'] for r in rows):
        pts = [r for r in rows if r['issuer'] == issuer]
        x = np.log([r['ttm'] for r in pts])
        y = np.array([r['target_spread_bp'] for r in pts])
        deg = min(2, len(pts) - 1)
        coef = np.polyfit(x, y, deg)
        grid = np.exp(np.linspace(x.min(), x.max(), n_points))
        out.append({
            'issuer': issuer,
            'ccy': pts[0]['ccy'],
            'points': [{'tenor': round(float(T), 4), 'bp': round(float(np.polyval(coef, np.log(T))), 2)}
                       for T in grid],
        })
    return out


def _run(b: SimBond, markets: dict, target: str) -> dict:
    return asset_and_basis_swap(b.times, b.amounts, b.dirty, b.ttm,
                                markets[b.ccy][0], markets[target][0], bond_freq=b.coupon_freq)


def compute_swap_spreads(target: str = 'USD') -> dict:
    markets = _markets()
    target = _check_target(target, markets)
    rows = [_bond_row(b, _run(b, markets, target)) for b in build_bonds(markets)]
    return {
        'as_of': _today().strftime('%Y-%m-%d'),
        'data_source': 'simulation',
        'target_ccy': target,
        'target_rfr': markets[target][0].rfr,
        'markets': _market_rows(markets),
        'bonds': rows,
        'issuer_curves': issuer_curves(rows),
    }


def get_bond_breakdown(bond_id: str, target: str = 'USD') -> dict:
    """Every intermediate of the three steps for one bond, plus its cash-flow schedule."""
    markets = _markets()
    target = _check_target(target, markets)
    bond = next((b for b in build_bonds(markets) if b.bond_id == bond_id), None)
    if bond is None:
        raise KeyError(bond_id)
    home = markets[bond.ccy][0]
    res = _run(bond, markets, target)
    dfs = home.discount(bond.times)
    steps = {k: (round(v, 6) if isinstance(v, float) else v) for k, v in res.items()}
    return {
        'as_of': _today().strftime('%Y-%m-%d'),
        'data_source': 'simulation',
        'bond': _bond_row(bond, res),
        'home_rfr': home.rfr,
        'target_ccy': target,
        'target_rfr': markets[target][0].rfr,
        'steps': steps,
        'cashflows': [{'time': round(float(t), 4), 'amount': round(float(a), 6),
                       'df': round(float(d), 6), 'pv': round(float(a * d), 6)}
                      for t, a, d in zip(bond.times, bond.amounts, dfs)],
    }


# ── Fair-value building blocks (CDS, basis, term rate, haircuts) ───────────────

HAIRCUT_GRID = [round(x, 2) for x in np.r_[np.arange(0.5, 10, 0.5), np.arange(10, 40.5, 1.0)]]
_PAR_YIELD_FOR_DURATION = 0.04   # duration of a grid point = a 4% semi-annual par bond's


def _grid_duration(T: float, zero: bool) -> float:
    if zero:
        return T
    t = leg_times(T, 2)
    a = np.full(len(t), _PAR_YIELD_FOR_DURATION * 100 / 2)
    a[-1] += 100.0
    return macaulay_duration(t, a, _PAR_YIELD_FOR_DURATION, freq=2)


def _haircut_block(excess_funding_bp: float, zero: bool, btp_downgrade: bool) -> dict:
    sched = fm.load_schedules()
    curves, bonds = [], []
    for issuer, meta in sched['issuers'].items():
        name, cls = fm.issuer_haircut_class(issuer, alternative=btp_downgrade)
        if name is None:
            continue
        pts = []
        for T in HAIRCUT_GRID:
            h = fm.haircut_pct(name, cls, T, _grid_duration(T, zero), zero)
            pts.append({'tenor': T, 'haircut_pct': h, 'drag_bp': round(fm.haircut_drag_bp(h, excess_funding_bp), 2)})
        curves.append({'issuer': issuer, 'schedule': name, 'haircut_class': cls,
                       'class_label': sched['schedules'][name]['classes'][cls]['label'],
                       'rating_basis': meta['rating_basis'], 'points': pts})
    for b in build_bonds(_markets()):
        name, cls = fm.issuer_haircut_class(b.issuer, alternative=btp_downgrade)
        if name is None:
            continue
        dur = fisher_weil_duration(b.times, b.amounts, b.discount)
        h = fm.haircut_pct(name, cls, b.ttm, dur, zero=False)      # benchmark bonds pay coupons
        bonds.append({'bond_id': b.bond_id, 'issuer': b.issuer, 'name': b.name, 'ttm': round(b.ttm, 4),
                      'duration': round(dur, 3), 'haircut_pct': h,
                      'drag_bp': round(fm.haircut_drag_bp(h, excess_funding_bp), 2)})
    return {
        'excess_funding_bp': excess_funding_bp,
        'zero_coupon': zero,
        'btp_downgrade': btp_downgrade,
        'curves': curves,
        'bonds': bonds,
        'sources': [{'schedule': k, 'name': v['name'], 'source': v['source'], 'url': v['url'],
                     'as_of': v['as_of'], 'basis': v['basis']} for k, v in sched['schedules'].items()],
    }


def get_funding_inputs(
    cds_bp: float = 60.0, settlement: str = 'physical',
    g: float = 0.10, q: float = 0.20, d: float = 0.08, d_new: float = 0.12,
    repo: float = 0.019, pd_: float = 0.0025, recovery: float = 0.40, b: float = 0.019,
    market_term_rate: float = 0.0215,
    excess_funding_bp: float = 600.0, zero: bool = False, btp_downgrade: bool = False,
) -> dict:
    basis = fm.secured_unsecured_basis_bp(g, q, d)
    basis_new = fm.secured_unsecured_basis_bp(g, q, d_new)
    tr = fm.term_rate(repo, pd_, recovery, q, d, g, b)
    cds = fm.adjusted_cds(cds_bp, settlement)
    return {
        'data_source': 'simulation',
        'cds': {**cds, 'adjusted_bp': round(cds['adjusted_bp'], 4),
                'scenarios': [{**sc, 'adjusted_bp': round(sc['adjusted_bp'], 4)} for sc in cds['scenarios']]},
        'secured_unsecured': {'g': g, 'q': q, 'd': d, 'basis_bp': round(basis, 4),
                              'd_new': d_new, 'basis_new_bp': round(basis_new, 4),
                              'change_bp': round(basis_new - basis, 4)},
        'term_rate': {
            'inputs': {'repo': repo, 'pd': pd_, 'recovery': recovery, 'q': q, 'd': d, 'g': g, 'b': b},
            'model': {k: round(v * 100, 6) if k != 'spread_to_repo_bp' else round(v, 4) for k, v in tr.items()},
            'market_rate_pct': round(market_term_rate * 100, 6),
            'market_spread_to_repo_bp': round((market_term_rate - repo) / 1e-4, 4),
            'implied_g_pct': round(fm.implied_cost_of_equity(market_term_rate, repo, pd_, recovery, q, d, b) * 100, 4)
            if q * d else None,
        },
        'haircuts': _haircut_block(excess_funding_bp, zero, btp_downgrade),
    }
