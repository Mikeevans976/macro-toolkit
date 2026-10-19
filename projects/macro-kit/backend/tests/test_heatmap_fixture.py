"""The frontend's heatmap test fixtures must have the same shape as the live
dashboard payload, so the page is tested against what the API really sends.
Regenerate the fixtures if this fails after an intentional payload change:
`cd backend && python scripts/make_heatmap_fixture.py`."""
import json
from pathlib import Path

import pytest

FIXTURES = Path(__file__).resolve().parents[2] / "frontend" / "src" / "test" / "fixtures"


def _shape(obj):
    if isinstance(obj, dict):
        return {k: _shape(v) for k, v in sorted(obj.items())}
    if isinstance(obj, list):
        return [_shape(obj[0])] if obj else []
    return type(obj).__name__ if obj is not None else "null"


@pytest.mark.parametrize("region", ["uk", "china"])
def test_fixture_matches_dashboard_payload_shape(region):
    from routers.heatmaps import heatmap_dashboard, Region
    live = heatmap_dashboard(Region(region))
    fixture = json.loads((FIXTURES / f"heatmap-{region}.json").read_text())
    assert _shape(fixture) == _shape(json.loads(json.dumps(live)))
