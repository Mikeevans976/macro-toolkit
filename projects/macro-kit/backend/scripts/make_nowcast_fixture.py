"""
Write the frontend test fixtures for the Quant Macro page from the simulated
UK GDP model, as of a fixed date:

    cd backend && python scripts/make_nowcast_fixture.py

Rerun after an intentional change to the payload (schemas/quant_macro.py).
The backtest fixture covers a short window to keep it small.
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

import pandas as pd  # noqa: E402

import quant_macro as qm  # noqa: E402

AS_OF = pd.Timestamp("2026-10-19")
OUT = BACKEND.parent / "frontend" / "src" / "test" / "fixtures"


def main() -> None:
    qm.ROOT = Path(tempfile.mkdtemp())          # never touch var/quant_macro
    spec = dataclasses.replace(qm.MODELS["uk-gdp"], backtest_from="2022Q1")
    m = qm.fit(spec, AS_OF, "csv")
    status = {**qm.get_status("uk-gdp"), "model_fitted_at": m.state["fitted_at"],
              "model_data_as_of": m.state["data_as_of"]}
    for name, payload in (("quant-macro-uk-gdp.json", qm.build_payload(m)),
                          ("quant-macro-uk-gdp-backtest.json", qm.build_backtest(spec, m.panel, AS_OF)),
                          ("quant-macro-uk-gdp-status.json", status)):
        (OUT / name).write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
        print("wrote", OUT / name)


if __name__ == "__main__":
    main()
