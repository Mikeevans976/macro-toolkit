"""Regenerate the frontend fixtures for the debt sustainability page from synthetic inputs.

    cd backend && python scripts/make_dsa_fixture.py
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import debt_sustainability as ds  # noqa: E402
from tests import dsa_synthetic as syn  # noqa: E402

OUT = Path(__file__).resolve().parents[2] / "frontend" / "src" / "test" / "fixtures"


def main() -> None:
    ds.ROOT = Path(tempfile.mkdtemp())
    payload = ds.build_payload("uk", inputs=syn.inputs(move=0.8))
    payload["computed_at"] = "2026-10-21T09:00:00"
    status = {"slug": "uk", "computed_at": payload["computed_at"], "as_of": payload["as_of"],
              "job": {"kind": "update", "state": "idle", "step": None, "started_at": None, "finished_at": None, "error": None}}
    (OUT / "quant-macro-dsa-uk.json").write_text(json.dumps(payload, indent=1), encoding="utf-8")
    (OUT / "quant-macro-dsa-uk-status.json").write_text(json.dumps(status, indent=1), encoding="utf-8")
    print(f"wrote {OUT / 'quant-macro-dsa-uk.json'}")


if __name__ == "__main__":
    main()
