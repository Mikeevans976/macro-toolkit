"""
UK fiscal data for the Debt Sustainability monitor (debt_sustainability.py).

Every source is public and downloaded by the backend, except the DMO gilt list
(its site blocks scripts: the page uploads the D1A report instead):

  ONS public sector finances (PUSF)   monthly, every release kept (sources/ons_pusf/)
  OBR Economic and fiscal outlook     parsed from the PDF (backend/data/obr/, uploads)
  Bank of England yield curves        daily nominal / real / implied RPI / OIS spot curves
  Bank of England database (IADB)     quarterly Bank Rate and par gilt yields
  ONS national accounts               quarterly real and nominal GDP
  DMO gilts in issue (D1A)            uploaded file (CSV, XLSX or XML)

Downloads are re-checked at most once a day; offline, the last copy is used.
"""
from __future__ import annotations

import io
import json
import logging
import re
import urllib.request
import zipfile
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

DATA_DIR = Path(__file__).parent / "data"
USER_AGENT = "Mozilla/5.0 (macro-kit research)"


def http_get(url: str, timeout: int = 120) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _fresh(path: Path, max_age_days: float, now: pd.Timestamp | None = None) -> bool:
    if not path.exists():
        return False
    age = (now or pd.Timestamp.now()) - pd.Timestamp(path.stat().st_mtime, unit="s")
    return age < pd.Timedelta(days=max_age_days)


def fy_label(year: int) -> str:
    """Financial year starting in April of ``year`` → '2026-27'."""
    return f"{year}-{(year + 1) % 100:02d}"


def fy_start(label: str) -> int:
    return int(label[:4])


def fy_of(period: pd.Period) -> int:
    """Financial year (start year) containing a monthly period."""
    return period.year if period.month >= 4 else period.year - 1


# ---------------------------------------------------------------------------
# ONS public sector finances
# ---------------------------------------------------------------------------

PUSF_URL = ("https://www.ons.gov.uk/file?uri=/economy/governmentpublicsectorandtaxes/"
            "publicsectorfinance/datasets/publicsectorfinances/current/pusf.csv")

# key → (CDID, unit). Flows are £m a month; stocks are end-month levels.
PUSF_SERIES: dict[str, tuple[str, str]] = {
    "psnb": ("J5II", "£m"),             # PS net borrowing ex PS banks
    "cbd": ("JW2T", "£m"),              # current budget deficit ex PS banks
    "net_investment": ("JW2Z", "£m"),
    "receipts": ("JW2O", "£m"),         # total current receipts ex PS banks
    "tme": ("KX5Q", "£m"),
    "interest_paid": ("JW2P", "£m"),    # interest & dividends paid to private sector and RoW
    "interest_received": ("JW2L", "£m"),
    "cg_interest_ex_uplift": ("JNYX", "£m"),
    "il_uplift": ("JNYY", "£m"),
    "psnd": ("HF6W", "£bn"),
    "psnd_pct": ("HF6X", "%"),
    "psnd_exboe": ("CPOF", "£m"),
    "psnd_exboe_pct": ("CPOA", "%"),
    "psnfl": ("JSK7", "£bn"),
    "psnfl_pct": ("CPOE", "%"),
    "gilts": ("JMD5", "£m"),            # gross debt: British government securities
    "tbills": ("BKPJ", "£m"),
    "nsandi": ("ACUA", "£m"),
    "apf_gilts": ("MEX2", "£m"),        # APF gilt holdings, nominal
    "apf_loan": ("JQ2I", "£m"),         # central bank loan to the APF (≈ reserves created)
    "apf_net_interest": ("MDD8", "£m"),
}
PUSF_FLOWS = {"psnb", "cbd", "net_investment", "receipts", "tme", "interest_paid", "interest_received",
              "cg_interest_ex_uplift", "il_uplift", "apf_net_interest"}
