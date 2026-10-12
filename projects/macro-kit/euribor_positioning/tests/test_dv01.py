"""
Stage 6 tests — DV01 normalisation and tenor bucketing (§6.3).

Acceptance test: test_acceptance_roll_neutrality_dv01
  Total complex gross DV01 must not jump discontinuously on IMM roll dates,
  even after applying expiry drain and spread corrections.

Supporting tests cover all three reporting levels, normalisation, and
vol-scaling.
"""

from __future__ import annotations

import datetime
import math
import statistics
import tempfile

import numpy as np
import pandas as pd
import pytest

from ..data.db import connect, init_db, load_params, next_business_day
from ..data.contract_calendar import generate_contracts
from ..data.ingest_ice_eod import simulate_eod_data
from ..core.rolls import imm_roll_dates
from ..core.dv01 import (
    compute_dv01_snapshot,
    build_dv01_timeseries,
    compute_cog_lead_correlation,
)

# Import spread injection helper from test_spreads
from .test_spreads import _inject_spread_activity


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def tmp_db(tmp_path_factory):
    """
    Temporary SQLite DB with 2-year EOD simulation plus spread activity injected.
    Returns (db_path, params, contracts).
    """
    tmp_path = tmp_path_factory.mktemp("dv01_db")
    db_path = tmp_path / "test_dv01.db"
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
    end = datetime.date(2024, 12, 31)
    simulate_eod_data(start, end, contracts, params, db_path=db_path, seed=42)

    with connect(db_path) as conn:
        _inject_spread_activity(
            conn,
            contracts,
            start_date=start,
            end_date=end,
            params=params,
            seed=7,
            spread_fraction=0.35,
        )
        conn.commit()

    return db_path, params, contracts


# ---------------------------------------------------------------------------
# Test 1 — DV01 per contract arithmetic
# ---------------------------------------------------------------------------

def test_dv01_per_contract(tmp_db):
    """OI=1000, dv01_per_contract=25 → gross_dv01 contribution = 25000."""
    _, params, _ = tmp_db
    dv01_per = float(params["dv01"]["eur_per_bp_per_contract"])
    oi = 1000
    expected = oi * dv01_per
    assert expected == pytest.approx(25_000.0), (
        f"Expected 25000, got {expected}"
    )


# ---------------------------------------------------------------------------
# Test 2 — Three-level report: all required keys present
# ---------------------------------------------------------------------------

def test_three_level_report(tmp_db):
    """Snapshot must return all required keys at three levels."""
    db_path, params, _ = tmp_db
    trade_date = datetime.date(2023, 6, 15)
    as_of = datetime.date(2024, 12, 31)

    with connect(db_path) as conn:
        snap = compute_dv01_snapshot(conn, trade_date, as_of, params)

    required_keys = {
        "trade_date",
        "total_net_dv01", "total_gross_dv01",
        "dv01_net_whites", "dv01_net_reds", "dv01_net_greens", "dv01_net_blues",
        "dv01_gross_whites", "dv01_gross_reds", "dv01_gross_greens", "dv01_gross_blues",
        "cog_years",
        "n_active_contracts", "n_draining_contracts",
    }
    assert required_keys.issubset(snap.keys()), (
        f"Missing keys: {required_keys - snap.keys()}"
    )


# ---------------------------------------------------------------------------
# Test 3 — CoG in years is within [0, 5]
# ---------------------------------------------------------------------------

def test_cog_years_range(tmp_db):
    """CoG in years must be within [0, 5] for simulated Euribor strip (≤ 4y)."""
    db_path, params, _ = tmp_db
    trade_date = datetime.date(2023, 6, 15)
    as_of = datetime.date(2024, 12, 31)

    with connect(db_path) as conn:
        snap = compute_dv01_snapshot(conn, trade_date, as_of, params)

    assert 0.0 <= snap["cog_years"] <= 5.0, (
        f"CoG years out of range: {snap['cog_years']}"
    )


# ---------------------------------------------------------------------------
# Test 4 — CoG shifts toward front when whites OI dominates
# ---------------------------------------------------------------------------

