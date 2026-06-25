"""
Macro data loader for the Euro Area Heatmap DFM.

Reads two CSV files from backend/data/:
  macro_series.csv   — series metadata (id, name, factor, frequency, col_index, ...)
  macro_releases.csv — actual releases  (series_id, reference_period, release_date, value, vintage)

Release date semantics
----------------------
Each row in macro_releases.csv represents one data point:
  - The observation is placed in Y_daily at its RELEASE DATE, not the reference period end.
  - This correctly handles publication lags and mixed frequencies:
      * Monthly PMI flash   : released ~3 weeks after month-end
      * Monthly HICP        : released ~30 days after month-end
      * Quarterly wages     : released ~6-8 weeks after quarter-end
  - Between releases, Y_daily stays NaN. The Kalman filter propagates on the
    transition equation alone — no imputation needed here.

Vintage handling
----------------
Only vintage=1 (first release) is used — real-time data principle. Revisions
are stored in the CSV for record-keeping but ignored by the loader.
If no vintage column is present, row order determines priority (first occurrence
of each series_id + reference_period wins).

Column ordering contract
------------------------
macro_series.csv has a col_index column (0..M_MACRO-1) that must be contiguous
and match the MACRO_INDICATOR_NAMES order in euro_area_heatmap.py. The loader
validates this at load time and raises ValueError if they diverge.
"""

from __future__ import annotations

import warnings as _warnings
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

_DATA_DIR = Path(__file__).parent / "data"
_SERIES_CSV   = _DATA_DIR / "macro_series.csv"
_RELEASES_CSV = _DATA_DIR / "macro_releases.csv"

MIN_OBS_PER_SERIES = 3   # series with fewer observations fall back to simulation


@dataclass
class MacroData:
    Y_daily: np.ndarray           # [T_DAILY, M_MACRO] — NaN except on release dates
    series_ids: list[str]         # length M_MACRO, in col_index order
    series_names: list[str]
    factor_assignments: list[str] # factor name per series (Growth/Inflation/...)
    primary_series_signs: list[int]  # +1 or -1 per series
    has_data: bool                # False when CSVs missing or all-empty
    n_obs_per_series: dict[str, int] # series_id → count of non-NaN rows
    warnings: list[str] = field(default_factory=list)


