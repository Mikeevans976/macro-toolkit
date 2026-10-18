"""
Unit tests for asset_basis_swap: the book's worked examples (H&S Ch 16-17)
and identities that must hold by construction.
"""
import numpy as np
import pytest

from asset_basis_swap import (
    Market,
    annuity,
    asset_and_basis_swap,
    conversion_factor,
    convert_spread,
    interpolated_asw,
    leg_times,
    market_value_asw,
    par_asw,
    par_swap_rate,
    synthetic_fixed_coupon,
    usd_asw,
)
from bond_math import price_from_curve


def _flat(r: float):
    return lambda t: np.exp(-r * np.asarray(t, dtype=float))


def _bond(coupon: float, maturity: float, freq: int = 1):
    t = leg_times(maturity, freq)
    a = np.full(len(t), coupon / freq)
    a[-1] += 100.0
    return t, a


USD = Market('USD', 'SOFR', _flat(0.040), float_freq=1, fixed_freq=1)
GBP = Market('GBP', 'SONIA', _flat(0.042), float_freq=1, fixed_freq=1, ccbs_bp=lambda T: -19.0)
JPY = Market('JPY', 'TONA', _flat(0.008), float_freq=1, fixed_freq=1,
             ccbs_bp=lambda T: -64.5, icbs_bp=lambda T: 12.0)


class TestSchedules:
    def test_leg_times_regular_and_stub(self):
        assert leg_times(3.0, 1) == pytest.approx([1.0, 2.0, 3.0])
        assert leg_times(2.25, 2) == pytest.approx([0.25, 0.75, 1.25, 1.75, 2.25])
        assert leg_times(0.0, 1).size == 0

    def test_annuity_flat_zero_rate(self):
        assert annuity(lambda t: np.ones_like(t), 7.5, 4) == pytest.approx(7.5)

    def test_par_swap_reprices_to_par(self):
        disc = _flat(0.03)
        c = par_swap_rate(disc, 10.0, 1) * 100.0
        t, a = _bond(c, 10.0)
        assert price_from_curve(t, a, disc) == pytest.approx(100.0, abs=1e-10)


class TestAssetSwap:
    def test_bond_on_the_curve_has_zero_asw(self):
        disc = _flat(0.035)
        t, a = _bond(2.5, 8.0)
        dirty = price_from_curve(t, a, disc)
        assert par_asw(t, a, dirty, disc, 8.0) == pytest.approx(0.0, abs=1e-9)
        assert market_value_asw(t, a, dirty, disc, 8.0) == pytest.approx(0.0, abs=1e-9)

    def test_cheap_bond_has_positive_asw(self):
        # A bond priced 30bp of yield above the swap curve: par ASW ≈ +30bp
        disc = _flat(0.035)
        t, a = _bond(3.5, 10.0)
        cheap = price_from_curve(t, a, _flat(0.038))
        s = par_asw(t, a, cheap, disc, 10.0)
        assert 25 < s < 35
        # Proceeds ASW scales by 100 / dirty
        assert market_value_asw(t, a, cheap, disc, 10.0) == pytest.approx(s * 100.0 / cheap, rel=1e-12)

    def test_par_and_interpolated_agree_for_par_bond_on_flat_curve(self):
        # No coupon effect when the bond trades at par on a flat curve
        disc = _flat(0.03)
        c = par_swap_rate(disc, 10.0, 1) * 100.0
        t, a = _bond(c + 0.2, 10.0)                  # coupon 20bp above the swap rate …
        dirty = 100.0                                # … priced at par
        assert par_asw(t, a, dirty, disc, 10.0) == pytest.approx(20.0, abs=1e-8)
        assert interpolated_asw(t, a, dirty, disc, 10.0) == pytest.approx(20.0, abs=1e-8)


