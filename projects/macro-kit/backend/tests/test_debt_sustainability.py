"""Debt sustainability monitor (debt_sustainability.py), its data readers (fiscal_data.py)
and the /api/tools/quant-macro/dsa routes.

Everything runs offline on synthetic inputs (tests/dsa_synthetic.py) and the OBR
forecast shipped in backend/data/obr/; saved state goes to a temporary directory.
"""
from __future__ import annotations

import io
import json
import time
import warnings

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

import debt_sustainability as ds
import fiscal_data as fd
from schemas.debt_sustainability import DebtSustainability
from tests import dsa_synthetic as syn


@pytest.fixture(scope="module", autouse=True)
def state_dir(tmp_path_factory):
    saved = ds.ROOT, ds.INPUTS
    ds.ROOT = tmp_path_factory.mktemp("dsa")
    ds.INPUTS = syn.inputs
    ds._payloads.clear()
    yield ds.ROOT
    ds.ROOT, ds.INPUTS = saved
    ds._payloads.clear()


@pytest.fixture(scope="module")
def payload() -> dict:
    return ds.build_payload("uk", inputs=syn.inputs())


@pytest.fixture(scope="module")
def payload_up() -> dict:
    """Every curve 1pp higher from April 2026 (after the OBR's January window)."""
    return ds.build_payload("uk", inputs=syn.inputs(move=1.0))


# ---------------------------------------------------------------------------
# Data readers
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("name,coupon", [
    ("4⅛% Treasury Gilt 2027", 4.125), ("0⅝% Index-linked Treasury Gilt 2045", 0.625),
    ("1 1/2% Treasury Gilt 2047", 1.5), ("3½% Treasury Gilt 2068", 3.5), ("Treasury Bill", None),
])
def test_coupon_from_name(name, coupon):
    assert fd.coupon_from_name(name) == coupon


def test_parse_gilt_register_csv_and_xml():
    csv = ("Gilts in Issue,,,\nAs at 20-Oct-2026,,,\n"
           "Gilt Name,ISIN Code,Redemption Date,Total Amount in Issue (£ million nominal),Total Amount including IL Uplift (£ million)\n"
           "4⅛% Treasury Gilt 2027,GB00TEST0001,22-Jul-2027,\"40,000\",\n"
           "0⅛% Index-linked Treasury Gilt 2031,GB00TEST0002,10-Aug-2031,\"30,000\",\"45,000\"\n")
    reg = fd.parse_gilt_register(csv.encode(), "D1A.csv")
    assert list(reg["coupon"]) == [4.125, 0.125]
    assert list(reg["index_linked"]) == [False, True]
    assert reg.loc[1, "uplifted"] == 45_000 and reg.loc[0, "nominal"] == 40_000
    assert reg.loc[0, "maturity"] == pd.Timestamp("2027-07-22")
    xml = ('<?xml version="1.0"?><root>'
           '<View_GILTS_IN_ISSUE INSTRUMENT_NAME="1¼% Treasury Gilt 2041" ISIN_CODE="GB00TEST0003" '
           'REDEMPTION_DATE="22/10/2041" TOTAL_AMOUNT_IN_ISSUE="35000" TOTAL_AMOUNT_INCLUDING_IL_UPLIFT="35000"/>'
           '</root>')
    reg = fd.parse_gilt_register(xml.encode(), "D1A.xml")
    assert reg.loc[0, "coupon"] == 1.25 and reg.loc[0, "maturity"].year == 2041
    with pytest.raises((ValueError, StopIteration)):
        fd.parse_gilt_register(b"nothing,here\n1,2\n", "junk.csv")


