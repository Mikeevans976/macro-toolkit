"""
Australia heatmap — thin wrapper around regional_heatmap.RegionalHeatmap.
All shared logic lives in regional_heatmap.py; only region-specific constants are here.
"""
import numpy as np
from regional_heatmap import HeatmapConfig, RegionalHeatmap

_CFG = HeatmapConfig(
    region="australia_heatmap",
    bond_name="ACGB",
    m_macro=42,
    catalogue_path="data/series_catalogue_au.json",
    gm_primary_series_id="au_pmi_manufacturing",
    yield_series_ids=["au_acgb_2y", "au_acgb_5y", "au_acgb_10y", "au_acgb_20y", "au_acgb_30y"],
    yield_tenors=["2y", "5y", "10y", "20y", "30y"],
    yield_means=np.array([3.80, 4.00, 4.35, 4.75, 4.80]),
    yield_factor_loadings=np.array([
        # GlobalMacro  Growth  Inflation  Employment  Wages
        [   0.10,       0.12,    0.46,      0.07,     0.09],  # 2y
        [   0.11,       0.14,    0.36,      0.06,     0.08],  # 5y
        [   0.12,       0.17,    0.27,      0.05,     0.07],  # 10y
        [   0.13,       0.20,    0.19,      0.05,     0.06],  # 20y
        [   0.14,       0.22,    0.15,      0.04,     0.05],  # 30y
    ]),
    yield_noise_factor=0.022,
    pca_pc1_pivot=2,   # index of "10y" in yield_tenors
    pca_pc2_pivot=4,   # index of "30y" (last tenor)
    pca_pc3_pivot=1,   # index of "5y"
    random_seed=22,
)

_h = RegionalHeatmap(_CFG)

# Re-export with original names so main.py is unchanged
get_au_daily_factors  = _h.get_daily_factors
get_au_fair_value     = _h.get_fair_value
get_au_yield_pca      = _h.get_yield_pca
get_au_pc_regressions = _h.get_pc_regressions
