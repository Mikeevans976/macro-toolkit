"""
Regional macro heatmap API — one router for every region in heatmap_regions.

    GET /api/tools/heatmap/{region}          every section of the page (one call)
    GET /api/tools/heatmap/{region}/{view}   one Block 1/Block 2 output

The backend is the single source of truth for the heatmap pages: the
frontend renders this payload and does no modelling of its own.
``region`` is a slug from ``heatmap_regions.REGIONS`` (e.g. ``uk``,
``euro-area``, ``new-zealand``); ``view`` is one of the four Block 1/Block 2
outputs below. The original per-region URLs (``/api/tools/uk-heatmap/factors``
…) are kept as hidden aliases.
"""
from __future__ import annotations

from enum import Enum
from typing import Callable

from fastapi import APIRouter, Depends

from auth import get_current_user
from heatmap_regions import REGIONS
from regional_heatmap import RegionalHeatmap
from schemas.heatmap import DailyFactors, FairValue, HeatmapDashboard, PCRegressions, YieldPCA

# Each engine precomputes its DFM + yield PCA on construction (~20 ms/region).
_ENGINES: dict[str, RegionalHeatmap] = {slug: RegionalHeatmap(cfg) for slug, cfg in REGIONS.items()}

Region = Enum("Region", {slug.replace("-", "_"): slug for slug in REGIONS}, type=str)


class View(str, Enum):
    factors = "factors"
    yield_pca = "yield-pca"
    pc_regressions = "pc-regressions"
    fair_value = "fair-value"


_VIEW_METHODS: dict[View, Callable[[RegionalHeatmap], object]] = {
    View.factors: RegionalHeatmap.get_daily_factors,          # daily macro factors (Block 1 DFM)
    View.yield_pca: RegionalHeatmap.get_yield_pca,            # yield PC scores, loadings, variance (Block 2)
    View.pc_regressions: RegionalHeatmap.get_pc_regressions,  # OLS of yield PCs on macro factors
    View.fair_value: RegionalHeatmap.get_fair_value,          # 10y actual, PCA recon, macro fair value
}

router = APIRouter(tags=["heatmaps"], dependencies=[Depends(get_current_user)])


@router.get("/api/tools/heatmap/{region}", response_model=HeatmapDashboard)
def heatmap_dashboard(region: Region):
    """Indicators, DFM factors, yield PCA, regressions, fair value, curve and
    breakeven regimes and scenario probabilities for one region."""
    return {**_ENGINES[region.value].get_dashboard(), "region": region.value}


@router.get("/api/tools/heatmap/{region}/{view}",
            response_model=DailyFactors | YieldPCA | PCRegressions | FairValue)
def heatmap_view(region: Region, view: View):
    """One output of a regional macro heatmap."""
    return _VIEW_METHODS[view](_ENGINES[region.value])


@router.get("/api/tools/{region}-heatmap/{view}", include_in_schema=False)
def heatmap_view_legacy(region: Region, view: View):
    """Legacy per-region URL, e.g. /api/tools/uk-heatmap/factors."""
    return heatmap_view(region, view)
