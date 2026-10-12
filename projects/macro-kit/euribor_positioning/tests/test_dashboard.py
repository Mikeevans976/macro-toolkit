"""
Stage 8 tests — Dashboard panels and diagnostics (§9.1, §9.2).

Acceptance test: Visual review — all six dashboard panels compute with correct
structure, complete columns, and values in sensible ranges.
"""

from __future__ import annotations

import datetime
import json
import math

import numpy as np
import pandas as pd
import pytest

from ..data.db import connect, init_db, load_params, next_business_day
from ..data.contract_calendar import generate_contracts
from ..data.ingest_ice_eod import simulate_eod_data
from ..outputs.dashboard import (
    panel_dv01_by_bucket,
    panel_crowding,
    panel_centre_of_gravity,
    panel_quadrant_mix,
    panel_curve_positioning,
    panel_cot_reconciliation,
    build_dashboard,
)
from ..outputs.diagnostics import (
    diagnostic_estimator_quality,
    diagnostic_price_impact,
    diagnostic_conditional_returns,
)


# ---------------------------------------------------------------------------
# Shared DB fixture with spread injection and planted COT
# ---------------------------------------------------------------------------

def _plant_cot(conn, start_date, end_date, params, seed=42):
    """Plant COT net positions for all categories (simple version)."""
    rng = np.random.default_rng(seed)
    categories = ["investment_firms", "commercial", "other_financial", "other"]

    # Collect business days
    n_days = (end_date - start_date).days + 1
    all_dates = [
        start_date + datetime.timedelta(days=i)
        for i in range(n_days)
        if (start_date + datetime.timedelta(days=i)).weekday() < 5
    ]
    fridays = [d for d in all_dates if d.weekday() == 4]

    for cat in categories:
        base = 500_000 + rng.integers(-100_000, 100_000)
        trend = float(rng.normal(0, 50_000))
        for i, friday in enumerate(fridays):
            net_pos = int(base + trend * math.sin(i * 0.1) + rng.normal(0, 20_000))
            longs = int(max(1, 500_000 + net_pos // 2))
            shorts = int(max(1, 500_000 - net_pos // 2))
            spread = 50_000
            tuesday = friday - datetime.timedelta(days=3)
            conn.execute(
                """INSERT OR REPLACE INTO cot_obs
                   (report_date, publication_date, category,
                    long_positions, short_positions, spreading, n_traders)
                   VALUES (?,?,?,?,?,?,?)""",
                (tuesday.isoformat(), friday.isoformat(), cat,
                 longs, shorts, spread, 80),
            )


@pytest.fixture(scope="module")
def tmp_db(tmp_path_factory):
    """
    2-year EOD simulation with planted COT.
    Returns (conn, params, start_date, end_date, as_of_date).
    """
    tmp_path = tmp_path_factory.mktemp("dashboard_db")
    db_path = tmp_path / "test_dashboard.db"
    params = load_params()
    params["database"]["path"] = str(db_path)

    init_db(db_path)

    contracts = generate_contracts(
        root=params["contracts"]["euribor_root"],
        start_year=2022,
        end_year=2027,
        include_serials=False,
    )
    with connect(db_path) as conn:
        conn.executemany(
            """INSERT OR IGNORE INTO contracts
               (contract_id, root, expiry_date, last_trading_day, contract_type, listing_date)
               VALUES (:contract_id, :root, :expiry_date, :last_trading_day,
                       :contract_type, :listing_date)""",
            contracts,
        )

    start = datetime.date(2023, 1, 3)
    end = datetime.date(2024, 12, 31)
    simulate_eod_data(start, end, contracts, params, db_path=db_path, seed=42)

    with connect(db_path) as conn:
        _plant_cot(conn, start, end, params, seed=7)

    as_of = datetime.date(2024, 12, 31)
    return db_path, params, start, end, as_of


# ---------------------------------------------------------------------------
# Helper to open a fresh connection per test
# ---------------------------------------------------------------------------

def _conn(tmp_db):
    db_path = tmp_db[0]
    return connect(db_path)


# ---------------------------------------------------------------------------
# 1. test_panel_dv01_structure
# ---------------------------------------------------------------------------

def test_panel_dv01_structure(tmp_db):
    db_path, params, start, end, as_of = tmp_db
    with connect(db_path) as conn:
        result = panel_dv01_by_bucket(conn, as_of, params)

    assert "as_of_date" in result
    assert "buckets" in result
    assert "total_net_dv01_eur" in result
    assert "total_zscore_1y" in result
    assert "total_zscore_3y" in result

    for bucket in ("whites", "reds", "greens", "blues"):
        assert bucket in result["buckets"]
        b = result["buckets"][bucket]
        assert "net_dv01_eur" in b
        assert "zscore_1y" in b
        assert "zscore_3y" in b
        assert "history" in b
        assert len(b["history"]) > 0, f"History for {bucket} is empty"

    # All history entries have required keys
    hist = result["buckets"]["whites"]["history"]
    for entry in hist[:3]:
        assert "date" in entry
        assert "net_dv01_eur" in entry
        assert "zscore_1y" in entry

    # z-scores are finite floats
    assert math.isfinite(result["total_zscore_1y"]) or result["total_zscore_1y"] == 0.0
    assert math.isfinite(result["total_zscore_3y"]) or result["total_zscore_3y"] == 0.0


# ---------------------------------------------------------------------------
# 2. test_panel_dv01_zscore_range
# ---------------------------------------------------------------------------

def test_panel_dv01_zscore_range(tmp_db):
    """
    Z-scores should be in a sensible range.
    Early warm-up period (first 252 business days) can have elevated z-scores due
    to a short rolling window; apply the range check only to entries after warm-up.
    The range [-10, 10] still catches pathological outliers.
    """
    db_path, params, start, end, as_of = tmp_db
    with connect(db_path) as conn:
        result = panel_dv01_by_bucket(conn, as_of, params)

    # Skip the first 252 entries (warm-up period for 1y z-score window)
    warmup = 252
    for bucket in ("whites", "reds", "greens", "blues"):
        history = result["buckets"][bucket]["history"]
        for entry in history[warmup:]:
            z = entry["zscore_1y"]
            assert -10 <= z <= 10 or z == 0.0, (
                f"z-score out of range for {bucket}: z={z} on {entry['date']}"
            )


# ---------------------------------------------------------------------------
# 3. test_panel_crowding_percentile_range
# ---------------------------------------------------------------------------

def test_panel_crowding_percentile_range(tmp_db):
    db_path, params, start, end, as_of = tmp_db
    with connect(db_path) as conn:
        result = panel_crowding(conn, as_of, params)

    assert "as_of_date" in result
    assert "total" in result
    assert "by_bucket" in result
    assert "history" in result

    # Total percentile rank in [0, 1]
    pct = result["total"]["percentile_rank"]
    assert 0.0 <= pct <= 1.0, f"Total percentile_rank={pct} out of [0, 1]"

    # History percentile ranks in [0, 1]
    for entry in result["history"]:
        p = entry["percentile_rank"]
        assert 0.0 <= p <= 1.0, f"History percentile_rank={p} out of [0,1] on {entry['date']}"

    # By-bucket percentile ranks
    for bucket in ("whites", "reds", "greens", "blues"):
        p = result["by_bucket"][bucket]["percentile_rank"]
        assert 0.0 <= p <= 1.0, f"Bucket {bucket} percentile_rank={p} out of [0, 1]"


# ---------------------------------------------------------------------------
# 4. test_panel_crowding_recent_share_range
# ---------------------------------------------------------------------------

def test_panel_crowding_recent_share_range(tmp_db):
    db_path, params, start, end, as_of = tmp_db
    with connect(db_path) as conn:
        result = panel_crowding(conn, as_of, params)

    # Total recent_share in [-1, 1]
    rs = result["total"]["recent_share_10d"]
    assert -1.0 <= rs <= 1.0, f"Total recent_share_10d={rs} out of [-1, 1]"

    # History
    for entry in result["history"]:
        s = entry["recent_share_10d"]
        assert -1.0 <= s <= 1.0, f"History recent_share={s} out of [-1,1] on {entry['date']}"


# ---------------------------------------------------------------------------
# 5. test_panel_cog_range
# ---------------------------------------------------------------------------

def test_panel_cog_range(tmp_db):
    db_path, params, start, end, as_of = tmp_db
    with connect(db_path) as conn:
        result = panel_centre_of_gravity(conn, as_of, params)

    assert "as_of_date" in result
    assert "cog_years" in result
    assert "cog_zscore" in result
    assert "history" in result
    assert len(result["history"]) > 0, "CoG history is empty"

    for entry in result["history"]:
        cog = entry["cog_years"]
        assert 0.0 <= cog <= 5.0, f"cog_years={cog} out of [0, 5] on {entry['date']}"


# ---------------------------------------------------------------------------
# 6. test_panel_quadrant_shares_sum
# ---------------------------------------------------------------------------

def test_panel_quadrant_shares_sum(tmp_db):
    db_path, params, start, end, as_of = tmp_db
    with connect(db_path) as conn:
        result = panel_quadrant_mix(conn, as_of, params)

    assert "as_of_date" in result
    assert "rolling_5d" in result
    assert "rolling_10d" in result
    assert "history" in result

    for window_name in ("rolling_5d", "rolling_10d"):
        w = result[window_name]
        s_lb = w["share_long_build"]
        s_sb = w["share_short_build"]
        s_sc = w["share_short_covering"]
        s_ll = w["share_long_liquidation"]
        total = s_lb + s_sb + s_sc + s_ll
        assert abs(total - 1.0) < 0.01, (
            f"{window_name} shares sum to {total} (expected ~1.0): "
            f"lb={s_lb}, sb={s_sb}, sc={s_sc}, ll={s_ll}"
        )


# ---------------------------------------------------------------------------
# 7. test_panel_curve_structure
# ---------------------------------------------------------------------------

def test_panel_curve_structure(tmp_db):
    db_path, params, start, end, as_of = tmp_db
    with connect(db_path) as conn:
        result = panel_curve_positioning(conn, as_of, params)

    assert "as_of_date" in result
    assert "curve_zscore" in result
    assert "curve_weekly_change" in result
    assert "curve_dv01_flow_today" in result
    assert "history" in result
    assert len(result["history"]) > 0, "Curve history is empty"

    # curve_zscore is a finite float (or 0.0 if not enough data)
    z = result["curve_zscore"]
    assert isinstance(z, float)
    assert math.isfinite(z) or z == 0.0

    # History entries have required keys
    for entry in result["history"][:3]:
        assert "date" in entry
        assert "curve_zscore" in entry
        assert "curve_dv01_flow" in entry


# ---------------------------------------------------------------------------
# 8. test_panel_cot_reconciliation_structure
# ---------------------------------------------------------------------------

def test_panel_cot_reconciliation_structure(tmp_db):
    db_path, params, start, end, as_of = tmp_db
    with connect(db_path) as conn:
        result = panel_cot_reconciliation(conn, as_of, params)

    assert "as_of_date" in result
    assert "r2" in result
    assert "fitted_lambda" in result
    assert "fitted_beta" in result
    assert "nowcast_today" in result
    assert "nowcast_uncertainty" in result
    assert "last_cot_report_date" in result
    assert "last_cot_value" in result
    assert "days_since_cot" in result
    assert "history" in result

    # r2 in [0, 1]
    assert 0.0 <= result["r2"] <= 1.0, f"r2={result['r2']} out of [0, 1]"

    # nowcast is a float
    assert isinstance(result["nowcast_today"], float)

    # days_since_cot >= 0
    assert result["days_since_cot"] >= 0

    # History entries have correct structure
    if len(result["history"]) > 0:
        entry = result["history"][0]
        assert "date" in entry
        assert "nowcast" in entry
        assert "cot_reported" in entry  # may be None
        assert "uncertainty_upper" in entry
        assert "uncertainty_lower" in entry


# ---------------------------------------------------------------------------
# 9. test_build_dashboard_all_panels
# ---------------------------------------------------------------------------

def test_build_dashboard_all_panels(tmp_db):
    db_path, params, start, end, as_of = tmp_db
    with connect(db_path) as conn:
        result = build_dashboard(conn, as_of, params)

    assert "as_of_date" in result
    assert "generated_at" in result
    assert "panels" in result

    expected_panels = {
        "dv01_by_bucket",
        "crowding",
        "centre_of_gravity",
        "quadrant_mix",
        "curve_positioning",
        "cot_reconciliation",
    }
    for panel_name in expected_panels:
        assert panel_name in result["panels"], f"Missing panel: {panel_name}"
        panel = result["panels"][panel_name]
        assert "error" not in panel, (
            f"Panel {panel_name} has error: {panel.get('error')}"
        )


# ---------------------------------------------------------------------------
# 10. test_dashboard_json_serialisable
# ---------------------------------------------------------------------------

def test_dashboard_json_serialisable(tmp_db):
    db_path, params, start, end, as_of = tmp_db
    with connect(db_path) as conn:
        result = build_dashboard(conn, as_of, params)

    # Should not raise TypeError
    serialised = json.dumps(result)
    assert len(serialised) > 100, "JSON output seems too short"


# ---------------------------------------------------------------------------
# 11. test_diagnostic_estimator_quality_shares_sum
# ---------------------------------------------------------------------------

def test_diagnostic_estimator_quality_shares_sum(tmp_db):
    db_path, params, start, end, as_of = tmp_db
    with connect(db_path) as conn:
        result = diagnostic_estimator_quality(conn, start, end, as_of, params)

    assert "period" in result
    assert "total_observations" in result
    assert "direction_estimator" in result
    assert "deadband" in result
    assert "spreads" in result

    if result["total_observations"] > 0:
        de = result["direction_estimator"]
        total_share = (
            de["vwap"]["share"]
            + de["open"]["share"]
            + de["fallback_close_to_close"]["share"]
        )
        assert abs(total_share - 1.0) < 0.01, (
            f"Estimator shares sum to {total_share} (expected ~1.0)"
        )

    # Deadband shares are valid
    dbd = result["deadband"]
    assert dbd["share_unclassified"] >= 0.0
    assert dbd["share_unclassified"] <= 1.0

    # Spread structure valid
    sp = result["spreads"]
    assert "total_doi" in sp
    assert "spread_attributed_doi" in sp
    assert "spread_share" in sp
    assert "by_type" in sp
    for stype in ("bundle", "pack", "calendar", "outright"):
        assert stype in sp["by_type"]


# ---------------------------------------------------------------------------
# 12. test_diagnostic_price_impact_structure
# ---------------------------------------------------------------------------

def test_diagnostic_price_impact_structure(tmp_db):
    db_path, params, start, end, as_of = tmp_db
    with connect(db_path) as conn:
        result = diagnostic_price_impact(conn, start, end, as_of, params, bucket="whites")

    assert "bucket" in result
    assert result["bucket"] == "whites"
    assert "history" in result
    assert "current" in result
    assert "zscore" in result
    assert len(result["history"]) > 0, "Price impact history is empty"

    # Impact values > 0
    for entry in result["history"]:
        assert "date" in entry
        assert "impact_median" in entry
        assert "impact_90pct" in entry
        assert "n_contracts" in entry
        # impact should be non-negative
        assert entry["impact_median"] >= 0.0, (
            f"impact_median={entry['impact_median']} is negative on {entry['date']}"
        )

    # Current impact is non-negative
    assert result["current"]["impact_median"] >= 0.0


# ---------------------------------------------------------------------------
# 13. test_diagnostic_conditional_returns_structure
# ---------------------------------------------------------------------------

def test_diagnostic_conditional_returns_structure(tmp_db):
    db_path, params, start, end, as_of = tmp_db
    with connect(db_path) as conn:
        result = diagnostic_conditional_returns(conn, as_of, params)

    assert "note" in result
    assert "extreme_long_episodes" in result
    assert "extreme_short_episodes" in result
    assert "percentile_thresholds" in result
    assert "current_percentile" in result

    # All forward_return fields are None (deliberately unfilled)
    for episode in result["extreme_long_episodes"]:
        assert episode["forward_return_1m"] is None, (
            f"Long episode forward_return_1m should be None, got {episode['forward_return_1m']}"
        )
        assert "start_date" in episode
        assert "end_date" in episode
        assert "peak_zscore" in episode
        assert "peak_dv01_eur" in episode

    for episode in result["extreme_short_episodes"]:
        assert episode["forward_return_1m"] is None, (
            f"Short episode forward_return_1m should be None, got {episode['forward_return_1m']}"
        )

    # current_percentile in [0, 1]
    cp = result["current_percentile"]
    assert 0.0 <= cp <= 1.0, f"current_percentile={cp} out of [0, 1]"


# ---------------------------------------------------------------------------
# 14. test_panel_error_isolation
# ---------------------------------------------------------------------------

def test_panel_error_isolation(tmp_db):
    """
    If one panel raises internally, build_dashboard() still returns other panels.
    Error panel has "error" key, not crash.
    """
    db_path, params, start, end, as_of = tmp_db

    # Monkey-patch one panel to raise
    import unittest.mock as mock
    from ..outputs import dashboard as dash_module

    original_fn = dash_module.panel_centre_of_gravity

    def _raise_panel(*args, **kwargs):
        raise RuntimeError("Simulated panel failure for error isolation test")

    with mock.patch.object(dash_module, "panel_centre_of_gravity", _raise_panel):
        with connect(db_path) as conn:
            result = build_dashboard(conn, as_of, params)

    panels = result["panels"]

    # The erroring panel should have "error" key
    assert "error" in panels["centre_of_gravity"], (
        "Expected 'error' key in centre_of_gravity panel after failure"
    )

    # Other panels should still be present and not errored
    for other_panel in ("dv01_by_bucket", "crowding", "quadrant_mix",
                        "curve_positioning", "cot_reconciliation"):
        assert other_panel in panels, f"Missing panel: {other_panel}"
        assert "error" not in panels[other_panel], (
            f"Panel {other_panel} unexpectedly errored: {panels[other_panel].get('error')}"
        )