PUSF_FLIP = {"psnb", "cbd", "net_investment"}      # the CSV signs deficits negative; flipped so a deficit is positive

_MONTHS = {m: i for i, m in enumerate(["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"], 1)}


@dataclass
class Pusf:
    monthly: pd.DataFrame                   # PeriodIndex (M) × PUSF_SERIES keys, £m / £bn / %
    release_date: pd.Timestamp | None
    next_release: str | None
    path: Path | None = None
    editions: list[str] = field(default_factory=list)


def download_pusf(folder: Path, max_age_days: float = 0.5) -> Path | None:
    """Current PUSF CSV, saved once per release as pusf_<release date>.csv."""
    folder.mkdir(parents=True, exist_ok=True)
    stamp = folder / "checked"
    editions = sorted(folder.glob("pusf_*.csv"))
    if editions and _fresh(stamp, max_age_days):
        return editions[-1]
    try:
        body = http_get(PUSF_URL)
        text = body.decode("latin-1")
        m = re.search(r'"Release Date","(\d{2})-(\d{2})-(\d{4})"', text)
        name = f"pusf_{m.group(3)}-{m.group(2)}-{m.group(1)}.csv" if m else f"pusf_{pd.Timestamp.today():%Y-%m-%d}.csv"
        target = folder / name
        if not target.exists():
            target.write_bytes(body)
            logger.info("ONS PUSF: saved edition %s", name)
        stamp.write_text(pd.Timestamp.now().isoformat(), encoding="utf-8")
        return target
    except Exception as exc:
        logger.warning("ONS PUSF download failed (%s); using the last saved edition", exc)
        return editions[-1] if editions else None


def read_pusf(path: Path) -> Pusf:
    raw = pd.read_csv(path, header=None, dtype=str, encoding="latin-1", keep_default_na=False)
    cdids = raw.iloc[1].tolist()
    labels = raw.iloc[:, 0].tolist()
    meta = {str(raw.iloc[i, 0]).strip().lower(): raw.iloc[i, 1] for i in range(min(8, len(raw)))}
    rows = [i for i, s in enumerate(labels) if re.fullmatch(r"\d{4} [A-Z]{3}", str(s).strip())]
    index = pd.PeriodIndex([pd.Period(year=int(labels[i][:4]), month=_MONTHS[labels[i][5:8]], freq="M") for i in rows])
    out = {}
    for key, (cdid, _unit) in PUSF_SERIES.items():
        if cdid not in cdids:
            logger.warning("ONS PUSF: series %s (%s) not in this edition", key, cdid)
            continue
        col = cdids.index(cdid)
        vals = pd.to_numeric(raw.iloc[rows, col].replace("", np.nan), errors="coerce").to_numpy()
        out[key] = -vals if key in PUSF_FLIP else vals
    df = pd.DataFrame(out, index=index).sort_index()
    rel = meta.get("release date")
    release = pd.to_datetime(rel, format="%d-%m-%Y", errors="coerce") if rel else None
    return Pusf(monthly=df, release_date=None if release is None or pd.isna(release) else release,
                next_release=meta.get("next release") or None, path=path)


def load_pusf(folder: Path) -> Pusf | None:
    path = download_pusf(folder)
    if path is None:
        return None
    p = read_pusf(path)
    p.editions = [f.stem.removeprefix("pusf_") for f in sorted(folder.glob("pusf_*.csv"))]
    return p


def fiscal_years(monthly: pd.DataFrame) -> pd.DataFrame:
    """Financial-year table: flows summed April–March, stocks at end-March.

    Index: FY start year. Column ``months`` counts the months observed (12 = complete)."""
    fy = pd.Series([fy_of(p) for p in monthly.index], index=monthly.index)
    flows = [c for c in monthly.columns if c in PUSF_FLOWS]
    stocks = [c for c in monthly.columns if c not in PUSF_FLOWS]
    agg = monthly[flows].groupby(fy.values).sum(min_count=1)
    months = monthly[flows[0]].notna().groupby(fy.values).sum() if flows else pd.Series(dtype=int)
    last = monthly[stocks].groupby(fy.values).last()
    out = pd.concat([agg, last], axis=1)
    out["months"] = months
    return out


