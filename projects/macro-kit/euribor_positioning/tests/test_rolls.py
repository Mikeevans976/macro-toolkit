"""
Stage 2 tests — contract calendar & fixed-contract ΔOI (§6.1).

Acceptance test:  test_roll_neutrality (§10.5)
  Total complex DV01 must not jump discontinuously on IMM roll dates.

Supporting tests:
  test_doi_fixed_contract      — ΔOI only within a single contract_id
  test_expiry_drain_flag       — drain flag fires before LTD when OI < threshold
  test_pack_assignment         — pack labels are correct for ranks 1-16+
  test_ttm_bucket              — bucket edges at 364/365/729/730/1094/1095 days
  test_generic_rank_monotone   — generic_rank increases with expiry
  test_serial_has_no_pack      — serial contracts get pack=None
"""

import datetime
import statistics

import pytest

from ..data.db import connect, init_db, load_params
from ..data.contract_calendar import generate_contracts
from ..data.ingest_ice_eod import simulate_eod_data

from ..core.rolls import (
    assign_pack,
    assign_ttm_bucket,
    build_daily_summary,
    complex_dv01_total,
    imm_roll_dates,
    compute_doi,
)


# ---------------------------------------------------------------------------
# Shared fixture — 2-year window, quarterly strip, 2024-2025
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def tmp_db(tmp_path_factory):
    """
    Temporary SQLite DB with schema and simulation data.
    Mirrors the pattern from test_integrity.py but scoped to module
    to avoid recreating for every test.
    """
    tmp_path = tmp_path_factory.mktemp("rolls_db")
    db_path = tmp_path / "test_rolls.db"
    params = load_params()
    params["database"]["path"] = str(db_path)

    init_db(db_path)

    contracts = generate_contracts(
        root=params["contracts"]["euribor_root"],
        start_year=2023,
        end_year=2028,
        include_serials=False,
    )
    with connect(db_path) as conn:
        conn.executemany(
            """INSERT OR IGNORE INTO contracts
               (contract_id, root, expiry_date, last_trading_day, contract_type, listing_date)
               VALUES (:contract_id, :root, :expiry_date, :last_trading_day, :contract_type, :listing_date)""",
            contracts,
        )

    simulate_eod_data(
        datetime.date(2024, 1, 2),
        datetime.date(2025, 12, 31),
        contracts,
        params,
        db_path=db_path,
    )

    return db_path, params, contracts


# ---------------------------------------------------------------------------
# §10.5  Roll neutrality — the acceptance test
# ---------------------------------------------------------------------------

def test_roll_neutrality(tmp_db):
    """
    §10.5: Total complex DV01 must not jump discontinuously on IMM roll dates.

    Strategy:
      1. Compute complex_dv01_total for every business day in the 2-year window.
      2. Compute day-over-day changes in total DV01.
      3. Identify IMM roll dates (last_trading_day of each quarterly contract).
      4. Assert that |DV01 change| on each roll date is < 3σ of all daily changes.
    """
    db_path, params, contracts = tmp_db

    start = datetime.date(2024, 1, 2)
    end   = datetime.date(2025, 12, 31)

    # Collect all business days in the range
    bdays = []
    d = start
    while d <= end:
        if d.weekday() < 5:
            bdays.append(d)
        d += datetime.timedelta(days=1)

    # Use as_of_date = end of range (we want the full picture)
    as_of = end

    with connect(db_path) as conn:
        dv01_series = {}
        for td in bdays:
            dv01_series[td] = complex_dv01_total(conn, td, as_of, params)

    # Day-over-day changes
    sorted_days = sorted(dv01_series)
    changes = {}
    for i in range(1, len(sorted_days)):
        prev_day = sorted_days[i - 1]
        curr_day = sorted_days[i]
        changes[curr_day] = abs(dv01_series[curr_day] - dv01_series[prev_day])

    # Only test if we have enough data points
    assert len(changes) >= 10, "Too few trading days to run roll-neutrality test"

    change_values = list(changes.values())
    sigma = statistics.stdev(change_values)

    # IMM roll dates within the window (change series starts from day 2)
    roll_dates = set(
        imm_roll_dates(contracts, sorted_days[1], sorted_days[-1])
    )

    # Assert no roll date has a discontinuous jump > 3σ
    threshold = 3.0 * sigma
    violations = []
    for rd in sorted(roll_dates):
        if rd in changes:
            if changes[rd] > threshold:
                violations.append(
                    f"Roll date {rd}: |ΔDVO1|={changes[rd]:,.0f} > 3σ={threshold:,.0f}"
                )

    assert violations == [], (
        "DV01 jumps discontinuously on IMM roll dates (§10.5 FAIL):\n"
        + "\n".join(violations)
        + f"\nAll daily changes: mean={statistics.mean(change_values):,.0f}, "
        f"σ={sigma:,.0f}, max={max(change_values):,.0f}"
    )