def test_read_pusf_flips_deficits_and_sums_fiscal_years(tmp_path):
    head = ['"Title","Net borrowing","Net debt"', '"CDID","J5II","CPOA"', '"PreUnit","",""', '"Unit","",""',
            '"Release Date","21-10-2026","21-10-2026"', '"Next release","20 November 2026","20 November 2026"',
            '"Important Notes","",""', '"2025","",""']
    months = pd.period_range("2025-04", "2026-05", freq="M")
    rows = [f'"{p.year} {p.strftime("%b").upper()}","-10","{80 + i}"' for i, p in enumerate(months)]
    path = tmp_path / "pusf.csv"
    path.write_text("\n".join(head + rows), encoding="latin-1")
    p = fd.read_pusf(path)
    assert p.release_date == pd.Timestamp("2026-10-21") and p.next_release == "20 November 2026"
    assert (p.monthly["psnb"] == 10).all()                      # deficits are positive
    fy = fd.fiscal_years(p.monthly)
    assert fy.loc[2025, "psnb"] == 120 and fy.loc[2025, "months"] == 12
    assert fy.loc[2025, "psnd_exboe_pct"] == 91                 # stocks at end-March
    assert fy.loc[2026, "months"] == 2


def test_shipped_obr_forecast_is_internally_consistent():
    efo = fd.load_efo(ds._root() / "uploads" / "obr")
    bn, pct, det = efo["bn"], efo["pct_gdp"], efo["determinants"]
    assert efo["edition"] == "March 2026" and efo["fiscal_cutoff"] == "30 January"
    for k in range(len(efo["years"])):
        assert bn["psnb"][k] == pytest.approx(bn["cbd"][k] + bn["net_investment"][k], abs=0.2)
        assert pct["psnb"][k] == pytest.approx(100 * bn["psnb"][k] / det["nominal_gdp_bn"][k], abs=0.06)
        assert pct["psnfl"][k] == pytest.approx(100 * bn["psnfl"][k] / det["nominal_gdp_centred_bn"][k], abs=0.06)
    assert ds.cutoff_date(efo) == pd.Timestamp("2026-01-30")


def test_parse_efo_text_reads_wrapped_rows_and_footnotes():
    years = "2024-252025-262026-27"
    text = "\n".join([
        "Economic and fiscal outlook – March 2026",
        "Table A.3: Determinants of the fiscal forecast", f"Outturn Forecast {years}",
        "Real GDP 1.5 1.2 1.3", "Nominal GDP1 5.2 4.1 3.6", "Nominal GDP (£ billion)1,2 2,934 3,055 3,164",
        "Nominal GDP (centred end-March £bn)1,3 3,011 3,099 3,220", "GDP deflator 4.0 3.2 2.0", "RPI 3.3 4.2 2.9",
        "CPI 2.4 3.4 2.0", "Bank Rate (per cent) 4.9 4.0 3.4", "Market gilt rates (per cent)9 4.3 4.4 4.5",
        "Table A.7: Total managed expenditure", years, "Central government debt interest, net of", "105.7 109.7 109.4", "APF1",
        "Table A.9: Fiscal aggregates", years,
        "Public sector current receipts (a) 38.8 40.4 41.2", "Total managed expenditure (b) 44.0 44.8 44.9",
        "Public sector net investment (d) 2.6 2.7 2.6", "Current budget deficit (c+e-a) 2.6 1.6 1.1",
        "Public sector net financial liabilities1 81.0 82.4 82.6", "Public sector net borrowing (b-a) 5.2 4.3 3.6",
        "Primary deficit 2.4 1.4 0.8", "Cyclically adjusted primary deficit 2.2 0.9 0.3",
        "Central government net cash requirement 6.1 4.8 4.4", "Public sector net debt1 93.2 94.3 94.8",
        "Public sector net debt ex Bank of England1 87.7 90.6 92.3", "£ billion",
        "Current budget deficit 76.7 49.2 33.9", "Public sector net investment 76.0 83.6 81.5",
        "Public sector net borrowing 152.7 132.7 115.5", "Public sector net financial liabilities 2,439 2,554 2,661",
        "Public sector net debt 2,805 2,922 3,053", "Public sector net debt ex Bank of England 2,639 2,808 2,971",
        "Net debt interest 82.2 90.0 89.0", "Non-interest receipts 1,095 1,194 1,261",
        "• A 1 percentage point change in gilt yields on debt issued across the forecast and Bank Rate expectations is "
        "estimated to lead to a change in PSNB by £15 billion in 2030-31.",
    ])
    e = fd.parse_efo_text(text)
    assert e["edition"] == "March 2026" and e["years"] == ["2024-25", "2025-26", "2026-27"]
    assert e["determinants"]["nominal_gdp_bn"] == [2934, 3055, 3164]
    assert e["determinants"]["gilt_rate"] == [4.3, 4.4, 4.5]
    assert e["bn"]["cg_debt_interest"] == [105.7, 109.7, 109.4]
    assert e["pct_gdp"]["psnd"] == [93.2, 94.3, 94.8] and e["pct_gdp"]["psnd_exboe"] == [87.7, 90.6, 92.3]
    assert e["bn"]["psnb"] == [152.7, 132.7, 115.5] and e["bn"]["psnfl"] == [2439, 2554, 2661]
    assert e["sensitivities"]["rates_1pp_bn"] == 15


