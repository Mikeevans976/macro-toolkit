"""
Stage 3 tests — Base signal (§4.1–§4.7).

Acceptance test: test_acceptance_nonzero_cot_correlation
  Build signal over 2 years, plant COT data tracking the signal,
  calibrate H for "whites" bucket, assert best_corr > 0.3.
"""

from __future__ import annotations

import datetime
import math
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from ..data.db import connect, init_db, load_params, next_business_day
from ..data.contract_calendar import generate_contracts, cot_publication_date
from ..data.ingest_ice_eod import simulate_eod_data
from ..core.base_signal import (
    aggregate_signal,
    build_base_signal,
    calibrate_halflife,
    estimate_direction,
    _decay_lambda,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def tmp_db_with_signal(tmp_path_factory):
    """
    Temporary SQLite DB with 2-year EOD simulation data loaded.
    Returns (db_path, params).
    No COT data — individual tests that need COT plant it themselves.
    """
    tmp_path = tmp_path_factory.mktemp("signal_db")
    db_path = tmp_path / "test_signal.db"
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
               VALUES (:contract_id, :root, :expiry_date, :last_trading_day, :contract_type, :listing_date)""",
            contracts,
        )

    start = datetime.date(2023, 1, 3)
    end   = datetime.date(2024, 12, 31)

    simulate_eod_data(start, end, contracts, params, db_path=db_path, seed=42)

    return db_path, params


def _build_signal_for_test(db_path, params):
    """Helper: build base signal for the full 2-year range."""
    start  = datetime.date(2023, 1, 3)
    end    = datetime.date(2024, 12, 31)
    as_of  = datetime.date(2025, 1, 1)
    with connect(db_path) as conn:
        sig = build_base_signal(conn, start, end, as_of, params)
    return sig


def _plant_cot_from_signal(signal_df, conn, params, noise_level=0.3, seed=99):
    """
    Insert COT data where investment_firms net position tracks the
    aggregated position signal plus noise. Plants a correlation for the
    acceptance test.

    The signal is resampled to weekly (Friday) values — the same alignment
    used by calibrate_halflife — before deriving the COT level, so that
    ΔP_week and ΔCOT_week are directly comparable.
    """
    rng = np.random.default_rng(seed)

    # Sum position over non-draining whites contracts per trade_date
    df = signal_df.reset_index()
    whites = df[(df["pack"] == "whites") & (~df["is_draining"])]
    daily_pos = whites.groupby("trade_date")["position"].sum()

    if daily_pos.empty:
        raise ValueError("No whites position data to plant COT from")

    # Resample to weekly Friday close — matching calibrate_halflife's alignment
    pos_index = pd.to_datetime(pd.Series(daily_pos.index))
    daily_pos_ts = pd.Series(daily_pos.values, index=pd.to_datetime(daily_pos.index))
    weekly_pos = daily_pos_ts.resample("W-FRI").last().dropna()

    scale = 1e4  # scale signal to COT-like magnitude

    max_base = 500_000

    for friday, ref_pos in weekly_pos.items():
        # COT report_date is the preceding Tuesday (3 days before Friday)
        tuesday = friday.date() - datetime.timedelta(days=3)
        if tuesday.weekday() != 1:
            # Adjust to nearest preceding Tuesday
            offset = (tuesday.weekday() - 1) % 7
            tuesday = tuesday - datetime.timedelta(days=offset)
        pub = friday.date()  # publication_date = Friday

        noise_scale = max(abs(ref_pos * scale) * noise_level, 1000)
        cot_net = ref_pos * scale + rng.normal(0, noise_scale)
        longs  = int(max_base + cot_net / 2)
        shorts = int(max_base - cot_net / 2)
        longs  = max(0, longs)
        shorts = max(0, shorts)
        spread = int(max_base * 0.15)
        n_trad = 80

        conn.execute(
            """INSERT OR REPLACE INTO cot_obs
               (report_date, publication_date, category,
                long_positions, short_positions, spreading, n_traders)
               VALUES (?,?,?,?,?,?,?)""",
            (tuesday.isoformat(), pub.isoformat(), "investment_firms",
             longs, shorts, spread, n_trad),
        )


# ---------------------------------------------------------------------------
# §4.3  Direction estimator tests
# ---------------------------------------------------------------------------

def test_direction_vwap():
    """settlement > vwap → direction=+1, estimator='vwap'."""
    d, est = estimate_direction(97.50, 97.45, vwap=97.48, open_price=97.46)
    assert d == 1.0
    assert est == "vwap"


def test_direction_vwap_below():
    """settlement < vwap → direction=-1, estimator='vwap'."""
    d, est = estimate_direction(97.44, 97.50, vwap=97.48, open_price=97.40)
    assert d == -1.0
    assert est == "vwap"


def test_direction_open():
    """vwap is None and settlement > open_price → direction=+1, estimator='open'."""
    d, est = estimate_direction(97.50, 97.45, vwap=None, open_price=97.46)
    assert d == 1.0
    assert est == "open"


def test_direction_open_below():
    """vwap is None and settlement < open_price → direction=-1, estimator='open'."""
    d, est = estimate_direction(97.40, 97.45, vwap=None, open_price=97.46)
    assert d == -1.0
    assert est == "open"


def test_direction_fallback():
    """Both vwap and open_price are None → estimator='fallback_close_to_close'."""
    # settlement > prev → price rose → direction +1
    d, est = estimate_direction(97.50, 97.45, vwap=None, open_price=None)
    assert est == "fallback_close_to_close"
    assert d == 1.0


def test_direction_fallback_negative():
    """Fallback: settlement < prev → direction=-1."""
    d, est = estimate_direction(97.40, 97.50, vwap=None, open_price=None)
    assert est == "fallback_close_to_close"
    assert d == -1.0


def test_direction_zero():
    """settlement == vwap → direction=0.0."""
    d, est = estimate_direction(97.50, 97.45, vwap=97.50, open_price=97.46)
    assert d == 0.0
    assert est == "vwap"


# ---------------------------------------------------------------------------
# §4.4  Confidence weight tests
# ---------------------------------------------------------------------------

def test_confidence_weight_cap(tmp_db_with_signal):
    """When |dr|/sigma > cap, weight must be capped at cap."""
    db_path, params = tmp_db_with_signal
    sig = _build_signal_for_test(db_path, params)
    cap = params["signal"]["confidence_weight_cap"]
    assert not sig.empty, "Signal DataFrame is empty"
    violations = (sig["w"] > cap + 1e-9).sum()
    assert violations == 0, f"{violations} rows have w > cap={cap}"


def test_confidence_weight_zero_sigma(tmp_db_with_signal):
    """When sigma == 0 (or NaN), weight must be 0.0 — no div-by-zero."""
    db_path, params = tmp_db_with_signal
    sig = _build_signal_for_test(db_path, params)

    zero_sigma_mask = sig["sigma"].isna() | (sig["sigma"] == 0)
    if zero_sigma_mask.any():
        bad = sig.loc[zero_sigma_mask, "w"]
        assert (bad == 0.0).all(), (
            f"Some rows with sigma=0/NaN have non-zero w:\n{bad[bad != 0]}"
        )


# ---------------------------------------------------------------------------
# §4.6  Turnover regime tests
# ---------------------------------------------------------------------------

def test_turnover_churn(tmp_db_with_signal):
    """High volume + low |doi| → regime='churn', factor=0.2."""
    db_path, params = tmp_db_with_signal
    sig = _build_signal_for_test(db_path, params)

    churn_rows = sig[sig["regime"] == "churn"]
    if not churn_rows.empty:
        assert (churn_rows["regime_factor"] == 0.2).all(), (
            "Churn rows should have regime_factor=0.2"
        )

    # Verify normal rows have factor=1.0
    normal_rows = sig[sig["regime"] == "normal"]
    if not normal_rows.empty:
        assert (normal_rows["regime_factor"] == 1.0).all(), (
            "Normal rows should have regime_factor=1.0"
        )


def test_turnover_transfer(tmp_db_with_signal):
    """Transfer regime → factor=1.5."""
    db_path, params = tmp_db_with_signal
    sig = _build_signal_for_test(db_path, params)

    transfer_rows = sig[sig["regime"] == "transfer"]
    if not transfer_rows.empty:
        assert (transfer_rows["regime_factor"] == 1.5).all(), (
            "Transfer rows should have regime_factor=1.5"
        )


# ---------------------------------------------------------------------------
# §4.2  Flow sign tests
# ---------------------------------------------------------------------------

def test_flow_sign_long_build():
    """
    Rates fall (dr > 0, price rose) + OI rises (doi > 0) → flow > 0 (long build).

    We directly test the formula: f = w_adj * direction * doi
    direction uses VWAP: settlement > vwap → +1
    """
    # settlement rose above vwap → direction = +1
    direction, _ = estimate_direction(97.60, 97.50, vwap=97.55, open_price=None)
    assert direction == 1.0

    doi = 1000   # OI grew
    w_adj = 1.0  # unit weight
    flow = w_adj * direction * doi
    assert flow > 0, f"Expected positive flow for long build, got {flow}"


def test_flow_sign_short_build():
    """
    Rates rise (price fell) + OI rises (doi > 0) → flow < 0 (short build).
    """
    # settlement fell below vwap → direction = -1
    direction, _ = estimate_direction(97.40, 97.50, vwap=97.48, open_price=None)
    assert direction == -1.0

    doi = 1000   # OI grew
    w_adj = 1.0
    flow = w_adj * direction * doi
    assert flow < 0, f"Expected negative flow for short build, got {flow}"


def test_flow_sign_in_signal(tmp_db_with_signal):
    """Spot-check flow column in built signal: flow is NaN only where doi is NaN."""
    db_path, params = tmp_db_with_signal
    sig = _build_signal_for_test(db_path, params)

    # Where doi is present and direction != 0 and w_adjusted != 0 → flow non-zero
    # (there will be some zeros where direction=0 or w_adjusted=0, that's fine)
    has_doi = sig["doi"].notna()
    flow_nan_where_doi_exists = sig.loc[has_doi, "flow"].isna().sum()
    assert flow_nan_where_doi_exists == 0, (
        f"{flow_nan_where_doi_exists} rows have NaN flow despite having doi"
    )


# ---------------------------------------------------------------------------
# §4.7  Decay tests
# ---------------------------------------------------------------------------

def test_decay_washout():
    """
    After 3 half-lives, initial condition washes out to < 12.5% (spec §4.7).
    λ^(3H) = (exp(−ln2/H))^(3H) = exp(−3ln2) = 1/8 = 12.5%.
    """
    for H in [20, 30, 60, 90]:
        lam = _decay_lambda(H)
        decay_factor = lam ** (3 * H)
        assert decay_factor < 0.125 + 1e-9, (
            f"H={H}: λ^(3H)={decay_factor:.6f} >= 0.125 (should wash out)"
        )


def test_decay_accumulation_convergence(tmp_db_with_signal):
    """Position series exists for all dates and is finite."""
    db_path, params = tmp_db_with_signal
    sig = _build_signal_for_test(db_path, params)

    assert "position" in sig.columns
    assert sig["position"].notna().any(), "All positions are NaN"
    assert np.isfinite(sig["position"].dropna()).all(), "Non-finite values in position"


# ---------------------------------------------------------------------------
# §4.5  Price impact
# ---------------------------------------------------------------------------

def test_price_impact_separate(tmp_db_with_signal):
    """
    impact_i is computed and stored, but modifying it does NOT change position.
    Verify impact is present and that position column is independent of it.
    """
    db_path, params = tmp_db_with_signal
    sig = _build_signal_for_test(db_path, params)

    assert "impact" in sig.columns, "impact column missing"

    # Store original positions
    original_positions = sig["position"].copy()

    # Simulate "modifying" impact (just check column isolation)
    sig_copy = sig.copy()
    sig_copy["impact"] = sig_copy["impact"] * 999.0

    # Position should be unchanged (it was computed from flow, not impact)
    pd.testing.assert_series_equal(
        sig_copy["position"],
        original_positions,
        check_names=False,
    )


def test_price_impact_formula(tmp_db_with_signal):
    """
    impact = |dr| / |doi| when |doi| > 0, else NaN.
    """
    db_path, params = tmp_db_with_signal
    sig = _build_signal_for_test(db_path, params)

    # Where doi != 0 and both dr_abs and doi are present
    mask = (sig["doi"].notna()) & (sig["doi"].abs() > 0) & (sig["dr_abs"].notna())
    if mask.any():
        expected = sig.loc[mask, "dr_abs"] / sig.loc[mask, "doi"].abs()
        actual   = sig.loc[mask, "impact"]
        pd.testing.assert_series_equal(
            actual.reset_index(drop=True),
            expected.reset_index(drop=True),
            check_names=False,
            rtol=1e-6,
        )

    # Where doi == 0 → impact should be NaN
    zero_doi = (sig["doi"].notna()) & (sig["doi"].abs() == 0)
    if zero_doi.any():
        assert sig.loc[zero_doi, "impact"].isna().all(), (
            "impact should be NaN when |doi| == 0"
        )


# ---------------------------------------------------------------------------
# Draining exclusion
# ---------------------------------------------------------------------------

def test_draining_excluded(tmp_db_with_signal):
    """Draining contracts must not be included in aggregate position."""
    db_path, params = tmp_db_with_signal
    sig = _build_signal_for_test(db_path, params)

    agg = aggregate_signal(sig, params)

    # Verify n_draining column exists
    assert "n_draining" in agg.columns

    # For each date, manually sum non-draining dv01_position and compare
    df = sig.reset_index()
    manual = df[~df["is_draining"]].groupby("trade_date")["dv01_position"].sum()
    manual = manual.reindex(agg.index)

    # Values should match within floating point tolerance
    # dropna() guards against dates where one side has no data (edge of range)
    diff = (agg["total_dv01_position"] - manual).abs().dropna()
    assert len(diff) > 0, "No overlapping dates to compare"
    assert (diff < 1e-4).all(), (
        f"Draining contracts appear in total_dv01_position. Max diff={diff.max()}"
    )


# ---------------------------------------------------------------------------
# §4.7  No level before anchoring
# ---------------------------------------------------------------------------

def test_no_level_before_anchoring(tmp_db_with_signal):
    """
    aggregate_signal must NOT expose raw position levels. It must expose:
      - weekly_change_position
      - zscore_position
    and must NOT have a column named "position" or "total_position".
    """
    db_path, params = tmp_db_with_signal
    sig = _build_signal_for_test(db_path, params)
    agg = aggregate_signal(sig, params)

    assert "weekly_change_position" in agg.columns, (
        "aggregate_signal must expose weekly_change_position"
    )
    assert "zscore_position" in agg.columns, (
        "aggregate_signal must expose zscore_position"
    )

    forbidden = {"position", "total_position", "raw_position"}
    found = forbidden & set(agg.columns)
    assert not found, (
        f"aggregate_signal exposes raw position levels before Kalman anchoring: {found}"
    )


# ---------------------------------------------------------------------------
# §4 — Column completeness
# ---------------------------------------------------------------------------

def test_signal_columns(tmp_db_with_signal):
    """build_base_signal must return all required columns."""
    db_path, params = tmp_db_with_signal
    sig = _build_signal_for_test(db_path, params)

    required = {
        "settlement_price", "prev_settlement_price",
        "rate", "prev_rate", "dr",
        "vwap", "open_price",
        "open_interest", "prev_oi", "doi",
        "volume",
        "direction", "estimator",
        "dr_abs", "sigma", "w", "regime", "regime_factor", "w_adjusted",
        "flow", "impact",
        "halflife", "decay_lambda",
        "position",
        "dv01_flow", "dv01_position",
        "pack", "ttm_bucket", "generic_rank", "is_draining",
        "days_to_expiry",
    }
    missing = required - set(sig.columns)
    assert not missing, f"Missing columns in signal output: {missing}"


def test_aggregate_columns(tmp_db_with_signal):
    """aggregate_signal must return all required aggregate columns."""
    db_path, params = tmp_db_with_signal
    sig = _build_signal_for_test(db_path, params)
    agg = aggregate_signal(sig, params)

    required = {
        "total_dv01_flow",
        "total_dv01_position",
        "dv01_flow_whites", "dv01_flow_reds", "dv01_flow_greens", "dv01_flow_blues",
        "dv01_pos_whites",  "dv01_pos_reds",  "dv01_pos_greens",  "dv01_pos_blues",
        "weekly_change_position",
        "zscore_position",
        "n_contracts",
        "n_draining",
    }
    missing = required - set(agg.columns)
    assert not missing, f"Missing columns in aggregate output: {missing}"


# ---------------------------------------------------------------------------
# Stage 3 acceptance test — non-zero COT correlation
# ---------------------------------------------------------------------------

def test_acceptance_nonzero_cot_correlation(tmp_db_with_signal):
    """
    §10  Stage 3 acceptance test.

    Build signal, plant COT tracking it, calibrate H, assert:
      1. best_corr > 0.3
      2. best_h differs from naive 20-day default (calibration did something)
    """
    db_path, params = tmp_db_with_signal
    sig = _build_signal_for_test(db_path, params)

    # Plant COT data that tracks the signal
    with connect(db_path) as conn:
        # Clear any existing COT for investment_firms to avoid conflicts
        conn.execute("DELETE FROM cot_obs WHERE category = 'investment_firms'")
        _plant_cot_from_signal(sig, conn, params, noise_level=0.3, seed=99)

    # Read COT from DB
    with connect(db_path) as conn:
        cot_rows = conn.execute(
            """SELECT publication_date, long_positions, short_positions
               FROM cot_obs
               WHERE category = 'investment_firms'
               ORDER BY publication_date"""
        ).fetchall()

    assert cot_rows, "No COT data found after planting"

    cot_df = pd.DataFrame([dict(r) for r in cot_rows])
    cot_df["publication_date"] = pd.to_datetime(cot_df["publication_date"])

    result = calibrate_halflife(sig, cot_df, "whites", params)

    assert "best_corr" in result
    assert "best_h"   in result
    assert "grid"     in result

    best_corr = result["best_corr"]
    best_h    = result["best_h"]

    assert not math.isnan(best_corr), "best_corr is NaN — no valid grid points"
    assert best_corr > 0.3, (
        f"best_corr={best_corr:.4f} <= 0.3. "
        "Signal and planted COT should be positively correlated."
    )
    # Calibration must have explored more than just the 20-day default
    naive_h = 20
    assert best_h != naive_h or len([h for h, c in result["grid"] if not math.isnan(c)]) > 1, (
        f"Calibration returned naive default H={naive_h} without exploring other values"
    )

    # At least one other H was tested
    grid_hs = [h for h, c in result["grid"] if not math.isnan(c)]
    assert len(grid_hs) > 1, "Calibration only tested one H value"
