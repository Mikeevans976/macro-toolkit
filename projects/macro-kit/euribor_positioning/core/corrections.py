"""
Stage 9 — €STR migration correction and option delta adjustment (§7.1, §7.4).

Provides:
  - detect_migration_days       : flag dates where Euribor OI falls match €STR OI rises
  - apply_migration_correction  : scale down doi_outright on migration days
  - third_friday                : 3rd Friday of a given year/month (option expiry)
  - option_expiry_dates         : list all 3rd Fridays over a year range
  - flag_option_delta_days      : flag option-expiry / ECB proximity days with large ΔOI
  - build_corrected_signal      : Stage 9 master pipeline
  - inject_migration_events     : test helper — insert synthetic migration events into DB

The final flow column for Stage 10 is `flow_final`.
"""

from __future__ import annotations

import calendar
import math
from datetime import date, timedelta
from typing import Optional

import numpy as np
import pandas as pd

from .spreads import spread_adjusted_quadrant_signal


# ---------------------------------------------------------------------------
# Hardcoded ECB meeting dates 2023–2026
# ---------------------------------------------------------------------------

_ECB_MEETING_DATES: list[date] = [
    # 2023
    date(2023, 2, 2),  date(2023, 3, 16), date(2023, 5, 4),  date(2023, 6, 15),
    date(2023, 7, 27), date(2023, 9, 14), date(2023, 10, 26), date(2023, 12, 14),
    # 2024
    date(2024, 1, 25), date(2024, 3, 7),  date(2024, 4, 11), date(2024, 6, 6),
    date(2024, 7, 18), date(2024, 9, 12), date(2024, 10, 17), date(2024, 12, 12),
    # 2025
    date(2025, 1, 30), date(2025, 3, 6),  date(2025, 4, 17), date(2025, 6, 5),
    date(2025, 7, 24), date(2025, 9, 11), date(2025, 10, 30), date(2025, 12, 18),
    # 2026
    date(2026, 1, 29), date(2026, 3, 5),  date(2026, 4, 16), date(2026, 6, 4),
    date(2026, 7, 23), date(2026, 9, 10), date(2026, 10, 29), date(2026, 12, 17),
]


# ---------------------------------------------------------------------------
# §7.4  €STR migration detection
# ---------------------------------------------------------------------------

def detect_migration_days(
    conn,
    start_date: date,
    end_date: date,
    as_of_date: date,
    params: dict,
) -> pd.DataFrame:
    """
    Returns DataFrame indexed by trade_date with columns:
        delta_euribor_oi      signed sum of ΔOI across all Euribor contracts
        delta_estr_oi         signed sum of ΔOI across all €STR contracts
        migration_flag        bool
        migration_ratio       |delta_estr_oi| / |delta_euribor_oi|, NaN if no Euribor fall
        migration_matched_oi  lots matched (to be suppressed from Euribor flow)
    """
    mp = params.get("migration", {})
    ratio_lower    = float(mp.get("ratio_lower",    0.70))
    ratio_upper    = float(mp.get("ratio_upper",    1.30))
    min_estr_oi    = float(mp.get("min_estr_oi_change", 500))
    corr_weight    = float(mp.get("correction_weight", 1.0))

    euribor_root = params["contracts"].get("euribor_root", "FEI")
    estr_root    = params["contracts"].get("estr_root",    "FEF")

    sql = """
        WITH lagged AS (
            SELECT
                d.contract_id,
                d.trade_date,
                d.open_interest,
                LAG(d.open_interest)
                    OVER (PARTITION BY d.contract_id ORDER BY d.trade_date)
                    AS prev_oi,
                c.root
            FROM daily_obs d
            JOIN contracts c ON c.contract_id = d.contract_id
            WHERE d.knowledge_date <= ?
              AND c.root IN (?, ?)
        )
        SELECT
            contract_id,
            trade_date,
            root,
            CASE WHEN prev_oi IS NOT NULL
                 THEN open_interest - prev_oi
                 ELSE NULL
            END AS doi
        FROM lagged
        WHERE trade_date >= ?
          AND trade_date <= ?
          AND prev_oi IS NOT NULL
        ORDER BY trade_date, contract_id
    """
    rows = conn.execute(
        sql,
        (
            as_of_date.isoformat(),
            euribor_root, estr_root,
            start_date.isoformat(), end_date.isoformat(),
        ),
    ).fetchall()

    if not rows:
        # No data — return empty DataFrame with correct schema and all flags False
        dates = _business_dates(start_date, end_date)
        return pd.DataFrame({
            "trade_date":          dates,
            "delta_euribor_oi":    0,
            "delta_estr_oi":       0,
            "migration_flag":      False,
            "migration_ratio":     float("nan"),
            "migration_matched_oi": 0,
        }).set_index("trade_date")

    df = pd.DataFrame([dict(r) for r in rows])
    df["trade_date"] = pd.to_datetime(df["trade_date"]).dt.date

    # Aggregate daily ΔOI by root
    euribor_daily = (
        df[df["root"] == euribor_root]
        .groupby("trade_date")["doi"]
        .sum()
        .rename("delta_euribor_oi")
    )
    estr_daily = (
        df[df["root"] == estr_root]
        .groupby("trade_date")["doi"]
        .sum()
        .rename("delta_estr_oi")
    )

    result = pd.DataFrame({"delta_euribor_oi": euribor_daily, "delta_estr_oi": estr_daily})
    result = result.reindex(
        pd.Index(_business_dates(start_date, end_date), name="trade_date")
    ).fillna(0.0)

    # Compute migration flag conditions
    euribor_fall = result["delta_euribor_oi"] < 0
    estr_rise    = result["delta_estr_oi"]    > min_estr_oi

    # Magnitude ratio — only defined when Euribor OI is falling
    denom   = result["delta_euribor_oi"].abs().replace(0, float("nan"))
    ratio   = result["delta_estr_oi"].abs() / denom
    result["migration_ratio"] = np.where(euribor_fall, ratio, float("nan"))

    ratio_ok = (
        result["migration_ratio"].notna()
        & (result["migration_ratio"] >= ratio_lower)
        & (result["migration_ratio"] <= ratio_upper)
    )
    result["migration_flag"] = euribor_fall & estr_rise & ratio_ok

    # Matched lots to suppress
    matched = np.where(
        result["migration_flag"],
        np.minimum(
            result["delta_euribor_oi"].abs(),
            result["delta_estr_oi"].abs(),
        ) * corr_weight,
        0.0,
    )
    result["migration_matched_oi"] = matched

    return result


