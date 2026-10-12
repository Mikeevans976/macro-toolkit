"""
bbg.py — Bloomberg blpapi wrapper.

Provides a `blp` object whose `bdh()` method is a drop-in replacement for
`xbbg.blp.bdh()`, so every call site only needs to change the import:

    # before
    from xbbg import blp
    df = blp.bdh(tickers=..., flds=..., start_date=..., end_date=...)

    # after
    from bbg import blp
    df = blp.bdh(tickers=..., flds=..., start_date=..., end_date=...)

Return format
-------------
pd.DataFrame with DatetimeIndex and MultiIndex columns (ticker, field),
matching xbbg output exactly so no downstream code needs to change.

Session lifecycle
-----------------
A new blpapi Session is opened and closed for every bdh() call.  This keeps
the implementation simple and avoids stale-connection issues across
long-running server processes.  Bloomberg sessions are cheap to open (~10 ms).

Requirements
------------
    pip install blpapi
Bloomberg Terminal (or B-PIPE / SAPI) must be running on localhost:8194.
"""

from __future__ import annotations

import datetime
import warnings
from typing import Sequence

import pandas as pd

try:
    import blpapi as _blpapi
    _AVAILABLE = True
except ImportError:
    _AVAILABLE = False

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_HOST = "localhost"
_PORT = 8194
_REFDATA_SVC = "//blp/refdata"
_EXRSVC_SVC  = "//blp/exrsvc"   # saved-search (BSRCH) service
_TIMEOUT_MS = 10_000   # 10 s per event wait


def _open_session():
    """Start a blpapi Session against the local Terminal, or raise."""
    opts = _blpapi.SessionOptions()
    opts.setServerHost(_HOST)
    opts.setServerPort(_PORT)

    session = _blpapi.Session(opts)
    if not session.start():
        raise RuntimeError(
            f"Failed to start Bloomberg session on {_HOST}:{_PORT}. "
            "Is the Bloomberg Terminal running?"
        )
    return session


# ---------------------------------------------------------------------------
# Core BDH implementation
# ---------------------------------------------------------------------------

