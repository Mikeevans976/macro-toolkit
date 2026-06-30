"""
Time series data fetcher for the analytics hub.

Resolves series IDs from series_catalogue.json to vendor tickers and fetches
historical data from Bloomberg (via blpapi) or Haver Analytics.

Output format
-------------
Always returns dict[series_id, pd.Series]:

  - Daily series (rates, swaps, equities, etc.)
    → pd.Series with DatetimeIndex

  - Macro series (monthly / quarterly)
    → pd.Series with PeriodIndex ('M' or 'Q')
    Resampled from raw daily Bloomberg/Haver data to the native frequency,
    taking the last observation per period.
    This format is consumed directly by load_macro_data() in macro_data_loader.py,
    which then estimates release dates from the typical_lag_days in macro_series.csv.

Derived series (source="derived", no vendor ticker) are silently skipped.
Unresolvable tickers raise a warning and are excluded from the output.

Usage
-----
    from data_fetcher import get_fetcher

    # Bloomberg (requires Bloomberg Terminal + blpapi installed)
    fetcher = get_fetcher("bloomberg")

    # Haver (requires Haver DLX installed; path to database directory)
    fetcher = get_fetcher("haver", path="/path/to/haver/databases")
    # or set environment variable HAVER_PATH instead of passing path=

    data = fetcher.fetch(
        series_ids=["ea_composite_pmi", "eur_swap_2y", "ea_core_hicp_yoy"],
        start="2020-01-01",
        end="2025-12-31",
    )

Dependencies
------------
Bloomberg : pip install blpapi         (requires Bloomberg Desktop API running)
Haver     : pip install Haver          (requires Haver DLX; typically Windows)

Both are optional — an ImportError with a clear message is raised if not installed.
"""

from __future__ import annotations

import json
import os
import warnings
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Literal

import pandas as pd

_CATALOGUE_PATH = Path(__file__).parent / "data" / "series_catalogue.json"

# ---------------------------------------------------------------------------
# Catalogue resolver
# ---------------------------------------------------------------------------

class _CatalogueResolver:
    """
    Loads a series catalogue JSON once and answers ticker lookups.

    Attributes exposed per series_id:
      - ticker_bloomberg : str | None
      - ticker_haver     : str | None
      - frequency        : "daily" | "monthly" | "quarterly"
      - source           : "bloomberg" | "haver" | "ecb" | "derived" | ...

    Parameters
    ----------
    path : path to the JSON catalogue file. Defaults to the EA catalogue
           (series_catalogue.json) when None.
    """

    def __init__(self, path: Path | None = None) -> None:
        catalogue_path = path or _CATALOGUE_PATH
        if not catalogue_path.exists():
            raise FileNotFoundError(
                f"series catalogue not found at {catalogue_path}. "
                "Run the catalogue build step first."
            )
        with open(catalogue_path, encoding="utf-8") as f:
            raw = json.load(f)

        # The catalogue has a _meta key at the top level; skip it.
        self._entries: dict[str, dict] = {}
        for entry in raw.get("series", []):
            sid = entry.get("id")
            if sid and sid != "_meta":
                self._entries[sid] = entry

    def resolve(
        self,
        series_ids: list[str],
        source: Literal["bloomberg", "haver"],
    ) -> tuple[dict[str, str], dict[str, str], list[str]]:
        """
        Map series_ids to vendor tickers.

        Returns
        -------
        ticker_map  : dict[series_id, ticker_string]   — series that have a ticker
        freq_map    : dict[series_id, frequency_str]   — "daily"/"monthly"/"quarterly"
        skipped     : list[str]                        — series without a ticker (derived/unavailable)
        """
        ticker_key = "ticker_bloomberg" if source == "bloomberg" else "ticker_haver"

        ticker_map: dict[str, str] = {}
        freq_map:   dict[str, str] = {}
        skipped:    list[str]      = []

        for sid in series_ids:
            entry = self._entries.get(sid)
            if entry is None:
                warnings.warn(f"data_fetcher: '{sid}' not found in catalogue — skipped.")
                skipped.append(sid)
                continue

            ticker = entry.get(ticker_key)
            if not ticker:
                # Derived series or not available on this source — skip silently.
                skipped.append(sid)
                continue

            ticker_map[sid] = ticker
            freq_map[sid]   = entry.get("frequency", "daily")

        return ticker_map, freq_map, skipped


_resolver = _CatalogueResolver()


