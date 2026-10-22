"""UK Labour Market Nowcast (labour_nowcast.py), its data readers (labour_data.py) and the
/api/tools/quant-macro/labour routes.

Runs offline on synthetic inputs (tests/labour_synthetic.py); saved state goes to a
temporary directory.
"""
from __future__ import annotations

import io
import json
import time
import warnings

import numpy as np
import openpyxl
import pandas as pd
import pytest
from fastapi.testclient import TestClient

import labour_data as ld
import labour_nowcast as ln
from schemas.labour_nowcast import LabourNowcast
from tests import labour_synthetic as syn


@pytest.fixture(scope="module", autouse=True)
def state_dir(tmp_path_factory):
    saved = ln.ROOT, ln.INPUTS, ln.QUARTERLY
    ln.ROOT = tmp_path_factory.mktemp("labour")
    ln.INPUTS, ln.QUARTERLY = syn.data, syn.gdp
    ln._payloads.clear()
    yield ln.ROOT
    ln.ROOT, ln.INPUTS, ln.QUARTERLY = saved
    ln._payloads.clear()


@pytest.fixture(scope="module")
def built() -> tuple[dict, ln.Params]:
    return ln.build("uk", syn.data(), syn.gdp(), None, True)


# ---------------------------------------------------------------------------
# Readers
# ---------------------------------------------------------------------------

def _xlsx(sheets: dict[str, list[list]]) -> bytes:
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    for name, rows in sheets.items():
        ws = wb.create_sheet(name)
        for r in rows:
            ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_read_lms(tmp_path):
    head = ['"Title","Employment","Unemployment rate","Active"', '"CDID","MGRZ","MGSX","MGSF"', '"PreUnit","","",""', '"Unit","","",""',
            '"Release Date","20-10-2026","20-10-2026","20-10-2026"', '"Next release","17 November 2026","",""', '"Important Notes","","",""',
            '"2026","1","2","3"', '"2026 Q2","1","2","3"']
    rows = ['"2026 JUN","34478","4.9","36256"', '"2026 JUL","34577","4.7","36290"']
    (tmp_path / "lms.csv").write_text("\n".join(head + rows), encoding="latin-1")
    df, info = ld.read_lms(tmp_path / "lms.csv")
    assert list(df.index.astype(str)) == ["2026-06", "2026-07"]
    assert df.loc[pd.Period("2026-07", "M"), "lfs_unemployment_rate"] == 4.7
    assert info.release == "2026-10-20" and info.next_release == "17 November 2026" and info.latest == "2026-07"


def test_read_rti_agents_and_dmp(tmp_path):
    from datetime import datetime
    (tmp_path / "rti.xlsx").write_bytes(_xlsx({
        "Index": [["x"]],
        "1. Payrolled employees (UK)": [["1. Payrolled employee counts"], [], ["Date", "Payrolled employees", "Change"],
                                        ["August 2026", 30268214, 712], ["September 2026", 30280860, 12646]]}))
    pay = ld.read_rti(tmp_path / "rti.xlsx")
    assert pay[pd.Period("2026-09", "M")] == 30280860 and len(pay) == 2

    head = [None, "Turnover"] + [None] * 15 + ["Recruitment Difficulties", "Employment Intentions (new scores)"]
    (tmp_path / "agents.xlsx").write_bytes(_xlsx({"Agents' scores": [[None, "Agents' scores"], head,
                                                                     [datetime(2026, 7, 1)] + [1.0] * 16 + [-1.0, 0.5],
                                                                     [datetime(2026, 8, 1)] + [1.0] * 16 + [-0.5, "n/a"]]}))
    ag = ld.read_agents(tmp_path / "agents.xlsx")
    assert ag.loc[pd.Period("2026-07", "M")].tolist() == [0.5, -1.0]
    assert np.isnan(ag.loc[pd.Period("2026-08", "M"), "agents_employment"])

    title = ["", "Realised employment growth over the past year (%)"] + [None] * 10 + ["Expected employment growth over the next year (%)"]
    (tmp_path / "dmp.xlsx").write_bytes(_xlsx({"Employment growth": [
        title, [], [], ["Survey date/reference period", "Single month", "3 month average"],
        ["Aug-26", 0.005, -0.237] + [None] * 9 + [0.1, 0.112], ["Sep-26", -0.574, -0.227] + [None] * 9 + [0.2, 0.153]]}))
    dm = ld.read_dmp(tmp_path / "dmp.xlsx")
    assert dm.loc[pd.Period("2026-09", "M")].tolist() == [-0.227, 0.153]


def test_transforms():
    x = pd.Series([100.0, 101, 102, 103, 104.0])
    assert ld.transform(x, "growth3").iloc[3] == pytest.approx(3.0)
    assert ld.transform(x, "level").equals(x)


# ---------------------------------------------------------------------------
# Factor model
# ---------------------------------------------------------------------------

def test_em_pca_recovers_the_factor_with_missing_data():
    rng = np.random.default_rng(0)
    f = np.cumsum(rng.normal(0, 1, 300)) * 0.1 + rng.normal(0, 1, 300)
    lam = np.array([1.0, 0.8, -0.6, 1.2, 0.5])
    Z = np.outer(f, lam) + rng.normal(0, 0.3, (300, 5))
    Z[:150, 3] = np.nan
    Z[rng.random((300, 5)) < 0.05] = np.nan
    fh, lh = ln.em_pca(Z)
    assert abs(np.corrcoef(fh, f)[0, 1]) > 0.97
    assert np.sign(lh[0]) * np.sign(lh[2]) < 0


