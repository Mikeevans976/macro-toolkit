"""EGB RV live path: Bloomberg frames → panels, ASW proxy, missing series, data-source gate."""

import numpy as np
import pandas as pd
import pytest

import bbg
import egb_rv

DATES = pd.bdate_range("2026-01-01", periods=40)
STALE = {"GNTH30YR Index", "EESWE30 Curncy"}   # stop printing 20 days before the end
DEAD = {"GFIN2YR Index"}                        # never returns anything


def _value(ticker: str) -> float:
    if ticker.startswith("EESWE"):
        return 2.0
    if ticker == egb_rv._ESTR_TICKER:
        return 1.9
    if ticker == egb_rv._VOL_TICKER:
        return 75.0
    return 3.0 + (sum(map(ord, ticker)) % 50) / 100


def _fake_bdh(tickers, flds, start, end):
    cols = {}
    for t in tickers:
        if t in DEAD:
            continue
        s = pd.Series(_value(t), index=DATES)
        if t in STALE:
            s.iloc[-20:] = np.nan
        cols[(t, flds)] = s
    return pd.DataFrame(cols)


@pytest.fixture
def fake_bbg(monkeypatch):
    monkeypatch.setattr(bbg.blp, "bdh", staticmethod(_fake_bdh))


def test_fetch_builds_panels_and_lists_missing(fake_bbg):
    ydf, estr, asw, vol, bond_map, missing = egb_rv._fetch_from_bbg("2026-01-01", "2026-03-01")

    assert missing == sorted(STALE | DEAD)
    assert ("Netherlands", 30) not in ydf.columns and ("Finland", 2) not in ydf.columns
    assert ("Bund", 10) in ydf.columns
    assert estr.iloc[-1] == pytest.approx(1.9)
    assert vol.iloc[-1] == pytest.approx(75.0)
    assert bond_map == {}


def test_asw_proxy_is_yield_minus_ois_in_bps(fake_bbg):
    ydf, _, asw, *_ = egb_rv._fetch_from_bbg("2026-01-01", "2026-03-01")

    expected = (ydf[("Bund", 10)] - 2.0) * 100
    pd.testing.assert_series_equal(asw[("Bund", 10)], expected, check_names=False)
    assert ("Bund", 30) not in asw.columns   # its OIS leg went stale


def test_no_bloomberg_unless_configured(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("Bloomberg called with data_source=csv")
    monkeypatch.setattr(egb_rv, "_load_bbg", boom)

    out = egb_rv._compute_egb_rv()
    assert out["data_source"] == "simulation"
    assert out["missing_series"] == []
