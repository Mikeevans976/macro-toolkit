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
A Bloomberg Terminal (Desktop API, localhost:8194 by default) or a B-PIPE /
Server API endpoint configured with the environment variables below.

Connection settings (environment, e.g. backend/.env)
----------------------------------------------------
    BBG_HOST, BBG_PORT          server (default localhost:8194)
    BBG_APP_NAME                B-PIPE application name; enables application
                                authentication for the session identity
    BBG_TLS_CLIENT_CREDENTIALS  path to the PKCS#12 client credentials (B-PIPE TLS)
    BBG_TLS_CLIENT_PASSWORD     password for the client credentials
    BBG_TLS_TRUST_MATERIAL      path to the PKCS#7 trust material
All B-PIPE settings come from your Bloomberg administrator.

Besides bdh(): bdp() (reference data), bds() (bulk data) and open_session()
for subscriptions (pod/bloomberg_news.py).
"""

from __future__ import annotations

import datetime
import os
import warnings
from typing import Any, Sequence

import pandas as pd

try:
    import blpapi as _blpapi
    _AVAILABLE = True
except ImportError:
    _AVAILABLE = False


class BloombergUnavailable(ImportError):
    """blpapi is not installed. Subclasses ImportError so existing
    ``except ImportError`` fallbacks (to simulated data) keep working; the API
    maps it to 503 instead of an opaque 500."""

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_HOST = os.environ.get("BBG_HOST", "localhost")
_PORT = int(os.environ.get("BBG_PORT", "8194"))
_REFDATA_SVC = "//blp/refdata"
_TIMEOUT_MS = 10_000   # 10 s per event wait


# ---------------------------------------------------------------------------
# Core BDH implementation
# ---------------------------------------------------------------------------

def bdh(
    tickers: Sequence[str],
    flds: Sequence[str],
    start_date: str,
    end_date: str,
    periodicity: str = "DAILY",
) -> pd.DataFrame:
    """
    Bloomberg Historical Data request (BDH).

    Parameters
    ----------
    tickers     : Bloomberg ticker strings, e.g. ["USGG10YR Index"]
    flds        : Bloomberg field names, e.g. ["PX_LAST"]
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
        raise BloombergUnavailable(
            "blpapi is not installed.\n"
            "Install the Bloomberg API Python SDK:\n"
            "  pip install blpapi\n"
            "Bloomberg Terminal (or B-PIPE / SAPI) must also be running."
        )

    tickers = list(tickers)
    flds    = list(flds)

    session = open_session()
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
# `blp` namespace object — matches `from xbbg import blp` usage pattern
# ---------------------------------------------------------------------------

class _Blp:
    """Namespace so `from bbg import blp; blp.bdh(...)` works identically
    to `from xbbg import blp; blp.bdh(...)`."""
    bdh = staticmethod(bdh)


blp = _Blp()


# ---------------------------------------------------------------------------
# Sessions (Desktop API or B-PIPE)
# ---------------------------------------------------------------------------

def _require_blpapi() -> None:
    if not _AVAILABLE:
        raise BloombergUnavailable(
            "blpapi is not installed. Install it with `pip install blpapi` and configure "
            "BBG_HOST / BBG_PORT (and the B-PIPE settings) in backend/.env."
        )


def session_options() -> "Any":
    """SessionOptions for the configured endpoint, with B-PIPE auth and TLS when set."""
    _require_blpapi()
    opts = _blpapi.SessionOptions()
    opts.setServerHost(_HOST)
    opts.setServerPort(_PORT)
    app = os.environ.get("BBG_APP_NAME")
    if app:
        opts.setSessionIdentityOptions(_blpapi.AuthOptions.createWithApp(app))
    cred = os.environ.get("BBG_TLS_CLIENT_CREDENTIALS")
    if cred:
        opts.setTlsOptions(_blpapi.TlsOptions.createFromFiles(
            cred, os.environ.get("BBG_TLS_CLIENT_PASSWORD", ""),
            os.environ["BBG_TLS_TRUST_MATERIAL"]))
    return opts