# ---------------------------------------------------------------------------
# test_doi_fixed_contract
# ---------------------------------------------------------------------------

def test_doi_fixed_contract(tmp_db):
    """
    §6.1.2: ΔOI is computed only within a single contract_id, never across
    contracts.  Verify that each doi row's prev_oi comes from the same
    contract_id (the SQL LAG partitions by contract_id).
    """
    db_path, params, contracts = tmp_db
    trade_date = datetime.date(2024, 6, 17)
    as_of = datetime.date(2025, 12, 31)

    with connect(db_path) as conn:
        rows = compute_doi(conn, trade_date, as_of, params)

    assert rows, "No DOI rows returned — check simulation date range"

    for row in rows:
        # prev_oi (if not None) must be this contract's own prior OI
        # We verify by re-querying the immediately preceding trade_date
        with connect(db_path) as conn:
            prev_row = conn.execute(
                """SELECT open_interest FROM daily_obs
                   WHERE contract_id = ?
                     AND trade_date < ?
                     AND knowledge_date <= ?
                   ORDER BY trade_date DESC LIMIT 1""",
                (row["contract_id"], trade_date.isoformat(), as_of.isoformat()),
            ).fetchone()
        if row["prev_oi"] is not None:
            assert prev_row is not None, (
                f"prev_oi={row['prev_oi']} reported but no prior row found for "
                f"{row['contract_id']}"
            )
            assert row["prev_oi"] == prev_row[0], (
                f"prev_oi mismatch for {row['contract_id']}: "
                f"compute_doi={row['prev_oi']}, direct query={prev_row[0]}"
            )


# ---------------------------------------------------------------------------
# test_expiry_drain_flag
# ---------------------------------------------------------------------------