# ---------------------------------------------------------------------------
# Abstract base
# ---------------------------------------------------------------------------

class DataFetcher(ABC):
    """
    Base class for vendor-specific fetchers.

    Subclasses implement _fetch_raw() which returns a raw DataFrame
    (DatetimeIndex, one column per series_id).  The base class then
    resamples macro series to their native PeriodIndex.

    Parameters
    ----------
    catalogue_path : path to the JSON catalogue file used for ticker resolution.
                     Defaults to the EA catalogue (series_catalogue.json) when None.
    """

    def __init__(self, catalogue_path: Path | None = None) -> None:
        self._resolver = _CatalogueResolver(catalogue_path) if catalogue_path else _resolver

    def fetch(
        self,
        series_ids: list[str],
        start: str,
        end: str,
    ) -> dict[str, pd.Series]:
        """
        Fetch time series for the given series_ids.

        Parameters
        ----------
        series_ids : list of IDs from series_catalogue.json
        start      : "YYYY-MM-DD"  (inclusive)
        end        : "YYYY-MM-DD"  (inclusive)

        Returns
        -------
        dict mapping series_id → pd.Series
          - daily series  : DatetimeIndex
          - macro series  : PeriodIndex ('M' or 'Q')
        Derived series and those without tickers for this source are omitted.
        """
        ticker_map, freq_map, skipped = self._resolver.resolve(series_ids, self._source)

        if not ticker_map:
            return {}

        raw = self._fetch_raw(ticker_map, start, end)   # DatetimeIndex DataFrame

        result: dict[str, pd.Series] = {}
        for sid, series in raw.items():
            series = series.dropna()
            if series.empty:
                warnings.warn(f"data_fetcher: '{sid}' returned no data for {start}–{end}.")
                continue

            freq = freq_map.get(sid, "daily")
            if freq == "monthly":
                series = (
                    series
                    .resample("ME")          # month-end
                    .last()
                    .dropna()
                    .rename_axis(None)
                )
                series.index = series.index.to_period("M")
            elif freq == "quarterly":
                series = (
                    series
                    .resample("QE")          # quarter-end
                    .last()
                    .dropna()
                    .rename_axis(None)
                )
                series.index = series.index.to_period("Q")
            # else: daily — keep DatetimeIndex as-is

            result[sid] = series

        return result

    @property
    @abstractmethod
    def _source(self) -> Literal["bloomberg", "haver"]:
        ...

    @abstractmethod
    def _fetch_raw(
        self,
        ticker_map: dict[str, str],
        start: str,
        end: str,
    ) -> dict[str, pd.Series]:
        """
        Download raw daily data for the given tickers.

        Parameters
        ----------
        ticker_map : dict[series_id, vendor_ticker]
        start, end : "YYYY-MM-DD"

        Returns
        -------
        dict[series_id, pd.Series] with DatetimeIndex
        """
        ...


# ---------------------------------------------------------------------------
# Bloomberg fetcher  (requires: pip install blpapi)
# ---------------------------------------------------------------------------

class BloombergFetcher(DataFetcher):
    """
    Fetches data from Bloomberg via the blpapi SDK.

    Requirements
    ------------
    - Bloomberg Terminal must be running and logged in.
    - pip install blpapi

    The standard price/level field used is PX_LAST.
    Pass fld="FIELD_NAME" to override (e.g. fld="LAST_PRICE").
    """

    def __init__(self, fld: str = "PX_LAST", catalogue_path: Path | None = None) -> None:
        super().__init__(catalogue_path)
        self._fld = fld
        try:
            from bbg import blp as _blp   # noqa: F401 — validate at construction
            self._blp = _blp
        except ImportError as e:
            raise ImportError(
                "blpapi is required for Bloomberg data. Install with: pip install blpapi\n"
                "Bloomberg Terminal must also be running."
            ) from e

    @property
    def _source(self) -> Literal["bloomberg"]:
        return "bloomberg"

    def _fetch_raw(
        self,
        ticker_map: dict[str, str],
        start: str,
        end: str,
    ) -> dict[str, pd.Series]:
        tickers    = list(ticker_map.values())
        id_by_tick = {v: k for k, v in ticker_map.items()}  # reverse map

        df = self._blp.bdh(
            tickers=tickers,
            flds=[self._fld],
            start_date=start,
            end_date=end,
        )
        # blpapi returns a DataFrame with MultiIndex columns: (ticker, field)
        # or single-level columns if only one field.
        if df.empty:
            return {}

        result: dict[str, pd.Series] = {}
        for ticker in tickers:
            sid = id_by_tick[ticker]
            try:
                if isinstance(df.columns, pd.MultiIndex):
                    s = df[(ticker, self._fld)]
                else:
                    s = df[ticker]
                result[sid] = s.rename(sid)
            except KeyError:
                warnings.warn(f"data_fetcher: Bloomberg returned no data for '{ticker}' ({sid}).")

        return result


