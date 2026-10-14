"""
Write the API's OpenAPI schema to frontend/src/api/openapi.json, from which
the frontend generates its TypeScript types (npm run gen:api).

    cd backend && python scripts/export_openapi.py

backend/tests/test_openapi_snapshot.py fails when the committed file is stale.
"""
import json
import logging
import sys
import warnings
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
OUT = BACKEND.parent / "frontend" / "src" / "api" / "openapi.json"


def schema() -> dict:
    warnings.filterwarnings("ignore")
    logging.disable(logging.WARNING)
    import main  # noqa: PLC0415
    return main.app.openapi()


def render(spec: dict) -> str:
    return json.dumps(spec, indent=1, sort_keys=True) + "\n"


if __name__ == "__main__":
    OUT.write_text(render(schema()))
    print(f"wrote {OUT}")
