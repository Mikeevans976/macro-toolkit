"""Macro Options Monitor: option maths, chain fitting, OIS path and payload assembly.

Everything here runs without Bloomberg: the snapshot builder is fed a synthetic raw
market, built from a known Bachelier smile and a known ECB step path.
"""
import math
from datetime import datetime

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

import macro_options as mo
from schemas.macro_options import MacroOptionsSnapshot


def test_parse_option_ticker():
    assert mo.parse_option_ticker("ERX6P    95.5 Comdty") == ("ERX6", "P", 95.5)
    assert mo.parse_option_ticker("ERZ6C 96.0625 Comdty") == ("ERZ6", "C", 96.0625)
    assert mo.parse_option_ticker("ERZ6 Comdty") is None
    assert mo._opt_ticker("ERZ6", "C", 100.0) == "ERZ6C 100 Comdty"


def test_rule_expiries_match_bloomberg():
    # Bloomberg OPT_EXPIRE_DT (2026-10-18): serials on Fridays, standard on the Monday
    assert mo._rule_expiry(2026, 11, False).isoformat() == "2026-11-13"
    assert mo._rule_expiry(2026, 10, False).isoformat() == "2026-10-16"
    assert mo._rule_expiry(2027, 1, False).isoformat() == "2027-01-15"
    assert mo._rule_expiry(2026, 12, True).isoformat() == "2026-12-14"


def test_estimated_ecb_meetings_are_thursdays():
    rows = mo.ecb_meetings(2029)
    est = [r for r in rows if r["estimated"]]
    assert est and all(r["decision"].weekday() == 3 for r in est)
    assert all((r["effective"] - r["decision"]).days in (5, 6) for r in rows)
    assert len([r for r in rows if r["decision"].year == 2028]) == 8


@pytest.mark.parametrize("K,cp", [(97.0, "C"), (97.0, "P"), (97.5, "C"), (96.25, "P")])
def test_implied_vol_round_trip(K, cp):
    F, T, vol = 97.1, 0.4, 0.65
    price = mo.bachelier_price(F, K, T, vol, cp)
    assert mo.implied_normal_vol(price, F, K, T, cp) == pytest.approx(vol, rel=1e-6)
    assert mo.implied_normal_vol(0.0, F, K, T, cp) is None


def test_scalar_and_vector_bachelier_agree():
    K = np.array([96.5, 97.0, 97.75])
    vec = mo.bachelier_call(97.1, K, 0.5, 0.6)
    assert vec == pytest.approx([mo.bachelier_price(97.1, k, 0.5, 0.6, "C") for k in K], abs=1e-12)


def test_convex_calls_removes_negative_density_and_keeps_convex_curves():
    h = 0.0125
    K = 96 + h * np.arange(200)
    clean = mo.bachelier_call(97.2, K, 0.3, 0.5)
    assert mo.convex_calls(clean, h) == pytest.approx(clean, abs=1e-12)
    noisy = clean + 0.002 * np.sin(np.arange(200) / 3)
    fixed = mo.convex_calls(noisy, h)
    assert (np.diff(fixed, 2) >= -1e-12).all()
    assert (np.diff(fixed) / h >= -1 - 1e-12).all() and (np.diff(fixed) <= 1e-12).all()


def _quotes(F, T, smile, strikes, tick=True):
    out = []
    for k in strikes:
        cp = "C" if k >= F else "P"
        p = mo.bachelier_price(F, k, T, smile(k), cp)
        if tick:
            p = round(p / mo.TICK) * mo.TICK
        if p > 0:
            out.append({"strike": k, "type": cp, "price": p, "source": "settle"})
    return out


def test_fit_chain_recovers_a_known_smile():
    F, T = 97.1, 0.5

    def smile(k):
        return 0.6 * (1 - 0.15 * (k - F) + 0.25 * (k - F) ** 2)

    strikes = [round(95.5 + 0.0625 * i, 4) for i in range(52)]
    fit = mo.fit_chain(F, T, _quotes(F, T, smile, strikes))
    assert fit is not None
    assert fit["atm_vol"] == pytest.approx(0.6, rel=0.03)
    assert fit["fit_rmse_ticks"] < 1.0
    grid = fit["grid_lo"] + fit["grid_h"] * np.arange(len(fit["calls"]))
    assert abs(round(fit["grid_lo"] / fit["grid_h"]) * fit["grid_h"] - fit["grid_lo"]) < 1e-9
    calls = np.array(fit["calls"])
    assert (np.diff(calls, 2) >= -1e-9).all()                        # density never negative
    mass = np.diff(calls, 2).sum() / fit["grid_h"]
    assert mass == pytest.approx(1.0, abs=0.02)
    true = mo.bachelier_call(F, grid, T, np.array([smile(k) for k in grid]))
    near = np.abs(grid - F) < 0.75
    assert np.abs(calls[near] - true[near]).max() < 2 * mo.TICK
    assert all(q["strike"] >= F for q in fit["quotes"] if q["type"] == "C")


def test_fit_chain_needs_three_quotes():
    assert mo.fit_chain(97.0, 0.5, [{"strike": 97.0, "type": "C", "price": 0.2, "source": "settle"}]) is None