def test_parse_curve_sheet():
    from datetime import datetime
    rows = [(None, "UK nominal spot curve"), ("Maturity",), ("years:", 0.5, 1.0, 1.5),
            ("#VALUE!", None, None, None), (datetime(2026, 10, 1), 4.1, "", 4.3), (datetime(2026, 10, 2), 4.0, 4.2, 4.4)]
    df = fd.parse_curve_sheet(rows)
    assert list(df.columns) == [0.5, 1.0, 1.5] and len(df) == 2
    assert np.isnan(df.iloc[0, 1]) and df.iloc[1, 2] == 4.4


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------

def _flat(level: float, date: str = "2026-10-20") -> ds.CurveSet:
    m = pd.Index([0.5, 5.0, 40.0])
    s = pd.Series(level, index=m)
    return ds.CurveSet(pd.Timestamp(date), s, s - 3, s - 1, s)


def test_flat_curves_give_flat_paths():
    cs = _flat(4.0)
    assert cs.fwd("nominal", 2.0, 12.0) == pytest.approx(4.0)
    realized = pd.Series({pd.Period("2026-05", "M"): 3.0})
    br = ds.bank_rate_path(cs, [2027, 2028], realized)
    assert br == pytest.approx([4.0, 4.0])
    assert ds.issue_yields(cs, [2027], 10.0) == pytest.approx([4.0])
    assert ds.inflation_shift(cs, _flat(4.0, "2026-01-30"), [2027]) == pytest.approx([0.0])
    # months before the curve date use the realised Bank Rate
    assert ds.bank_rate_path(cs, [2026], realized)[0] < 4.0


def _portfolio() -> ds.Portfolio:
    conv = pd.DataFrame({"amount": [100.0, 100.0, 100.0], "coupon": [2.0, 3.0, 4.0], "mat": [2026, 2028, 2040]})
    link = pd.DataFrame({"amount": [60.0], "coupon": [0.5], "mat": [2035]})
    return ds.Portfolio(pd.Timestamp("2026-09-30"), conv, link, bills=20.0, nsandi=30.0, reserves=50.0, apf=40.0,
                        apf_coupon=3.0, source="reconstructed", note="")


def test_interest_model_accounting():
    rules = fd.fiscal_rules()
    mix = rules["issuance_mix"]
    fys = [2026, 2027, 2028]
    rp = ds.rate_paths(_flat(4.0), fys, pd.Series(dtype=float), np.array([3.0, 3.0, 3.0]), mix)
    cgncr = np.array([10.0, 10.0, 10.0])
    apf = {"reduction_per_year_bn": 20.0, "average_price": 1.0}
    out = ds.run_interest(_portfolio(), fys, rp, cgncr, mix, apf)
    # first year: half a year on the gilt maturing in 2026, full years on the others
    redeem = 100 + 0.0
    need = 10 + redeem
    conv = 100 * 0.02 * 0.5 + 100 * 0.03 + 100 * 0.04 + need * (1 - mix["index_linked"]["share"] - mix["bills"]["share"]) * 0.04 * 0.5
    assert out["conventional"][0] == pytest.approx(conv)
    assert out["redemptions"][0] == pytest.approx(redeem) and out["gross_issuance"][0] == pytest.approx(need)
    floating = (20 + need * mix["bills"]["share"] / 2 + 30 + (50 - 20 / 2)) * 0.04
    assert out["floating"][0] == pytest.approx(floating)
    assert out["apf_offset"][0] == pytest.approx((40 - 10) * 0.03)
    assert out["total"][0] == pytest.approx(out["conventional"][0] + out["uplift"][0] + out["linker_coupon"][0]
                                            + out["floating"][0] - out["apf_offset"][0])


