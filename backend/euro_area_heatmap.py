"""
Euro Area heatmap — thin wrapper around regional_heatmap.RegionalHeatmap.
All shared logic lives in regional_heatmap.py; only region-specific constants are here.
"""
import numpy as np
from regional_heatmap import HeatmapConfig, RegionalHeatmap

_CFG = HeatmapConfig(
    region="euro_area",
    bond_name="Bund",
    m_macro=60,
    catalogue_path=None,   # EA uses the default catalogue (no catalogue_path kwarg)
    gm_primary_series_id="ea_esi",
    yield_series_ids=[
        "bund_2y", "bund_3y", "bund_5y", "bund_7y",
        "bund_10y", "bund_15y", "bund_20y", "bund_30y",
    ],
    yield_tenors=["2y", "3y", "5y", "7y", "10y", "15y", "20y", "30y"],
    yield_means=np.array([2.45, 2.35, 2.28, 2.38, 2.44, 2.50, 2.56, 2.62]),
    yield_factor_loadings=np.array([
        # GlobalMacro  Growth  Inflation  Employment  Wages
        [   0.10,       0.12,    0.38,      0.03,     0.06],  # 2y
        [   0.10,       0.12,    0.38,      0.03,     0.06],  # 3y
        [   0.10,       0.12,    0.36,      0.04,     0.07],  # 5y
        [   0.10,       0.13,    0.33,      0.04,     0.07],  # 7y
        [   0.12,       0.15,    0.30,      0.05,     0.07],  # 10y
        [   0.13,       0.17,    0.26,      0.05,     0.07],  # 15y
        [   0.14,       0.19,    0.23,      0.05,     0.07],  # 20y
        [   0.15,       0.21,    0.20,      0.06,     0.07],  # 30y
    ]),
    yield_noise_factor=0.025,
    pca_pc1_pivot=4,   # index of "10y" in yield_tenors
    pca_pc2_pivot=7,   # index of "30y" (last tenor)
    pca_pc3_pivot=3,   # index of "7y"
    random_seed=42,
)

_h = RegionalHeatmap(_CFG)

# Re-export with original names so main.py is unchanged (no region prefix for EA)
get_daily_factors  = _h.get_daily_factors
get_fair_value     = _h.get_fair_value
get_yield_pca      = _h.get_yield_pca
get_pc_regressions = _h.get_pc_regressions
