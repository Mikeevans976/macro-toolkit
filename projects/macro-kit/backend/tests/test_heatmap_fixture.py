"""The frontend's heatmap test fixture must have the same shape as the live
dashboard payload, so the page is tested against what the API really sends.
Regenerate the fixture if this fails after an intentional payload change:
`cd backend && python scripts/make_heatmap_fixture.py`."""
import json
from pathlib import Path

FIXTURE = Path(__file__).resolve().parents[2] / "frontend" / "src" / "test" / "fixtures" / "heatmap-uk.json"


def _shape(obj):
    if isinstance(obj, dict):
        return {k: _shape(v) for k, v in sorted(obj.items())}
    if isinstance(obj, list):
        return [_shape(obj[0])] if obj else []
    return type(obj).__name__ if obj is not None else "null"


def test_fixture_matches_dashboard_payload_shape():
    from routers.heatmaps import heatmap_dashboard, Region
    live = heatmap_dashboard(Region("uk"))
    assert _shape(json.loads(FIXTURE.read_text())) == _shape(json.loads(json.dumps(live)))