def test_ois_path_flat_curve_means_no_moves():
    as_of = datetime(2026, 10, 16, 21, 0)
    meetings = [m for m in mo.ecb_meetings(2029) if m["decision"] > as_of]
    tenors = list(mo.OIS_TICKERS.values())
    # Flat €STR at 2.44 still gives (slightly) rising simple par rates from compounding: build them exactly
    def D(days):
        return (1 + 0.0244 / 360) ** -days

    ois = {}
    start = pd.Timestamp(as_of.date())
    for T in tenors:
        end = start + pd.DateOffset(months=int(round(T * 12)))
        e = (end - start).days
        if T <= 1:
            ois[T] = (1 / D(e) - 1) * 360 / e * 100
        else:
            pays = [end]
            while (p := pays[-1] - pd.DateOffset(years=1)) > start:
                pays.append(p)
            days = sorted((p - start).days for p in pays)
            ann = sum((p - q) / 360 * D(p) for q, p in zip([0, *days[:-1]], days))
            ois[T] = (1 - D(e)) / ann * 100
    path = mo.ois_meeting_path(as_of, 2.44, 2.50, ois, meetings)
    assert path
    assert max(abs(m["exp_bp"]) for m in path) < 0.5
    assert path[0]["rate"] == pytest.approx(2.50, abs=0.01)                 # DFR = €STR − spread
    assert all(m["decision"] > as_of for m in path)


def test_ois_path_finds_a_priced_hike():
    as_of = datetime(2026, 10, 16, 21, 0)
    meetings = [m for m in mo.ecb_meetings(2029) if m["decision"] > as_of]
    hike_eff = meetings[1]["effective"]          # +25 bp at the December meeting
    start = pd.Timestamp(as_of.date())

    def r(day):
        return 2.44 + (0.25 if start + pd.Timedelta(days=day) >= pd.Timestamp(hike_eff) else 0.0)

    def D(days):
        return math.prod(1 / (1 + r(i) / 100 / 360) for i in range(days))

    ois = {}
    for T in [m / 12 for m in range(1, 12)] + [1.0]:
        e = ((start + pd.DateOffset(months=int(round(T * 12)))) - start).days
        ois[T] = (1 / D(e) - 1) * 360 / e * 100
    path = mo.ois_meeting_path(as_of, 2.44, 2.50, ois, meetings)
    moves = {m["decision"].date(): m["exp_bp"] for m in path}
    assert moves[meetings[1]["decision"].date()] == pytest.approx(25, abs=4)
    assert path[-1]["cumulative_bp"] == pytest.approx(25, abs=2)


def _synthetic_raw():
    """A raw Bloomberg pull for two contracts, built from a known smile."""
    as_of = datetime(2026, 10, 16, 16, 15)
    contracts = [
        {"year": 2026, "month": 12, "id": "ERZ6", "ticker": "ERZ6 Comdty", "ltd": "2026-12-14"},
        {"year": 2027, "month": 3, "id": "ERH7", "ticker": "ERH7 Comdty", "ltd": "2027-03-15"},
    ]
    F = {"ERZ6": 97.1, "ERH7": 96.84}
    exp = {"ERX6": "2026-11-13", "ERZ6": "2026-12-14", "ERH7": "2027-03-15"}
    universe, quotes = {}, {}
    for root, under in [("ERX6", "ERZ6"), ("ERZ6", "ERZ6"), ("ERH7", "ERH7")]:
        f = F[under]
        T = mo._years(as_of, datetime.fromisoformat(exp[root]).replace(hour=10))
        ts = []
        for q in _quotes(f, T, lambda k: 0.55 + 0.1 * (k - f) ** 2, [round(f - 1.5 + 0.0625 * i, 4) for i in range(49)]):
            for cp in "CP":
                t = mo._opt_ticker(root, cp, q["strike"])
                ts.append(t)
                price = q["price"] if cp == q["type"] else q["price"] + (f - q["strike"] if cp == "C" else q["strike"] - f)
                quotes[t] = {"settle": price}
        universe[root] = ts
    return {
        "live": False, "as_of": as_of.isoformat(timespec="minutes"), "contracts": contracts,
        "F": F, "F_settle": F,
        "rates": {mo.DFR_TICKER: 2.5, mo.ESTR_TICKER: 2.44, **{t: 2.44 + 0.2 * T for t, T in mo.OIS_TICKERS.items()}},
        "universe": universe, "quotes": quotes, "expiries": exp,
    }


def test_build_snapshot_payload():
    payload = mo._build(_synthetic_raw())
    MacroOptionsSnapshot.model_validate(payload)
    z6 = payload["contracts"][0]
    assert [e["code"] for e in z6["expiries"]] == ["ERX6", "ERZ6"]
    assert [e["kind"] for e in z6["expiries"]] == ["serial", "standard"]
    assert z6["expiries"][0]["id"] == "2026-11"
    assert z6["expiries"][1]["atm_vol"] == pytest.approx(0.55, rel=0.05)
    assert payload["ois_path"] and payload["ois_path"][0]["exp_bp"] > 0      # an upward-sloping OIS curve
    assert payload["rates"]["dfr"] == 2.5
    assert payload["data_source"] == "bloomberg" and payload["live"] is False


def test_endpoints_fall_back_to_simulation_without_bloomberg():
    import main
    from auth import get_current_user
    main.app.dependency_overrides[get_current_user] = lambda: {"username": "t", "full_name": "T"}
    try:
        client = TestClient(main.app)
        r = client.get("/api/tools/macro-options/snapshot")
        assert r.status_code == 200 and r.json()["data_source"] == "simulation"
        r = client.get("/api/tools/macro-options/open-interest?contract=ERZ6&expiry=2026-11")
        assert r.status_code == 200 and r.json()["data_source"] == "simulation"
        assert client.get("/api/tools/macro-options/open-interest?contract=XX&expiry=2026-11").status_code == 422
        assert client.get("/api/tools/macro-options/snapshot?date=yesterday").status_code == 422
    finally:
        main.app.dependency_overrides.clear()
