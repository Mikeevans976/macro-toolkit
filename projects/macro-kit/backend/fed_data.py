"""
Federal Reserve public data for the US Quant Macro models.

  GDPNow (Federal Reserve Bank of Atlanta)   every nowcast since 2014, from the model's own
                                             workbook (archive + the current quarter's tracking)

The workbook is re-downloaded at most once a day; offline, the last copy is used.
"""
from __future__ import annotations

import logging
from pathlib import Path

import pandas as pd

from fiscal_data import _fresh, http_get

logger = logging.getLogger(__name__)

GDPNOW_URL = ("https://www.atlantafed.org/-/media/Project/Atlanta/FRBA/Documents/research-and-data/data/gdpnow/"
              "GDPTrackingModelDataAndForecasts.xlsx")
GDPNOW_PAGE = "https://www.atlantafed.org/cqer/research/gdpnow"
KEEP_YEARS = 3


def _download(url: str, path: Path, max_age_days: float = 0.5) -> Path | None:
    if _fresh(path, max_age_days):
        return path
    try:
        body = http_get(url, timeout=180)
        if body[:2] != b"PK":
            raise ValueError("not a workbook")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        return path
    except Exception as exc:
        logger.warning("Fed data: %s download failed (%s)", url, exc)
        return path if path.exists() else None


def parse_gdpnow(path: Path, today: pd.Timestamp | None = None) -> list[dict]:
    """GDPNow's nowcasts (% q/q saar) by publication day and quarter, the last few years."""
    import openpyxl

    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        arch = list(wb["TrackingArchives"].iter_rows(values_only=True))
        track = list(wb["TrackingHistory"].iter_rows(values_only=True))
    finally:
        wb.close()
    head = [str(x or "") for x in arch[0]]
    col = next(i for i, h in enumerate(head) if h.strip() == "GDP Nowcast")
    rows = {}
    for r in arch[1:]:
        if r and hasattr(r[0], "year") and hasattr(r[1], "year") and isinstance(r[col], (int, float)):
            rows[(pd.Timestamp(r[0]).normalize(), pd.Period(r[1], "Q"))] = float(r[col])
    # the quarter being tracked now (dates across the first row, the GDP row by label)
    title = next((str(r[0]) for r in track[:4] if r and r[0] and "Evolution of GDP nowcast" in str(r[0])), "")
    q_now = title.rsplit(" ", 1)[-1].upper() if title else None
    gdp_row = next((r for r in track if r and str(r[0]).strip() == "GDP"), None)
    if q_now and gdp_row is not None:
        q = pd.Period(q_now, "Q")
        for d, v in zip(track[0][2:], gdp_row[2:]):
            if hasattr(d, "year") and isinstance(v, (int, float)):
                rows[(pd.Timestamp(d).normalize(), q)] = float(v)
    first = (today or pd.Timestamp.today()) - pd.DateOffset(years=KEEP_YEARS)
    return [{"published": d.strftime("%Y-%m-%d"), "source": "GDPNow", "quarter": str(q), "value": round(v, 3),
             "url": GDPNOW_PAGE, "note": None}
            for (d, q), v in sorted(rows.items()) if d >= first]


def gdpnow(folder: Path) -> dict | None:
    path = _download(GDPNOW_URL, folder / "GDPTrackingModelDataAndForecasts.xlsx")
    if path is None:
        return None
    try:
        return {"institution": "Federal Reserve Bank of Atlanta", "label": "GDPNow", "estimates": parse_gdpnow(path)}
    except Exception:
        logger.warning("Fed data: GDPNow workbook unreadable", exc_info=True)
        return None
