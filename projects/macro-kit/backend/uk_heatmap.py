"""
UK heatmap — thin wrapper around regional_heatmap.RegionalHeatmap.
All shared logic lives in regional_heatmap.py; only region-specific constants are here.
"""
import numpy as np
from regional_heatmap import HeatmapConfig, RegionalHeatmap

_CFG = HeatmapConfig(
    region="uk_heatmap",
    bond_name="Gilt",
    m_macro=48,
    catalogue_path="data/series_catalogue_uk.json",
    gm_primary_series_id="uk_composite_pmi",
    yield_series_ids=["gilt_2y", "gilt_5y", "gilt_10y", "gilt_20y", "gilt_30y"],
    yield_tenors=["2y", "5y", "10y", "20y", "30y"],
    yield_means=np.array([4.20, 4.10, 4.50, 5.05, 5.20]),
    yield_factor_loadings=np.array([
        # GlobalMacro  Growth  Inflation  Employment  Wages
        [   0.12,       0.15,    0.45,      0.06,     0.08],  # 2y
        [   0.12,       0.14,    0.38,      0.05,     0.07],  # 5y
        [   0.13,       0.16,    0.30,      0.06,     0.08],  # 10y
        [   0.14,       0.20,    0.22,      0.05,     0.07],  # 20y
        [   0.15,       0.22,    0.18,      0.05,     0.06],  # 30y
    ]),
    yield_noise_factor=0.025,
    pca_pc1_pivot=2,   # index of "10y" in yield_tenors
    pca_pc2_pivot=4,   # index of "30y" (last tenor)
    pca_pc3_pivot=1,   # index of "5y"
    random_seed=99,
)

_h = RegionalHeatmap(_CFG)

# Re-export with original names so main.py is unchanged
get_uk_daily_factors  = _h.get_daily_factors
get_uk_fair_value     = _h.get_fair_value
get_uk_yield_pca      = _h.get_yield_pca
get_uk_pc_regressions = _h.get_pc_regressions