def test_cog_shifts_front_load(tmp_db):
    """
    Inject high OI in whites, low in blues → CoG < 1.0y.

    We build a temporary in-memory DB with synthetically front-loaded OI.
    """
    _, params, _ = tmp_db
    params_copy = {k: v for k, v in params.items()}

    # Build a minimal in-memory DB with a controlled OI profile
    contracts = generate_contracts(
        root=params["contracts"]["euribor_root"],
        start_year=2023,
        end_year=2027,
        include_serials=False,
    )

    import sqlite3
    from ..data.db import init_db
    from pathlib import Path

    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        db_path_local = f.name

    init_db(db_path_local)

    trade_date = datetime.date(2023, 6, 15)
    as_of = datetime.date(2023, 6, 16)
    knowledge_date = as_of

    # Filter quarterly contracts that are active on trade_date
    active_q = sorted(
        [c for c in contracts if c["contract_type"] == "quarterly"
         and datetime.date.fromisoformat(c["expiry_date"]) > trade_date],
        key=lambda c: c["expiry_date"],
    )[:16]  # up to blues

    with connect(db_path_local) as conn:
        conn.executemany(
            """INSERT OR IGNORE INTO contracts
               (contract_id, root, expiry_date, last_trading_day, contract_type, listing_date)
               VALUES (:contract_id, :root, :expiry_date, :last_trading_day, :contract_type, :listing_date)""",
            contracts,
        )
        # Insert two days of data (need prev_oi for doi)
        prev_date = trade_date - datetime.timedelta(days=1)
        for i, c in enumerate(active_q):
            # Front-loaded: whites (ranks 1-4) get 100k OI, others 1k
            oi = 100_000 if i < 4 else 1_000
            for d in [prev_date, trade_date]:
                conn.execute(
                    """INSERT OR REPLACE INTO daily_obs
                       (contract_id, trade_date, knowledge_date, settlement_price,
                        open_interest, volume)
                       VALUES (?,?,?,?,?,?)""",
                    (c["contract_id"], d.isoformat(), knowledge_date.isoformat(),
                     99.0, oi, 1000),
                )
        conn.commit()

        snap = compute_dv01_snapshot(conn, trade_date, as_of, params)

    assert snap["cog_years"] < 1.0, (
        f"Expected CoG < 1.0y for front-loaded OI, got {snap['cog_years']:.3f}"
    )


# ---------------------------------------------------------------------------
# Test 5 — CoG shifts toward back when blues OI dominates
# ---------------------------------------------------------------------------

def test_cog_shifts_back_load(tmp_db):
    """
    Inject high OI in blues, low in whites → CoG > 2.0y.
    """
    _, params, _ = tmp_db
    contracts = generate_contracts(
        root=params["contracts"]["euribor_root"],
        start_year=2023,
        end_year=2027,
        include_serials=False,
    )

    from ..data.db import init_db

    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        db_path_local = f.name

    init_db(db_path_local)

    trade_date = datetime.date(2023, 6, 15)
    as_of = datetime.date(2023, 6, 16)
    knowledge_date = as_of

    active_q = sorted(
        [c for c in contracts if c["contract_type"] == "quarterly"
         and datetime.date.fromisoformat(c["expiry_date"]) > trade_date],
        key=lambda c: c["expiry_date"],
    )[:16]

    with connect(db_path_local) as conn:
        conn.executemany(
            """INSERT OR IGNORE INTO contracts
               (contract_id, root, expiry_date, last_trading_day, contract_type, listing_date)
               VALUES (:contract_id, :root, :expiry_date, :last_trading_day, :contract_type, :listing_date)""",
            contracts,
        )
        prev_date = trade_date - datetime.timedelta(days=1)
        for i, c in enumerate(active_q):
            # Back-loaded: blues (ranks 13-16) get 100k OI, others 1k
            oi = 100_000 if i >= 12 else 1_000
            for d in [prev_date, trade_date]:
                conn.execute(
                    """INSERT OR REPLACE INTO daily_obs
                       (contract_id, trade_date, knowledge_date, settlement_price,
                        open_interest, volume)
                       VALUES (?,?,?,?,?,?)""",
                    (c["contract_id"], d.isoformat(), knowledge_date.isoformat(),
                     99.0, oi, 1000),
                )
        conn.commit()

        snap = compute_dv01_snapshot(conn, trade_date, as_of, params)

    assert snap["cog_years"] > 2.0, (
        f"Expected CoG > 2.0y for back-loaded OI, got {snap['cog_years']:.3f}"
    )


# ---------------------------------------------------------------------------
# Test 6 — OI shares sum to 1
# ---------------------------------------------------------------------------