def bdh(
    tickers: Sequence[str] | str,
    flds: Sequence[str] | str,
    start_date: str,
    end_date: str,
    periodicity: str = "DAILY",
) -> pd.DataFrame:
    """
    Bloomberg Historical Data request (BDH).

    Parameters
    ----------
    tickers     : Bloomberg ticker strings, e.g. ["USGG10YR Index"].
                  A bare string is treated as a single ticker.
    flds        : Bloomberg field names, e.g. ["PX_LAST"].
                  A bare string is treated as a single field.
    start_date  : "YYYY-MM-DD"
    end_date    : "YYYY-MM-DD"
    periodicity : "DAILY" | "WEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY"
                  (default "DAILY")

    Returns
    -------
    pd.DataFrame
        DatetimeIndex, MultiIndex columns (ticker, field).
        Empty DataFrame on any failure.

    Raises
    ------
    ImportError  : blpapi is not installed.
    RuntimeError : Bloomberg session could not be started / service not opened.
    """
    if not _AVAILABLE:
        raise ImportError(
            "blpapi is not installed.\n"
            "Install the Bloomberg API Python SDK:\n"
            "  pip install blpapi\n"
            "Bloomberg Terminal (or B-PIPE / SAPI) must also be running."
        )

    # A bare string is one value, not a sequence of characters.  xbbg accepts
    # either form and most call sites pass flds="PX_LAST", so normalise here
    # rather than at every call site — list("PX_LAST") would otherwise request
    # the seven single-letter fields P, X, _, L, A, S, T and return nothing.
    tickers = [tickers] if isinstance(tickers, str) else list(tickers)
    flds    = [flds]    if isinstance(flds, str)    else list(flds)

    # ── Open session ────────────────────────────────────────────────────────
    session = _open_session()

    try:
        if not session.openService(_REFDATA_SVC):
            raise RuntimeError(
                f"Failed to open Bloomberg service {_REFDATA_SVC}."
            )

        svc     = session.getService(_REFDATA_SVC)
        request = svc.createRequest("HistoricalDataRequest")

        for t in tickers:
            request.getElement("securities").appendValue(t)
        for f in flds:
            request.getElement("fields").appendValue(f)

        request.set("startDate",             start_date.replace("-", ""))
        request.set("endDate",               end_date.replace("-", ""))
        request.set("periodicitySelection",  periodicity)
        request.set("periodicityAdjustment", "ACTUAL")
        request.set("nonTradingDayFillOption", "ACTIVE_DAYS_ONLY")

        session.sendRequest(request)

        # ── Collect responses ────────────────────────────────────────────────
        # raw[ticker] = {"_dates": [...], field: [...], ...}
        raw: dict[str, dict] = {}

        done = False
        while not done:
            event = session.nextEvent(_TIMEOUT_MS)

            if event.eventType() in (
                _blpapi.Event.RESPONSE,
                _blpapi.Event.PARTIAL_RESPONSE,
            ):
                for msg in event:
                    _process_message(msg, flds, raw)

            if event.eventType() == _blpapi.Event.RESPONSE:
                done = True
            elif event.eventType() == _blpapi.Event.TIMEOUT:
                warnings.warn("bbg.bdh: timed out waiting for Bloomberg response.")
                done = True

    finally:
        session.stop()

    return _build_dataframe(tickers, flds, raw)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _process_message(msg, flds: list[str], raw: dict) -> None:
    """Parse one HistoricalDataResponse message into raw accumulator."""
    if not msg.hasElement("securityData"):
        return

    sec_data = msg.getElement("securityData")

    # Security error check
    if sec_data.hasElement("securityError"):
        err = sec_data.getElement("securityError")
        ticker = sec_data.getElementAsString("security")
        warnings.warn(
            f"bbg.bdh: Bloomberg security error for '{ticker}': "
            f"{err.getElementAsString('message')}"
        )
        return

    ticker          = sec_data.getElementAsString("security")
    field_data_arr  = sec_data.getElement("fieldData")

    if ticker not in raw:
        raw[ticker] = {"_dates": [], **{f: [] for f in flds}}

    for i in range(field_data_arr.numValues()):
        pt = field_data_arr.getValueAsElement(i)

        # Date — blpapi returns a blpapi.Datetime object
        dt = pt.getElementAsDatetime("date")
        raw[ticker]["_dates"].append(datetime.date(dt.year, dt.month, dt.day))

        for f in flds:
            if pt.hasElement(f):
                try:
                    raw[ticker][f].append(pt.getElementAsFloat(f))
                except Exception:
                    raw[ticker][f].append(None)
            else:
                raw[ticker][f].append(None)

        # Per-field error reporting (non-fatal)
        if sec_data.hasElement("fieldExceptions"):
            fex_arr = sec_data.getElement("fieldExceptions")
            for j in range(fex_arr.numValues()):
                fex = fex_arr.getValueAsElement(j)
                bad_field = fex.getElementAsString("fieldId")
                err_info  = fex.getElement("errorInfo")
                warnings.warn(
                    f"bbg.bdh: field error for '{ticker}' field '{bad_field}': "
                    f"{err_info.getElementAsString('message')}"
                )


def _build_dataframe(
    tickers: list[str],
    flds: list[str],
    raw: dict,
) -> pd.DataFrame:
    """Assemble MultiIndex DataFrame from raw accumulator."""
    frames = []
    for ticker in tickers:
        td = raw.get(ticker)
        if not td or not td["_dates"]:
            continue

        idx  = pd.to_datetime(td["_dates"])
        data = {f: td[f] for f in flds}
        df_t = pd.DataFrame(data, index=idx)
        df_t.columns = pd.MultiIndex.from_tuples([(ticker, f) for f in flds])
        frames.append(df_t)

    if not frames:
        return pd.DataFrame()

    result = pd.concat(frames, axis=1).sort_index()
    result.index = pd.to_datetime(result.index)
    return result