# ---------------------------------------------------------------------------
# OBR Economic and fiscal outlook (parsed from the PDF)
# ---------------------------------------------------------------------------

_NUM = r"-?\d[\d,]*\.?\d*"


def _numbers(line: str) -> list[float]:
    return [float(x.replace(",", "")) for x in re.findall(_NUM, line) if re.search(r"\d", x)]


def _fy_header(block: list[str]) -> list[str]:
    for ln in block:
        years = re.findall(r"(\d{4})-(\d{2})(?=\d{4}-|\s|$)", ln)
        if len(years) >= 3:
            return [f"{a}-{b}" for a, b in years]
    raise ValueError("no financial-year header")


def _table_block(lines: list[str], title: str, length: int = 80) -> list[str]:
    """The lines of a detailed table, from its title (the Annex copy, not the contents page)."""
    idx = [i for i, ln in enumerate(lines) if ln.startswith(title)]
    for i in idx:
        nxt = " ".join(lines[i + 1:i + 6])
        if "...." not in lines[i] and re.search(r"\d{4}-\d{2}", nxt):
            return lines[i:i + length]
    raise ValueError(f"table {title!r} not found")


def _row(block: list[str], label: str, n: int, start: int = 0) -> list[float] | None:
    """First row after ``start`` whose text (footnote digits stripped) begins with ``label``.

    Values may sit on the following line when the label wraps."""
    pat = re.compile(r"^" + re.escape(label) + r"[\d,]*(?:\s|$)")
    for i in range(start, len(block)):
        if pat.match(block[i]):
            rest = re.sub(r"^[\d,]*", "", block[i][len(label):])      # footnote markers: 'GDP1,2 2,934'
            vals = _numbers(rest)
            if len(vals) < n and i + 1 < len(block):
                vals = _numbers(block[i + 1])
            if len(vals) >= n:
                return vals[:n]
    return None