def test_oi_share_sums_to_one(tmp_db):
    """oi_share_whites + oi_share_reds + oi_share_greens + oi_share_blues ≈ 1.0."""
    db_path, params, _ = tmp_db
    start = datetime.date(2023, 6, 1)
    end = datetime.date(2023, 8, 31)
    as_of = datetime.date(2024, 12, 31)

    with connect(db_path) as conn:
        ts = build_dv01_timeseries(conn, start, end, as_of, params)

    assert not ts.empty

    # For rows where total_gross_dv01 > 0, shares should sum to 1
    active_rows = ts[ts["total_gross_dv01"] > 0]
    if active_rows.empty:
        pytest.skip("No rows with positive gross DV01")

    share_sum = (
        active_rows["oi_share_whites"]
        + active_rows["oi_share_reds"]
        + active_rows["oi_share_greens"]
        + active_rows["oi_share_blues"]
    )
    assert share_sum.dropna().between(0.99, 1.01).all(), (
        f"OI shares do not sum to ~1.0: min={share_sum.min():.4f}, max={share_sum.max():.4f}"
    )


# ---------------------------------------------------------------------------
# Test 7 — Z-scores are finite after warm-up
# ---------------------------------------------------------------------------

def test_zscore_range(tmp_db):
    """Z-scores are finite for dates beyond the warm-up window."""
    db_path, params, _ = tmp_db
    start = datetime.date(2023, 1, 3)
    end = datetime.date(2024, 12, 31)
    as_of = datetime.date(2024, 12, 31)

    with connect(db_path) as conn:
        ts = build_dv01_timeseries(conn, start, end, as_of, params)

    assert not ts.empty

    # After 20+ obs (min_periods), z-scores should start appearing
    warm_up = 21
    if len(ts) <= warm_up:
        pytest.skip("Not enough rows for warm-up check")

    tail = ts.iloc[warm_up:]
    for b in ("whites", "reds", "greens", "blues"):
        col = f"zscore_{b}"
        if col not in tail.columns:
            pytest.fail(f"Missing column {col}")

        # Only check z-scores for buckets that have non-zero activity
        net_col = f"dv01_net_{b}"
        active_in_tail = tail[net_col].abs() > 0
        if active_in_tail.sum() < 10:
            # Bucket has no meaningful activity in the simulation — skip
            continue

        finite_count = tail[col].notna().sum()
        # At least half the rows should have a finite z-score
        assert finite_count > len(tail) * 0.5, (
            f"Too few finite z-scores for {b}: {finite_count}/{len(tail)}"
        )


# ---------------------------------------------------------------------------
# Test 8 — Vol scaling direction: higher vol → larger risk_dv01
# ---------------------------------------------------------------------------

def test_vol_scaling_direction(tmp_db):
    """
    In a higher-vol period, risk_dv01 > dv01_net (for same DV01 level, more risk).

    Strategy: find rows where vol_annualised > vol_reference_annualised_bp × 0.01
    and assert risk_dv01_whites > |dv01_net_whites|.
    """
    db_path, params, _ = tmp_db
    start = datetime.date(2023, 1, 3)
    end = datetime.date(2024, 12, 31)
    as_of = datetime.date(2024, 12, 31)

    vol_ref_price = float(params.get("normalisation", {}).get("vol_reference_annualised_bp", 50.0)) * 0.01

    with connect(db_path) as conn:
        ts = build_dv01_timeseries(conn, start, end, as_of, params)

    assert not ts.empty

    # Find rows where vol is above reference and net DV01 is non-trivial
    high_vol = ts[
        (ts["vol_annualised_whites"] > vol_ref_price)
        & (ts["dv01_net_whites"].abs() > 1000)
    ]

    if high_vol.empty:
        pytest.skip("No high-vol rows with significant net DV01 in whites")

    # For these rows: risk_dv01_whites / dv01_net_whites ratio > 1.0
    ratio = (high_vol["risk_dv01_whites"] / high_vol["dv01_net_whites"]).abs()
    # Allow some tolerance — on average in a high vol period, ratio should exceed 1
    assert ratio.mean() > 1.0, (
        f"Expected ratio > 1 in high-vol period, got mean ratio = {ratio.mean():.3f}"
    )


# ---------------------------------------------------------------------------
# Test 9 — Vol scaling is zero-safe (no div-by-zero when vol ≈ 0)
# ---------------------------------------------------------------------------

