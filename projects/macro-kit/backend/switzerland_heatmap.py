"""
Switzerland heatmap — thin wrapper around regional_heatmap.RegionalHeatmap.
All shared logic lives in regional_heatmap.py; only region-specific constants are here.
"""
import numpy as np
from regional_heatmap import HeatmapConfig, RegionalHeatmap

_CFG = HeatmapConfig(
    region="switzerland_heatmap",
    bond_name="Confederation",
    m_macro=42,
    catalogue_path="data/series_catalogue_ch.json",
    gm_primary_series_id="ch_pmi_manufacturing",
    yield_series_ids=["ch_conf_2y", "ch_conf_5y", "ch_conf_10y", "ch_conf_20y", "ch_conf_30y"],
    yield_tenors=["2y", "5y", "10y", "20y", "30y"],
    yield_means=np.array([0.45, 0.60, 0.80, 1.10, 1.20]),
    yield_factor_loadings=np.array([
        # GlobalMacro  Growth  Inflation  Employment  Wages
        [   0.08,       0.10,    0.35,      0.05,     0.08],  # 2y
        [   0.09,       0.12,    0.27,      0.05,     0.07],  # 5y
        [   0.10,       0.14,    0.20,      0.04,     0.06],  # 10y
        [   0.11,       0.17,    0.14,      0.04,     0.05],  # 20y
        [   0.12,       0.19,    0.11,      0.03,     0.05],  # 30y
    ]),
    yield_noise_factor=0.012,
    pca_pc1_pivot=2,   # index of "10y" in yield_tenors
    pca_pc2_pivot=4,   # index of "30y" (last tenor)
    pca_pc3_pivot=1,   # index of "5y"
    random_seed=33,
)

_h = RegionalHeatmap(_CFG)

# Re-export with original names so main.py is unchanged
get_ch_daily_factors  = _h.get_daily_factors
get_ch_fair_value     = _h.get_fair_value
get_ch_yield_pca      = _h.get_yield_pca
get_ch_pc_regressions = _h.get_pc_regressions
