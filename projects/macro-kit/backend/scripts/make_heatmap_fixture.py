"""
Regenerate the frontend heatmap test fixtures from the simulated dashboard
payload (trimmed: last 90 daily points, 3 groups x 3 indicators):
heatmap-uk.json (DM shape) and heatmap-china.json (EM shape: Credit factor,
no breakeven).

    cd backend && python scripts/make_heatmap_fixture.py
"""
import json
import os
import sys
import warnings
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
warnings.filterwarnings("ignore")
os.environ["ANALYTICS_DATA_SOURCE"] = "csv"      # fixtures are always the simulated payload

from heatmap_regions import REGIONS  # noqa: E402
from regional_heatmap import RegionalHeatmap  # noqa: E402

N = 90
FIXTURES = BACKEND.parent / "frontend" / "src" / "test" / "fixtures"
REGIONS_OUT = ("uk", "china")


def _trim(obj):
    if isinstance(obj, dict):
        return {k: _trim(v) for k, v in obj.items()}
    if isinstance(obj, list) and len(obj) > N and not isinstance(obj[0], (dict, list)):
        return obj[-N:]
    if isinstance(obj, list):
        return [_trim(v) for v in obj]
    return obj


def main() -> None:
    for region in REGIONS_OUT:
        d = _trim(dict(RegionalHeatmap(REGIONS[region]).get_dashboard(), region=region))
        d["indicators"]["groups"] = [dict(g, indicators=g["indicators"][:3]) for g in d["indicators"]["groups"][:3]]
        out = FIXTURES / f"heatmap-{region}.json"
        out.write_text(json.dumps(d, separators=(",", ":")))
        print(f"wrote {out} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