def test_linear_sensitivity_matches_the_interest_model():
    rules = fd.fiscal_rules()
    mix = rules["issuance_mix"]
    fys = list(range(2026, 2034))
    cgncr = np.full(len(fys), 50.0)
    rpi = np.full(len(fys), 3.0)

    def total(cs, r=rpi):
        rp = ds.rate_paths(cs, fys, pd.Series(dtype=float), r, mix)
        return ds.run_interest(_portfolio(), fys, rp, cgncr, mix, rules["apf"])
    base = total(_flat(4.0))
    sens = ds.sensitivity(base, mix)
    one = np.ones((1, len(fys)))
    lin = sens.interest(one, one, 0 * one)[0]
    up = total(_flat(5.0))["total"] - base["total"]
    np.testing.assert_allclose(lin, up, rtol=0.03, atol=0.15)
    lin_rpi = sens.interest(0 * one, 0 * one, one)[0]
    up_rpi = total(_flat(4.0), rpi + 1)["total"] - base["total"]
    np.testing.assert_allclose(lin_rpi, up_rpi, rtol=0.1, atol=0.3)


def test_decomposition_adds_up():
    rows = ds.decompose([2026, 2027], np.array([91.0, 92.5]), 90.0, 2700.0, np.array([2830.0, 2960.0]),
                        np.array([3110.0, 3200.0]), 3000.0, np.array([95.0, 100.0]), np.array([30.0, 10.0]))
    for r in rows:
        assert r["growth"] + r["interest"] + r["primary"] + r["other"] == pytest.approx(r["change"])
    assert rows[0]["growth"] == pytest.approx(90 * (3000 / 3110 - 1))


def test_obr_baseline_reproduces_the_obr():
    efo = fd.load_efo(ds._root() / "uploads" / "obr")
    b = ds.obr_baseline(efo, 2035, np.zeros(11))
    assert b.years[0] == 2025 and b.years[-1] == 2035 and b.obr_n == 6
    assert b.pct("psnfl")[:6] == pytest.approx(efo["pct_gdp"]["psnfl"][1:], abs=0.06)
    h = ds.rule_headroom(b, 2029)
    assert h["stability_bn"] == pytest.approx(23.6)
    assert h["investment_pp"] == pytest.approx(0.7, abs=0.06)
    # with no change in interest the market baseline is the OBR's
    assert ds.rule_headroom(ds.with_interest(b, np.zeros(11)), 2029) == h
    up = ds.with_interest(b, np.ones(11))
    assert ds.rule_headroom(up, 2029)["stability_bn"] == pytest.approx(22.6)
    assert up.psnfl[-1] - b.psnfl[-1] == pytest.approx(11)


def test_payload_validates_and_unchanged_markets_leave_headroom_almost_unchanged(payload):
    DebtSustainability.model_validate(payload)
    for r in payload["rules"]:
        assert r["obr_bn"] in (23.6, 26.5)
        assert abs(r["change_bn"]) < 1.0                     # only the passage of time
        assert sum(v for v in r["attribution"].values()) == pytest.approx(r["change_bn"], abs=0.15)
        assert abs(r["attribution"]["bank_rate"]) < 0.05 and abs(r["attribution"]["gilts"]) < 0.05
    fan = payload["fan"]["psnd_pct"]
    for row in fan:
        assert row["p5"] <= row["p25"] <= row["p50"] <= row["p75"] <= row["p95"]
    assert fan[-1]["p95"] - fan[-1]["p5"] > fan[1]["p95"] - fan[1]["p5"]       # uncertainty grows
    for key in ("stability", "investment", "both"):
        assert 0 <= payload["probabilities"][key] <= 1
    assert {s["id"] for s in payload["scenarios"]} >= {"rates_100", "replay_2022", "replay_2008"}
    for dyn in payload["dynamics"].values():
        for r in dyn:
            assert r["growth"] + r["interest"] + r["primary"] + r["other"] == pytest.approx(r["change"], abs=0.03)


