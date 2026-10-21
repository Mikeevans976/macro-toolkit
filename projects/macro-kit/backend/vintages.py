"""
Real-time data vintages for the Quant Macro nowcasts: every value with the
date it became public, so any past day's dataset can be rebuilt exactly as
it stood (first prints, then each revision).

Store: ``var/quant_macro/vintages.db`` (SQLite), one row per published value

  observations(dataset, series, period, known_from, value, source)
    dataset     catalogue name without ".json" (shared by every model on it)
    period      'YYYY-MM'
    known_from  'YYYY-MM-DD', first day the value was public
    value       in the Bloomberg ticker's units, before the catalogue transform
    source      ons | bbg_first | snapshot

Rows are only ever added. ``snapshot_runs`` records each live data load, so a
value first seen in a later snapshot can be dated by its release (if it came
out since the previous run) or by the run itself (a revision).

Sources, best first (``assemble``):
  ons        ONS revisions triangles: every published vintage, dated by the
             release it came with. Periods before a triangle's first vintage
             fall back to Bloomberg.
  bbg_first  Bloomberg's first-reported value (ACTUAL_RELEASE) at the release
             date; today's value is assumed from release + settle_days.
  snapshot   what Bloomberg showed on each live load; exact from the first run.
Series with neither (surveys) are taken as unrevised: today's value from its
release date.
"""
from __future__ import annotations

import io
import json
import logging
import re
import sqlite3
import urllib.request
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Callable

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

ONS_BASE = "https://www.ons.gov.uk"

# ONS revisions triangles. ``page``: dataset landing page (the download link
# changes with every edition, so it is read from the page); ``link``: regex for
# the file; ``member``: file inside a zip; ``sheet``: worksheet with the
# triangle; ``diff``/``scale``: levels → the ticker's monthly change.
ONS_DATASETS: dict[str, dict] = {
    "mgdp_mom": {
        "title": "Monthly GDP revisions triangle (m/m)",
        "page": "/economy/grossdomesticproductgdp/datasets/revisionstrianglesformonthlygdp",
        "link": r"mgdprevisiontriangles\.zip",
        "member": r"\(M on M\)\.xlsx$",
        "sheet": "Estimate",
    },
    "iop_mom": {
        "title": "Index of Production revisions triangle (1 month growth)",
        "page": "/economy/economicoutputandproductivity/output/datasets/revisionstotheindexofproduction",
        "link": r"iopiom\d+\.zip",
        "member": r"index of Production - 1 Month Growth\.xlsm$",
        "sheet": "triangle",
    },
    "rsi_mom": {
        "title": "Retail sales revisions triangle (1 month growth)",
        "page": "/businessindustryandtrade/retailindustry/datasets/retailsalesrevisionstriangles1monthgrowth",
        "link": r"revisionstrianglesmomworkingtables\.xlsx",
        "sheet": "triangle",
    },
    "rti_payrolls": {
        "title": "PAYE RTI revisions triangle (payrolled employees)",
        "page": "/employmentandlabourmarket/peopleinwork/earningsandworkinghours/datasets/"
                "earningsandemploymentfrompayasyouearnrealtimeinformationrevisiontriangle",
        "link": r"rtirevisiontriangle\w+\.xlsx",
        "sheet": "Payrolled employees",
        "diff": True,
        "scale": 0.001,
    },
}

_SCHEMA = """
CREATE TABLE IF NOT EXISTS observations (
    dataset TEXT NOT NULL, series TEXT NOT NULL, period TEXT NOT NULL,
    known_from TEXT NOT NULL, value REAL NOT NULL, source TEXT NOT NULL,
    PRIMARY KEY (dataset, series, period, known_from, source)
);
CREATE TABLE IF NOT EXISTS snapshot_runs (
    dataset TEXT NOT NULL, run_date TEXT NOT NULL, PRIMARY KEY (dataset, run_date)
);
"""

COLUMNS = ["series", "period", "known_from", "value", "source"]


# ---------------------------------------------------------------------------
# Store
# ---------------------------------------------------------------------------

