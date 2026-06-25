"""
Macro data loader for the Euro Area Heatmap DFM.

Primary interface
-----------------
Call load_macro_data() with a dict of pandas Series:

    data = {
        "ea_composite_pmi":       pd.Series({pd.Period("2024-01", "M"): 47.9, ...}),
        "ea_core_hicp_yoy":       pd.Series({pd.Period("2024-01", "M"): 3.3,  ...}),
        "ea_negotiated_wages_yoy": pd.Series({pd.Period("2024-Q1", "Q"): 4.69, ...}),
        ...
    }
    macro_data = load_macro_data(daily_dates, m_macro=8, data=data)

Period index can be pd.PeriodIndex, pd.DatetimeIndex (snapped to period),
or string-valued (e.g. "2024-01", "2024-Q1") — all are normalised internally.

File-based fallback
-------------------
If data=None, the loader reads backend/data/macro_releases.csv which has the
same information in tabular form (series_id, reference_period, value).

Release date estimation
-----------------------
Since actual release dates are not available, the estimated release date is:

    estimated_release = period_end_date + typical_lag_days

where typical_lag_days is read from backend/data/macro_series.csv and
encodes the typical publication lag for each series.

This is then snapped to the next business day on the daily grid.

Later, if actual release dates become available, pass the data as a
dict[str, pd.Series] with a DatetimeIndex instead of a PeriodIndex —
the loader detects this and uses the index dates directly.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

_DATA_DIR     = Path(__file__).parent / "data"
_SERIES_CSV   = _DATA_DIR / "macro_series.csv"
_RELEASES_CSV = _DATA_DIR / "macro_releases.csv"


@dataclass
class MacroData:
    Y_daily: np.ndarray              # [T_DAILY, M_MACRO] — NaN except on (estimated) release dates
    series_ids: list[str]            # length M_MACRO, in col_index order
    series_names: list[str]
    factor_assignments: list[str]    # factor name per series
    primary_series_signs: list[int]  # +1 or -1 per series
    has_data: bool                   # False when no usable data found
    n_obs_per_series: dict[str, int] # series_id → count of non-NaN rows in Y_daily
    warnings: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Period parsing helpers
# ---------------------------------------------------------------------------

def _to_period(val, freq: str) -> pd.Period | None:
    """
    Normalise a single period value to pd.Period.
    freq: 'M' for monthly, 'Q' for quarterly.
    Accepts: pd.Period, datetime-like, or strings such as
    '2024-01', '2024-Q1', 'Q1 2024', 'January 2024', '2024-01-01'.
    Returns None on failure.
    """
    if isinstance(val, pd.Period):
        return val.asfreq(freq)
    try:
        return pd.Period(val, freq=freq)
    except Exception:
        pass
    # Try parsing as a date then converting
    try:
        ts = pd.Timestamp(val)
        return pd.Period(ts, freq=freq)
    except Exception:
        return None


def _period_end_date(period: pd.Period) -> pd.Timestamp:
    """Last calendar day of a period as a normalised Timestamp."""
    return period.end_time.normalize()


def _estimate_release_date(period: pd.Period, lag_days: int) -> pd.Timestamp:
    """period_end + lag_days calendar days."""
    return _period_end_date(period) + pd.Timedelta(days=lag_days)


def _snap_to_grid(date: pd.Timestamp, daily_arr: np.ndarray) -> int | None:
    """
    Return the index of the first business day >= date in daily_arr.
    Returns None if date is after the end of the grid.
    """
    d = np.datetime64(date.date(), "D")
    idx = int(np.searchsorted(daily_arr, d, side="left"))
    if idx >= len(daily_arr):
        return None
    return idx


# ---------------------------------------------------------------------------
# Series metadata loader
# ---------------------------------------------------------------------------

def _load_series_meta(m_macro: int) -> pd.DataFrame:
    """
    Load and validate macro_series.csv.
    Returns a DataFrame sorted by col_index with all required columns present.
    """
    if not _SERIES_CSV.exists():
        raise FileNotFoundError(f"macro_series.csv not found at {_SERIES_CSV}")

    meta = pd.read_csv(_SERIES_CSV, comment="#")
    required = {"series_id", "col_index", "name", "factor",
                "primary_series_sign", "frequency", "typical_lag_days"}
    missing = required - set(meta.columns)
    if missing:
        raise ValueError(f"macro_series.csv is missing columns: {missing}")

    meta = meta.sort_values("col_index").reset_index(drop=True)
    col_indices = meta["col_index"].tolist()
    if col_indices != list(range(m_macro)):
        raise ValueError(
            f"macro_series.csv col_index values {col_indices} must be "
            f"exactly 0..{m_macro - 1}."
        )
    return meta


# ---------------------------------------------------------------------------
# Core builder: (series_id, period, value) → Y_daily
# ---------------------------------------------------------------------------

def _build_Y_daily(
    records: list[tuple[str, pd.Period | pd.Timestamp, float]],
    # list of (series_id, period_or_release_date, value)
    # If the second element is a pd.Period, release date is estimated via lag.
    # If it is a pd.Timestamp, it is used directly as the release date.
    col_map: dict[str, int],
    lag_map: dict[str, int],
    freq_map: dict[str, str],
    daily_dates: pd.DatetimeIndex,
    m_macro: int,
    warn_log: list[str],
) -> np.ndarray:
    T = len(daily_dates)
    daily_arr = np.array(daily_dates, dtype="datetime64[D]")
    Y_daily = np.full((T, m_macro), np.nan)

    # Track (col, snap_idx) → reference period for collision resolution
    placed: dict[tuple[int, int], str] = {}

    for series_id, period_or_ts, value in records:
        col = col_map[series_id]

        # Determine release date
        if isinstance(period_or_ts, pd.Timestamp):
            release_date = period_or_ts
            period_key = str(period_or_ts.date())
        else:
            release_date = _estimate_release_date(period_or_ts, lag_map[series_id])
            period_key = str(period_or_ts)

        snap_idx = _snap_to_grid(release_date, daily_arr)
        if snap_idx is None:
            warn_log.append(
                f"  {series_id} period {period_key}: estimated release "
                f"{release_date.date()} is after grid end — skipped."
            )
            continue

        key = (col, snap_idx)
        if key in placed:
            # Two observations mapped to the same business day for this series.
            # Keep the later reference period (more recent data).
            if period_key > placed[key]:
                placed[key] = period_key
                Y_daily[snap_idx, col] = value
        else:
            placed[key] = period_key
            Y_daily[snap_idx, col] = value

    return Y_daily


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def load_macro_data(
    daily_dates: pd.DatetimeIndex,
    m_macro: int,
    data: dict[str, pd.Series] | None = None,
) -> MacroData:
    """
    Build the daily observation matrix Y_daily from macro release data.

    Parameters
    ----------
    daily_dates : business-day date index for the full sample
    m_macro     : expected number of series (must match col_index range in macro_series.csv)
    data        : optional dict mapping series_id → pd.Series.
                  Index can be:
                    - pd.PeriodIndex  (monthly or quarterly periods)
                    - pd.DatetimeIndex (treated as actual release dates directly)
                    - object index of period strings (e.g. "2024-01", "2024-Q1")
                  If None, data is read from macro_releases.csv.

    Returns
    -------
    MacroData with Y_daily[T, M] — NaN except on (estimated) release dates.
    """
    warn_log: list[str] = []

    # ── Load series metadata ──────────────────────────────────────────────────
    try:
        meta = _load_series_meta(m_macro)
    except (FileNotFoundError, ValueError) as e:
        raise RuntimeError(f"Cannot load macro series metadata: {e}") from e

    series_ids   = meta["series_id"].tolist()
    series_names = meta["name"].tolist()
    factor_asgn  = meta["factor"].tolist()
    prim_signs   = meta["primary_series_sign"].astype(int).tolist()
    col_map      = dict(zip(meta["series_id"], meta["col_index"].astype(int)))
    lag_map      = dict(zip(meta["series_id"], meta["typical_lag_days"].astype(int)))
    freq_map     = dict(zip(meta["series_id"], meta["frequency"]))  # "monthly"/"quarterly"

    def _empty(reason: str) -> MacroData:
        warn_log.append(reason)
        return MacroData(
            Y_daily=np.full((len(daily_dates), m_macro), np.nan),
            series_ids=series_ids,
            series_names=series_names,
            factor_assignments=factor_asgn,
            primary_series_signs=prim_signs,
            has_data=False,
            n_obs_per_series={sid: 0 for sid in series_ids},
            warnings=warn_log,
        )

    t_start, t_end = daily_dates[0], daily_dates[-1]

    # ── Resolve data source ───────────────────────────────────────────────────
    if data is not None:
        records = _records_from_dict(data, col_map, freq_map, t_start, t_end, warn_log)
    else:
        if not _RELEASES_CSV.exists():
            return _empty(f"macro_releases.csv not found at {_RELEASES_CSV}; using simulation.")
        releases = pd.read_csv(_RELEASES_CSV, comment="#")
        if releases.empty or "series_id" not in releases.columns:
            return _empty("macro_releases.csv has no data rows; using simulation.")
        records = _records_from_csv(releases, col_map, freq_map, t_start, t_end, warn_log)

    if not records:
        return _empty("No usable observations found; using simulation.")

    # ── Build Y_daily ─────────────────────────────────────────────────────────
    Y_daily = _build_Y_daily(
        records, col_map, lag_map, freq_map, daily_dates, m_macro, warn_log
    )

    n_obs = {
        sid: int(np.sum(~np.isnan(Y_daily[:, col_map[sid]])))
        for sid in series_ids
    }
    empty_series = [sid for sid, cnt in n_obs.items() if cnt == 0]
    if empty_series:
        warn_log.append(
            f"No observations placed for: {empty_series}. "
            "These columns stay NaN; Kalman propagates on transition alone."
        )

    has_data = any(cnt > 0 for cnt in n_obs.values())

    return MacroData(
        Y_daily=Y_daily,
        series_ids=series_ids,
        series_names=series_names,
        factor_assignments=factor_asgn,
        primary_series_signs=prim_signs,
        has_data=has_data,
        n_obs_per_series=n_obs,
        warnings=warn_log,
    )


# ---------------------------------------------------------------------------
# Record builders for each source
# ---------------------------------------------------------------------------

def _records_from_dict(
    data: dict[str, pd.Series],
    col_map: dict[str, int],
    freq_map: dict[str, str],
    t_start: pd.Timestamp,
    t_end: pd.Timestamp,
    warn_log: list[str],
) -> list[tuple]:
    """
    Convert a dict[series_id, pd.Series] to a flat list of
    (series_id, period_or_timestamp, value) tuples.

    If the Series has a DatetimeIndex → values used directly as release dates.
    If the Series has a PeriodIndex or object index → treated as reference periods;
    release dates estimated via typical_lag_days.
    """
    records = []
    unknown = [sid for sid in data if sid not in col_map]
    if unknown:
        warn_log.append(f"Skipping unknown series_ids: {unknown}")

    for series_id, series in data.items():
        if series_id not in col_map:
            continue
        freq_str = freq_map[series_id]
        pd_freq  = "M" if freq_str == "monthly" else "Q"

        if isinstance(series.index, pd.DatetimeIndex):
            # Actual release dates provided
            for ts, value in series.items():
                if pd.isna(value):
                    continue
                ts = pd.Timestamp(ts)
                if ts < t_start or ts > t_end:
                    continue
                records.append((series_id, ts, float(value)))

        else:
            # Period index (or string index) — estimate release dates via lag
            for idx_val, value in series.items():
                if pd.isna(value):
                    continue
                period = _to_period(idx_val, pd_freq)
                if period is None:
                    warn_log.append(
                        f"  {series_id}: cannot parse period '{idx_val}' — skipped."
                    )
                    continue
                records.append((series_id, period, float(value)))

    return records


def _records_from_csv(
    releases: pd.DataFrame,
    col_map: dict[str, int],
    freq_map: dict[str, str],
    t_start: pd.Timestamp,
    t_end: pd.Timestamp,
    warn_log: list[str],
) -> list[tuple]:
    """Convert macro_releases.csv rows to (series_id, period, value) tuples."""
    required = {"series_id", "reference_period", "value"}
    missing  = required - set(releases.columns)
    if missing:
        raise ValueError(f"macro_releases.csv is missing columns: {missing}")

    unknown = set(releases["series_id"].unique()) - set(col_map)
    if unknown:
        warn_log.append(f"Skipping unknown series_ids in CSV: {sorted(unknown)}")

    records = []
    for _, row in releases.iterrows():
        series_id = row["series_id"]
        if series_id not in col_map:
            continue
        if pd.isna(row["value"]):
            continue

        freq_str = freq_map[series_id]
        pd_freq  = "M" if freq_str == "monthly" else "Q"
        period   = _to_period(row["reference_period"], pd_freq)
        if period is None:
            warn_log.append(
                f"  {series_id}: cannot parse period '{row['reference_period']}' — skipped."
            )
            continue
        records.append((series_id, period, float(row["value"])))

    return records