def _business_dates(start_date: date, end_date: date) -> list[date]:
    """Return list of Mon-Fri dates in [start_date, end_date]."""
    dates = []
    d = start_date
    while d <= end_date:
        if d.weekday() < 5:
            dates.append(d)
        d += timedelta(days=1)
    return dates


def apply_migration_correction(
    outright_df: pd.DataFrame,
    migration_df: pd.DataFrame,
    params: dict,
) -> pd.DataFrame:
    """
    Apply migration correction to the spread-adjusted outright signal.

    On migration days:
      - Scale down |doi_outright| for each Euribor contract proportionally.
      - share_i = |doi_outright_i| / |total Euribor outright OI on that day|
      - corrected doi = doi_outright × (1 - migration_matched_oi × share_i / |doi_outright_i|)
        which simplifies to: doi_outright_i - sign × (migration_matched_oi × share_i)
      - Recompute flow_migration_corrected proportionally.
      - Add columns: migration_flag, doi_migration_corrected, flow_migration_corrected.

    On non-migration days:
      - migration_flag = False, doi_migration_corrected = doi_outright (unchanged).
    """
    df = outright_df.reset_index().copy()

    # Ensure trade_date is date objects
    if pd.api.types.is_datetime64_any_dtype(df["trade_date"]):
        df["trade_date"] = df["trade_date"].dt.date

    mig = migration_df.copy()
    if pd.api.types.is_datetime64_any_dtype(mig.index):
        mig.index = mig.index.map(lambda x: x.date() if hasattr(x, "date") else x)

    # Merge migration flags
    df = df.merge(
        mig[["migration_flag", "migration_matched_oi"]].reset_index(),
        on="trade_date",
        how="left",
    )
    df["migration_flag"] = df["migration_flag"].fillna(False)
    df["migration_matched_oi"] = df["migration_matched_oi"].fillna(0.0)

    # On migration days, compute total Euribor outright per day
    doi_abs = df["doi"].abs().fillna(0.0)
    total_per_day = df.groupby("trade_date")["doi"].transform(
        lambda s: s.abs().sum()
    ).fillna(0.0)

    # share_i: proportional weight per contract on that day
    share_i = np.where(total_per_day > 0, doi_abs / total_per_day, 0.0)

    # Amount to subtract from |doi_outright|
    reduction = df["migration_matched_oi"].values * share_i
    doi_sign  = np.sign(df["doi"].fillna(0.0).values)

    mig_flag = df["migration_flag"].values
    doi_outright_val = df["doi"].fillna(0.0).values

    # corrected doi = doi_outright - sign × reduction (only on migration days)
    doi_corrected = np.where(
        mig_flag,
        doi_outright_val - doi_sign * reduction,
        doi_outright_val,
    )
    df["doi_migration_corrected"] = doi_corrected

    # Recompute flow: flow_migration_corrected = flow_quadrant × (|doi_corrected| / |doi_outright|)
    # But handle zeros carefully
    doi_abs_safe = np.where(doi_abs > 0, doi_abs, 1.0)
    scale = np.where(
        mig_flag & (doi_abs > 0),
        np.abs(doi_corrected) / doi_abs_safe,
        1.0,
    )
    scale = np.clip(scale, 0.0, 1.0)

    df["flow_migration_corrected"] = df["flow_quadrant"].fillna(0.0).values * scale

    # Recompute flow_quadrant and position_quadrant from corrected flow
    # (For final signal assembly, flow_final will use flow_migration_corrected.)

    df = df.set_index(["contract_id", "trade_date"])
    return df