def test_expiry_drain_flag():
    """
    §6.1.1: The drain flag fires when current OI drops below
    fraction_of_3m_peak × trailing_peak_OI.

    Strategy: Build a minimal in-memory DB with a single quarterly contract.
    Insert 70 daily OI rows:
      - Days 1–63: OI = 100,000 (high, building peak)
      - Day 64 onwards: OI drops to 5,000 (5% of peak → well below 10% threshold)

    Verify that build_daily_summary flags is_draining=True on day 64.
    """
    import tempfile
    from pathlib import Path

    tmp_path = Path(tempfile.mkdtemp())
    db_path = tmp_path / "drain_test.db"
    params = load_params()
    params["database"]["path"] = str(db_path)

    init_db(db_path)

    from ..data.db import next_business_day

    # A single quarterly contract expiring well in the future
    contract_id = "FEI_2027H"
    expiry = datetime.date(2027, 3, 17)
    ltd = datetime.date(2027, 3, 15)

    with connect(db_path) as conn:
        conn.execute(
            """INSERT INTO contracts
               (contract_id, root, expiry_date, last_trading_day, contract_type)
               VALUES (?,?,?,?,?)""",
            (contract_id, "FEI", expiry.isoformat(), ltd.isoformat(), "quarterly"),
        )

    # Build a sequence of trade dates (business days starting 2024-01-02)
    trade_dates = []
    d = datetime.date(2024, 1, 2)
    while len(trade_dates) < 70:
        if d.weekday() < 5:
            trade_dates.append(d)
        d += datetime.timedelta(days=1)

    peak_oi = 100_000
    drain_oi = 5_000  # 5% of peak → below 10% threshold

    with connect(db_path) as conn:
        for i, td in enumerate(trade_dates):
            oi = peak_oi if i < 63 else drain_oi
            kd = next_business_day(td)
            conn.execute(
                """INSERT INTO daily_obs
                   (contract_id, trade_date, knowledge_date,
                    settlement_price, open_interest, volume)
                   VALUES (?,?,?,?,?,?)""",
                (contract_id, td.isoformat(), kd.isoformat(), 97.5, oi, 1000),
            )

    as_of = datetime.date(2025, 12, 31)
    drain_date = trade_dates[65]  # well into the drain period (i >= 63)

    with connect(db_path) as conn:
        summary = build_daily_summary(
            conn, drain_date, as_of, params, include_draining=True
        )

    assert summary, f"No rows returned for drain_date={drain_date}"
    row = summary[0]
    assert row["is_draining"], (
        f"Expected is_draining=True on {drain_date} "
        f"(OI={row['open_interest']}, drain threshold should be "
        f"{0.10 * peak_oi:,.0f} = 10% of {peak_oi:,} peak)"
    )

    # Also verify the flag is NOT set at peak (early date)
    early_date = trade_dates[30]
    with connect(db_path) as conn:
        summary_early = build_daily_summary(
            conn, early_date, as_of, params, include_draining=True
        )
    assert summary_early, f"No rows for early_date={early_date}"
    assert not summary_early[0]["is_draining"], (
        f"Expected is_draining=False at peak OI on {early_date}"
    )


# ---------------------------------------------------------------------------
# test_pack_assignment
# ---------------------------------------------------------------------------

def test_pack_assignment():
    """§6.1.3: Pack labels assigned correctly for ranks 1-17+."""
    assert assign_pack(1)  == "whites"
    assert assign_pack(2)  == "whites"
    assert assign_pack(4)  == "whites"
    assert assign_pack(5)  == "reds"
    assert assign_pack(8)  == "reds"
    assert assign_pack(9)  == "greens"
    assert assign_pack(12) == "greens"
    assert assign_pack(13) == "blues"
    assert assign_pack(16) == "blues"
    assert assign_pack(17) == "ultra"
    assert assign_pack(20) == "ultra"


# ---------------------------------------------------------------------------
# test_ttm_bucket
# ---------------------------------------------------------------------------

def test_ttm_bucket():
    """§6.1.3: TTM bucket edges are correct."""
    assert assign_ttm_bucket(0)    == "0-1y"
    assert assign_ttm_bucket(364)  == "0-1y"
    assert assign_ttm_bucket(365)  == "1-2y"
    assert assign_ttm_bucket(729)  == "1-2y"
    assert assign_ttm_bucket(730)  == "2-3y"
    assert assign_ttm_bucket(1094) == "2-3y"
    assert assign_ttm_bucket(1095) == "3y+"
    assert assign_ttm_bucket(2000) == "3y+"


# ---------------------------------------------------------------------------
# test_generic_rank_monotone
# ---------------------------------------------------------------------------