# ---------------------------------------------------------------------------
# Haver fetcher  (requires: pip install Haver)
# ---------------------------------------------------------------------------

class HaverFetcher(DataFetcher):
    """
    Fetches data from Haver Analytics via the Haver Python package.

    Requirements
    ------------
    - pip install Haver
    - Haver DLX must be installed and databases accessible.
      On Windows this is typically C:/Haver/Data/ or similar.
      On macOS/Linux, mount the Haver share or use Haver's remote access.

    Parameters
    ----------
    path : path to the Haver databases directory.
           Alternatively set the HAVER_PATH environment variable.

    Ticker format in series_catalogue.json
    ----------------------------------------
    Haver mnemonics are stored as "SERIES@DATABASE"  (e.g. "CPIEZXFE@EUDATA").
    The fetcher splits on "@" to get the series code and database name.
    """

    def __init__(self, path: str | None = None, catalogue_path: Path | None = None) -> None:
        super().__init__(catalogue_path)
        try:
            import Haver as _haver
            self._haver = _haver
        except ImportError as e:
            raise ImportError(
                "The Haver package is required for Haver data. Install with: pip install Haver\n"
                "Haver DLX must also be installed and the database path must be accessible."
            ) from e

        db_path = path or os.environ.get("HAVER_PATH")
        if db_path:
            self._haver.path(db_path)
        else:
            warnings.warn(
                "data_fetcher: No Haver path provided and HAVER_PATH env var is not set. "
                "Proceeding — Haver will use its default path if configured."
            )

    @property
    def _source(self) -> Literal["haver"]:
        return "haver"

    def _fetch_raw(
        self,
        ticker_map: dict[str, str],
        start: str,
        end: str,
    ) -> dict[str, pd.Series]:
        start_ts = pd.Timestamp(start)
        end_ts   = pd.Timestamp(end)

        result: dict[str, pd.Series] = {}
        for sid, mnemonic in ticker_map.items():
            # Mnemonic format: "SERIES@DATABASE"
            if "@" not in mnemonic:
                warnings.warn(
                    f"data_fetcher: Haver mnemonic '{mnemonic}' for '{sid}' is not in "
                    "'SERIES@DATABASE' format — skipped."
                )
                continue

            series_code, db_name = mnemonic.split("@", 1)
            try:
                s = self._haver.data(series_code, db_name)
                if not isinstance(s, pd.Series):
                    # Older Haver package versions return a DataFrame
                    s = s.squeeze()
                s = s.loc[start_ts:end_ts]
                s.index = pd.to_datetime(s.index)
                result[sid] = s.rename(sid)
            except Exception as exc:
                warnings.warn(
                    f"data_fetcher: Failed to fetch Haver series '{mnemonic}' ({sid}): {exc}"
                )

        return result


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------

def get_fetcher(
    source: Literal["bloomberg", "haver"],
    **kwargs,
) -> DataFetcher:
    """
    Return a DataFetcher for the requested source.

    Parameters
    ----------
    source : "bloomberg" or "haver"
    **kwargs :
        bloomberg : fld="PX_LAST"  (optional, override Bloomberg field)
        haver     : path="/path/to/haver/databases"  (optional if HAVER_PATH is set)

    Examples
    --------
        fetcher = get_fetcher("bloomberg")
        fetcher = get_fetcher("haver", path="/mnt/haver")

        data = fetcher.fetch(
            series_ids=["ea_composite_pmi", "eur_swap_2y"],
            start="2020-01-01",
            end="2025-12-31",
        )
    """
    catalogue_path: Path | None = kwargs.get("catalogue_path")
    if source == "bloomberg":
        return BloombergFetcher(fld=kwargs.get("fld", "PX_LAST"), catalogue_path=catalogue_path)
    elif source == "haver":
        return HaverFetcher(path=kwargs.get("path"), catalogue_path=catalogue_path)
    else:
        raise ValueError(f"Unknown source '{source}'. Choose 'bloomberg' or 'haver'.")
