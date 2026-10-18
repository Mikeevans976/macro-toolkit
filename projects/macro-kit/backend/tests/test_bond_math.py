"""
Unit tests for bond_math: hand-computable answers and identities that must
hold by construction (finite differences, key rates summing to the parallel).
"""
import numpy as np
import pandas as pd
import pytest

from bond_math import (
    bachelier_price,
    black_price,
    curve_bpv,
    ewma_normal_vol,
    fisher_weil_convexity,
    fisher_weil_duration,
    key_rate_durations,
    lognormal_from_normal,
    macaulay_duration,
    modified_duration,
    normal_from_lognormal,
    normal_from_lognormal_approx,
    price_from_curve,
    price_from_yield,
    risk_report,
    rolling_normal_vol,
    yield_convexity,
    ytm,
)


def _annual_bond(coupon: float, years: int):
    t = np.arange(1, years + 1, dtype=float)
    a = np.full(years, coupon)
    a[-1] += 100.0
    return t, a


def _flat(r: float):
    """Flat continuously compounded zero curve."""
    return lambda t: np.exp(-r * np.asarray(t))


def _sloped(t):
    """Upward-sloping zero curve, 2% → ~4%."""
    t = np.asarray(t, dtype=float)
    return np.exp(-(0.02 + 0.02 * (1 - np.exp(-t / 8))) * t)


# ── Yield-based ──────────────────────────────────────────────────────────────

class TestYieldMeasures:
    def test_par_bond_prices_at_100(self):
        t, a = _annual_bond(5.0, 10)
        assert price_from_yield(t, a, 0.05) == pytest.approx(100.0, abs=1e-10)
        assert ytm(t, a, 100.0) == pytest.approx(0.05, abs=1e-10)

    def test_textbook_10y_5pct(self):
        # Macaulay of a par annual bond = (1+y)/y · (1 − (1+y)^−n)
        t, a = _annual_bond(5.0, 10)
        mac = macaulay_duration(t, a, 0.05)
        assert mac == pytest.approx(1.05 / 0.05 * (1 - 1.05 ** -10), abs=1e-10)
        assert mac == pytest.approx(8.1078, abs=1e-4)
        assert modified_duration(t, a, 0.05) == pytest.approx(mac / 1.05, abs=1e-12)

    def test_zero_coupon_duration_is_maturity(self):
        t, a = np.array([7.0]), np.array([100.0])
        assert macaulay_duration(t, a, 0.03) == pytest.approx(7.0)
        assert fisher_weil_duration(t, a, _sloped) == pytest.approx(7.0)

    @pytest.mark.parametrize("freq", [1, 2])
    def test_duration_and_convexity_match_finite_differences(self, freq):
        t, a = np.arange(0.5, 15.01, 0.5), np.full(30, 2.0)
        a[-1] += 100.0
        y, h = 0.034, 1e-5
        p0 = price_from_yield(t, a, y, freq)
        pu, pd_ = price_from_yield(t, a, y + h, freq), price_from_yield(t, a, y - h, freq)
        assert modified_duration(t, a, y, freq) == pytest.approx(-(pu - pd_) / (2 * h) / p0, rel=1e-7)
        assert yield_convexity(t, a, y, freq) == pytest.approx((pu + pd_ - 2 * p0) / (h * h) / p0, rel=1e-4)

    def test_ytm_round_trip_semi_annual(self):
        t, a = np.arange(0.5, 10.01, 0.5), np.full(20, 1.5)
        a[-1] += 100.0
        p = price_from_yield(t, a, 0.041, freq=2)
        assert ytm(t, a, p, freq=2) == pytest.approx(0.041, abs=1e-10)

    def test_negative_yield(self):
        t, a = _annual_bond(0.0, 5)
        p = price_from_yield(t, a, -0.005)
        assert p > 100.0
        assert ytm(t, a, p) == pytest.approx(-0.005, abs=1e-10)


# ── Curve-based ──────────────────────────────────────────────────────────────

