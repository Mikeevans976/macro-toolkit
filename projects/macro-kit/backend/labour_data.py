"""
UK labour-market data for the Labour Market Nowcast (labour_nowcast.py).

Public sources, downloaded by the backend and re-checked at most once a day
(offline, the last copy is used):

  ONS Labour Market Statistics (lms.csv)   LFS employment, unemployment, activity, vacancies, real AWE
  ONS PAYE RTI (rtisa*.xlsx)               HMRC payrolled employees
  Bank of England Agents' scores           employment intentions, recruitment difficulties
  Decision Maker Panel (monthly data)      realised and expected employment growth

Survey series the Bank also uses but that are only on Bloomberg (S&P Global PMI,
KPMG/REC Report on Jobs, Lloyds Business Barometer) come from the catalogue's
Bloomberg tickers when the data source is Bloomberg, and are listed as missing otherwise.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

from fiscal_data import _fresh, http_get

logger = logging.getLogger(__name__)

DATA_DIR = Path(__file__).parent / "data"
ONS = "https://www.ons.gov.uk"
LMS_URL = ONS + "/file?uri=/employmentandlabourmarket/peopleinwork/employmentandemployeetypes/datasets/labourmarketstatistics/current/lms.csv"
RTI_PAGE = ONS + "/employmentandlabourmarket/peopleinwork/earningsandworkinghours/datasets/realtimeinformationstatisticsreferencetableseasonallyadjusted"
AGENTS_URL = "https://www.bankofengland.co.uk/-/media/boe/files/agents-summary/agentsscores.xlsx"
AGENTS_HISTORIC_URL = "https://www.bankofengland.co.uk/-/media/boe/files/agents-summary/historic-agents-scores.xlsx"
DMP_URL = "https://www.bankofengland.co.uk/-/media/boe/files/decision-maker-panel-survey/{year}/monthly-dmp-data-{month}-{year}.xlsx"

# LMS CDIDs: key → CDID (all seasonally adjusted, three-month averages for the LFS)
LMS_SERIES = {
    "lfs_employment": "MGRZ",      # employment 16+, 000s
    "lfs_unemployment_rate": "MGSX",
    "lfs_active": "MGSF",          # economically active 16+, 000s
    "vacancies": "AP2Y",           # 000s, three months to
    "real_awe": "A3WX",            # whole-economy real AWE, £ a week
}
_MONTHS = {m: i for i, m in enumerate(["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"], 1)}
_MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september",
                "october", "november", "december"]


@dataclass
class SourceInfo:
    name: str
    file: str | None = None
    latest: str | None = None            # latest month with data
    release: str | None = None
    next_release: str | None = None
    error: str | None = None


@dataclass
class LabourData:
    monthly: pd.DataFrame                    # PeriodIndex[M] × series id, raw units
    sources: dict[str, SourceInfo] = field(default_factory=dict)
    missing: dict[str, str] = field(default_factory=dict)        # series id → why it is missing


def _download(url: str, path: Path, max_age_days: float = 0.5, check=lambda b: True) -> Path | None:
    if _fresh(path, max_age_days):
        return path
    try:
        body = http_get(url)
        if not check(body):
            raise ValueError("unexpected content")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        return path
    except Exception as exc:
        logger.warning("Labour data: %s download failed (%s)", url, exc)
        return path if path.exists() else None


_is_xlsx = lambda b: b[:2] == b"PK"          # noqa: E731


# ---------------------------------------------------------------------------
# ONS
# ---------------------------------------------------------------------------

def read_lms(path: Path) -> tuple[pd.DataFrame, SourceInfo]:
    raw = pd.read_csv(path, header=None, dtype=str, encoding="latin-1", keep_default_na=False, low_memory=False)
    cdids = raw.iloc[1].tolist()
    meta = {str(raw.iloc[i, 0]).strip().lower(): raw.iloc[i, 1] for i in range(min(8, len(raw)))}
    labels = raw.iloc[:, 0].astype(str).str.strip()
    rows = labels[labels.str.fullmatch(r"\d{4} [A-Z]{3}")].index
    idx = pd.PeriodIndex([pd.Period(year=int(labels[i][:4]), month=_MONTHS[labels[i][5:8]], freq="M") for i in rows])
    out = {}
    for key, cdid in LMS_SERIES.items():
        if cdid in cdids:
            out[key] = pd.to_numeric(raw.iloc[rows, cdids.index(cdid)].replace("", np.nan), errors="coerce").to_numpy()
    df = pd.DataFrame(out, index=idx).sort_index()
    rel = pd.to_datetime(meta.get("release date"), format="%d-%m-%Y", errors="coerce")
    info = SourceInfo("ONS Labour Market Statistics", path.name,
                      str(df["lfs_employment"].dropna().index[-1]) if "lfs_employment" in df else None,
                      None if pd.isna(rel) else rel.strftime("%Y-%m-%d"), meta.get("next release") or None)
    return df, info


def read_rti(path: Path) -> pd.Series:
    import openpyxl

    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        sheet = next(s for s in wb.sheetnames if s.startswith("1.") or "ayrolled employees (UK)" in s)
        rows = list(wb[sheet].iter_rows(values_only=True))
    finally:
        wb.close()
    out = {}
    for r in rows:
        if r and isinstance(r[0], str) and isinstance(r[1], (int, float)):
            try:
                out[pd.Period(pd.Timestamp("1 " + r[0].strip()), "M")] = float(r[1])
            except ValueError:
                continue
    return pd.Series(out, dtype=float).sort_index()


def download_rti(folder: Path) -> Path | None:
    stamp = folder / "rti_checked"
    files = sorted(folder.glob("rtisa*.xlsx"))
    if files and _fresh(stamp, 0.5):
        return files[-1]
    try:
        html = http_get(RTI_PAGE).decode("utf-8", "replace")
        uri = next(u for u in re.findall(r'/file\?uri=([^"\']+rtisa[^"\']*\.xlsx)', html))
        target = folder / uri.rsplit("/", 1)[-1]
        if not target.exists():
            body = http_get(f"{ONS}/file?uri={uri}")
            if not _is_xlsx(body):
                raise ValueError("not a workbook")
            folder.mkdir(parents=True, exist_ok=True)
            target.write_bytes(body)
        stamp.write_text(pd.Timestamp.now().isoformat(), encoding="utf-8")
        return target
    except Exception as exc:
        logger.warning("Labour data: PAYE RTI download failed (%s)", exc)
        return files[-1] if files else None


# ---------------------------------------------------------------------------
# Bank of England Agents and Decision Maker Panel
# ---------------------------------------------------------------------------

def read_agents(path: Path) -> pd.DataFrame:
    """Agents' scores: employment intentions and recruitment difficulties (monthly)."""
    import openpyxl

    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        rows = list(wb["Agents' scores"].iter_rows(values_only=True))
    finally:
        wb.close()
    head = next(i for i, r in enumerate(rows[:12]) if any(isinstance(x, str) and "Employment Intentions" in x for x in r))
    names = [str(x or "") for x in rows[head]]
    cols = {"agents_employment": next(i for i, n in enumerate(names) if "Employment Intentions" in n),
            "agents_recruitment": next(i for i, n in enumerate(names) if "Recruitment Difficulties" in n)}
    data = {}
    for r in rows[head + 1:]:
        if r and hasattr(r[0], "year"):
            data[pd.Period(r[0], "M")] = [r[c] if isinstance(r[c], (int, float)) else np.nan for c in cols.values()]
    return pd.DataFrame.from_dict(data, orient="index", columns=list(cols)).sort_index()


