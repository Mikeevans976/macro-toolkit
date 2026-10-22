"""US Labour Market Nowcast: the labour engine's US configuration on the simulated US
labour market (labour_data.simulate_us), and its API route."""
from __future__ import annotations

import warnings

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

import labour_data as ld
import labour_nowcast as ln
from schemas.labour_nowcast import LabourNowcast

LAST = pd.Period("2026-09", "M")


def _gdp(slug: str = "us") -> pd.Series:
    rng = np.random.default_rng(7)
    return pd.Series(rng.normal(0.5, 0.4, 118), index=pd.period_range("1997Q1", periods=118, freq="Q"))


@pytest.fixture(scope="module", autouse=True)
def state_dir(tmp_path_factory):
    saved = ln.ROOT, ln.INPUTS, ln.QUARTERLY
    ln.ROOT = tmp_path_factory.mktemp("labour_us")
    ln.INPUTS, ln.QUARTERLY = (lambda slug: ld.simulate_us(LAST)), _gdp
    ln._payloads.clear()
    yield ln.ROOT
    ln.ROOT, ln.INPUTS, ln.QUARTERLY = saved
    ln._payloads.clear()


@pytest.fixture(scope="module")
def built() -> tuple[dict, ln.Params]:
    return ln.build("us", ld.simulate_us(LAST), _gdp(), None, True)


def test_simulation_is_deterministic_and_complete():
    a, b = ld.simulate_us(LAST), ld.simulate_us(LAST)
    pd.testing.assert_frame_equal(a.monthly, b.monthly)
    assert a.source == "simulation" and a.monthly.index.max() == LAST
    u = a.monthly["unemployment_rate"]
    assert 3.3 <= u.iloc[-1] <= 5.5
    hh = a.monthly["household_employment"] / a.monthly["labour_force"]
    np.testing.assert_allclose(100 * (1 - hh), u, atol=1e-9)


def test_us_payload(built):
    p, params = built
    LabourNowcast.model_validate({**p, "runs": []})
    assert p["labels"]["target"] == "Nonfarm payrolls" and p["labels"]["institution"] == "Federal Reserve"
    assert p["data_source"] == "simulation" and params.b > 0 and p["model"]["n_indicators"] == 12
    nxt = p["next_prints"]["lfs_employment"]
    assert nxt["kind"] == "change" and nxt["period"] == "2026-10" and nxt["lo"] < nxt["forecast"] < nxt["hi"]
    assert nxt["release"].startswith("06 November 2026")                 # first Friday after October
    # the change is the underlying 3m/3m rate spread over three months, on the latest level
    lvl = ld.simulate_us(LAST).monthly["payrolls"]
    assert nxt["forecast"] == pytest.approx(lvl[LAST] * nxt["underlying"] / 300, abs=0.6)
    assert p["next_prints"]["payrolls"] is None                          # no separate flash measure


def test_unemployment_is_a_quarterly_average_against_the_sep(built):
    p, _ = built
    u = p["next_prints"]["unemployment"]
    assert [x["period"] for x in u] == ["2026Q4", "2027Q1"]
    assert u[0]["boe"] == {"report": "September 2026", "value": 4.1}
    assert u[0]["lo"] <= u[0]["projection"] <= u[0]["hi"]
    assert p["latest"]["boe_report"] == "September 2026" and "kept pace with the workforce" in p["latest"]["boe_text"]


@pytest.fixture(scope="module")
def client():
    import main
    from auth import get_current_user
    main.app.dependency_overrides[get_current_user] = lambda: {"username": "t", "full_name": "T"}
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        yield TestClient(main.app)
    main.app.dependency_overrides.clear()


def test_api(client):
    r = client.get("/api/tools/quant-macro/labour/us")
    assert r.status_code == 200, r.text[:300]
    assert r.json()["title"] == "US Labour Market Nowcast"
