"""
Norway heatmap — thin wrapper around regional_heatmap.RegionalHeatmap.
All shared logic lives in regional_heatmap.py; only region-specific constants are here.
"""
import numpy as np
from regional_heatmap import HeatmapConfig, RegionalHeatmap

_CFG = HeatmapConfig(
    region="norway_heatmap",
    bond_name="NGB",
    m_macro=40,
    catalogue_path="data/series_catalogue_no.json",
    gm_primary_series_id="no_pmi_manufacturing",
    yield_series_ids=["no_ngb_2y", "no_ngb_5y", "no_ngb_10y", "no_ngb_20y", "no_ngb_30y"],
    yield_tenors=["2y", "5y", "10y", "20y", "30y"],
    yield_means=np.array([3.50, 3.70, 4.00, 4.30, 4.40]),
    yield_factor_loadings=np.array([
        # GlobalMacro  Growth  Inflation  Employment  Wages
        [   0.10,       0.12,    0.44,      0.06,     0.09],  # 2y
        [   0.11,       0.14,    0.34,      0.05,     0.08],  # 5y
        [   0.12,       0.16,    0.25,      0.05,     0.07],  # 10y
        [   0.13,       0.19,    0.17,      0.04,     0.06],  # 20y
        [   0.14,       0.21,    0.13,      0.04,     0.06],  # 30y
    ]),
    yield_noise_factor=0.020,
    pca_pc1_pivot=2,   # index of "10y" in yield_tenors
    pca_pc2_pivot=4,   # index of "30y" (last tenor)
    pca_pc3_pivot=1,   # index of "5y"
    random_seed=88,
)

_h = RegionalHeatmap(_CFG)

# Re-export with original names so main.py is unchanged
get_no_daily_factors  = _h.get_daily_factors
get_no_fair_value     = _h.get_fair_value
get_no_yield_pca      = _h.get_yield_pca
get_no_pc_regressions = _h.get_pc_regressions
