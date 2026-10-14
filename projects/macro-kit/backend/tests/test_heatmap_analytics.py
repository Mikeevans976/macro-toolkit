"""heatmap_analytics: vectorised numpy port vs a literal transcription of the
frontend pages' loops, plus hand-computable cases."""
import numpy as np
import pytest

import heatmap_analytics as ha

ROLL = ha.ROLL_DAYS


def _js_round(x):
    return int(np.floor(x + 0.5))


def _loop_curve_full(long, short):
    """EuroAreaHeatmap.tsx computeFullDailyDir, transcribed."""
    out = []
    for t in range(ROLL, len(long)):
        bs = bf = bes = bef = 0
        for i in range(t - ROLL + 1, t + 1):
            d_long = long[i] - long[i - 1]
            d_spread = (long[i] - short[i]) - (long[i - 1] - short[i - 1])
            if abs(d_long) < 1e-7:
                continue
            if d_long < 0 and d_spread > 0: bs += 1
            elif d_long < 0 and d_spread <= 0: bf += 1
            elif d_long > 0 and d_spread > 0: bes += 1
            else: bef += 1
        total = (bs + bf + bes + bef) or 1
        out.append([_js_round(c / total * 100) for c in (bs, bf, bes, bef)])
    return np.array(out)


def _loop_be_full(nom, be):
    """EuroAreaHeatmap.tsx computeBEFullDir, transcribed."""
    out = []
    for t in range(ROLL, len(nom)):
        c = [0, 0, 0, 0]
        for i in range(t - ROLL + 1, t + 1):
            dy, dbe = nom[i] - nom[i - 1], be[i] - be[i - 1]
            if abs(dy) < 1e-7:
                continue
            if dy > 0 and dbe > 0: c[0] += 1
            elif dy < 0 and dbe < 0: c[1] += 1
            elif dy < 0 and dbe > 0: c[2] += 1
            else: c[3] += 1
        total = sum(c) or 1
        out.append([_js_round(x / total * 100) for x in c])
    return np.array(out)


def _loop_lookbacks(long, short):
    """EuroAreaHeatmap.tsx computeFreqTable, transcribed."""
    rows = []
    n = len(long)
    for horizon, days in ha.LOOKBACKS:
        c = [0, 0, 0, 0]
        for i in range(max(1, n - days), n):
            d_long = long[i] - long[i - 1]
            d_spread = (long[i] - short[i]) - (long[i - 1] - short[i - 1])
            if abs(d_long) < 1e-7:
                continue
            k = (0 if d_spread > 0 else 1) if d_long < 0 else (2 if d_spread > 0 else 3)
            c[k] += 1
        total = sum(c) or 1
        rows.append([round(x / total * 100) for x in c])
    return rows


@pytest.fixture
def paths():
    rng = np.random.default_rng(7)
    long = 4 + np.cumsum(rng.normal(0, 0.03, 300))
    short = 3.5 + np.cumsum(rng.normal(0, 0.03, 300))
    long[50:53] = long[49]            # flat days are unclassified
    be = 2.2 + np.cumsum(rng.normal(0, 0.01, 300))
    return long, short, be


def test_rolling_curve_regimes_match_page_loops(paths):
    long, short, _ = paths
    got = ha.rolling_shares(ha.curve_regime_labels(long, short))
    np.testing.assert_array_equal(got, _loop_curve_full(long, short))


def test_rolling_be_regimes_match_page_loops(paths):
    long, _, be = paths
    got = ha.rolling_shares(ha.be_regime_labels(long, be))
    np.testing.assert_array_equal(got, _loop_be_full(long, be))


def test_lookback_table_matches_page_loops(paths):
    long, short, _ = paths
    rows = ha.lookback_table(ha.curve_regime_labels(long, short), ha.CURVE_REGIMES)
    assert [[r[k] for k in ha.CURVE_REGIMES] for r in rows] == _loop_lookbacks(long, short)
    assert [r["horizon"] for r in rows] == ["2w", "1m", "2m", "3m"]


def test_regime_conventions_by_hand():
    # long falls & spread widens → bull steep; long rises & spread narrows → bear flat
    long = np.array([4.0, 3.9, 4.0, 4.0])
    short = np.array([3.0, 2.8, 3.2, 3.2])   # spread 1.0 → 1.1 → 0.8 → 0.8
    assert ha.curve_regime_labels(long, short).tolist() == [0, 3, -1]
    nom = np.array([4.0, 4.1, 4.0, 4.1])
    be = np.array([2.0, 2.1, 2.2, 2.1])
    assert ha.be_regime_labels(nom, be).tolist() == [0, 2, 3]   # expansion, stagflation, goldilocks


def test_dispersion_bounds():
    assert ha.dispersion((25, 25, 25, 25)) == 0.0
    assert ha.dispersion((100, 0, 0, 0)) == 100.0


def test_scenarios_sum_to_about_100_and_map_regimes():
    assert ha.curve_scenarios(100, 0, 0, 0)["hard_landing"] == 100
    assert ha.curve_scenarios(0, 0, 0, 100)["reacceleration"] == 100
    p = ha.be_scenarios(30, 20, 25, 25)
    assert abs(sum(p.values()) - 100) <= 2


def test_curve_fair_value_table():
    tenors = ["2y", "5y", "10y", "30y"]
    fair = np.tile([3.0, 3.2, 3.5, 3.8], (5, 1))
    yields = fair.copy()
    yields[:, 2] += np.array([0.0, 0.1, -0.1, 0.0, 0.05])      # 10y residuals (pp)
    rows = {r["label"]: r for r in ha.curve_fair_value_table(tenors, yields, fair)}
    assert rows["10y"]["resid_bp"] == 5.0
    assert rows["10y"]["std_bp"] == pytest.approx(np.std([0, 10, -10, 0, 5]), abs=0.01)
    assert rows["2s10s"]["current"] == 55.0 and rows["2s10s"]["resid_bp"] == 5.0
    assert rows["2y"]["zscore"] == 0.0


def test_factor_summary():
    s = np.arange(300, dtype=float)
    out = ha.factor_summary(s)
    assert out["current"] == 299 and out["d1m"] == 21 and out["d3m"] == 63 and out["d12m"] == 252
    assert ha.factor_summary(np.arange(10.0))["d12m"] is None