def parse_efo_text(text: str, source: str = "") -> dict:
    """OBR EFO → the forecast lines the monitor uses (£bn, %, % of GDP by financial year)."""
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    head = " ".join(lines[:60])
    m = re.search(r"Economic and fiscal outlook\s*[–-]\s*(\w+ \d{4})", head) or re.search(r"(January|February|March|April|May|June|July|August|September|October|November|December) (\d{4})", head)
    edition = (m.group(1) if m and m.lastindex == 1 else f"{m.group(1)} {m.group(2)}") if m else "unknown"

    a3 = _table_block(lines, "Table A.3: Determinants of the fiscal forecast")
    years = _fy_header(a3)
    n = len(years)
    det = {
        "real_gdp_growth": _row(a3, "Real GDP", n),
        "nominal_gdp_growth": _row(a3, "Nominal GDP", n),
        "nominal_gdp_bn": _row(a3, "Nominal GDP (£ billion)", n),
        "nominal_gdp_centred_bn": _row(a3, "Nominal GDP (centred end-March £bn)", n),
        "gdp_deflator": _row(a3, "GDP deflator", n),
        "rpi": _row(a3, "RPI", n),
        "cpi": _row(a3, "CPI", n),
        "bank_rate": _row(a3, "Bank Rate (per cent)", n),
        "gilt_rate": _row(a3, "Market gilt rates (per cent)", n),
    }

    a9 = _table_block(lines, "Table A.9: Fiscal aggregates", 70)
    bn_at = next(i for i, ln in enumerate(a9) if ln.startswith("£ billion"))
    pct = {
        "receipts": _row(a9, "Public sector current receipts (a)", n),
        "tme": _row(a9, "Total managed expenditure (b)", n),
        "net_investment": _row(a9, "Public sector net investment (d)", n),
        "cbd": _row(a9, "Current budget deficit (c+e-a)", n),
        "psnfl": _row(a9, "Public sector net financial liabilities", n),
        "psnb": _row(a9, "Public sector net borrowing (b-a)", n),
        "primary_deficit": _row(a9, "Primary deficit", n),
        "ca_primary_deficit": _row(a9, "Cyclically adjusted primary deficit", n),
        "cgncr": _row(a9, "Central government net cash requirement", n),
        "psnd": _row(a9, "Public sector net debt", n),
        "psnd_exboe": _row(a9, "Public sector net debt ex Bank of England", n),
    }
    bn = {
        "cbd": _row(a9, "Current budget deficit", n, bn_at),
        "net_investment": _row(a9, "Public sector net investment", n, bn_at),
        "psnb": _row(a9, "Public sector net borrowing", n, bn_at),
        "psnfl": _row(a9, "Public sector net financial liabilities", n, bn_at),
        "psnd": _row(a9, "Public sector net debt", n, bn_at),
        "psnd_exboe": _row(a9, "Public sector net debt ex Bank of England", n, bn_at),
        "net_debt_interest": _row(a9, "Net debt interest", n, bn_at),
        "non_interest_receipts": _row(a9, "Non-interest receipts", n, bn_at),
    }
    a7 = _table_block(lines, "Table A.7: Total managed expenditure", 60)
    bn["cg_debt_interest"] = _row(a7, "Central government debt interest, net of", n)

    apf = None
    try:
        t53 = _table_block(lines, "Table 5.3: Forecast of cash transfers to the APF", 30)
        f_years = re.findall(r"\d{4}-\d{2}", " ".join(t53[1:5]))
        vals = _row(t53, "APF interest losses (a)", len(f_years))
        if vals:
            apf = dict(zip(f_years, vals))
    except (ValueError, StopIteration):
        pass

    flat = " ".join(lines)
    def _reckoner(pattern: str) -> float | None:
        mm = re.search(pattern, flat)
        return float(mm.group(1)) if mm else None
    sens = {
        "nominal_gdp_0p1pp_bn": _reckoner(r"0\.1 percentage point change in nominal GDP growth[^£]*£(\d+(?:\.\d+)?) billion"),
        "rates_1pp_bn": _reckoner(r"1 percentage point change in gilt yields[^£]*£(\d+(?:\.\d+)?) billion"),
        "rpi_1pp_bn": _reckoner(r"1 percentage point increase in RPI inflation[^£]*£(\d+(?:\.\d+)?) billion"),
    }
    sens_year = re.search(r"change in PSNB of £\d+ billion in (\d{4}-\d{2})", flat)
    cut = re.search(r"fiscal forecast,? over the 10 working days to (\d{1,2} \w+)", flat)
    return {
        "edition": edition,
        "source": source,
        "years": years,
        "outturn_years": 1,
        "determinants": det,
        "pct_gdp": pct,
        "bn": bn,
        "apf_interest_losses": apf,
        "sensitivities": {**sens, "year": sens_year.group(1) if sens_year else years[-1]},
        "fiscal_cutoff": cut.group(1) if cut else None,
    }


def parse_efo_pdf(path: Path, source: str = "") -> dict:
    import pdfplumber

    with pdfplumber.open(path) as pdf:
        text = "\n".join(p.extract_text() or "" for p in pdf.pages)
    out = parse_efo_text(text, source)
    missing = [f"{grp}.{k}" for grp in ("determinants", "pct_gdp", "bn") for k, v in out[grp].items() if v is None]
    if missing:
        raise ValueError(f"OBR EFO {path.name}: could not read {', '.join(missing)}")
    return out


def _edition_date(edition: str) -> pd.Timestamp:
    try:
        return pd.Timestamp(f"1 {edition}")
    except ValueError:
        return pd.Timestamp(0)


