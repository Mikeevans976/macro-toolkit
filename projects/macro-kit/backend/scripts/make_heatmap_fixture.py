"""
Regenerate frontend/src/test/fixtures/heatmap-uk.json from the live heatmap
dashboard payload (trimmed: last 90 daily points, 3 groups x 3 indicators).

    cd backend && python scripts/make_heatmap_fixture.py
"""
import json
import sys
import warnings
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
warnings.filterwarnings("ignore")

from heatmap_regions import REGIONS  # noqa: E402
from regional_heatmap import RegionalHeatmap  # noqa: E402

N = 90
OUT = BACKEND.parent / "frontend" / "src" / "test" / "fixtures" / "heatmap-uk.json"


def _trim(obj):
    if isinstance(obj, dict):
        return {k: _trim(v) for k, v in obj.items()}
    if isinstance(obj, list) and len(obj) > N and not isinstance(obj[0], (dict, list)):
        return obj[-N:]
    if isinstance(obj, list):
        return [_trim(v) for v in obj]
    return obj


def main() -> None:
    d = _trim(dict(RegionalHeatmap(REGIONS["uk"]).get_dashboard(), region="uk"))
    d["indicators"]["groups"] = [dict(g, indicators=g["indicators"][:3]) for g in d["indicators"]["groups"][:3]]
    OUT.write_text(json.dumps(d, separators=(",", ":")))
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