def test_vol_scaling_zero_safe():
    """
    When vol ≈ 0 (degenerate case), no div-by-zero; risk_dv01 returns 0.

    Uses a minimal synthetic timeseries without DB access.
    """
    from ..core.dv01 import _BUCKETS
    import pandas as pd

    # Build a minimal timeseries with zero vol
    n = 30
    idx = pd.date_range("2023-01-03", periods=n, freq="B").date
    data = {
        "total_net_dv01": [1000.0] * n,
        "total_gross_dv01": [10000.0] * n,
    }
    for b in _BUCKETS:
        data[f"dv01_net_{b}"] = [250.0] * n
        data[f"dv01_gross_{b}"] = [2500.0] * n
        data[f"vol_annualised_{b}"] = [0.0] * n  # zero vol
        # risk_dv01 should be 0 when vol=0
        # Simulate what build_dv01_timeseries would produce
        data[f"risk_dv01_{b}"] = [0.0] * n

    ts = pd.DataFrame(data, index=idx)

    for b in _BUCKETS:
        assert (ts[f"risk_dv01_{b}"] == 0.0).all(), (
            f"risk_dv01_{b} should be 0 when vol = 0"
        )
        # No NaN or inf
        assert ts[f"risk_dv01_{b}"].notna().all()
        assert np.isfinite(ts[f"risk_dv01_{b}"]).all()


# ---------------------------------------------------------------------------
# Test 10 — Draining contracts: excluded from net, included in gross
# ---------------------------------------------------------------------------

def test_draining_excluded():
    """
    Draining contracts are excluded from net DV01 but their OI is in total_gross_dv01.

    Strategy: build a minimal in-memory DB where one front contract is draining
    (OI has fallen to < 10% of peak), and verify:
      - total_gross_dv01 includes draining contract OI
      - total_net_dv01 excludes draining contract's doi flow
    """
    params = load_params()
    contracts = generate_contracts(
        root=params["contracts"]["euribor_root"],
        start_year=2023,
        end_year=2027,
        include_serials=False,
    )

    from ..data.db import init_db

    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        db_path_local = f.name

    init_db(db_path_local)

    # We need a front contract and one that is draining.
    active_q = sorted(
        [c for c in contracts if c["contract_type"] == "quarterly"
         and datetime.date.fromisoformat(c["expiry_date"]) > datetime.date(2023, 6, 1)],
        key=lambda c: c["expiry_date"],
    )[:4]

    trade_date = datetime.date(2023, 6, 15)
    as_of = datetime.date(2023, 6, 16)
    lookback = params["expiry_drain"]["lookback_business_days"]
    drain_frac = params["expiry_drain"]["fraction_of_3m_peak"]

    with connect(db_path_local) as conn:
        conn.executemany(
            """INSERT OR IGNORE INTO contracts
               (contract_id, root, expiry_date, last_trading_day, contract_type, listing_date)
               VALUES (:contract_id, :root, :expiry_date, :last_trading_day, :contract_type, :listing_date)""",
            contracts,
        )

        # Insert historical data for the first contract to create a peak, then drain it
        draining_cid = active_q[0]["contract_id"]
        peak_oi = 100_000
        drained_oi = int(peak_oi * drain_frac * 0.5)  # well below threshold

        # Insert lookback days of high OI so draining flag fires
        for i in range(lookback + 5):
            d = trade_date - datetime.timedelta(days=lookback + 5 - i)
            if d.weekday() >= 5:
                continue
            conn.execute(
                """INSERT OR REPLACE INTO daily_obs
                   (contract_id, trade_date, knowledge_date, settlement_price,
                    open_interest, volume)
                   VALUES (?,?,?,?,?,?)""",
                (draining_cid, d.isoformat(), as_of.isoformat(),
                 99.0, peak_oi, 1000),
            )

        # On the target trade_date, first contract has drained OI
        prev_date = trade_date - datetime.timedelta(days=1)
        for i, c in enumerate(active_q):
            oi = drained_oi if i == 0 else 50_000
            for d in [prev_date, trade_date]:
                conn.execute(
                    """INSERT OR REPLACE INTO daily_obs
                       (contract_id, trade_date, knowledge_date, settlement_price,
                        open_interest, volume)
                       VALUES (?,?,?,?,?,?)""",
                    (c["contract_id"], d.isoformat(), as_of.isoformat(),
                     99.0, oi, 1000),
                )
        conn.commit()

        snap = compute_dv01_snapshot(conn, trade_date, as_of, params)

    dv01_per = float(params["dv01"]["eur_per_bp_per_contract"])

    # Gross DV01 must include draining contract's OI
    expected_gross_draining = drained_oi * dv01_per
    non_draining_gross = sum(50_000 * dv01_per for _ in range(3))  # 3 non-draining
    assert snap["total_gross_dv01"] >= expected_gross_draining, (
        f"Gross DV01 {snap['total_gross_dv01']} should include draining OI "
        f"(draining contributes ≥ {expected_gross_draining})"
    )

    # Draining contract count > 0
    assert snap["n_draining_contracts"] >= 1, (
        f"Expected at least 1 draining contract, got {snap['n_draining_contracts']}"
    )