def test_generic_rank_monotone(tmp_db):
    """
    §6.1.3: generic_rank must increase monotonically with expiry_date for
    quarterly contracts on any given trade_date.
    """
    db_path, params, contracts = tmp_db
    trade_date = datetime.date(2024, 4, 15)
    as_of = datetime.date(2025, 12, 31)

    with connect(db_path) as conn:
        summary = build_daily_summary(
            conn, trade_date, as_of, params, include_draining=True
        )

    quarterly_rows = [
        r for r in summary if r["contract_type"] == "quarterly" and r["generic_rank"] is not None
    ]
    assert quarterly_rows, "No quarterly rows returned"

    quarterly_rows.sort(key=lambda r: r["generic_rank"])
    for i in range(1, len(quarterly_rows)):
        prev = quarterly_rows[i - 1]
        curr = quarterly_rows[i]
        assert curr["expiry_date"] >= prev["expiry_date"], (
            f"generic_rank not monotone with expiry: rank {prev['generic_rank']} "
            f"(exp={prev['expiry_date']}) vs rank {curr['generic_rank']} "
            f"(exp={curr['expiry_date']})"
        )
        assert curr["generic_rank"] > prev["generic_rank"], (
            f"Duplicate or non-monotone generic_rank: {prev['generic_rank']} -> {curr['generic_rank']}"
        )


# ---------------------------------------------------------------------------
# test_serial_has_no_pack
# ---------------------------------------------------------------------------

def test_serial_has_no_pack():
    """
    §6.1.4: Serial contracts must NOT get a pack label.
    We synthesise a minimal scenario: two quarterly + two serial contracts,
    insert them into a fresh DB, and check that build_daily_summary returns
    pack=None for serials.
    """
    import tempfile
    from pathlib import Path

    tmp_path = Path(tempfile.mkdtemp())
    db_path = tmp_path / "serial_test.db"
    params = load_params()
    params["database"]["path"] = str(db_path)

    init_db(db_path)

    from ..data.contract_calendar import generate_contracts as gc
    from ..data.db import next_business_day

    # Use a range that includes serial months (include_serials=True)
    all_contracts = gc("FEI", 2024, 2025, include_serials=True)

    with connect(db_path) as conn:
        conn.executemany(
            """INSERT OR IGNORE INTO contracts
               (contract_id, root, expiry_date, last_trading_day, contract_type, listing_date)
               VALUES (:contract_id, :root, :expiry_date, :last_trading_day, :contract_type, :listing_date)""",
            all_contracts,
        )

    # Insert one observation for each active contract on 2024-04-15
    trade_date = datetime.date(2024, 4, 15)
    knowledge_date = next_business_day(trade_date)

    with connect(db_path) as conn:
        for c in all_contracts:
            exp = datetime.date.fromisoformat(c["expiry_date"])
            if exp < trade_date:
                continue
            # Insert a minimal row
            conn.execute(
                """INSERT OR IGNORE INTO daily_obs
                   (contract_id, trade_date, knowledge_date, settlement_price,
                    open_interest, volume)
                   VALUES (?,?,?,?,?,?)""",
                (c["contract_id"], trade_date.isoformat(), knowledge_date.isoformat(),
                 97.5, 10000, 500),
            )

    as_of = datetime.date(2024, 12, 31)
    with connect(db_path) as conn:
        summary = build_daily_summary(
            conn, trade_date, as_of, params, include_draining=True
        )

    serial_rows = [r for r in summary if r["contract_type"] == "serial"]
    quarterly_rows = [r for r in summary if r["contract_type"] == "quarterly"]

    assert serial_rows, "No serial rows found — check include_serials=True"
    assert quarterly_rows, "No quarterly rows found"

    for r in serial_rows:
        assert r["pack"] is None, (
            f"Serial {r['contract_id']} has pack={r['pack']!r}; expected None"
        )
        # Serials still get a ttm_bucket
        assert r["ttm_bucket"] in {"0-1y", "1-2y", "2-3y", "3y+"}, (
            f"Serial {r['contract_id']} has unexpected ttm_bucket={r['ttm_bucket']!r}"
        )
        # Serials have no generic_rank
        assert r["generic_rank"] is None, (
            f"Serial {r['contract_id']} has generic_rank={r['generic_rank']!r}; expected None"
        )

    for r in quarterly_rows:
        assert r["pack"] is not None, (
            f"Quarterly {r['contract_id']} has pack=None (should have a label)"
        )
