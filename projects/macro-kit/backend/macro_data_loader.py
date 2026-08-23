"""
Macro data loader for the Euro Area Heatmap DFM.

Series metadata (ordering, lag, factor assignment) is read from
series_catalogue_ea.json — no CSV files required.

Primary interface
-----------------
    from data_fetcher import get_fetcher
    fetcher = get_fetcher("bloomberg")   # or "haver"
    data = fetcher.fetch(series_ids, start=..., end=...)

    macro_data = load_macro_data(daily_dates, m_macro, data=data)

The `data` argument is a dict[series_id, pd.Series]:
  - PeriodIndex  → release date estimated as period_end + typical_lag_days
  - DatetimeIndex → used directly as release dates (forward-compatible for
                    when actual release calendars become available)

If data=None or no usable observations are found, MacroData.has_data is
False and the heatmap falls back to synthetic simulation.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

_CATALOGUE_PATH = Path(__file__).parent / "data" / "series_catalogue_ea.json"


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
# Catalogue loader — replaces macro_series.csv
# ---------------------------------------------------------------------------

def _load_dfm_meta(m_macro: int, catalogue_path: Path | None = None) -> list[dict]:
    """
    Read DFM series metadata from series_catalogue_ea.json (or a custom catalogue).

    Parameters
    ----------
    m_macro        : expected number of DFM series (must match dfm_col_index range)
    catalogue_path : path to the JSON catalogue file. Defaults to the EA catalogue
                     (series_catalogue_ea.json) when None.

    Returns a list of length m_macro, sorted by dfm_col_index, each entry:
      id, name, factor (dfm_factor), sign (dfm_sign), frequency, typical_lag_days
    """
    path = catalogue_path or _CATALOGUE_PATH
    if not path.exists():
        raise FileNotFoundError(
            f"series catalogue not found at {path}"
        )

    with open(path, encoding="utf-8") as f:
        catalogue = json.load(f)

    dfm_entries = [
        e for e in catalogue.get("series", [])
        if e.get("dfm_col_index") is not None
    ]

    if not dfm_entries:
        raise ValueError(
            f"No entries with 'dfm_col_index' found in {path.name}. "
            "Add dfm_col_index to the DFM input series."
        )

    dfm_entries.sort(key=lambda e: e["dfm_col_index"])

    col_indices = [e["dfm_col_index"] for e in dfm_entries]
    if col_indices != list(range(m_macro)):
        raise ValueError(
            f"dfm_col_index values {col_indices} in {path.name} must be "
            f"exactly 0..{m_macro - 1}."
        )

    required_fields = {"id", "name", "dfm_factor", "dfm_sign", "frequency", "typical_lag_days"}
    for e in dfm_entries:
        missing = required_fields - set(e.keys())
        if missing:
            raise ValueError(
                f"Catalogue entry '{e.get('id')}' is missing DFM fields: {missing}"
            )

    return dfm_entries


# ---------------------------------------------------------------------------
# Period parsing helpers
# ---------------------------------------------------------------------------

def _to_period(val, freq: str) -> pd.Period | None:
    if isinstance(val, pd.Period):
        return val.asfreq(freq)
    try:
        return pd.Period(val, freq=freq)
    except Exception:
        pass
    try:
        ts = pd.Timestamp(val)
        return pd.Period(ts, freq=freq)
    except Exception:
        return None


def _period_end_date(period: pd.Period) -> pd.Timestamp:
    return period.end_time.normalize()


def _snap_to_grid(date: pd.Timestamp, daily_arr: np.ndarray) -> int | None:
    """Return index of first business day >= date. None if after grid end."""
    d = np.datetime64(date.date(), "D")
    idx = int(np.searchsorted(daily_arr, d, side="left"))
    return None if idx >= len(daily_arr) else idx


# ---------------------------------------------------------------------------
# Core builder: (series_id, period_or_ts, value) → Y_daily
# ---------------------------------------------------------------------------

def _build_Y_daily(
    records: list[tuple],
    col_map: dict[str, int],
    lag_map: dict[str, int],
    daily_dates: pd.DatetimeIndex,
    m_macro: int,
    warn_log: list[str],
) -> np.ndarray:
    T = len(daily_dates)
    daily_arr = np.array(daily_dates, dtype="datetime64[D]")
    Y_daily = np.full((T, m_macro), np.nan)
    placed: dict[tuple[int, int], str] = {}

    for series_id, period_or_ts, value in records:
        col = col_map[series_id]

        if isinstance(period_or_ts, pd.Timestamp):
            release_date = period_or_ts
            period_key   = str(period_or_ts.date())
        else:
            lag = lag_map[series_id]
            release_date = _period_end_date(period_or_ts) + pd.Timedelta(days=lag)
            period_key   = str(period_or_ts)

        snap_idx = _snap_to_grid(release_date, daily_arr)
        if snap_idx is None:
            warn_log.append(
                f"  {series_id} {period_key}: estimated release "
                f"{release_date.date()} is after grid end — skipped."
            )
            continue

        key = (col, snap_idx)
        if key in placed:
            if period_key > placed[key]:
                placed[key] = period_key
                Y_daily[snap_idx, col] = value
        else:
            placed[key] = period_key
            Y_daily[snap_idx, col] = value

    return Y_daily


# ---------------------------------------------------------------------------
# Record builder from dict[series_id, pd.Series]
# ---------------------------------------------------------------------------

def _records_from_dict(
    data: dict[str, pd.Series],
    col_map: dict[str, int],
    freq_map: dict[str, str],
    warn_log: list[str],
) -> list[tuple]:
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
            for ts, value in series.items():
                if pd.isna(value):
                    continue
                records.append((series_id, pd.Timestamp(ts), float(value)))
        else:
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


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def load_macro_data(
    daily_dates: pd.DatetimeIndex,
    m_macro: int,
    data: dict[str, pd.Series] | None = None,
    catalogue_path: Path | None = None,
) -> MacroData:
    """
    Build the daily observation matrix Y_daily from macro release data.

    Parameters
    ----------
    daily_dates    : business-day date index for the full sample
    m_macro        : expected number of series (must match dfm_col_index range in catalogue)
    data           : dict[series_id, pd.Series] from data_fetcher.fetch().
                     If None or empty, returns MacroData with has_data=False.
    catalogue_path : path to the JSON catalogue file. Defaults to the EA catalogue
                     (series_catalogue_ea.json) when None.

    Returns
    -------
    MacroData with Y_daily[T, M] — NaN except on (estimated) release dates.
    """
    warn_log: list[str] = []

    meta = _load_dfm_meta(m_macro, catalogue_path=catalogue_path)

    series_ids   = [e["id"]          for e in meta]
    series_names = [e["name"]        for e in meta]
    factor_asgn  = [e["dfm_factor"]  for e in meta]
    prim_signs   = [int(e["dfm_sign"]) for e in meta]
    col_map      = {e["id"]: e["dfm_col_index"]    for e in meta}
    lag_map      = {e["id"]: int(e["typical_lag_days"] or 0) for e in meta}
    freq_map     = {e["id"]: e["frequency"]        for e in meta}

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

    if not data:
        return _empty("No data provided to load_macro_data; heatmap will use simulation.")

    records = _records_from_dict(data, col_map, freq_map, warn_log)

    if not records:
        return _empty("No usable observations found in provided data; using simulation.")

    Y_daily = _build_Y_daily(records, col_map, lag_map, daily_dates, m_macro, warn_log)

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