def load_macro_data(
    daily_dates: pd.DatetimeIndex,
    m_macro: int,
) -> MacroData:
    """
    Load macro release data and build the daily observation matrix Y_daily.

    Parameters
    ----------
    daily_dates : business-day date index for the full sample (from euro_area_heatmap.py)
    m_macro     : expected number of series (must match col_index range in macro_series.csv)

    Returns
    -------
    MacroData with Y_daily[T, M] — NaN except on actual release dates.
    """
    warn_log: list[str] = []
    empty_result = MacroData(
        Y_daily=np.full((len(daily_dates), m_macro), np.nan),
        series_ids=[],
        series_names=[],
        factor_assignments=[],
        primary_series_signs=[],
        has_data=False,
        n_obs_per_series={},
        warnings=warn_log,
    )

    # ── 1. Load series metadata ───────────────────────────────────────────────
    if not _SERIES_CSV.exists():
        warn_log.append(f"macro_series.csv not found at {_SERIES_CSV}; using simulation.")
        return empty_result

    meta = pd.read_csv(_SERIES_CSV, comment="#")
    required_meta_cols = {"series_id", "col_index", "name", "factor",
                          "primary_series_sign"}
    missing = required_meta_cols - set(meta.columns)
    if missing:
        raise ValueError(f"macro_series.csv is missing columns: {missing}")

    meta = meta.sort_values("col_index").reset_index(drop=True)
    col_indices = meta["col_index"].tolist()
    if col_indices != list(range(m_macro)):
        raise ValueError(
            f"macro_series.csv col_index values {col_indices} must be "
            f"exactly 0..{m_macro - 1}. Update the CSV or M_MACRO constant."
        )

    series_ids   = meta["series_id"].tolist()
    series_names = meta["name"].tolist()
    factor_asgn  = meta["factor"].tolist()
    prim_signs   = meta["primary_series_sign"].astype(int).tolist()
    col_map      = dict(zip(series_ids, col_indices))   # series_id → column index

    # ── 2. Load release data ──────────────────────────────────────────────────
    if not _RELEASES_CSV.exists():
        warn_log.append(f"macro_releases.csv not found at {_RELEASES_CSV}; using simulation.")
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

    releases = pd.read_csv(
        _RELEASES_CSV,
        comment="#",
        parse_dates=["release_date"],
    )

    if releases.empty:
        warn_log.append("macro_releases.csv has no data rows; using simulation.")
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

    required_rel_cols = {"series_id", "release_date", "value"}
    missing = required_rel_cols - set(releases.columns)
    if missing:
        raise ValueError(f"macro_releases.csv is missing columns: {missing}")

    # ── 3. Keep first vintage only ────────────────────────────────────────────
    if "vintage" in releases.columns:
        releases = (
            releases
            .sort_values(["series_id", "reference_period", "vintage"])
            .drop_duplicates(subset=["series_id", "reference_period"], keep="first")
        )
    else:
        releases = releases.drop_duplicates(
            subset=["series_id", "reference_period"], keep="first"
        )

    # ── 4. Filter: unknown series_id ─────────────────────────────────────────
    known_mask = releases["series_id"].isin(col_map)
    unknown_ids = releases.loc[~known_mask, "series_id"].unique().tolist()
    if unknown_ids:
        warn_log.append(
            f"Skipping unknown series_ids in macro_releases.csv: {unknown_ids}"
        )
    releases = releases[known_mask].copy()

    # ── 5. Filter: release dates outside the daily grid window ───────────────
    t_start, t_end = daily_dates[0], daily_dates[-1]
    in_window = (releases["release_date"] >= t_start) & (releases["release_date"] <= t_end)
    n_dropped = (~in_window).sum()
    if n_dropped:
        warn_log.append(
            f"Dropped {n_dropped} release(s) outside daily grid "
            f"[{t_start.date()} – {t_end.date()}]."
        )
    releases = releases[in_window].copy()

    if releases.empty:
        warn_log.append("No releases remain after filtering; using simulation.")
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

    # ── 6. Snap release dates to business-day grid ───────────────────────────
    # np.searchsorted with side='left' returns the index of the first date
    # >= release_date, which is the correct next-business-day snap.
    daily_arr = np.array(daily_dates, dtype="datetime64[D]")
    rel_dates  = releases["release_date"].values.astype("datetime64[D]")
    snap_idx   = np.searchsorted(daily_arr, rel_dates, side="left")
    snap_idx   = np.clip(snap_idx, 0, len(daily_dates) - 1)
    releases   = releases.copy()
    releases["snap_idx"] = snap_idx

    # ── 7. Handle same-day collisions for the same series ────────────────────
    # If two entries for the same series land on the same snapped business day,
    # keep the one with the later reference_period (more recent data wins).
    releases = (
        releases
        .sort_values(["series_id", "snap_idx", "reference_period"])
        .drop_duplicates(subset=["series_id", "snap_idx"], keep="last")
    )

    # ── 8. Build Y_daily ─────────────────────────────────────────────────────
    T = len(daily_dates)
    Y_daily = np.full((T, m_macro), np.nan)

    for _, row in releases.iterrows():
        col = col_map[row["series_id"]]
        idx = int(row["snap_idx"])
        Y_daily[idx, col] = float(row["value"])

    # ── 9. Count observations per series ─────────────────────────────────────
    n_obs = {
        sid: int(np.sum(~np.isnan(Y_daily[:, col_map[sid]])))
        for sid in series_ids
    }

    # Warn on series with no observations
    empty_series = [sid for sid, cnt in n_obs.items() if cnt == 0]
    if empty_series:
        warn_log.append(
            f"No observations for series: {empty_series}. "
            "These columns stay NaN; Kalman will propagate on transition alone."
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
