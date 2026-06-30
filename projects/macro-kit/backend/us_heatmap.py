"""
US heatmap — thin wrapper around regional_heatmap.RegionalHeatmap.
All shared logic lives in regional_heatmap.py; only region-specific constants are here.
"""
import numpy as np
from regional_heatmap import HeatmapConfig, RegionalHeatmap

_CFG = HeatmapConfig(
    region="us_heatmap",
    bond_name="UST",
    m_macro=56,
    catalogue_path="data/series_catalogue_us.json",
    gm_primary_series_id="us_spglobal_composite_pmi",
    yield_series_ids=["us_ust_2y", "us_ust_5y", "us_ust_10y", "us_ust_20y", "us_ust_30y"],
    yield_tenors=["2y", "5y", "10y", "20y", "30y"],
    yield_means=np.array([4.00, 4.15, 4.48, 4.85, 4.75]),
    yield_factor_loadings=np.array([
        # GlobalMacro  Growth  Inflation  Employment  Wages
        [   0.10,       0.12,    0.50,      0.08,     0.10],  # 2y
        [   0.12,       0.14,    0.40,      0.06,     0.08],  # 5y
        [   0.13,       0.18,    0.28,      0.06,     0.08],  # 10y
        [   0.14,       0.22,    0.20,      0.05,     0.06],  # 20y
        [   0.15,       0.24,    0.16,      0.05,     0.06],  # 30y
    ]),
    yield_noise_factor=0.025,
    pca_pc1_pivot=2,   # index of "10y" in yield_tenors
    pca_pc2_pivot=4,   # index of "30y" (last tenor)
    pca_pc3_pivot=1,   # index of "5y"
    random_seed=42,
)

_h = RegionalHeatmap(_CFG)

# Re-export with original names so main.py is unchanged
get_us_daily_factors  = _h.get_daily_factors
get_us_fair_value     = _h.get_fair_value
get_us_yield_pca      = _h.get_yield_pca
get_us_pc_regressions = _h.get_pc_regressions
