"""
Region registry for the regional macro heatmaps.

One ``HeatmapConfig`` per region, keyed by the URL slug used in
``/api/tools/heatmap/{region}/...``. Adding a region = adding an entry here
plus its ``data/series_catalogue_<region>.json``. The shared engine lives in
``regional_heatmap.py``.
"""
import zlib

import numpy as np

from regional_heatmap import FACTOR_NAMES, HeatmapConfig

# Simulated factor → yield loadings for the EM regions, (front, back) of the curve,
# interpolated across tenors. Only used when live yields are unavailable.
_EM_LOADING_ENDS = {
    "Global Macro": (0.10, 0.15), "Growth": (0.12, 0.22), "Inflation": (0.50, 0.18),
    "Employment": (0.07, 0.04), "Wages": (0.09, 0.05), "External": (0.10, 0.08), "Credit": (0.12, 0.08),
}


def _em_loadings(n_tenors: int, factors: list[str]) -> np.ndarray:
    w = np.linspace(0.0, 1.0, n_tenors)[:, None]
    front = np.array([_EM_LOADING_ENDS[f][0] for f in factors])
    back = np.array([_EM_LOADING_ENDS[f][1] for f in factors])
    return front + w * (back - front)


def _em(slug: str, cc: str, *, display_name: str, bond_name: str, m_macro: int, gm: str,
        tenors: list[str], yield_means: list[float], factors: list[str] = FACTOR_NAMES,
        short: str = "2y", ultra: str | None = "30y", pc3: str = "5y", breakeven: bool = False,
        real_10y: str | None = None, breakeven_10y: str | None = None,
        breakeven_mean: float = 3.0) -> HeatmapConfig:
    """An EM region: catalogue data/series_catalogue_<cc>.json, yields <cc>_govt_<tenor>."""
    factors = list(factors)
    last = tenors[-1]
    return HeatmapConfig(
        region=f"{slug.replace('-', '_')}_heatmap",
        bond_name=bond_name,
        m_macro=m_macro,
        catalogue_path=f"data/series_catalogue_{cc}.json",
        gm_primary_series_id=gm,
        yield_series_ids=[f"{cc}_govt_{t}" for t in tenors],
        yield_tenors=tenors,
        yield_means=np.array(yield_means),
        yield_factor_loadings=_em_loadings(len(tenors), factors),
        yield_noise_factor=0.03,
        pca_pc1_pivot=tenors.index("10y"),
        pca_pc2_pivot=tenors.index(ultra or last),
        pca_pc3_pivot=tenors.index(pc3),
        random_seed=zlib.crc32(slug.encode()),
        display_name=display_name,
        breakeven_mean=breakeven_mean,
        real_yield_10y_series_id=real_10y,
        breakeven_10y_series_id=breakeven_10y,
        factors=factors,
        short_tenor=short,
        ultra_tenor=ultra,
        breakeven=breakeven,
        bloc="em",
    )


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
    # ── Emerging markets (docs/EM_HEATMAPS_PLAN.md) ─────────────────────────
    "mexico": _em(
        "mexico", "mx", display_name="Mexico", bond_name="Mbono", m_macro=30, gm="mx_igae_yoy",
        tenors=["2y", "3y", "5y", "10y", "20y", "30y"], yield_means=[7.4, 7.9, 8.5, 9.4, 9.8, 9.9],
        breakeven=True, real_10y="mx_udibono_10y", breakeven_mean=4.0,
    ),
    "china": _em(
        "china", "cn", display_name="China", bond_name="CGB", m_macro=28, gm="cn_nbs_pmi_mfg",
        factors=["Global Macro", "Growth", "Inflation", "Employment", "Credit"],
        tenors=["1y", "2y", "5y", "7y", "10y", "30y"], yield_means=[1.2, 1.3, 1.5, 1.6, 1.8, 2.1],
    ),
    "india": _em(
        "india", "in", display_name="India", bond_name="G-sec", m_macro=15, gm="in_ip_yoy",
        factors=["Global Macro", "Growth", "Inflation", "External"],
        tenors=["2y", "5y", "10y", "15y", "30y"], yield_means=[6.8, 7.1, 7.3, 7.5, 7.7],
    ),
    "brazil": _em(
        "brazil", "br", display_name="Brazil", bond_name="NTN-F", m_macro=23, gm="br_ibc_br_yoy",
        tenors=["1y", "2y", "3y", "5y", "7y", "10y"], yield_means=[12.5, 12.3, 12.4, 12.6, 12.8, 12.9],
        ultra=None, breakeven=True, real_10y="br_ntnb_10y", breakeven_mean=5.8,
    ),
    "south-korea": _em(
        "south-korea", "kr", display_name="South Korea", bond_name="KTB", m_macro=18, gm="kr_exports_yoy",
        factors=["Global Macro", "Growth", "Inflation", "Employment", "External"],
        tenors=["3y", "5y", "10y", "20y", "30y"], yield_means=[3.0, 3.1, 3.3, 3.3, 3.2],
        short="3y", breakeven=True, breakeven_10y="kr_breakeven_10y", breakeven_mean=2.5,
    ),
    "south-africa": _em(
        "south-africa", "za", display_name="South Africa", bond_name="SAGB", m_macro=17, gm="za_absa_pmi",
        tenors=["2y", "5y", "10y", "20y", "30y"], yield_means=[7.9, 8.4, 9.3, 9.9, 9.9],
        breakeven=True, real_10y="za_ilb_10y", breakeven_mean=5.0,
    ),
    "poland": _em(
        "poland", "pl", display_name="Poland", bond_name="POLGB", m_macro=14, gm="pl_ip_yoy",
        tenors=["2y", "3y", "5y", "7y", "10y"], yield_means=[4.9, 5.1, 5.4, 5.6, 5.8], ultra=None,
    ),
    "indonesia": _em(
        "indonesia", "id", display_name="Indonesia", bond_name="INDOGB", m_macro=13, gm="id_retail_sales_yoy",
        factors=["Global Macro", "Growth", "Inflation", "External"],
        tenors=["2y", "5y", "10y", "20y", "30y"], yield_means=[6.5, 6.7, 6.9, 7.0, 7.1],
    ),
    "hungary": _em(
        "hungary", "hu", display_name="Hungary", bond_name="HGB", m_macro=14, gm="hu_ip_yoy",
        tenors=["2y", "3y", "5y", "10y", "15y"], yield_means=[5.4, 5.5, 5.6, 5.4, 5.3], ultra="15y",
    ),
    "czech-republic": _em(
        "czech-republic", "cz", display_name="Czech Republic", bond_name="CZGB", m_macro=14, gm="cz_ip_yoy",
        tenors=["2y", "5y", "10y", "20y", "30y"], yield_means=[4.2, 4.7, 5.2, 5.7, 5.9],
    ),
    "romania": _em(
        "romania", "ro", display_name="Romania", bond_name="ROMGB", m_macro=11, gm="ro_ip_yoy",
        tenors=["2y", "3y", "5y", "7y", "10y"], yield_means=[6.6, 6.7, 6.8, 6.9, 7.0], ultra=None,
    ),
    "turkey": _em(
        "turkey", "tr", display_name="Turkey", bond_name="TURKGB", m_macro=13, gm="tr_ip_yoy",
        factors=["Global Macro", "Growth", "Inflation", "Employment"],
        tenors=["2y", "3y", "5y", "7y", "10y"], yield_means=[35.6, 35.4, 34.6, 33.6, 32.8], ultra=None,
    ),
    "israel": _em(
        "israel", "il", display_name="Israel", bond_name="ILGOV", m_macro=11, gm="il_ip_yoy",
        factors=["Global Macro", "Growth", "Inflation", "Employment"],
        tenors=["2y", "5y", "10y", "20y", "30y"], yield_means=[3.4, 3.7, 4.1, 4.5, 4.6],
        breakeven=True, real_10y="il_cpi_linked_10y", breakeven_mean=2.2,
    ),
    "chile": _em(
        "chile", "cl", display_name="Chile", bond_name="BTP", m_macro=14, gm="cl_imacec_yoy",
        tenors=["2y", "3y", "5y", "7y", "10y"], yield_means=[5.1, 5.4, 5.9, 6.1, 6.1], ultra=None,
        breakeven=True, real_10y="cl_bcu_10y", breakeven_mean=3.4,
    ),
    "colombia": _em(
        "colombia", "co", display_name="Colombia", bond_name="TES", m_macro=9, gm="co_ip_yoy",
        factors=["Global Macro", "Growth", "Inflation", "Employment"],
        tenors=["2y", "5y", "10y", "20y", "30y"], yield_means=[12.2, 12.9, 13.1, 13.0, 13.4],
    ),
    "peru": _em(
        "peru", "pe", display_name="Peru", bond_name="Soberano", m_macro=11, gm="pe_activity_yoy",
        factors=["Global Macro", "Growth", "Inflation", "Employment"],
        tenors=["2y", "5y", "10y", "20y", "30y"], yield_means=[4.2, 5.1, 6.8, 6.8, 6.9],
    ),
    "thailand": _em(
        "thailand", "th", display_name="Thailand", bond_name="ThaiGB", m_macro=9, gm="th_private_consumption_yoy",
        factors=["Global Macro", "Growth", "Inflation", "Employment"],
        tenors=["2y", "5y", "10y", "20y", "30y"], yield_means=[1.3, 1.8, 2.4, 3.2, 3.4],
    ),
    "malaysia": _em(
        "malaysia", "my", display_name="Malaysia", bond_name="MGS", m_macro=11, gm="my_ip_yoy",
        tenors=["2y", "5y", "10y", "20y", "30y"], yield_means=[3.4, 3.7, 4.0, 4.3, 4.3],
    ),
    "philippines": _em(
        "philippines", "ph", display_name="Philippines", bond_name="RPGB", m_macro=9, gm="ph_manuf_volume_yoy",
        factors=["Global Macro", "Growth", "Inflation", "Employment"],
        tenors=["2y", "5y", "10y", "20y", "30y"], yield_means=[7.1, 7.7, 8.0, 8.4, 8.4],
    ),
    "taiwan": _em(
        "taiwan", "tw", display_name="Taiwan", bond_name="TGB", m_macro=11, gm="tw_export_orders_yoy",
        factors=["Global Macro", "Growth", "Inflation", "Employment", "Wages", "External"],
        tenors=["2y", "5y", "10y", "20y", "30y"], yield_means=[1.8, 1.9, 2.1, 2.2, 2.3],
    ),
}
