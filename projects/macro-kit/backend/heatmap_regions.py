"""
Region registry for the regional macro heatmaps.

One ``HeatmapConfig`` per region, keyed by the URL slug used in
``/api/tools/heatmap/{region}/...``. Adding a region = adding an entry here
plus its ``data/series_catalogue_<region>.json``. The shared engine lives in
``regional_heatmap.py``.
"""
import numpy as np

from regional_heatmap import HeatmapConfig

REGIONS: dict[str, HeatmapConfig] = {
    "euro-area": HeatmapConfig(
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
        display_name="Euro Area",
        breakeven_mean=2.1,
    ),
    "uk": HeatmapConfig(
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
        display_name="United Kingdom",
        breakeven_mean=3.4,
    ),
    "us": HeatmapConfig(
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
        display_name="United States",
        breakeven_mean=2.3,
        real_yield_10y_series_id="us_tips_10y",
    ),
    "japan": HeatmapConfig(
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
        display_name="Japan",
        breakeven_mean=1.3,
    ),
    "canada": HeatmapConfig(
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
        display_name="Canada",
        breakeven_mean=1.9,
    ),
    "sweden": HeatmapConfig(
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
        display_name="Sweden",
        breakeven_mean=1.8,
        real_yield_10y_series_id="se_sgb_10y_real",
    ),
    "norway": HeatmapConfig(
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
        display_name="Norway",
        breakeven_mean=2.2,
        real_yield_10y_series_id="no_ngb_10y_real",
    ),
    "switzerland": HeatmapConfig(
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
        display_name="Switzerland",
        breakeven_mean=0.9,
    ),
    "australia": HeatmapConfig(
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
        display_name="Australia",
        breakeven_mean=2.4,
    ),
    "new-zealand": HeatmapConfig(
        region="new_zealand_heatmap",
        bond_name="NZGB",
        m_macro=42,
        catalogue_path="data/series_catalogue_nz.json",
        gm_primary_series_id="nz_pmi_manufacturing",
        yield_series_ids=["nz_nzgb_2y", "nz_nzgb_5y", "nz_nzgb_10y", "nz_nzgb_20y", "nz_nzgb_30y"],
        yield_tenors=["2y", "5y", "10y", "20y", "30y"],
        yield_means=np.array([4.00, 4.30, 4.60, 5.00, 5.10]),
        yield_factor_loadings=np.array([
            # GlobalMacro  Growth  Inflation  Employment  Wages
            [   0.10,       0.12,    0.47,      0.07,     0.09],  # 2y
            [   0.11,       0.14,    0.37,      0.06,     0.08],  # 5y
            [   0.12,       0.17,    0.28,      0.05,     0.07],  # 10y
            [   0.13,       0.20,    0.20,      0.05,     0.06],  # 20y
            [   0.14,       0.22,    0.16,      0.04,     0.05],  # 30y
        ]),
        yield_noise_factor=0.022,
        pca_pc1_pivot=2,   # index of "10y" in yield_tenors
        pca_pc2_pivot=4,   # index of "30y" (last tenor)
        pca_pc3_pivot=1,   # index of "5y"
        random_seed=11,
        display_name="New Zealand",
        breakeven_mean=2.2,
    ),
}