class TestBookExamples:
    def test_jgb_usd_asw_is_79bp(self):
        # H&S Ch 16: JGB 10Y 6M-ASW −1, ICBS +12, CCBS −64.5, CF 0.95 ⇒ +79bp vs USD
        assert usd_asw(-1.0, -64.5, 0.95, icbs_bp=12.0) == pytest.approx(79.47, abs=0.01)

    def test_ust_to_gbp_floater(self):
        # H&S Ch 17: SOFR+30 → SONIA − 19 + 30 = SONIA+11 (CF ≈ 1)
        s = convert_spread(30.0, USD, GBP, 10.0)
        cf = conversion_factor(USD, GBP, 10.0)
        assert s == pytest.approx(30.0 / cf - 19.0, abs=1e-10)
        assert s == pytest.approx(11.0, abs=0.5)

    def test_ust_to_gbp_synthetic_coupon(self):
        # Consistency, not the book's own curve: with a ~4.35% GBP par swap,
        # SONIA+11 becomes a ~4.46% fixed coupon.
        gbp = Market('GBP', 'SONIA', _flat(np.log(1.0435)), float_freq=1, fixed_freq=1, ccbs_bp=lambda T: -19.0)
        assert par_swap_rate(gbp.discount, 9.6, 1) * 100 == pytest.approx(4.35, abs=0.01)
        assert synthetic_fixed_coupon(11.0, gbp, 9.6) == pytest.approx(4.46, abs=0.01)


class TestConversion:
    def test_shortcut_matches_convert_spread(self):
        cf = conversion_factor(JPY, USD, 10.0)       # BPV_USD / BPV_JPY
        assert convert_spread(-1.0, JPY, USD, 10.0) == pytest.approx(usd_asw(-1.0, -64.5, cf, 12.0), abs=1e-10)

    def test_round_trip(self):
        # Without ICBS, GBP → JPY → GBP returns the starting spread
        jpy = Market('JPY', 'TONA', JPY.discount, ccbs_bp=JPY.ccbs_bp)
        there = convert_spread(25.0, GBP, jpy, 7.0)
        assert convert_spread(there, jpy, GBP, 7.0) == pytest.approx(25.0, abs=1e-10)

    def test_same_currency_is_identity(self):
        assert convert_spread(17.0, GBP, GBP, 5.0) == 17.0

    def test_zero_basis_identical_curves_changes_nothing(self):
        a = Market('EUR', 'ESTR', _flat(0.02))
        b = Market('USD', 'SOFR', _flat(0.02))
        assert convert_spread(12.0, a, b, 10.0) == pytest.approx(12.0, abs=1e-12)


class TestPipeline:
    def test_synthetic_bond_is_worth_the_floater(self):
        # On the target RFR curve the synthetic fixed bond is worth what the
        # RFR + s floater is worth: 100 + s · A_float · 100. Both legs start
        # today, so the synthetic bond's short first coupon accrues from today.
        t, a = _bond(3.375, 9.6)
        dirty = price_from_curve(t, a, _flat(0.043))
        out = asset_and_basis_swap(t, a, dirty, 9.6, USD, GBP)
        assert out['upfront'] == pytest.approx(100.0 - dirty)
        tg = leg_times(9.6, GBP.fixed_freq)
        ag = out['synthetic_coupon'] * np.diff(np.r_[0.0, tg])
        ag[-1] += 100.0
        floater = 100.0 + out['target_spread_bp'] * 1e-4 * annuity(GBP.discount, 9.6, GBP.float_freq) * 100.0
        assert price_from_curve(tg, ag, GBP.discount) == pytest.approx(floater, abs=1e-9)

    def test_home_currency_target(self):
        t, a = _bond(4.0, 5.0)
        out = asset_and_basis_swap(t, a, 99.0, 5.0, USD, USD)
        assert out['conversion_factor'] == 1.0
        assert out['target_spread_bp'] == pytest.approx(out['par_asw_bp'])
        assert out['home_ccbs_bp'] == 0.0
