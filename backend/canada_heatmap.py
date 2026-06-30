"""
Canada heatmap — thin wrapper around regional_heatmap.RegionalHeatmap.
All shared logic lives in regional_heatmap.py; only region-specific constants are here.
"""
import numpy as np
from regional_heatmap import HeatmapConfig, RegionalHeatmap

_CFG = HeatmapConfig(
    region="canada_heatmap",
    bond_name="CanGov",
    m_macro=43,
    catalogue_path="data/series_catalogue_ca.json",
    gm_primary_series_id="ca_spglobal_composite_pmi",
    yield_series_ids=["ca_cangov_2y", "ca_cangov_5y", "ca_cangov_10y", "ca_cangov_20y", "ca_cangov_30y"],
    yield_tenors=["2y", "5y", "10y", "20y", "30y"],
    yield_means=np.array([3.10, 3.20, 3.40, 3.65, 3.60]),
    yield_factor_loadings=np.array([
        # GlobalMacro  Growth  Inflation  Employment  Wages
        [   0.10,       0.12,    0.45,      0.07,     0.09],  # 2y
        [   0.12,       0.14,    0.35,      0.06,     0.08],  # 5y
        [   0.13,       0.17,    0.26,      0.05,     0.07],  # 10y
        [   0.14,       0.20,    0.18,      0.05,     0.06],  # 20y
        [   0.15,       0.22,    0.14,      0.04,     0.06],  # 30y
    ]),
    yield_noise_factor=0.020,
    pca_pc1_pivot=2,   # index of "10y" in yield_tenors
    pca_pc2_pivot=4,   # index of "30y" (last tenor)
    pca_pc3_pivot=1,   # index of "5y"
    random_seed=55,
)

_h = RegionalHeatmap(_CFG)

# Re-export with original names so main.py is unchanged
get_ca_daily_factors  = _h.get_daily_factors
get_ca_fair_value     = _h.get_fair_value
get_ca_yield_pca      = _h.get_yield_pca
get_ca_pc_regressions = _h.get_pc_regressions