def load_efo(upload_dir: Path) -> dict:
    """Latest OBR forecast: uploaded editions (var) and the ones shipped in backend/data/obr/."""
    files = list((DATA_DIR / "obr").glob("efo_*.json")) + (list(upload_dir.glob("efo_*.json")) if upload_dir.exists() else [])
    editions = [json.loads(f.read_text(encoding="utf-8")) for f in files]
    if not editions:
        raise FileNotFoundError("no OBR forecast in backend/data/obr/")
    return max(editions, key=lambda e: _edition_date(e["edition"]))


def fiscal_rules() -> dict:
    return json.loads((DATA_DIR / "fiscal_rules_uk.json").read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# Bank of England yield curves (spot, % a year, maturities in years)
# ---------------------------------------------------------------------------

BOE_CURVES = "https://www.bankofengland.co.uk/-/media/boe/files/statistics/yield-curves/"
CURVE_KINDS = {            # kind → (archive zip, member prefix in archive, member prefix in latest)
    "nominal": ("glcnominalddata.zip", "GLC Nominal daily data_2025", "GLC Nominal daily data current month"),
    "real": ("glcrealddata.zip", "GLC Real daily data_2025", "GLC Real daily data current month"),
    "inflation": ("glcinflationddata.zip", "GLC Inflation daily data_2025", "GLC Inflation daily data current month"),
    "ois": ("oisddata.zip", "OIS daily data_2025", "OIS daily data current month"),
}


def parse_curve_sheet(rows: list[tuple]) -> pd.DataFrame:
    """A BoE '4. spot curve' sheet → DataFrame (date × maturity in years)."""
    mats, data = None, {}
    for r in rows:
        if not r:
            continue
        if r[0] == "years:":
            mats = [float(x) if isinstance(x, (int, float)) else np.nan for x in r[1:]]
        elif mats is not None and hasattr(r[0], "year"):
            vals = [float(x) if isinstance(x, (int, float)) else np.nan for x in r[1:len(mats) + 1]]
            data[pd.Timestamp(r[0]).normalize()] = vals
    if mats is None:
        return pd.DataFrame()
    df = pd.DataFrame.from_dict(data, orient="index", columns=mats).sort_index()
    df = df.loc[:, [c for c in df.columns if np.isfinite(c)]]
    return df.dropna(how="all")


def _read_curve_xlsx(data: bytes) -> pd.DataFrame:
    import openpyxl

    wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    try:
        sheet = next(s for s in wb.sheetnames if "spot curve" in s and "short" not in s)
        return parse_curve_sheet(list(wb[sheet].iter_rows(values_only=True)))
    finally:
        wb.close()


def _zip_member(z: zipfile.ZipFile, prefix: str) -> bytes | None:
    names = [n for n in z.namelist() if n.startswith(prefix)]
    return z.read(names[0]) if names else None


def update_boe_curves(folder: Path, max_age_days: float = 0.5) -> dict[str, pd.DataFrame]:
    """Daily spot curves since 2025 (archive once, then the current-month file daily)."""
    folder.mkdir(parents=True, exist_ok=True)
    stamp = folder / "checked"
    curves = {k: pd.read_csv(folder / f"{k}.csv", index_col=0, parse_dates=True) if (folder / f"{k}.csv").exists() else pd.DataFrame()
              for k in CURVE_KINDS}
    for df in curves.values():
        df.columns = [float(c) for c in df.columns]
    if all(len(c) for c in curves.values()) and _fresh(stamp, max_age_days):
        return curves
    try:
        latest = zipfile.ZipFile(io.BytesIO(http_get(BOE_CURVES + "latest-yield-curve-data.zip")))
    except Exception as exc:
        logger.warning("BoE yield curves: download failed (%s)", exc)
        return curves
    for kind, (archive, arch_prefix, latest_prefix) in CURVE_KINDS.items():
        parts = [curves[kind]] if len(curves[kind]) else []
        try:
            if not len(curves[kind]):
                logger.info("BoE yield curves: downloading the %s archive (once)", kind)
                z = zipfile.ZipFile(io.BytesIO(http_get(BOE_CURVES + archive, timeout=600)))
                member = _zip_member(z, arch_prefix)
                if member:
                    parts.append(_read_curve_xlsx(member))
            member = _zip_member(latest, latest_prefix)
            if member:
                parts.append(_read_curve_xlsx(member))
        except Exception as exc:
            logger.warning("BoE %s curve: %s", kind, exc)
        if parts:
            df = pd.concat(parts)
            df = df[~df.index.duplicated(keep="last")].sort_index()
            df = df.loc[:, sorted(df.columns)]
            df.to_csv(folder / f"{kind}.csv", float_format="%.5f")
            curves[kind] = df
    stamp.write_text(pd.Timestamp.now().isoformat(), encoding="utf-8")
    return curves


# ---------------------------------------------------------------------------
# Quarterly macro history (BoE database, ONS national accounts)
# ---------------------------------------------------------------------------

IADB = ("https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?csv.x=yes"
        "&Datefrom=01/Jan/1985&Dateto=now&SeriesCodes={codes}&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N")
BOE_QUARTERLY = {"bank_rate": "IUQABEDR", "gilt_5y": "IUQASNPY", "gilt_10y": "IUQAMNPY", "gilt_20y": "IUQALNPY"}
ONS_QUARTERLY = {   # key → (CDID, dataset)
    "real_gdp": ("ABMI", "qna"),
    "nominal_gdp": ("YBHA", "qna"),
}
ONS_TS = "https://www.ons.gov.uk/generator?format=csv&uri=/economy/grossdomesticproductgdp/timeseries/{cdid}/{ds}"


def quarterly_history(folder: Path, max_age_days: float = 7) -> pd.DataFrame:
    """Quarterly Bank Rate, par gilt yields (BoE) and real/nominal GDP (ONS), cached weekly."""
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "quarterly.csv"
    if _fresh(path, max_age_days):
        df = pd.read_csv(path, index_col=0)
        df.index = pd.PeriodIndex(df.index, freq="Q")
        return df
    try:
        boe = pd.read_csv(io.BytesIO(http_get(IADB.format(codes=",".join(BOE_QUARTERLY.values())))))
        boe.index = pd.PeriodIndex(pd.to_datetime(boe.pop("DATE"), format="%d %b %Y"), freq="Q")
        boe = boe.rename(columns={v: k for k, v in BOE_QUARTERLY.items()})
        cols = {}
        for key, (cdid, ds) in ONS_QUARTERLY.items():
            raw = pd.read_csv(io.BytesIO(http_get(ONS_TS.format(cdid=cdid.lower(), ds=ds))), header=None, dtype=str)
            q = raw[raw[0].str.fullmatch(r"\d{4} Q\d", na=False)]
            cols[key] = pd.Series(pd.to_numeric(q[1], errors="coerce").to_numpy(),
                                  index=pd.PeriodIndex([p.replace(" ", "") for p in q[0]], freq="Q"))
        df = boe.join(pd.DataFrame(cols), how="outer").sort_index()
        df.to_csv(path)
        return df
    except Exception as exc:
        logger.warning("Quarterly macro history download failed (%s)", exc)
        if path.exists():
            df = pd.read_csv(path, index_col=0)
            df.index = pd.PeriodIndex(df.index, freq="Q")
            return df
        raise


# ---------------------------------------------------------------------------
# DMO gilts in issue (uploaded D1A report)
# ---------------------------------------------------------------------------

_FRACTIONS = {"¼": "1/4", "½": "1/2", "¾": "3/4", "⅛": "1/8", "⅜": "3/8", "⅝": "5/8", "⅞": "7/8", "⅓": "1/3", "⅔": "2/3"}


def coupon_from_name(name: str) -> float | None:
    """'4⅛% Treasury Gilt 2027' → 4.125; '0 5/8% Index-linked Treasury Gilt 2045' → 0.625."""
    s = name
    for k, v in _FRACTIONS.items():
        s = s.replace(k, f" {v}")
    m = re.match(r"\s*(\d+)?\s*(\d+/\d+)?\s*%", s)
    if not m or not (m.group(1) or m.group(2)):
        return None
    return float(int(m.group(1) or 0) + (Fraction(m.group(2)) if m.group(2) else 0))


def _pick(cols: list[str], *patterns: str, exclude: str | None = None) -> str | None:
    for pat in patterns:
        for c in cols:
            if re.search(pat, c, re.I) and not (exclude and re.search(exclude, c, re.I)):
                return c
    return None


def parse_gilt_register(data: bytes, filename: str) -> pd.DataFrame:
    """DMO 'Gilts in issue' (D1A) as CSV, XLSX or XML → one row per gilt.

    Columns: name, isin, maturity, coupon (%), index_linked, nominal (£m), uplifted (£m)."""
    suffix = filename.lower().rsplit(".", 1)[-1]
    if suffix == "xml" or data.lstrip()[:1] == b"<":
        import xml.etree.ElementTree as ET

        root = ET.fromstring(data)
        recs = [dict(el.attrib) for el in root.iter() if len(el.attrib) >= 3]
        if not recs:
            recs = [{c.tag: (c.text or "") for c in el} for el in root.iter() if len(el) >= 3 and all(len(c) == 0 for c in el)]
        df = pd.DataFrame(recs)
    elif suffix in ("xlsx", "xls"):
        raw = pd.read_excel(io.BytesIO(data), header=None)
        hdr = next(i for i in range(min(30, len(raw))) if raw.iloc[i].astype(str).str.contains("redemption|maturity", case=False).any())
        df = raw.iloc[hdr + 1:].set_axis(raw.iloc[hdr].astype(str).tolist(), axis=1)
    else:
        text = data.decode("utf-8-sig", errors="replace")
        lines = text.splitlines()
        hdr = next(i for i, ln in enumerate(lines[:30]) if re.search("redemption|maturity", ln, re.I))
        df = pd.read_csv(io.StringIO("\n".join(lines[hdr:])))
    cols = [str(c) for c in df.columns]
    df.columns = cols
    c_name = _pick(cols, r"instrument.?name", r"^name", r"gilt", r"stock")
    c_mat = _pick(cols, r"redemption.?date", r"maturity")
    c_isin = _pick(cols, r"isin")
    c_nom = _pick(cols, r"amount.*issue.*nominal", r"nominal", r"amount.?in.?issue", r"amount.?outstanding", exclude=r"uplift")
    c_upl = _pick(cols, r"includ.*uplift", r"uplift")
    if not (c_name and c_mat and c_nom):
        raise ValueError(f"unrecognised gilt list: columns {cols[:12]}")
    out = pd.DataFrame({
        "name": df[c_name].astype(str).str.strip(),
        "isin": df[c_isin].astype(str).str.strip() if c_isin else "",
        "maturity": pd.to_datetime(df[c_mat], errors="coerce", dayfirst=True),
        "nominal": pd.to_numeric(df[c_nom].astype(str).str.replace(",", ""), errors="coerce"),
        "uplifted": pd.to_numeric(df[c_upl].astype(str).str.replace(",", ""), errors="coerce") if c_upl else np.nan,
    })
    out = out.dropna(subset=["maturity", "nominal"])
    out = out[out["nominal"] > 0]
    out["index_linked"] = out["name"].str.contains("index", case=False)
    out["coupon"] = out["name"].map(coupon_from_name)
    if out["nominal"].median() > 1e6:          # reported in £ rather than £m
        out["nominal"] /= 1e6
        out["uplifted"] /= 1e6
    if out.empty:
        raise ValueError("no gilts found in the uploaded file")
    return out.reset_index(drop=True)