def test_contributions_add_up_exactly(built):
    payload, p = built
    for row in payload["contributions"]:
        total = (row["constant"] or 0) + sum(v or 0 for v in row["contributions"].values())
        assert total == pytest.approx(row["total"], abs=2e-3)
    # and the linear smoother reproduces the full smoother
    X, _ = ln.panel(syn.data(), ld.catalogue(), syn.LAST + 3)
    Z = ln.standardise(X, p)
    sm = ln.kalman_smooth(Z, p)
    np.testing.assert_allclose(ln.smooth_linear(Z, sm, p), sm.mean, atol=1e-9)


def test_scaling_and_fit(built):
    payload, p = built
    assert p.b > 0 and 0.2 < p.r2 < 1
    assert p.ids == ["agents_employment", "agents_recruitment", "dmp_realised", "dmp_expected", "payrolls", "vacancies"]
    s = pd.DataFrame(payload["series"]).set_index("month")
    est = s[s["kind"] == "estimate"]
    assert est["underlying"].corr(est["lfs"]) > 0.4
    assert (s["lo"] <= s["underlying"]).all() and (s["underlying"] <= s["hi"]).all()
    assert s.loc["2026-10", "kind"] == "projection" and s.loc["2020-06", "kind"] == "pandemic"
    LabourNowcast.model_validate({**payload, "runs": []})


def test_next_prints_and_unemployment_projection(built):
    payload, _ = built
    np_ = payload["next_prints"]
    lfs = np_["lfs_employment"]
    assert lfs["period"] == "2026-08" and lfs["latest_period"] == "2026-07" and lfs["release"] == "17 November 2026"
    assert lfs["lo"] < lfs["forecast"] < lfs["hi"]
    assert [u["period"] for u in np_["unemployment"]] == ["2026Q3", "2026Q4"]
    assert np_["unemployment"][1]["boe"] == {"report": "July 2026", "value": 5.1}
    # one step: employment and the labour force rolled forward from the latest LFS month
    mo = syn.data().monthly
    under = pd.DataFrame(payload["series"]).set_index("month")["underlying"]
    e, a = mo["lfs_employment"].dropna(), mo["lfs_active"].dropna()
    e2 = e.iloc[-1] * (1 + under["2026-08"] / 300) * (1 + under["2026-09"] / 300)
    a2 = a.iloc[-1] * (1 + np_["labour_force_growth"] / 300) ** 2
    assert np_["unemployment"][0]["projection"] == pytest.approx(100 * (1 - e2 / a2), abs=0.01)
    pay = np_["payrolls"]
    assert pay["period"] == "2026-10" and pay["lo_k"] < pay["change_k"] < pay["hi_k"]


def test_bank_companion_analyses(built):
    payload, _ = built
    g = payload["gdp_implied"]
    assert g["lags"] == 6 and g["latest_gdp_quarter"] == "2026Q2" and g["rows"][-1]["quarter"] == "2026Q3"
    sv = payload["svar"]
    assert sv["ok"] and sv["accepted"] > 0
    d, s = sv["impact"]["demand"], sv["impact"]["supply"]
    assert d[0] > 0 and d[1] > 0 and s[0] > 0 and s[1] < 0
    for r in sv["rows"]:
        assert r["baseline"] + r["demand"] + r["supply"] == pytest.approx(r["employment"], abs=1e-9)


def test_news_attributes_a_new_survey_reading():
    p0, params = ln.build("uk", syn.data(), syn.gdp(), None, True)
    p1, _ = ln.build("uk", syn.data({"dmp_expected": 6.0}), syn.gdp(), params, False)
    n = ln.news(p0, p1)
    assert n["same_model"] and n["month"] == "2026-09"
    moved = {k: v for k, v in n["by_indicator"].items() if abs(v or 0) > 1e-3}
    assert set(moved) == {"dmp_expected"} and moved["dmp_expected"] > 0
    assert sum(n["by_indicator"].values()) == pytest.approx(n["change"], abs=2e-3)


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def client():
    import main
    from auth import get_current_user
    main.app.dependency_overrides[get_current_user] = lambda: {"username": "t", "full_name": "T"}
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        yield TestClient(main.app)
    main.app.dependency_overrides.clear()


def _wait(client, kind: str, timeout: float = 120) -> dict:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        st = client.get("/api/tools/quant-macro/labour/uk/status").json()
        if st["jobs"][kind]["state"] != "running":
            return st
        time.sleep(0.3)
    raise AssertionError(f"{kind} still running")


def test_api_routes_and_jobs(client, state_dir):
    assert client.get("/api/tools/quant-macro/labour/atlantis").status_code == 404
    r = client.get("/api/tools/quant-macro/labour/uk")
    assert r.status_code == 200, r.text[:300]
    body = r.json()
    assert body["title"] == "UK Labour Market Nowcast" and (state_dir / "uk" / "model.json").exists()
    fitted = body["model"]["fitted_at"]
    assert client.get("/api/tools/quant-macro/labour/uk").json()["computed_at"] == body["computed_at"]
    client.post("/api/tools/quant-macro/labour/uk/refresh")
    st = _wait(client, "update")
    assert st["jobs"]["update"]["state"] == "done" and st["model_fitted_at"] == fitted       # same parameters
    body = client.get("/api/tools/quant-macro/labour/uk").json()
    assert body["news"]["same_model"] and body["news"]["change"] == 0 and len(body["runs"]) == 2
    client.post("/api/tools/quant-macro/labour/uk/refit")
    st = _wait(client, "refit")
    assert st["jobs"]["refit"]["state"] == "done" and st["model_fitted_at"] >= fitted
    # the GDP nowcast route is untouched
    assert client.get("/api/tools/quant-macro/uk-gdp/status").status_code == 200
    json.dumps(body)