class VintageStore:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as con:
            con.executescript(_SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        con = sqlite3.connect(self.path, timeout=30)
        con.execute("PRAGMA journal_mode=WAL")
        return con

    def add(self, dataset: str, rows: pd.DataFrame) -> int:
        """Insert rows (COLUMNS; period Period/str, known_from Timestamp/str). Existing keys are kept."""
        if rows.empty:
            return 0
        recs = [(dataset, r.series, str(r.period), pd.Timestamp(r.known_from).strftime("%Y-%m-%d"),
                 float(r.value), r.source) for r in rows[COLUMNS].itertuples(index=False)]
        with self._connect() as con:
            before = con.total_changes
            con.executemany("INSERT OR IGNORE INTO observations VALUES (?, ?, ?, ?, ?, ?)", recs)
            return con.total_changes - before

    def read(self, dataset: str) -> pd.DataFrame:
        with self._connect() as con:
            df = pd.read_sql_query(
                "SELECT series, period, known_from, value, source FROM observations WHERE dataset = ?",
                con, params=(dataset,))
        df["period"] = pd.PeriodIndex(df["period"], freq="M")
        df["known_from"] = pd.to_datetime(df["known_from"])
        return df

    def runs(self, dataset: str) -> list[pd.Timestamp]:
        with self._connect() as con:
            got = con.execute("SELECT run_date FROM snapshot_runs WHERE dataset = ? ORDER BY run_date",
                              (dataset,)).fetchall()
        return [pd.Timestamp(r[0]) for r in got]

    def snapshot(self, dataset: str, latest: dict[str, pd.Series], release: dict[str, pd.Series],
                 today: pd.Timestamp) -> int:
        """Record today's values where they differ from the last snapshot.

        A period first seen now is dated by its release if that came after the previous run
        (it was published in between), otherwise by today (a revision, or the first run)."""
        today = today.normalize()
        runs = [r for r in self.runs(dataset) if r < today]
        prev_run = runs[-1] if runs else None
        stored = self.read(dataset)
        snaps = stored[stored["source"] == "snapshot"].sort_values("known_from")
        last = snaps.groupby(["series", "period"])["value"].last()
        rows = []
        for sid, x in latest.items():
            rel = release.get(sid, pd.Series(dtype="datetime64[ns]"))
            for p, v in x.dropna().items():
                old = last.get((sid, p))
                if old is not None and np.isclose(old, v, rtol=0, atol=1e-9):
                    continue
                r = rel.get(p)
                fresh = old is None and prev_run is not None and r is not None and not pd.isna(r) and prev_run < r <= today
                rows.append((sid, p, r if fresh else today, float(v), "snapshot"))
        n = self.add(dataset, pd.DataFrame(rows, columns=COLUMNS))
        with self._connect() as con:
            con.execute("INSERT OR IGNORE INTO snapshot_runs VALUES (?, ?)", (dataset, today.strftime("%Y-%m-%d")))
        return n


# ---------------------------------------------------------------------------
# ONS revisions triangles
# ---------------------------------------------------------------------------

_MONTH_FORMATS = ("%Y %b", "%b-%y", "%B %Y", "%b %Y", "%Y-%m")


def _month(x) -> pd.Period | None:
    if isinstance(x, datetime):
        return pd.Period(x, "M")
    if isinstance(x, str):
        s = x.strip()
        for fmt in _MONTH_FORMATS:
            try:
                return pd.Period(datetime.strptime(s, fmt), "M")
            except ValueError:
                continue
    return None


def parse_triangle(rows: list[tuple]) -> pd.DataFrame:
    """Revisions triangle → long frame (vintage, period, value).

    Layout shared by the ONS triangles: a 'Relating to period' header row of reference
    months, then one row per publication month (label = month of publication). Summary
    rows ('First Estimate', 'Latest Estimate', 'Value 12 months later', …) are skipped."""
    header = None
    for i, row in enumerate(rows):
        for j, cell in enumerate(row):
            if isinstance(cell, str) and cell.strip().lower().startswith("relating to period"):
                header = (i, j)
                break
        if header:
            break
    if header is None:
        raise ValueError("no 'Relating to period' header row")
    h, lab = header
    periods = {j: p for j, cell in enumerate(rows[h]) if j > lab and (p := _month(cell)) is not None}
    out = []
    for row in rows[h + 1:]:
        if len(row) <= lab:
            continue
        vm = _month(row[lab])
        if vm is None:
            continue
        for j, p in periods.items():
            v = row[j] if j < len(row) else None
            if isinstance(v, (int, float)) and not isinstance(v, bool) and np.isfinite(v):
                out.append((vm, p, float(v)))
    return pd.DataFrame(out, columns=["vintage", "period", "value"])


def triangle_rows(tri: pd.DataFrame, release_fn: Callable[[pd.Period], pd.Timestamp],
                  diff: bool = False, scale: float = 1.0) -> pd.DataFrame:
    """Long triangle → dated vintage rows (period, known_from, value), revisions only.

    Each publication is dated by the release of the newest period it contains
    (``release_fn``), or mid-month if that date falls outside the publication month."""
    if diff:
        tri = tri.sort_values(["vintage", "period"]).copy()
        prev = tri.groupby("vintage")["period"].shift()
        lvl = tri.groupby("vintage")["value"].shift()
        ok = prev.notna() & (prev == tri["period"] - 1)
        tri = tri.assign(value=(tri["value"] - lvl).where(ok))
        tri = tri.dropna(subset=["value"])
    tri = tri.assign(value=(tri["value"] * scale).round(6))
    dates = {}
    for vm, grp in tri.groupby("vintage"):
        d = release_fn(grp["period"].max())
        if d is None or pd.isna(d) or pd.Timestamp(d).to_period("M") != vm:
            d = vm.start_time + pd.Timedelta(days=14)
        dates[vm] = pd.Timestamp(d).normalize()
    tri = tri.assign(known_from=tri["vintage"].map(dates)).sort_values(["period", "known_from"])
    changed = tri.groupby("period")["value"].diff().fillna(1.0).abs() > 1e-9
    return tri.loc[changed, ["period", "known_from", "value"]].reset_index(drop=True)


def _http_get(url: str, timeout: int = 60) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "macro-kit/1.0 (research)"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def download_ons(key: str, root: Path, max_age_days: float = 1.0, today: pd.Timestamp | None = None) -> Path | None:
    """Latest edition of an ONS triangle, kept as downloaded under root/<key>/.

    The landing page is re-read at most once a day; a new edition is saved next to the
    old ones. Returns the newest local file (None if never downloaded and offline)."""
    spec = ONS_DATASETS[key]
    folder = root / key
    folder.mkdir(parents=True, exist_ok=True)
    meta_path = folder / "fetched.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
    now = today or pd.Timestamp.now()
    local = folder / meta["file"] if meta.get("file") else None
    if local and local.exists() and (now - pd.Timestamp(meta["checked"])).days < max_age_days:
        return local
    try:
        html = _http_get(ONS_BASE + spec["page"], timeout=30).decode("utf-8", "replace")
        links = list(dict.fromkeys(re.findall(r'/file\?uri=([^"\'&]+)', html)))
        links = [u for u in links if re.search(spec["link"], u)]
        links.sort(key=lambda u: "/current/" not in u)          # current edition first, then page order
        for uri in links:
            name = uri.rsplit("/", 1)[-1]
            target = folder / name
            if not target.exists():
                body = _http_get(f"{ONS_BASE}/file?uri={uri}")
                if not body.startswith(b"PK"):                    # an HTML error page, not a zip/xlsx
                    continue
                target.write_bytes(body)
            meta = {"file": name, "uri": uri, "checked": now.isoformat()}
            meta_path.write_text(json.dumps(meta, indent=1), encoding="utf-8")
            return target
        logger.warning("ONS %s: no downloadable edition found", key)
    except Exception as exc:
        logger.warning("ONS %s: download failed (%s)", key, exc)
    return local if local and local.exists() else None


def read_ons_file(key: str, path: Path) -> pd.DataFrame:
    """Parse a downloaded ONS triangle file → long (vintage, period, value)."""
    import openpyxl

    spec = ONS_DATASETS[key]
    data = path.read_bytes()
    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            names = [n for n in z.namelist() if re.search(spec["member"], n, re.I)]
            if not names:
                raise ValueError(f"{path.name}: no member matching {spec['member']!r}")
            data = z.read(names[0])
    wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    try:
        rows = list(wb[spec["sheet"]].iter_rows(values_only=True))
    finally:
        wb.close()
    return parse_triangle(rows)


def ons_rows(key: str, path: Path, release_fn: Callable[[pd.Period], pd.Timestamp]) -> pd.DataFrame:
    spec = ONS_DATASETS[key]
    tri = read_ons_file(key, path)
    return triangle_rows(tri, release_fn, diff=spec.get("diff", False), scale=spec.get("scale", 1.0))


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------

def assemble(series: list[dict], stored: pd.DataFrame, latest: dict[str, pd.Series],
             first: dict[str, pd.Series], release: dict[str, pd.Series],
             first_run: pd.Timestamp | None) -> tuple[pd.DataFrame, dict[str, str]]:
    """All dated observations per series from the best sources available, and a note on each.

    ``latest``/``first``/``release``: today's Bloomberg values, first-reported values and
    release dates per period. ``stored``: rows from the store (ons, snapshot). ``first_run``:
    first snapshot date; the first-print/settle guess only covers releases before it."""
    frames, info = [], {}
    for s in series:
        sid = s["id"]
        if sid not in latest:
            continue
        cfg = s.get("vintages") or {}
        settle = pd.Timedelta(days=cfg.get("settle_days", 0))
        rel = release[sid]
        x = latest[sid].dropna()
        f = first.get(sid, pd.Series(dtype=float)).dropna()

        fb = []                                   # Bloomberg fallback: first print, then today's value
        for p, v in x.items():
            r = rel.get(p)
            if r is None or pd.isna(r):
                continue
            if p in f.index and not np.isclose(f[p], v, rtol=0, atol=1e-9):
                fb += [(p, r, f[p], "bbg_first"), (p, r + settle, v, "bbg_first")]
            else:
                fb.append((p, r, v, "bbg_first"))
        fb = pd.DataFrame(fb, columns=["period", "known_from", "value", "source"])

        mine = stored[stored["series"] == sid]
        ons = mine[mine["source"] == "ons"]
        snaps = mine[mine["source"] == "snapshot"]
        if not ons.empty:
            start = ons["known_from"].min()
            newer = fb[~fb["period"].isin(ons["period"])]             # released since the triangle's edition
            parts = [fb[fb["known_from"] < start], ons[["period", "known_from", "value", "source"]],
                     newer[newer["known_from"] >= start]]
            key = cfg.get("ons")
            info[sid] = (f"ONS revisions triangle ({ONS_DATASETS[key]['title']}) from {start:%b %Y}; "
                         f"earlier periods {'first print + latest' if not f.empty else 'latest value only'} (Bloomberg)")
        else:
            if first_run is not None:
                fb = fb[fb["known_from"] < first_run]
            parts = [fb, snaps[["period", "known_from", "value", "source"]]]
            if not cfg:
                info[sid] = "Not revised (survey): latest value from its release date"
            elif not f.empty:
                info[sid] = (f"Bloomberg first print, latest value assumed after {cfg.get('settle_days', 0)} days"
                             + (f"; daily snapshots from {first_run:%d %b %Y}" if first_run is not None else ""))
            else:
                info[sid] = ("Latest value only (first prints unavailable)"
                             + (f"; daily snapshots from {first_run:%d %b %Y}" if first_run is not None else ""))
        df = pd.concat([p_ for p_ in parts if not p_.empty], ignore_index=True) if any(
            not p_.empty for p_ in parts) else pd.DataFrame(columns=["period", "known_from", "value", "source"])
        frames.append(df.assign(series=sid))
    obs = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=COLUMNS)
    return dedupe(obs[COLUMNS]), info


def dedupe(obs: pd.DataFrame) -> pd.DataFrame:
    """Drop rows that repeat the value already public for the same (series, period)."""
    obs = obs.sort_values(["series", "period", "known_from"], kind="stable").reset_index(drop=True)
    same_cell = (obs["series"] == obs["series"].shift()) & (obs["period"] == obs["period"].shift())
    repeat = same_cell & np.isclose(obs["value"], obs["value"].shift().fillna(np.inf), rtol=0, atol=1e-9)
    return obs.loc[~repeat].reset_index(drop=True)