def read_agents_historic(path: Path) -> pd.Series:
    """Discontinued aggregate employment-intentions score (1997-2022), spliced before the new one."""
    import openpyxl

    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        rows = list(wb["Discontinued Agents' scores"].iter_rows(values_only=True))
    finally:
        wb.close()
    head = next(i for i, r in enumerate(rows[:12]) if any(isinstance(x, str) and "Employment Intentions" in x and "old" in x for x in r))
    col = next(i for i, x in enumerate(rows[head]) if isinstance(x, str) and "Employment Intentions" in x and "old" in x)
    data = {pd.Period(r[0], "M"): float(r[col]) for r in rows[head + 1:]
            if r and hasattr(r[0], "year") and isinstance(r[col], (int, float))}
    return pd.Series(data, dtype=float).sort_index()


def read_dmp(path: Path) -> pd.DataFrame:
    """DMP monthly data: mean realised and expected employment growth, three-month averages."""
    import openpyxl

    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        rows = list(wb["Employment growth"].iter_rows(values_only=True))
    finally:
        wb.close()
    head = next(i for i, r in enumerate(rows[:10]) if r and r[0] and "Survey date" in str(r[0]))
    titles = [str(x or "") for x in rows[0]]
    exp_col = next(i for i, t in enumerate(titles) if "Expected employment growth" in t)
    data = {}
    for r in rows[head + 1:]:
        if not r or not r[0]:
            continue
        try:
            p = pd.Period(pd.to_datetime(str(r[0]), format="%b-%y"), "M")
        except ValueError:
            continue
        f = lambda x: float(x) if isinstance(x, (int, float)) else np.nan   # noqa: E731
        data[p] = [f(r[2]), f(r[exp_col + 1])]           # three-month averages
    return pd.DataFrame.from_dict(data, orient="index", columns=["dmp_realised", "dmp_expected"]).sort_index()


def download_dmp(folder: Path, today: pd.Timestamp | None = None) -> Path | None:
    """The latest monthly DMP workbook (the file name carries the survey month)."""
    stamp = folder / "dmp_checked"
    files = sorted(folder.glob("monthly-dmp-data-*.xlsx"), key=lambda f: f.stat().st_mtime)
    if files and _fresh(stamp, 0.5):
        return files[-1]
    now = today or pd.Timestamp.today()
    for k in range(0, 4):
        d = now - pd.DateOffset(months=k)
        name = f"monthly-dmp-data-{_MONTH_NAMES[d.month - 1]}-{d.year}.xlsx"
        target = folder / name
        if target.exists():
            break
        try:
            body = http_get(DMP_URL.format(year=d.year, month=_MONTH_NAMES[d.month - 1]))
        except Exception:
            continue
        if _is_xlsx(body):
            folder.mkdir(parents=True, exist_ok=True)
            target.write_bytes(body)
            break
    else:
        logger.warning("Labour data: no DMP workbook found for the last four months")
        return files[-1] if files else None
    stamp.write_text(pd.Timestamp.now().isoformat(), encoding="utf-8")
    return target