def test_higher_rates_cut_headroom(payload, payload_up):
    base = {r["id"]: r for r in payload["rules"]}
    for r in payload_up["rules"]:
        assert r["market_bn"] < base[r["id"]]["market_bn"] - 10
        assert r["attribution"]["gilts"] < 0 and r["attribution"]["bank_rate"] < 0
        assert sum(r["attribution"].values()) == pytest.approx(r["change_bn"], abs=0.15)
        assert len(r["history"]) > 10 and r["history"][-1]["value"] == pytest.approx(r["market_bn"], abs=0.15)
    assert payload_up["probabilities"]["stability"] < payload["probabilities"]["stability"]
    rates = {s["id"]: s for s in payload["scenarios"]}["rates_100"]
    base_stab = base["stability"]["market_bn"]
    assert rates["stability_bn"] < base_stab - 5


def test_tracker_and_financing(payload):
    t = payload["tracker"]
    assert t["year"] == "2026-27" and t["months_observed"] == 6 and len(t["months"]) == 12
    assert t["months"][0]["month"] == "2026-04" and t["months"][-1]["current"] is None
    assert t["ytd_bn"] == pytest.approx(sum(m["current"] for m in t["months"][:6]), abs=0.3)
    assert t["obr_full_year_bn"] == 115.5 and t["next_month"] == "2026-10"
    f = payload["financing"]
    assert f["linker_share"] == pytest.approx(0.24, abs=0.005)
    assert sum(r["conventional"] + r["index_linked"] for r in f["profile"]) == pytest.approx(f["gilts_bn"], rel=0.01)
    assert payload["sources"]["register_source"] == "reconstructed"


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


def _wait(client, timeout: float = 120) -> dict:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        st = client.get("/api/tools/quant-macro/dsa/uk/status").json()
        if st["job"]["state"] != "running":
            return st
        time.sleep(0.3)
    raise AssertionError("refresh still running")


def test_api_routes_upload_and_refresh(client, state_dir):
    assert client.get("/api/tools/quant-macro/dsa/atlantis").status_code == 404
    r = client.get("/api/tools/quant-macro/dsa/uk")                 # first use: computed and saved
    assert r.status_code == 200, r.text[:300]
    body = r.json()
    assert body["title"] == "UK Debt Sustainability" and (state_dir / "uk" / "payload.json").exists()
    assert client.get("/api/tools/quant-macro/dsa/uk").json()["computed_at"] == body["computed_at"]
    # the nowcast routes are untouched
    assert client.get("/api/tools/quant-macro/dsa").status_code == 404

    csv = ("Gilt Name,ISIN Code,Redemption Date,Total Amount in Issue (£ million nominal)\n"
           "4% Treasury Gilt 2030,GB00TEST0004,22-Oct-2030,\"500,000\"\n"
           "2% Treasury Gilt 2045,GB00TEST0005,22-Oct-2045,\"1,500,000\"\n"
           "0½% Index-linked Treasury Gilt 2040,GB00TEST0006,22-Mar-2040,\"400,000\"\n")
    r = client.post("/api/tools/quant-macro/dsa/uk/upload", files={"file": ("D1A.csv", io.BytesIO(csv.encode()), "text/csv")})
    assert r.status_code == 200, r.text[:300]
    assert r.json()["kind"] == "dmo" and "3 gilts" in r.json()["detail"]
    st = _wait(client)
    assert st["job"]["state"] == "done", st["job"]["error"]
    body = client.get("/api/tools/quant-macro/dsa/uk").json()
    assert body["sources"]["register_source"] == "dmo" and body["financing"]["gilts_bn"] == pytest.approx(2400, abs=1)

    r = client.post("/api/tools/quant-macro/dsa/uk/upload", files={"file": ("x.csv", io.BytesIO(b"a,b\n1,2\n"), "text/csv")})
    assert r.status_code == 422
    assert client.post("/api/tools/quant-macro/dsa/uk/refresh").json()["job"]["state"] in ("running", "done")
    assert _wait(client)["job"]["state"] == "done"
    json.dumps(body)
