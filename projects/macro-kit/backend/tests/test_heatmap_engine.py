"""Regional heatmap engine: region-specific factor sets, config validation,
catalogue transforms, partial-panel live mode and curve-only scenarios
(the generalisation done for the EM regions, docs/EM_HEATMAPS_PLAN.md)."""
import dataclasses
import warnings

import numpy as np
import pandas as pd
import pytest

import heatmap_analytics as ha
import regional_heatmap as rh
from heatmap_regions import REGIONS
from regional_heatmap import RegionalHeatmap, _apply_transforms


def _dashboard(slug):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return RegionalHeatmap(REGIONS[slug]).get_dashboard()


# ---------------------------------------------------------------------------
# Config validation
# ---------------------------------------------------------------------------

def test_loadings_must_match_factor_set():
    cfg = REGIONS["china"]
    with pytest.raises(ValueError, match="yield_factor_loadings"):
        dataclasses.replace(cfg, yield_factor_loadings=np.zeros((len(cfg.yield_tenors), 5 + 1)))


def test_curve_legs_must_be_tenors():
    with pytest.raises(ValueError, match="curve legs"):
        dataclasses.replace(REGIONS["poland"], ultra_tenor="30y")


def test_pc1_pivot_must_be_long_tenor():
    with pytest.raises(ValueError, match="pca_pc1_pivot"):
        dataclasses.replace(REGIONS["uk"], pca_pc1_pivot=1)


def test_catalogue_factor_outside_config_is_rejected():
    # China's catalogue has a Credit group; a default (DM) factor set must refuse it
    cfg = REGIONS["china"]
    bad = dataclasses.replace(cfg, factors=list(rh.FACTOR_NAMES),
                              yield_factor_loadings=np.zeros((len(cfg.yield_tenors), 5)))
    with pytest.raises(ValueError, match="not in HeatmapConfig.factors"):
        RegionalHeatmap(bad)


# ---------------------------------------------------------------------------
# EM payloads (simulated data)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("slug", [s for s, c in REGIONS.items() if c.bloc == "em"])
def test_em_payload_follows_its_config(slug):
    cfg, d = REGIONS[slug], _dashboard(slug)
    assert list(d["factors"]["factors"]) == cfg.factors
    assert d["regressions"]["factor_names"] == cfg.factors
    assert len(d["regressions"]["pc1"]["beta"]) == len(cfg.factors)
    short, long = cfg.short_tenor[:-1], cfg.long_tenor[:-1]
    assert d["curve_regimes"][0]["name"] == f"{short}s{long}s"
    assert len(d["curve_regimes"]) == (2 if cfg.ultra_tenor else 1)
    assert d["fv_tenor"] == cfg.long_tenor and d["bloc"] == "em"
    if cfg.breakeven:
        assert d["breakeven"] is not None and d["scenarios"]["breakeven"] is not None
    else:
        assert d["breakeven"] is None and d["data_source"]["breakeven"] == "none"
        assert d["scenarios"]["current"]["breakeven"] is None


def test_korea_short_leg_in_fair_value_table():
    labels = [r["label"] for r in _dashboard("south-korea")["fair_value"]["curve_table"]]
    assert labels == ["3y", "5y", "10y", "30y", "3s10s", "5s30s"]


def test_curve_only_scenarios():
    n = 200
    rng = np.random.default_rng(0)
    long = 4 + np.cumsum(rng.normal(0, 0.03, n))
    short = 3 + np.cumsum(rng.normal(0, 0.03, n))
    dates = [str(d.date()) for d in pd.bdate_range("2024-01-01", periods=n)]
    sc = ha.scenario_section(ha.curve_regime_section(dates, long, short, "2s10s"), None)
    assert sc["breakeven"] is None and sc["current"]["breakeven"] is None
    assert sum(sc["current"]["curve"].values()) in (99, 100, 101)


# ---------------------------------------------------------------------------
# Catalogue transforms
# ---------------------------------------------------------------------------

def _monthly(values, start="2020-01"):
    return pd.Series(values, index=pd.period_range(start, periods=len(values), freq="M"), dtype=float)


def test_yoy_transform():
    s = _monthly(np.arange(100, 124))
    out = _apply_transforms({"x": s}, [{"id": "x", "frequency": "monthly", "transform": "yoy"}])["x"]
    assert len(out) == 12
    assert out.iloc[0] == pytest.approx((112 / 100 - 1) * 100)


def test_sum12_transform_and_untouched_series():
    s = _monthly(np.ones(15))
    meta = [{"id": "x", "frequency": "monthly", "transform": "sum12"}, {"id": "y", "frequency": "monthly"}]
    out = _apply_transforms({"x": s, "y": s}, meta)
    assert (out["x"] == 12).all() and len(out["x"]) == 4
    assert out["y"] is s


def test_transform_does_not_bridge_missing_months():
    # Jan 2021 missing: the yoy for Jan 2022 must not be computed against Dec 2020
    s = _monthly(np.arange(100, 125)).drop(pd.Period("2021-01", "M"))
    out = _apply_transforms({"x": s}, [{"id": "x", "frequency": "monthly", "transform": "yoy"}])["x"]
    assert pd.Period("2021-01", "M") not in out.index
    assert pd.Period("2022-01", "M") not in out.index


# ---------------------------------------------------------------------------
# Partial-panel live mode
# ---------------------------------------------------------------------------

def _fake_live(monkeypatch, cfg, drop=()):
    """Serve the region's own simulated indicators as if they came from a vendor."""
    monkeypatch.setenv("ANALYTICS_DATA_SOURCE", "simulation")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        sim = RegionalHeatmap(cfg)
    monthly = pd.PeriodIndex(sim.grid.monthly, freq="M")
    data = {sid: pd.Series(sim._indicator_monthly[:, m], index=monthly)
            for m, sid in enumerate(sim._macro_series_ids) if sid not in drop}
    monkeypatch.setenv("ANALYTICS_DATA_SOURCE", "csv")
    monkeypatch.setattr(RegionalHeatmap, "_fetch_macro_data", lambda self, a, b: data)
    return sim


def test_partial_panel_drops_dead_series(monkeypatch):
    cfg = REGIONS["mexico"]
    dead = ["mx_antad_sss", "mx_mfg_wages"]
    _fake_live(monkeypatch, cfg, drop=dead)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        e = RegionalHeatmap(cfg)
    assert e.macro_source == "live"
    assert e.missing_series == dead
    assert np.isfinite(e.FACTORS_SMOOTH).all()
    rows = {r["id"]: r for g in e.get_dashboard()["indicators"]["groups"] for r in g["indicators"]}
    assert all(z is None for z in rows["mx_antad_sss"]["zscores"])


def test_missing_primary_falls_back_to_simulation(monkeypatch):
    cfg = REGIONS["mexico"]
    _fake_live(monkeypatch, cfg, drop=["mx_core_cpi_yoy"])       # the Inflation primary
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        e = RegionalHeatmap(cfg)
    assert e.macro_source == "simulation" and e.missing_series == []