class TestCurveMeasures:
    def test_fisher_weil_equals_macaulay_on_flat_curve(self):
        # On a flat curve every flow is discounted at the YTM, so FW = Macaulay
        t, a = _annual_bond(3.0, 12)
        r = 0.03
        y = np.exp(r) - 1.0                  # annual-compounding equivalent
        assert fisher_weil_duration(t, a, _flat(r)) == pytest.approx(macaulay_duration(t, a, y), abs=1e-10)

    def test_fisher_weil_differs_from_macaulay_on_sloped_curve(self):
        t, a = _annual_bond(6.0, 30)
        p = price_from_curve(t, a, _sloped)
        mac = macaulay_duration(t, a, ytm(t, a, p))
        fw = fisher_weil_duration(t, a, _sloped)
        assert abs(fw - mac) > 0.05          # single-YTM discounting overweights the long flows

    def test_fisher_weil_matches_parallel_shift(self):
        t, a = _annual_bond(4.0, 20)
        p = price_from_curve(t, a, _sloped)
        h = 1e-5
        up, dn = price_from_curve(t, a, _sloped, h), price_from_curve(t, a, _sloped, -h)
        assert fisher_weil_duration(t, a, _sloped) == pytest.approx((dn - up) / (2 * h) / p, rel=1e-8)
        assert fisher_weil_convexity(t, a, _sloped) == pytest.approx((up + dn - 2 * p) / (h * h) / p, rel=1e-4)

    def test_bpv_is_duration_times_price(self):
        t, a = _annual_bond(2.5, 10)
        p = price_from_curve(t, a, _sloped)
        assert curve_bpv(t, a, _sloped) == pytest.approx(fisher_weil_duration(t, a, _sloped) * p * 1e-4, rel=1e-6)

    # Key rates come from ±1bp bumps, so they differ from the analytic duration
    # by the central-difference error, O((T · 1bp)²) ≈ 1e-7 relative.
    def test_key_rates_sum_to_parallel(self):
        t, a = np.arange(0.5, 27.01, 0.5), np.full(54, 1.75)
        a[-1] += 100.0
        krd = key_rate_durations(t, a, _sloped)
        assert sum(k['duration'] for k in krd) == pytest.approx(fisher_weil_duration(t, a, _sloped), rel=1e-6)
        assert sum(k['bpv'] for k in krd) == pytest.approx(curve_bpv(t, a, _sloped), rel=1e-6)

    def test_key_rates_zero_coupon_between_tenors(self):
        # A 7y zero sits 2/5 of the way from the 5y to the 10y key rate
        krd = {k['tenor']: k['duration'] for k in key_rate_durations([7.0], [100.0], _sloped)}
        assert krd[5.0] == pytest.approx(7.0 * 0.6, rel=1e-6)
        assert krd[10.0] == pytest.approx(7.0 * 0.4, rel=1e-6)
        assert krd[2.0] == pytest.approx(0.0, abs=1e-10)

    def test_risk_report_is_consistent(self):
        t, a = _annual_bond(3.0, 10)
        rep = risk_report(t, a, _sloped)
        assert rep['dirty'] == pytest.approx(price_from_yield(t, a, rep['ytm']), abs=1e-9)
        assert len(rep['key_rates']) == 5


# ── Vol conversion ───────────────────────────────────────────────────────────

class TestVolConversion:
    @pytest.mark.parametrize("K", [2.5, 3.0, 3.5])
    def test_round_trip(self, K):
        sn = normal_from_lognormal(3.0, K, 2.0, 0.30)
        assert lognormal_from_normal(3.0, K, 2.0, sn) == pytest.approx(0.30, abs=1e-9)

    def test_atm_approximation(self):
        # σ_N ≈ σ_LN · F is accurate ATM for small σ√T
        exact = normal_from_lognormal(4.0, 4.0, 0.25, 0.20)
        approx = normal_from_lognormal_approx(4.0, 0.20)
        assert approx == pytest.approx(80.0)
        assert exact == pytest.approx(approx, rel=2e-3)

    def test_shifted_lognormal_handles_negative_rates(self):
        sn = normal_from_lognormal(-0.2, -0.2, 1.0, 0.25, shift=2.0)
        assert sn == pytest.approx(0.25 * 1.8 * 100.0, rel=5e-3)

    def test_bachelier_atm_closed_form(self):
        # ATM Bachelier = σ√T / √(2π)
        assert bachelier_price(3.0, 3.0, 1.0, 100.0) == pytest.approx(1.0 / np.sqrt(2 * np.pi), rel=1e-12)

    def test_black_rejects_non_positive(self):
        with pytest.raises(ValueError):
            black_price(-0.1, 0.5, 1.0, 0.2)


# ── Realised vol ─────────────────────────────────────────────────────────────

class TestRealisedVol:
    def test_constant_move_size(self):
        # Alternating ±5bp moves: vol = 5 · √252 bp/yr whatever the weighting
        steps = np.tile([0.05, -0.05], 100)
        levels = pd.Series(np.r_[3.0, 3.0 + np.cumsum(steps)])
        assert ewma_normal_vol(levels).iloc[-1] == pytest.approx(5 * np.sqrt(252), rel=1e-10)
        assert rolling_normal_vol(levels).iloc[-1] == pytest.approx(5 * np.sqrt(252), rel=1e-10)

    def test_ewma_has_no_drop_off_cliff(self):
        # One 50bp shock, then quiet 1bp days: the rolling vol falls off a cliff
        # when the shock leaves the window; the EWMA decays smoothly.
        moves = np.r_[np.full(100, 0.01), 0.50, np.full(150, 0.01)]
        levels = pd.Series(np.r_[3.0, 3.0 + np.cumsum(moves)])
        roll = rolling_normal_vol(levels, window=63).dropna()
        ewma = ewma_normal_vol(levels, halflife=21).dropna()
        assert roll.diff().min() < -50          # cliff
        after = ewma.iloc[101:]
        assert (after.diff().dropna() <= 1e-9).all()
        assert after.diff().min() > -15

    def test_scale_for_bp_series(self):
        levels = pd.Series(np.r_[0.0, np.cumsum(np.tile([2.0, -2.0], 50))])
        assert ewma_normal_vol(levels, scale=1.0).iloc[-1] == pytest.approx(2 * np.sqrt(252), rel=1e-10)
