"""The committed OpenAPI schema (source of the generated frontend types) must
match the app. Regenerate with: cd backend && python scripts/export_openapi.py
then cd frontend && npm run gen:api."""
import importlib.util
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "export_openapi.py"


def test_openapi_snapshot_is_current():
    spec = importlib.util.spec_from_file_location("export_openapi", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod.OUT.read_text() == mod.render(mod.schema()), (
        "frontend/src/api/openapi.json is stale: run backend/scripts/export_openapi.py and npm run gen:api")