# ---------------------------------------------------------------------------
# §7.1  Option expiry helpers
# ---------------------------------------------------------------------------

def third_friday(year: int, month: int) -> date:
    """Return the 3rd Friday of the given year/month (standard Euribor option expiry)."""
    d = date(year, month, 1)
    # weekday(): Monday=0, Friday=4
    days_to_fri = (4 - d.weekday()) % 7
    first_fri   = d + timedelta(days=days_to_fri)
    return first_fri + timedelta(weeks=2)


def option_expiry_dates(start_year: int, end_year: int) -> list[date]:
    """Return all 3rd Fridays from start_year through end_year (inclusive)."""
    result = []
    for year in range(start_year, end_year + 1):
        for month in range(1, 13):
            result.append(third_friday(year, month))
    return result


# ---------------------------------------------------------------------------
# §7.1  Option delta flag
# ---------------------------------------------------------------------------

def flag_option_delta_days(
    signal_df: pd.DataFrame,
    params: dict,
    ecb_dates: Optional[list[date]] = None,
) -> pd.DataFrame:
    """
    Add option-delta adjustment columns to signal_df.

    Flags `option_delta_flag=True` when BOTH:
    1. trade_date is within params["options"]["ecb_proximity_days"] of an ECB meeting
       OR is an option expiry date (3rd Friday).
    2. The contract's |ΔOI| exceeds params["options"]["large_oi_move_pct"] ×
       trailing 20-day mean |ΔOI| for that contract.

    Returns signal_df with additional columns:
        is_option_expiry_date  bool
        is_ecb_proximity       bool
        option_delta_flag      bool
        w_adjusted_corrected   w_adjusted after option downweighting
        flow_final             flow after all corrections (migration + option)
        dv01_flow_final        flow_final × dv01_per_contract
    """
    op  = params.get("options", {})
    ecb_prox_days  = int(op.get("ecb_proximity_days",  2))
    large_pct      = float(op.get("large_oi_move_pct",  0.02))
    downweight     = float(op.get("option_downweight",   0.3))
    dv01_per       = float(params["dv01"]["eur_per_bp_per_contract"])

    if ecb_dates is None:
        ecb_dates = _ECB_MEETING_DATES

    df = signal_df.reset_index().copy()
    if pd.api.types.is_datetime64_any_dtype(df["trade_date"]):
        df["trade_date"] = df["trade_date"].dt.date

    # Build option expiry set
    if len(df) > 0:
        all_years = sorted({d.year for d in df["trade_date"]})
        expiry_set = set(option_expiry_dates(all_years[0], all_years[-1]))
    else:
        expiry_set = set()

    # Build ECB proximity set: all dates within ±ecb_prox_days of each ECB meeting
    ecb_prox_set: set[date] = set()
    for ecb_d in ecb_dates:
        for delta in range(-ecb_prox_days, ecb_prox_days + 1):
            ecb_prox_set.add(ecb_d + timedelta(days=delta))

    df["is_option_expiry_date"] = df["trade_date"].isin(expiry_set)
    df["is_ecb_proximity"]      = df["trade_date"].isin(ecb_prox_set)

    # Calendar / proximity trigger (condition 1)
    cal_trigger = df["is_option_expiry_date"] | df["is_ecb_proximity"]

    # Trailing 20-day mean |ΔOI| per contract (condition 2)
    doi_abs = df["doi"].abs().fillna(0.0)
    df["_doi_abs"] = doi_abs.values

    trailing_mean_list = []
    for cid, grp in df.groupby("contract_id", sort=False):
        grp_s = grp.sort_values("trade_date").copy()
        trailing = grp_s["_doi_abs"].rolling(window=20, min_periods=1).mean().shift(1)
        trailing_mean_list.append(trailing)
    df["_trailing_mean_doi"] = pd.concat(trailing_mean_list).reindex(df.index)

    # Large OI move: |ΔOI| > large_pct × trailing mean
    # Guard against NaN trailing mean
    trailing_safe = df["_trailing_mean_doi"].fillna(0.0)
    large_oi_move = np.where(
        trailing_safe > 0,
        df["_doi_abs"].values > large_pct * trailing_safe.values,
        False,
    )
    df["option_delta_flag"] = cal_trigger.values & large_oi_move

    # Adjusted weight: multiply by downweight on flagged rows
    w_base = df["w_adjusted"].fillna(0.0).values
    df["w_adjusted_corrected"] = np.where(
        df["option_delta_flag"],
        w_base * downweight,
        w_base,
    )

    # flow_final: start from flow_migration_corrected if present, else flow_quadrant
    if "flow_migration_corrected" in df.columns:
        base_flow = df["flow_migration_corrected"].fillna(0.0).values
    else:
        base_flow = df["flow_quadrant"].fillna(0.0).values

    # Scale flow by w_adjusted_corrected / w_adjusted on flagged rows
    w_ratio = np.where(
        df["option_delta_flag"] & (w_base > 0),
        df["w_adjusted_corrected"].values / np.where(w_base > 0, w_base, 1.0),
        1.0,
    )
    df["flow_final"]      = base_flow * w_ratio
    df["dv01_flow_final"] = df["flow_final"] * dv01_per

    # Drop internal helpers
    df.drop(columns=["_doi_abs", "_trailing_mean_doi"], inplace=True)

    df = df.set_index(["contract_id", "trade_date"])
    return df