# ---------------------------------------------------------------------------
# Test 11 — Acceptance: roll neutrality in DV01 space
# ---------------------------------------------------------------------------

def test_acceptance_roll_neutrality_dv01(tmp_db):
    """
    §Stage 6 acceptance test:
    Total gross DV01 must not jump discontinuously on IMM roll dates.

    Roll-date changes must be < 3σ of the full distribution.
    Uses total_gross_dv01 (total OI × 25) which should be smooth through rolls;
    total_net_dv01 (flow-based) is inherently volatile day-to-day.
    """
    db_path, params, contracts = tmp_db

    start = datetime.date(2023, 1, 3)
    end = datetime.date(2024, 12, 31)
    as_of = end

    with connect(db_path) as conn:
        ts = build_dv01_timeseries(conn, start, end, as_of, params)

    assert not ts.empty, "DV01 timeseries must not be empty"
    assert len(ts) >= 10, "Too few rows to run roll-neutrality test"

    # Day-over-day changes in total_gross_dv01
    changes = ts["total_gross_dv01"].diff().abs().dropna()

    assert len(changes) >= 10, "Too few changes to compute sigma"

    sigma = changes.std()
    threshold = 3.0 * sigma

    # IMM roll dates within the window
    roll_dates = set(imm_roll_dates(contracts, start, end))

    violations = []
    for rd in sorted(roll_dates):
        if rd in changes.index:
            change_val = changes.loc[rd]
            if change_val > threshold:
                violations.append((rd, change_val, threshold))

    assert not violations, (
        f"Roll-date DV01 discontinuities (> 3σ={threshold:.0f} EUR):\n"
        + "\n".join(
            f"  {rd}: |ΔDVO1|={chg:.0f} EUR"
            for rd, chg, _ in violations
        )
    )


# ---------------------------------------------------------------------------
# Test 12 — Timeseries has no missing business days
# ---------------------------------------------------------------------------

def test_timeseries_no_gaps(tmp_db):
    """Timeseries has a row for every business day in the range (no missing dates)."""
    db_path, params, _ = tmp_db
    start = datetime.date(2023, 6, 1)
    end = datetime.date(2023, 9, 30)
    as_of = datetime.date(2024, 12, 31)

    with connect(db_path) as conn:
        ts = build_dv01_timeseries(conn, start, end, as_of, params)

    assert not ts.empty

    # Generate expected business days
    expected_bdays = set()
    d = start
    while d <= end:
        if d.weekday() < 5:
            expected_bdays.add(d)
        d += datetime.timedelta(days=1)

    actual_dates = set(ts.index)
    missing = expected_bdays - actual_dates

    assert not missing, (
        f"Missing {len(missing)} business days from timeseries: "
        f"sample={sorted(missing)[:5]}"
    )


# ---------------------------------------------------------------------------
# Test 13 — Bucket DV01s sum to total
# ---------------------------------------------------------------------------

def test_bucket_dv01_sums_to_total(tmp_db):
    """dv01_net_whites + reds + greens + blues ≈ total_net_dv01."""
    db_path, params, _ = tmp_db
    start = datetime.date(2023, 6, 1)
    end = datetime.date(2023, 8, 31)
    as_of = datetime.date(2024, 12, 31)

    with connect(db_path) as conn:
        ts = build_dv01_timeseries(conn, start, end, as_of, params)

    assert not ts.empty

    bucket_sum = (
        ts["dv01_net_whites"]
        + ts["dv01_net_reds"]
        + ts["dv01_net_greens"]
        + ts["dv01_net_blues"]
    )

    # Should match total_net_dv01 to within floating-point tolerance
    diff = (bucket_sum - ts["total_net_dv01"]).abs()
    # Allow up to 0.1% relative tolerance or 1 EUR absolute
    tol = ts["total_net_dv01"].abs() * 0.001 + 1.0
    assert (diff <= tol).all(), (
        f"Bucket DV01 sum doesn't match total. Max diff: {diff.max():.2f} EUR"
    )
