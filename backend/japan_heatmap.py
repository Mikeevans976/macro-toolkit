"""
Japan heatmap — thin wrapper around regional_heatmap.RegionalHeatmap.
All shared logic lives in regional_heatmap.py; only region-specific constants are here.
"""
import numpy as np
from regional_heatmap import HeatmapConfig, RegionalHeatmap

_CFG = HeatmapConfig(
    region="japan_heatmap",
    bond_name="JGB",
    m_macro=44,
    catalogue_path="data/series_catalogue_jp.json",
    gm_primary_series_id="jp_jibun_composite_pmi",
    yield_series_ids=["jp_jgb_2y", "jp_jgb_5y", "jp_jgb_10y", "jp_jgb_20y", "jp_jgb_30y"],
    yield_tenors=["2y", "5y", "10y", "20y", "30y"],
    yield_means=np.array([0.70, 1.10, 1.55, 2.30, 2.75]),
    yield_factor_loadings=np.array([
        # GlobalMacro  Growth  Inflation  Employment  Wages
        [   0.08,       0.10,    0.35,      0.05,     0.12],  # 2y
        [   0.10,       0.12,    0.28,      0.05,     0.10],  # 5y
        [   0.12,       0.15,    0.22,      0.05,     0.10],  # 10y
        [   0.13,       0.18,    0.16,      0.04,     0.08],  # 20y
        [   0.14,       0.20,    0.12,      0.04,     0.08],  # 30y
    ]),
    yield_noise_factor=0.015,
    pca_pc1_pivot=2,   # index of "10y" in yield_tenors
    pca_pc2_pivot=4,   # index of "30y" (last tenor)
    pca_pc3_pivot=1,   # index of "5y"
    random_seed=77,
)

_h = RegionalHeatmap(_CFG)

# Re-export with original names so main.py is unchanged
get_jp_daily_factors  = _h.get_daily_factors
get_jp_fair_value     = _h.get_fair_value
get_jp_yield_pca      = _h.get_yield_pca
get_jp_pc_regressions = _h.get_pc_regressions
