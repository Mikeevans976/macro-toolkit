"""Swaps RV implied vol: grid lookup, leg interpolation and the structure's vol."""

import numpy as np
import pandas as pd
import pytest

from swaps_rv import (
    _implied_structure_vol,
    _leg_implied_vol,
    _vol_grid,
    _vol_grid_tickers,
    compute_rv,
)

EXPS = [1 / 12, 0.25, 0.5, 1.0, 2.0, 3.0, 5.0, 10.0]
TENS = [1, 2, 3, 5, 7, 10, 15, 20, 30]


def vol_at(e: float, t: float) -> float:
    """A smooth synthetic surface, linear in expiry and tenor so interpolation is exact."""
    return 100 - 2 * e - t


def fake_fetched(days: int = 5, last: str = "2026-10-16", hole: bool = False) -> tuple:
    idx = pd.bdate_range(end=last, periods=days)
    cols = pd.MultiIndex.from_tuples([(e, t) for e in EXPS for t in TENS], names=["expiry", "tenor"])
    grid = pd.DataFrame([[vol_at(e, t) for e, t in cols] for _ in idx], index=idx, columns=cols)
    if hole:   # no expiry prices the 1y tenor: unusable
        for e in EXPS:
            grid[(e, 1)] = np.nan
    return (0.0, (pd.DataFrame(), pd.DataFrame(), pd.DataFrame(), grid))


@pytest.fixture
def grid():
    return _vol_grid(fake_fetched(), pd.Timestamp("2026-10-16"))


def test_grid_reads_the_as_of_row(grid):
    exps, tens, vols, date = grid
    assert list(tens) == TENS and exps[0] == pytest.approx(1 / 12) and date == "2026-10-16"
    assert vols[list(exps).index(2.0), TENS.index(10)] == vol_at(2, 10)


def test_grid_missing_stale_or_incomplete():
    assert _vol_grid(None, pd.Timestamp("2026-10-16")) is None
    assert _vol_grid((0.0, (pd.DataFrame(),) * 3), pd.Timestamp("2026-10-16")) is None
    assert _vol_grid(fake_fetched(last="2026-09-01"), pd.Timestamp("2026-10-16")) is None   # > a week old
    assert _vol_grid(fake_fetched(hole=True), pd.Timestamp("2026-10-16")) is None


def test_leg_vol_expiry_is_the_forward_start(grid):
    assert _leg_implied_vol(2, 10, grid) == pytest.approx(vol_at(2, 10))     # 2y10y: 2y expiry
    assert _leg_implied_vol(0, 10, grid) == pytest.approx(vol_at(1, 10))     # 10y spot: 1y (the carry horizon)
    assert _leg_implied_vol(15, 5, grid) == pytest.approx(vol_at(10, 5))     # beyond the grid: capped at 10y
    assert _leg_implied_vol(4, 4, grid) == pytest.approx(vol_at(4, 4))       # interpolated both ways


def test_missing_corner_uses_the_longest_expiry_that_prices_the_tenor():
    # GBP/USD: no 10y expiry on 10y+ tenors
    fetched = fake_fetched()
    grid_df = fetched[1][3]
    for t in (10, 15, 20, 30):
        grid_df[(10.0, t)] = np.nan
    grid = _vol_grid(fetched, pd.Timestamp("2026-10-16"))
    assert grid is not None
    assert _leg_implied_vol(10, 10, grid) == pytest.approx(vol_at(5, 10))     # capped at 5y expiry
    assert _leg_implied_vol(7, 20, grid) == pytest.approx(vol_at(5, 20))
    assert _leg_implied_vol(10, 5, grid) == pytest.approx(vol_at(10, 5))      # short tenors keep 10y expiry
    assert _leg_implied_vol(3, 10, grid) == pytest.approx(vol_at(3, 10))      # inside the grid: unchanged


def test_ticker_layouts():
    eur, gbp, usd = (_vol_grid_tickers(c) for c in ("EUR", "GBP", "USD"))
    assert eur["ENPS0110 ICPL Curncy"] == (1.0, 10) and eur["ENPS0A10 ICPL Curncy"] == (1 / 12, 10)
    assert gbp["GBNS0110 ICPL Curncy"] == (1.0, 10) and len(gbp) == 72
    assert usd["USSNA110 ICPL Curncy"] == (1.0, 10) and usd["USSNAA10 ICPL Curncy"] == (1 / 12, 10)
    assert usd["USSNA101 ICPL Curncy"] == (10.0, 1)
    assert not any(e == 10.0 and t >= 10 for e, t in usd.values())                # ambiguous codes left out
    assert len(set(usd)) == len(usd) == 68


def test_structure_vol_combines_leg_vols_and_correlation():
    legs = ("1y5y", "1y10y")
    iv = {"1y5y": 90.0, "1y10y": 80.0}
    corr = lambda r: pd.DataFrame([[1, r], [r, 1]], index=legs, columns=legs)  # noqa: E731
    assert _implied_structure_vol(legs, (-1, 1), iv, corr(1.0)) == pytest.approx(10.0)
    assert _implied_structure_vol(legs, (-1, 1), iv, corr(0.0)) == pytest.approx(np.hypot(90, 80))
    fly = ("a", "b", "c")
    c3 = pd.DataFrame(np.eye(3), index=fly, columns=fly)
    assert _implied_structure_vol(fly, (-1, 2, -1), {"a": 1.0, "b": 1.0, "c": 1.0}, c3) == pytest.approx(np.sqrt(6))


def test_csv_mode_has_no_implied_vol():
    rv = compute_rv("EUR")
    assert rv["implied_vol"] is None
    assert all(r["ivol_bps"] is None and r["carry_ivol_ratio"] is None for r in rv["rv_monitor"])
