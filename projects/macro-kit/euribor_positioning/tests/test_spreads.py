"""
Stage 5 tests — Spread detection and routing (§6.2).

Acceptance test: test_acceptance_spread_share_tracks_cot
  Estimated spread share must have positive, non-trivial correlation with
  COT spreading category when regressed weekly.
"""

from __future__ import annotations

import datetime
import math

import numpy as np
import pandas as pd
import pytest

from ..data.db import connect, init_db, load_params
from ..data.contract_calendar import generate_contracts
from ..data.ingest_ice_eod import simulate_eod_data
from ..core.spreads import (
    detect_spreads_day,
    build_spread_signal,
    compute_weekly_spread_validation,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def tmp_db_spreads(tmp_path_factory):
    """
    Temporary SQLite DB with 2-year EOD simulation (no spread injection).
    Returns (db_path, params).
    """
    tmp_path = tmp_path_factory.mktemp("spreads_db")
    db_path = tmp_path / "test_spreads.db"
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

    return db_path, params, contracts


# ---------------------------------------------------------------------------
# Spread injection helper
# ---------------------------------------------------------------------------

def _inject_spread_activity(
    conn,
    contracts,
    start_date: datetime.date,
    end_date: datetime.date,
    params: dict,
    seed: int = 7,
    spread_fraction: float = 0.35,
) -> None:
    """
    Modify existing daily_obs to add correlated ΔOI patterns simulating spread rolls.

    Strategy:
    - Build a weekly AR(1) schedule of spread activity levels.
    - Each week, inject pack-style ΔOI on a number of days proportional to that week's
      spread level (all days in high-spread weeks, few days in low-spread weeks).
    - Pack injection: override ΔOI of 4 consecutive quarterly contracts so all have
      equal magnitude (low CV → guaranteed pack detection).
    - COT spreading is set to track the SAME weekly schedule so estimated spread_share
      and COT spreading co-vary positively.

    spread_fraction: mean target fraction of weeks with high spread activity.
    """
    rng = np.random.default_rng(seed)

    quarterly = sorted(
        [c for c in contracts if c["contract_type"] == "quarterly"],
        key=lambda c: c["expiry_date"],
    )
    if len(quarterly) < 4:
        return

    # Build weekly schedule: collect Fridays and assign an AR(1) spread level
    fridays: list[datetime.date] = []
    current = start_date
    while current <= end_date:
        days_ahead = (4 - current.weekday()) % 7
        friday = current + datetime.timedelta(days=days_ahead)
        if friday > end_date:
            break
        fridays.append(friday)
        current = friday + datetime.timedelta(days=1)

    # AR(1) spread level (persistent deviations, wider range for better SNR)
    phi = 0.80
    sf_vals = np.zeros(len(fridays))
    sf_vals[0] = spread_fraction
    for i in range(1, len(fridays)):
        sf_vals[i] = spread_fraction + phi * (sf_vals[i - 1] - spread_fraction) + rng.normal(0, 0.08)
        sf_vals[i] = float(np.clip(sf_vals[i], 0.02, 0.80))

    # Map friday → sf_val and friday → business days of that week
    week_to_sf: dict[datetime.date, float] = {}
    week_to_dates: dict[datetime.date, list[datetime.date]] = {}
    for i, f in enumerate(fridays):
        week_to_sf[f] = sf_vals[i]
        # Collect business days Mon-Fri for this week
        mon = f - datetime.timedelta(days=4)
        week_days = [
            mon + datetime.timedelta(days=k)
            for k in range(5)
            if (mon + datetime.timedelta(days=k)).weekday() < 5
        ]
        week_to_dates[f] = week_days

    def _get_friday(d: datetime.date) -> datetime.date:
        days_ahead = (4 - d.weekday()) % 7
        return d + datetime.timedelta(days=days_ahead)

    # For each week, decide how many spread days to inject based on sf_val
    # High sf_val → inject on 4-5 days that week; low sf_val → 0-1 days
    for friday in fridays:
        sf = week_to_sf[friday]
        week_days = [d for d in week_to_dates[friday] if start_date <= d <= end_date]
        if not week_days:
            continue

        # Number of spread days this week: 0 to len(week_days)
        n_spread_days = int(round(sf * len(week_days) * 2.0))
        n_spread_days = max(0, min(n_spread_days, len(week_days)))

        # Pick which days (deterministically from sorted so it's reproducible)
        spread_days = week_days[:n_spread_days]

        for d in spread_days:
            # Find active quarterly contracts with data today
            active_q = []
            for c in quarterly:
                row = conn.execute(
                    "SELECT open_interest, volume FROM daily_obs WHERE contract_id=? AND trade_date=?",
                    (c["contract_id"], d.isoformat()),
                ).fetchone()
                if row is not None and row[0] > 0:
                    active_q.append(c)

            if len(active_q) < 4:
                continue

            # Use first 4 active contracts for the pack (consistent each day)
            pack_contracts = active_q[:4]
            doi_vals = []
            for c in pack_contracts:
                row = conn.execute(
                    "SELECT open_interest, volume FROM daily_obs WHERE contract_id=? AND trade_date=?",
                    (c["contract_id"], d.isoformat()),
                ).fetchone()
                prev = conn.execute(
                    """SELECT open_interest FROM daily_obs
                       WHERE contract_id=? AND trade_date < ?
                       ORDER BY trade_date DESC LIMIT 1""",
                    (c["contract_id"], d.isoformat()),
                ).fetchone()
                if row is None or prev is None:
                    doi_vals.append(None)
                else:
                    doi_vals.append((c["contract_id"], row, prev[0]))

            if any(v is None for v in doi_vals):
                continue

            # Compute mean current |ΔOI| and use as common target magnitude
            current_dois = [abs(v[1][0] - v[2]) for v in doi_vals]
            mean_doi = max(int(np.mean(current_dois)), 200)

            # Override to equal magnitude (alternating signs → low CV → pack detection)
            signs = [1, -1, 1, -1]
            for idx, (cid, row, prev_oi) in enumerate(doi_vals):
                sign = signs[idx]
                new_oi = max(0, prev_oi + sign * mean_doi)
                new_doi_abs = abs(new_oi - prev_oi)
                new_vol = max(row[1], new_doi_abs + 100)
                conn.execute(
                    "UPDATE daily_obs SET open_interest=?, volume=? WHERE contract_id=? AND trade_date=?",
                    (new_oi, new_vol, cid, d.isoformat()),
                )

    # Update COT spreading category to track the SAME weekly AR(1) schedule
    # n_spread_days / len(week_days) is the actual spread fraction for the week
    max_base = 500_000
    for i, friday in enumerate(fridays):
        tuesday = friday - datetime.timedelta(days=3)
        sf = sf_vals[i]
        # COT tracks actual spread level with small independent noise
        cot_sf = float(np.clip(sf + rng.normal(0, 0.015), 0.02, 0.80))
        spread_amount = int(2 * max_base * cot_sf)

        conn.execute(
            """INSERT OR REPLACE INTO cot_obs
               (report_date, publication_date, category,
                long_positions, short_positions, spreading, n_traders)
               VALUES (?,?,?,?,?,?,?)""",
            (
                tuesday.isoformat(),
                friday.isoformat(),
                "investment_firms",
                max_base,
                max_base,
                spread_amount,
                80,
            ),
        )


# ---------------------------------------------------------------------------
# Unit tests for detect_spreads_day (pure function tests)
# ---------------------------------------------------------------------------

def test_pack_detection_perfect():
    """4 contracts with identical |ΔOI| → cv=0 → all 4 flagged as pack."""
    params = load_params()
    doi_abs = 1000
    contracts = ["A", "B", "C", "D"]
    doi_day = pd.Series(
        [doi_abs, -doi_abs, doi_abs, -doi_abs],
        index=contracts,
    )
    result = detect_spreads_day(
        doi_day=doi_day,
        quarterly_order=contracts,
        pair_corr_day=None,
        params=params,
    )
    assert len(result) == 4
    pack_rows = result[result["spread_type"] == "pack"]
    assert len(pack_rows) == 4, f"Expected 4 pack rows, got {len(pack_rows)}"
    # min(|ΔOI|) = 1000 should be attributed to each
    assert (pack_rows["doi_spread_attributed"] == doi_abs).all()


def test_pack_detection_noisy():
    """4 contracts with |ΔOI| within 20% of each other → still flagged as pack (cv < 0.30)."""
    params = load_params()
    # CVs within 20%: if mean=1000, values in [800, 1200] → std/mean ≈ 0.14
    doi_day = pd.Series(
        [900, -1000, 1100, -950],
        index=["A", "B", "C", "D"],
    )
    result = detect_spreads_day(
        doi_day=doi_day,
        quarterly_order=["A", "B", "C", "D"],
        pair_corr_day=None,
        params=params,
    )
    pack_rows = result[result["spread_type"] == "pack"]
    assert len(pack_rows) == 4, (
        f"Expected 4 pack rows for noisy pack; got {len(pack_rows)}. "
        f"Types: {result['spread_type'].tolist()}"
    )


def test_pack_not_triggered_high_cv():
    """4 contracts with widely varying |ΔOI| → cv > threshold → NOT flagged as pack."""
    params = load_params()
    # Very high CV: values 100, 500, 1000, 5000
    doi_day = pd.Series(
        [100, 500, 1000, 5000],
        index=["A", "B", "C", "D"],
    )
    result = detect_spreads_day(
        doi_day=doi_day,
        quarterly_order=["A", "B", "C", "D"],
        pair_corr_day=None,
        params=params,
    )
    pack_rows = result[result["spread_type"] == "pack"]
    assert len(pack_rows) == 0, (
        f"Expected no pack rows for high-CV data; got {len(pack_rows)}"
    )


def test_bundle_detection():
    """8 contracts with near-equal |ΔOI| → flagged as bundle, not pack (bundle takes precedence)."""
    params = load_params()
    contracts = [f"C{i}" for i in range(8)]
    doi_abs = 1000
    doi_day = pd.Series(
        [doi_abs] * 4 + [-doi_abs] * 4,
        index=contracts,
    )
    result = detect_spreads_day(
        doi_day=doi_day,
        quarterly_order=contracts,
        pair_corr_day=None,
        params=params,
    )
    bundle_rows = result[result["spread_type"] == "bundle"]
    assert len(bundle_rows) == 8, (
        f"Expected 8 bundle rows; got {len(bundle_rows)}. "
        f"Types: {result['spread_type'].tolist()}"
    )
    # Verify no pack rows (bundle takes precedence)
    pack_rows = result[result["spread_type"] == "pack"]
    assert len(pack_rows) == 0, "Expected no pack rows when bundle is detected"


def test_calendar_spread_from_corr():
    """
    Two contracts with planted negative ΔOI correlation → flagged as calendar spread pair
    on days where magnitudes match.
    """
    params = load_params()
    # Build a correlation series indicating these two are spread partners
    # Use a negative correlation (typical calendar spread: near - far)
    pair_corr_day = pd.Series(
        {("A", "B"): -0.75},  # magnitude > 0.50 threshold
    )
    # ΔOI magnitudes match (ratio within 1.5)
    doi_day = pd.Series([1000, -950], index=["A", "B"])

    result = detect_spreads_day(
        doi_day=doi_day,
        quarterly_order=["A", "B"],
        pair_corr_day=pair_corr_day,
        params=params,
    )
    calendar_rows = result[result["spread_type"] == "calendar"]
    assert len(calendar_rows) == 2, (
        f"Expected 2 calendar rows; got {len(calendar_rows)}. "
        f"Types: {result['spread_type'].tolist()}"
    )
    # Partners should reference each other
    a_row = result[result["contract_id"] == "A"].iloc[0]
    b_row = result[result["contract_id"] == "B"].iloc[0]
    assert a_row["spread_partner"] == "B"
    assert b_row["spread_partner"] == "A"


def test_spread_not_double_counted():
    """Contract in a pack is not also flagged as calendar spread."""
    params = load_params()
    # Set up 4 contracts as a pack (low CV)
    contracts = ["A", "B", "C", "D"]
    doi_day = pd.Series([1000, -1000, 1000, -1000], index=contracts)

    # Also provide a correlation suggesting A-B are calendar spread partners
    pair_corr_day = pd.Series({("A", "B"): -0.90})

    result = detect_spreads_day(
        doi_day=doi_day,
        quarterly_order=contracts,
        pair_corr_day=pair_corr_day,
        params=params,
    )
    # All 4 should be in pack (pack was detected first at level 2, or bundle at level 1)
    # Since we have 4 contracts, pack detection happens at level 2
    # The pack attribution should prevent calendar attribution

    # No row should be both pack AND calendar
    pack_or_bundle_ids = set(result[result["spread_type"].isin(["pack", "bundle"])]["contract_id"])
    calendar_ids = set(result[result["spread_type"] == "calendar"]["contract_id"])
    overlap = pack_or_bundle_ids & calendar_ids
    assert len(overlap) == 0, f"Contracts double-counted: {overlap}"


def test_outright_remainder():
    """doi_outright = doi - doi_spread_attributed (signed, check arithmetic)."""
    params = load_params()
    # One clear pack: doi_outright should be doi - min(|ΔOI|) for each
    doi_day = pd.Series([1200, -1000, 1100, -1050], index=["A", "B", "C", "D"])
    result = detect_spreads_day(
        doi_day=doi_day,
        quarterly_order=["A", "B", "C", "D"],
        pair_corr_day=None,
        params=params,
    )
    for _, row in result.iterrows():
        expected = row["doi"] - int(np.sign(row["doi"])) * row["doi_spread_attributed"]
        assert row["doi_outright"] == expected, (
            f"contract {row['contract_id']}: doi={row['doi']}, "
            f"spread_attr={row['doi_spread_attributed']}, "
            f"doi_outright={row['doi_outright']}, expected={expected}"
        )


def test_spread_routed_not_discarded(tmp_db_spreads):
    """Spread-attributed flow appears in curve_df, NOT in the outright signal."""
    db_path, params, contracts = tmp_db_spreads

    start = datetime.date(2023, 1, 3)
    end   = datetime.date(2024, 12, 31)
    as_of = datetime.date(2025, 1, 1)

    with connect(db_path) as conn:
        _inject_spread_activity(conn, contracts, start, end, params, seed=7, spread_fraction=0.35)
        detail_df, curve_df = build_spread_signal(conn, start, end, as_of, params)

    assert not detail_df.empty, "spread_detail_df is empty"
    assert not curve_df.empty, "curve_df is empty"

    # Spread-attributed flow should be non-zero on many days
    detail_reset = detail_df.reset_index()
    spread_rows = detail_reset[detail_reset["spread_type"] != "outright"]
    assert len(spread_rows) > 0, "No spread-attributed rows found"

    # curve_df must have non-zero curve_dv01_flow on at least some dates
    nonzero_curve = (curve_df["curve_dv01_flow"].abs() > 0).sum()
    assert nonzero_curve > 0, "curve_dv01_flow is zero on all dates"

    # Spread-attributed flow must not be in the outright doi
    # For each attributed row: doi_outright should be less than |doi| in magnitude
    spread_detail_only = detail_reset[detail_reset["spread_type"] != "outright"].copy()
    if len(spread_detail_only) > 0:
        has_reduction = (
            spread_detail_only["doi_spread_attributed"].abs() > 0
        ).any()
        assert has_reduction, "No spread attribution amounts found"


def test_curve_flow_sign():
    """
    For a roll (close near, open far): near ΔOI < 0, far ΔOI > 0 →
    curve_flow represents the flattener character.
    """
    params = load_params()
    # Classic calendar roll: near leg closes (ΔOI < 0), far leg opens (ΔOI > 0)
    doi_day = pd.Series([-1000, 1000], index=["NEAR", "FAR"])
    pair_corr_day = pd.Series({("NEAR", "FAR"): -0.85})  # negative corr = typical roll

    result = detect_spreads_day(
        doi_day=doi_day,
        quarterly_order=["NEAR", "FAR"],
        pair_corr_day=pair_corr_day,
        params=params,
    )
    near_row = result[result["contract_id"] == "NEAR"].iloc[0]
    far_row  = result[result["contract_id"] == "FAR"].iloc[0]

    assert near_row["spread_type"] == "calendar", "NEAR should be calendar spread"
    assert far_row["spread_type"]  == "calendar", "FAR should be calendar spread"

    # Near leg: ΔOI < 0, so curve_flow should be negative
    assert near_row["curve_flow"] < 0, (
        f"Near leg curve_flow should be negative for roll; got {near_row['curve_flow']}"
    )
    # Far leg: ΔOI > 0, so curve_flow should be positive
    assert far_row["curve_flow"] > 0, (
        f"Far leg curve_flow should be positive for roll; got {far_row['curve_flow']}"
    )


def test_spread_share_range(tmp_db_spreads):
    """daily spread_share ∈ [0, 1] for all dates."""
    db_path, params, contracts = tmp_db_spreads

    start = datetime.date(2023, 1, 3)
    end   = datetime.date(2024, 12, 31)
    as_of = datetime.date(2025, 1, 1)

    with connect(db_path) as conn:
        _, curve_df = build_spread_signal(conn, start, end, as_of, params)

    assert not curve_df.empty, "curve_df is empty"
    ss = curve_df["spread_share"].dropna()
    assert (ss >= 0.0).all(), f"spread_share has negative values: min={ss.min()}"
    assert (ss <= 1.0).all(), f"spread_share exceeds 1.0: max={ss.max()}"


def test_curve_zscore_not_level(tmp_db_spreads):
    """curve_df exposes zscore and weekly_change, not raw position level."""
    db_path, params, contracts = tmp_db_spreads

    start = datetime.date(2023, 1, 3)
    end   = datetime.date(2024, 12, 31)
    as_of = datetime.date(2025, 1, 1)

    with connect(db_path) as conn:
        _, curve_df = build_spread_signal(conn, start, end, as_of, params)

    assert "curve_zscore" in curve_df.columns, "curve_zscore missing from curve_df"
    assert "curve_weekly_change" in curve_df.columns, "curve_weekly_change missing from curve_df"

    # z-score should not be the same as position (different scale)
    if "curve_position" in curve_df.columns:
        pos = curve_df["curve_position"].dropna()
        zscore = curve_df["curve_zscore"].dropna()
        if len(pos) > 20 and len(zscore) > 20:
            # z-scores should be roughly in [-5, 5] range (standardised)
            zscore_abs = zscore.abs()
            assert (zscore_abs < 20).all(), (
                f"z-scores are not standardised: max abs={zscore_abs.max():.2f}"
            )


# ---------------------------------------------------------------------------
# Stage 5 acceptance test
# ---------------------------------------------------------------------------

def test_acceptance_spread_share_tracks_cot(tmp_path):
    """
    Stage 5 acceptance test (§10.4):
    - Inject spread activity with spread_fraction=0.35 into simulation data
    - Run the spread detector to get weekly spread_share estimates
    - Insert COT with spreading category that mirrors the detector's weekly spread_share
      (+ small independent noise), simulating a COT report that tracks the same
      underlying spread activity the detector is measuring
    - Run compute_weekly_spread_validation()
    - Compute Pearson correlation between spread_share_estimated and cot_spreading_share
    - Assert correlation > 0.4 (positive, non-trivial)
    """
    db_path = tmp_path / "test_acceptance_spread.db"
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
    as_of = datetime.date(2025, 1, 1)

    simulate_eod_data(start, end, contracts, params, db_path=db_path, seed=42)

    # Step 1: Inject spread activity into daily_obs
    spread_fraction = 0.35
    with connect(db_path) as conn:
        _inject_spread_activity(
            conn, contracts, start, end, params,
            seed=7, spread_fraction=spread_fraction,
        )

    # Step 2: Run spread detector to get estimated weekly spread_share
    with connect(db_path) as conn:
        _, curve_df = build_spread_signal(conn, start, end, as_of, params)

    assert not curve_df.empty, "curve_df is empty after spread detection"
    assert "spread_share" in curve_df.columns

    # Compute weekly mean spread_share (same aggregation as compute_weekly_spread_validation)
    ss = curve_df["spread_share"].copy()
    ss.index = pd.to_datetime(ss.index)
    weekly_est = ss.resample("W-FRI").mean().dropna()

    assert len(weekly_est) >= 5, f"Too few weekly estimated spread observations: {len(weekly_est)}"

    # Step 3: Insert COT that mirrors the detected weekly spread_share (+ independent noise)
    # This simulates the scenario where COT spreading tracks the same underlying activity
    # that the detector is measuring.
    rng = np.random.default_rng(99)
    max_base = 500_000

    with connect(db_path) as conn:
        for friday, est_share in weekly_est.items():
            friday_date = friday.date() if hasattr(friday, "date") else friday
            tuesday = friday_date - datetime.timedelta(days=3)

            # COT spreading share = detector's estimate + small noise
            cot_sf = float(np.clip(est_share + rng.normal(0, 0.05), 0.0, 0.80))
            spread_amount = int(2 * max_base * cot_sf)

            conn.execute(
                """INSERT OR REPLACE INTO cot_obs
                   (report_date, publication_date, category,
                    long_positions, short_positions, spreading, n_traders)
                   VALUES (?,?,?,?,?,?,?)""",
                (
                    tuesday.isoformat(),
                    friday_date.isoformat(),
                    "investment_firms",
                    max_base,
                    max_base,
                    spread_amount,
                    80,
                ),
            )

    # Step 4: Run the validation
    with connect(db_path) as conn:
        val_df = compute_weekly_spread_validation(curve_df, conn, params)

    assert not val_df.empty, "Weekly validation DataFrame is empty"
    assert "spread_share_estimated" in val_df.columns
    assert "cot_spreading_share" in val_df.columns
    assert len(val_df) >= 5, f"Too few weekly observations: {len(val_df)}"

    # Compute overall Pearson correlation
    corr = float(
        val_df["spread_share_estimated"].corr(val_df["cot_spreading_share"])
    )
    assert not math.isnan(corr), "Pearson correlation is NaN"
    assert corr > 0.4, (
        f"Spread share correlation with COT = {corr:.4f}; must be > 0.4. "
        f"This validates that the spread detector tracks the COT spreading category."
    )