# ---------------------------------------------------------------------------
# Catalogue and assembly
# ---------------------------------------------------------------------------

def catalogue(name: str = "series_catalogue_labour_uk.json") -> dict:
    return json.loads((DATA_DIR / name).read_text(encoding="utf-8"))


def staff_judgements(name: str = "boe_labour_staff_uk.json") -> dict:
    return json.loads((DATA_DIR / name).read_text(encoding="utf-8"))


def _bloomberg(series: list[dict], start: str) -> tuple[pd.DataFrame, dict[str, str]]:
    want = [s for s in series if s.get("ticker_bloomberg")]
    missing = {s["id"]: "Bloomberg ticker not set" for s in series if not s.get("ticker_bloomberg")}
    if not want:
        return pd.DataFrame(), missing
    try:
        import bbg

        df = bbg.bdh([s["ticker_bloomberg"] for s in want], "PX_LAST", pd.Timestamp(start), pd.Timestamp.today())
        out = {}
        for s in want:
            col = df[s["ticker_bloomberg"]] if s["ticker_bloomberg"] in df else None
            if col is None or col.dropna().empty:
                missing[s["id"]] = "no data from Bloomberg"
                continue
            m = col.dropna()
            m.index = pd.PeriodIndex(pd.to_datetime(m.index), freq="M")
            out[s["id"]] = m.groupby(level=0).last()
        return pd.DataFrame(out), missing
    except Exception as exc:
        for s in want:
            missing[s["id"]] = f"Bloomberg unavailable ({type(exc).__name__})"
        return pd.DataFrame(), missing


def load(root: Path, data_source: str) -> LabourData:
    cat = catalogue()
    sources: dict[str, SourceInfo] = {}
    frames = []
    lms = _download(LMS_URL, root / "lms.csv", check=lambda b: b[:7] == b'"Title"')
    if lms is None:
        raise RuntimeError("ONS Labour Market Statistics unavailable (offline and never downloaded)")
    df, sources["lms"] = read_lms(lms)
    frames.append(df)
    rti = download_rti(root)
    if rti is not None:
        pay = read_rti(rti).rename("payrolls").to_frame()
        frames.append(pay)
        sources["rti"] = SourceInfo("HMRC PAYE RTI (ONS)", rti.name, str(pay.index[-1]))
    agents = _download(AGENTS_URL, root / "agentsscores.xlsx", check=_is_xlsx)
    if agents is not None:
        ag = read_agents(agents)
        hist = _download(AGENTS_HISTORIC_URL, root / "historic-agents-scores.xlsx", max_age_days=30, check=_is_xlsx)
        if hist is not None:
            old = read_agents_historic(hist)
            new = ag["agents_employment"].dropna()
            first = new.index.min() if len(new) else old.index.max() + 1
            ag = ag.reindex(ag.index.union(old.index))
            before = old[old.index < first]
            ag.loc[before.index, "agents_employment"] = before
        frames.append(ag)
        sources["agents"] = SourceInfo("Bank of England Agents' scores", agents.name, str(ag.dropna(how="all").index[-1]))
    dmp = download_dmp(root)
    if dmp is not None:
        dm = read_dmp(dmp)
        frames.append(dm)
        sources["dmp"] = SourceInfo("Decision Maker Panel", dmp.name, str(dm.dropna(how="all").index[-1]))
    bbg_series = [s for s in cat["series"] if s["source"] == "bloomberg"]
    missing: dict[str, str] = {}
    if data_source == "bloomberg":
        bb, missing = _bloomberg(bbg_series, cat["_meta"]["start"])
        if len(bb):
            frames.append(bb)
    else:
        missing = {s["id"]: "Bloomberg series (data source is not Bloomberg)" for s in bbg_series}
    monthly = pd.concat(frames, axis=1).sort_index()
    monthly = monthly.loc[cat["_meta"]["start"]:]
    for s in cat["series"]:
        if s["id"] not in monthly or monthly[s["id"]].dropna().empty:
            missing.setdefault(s["id"], "no data")
    return LabourData(monthly, sources, missing)


def transform(x: pd.Series, how: str) -> pd.Series:
    if how == "level":
        return x
    if how == "growth3":           # % change on three months earlier
        return 100 * (x / x.shift(3) - 1)
    if how == "diff3":
        return x - x.shift(3)
    raise ValueError(how)


def lfs_growth(monthly: pd.DataFrame) -> pd.Series:
    """LFS employment growth, three months on the previous three months (%)."""
    return transform(monthly["lfs_employment"], "growth3")