# ---------------------------------------------------------------------------
# Core BDP implementation
# ---------------------------------------------------------------------------

def bdp(
    tickers: Sequence[str] | str,
    flds: Sequence[str] | str,
) -> pd.DataFrame:
    """
    Bloomberg Reference Data request (BDP) — one snapshot value per field.

    Parameters
    ----------
    tickers : Bloomberg ticker strings.  A bare string is a single ticker.
    flds    : Bloomberg field names, e.g. ["MATURITY", "AMT_OUTSTANDING"].
              A bare string is a single field.

    Returns
    -------
    pd.DataFrame
        Indexed by ticker, one column per requested field, field names kept
        exactly as passed in.  Numeric fields come back as floats, everything
        else (dates, "Y"/"N" flags, text) as strings — callers coerce dates
        with pd.to_datetime.  Missing values are NaN.
        Empty DataFrame on any failure.

    Raises
    ------
    ImportError  : blpapi is not installed.
    RuntimeError : Bloomberg session could not be started / service not opened.
    """
    if not _AVAILABLE:
        raise ImportError(
            "blpapi is not installed.\n"
            "Install the Bloomberg API Python SDK:\n"
            "  pip install blpapi\n"
            "Bloomberg Terminal (or B-PIPE / SAPI) must also be running."
        )

    tickers = [tickers] if isinstance(tickers, str) else list(tickers)
    flds    = [flds]    if isinstance(flds, str)    else list(flds)

    session = _open_session()

    try:
        if not session.openService(_REFDATA_SVC):
            raise RuntimeError(f"Failed to open Bloomberg service {_REFDATA_SVC}.")

        svc     = session.getService(_REFDATA_SVC)
        request = svc.createRequest("ReferenceDataRequest")

        for t in tickers:
            request.getElement("securities").appendValue(t)
        for f in flds:
            request.getElement("fields").appendValue(f)

        session.sendRequest(request)

        rows: dict[str, dict] = {}

        done = False
        while not done:
            event = session.nextEvent(_TIMEOUT_MS)

            if event.eventType() in (
                _blpapi.Event.RESPONSE,
                _blpapi.Event.PARTIAL_RESPONSE,
            ):
                for msg in event:
                    _process_ref_message(msg, flds, rows)

            if event.eventType() == _blpapi.Event.RESPONSE:
                done = True
            elif event.eventType() == _blpapi.Event.TIMEOUT:
                warnings.warn("bbg.bdp: timed out waiting for Bloomberg response.")
                done = True

    finally:
        session.stop()

    if not rows:
        return pd.DataFrame()

    # Preserve the requested ticker order for the securities that came back.
    index = [t for t in tickers if t in rows]
    return pd.DataFrame(
        [{f: rows[t].get(f) for f in flds} for t in index],
        index=index,
        columns=flds,
    )


def _process_ref_message(msg, flds: list[str], rows: dict) -> None:
    """Parse one ReferenceDataResponse message into the rows accumulator."""
    if not msg.hasElement("securityData"):
        return

    sec_data_arr = msg.getElement("securityData")

    for i in range(sec_data_arr.numValues()):
        sec_data = sec_data_arr.getValueAsElement(i)
        ticker   = sec_data.getElementAsString("security")

        if sec_data.hasElement("securityError"):
            err = sec_data.getElement("securityError")
            warnings.warn(
                f"bbg.bdp: Bloomberg security error for '{ticker}': "
                f"{err.getElementAsString('message')}"
            )
            continue

        field_data  = sec_data.getElement("fieldData")
        rows[ticker] = {}

        for f in flds:
            if not field_data.hasElement(f):
                rows[ticker][f] = None
                continue
            # Numbers as floats; dates, flags and text fall through to string.
            try:
                rows[ticker][f] = field_data.getElementAsFloat(f)
            except Exception:
                try:
                    rows[ticker][f] = field_data.getElementAsString(f)
                except Exception:
                    rows[ticker][f] = None

        if sec_data.hasElement("fieldExceptions"):
            fex_arr = sec_data.getElement("fieldExceptions")
            for j in range(fex_arr.numValues()):
                fex = fex_arr.getValueAsElement(j)
                warnings.warn(
                    f"bbg.bdp: field error for '{ticker}' field "
                    f"'{fex.getElementAsString('fieldId')}': "
                    f"{fex.getElement('errorInfo').getElementAsString('message')}"
                )


