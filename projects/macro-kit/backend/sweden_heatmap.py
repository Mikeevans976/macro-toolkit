"""
Sweden heatmap — thin wrapper around regional_heatmap.RegionalHeatmap.
All shared logic lives in regional_heatmap.py; only region-specific constants are here.
"""
import numpy as np
from regional_heatmap import HeatmapConfig, RegionalHeatmap

_CFG = HeatmapConfig(
    region="sweden_heatmap",
    bond_name="SGB",
    m_macro=40,
    catalogue_path="data/series_catalogue_se.json",
    gm_primary_series_id="se_silf_pmi_manufacturing",
    yield_series_ids=["se_sgb_2y", "se_sgb_5y", "se_sgb_10y", "se_sgb_20y", "se_sgb_30y"],
    yield_tenors=["2y", "5y", "10y", "20y", "30y"],
    yield_means=np.array([1.90, 2.10, 2.40, 2.70, 2.75]),
    yield_factor_loadings=np.array([
        # GlobalMacro  Growth  Inflation  Employment  Wages
        [   0.10,       0.12,    0.42,      0.06,     0.08],  # 2y
        [   0.11,       0.13,    0.33,      0.05,     0.07],  # 5y
        [   0.12,       0.16,    0.24,      0.05,     0.07],  # 10y
        [   0.13,       0.19,    0.17,      0.04,     0.06],  # 20y
        [   0.14,       0.21,    0.13,      0.04,     0.06],  # 30y
    ]),
    yield_noise_factor=0.018,
    pca_pc1_pivot=2,   # index of "10y" in yield_tenors
    pca_pc2_pivot=4,   # index of "30y" (last tenor)
    pca_pc3_pivot=1,   # index of "5y"
    random_seed=66,
)

_h = RegionalHeatmap(_CFG)

# Re-export with original names so main.py is unchanged
get_se_daily_factors  = _h.get_daily_factors
get_se_fair_value     = _h.get_fair_value
get_se_yield_pca      = _h.get_yield_pca
get_se_pc_regressions = _h.get_pc_regressions
