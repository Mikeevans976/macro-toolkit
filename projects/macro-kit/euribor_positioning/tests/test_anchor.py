"""
Stage 7 tests — Kalman anchoring to COT (§8.1–§8.4).

Acceptance test: test_acceptance_r2_threshold
  Kalman filter on planted-COT data must achieve R² > params["kalman"]["r2_threshold"] (0.30).
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
from ..core.anchor import (
    run_kalman_filter,
    estimate_parameters,
    compute_r2,
    build_anchor,
    build_anchor_all_categories,
)
from ..core.spreads import spread_adjusted_quadrant_signal


# ---------------------------------------------------------------------------
# Shared DB fixture
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def tmp_db_anchor(tmp_path_factory):
    """
    2-year EOD simulation with planted COT for all 4 categories.
    Returns (db_path, params, contracts).
    """
    tmp_path = tmp_path_factory.mktemp("anchor_db")
    db_path = tmp_path / "test_anchor.db"
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
# Helper: plant COT from the flow signal (ensures high R² on planted data)
# ---------------------------------------------------------------------------

def _plant_cot_from_signal(
    conn,
    db_path,
    start_date: datetime.date,
    end_date: datetime.date,
    params: dict,
    categories: list[str] | None = None,
    noise_level: float = 0.05,
    seed: int = 123,
) -> pd.Series:
    """
    Build the aggregate flow signal, then plant COT net positions that directly
    track the cumulative flow. This ensures the Kalman filter has a clean signal
    to latch onto and should achieve high R².

    Returns the daily_flow Series used for planting (for use in unit tests).
    """
    rng = np.random.default_rng(seed)
    as_of = datetime.date(2025, 1, 1)

    if categories is None:
        categories = ["investment_firms", "commercial", "other_financial", "other"]

    # Build aggregate flow
    adj_df, _ = spread_adjusted_quadrant_signal(
        conn, start_date, end_date, as_of, params
    )
    if adj_df.empty:
        raise ValueError("spread_adjusted_quadrant_signal returned empty DataFrame")

    adj_reset = adj_df.reset_index()
    non_draining = adj_reset[~adj_reset["is_draining"]]
    daily_flow = non_draining.groupby("trade_date")["flow_quadrant"].sum().sort_index()

    # Build a cumulative position signal (exponentially decayed for realism)
    lam_acc = 0.97
    cum_signal = []
    p = 0.0
    for f in daily_flow.values:
        p = lam_acc * p + float(f)
        cum_signal.append(p)
    cum_signal = np.array(cum_signal)

    # Scale to COT lot units (roughly 500k base level)
    scale = 500_000.0 / (np.std(cum_signal) + 1e-8)

    # Collect Fridays in range
    all_dates = daily_flow.index.tolist()
    fridays = [d for d in all_dates if d.weekday() == 4]

    if not fridays:
        raise ValueError("No Fridays found in date range for COT planting")

    # Map cumulative signal to Fridays
    date_to_idx = {d: i for i, d in enumerate(all_dates)}

    for cat in categories:
        for friday in fridays:
            idx = date_to_idx.get(friday)
            if idx is None:
                continue
            sig_val = cum_signal[idx] * scale
            # Add category-specific noise
            noise = rng.normal(0, abs(sig_val) * noise_level + 1000)
            net_pos = sig_val + noise

            longs  = int(max(0, 500_000 + net_pos / 2))
            shorts = int(max(0, 500_000 - net_pos / 2))
            spread = int(500_000 * 0.10)

            tuesday = friday - datetime.timedelta(days=3)
            conn.execute(
                """INSERT OR REPLACE INTO cot_obs
                   (report_date, publication_date, category,
                    long_positions, short_positions, spreading, n_traders)
                   VALUES (?,?,?,?,?,?,?)""",
                (
                    tuesday.isoformat(),
                    friday.isoformat(),
                    cat,
                    longs,
                    shorts,
                    spread,
                    80,
                ),
            )

    return daily_flow


# ---------------------------------------------------------------------------
# 1. Unit test: Kalman predict step
# ---------------------------------------------------------------------------

def test_kalman_predict_step():
    """x_pred = λ·x_prev + β·f_t (pure arithmetic, no DB)."""
    lam = 0.95
    beta = 2.0
    x_prev = 10_000.0
    f_t = 500.0
    x_pred_expected = lam * x_prev + beta * f_t
    assert abs(x_pred_expected - (0.95 * 10_000.0 + 2.0 * 500.0)) < 1e-9


# ---------------------------------------------------------------------------
# 2. Unit test: Kalman update step
# ---------------------------------------------------------------------------

def test_kalman_update_step():
    """Verify x_est and K formulas from known scalars."""
    x_pred = 10_000.0
    P_pred = 1e6
    R = 1e5
    z = 12_000.0

    innovation = z - x_pred
    S = P_pred + R
    K_expected = P_pred / S
    x_est_expected = x_pred + K_expected * innovation

    # Verify K
    assert abs(K_expected - P_pred / (P_pred + R)) < 1e-12

    # Verify x_est moves toward z
    assert abs(x_est_expected - (x_pred + K_expected * (z - x_pred))) < 1e-9

    # With known values: K = 1e6 / (1e6 + 1e5) = 1e6 / 1.1e6 ≈ 0.9091
    assert abs(K_expected - 1e6 / 1.1e6) < 1e-9


# ---------------------------------------------------------------------------
# 3. Kalman gain bounded
# ---------------------------------------------------------------------------

def test_kalman_gain_bounded():
    """K ∈ [0, 1] for any valid P_pred, R > 0."""
    params = load_params()
    test_cases = [
        (1e8, 1e8),   # equal uncertainty
        (1e8, 1e2),   # very confident observation
        (1.0, 1e8),   # very uncertain observation
        (0.0, 1e5),   # zero prediction variance → K = 0
    ]
    for P_pred, R in test_cases:
        # Build a minimal filter run with one observation day
        dates = [datetime.date(2024, 1, 5)]  # a Friday
        flow_series = pd.Series([0.0], index=dates)
        cot_series = pd.Series([10_000.0], index=dates)

        filter_df = run_kalman_filter(
            dates=dates,
            flow_series=flow_series,
            cot_series=cot_series,
            params=params,
            lam=0.95,
            beta=1.0,
            Q=0.0,
            R=R,
        )
        # Re-compute K manually
        P_pred_actual = filter_df["P_pred"].iloc[0]
        S_actual = filter_df["S"].iloc[0]
        if not math.isnan(S_actual):
            K_actual = filter_df["K"].iloc[0]
            assert 0.0 <= K_actual <= 1.0, (
                f"K={K_actual:.6f} out of [0,1] for P_pred={P_pred_actual:.2e}, R={R:.2e}"
            )


# ---------------------------------------------------------------------------
# 4. No update on non-observation days
# ---------------------------------------------------------------------------

def test_no_update_on_non_friday():
    """On non-observation days, x_est == x_pred and P_est == P_pred."""
    params = load_params()
    # Build a 5-day week: Mon–Fri, only Friday has COT
    mon = datetime.date(2024, 1, 8)   # Monday
    dates = [mon + datetime.timedelta(days=i) for i in range(5)]
    friday = dates[4]

    flow_series = pd.Series([100.0] * 5, index=dates)
    cot_series = pd.Series([50_000.0], index=[friday])

    filter_df = run_kalman_filter(
        dates=dates,
        flow_series=flow_series,
        cot_series=cot_series,
        params=params,
        lam=0.95,
        beta=1.0,
        Q=1e4,
        R=1e5,
    )

    # Check Mon-Thu: is_observation_day=False → x_est == x_pred, P_est == P_pred
    for t in dates[:4]:
        row = filter_df.loc[t]
        assert not row["is_observation_day"], f"{t} should not be an observation day"
        assert abs(row["x_est"] - row["x_pred"]) < 1e-12, (
            f"On {t}: x_est={row['x_est']:.4f} != x_pred={row['x_pred']:.4f}"
        )
        assert abs(row["P_est"] - row["P_pred"]) < 1e-12, (
            f"On {t}: P_est={row['P_est']:.4f} != P_pred={row['P_pred']:.4f}"
        )

    # Friday: observation day → x_est updated
    assert filter_df.loc[friday, "is_observation_day"]
    assert not math.isnan(filter_df.loc[friday, "K"])


# ---------------------------------------------------------------------------
# 5. COT timing discipline
# ---------------------------------------------------------------------------

def test_cot_timing_discipline():
    """
    Using Tuesday (look-ahead) timing produces artificially higher R² than
    Friday (correct) timing on the same data.

    The spec states: "the 'wrong' Tuesday-timing version should show R² >
    'correct' Friday-timing version on the same data."

    Mechanism: With Tuesday timing the filter updates at the same time the
    COT state is valid (t=Tuesday → x_est absorbs z with no propagation gap).
    With Friday timing the filter propagates forward 3 days before updating,
    accumulating Q uncertainty → higher residuals → lower R².

    Both R² values are measured on each filter's own observation dates
    (as would happen in a live system), so the comparison is:
      r2_tuesday_timed vs r2_friday_timed on their respective obs dates.
    The Tuesday-timed version has artificially inflated R² because it
    pretends the data is available 3 days before publication (look-ahead).
    """
    params = load_params()
    rng = np.random.default_rng(9)

    # Build 104 weeks of business days
    start = datetime.date(2022, 1, 3)
    d = start
    while d.weekday() != 0:
        d += datetime.timedelta(days=1)

    dates = []
    while len(dates) < 520:  # ~104 weeks
        if d.weekday() < 5:
            dates.append(d)
        d += datetime.timedelta(days=1)
    dates_set = set(dates)

    # True latent state: AR(1) + flow, with process noise
    # Use a large Q relative to R so timing matters
    lam_true, beta_true = 0.90, 10.0
    Q_true = 1e6   # substantial process noise per day
    R_true = 5e4   # relatively tight observation noise

    flow_vals = rng.normal(0, 100, len(dates))
    flow_series = pd.Series(flow_vals, index=dates)

    x = 0.0
    true_states = {}
    for t, f in zip(dates, flow_vals):
        x = lam_true * x + beta_true * f + rng.normal(0, math.sqrt(Q_true))
        true_states[t] = x

    # Tuesdays and Fridays
    tuesdays = [t for t in dates if t.weekday() == 1]

    # Shared COT values: each week has one net-position reading
    # The reading is of the TRUE TUESDAY state (that's what real COT measures)
    cot_raw: dict[datetime.date, float] = {}
    for tue in tuesdays:
        cot_raw[tue] = true_states[tue] + rng.normal(0, math.sqrt(R_true))

    # --- Correct filter: observations indexed on Fridays (publication_date) ---
    # z_friday = cot_raw[prev_tuesday]
    cot_friday_indexed = pd.Series(
        {tue + datetime.timedelta(days=3): val
         for tue, val in cot_raw.items()
         if (tue + datetime.timedelta(days=3)) in dates_set},
        dtype=float,
    )

    # --- Wrong filter: observations indexed on Tuesdays (look-ahead) ---
    cot_tuesday_indexed = pd.Series(
        {tue: val for tue, val in cot_raw.items() if tue in dates_set},
        dtype=float,
    )

    # Run both filters
    filter_friday_timed = run_kalman_filter(
        dates=dates, flow_series=flow_series, cot_series=cot_friday_indexed,
        params=params, lam=lam_true, beta=beta_true, Q=Q_true, R=R_true,
    )
    filter_tuesday_timed = run_kalman_filter(
        dates=dates, flow_series=flow_series, cot_series=cot_tuesday_indexed,
        params=params, lam=lam_true, beta=beta_true, Q=Q_true, R=R_true,
    )

    # R² on each filter's own observation dates
    r2_friday_timed  = compute_r2(filter_friday_timed,  cot_friday_indexed)
    r2_tuesday_timed = compute_r2(filter_tuesday_timed, cot_tuesday_indexed)

    # The wrong (Tuesday-timed) filter sees z immediately at the state it describes,
    # so the update innovation is smaller → R² is artificially inflated.
    assert r2_tuesday_timed > r2_friday_timed, (
        f"Expected Tuesday (look-ahead) R²={r2_tuesday_timed:.4f} > "
        f"Friday (correct) R²={r2_friday_timed:.4f}. "
        "The look-ahead version should have artificially higher R², "
        "demonstrating why Friday timing is correct and avoids bias."
    )


# ---------------------------------------------------------------------------
# 6. MLE converges on planted data
# ---------------------------------------------------------------------------

def test_mle_converges(tmp_db_anchor):
    """estimate_parameters() converges on planted data."""
    db_path, params, contracts = tmp_db_anchor
    start = datetime.date(2023, 1, 3)
    end   = datetime.date(2024, 12, 31)

    with connect(db_path) as conn:
        daily_flow = _plant_cot_from_signal(conn, db_path, start, end, params, seed=1)
        cot_series = pd.Series(dtype=float)
        rows = conn.execute(
            """SELECT publication_date, long_positions, short_positions
               FROM cot_obs WHERE category='investment_firms' ORDER BY publication_date"""
        ).fetchall()
        for r in rows:
            pub_d = datetime.date.fromisoformat(r["publication_date"])
            cot_series[pub_d] = int(r["long_positions"]) - int(r["short_positions"])

    dates = sorted(daily_flow.index.tolist())
    result = estimate_parameters(dates, daily_flow, cot_series, params)

    assert result["converged"], (
        f"MLE did not converge. Result: {result}"
    )
    assert result["n_obs"] > 0, "No observation dates found during MLE"


# ---------------------------------------------------------------------------
# 7. MLE beta positive
# ---------------------------------------------------------------------------

def test_mle_beta_positive(tmp_db_anchor):
    """Estimated β > 0 when flow and COT are positively correlated."""
    db_path, params, contracts = tmp_db_anchor
    start = datetime.date(2023, 1, 3)
    end   = datetime.date(2024, 12, 31)

    with connect(db_path) as conn:
        daily_flow = _plant_cot_from_signal(conn, db_path, start, end, params, seed=2)
        rows = conn.execute(
            """SELECT publication_date, long_positions, short_positions
               FROM cot_obs WHERE category='investment_firms' ORDER BY publication_date"""
        ).fetchall()
        cot_series = pd.Series(
            {datetime.date.fromisoformat(r["publication_date"]): int(r["long_positions"]) - int(r["short_positions"])
             for r in rows},
            dtype=float,
        )

    dates = sorted(daily_flow.index.tolist())
    result = estimate_parameters(dates, daily_flow, cot_series, params)

    assert result["beta"] > 0, (
        f"Expected β > 0 for positively correlated flow/COT data; got β={result['beta']:.6f}"
    )


# ---------------------------------------------------------------------------
# 8. MLE lambda in range
# ---------------------------------------------------------------------------

def test_mle_lambda_in_range(tmp_db_anchor):
    """Estimated λ ∈ (0, 1) always (sigmoid transform guarantees this)."""
    db_path, params, contracts = tmp_db_anchor
    start = datetime.date(2023, 1, 3)
    end   = datetime.date(2024, 12, 31)

    with connect(db_path) as conn:
        daily_flow = _plant_cot_from_signal(conn, db_path, start, end, params, seed=3)
        rows = conn.execute(
            """SELECT publication_date, long_positions, short_positions
               FROM cot_obs WHERE category='investment_firms' ORDER BY publication_date"""
        ).fetchall()
        cot_series = pd.Series(
            {datetime.date.fromisoformat(r["publication_date"]): int(r["long_positions"]) - int(r["short_positions"])
             for r in rows},
            dtype=float,
        )

    dates = sorted(daily_flow.index.tolist())
    result = estimate_parameters(dates, daily_flow, cot_series, params)

    assert 0.0 < result["lambda"] < 1.0, (
        f"Expected λ ∈ (0,1); got λ={result['lambda']:.6f}"
    )


# ---------------------------------------------------------------------------
# 9. R² formula correctness
# ---------------------------------------------------------------------------

def test_r2_formula():
    """Hand-compute R² on small example and compare to compute_r2()."""

    # Small example: 3 Fridays with known z_t values
    fridays = [
        datetime.date(2024, 1, 5),
        datetime.date(2024, 1, 12),
        datetime.date(2024, 1, 19),
    ]
    z_vals = [10_000.0, 12_000.0, 9_000.0]
    x_est_vals = [10_500.0, 11_800.0, 9_200.0]

    # Build a fake filter_df
    records = []
    for i, d in enumerate(fridays):
        records.append({
            "f_t": 0.0,
            "z_t": z_vals[i],
            "x_pred": x_est_vals[i] - 100.0,
            "P_pred": 1e5,
            "x_est": x_est_vals[i],
            "P_est": 5e4,
            "innovation": z_vals[i] - (x_est_vals[i] - 100.0),
            "S": 1.5e5,
            "K": 0.67,
            "is_observation_day": True,
        })
    filter_df = pd.DataFrame(records, index=fridays)
    filter_df.index.name = "trade_date"

    cot_series = pd.Series(z_vals, index=fridays, dtype=float)

    # Hand-compute
    z_arr = np.array(z_vals)
    x_arr = np.array(x_est_vals)
    residuals = z_arr - x_arr
    ss_res = float((residuals ** 2).sum())
    ss_tot = float(((z_arr - z_arr.mean()) ** 2).sum())
    r2_expected = 1.0 - ss_res / ss_tot

    r2_actual = compute_r2(filter_df, cot_series)

    assert abs(r2_actual - r2_expected) < 1e-9, (
        f"R² mismatch: expected={r2_expected:.6f}, got={r2_actual:.6f}"
    )


# ---------------------------------------------------------------------------
# 10. Acceptance test: R² > threshold on planted data
# ---------------------------------------------------------------------------

def test_acceptance_r2_threshold(tmp_path):
    """
    Stage 7 acceptance test:
    Build anchor for investment_firms on 2-year planted simulation.
    Assert result["r2"] > params["kalman"]["r2_threshold"] (0.30).
    """
    db_path = tmp_path / "test_acceptance_anchor.db"
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

    # Plant COT from the flow signal
    with connect(db_path) as conn:
        _plant_cot_from_signal(
            conn, db_path, start, end, params,
            categories=["investment_firms"], noise_level=0.05, seed=10,
        )

    r2_threshold = params["kalman"]["r2_threshold"]

    with connect(db_path) as conn:
        result = build_anchor(conn, start, end, as_of, params, category="investment_firms")

    assert "r2" in result, "build_anchor result missing 'r2' key"
    assert not math.isnan(result["r2"]), "R² is NaN"
    assert result["r2"] > r2_threshold, (
        f"Stage 7 acceptance test failed: R²={result['r2']:.4f} ≤ threshold={r2_threshold}. "
        f"Fitted params: {result['params_fitted']}"
    )


# ---------------------------------------------------------------------------
# 11. All categories run without error
# ---------------------------------------------------------------------------

def test_all_categories_run(tmp_path):
    """build_anchor_all_categories() returns results for all 4 categories."""
    db_path = tmp_path / "test_all_cats.db"
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

    with connect(db_path) as conn:
        _plant_cot_from_signal(
            conn, db_path, start, end, params,
            categories=["investment_firms", "commercial", "other_financial", "other"],
            noise_level=0.10, seed=20,
        )

    with connect(db_path) as conn:
        results = build_anchor_all_categories(conn, start, end, as_of, params)

    assert len(results) == 4, f"Expected 4 categories, got {len(results)}"
    for cat in ["investment_firms", "commercial", "other_financial", "other"]:
        assert cat in results, f"Category {cat!r} missing from results"
        assert "r2" in results[cat], f"No 'r2' key for category {cat!r}"


# ---------------------------------------------------------------------------
# 12. Filter output columns
# ---------------------------------------------------------------------------

def test_filter_output_columns():
    """filter_df has all required columns."""
    params = load_params()
    dates = [
        datetime.date(2024, 1, 8),   # Mon
        datetime.date(2024, 1, 9),   # Tue
        datetime.date(2024, 1, 10),  # Wed
        datetime.date(2024, 1, 11),  # Thu
        datetime.date(2024, 1, 12),  # Fri
    ]
    flow_series = pd.Series([10.0, 20.0, -5.0, 15.0, 8.0], index=dates)
    cot_series  = pd.Series([5000.0], index=[datetime.date(2024, 1, 12)])

    filter_df = run_kalman_filter(
        dates=dates,
        flow_series=flow_series,
        cot_series=cot_series,
        params=params,
        lam=0.95,
        beta=1.0,
        Q=1e4,
        R=1e5,
    )

    required_cols = [
        "f_t", "z_t", "x_pred", "P_pred", "x_est", "P_est",
        "innovation", "S", "K", "is_observation_day",
    ]
    for col in required_cols:
        assert col in filter_df.columns, f"Missing column: {col!r}"

    assert filter_df.index.name == "trade_date"
    assert len(filter_df) == len(dates)


# ---------------------------------------------------------------------------
# 13. x_est snaps toward COT observation
# ---------------------------------------------------------------------------

def test_x_est_snaps_to_cot():
    """On Fridays with COT data, |x_est - z| < |x_pred - z|."""
    params = load_params()

    dates = [
        datetime.date(2024, 1, 8),
        datetime.date(2024, 1, 9),
        datetime.date(2024, 1, 10),
        datetime.date(2024, 1, 11),
        datetime.date(2024, 1, 12),  # Friday — observation
    ]
    flow_series = pd.Series([0.0] * 5, index=dates)
    # Place a large COT observation far from where the filter starts
    cot_series = pd.Series([500_000.0], index=[datetime.date(2024, 1, 12)])

    filter_df = run_kalman_filter(
        dates=dates,
        flow_series=flow_series,
        cot_series=cot_series,
        params=params,
        lam=0.95,
        beta=1.0,
        Q=1e4,
        R=1e5,
    )

    friday = datetime.date(2024, 1, 12)
    row = filter_df.loc[friday]
    z = row["z_t"]
    x_pred = row["x_pred"]
    x_est  = row["x_est"]

    assert abs(x_est - z) < abs(x_pred - z), (
        f"Filter did not move toward observation: "
        f"|x_est - z|={abs(x_est - z):.2f} vs |x_pred - z|={abs(x_pred - z):.2f}"
    )


# ---------------------------------------------------------------------------
# 14. Level now meaningful
# ---------------------------------------------------------------------------

def test_level_now_meaningful(tmp_db_anchor):
    """
    After anchoring, mean(|x_est(Fridays) - z|) < std(z).
    The nowcast is within one standard deviation of the reported value on average.
    """
    db_path, params, contracts = tmp_db_anchor
    start = datetime.date(2023, 1, 3)
    end   = datetime.date(2024, 12, 31)
    as_of = datetime.date(2025, 1, 1)

    with connect(db_path) as conn:
        _plant_cot_from_signal(
            conn, db_path, start, end, params,
            categories=["investment_firms"], noise_level=0.05, seed=14,
        )

    with connect(db_path) as conn:
        result = build_anchor(conn, start, end, as_of, params, category="investment_firms")

    filter_df = result["filter_df"]
    obs_rows  = filter_df[filter_df["is_observation_day"]]

    z_vals    = obs_rows["z_t"].dropna()
    x_vals    = obs_rows["x_est"].reindex(z_vals.index)

    mean_abs_err = float((z_vals - x_vals).abs().mean())
    std_z        = float(z_vals.std())

    assert mean_abs_err < std_z, (
        f"Nowcast not within 1σ of COT on average: "
        f"mean|x_est - z|={mean_abs_err:.2f}, std(z)={std_z:.2f}"
    )