# ---------------------------------------------------------------------------
# Core BSRCH implementation
# ---------------------------------------------------------------------------

def bsrch(domain: str) -> list[str]:
    """
    Bloomberg SRCH / fixed-income search (BSRCH) — run a saved screen and
    return the securities it matches.

    Parameters
    ----------
    domain : saved-search domain string, e.g. "FI:my_govt_screen".

    Returns
    -------
    list[str]
        Bloomberg ticker strings, in the order the screen returned them.
        Empty list on any failure.

    Raises
    ------
    ImportError  : blpapi is not installed.
    RuntimeError : Bloomberg session could not be started / service not opened.
    """
    if not _AVAILABLE:
        raise ImportError(
            "blpapi is not installed.\n"
            "Install the Bloomberg API Python SDK:\n"
            "  pip install blpapi\n"
            "Bloomberg Terminal (or B-PIPE / SAPI) must also be running."
        )

    session = _open_session()

    try:
        if not session.openService(_EXRSVC_SVC):
            raise RuntimeError(f"Failed to open Bloomberg service {_EXRSVC_SVC}.")

        svc     = session.getService(_EXRSVC_SVC)
        request = svc.createRequest("ExcelGetGridRequest")
        request.set("Domain", domain)

        session.sendRequest(request)

        tickers: list[str] = []

        done = False
        while not done:
            event = session.nextEvent(_TIMEOUT_MS)

            if event.eventType() in (
                _blpapi.Event.RESPONSE,
                _blpapi.Event.PARTIAL_RESPONSE,
            ):
                for msg in event:
                    if msg.hasElement("responseError"):
                        err = msg.getElement("responseError")
                        warnings.warn(
                            f"bbg.bsrch: Bloomberg error for domain '{domain}': "
                            f"{err.getElementAsString('message')}"
                        )
                        continue
                    # GridResponse reports a bad domain in its own Error field
                    # rather than as a responseError — an unsaved screen name
                    # would otherwise come back as a silent empty result.
                    if msg.hasElement("Error"):
                        detail = msg.getElementAsString("Error")
                        if detail:
                            warnings.warn(
                                f"bbg.bsrch: Bloomberg rejected domain "
                                f"'{domain}': {detail}"
                            )
                            continue
                    _collect_grid_tickers(msg, tickers)

            if event.eventType() == _blpapi.Event.RESPONSE:
                done = True
            elif event.eventType() == _blpapi.Event.TIMEOUT:
                warnings.warn("bbg.bsrch: timed out waiting for Bloomberg response.")
                done = True

    finally:
        session.stop()

    return tickers


def _collect_grid_tickers(msg, tickers: list[str]) -> None:
    """Pull the first cell of every DataRecord — the security identifier."""
    if not msg.hasElement("DataRecords"):
        return

    records = msg.getElement("DataRecords")
    for i in range(records.numValues()):
        record = records.getValueAsElement(i)
        if not record.hasElement("DataFields"):
            continue
        fields = record.getElement("DataFields")
        if fields.numValues() == 0:
            continue
        cell = fields.getValueAsElement(0)
        if cell.hasElement("StringValue"):
            tickers.append(cell.getElementAsString("StringValue"))


# ---------------------------------------------------------------------------
# `blp` namespace object — matches `from xbbg import blp` usage pattern
# ---------------------------------------------------------------------------

class _Blp:
    """Namespace so `from bbg import blp; blp.bdh(...)` works identically
    to `from xbbg import blp; blp.bdh(...)`."""
    bdh   = staticmethod(bdh)
    bdp   = staticmethod(bdp)
    bsrch = staticmethod(bsrch)


blp = _Blp()
