"""Regenerate the frontend fixtures for the Labour Market Nowcast page from synthetic inputs.

    cd backend && python scripts/make_labour_fixture.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import labour_nowcast as ln  # noqa: E402
from tests import labour_synthetic as syn  # noqa: E402

OUT = Path(__file__).resolve().parents[2] / "frontend" / "src" / "test" / "fixtures"


def main() -> None:
    p0, params = ln.build("uk", syn.data(), syn.gdp(), None, True)
    payload, _ = ln.build("uk", syn.data({"dmp_expected": 3.0}), syn.gdp(), params, False)
    for p in (p0, payload):
        p["computed_at"], p["as_of"] = "2026-10-22T09:00:00", "2026-10-22"
        p["model"]["fitted_at"] = "2026-10-22T08:59:00"
    p0["computed_at"] = "2026-10-21T09:00:00"
    payload["news"] = ln.news(p0, payload)
    payload["runs"] = [{"computed_at": "2026-10-21T09:00:00", "month": "2026-09", "underlying": p0["latest"]["underlying"], "fitted_at": "2026-10-22T08:59:00"},
                       {"computed_at": "2026-10-22T09:00:00", "month": "2026-09", "underlying": payload["latest"]["underlying"], "fitted_at": "2026-10-22T08:59:00"}]
    idle = {"state": "idle", "step": None, "started_at": None, "finished_at": None, "error": None}
    status = {"slug": "uk", "computed_at": payload["computed_at"], "as_of": payload["as_of"],
              "model_fitted_at": payload["model"]["fitted_at"], "model_data_through": payload["model"]["data_through"],
              "jobs": {"update": {"kind": "update", **idle}, "refit": {"kind": "refit", **idle}}}
    (OUT / "quant-macro-labour-uk.json").write_text(json.dumps(payload, indent=1), encoding="utf-8")
    (OUT / "quant-macro-labour-uk-status.json").write_text(json.dumps(status, indent=1), encoding="utf-8")
    print(f"wrote {OUT / 'quant-macro-labour-uk.json'}")


if __name__ == "__main__":
    main()
