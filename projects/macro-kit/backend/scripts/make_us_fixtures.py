"""
Write the frontend test fixtures for the US Quant Macro pages (simulated data, fixed date):

    cd backend && python scripts/make_us_fixtures.py

  quant-macro-us-gdp.json       US GDP nowcast (quarterly target, FOMC SEP panel); the GDPNow
                                block is a small fixed sample so the test needs no download
  quant-macro-labour-us.json    US Labour Market Nowcast
"""
import dataclasses
import json
import os
import sys
import tempfile
import warnings
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
os.environ["ANALYTICS_DATA_SOURCE"] = "csv"
warnings.filterwarnings("ignore")

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

import labour_data as ld  # noqa: E402
import labour_nowcast as ln  # noqa: E402
import quant_macro as qm  # noqa: E402

AS_OF = pd.Timestamp("2026-10-22")
OUT = BACKEND.parent / "frontend" / "src" / "test" / "fixtures"
GDPNOW_SAMPLE = {
    "institution": "Federal Reserve Bank of Atlanta", "label": "GDPNow",
    "estimates": [{"published": d, "source": "GDPNow", "quarter": q, "value": v,
                   "url": "https://www.atlantafed.org/cqer/research/gdpnow", "note": None}
                  for d, q, v in (("2026-07-28", "2026Q2", 1.54), ("2026-10-02", "2026Q3", 3.78), ("2026-10-20", "2026Q3", 3.5))],
}


def write(name: str, obj) -> None:
    (OUT / name).write_text(json.dumps(obj, separators=(",", ":")) + "\n", encoding="utf-8")
    print("wrote", OUT / name)


def main() -> None:
    qm.ROOT = Path(tempfile.mkdtemp())
    qm.FETCH_PUBLIC = False
    spec = dataclasses.replace(qm.MODELS["us-gdp"], maxiter=60)
    m = qm.fit(spec, AS_OF, "csv")
    payload = qm.build_payload(m)
    # the GDPNow block as the payload builds it, from the fixed sample
    now = {r["quarter"]: r["nowcast"] for r in payload["quarters"]}
    est = [{**e, "actual": None} for e in GDPNOW_SAMPLE["estimates"]]
    latest = est[-1]
    payload["central_bank"] = {
        "institution": GDPNOW_SAMPLE["institution"], "label": "GDPNow", "estimates": est,
        "comparisons": [{"quarter": "2026Q3", "cb_value": latest["value"], "cb_published": latest["published"],
                         "cb_source": "GDPNow", "model_now": now["2026Q3"], "model_at_publication": now["2026Q3"],
                         "news_since": 0.0, "gap": round(now["2026Q3"] - latest["value"], 4)}],
    }
    write("quant-macro-us-gdp.json", payload)

    ln.ROOT = Path(tempfile.mkdtemp())
    gdp = pd.Series(np.random.default_rng(7).normal(0.5, 0.4, 118), index=pd.period_range("1997Q1", periods=118, freq="Q"))
    lp, _ = ln.build("us", ld.simulate_us(pd.Period("2026-09", "M")), gdp, None, True)
    lp["computed_at"], lp["as_of"], lp["runs"], lp["news"] = "2026-10-22T09:00:00", "2026-10-22", [], None
    lp["model"]["fitted_at"] = "2026-10-22T08:59:00"
    write("quant-macro-labour-us.json", lp)


if __name__ == "__main__":
    main()