# ---------------------------------------------------------------------------
# Stage 9 master pipeline
# ---------------------------------------------------------------------------

def build_corrected_signal(
    conn,
    start_date: date,
    end_date: date,
    as_of_date: date,
    params: dict,
    ecb_dates: Optional[list[date]] = None,
    instrument_roots: list[str] | None = None,
) -> pd.DataFrame:
    """
    Full Stage 9 pipeline:
    1. Call spread_adjusted_quadrant_signal() (Stage 5).
    2. detect_migration_days() and apply_migration_correction().
    3. flag_option_delta_days().
    4. Return combined DataFrame with all correction columns.

    Final flow column: flow_final (definitive signal for Stage 10).
    """
    # Stage 5
    outright_df, _curve_df = spread_adjusted_quadrant_signal(
        conn, start_date, end_date, as_of_date, params, instrument_roots=instrument_roots
    )

    if outright_df.empty:
        return outright_df

    # Stage 9a: migration correction
    migration_df = detect_migration_days(
        conn, start_date, end_date, as_of_date, params
    )
    corrected_df = apply_migration_correction(outright_df, migration_df, params)

    # Stage 9b: option delta adjustment + flow_final
    final_df = flag_option_delta_days(corrected_df, params, ecb_dates=ecb_dates)

    return final_df


# ---------------------------------------------------------------------------
# Simulation helper for testing
# ---------------------------------------------------------------------------