def open_session(event_handler=None) -> "Any":
    """Start a session. With event_handler, the session runs asynchronously (subscriptions)."""
    _require_blpapi()
    session = (_blpapi.Session(session_options(), event_handler) if event_handler
               else _blpapi.Session(session_options()))
    if not session.start():
        raise RuntimeError(f"Failed to start Bloomberg session on {_HOST}:{_PORT}. "
                           "Check the Terminal or B-PIPE connection settings.")
    return session


# ---------------------------------------------------------------------------
# Reference data: BDP / BDS
# ---------------------------------------------------------------------------

def element_to_python(el) -> Any:
    """Convert a blpapi Element to plain Python (dict / list / scalar)."""
    if el.isArray():
        return [element_to_python(el.getValueAsElement(i)) if el.datatype() in (_blpapi.DataType.SEQUENCE,
                                                                                _blpapi.DataType.CHOICE)
                else el.getValue(i) for i in range(el.numValues())]
    if el.datatype() in (_blpapi.DataType.SEQUENCE, _blpapi.DataType.CHOICE):
        return {str(sub.name()): element_to_python(sub) for sub in el.elements()}
    if el.isNull():
        return None
    value = el.getValue()
    if isinstance(value, (datetime.date, datetime.datetime, datetime.time)):
        return value.isoformat()
    return value


def _reference_request(tickers: Sequence[str], flds: Sequence[str],
                       overrides: dict[str, Any] | None) -> list[dict]:
    """Send a ReferenceDataRequest; return one {security, fieldData, errors} dict per security."""
    session = open_session()
    try:
        if not session.openService(_REFDATA_SVC):
            raise RuntimeError(f"Failed to open Bloomberg service {_REFDATA_SVC}.")
        request = session.getService(_REFDATA_SVC).createRequest("ReferenceDataRequest")
        for t in tickers:
            request.getElement("securities").appendValue(t)
        for f in flds:
            request.getElement("fields").appendValue(f)
        for k, v in (overrides or {}).items():
            ov = request.getElement("overrides").appendElement()
            ov.setElement("fieldId", k)
            ov.setElement("value", str(v))
        session.sendRequest(request)

        out: list[dict] = []
        while True:
            event = session.nextEvent(_TIMEOUT_MS)
            if event.eventType() in (_blpapi.Event.RESPONSE, _blpapi.Event.PARTIAL_RESPONSE):
                for msg in event:
                    if not msg.hasElement("securityData"):
                        continue
                    arr = msg.getElement("securityData")
                    for i in range(arr.numValues()):
                        sd = element_to_python(arr.getValueAsElement(i))
                        out.append(sd)
            if event.eventType() == _blpapi.Event.RESPONSE:
                return out
            if event.eventType() == _blpapi.Event.TIMEOUT:
                warnings.warn("bbg: timed out waiting for a reference data response.")
                return out
    finally:
        session.stop()


def bdp(tickers: Sequence[str], flds: Sequence[str],
        overrides: dict[str, Any] | None = None) -> dict[str, dict[str, Any]]:
    """Reference data: {ticker: {field: value}}. Missing fields are absent; errors under '_errors'."""
    result: dict[str, dict[str, Any]] = {}
    for sd in _reference_request(list(tickers), list(flds), overrides):
        row = dict(sd.get("fieldData") or {})
        errors = [e for e in [sd.get("securityError")] if e] + list(sd.get("fieldExceptions") or [])
        if errors:
            row["_errors"] = errors
        result[sd.get("security")] = row
    return result


def bds(ticker: str, fld: str, overrides: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Bulk data: the rows of one bulk field for one security."""
    rows = bdp([ticker], [fld], overrides).get(ticker, {}).get(fld)
    return rows if isinstance(rows, list) else []



_Blp.bdp = staticmethod(bdp)   # type: ignore[attr-defined]
_Blp.bds = staticmethod(bds)   # type: ignore[attr-defined]