def inject_migration_events(
    conn,
    euribor_contracts: list[dict],
    estr_contracts: list[dict],
    event_dates: list[date],
    migration_lots: int,
    params: dict,
) -> None:
    """
    Inject synthetic migration events into the DB for testing.

    On each event_date:
    - Reduce OI of active Euribor contracts by migration_lots total (split proportionally).
    - Add/update €STR contracts rows with OI = migration_lots (rising €STR OI).
    - volume must be ≥ |ΔOI| to satisfy §4.8 check 1.
    - Revisions to existing Euribor rows are logged to daily_obs_revisions.

    €STR contracts must already be in the contracts table with root = "FEF".
    """
    from ..data.db import next_business_day as _nbd

    euribor_root = params["contracts"].get("euribor_root", "FEI")
    estr_root    = params["contracts"].get("estr_root",    "FEF")

    # Ensure €STR contracts exist in contracts table
    for c in estr_contracts:
        conn.execute(
            """INSERT OR IGNORE INTO contracts
               (contract_id, root, expiry_date, last_trading_day, contract_type, listing_date)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                c["contract_id"], c.get("root", estr_root),
                c["expiry_date"], c["last_trading_day"],
                c.get("contract_type", "quarterly"),
                c.get("listing_date", None),
            ),
        )

    for event_date in event_dates:
        knowledge_date = _nbd(event_date)

        # --- Euribor: find active contracts and get current OI ---
        active_euribor = []
        for c in euribor_contracts:
            row = conn.execute(
                "SELECT open_interest, volume, settlement_price, knowledge_date "
                "FROM daily_obs WHERE contract_id=? AND trade_date=?",
                (c["contract_id"], event_date.isoformat()),
            ).fetchone()
            if row is not None and row["open_interest"] > 0:
                active_euribor.append((c["contract_id"], dict(row)))

        if not active_euribor:
            continue

        total_oi = sum(r["open_interest"] for _, r in active_euribor)
        if total_oi <= 0:
            continue

        # Split migration_lots proportionally across active Euribor contracts
        for cid, row in active_euribor:
            share     = row["open_interest"] / total_oi
            reduction = int(round(migration_lots * share))
            new_oi    = max(0, row["open_interest"] - reduction)
            doi_abs   = abs(new_oi - row["open_interest"])
            new_vol   = max(row["volume"], doi_abs + 100)

            # Log revision
            max_seq = conn.execute(
                "SELECT COALESCE(MAX(revision_seq),0) FROM daily_obs_revisions "
                "WHERE contract_id=? AND trade_date=?",
                (cid, event_date.isoformat()),
            ).fetchone()[0]
            conn.execute(
                """INSERT INTO daily_obs_revisions
                   (contract_id, trade_date, knowledge_date, settlement_price,
                    open_interest, volume, vwap, open_price, revision_seq)
                   SELECT contract_id, trade_date, knowledge_date, settlement_price,
                          open_interest, volume, vwap, open_price, ?
                   FROM daily_obs WHERE contract_id=? AND trade_date=?""",
                (max_seq + 1, cid, event_date.isoformat()),
            )
            conn.execute(
                """UPDATE daily_obs
                   SET open_interest=?, volume=?, revised_at=datetime('now')
                   WHERE contract_id=? AND trade_date=?""",
                (new_oi, new_vol, cid, event_date.isoformat()),
            )

        # --- €STR: insert or update with rising OI ---
        # Use the first €STR contract (nearest expiry)
        estr_sorted = sorted(estr_contracts, key=lambda c: c["expiry_date"])
        for ci, estr_c in enumerate(estr_sorted[:2]):
            cid = estr_c["contract_id"]
            # Get existing €STR OI if any
            existing = conn.execute(
                "SELECT open_interest, volume, settlement_price FROM daily_obs "
                "WHERE contract_id=? AND trade_date=?",
                (cid, event_date.isoformat()),
            ).fetchone()

            # We want €STR OI to rise by migration_lots (or migration_lots/2 per contract)
            per_contract = migration_lots // max(1, len(estr_sorted[:2]))
            if existing is not None:
                prev_oi  = existing["open_interest"]
                new_oi   = prev_oi + per_contract
                doi_abs  = abs(new_oi - prev_oi)
                new_vol  = max(existing["volume"] if existing["volume"] else 0, doi_abs + 100)
                sett     = existing["settlement_price"]
                conn.execute(
                    """UPDATE daily_obs
                       SET open_interest=?, volume=?, revised_at=datetime('now')
                       WHERE contract_id=? AND trade_date=?""",
                    (new_oi, new_vol, cid, event_date.isoformat()),
                )
            else:
                # Need a settlement price — use 97.0 as a placeholder
                sett   = 97.0
                new_oi = per_contract
                new_vol = per_contract + 100

                # Insert a prior-day row with OI=0 so LAG produces a valid ΔOI
                prev_ed = event_date - timedelta(days=1)
                while prev_ed.weekday() >= 5:
                    prev_ed -= timedelta(days=1)
                prev_kd = _nbd(prev_ed)
                # Only insert prior day if it doesn't already exist
                prev_exists = conn.execute(
                    "SELECT 1 FROM daily_obs WHERE contract_id=? AND trade_date=?",
                    (cid, prev_ed.isoformat()),
                ).fetchone()
                if not prev_exists:
                    conn.execute(
                        """INSERT OR IGNORE INTO daily_obs
                           (contract_id, trade_date, knowledge_date, settlement_price,
                            open_interest, volume, vwap, open_price)
                           VALUES (?,?,?,?,?,?,?,?)""",
                        (
                            cid, prev_ed.isoformat(), prev_kd.isoformat(),
                            sett, 0, 100, sett, None,
                        ),
                    )

                conn.execute(
                    """INSERT OR REPLACE INTO daily_obs
                       (contract_id, trade_date, knowledge_date, settlement_price,
                        open_interest, volume, vwap, open_price)
                       VALUES (?,?,?,?,?,?,?,?)""",
                    (
                        cid, event_date.isoformat(), knowledge_date.isoformat(),
                        sett, new_oi, new_vol, sett, None,
                    ),
                )
