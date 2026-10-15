"""
The research library: sell-side research the Research Librarian has collected.

Tables (var/research.db):
    documents  one row per document (deduplicated by content hash)
    passages   FTS5 full-text index over each document's text, in ~1,500-char passages
    calls      forecasts and trade recommendations extracted from documents, so each
               bank's view on a variable can be tracked over time
    sweeps     when each source (portal, inbox, drop folder) was last scanned

Document status: new (ingested, text indexed) → processed (summary, tags and calls
recorded by the Librarian) | failed (text could not be extracted).
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Optional

from runtime_paths import state_path

DB_PATH = state_path("research.db")
FILES_DIR = state_path("research_files")
FILES_DIR.mkdir(parents=True, exist_ok=True)
PASSAGE_CHARS = 1500
PASSAGE_OVERLAP = 200


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS documents (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            content_hash  TEXT NOT NULL UNIQUE,
            source        TEXT NOT NULL,          -- portal:<id> | email | bloomberg | upload
            bank          TEXT,
            title         TEXT NOT NULL,
            authors       TEXT,
            published_at  TEXT,
            url           TEXT,
            file_path     TEXT,
            ingested_at   TEXT NOT NULL,
            status        TEXT NOT NULL DEFAULT 'new',
            summary       TEXT,
            tags          TEXT,                   -- JSON list: markets, regions, themes
            n_chars       INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_docs_status ON documents(status);
        CREATE INDEX IF NOT EXISTS idx_docs_bank ON documents(bank, published_at);
        CREATE VIRTUAL TABLE IF NOT EXISTS passages USING fts5(
            text, doc_id UNINDEXED, seq UNINDEXED, tokenize = 'porter unicode61'
        );
        CREATE TABLE IF NOT EXISTS calls (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id        INTEGER NOT NULL,
            bank          TEXT NOT NULL,
            published_at  TEXT,
            recorded_at   TEXT NOT NULL,
            kind          TEXT NOT NULL,          -- forecast | trade | view
            market        TEXT NOT NULL,          -- normalised key, e.g. 'ECB deposit rate', 'EUR 2s10s', 'EURUSD'
            target_date   TEXT,                   -- e.g. '2027-12-31' or 'end-2027'; NULL for open views
            value         REAL,                   -- numeric forecast if any
            unit          TEXT,                   -- %, bp, level
            direction     TEXT,                   -- for trades/views: long, short, steepener, higher, lower...
            statement     TEXT NOT NULL           -- the call in the bank's words (short)
        );
        CREATE INDEX IF NOT EXISTS idx_calls_market ON calls(market, bank, published_at);
        CREATE TABLE IF NOT EXISTS sweeps (
            source      TEXT PRIMARY KEY,
            last_run    TEXT NOT NULL,
            last_result TEXT
        );
    """)
    return conn


def content_hash(text: str) -> str:
    return hashlib.sha256(" ".join(text.split()).lower().encode("utf-8")).hexdigest()


def _passages(text: str) -> list[str]:
    text = text.strip()
    if len(text) <= PASSAGE_CHARS:
        return [text] if text else []
    out, i = [], 0
    while i < len(text):
        out.append(text[i:i + PASSAGE_CHARS])
        i += PASSAGE_CHARS - PASSAGE_OVERLAP
    return out


def add_document(text: str, *, source: str, title: str, bank: Optional[str] = None,
                 authors: Optional[str] = None, published_at: Optional[str] = None,
                 url: Optional[str] = None, file_path: Optional[str] = None) -> tuple[int, bool]:
    """Store a document and index its text. Returns (doc_id, created); duplicates return the existing id."""
    h = content_hash(text)
    with connect() as conn:
        row = conn.execute("SELECT id FROM documents WHERE content_hash=?", (h,)).fetchone()
        if row:
            return row["id"], False
        status = "new" if text.strip() else "failed"
        cur = conn.execute(
            "INSERT INTO documents (content_hash, source, bank, title, authors, published_at, url, file_path, "
            "ingested_at, status, n_chars) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (h, source, bank, title, authors, published_at, url, file_path, _now(), status, len(text)))
        doc_id = cur.lastrowid
        conn.executemany("INSERT INTO passages (text, doc_id, seq) VALUES (?,?,?)",
                         [(p, doc_id, i) for i, p in enumerate(_passages(text))])
    return doc_id, True


def get_document(doc_id: int, with_text: bool = False, max_chars: int = 12000) -> dict:
    with connect() as conn:
        row = conn.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
        if not row:
            raise KeyError(f"No research document #{doc_id}")
        doc = dict(row)
        doc["tags"] = json.loads(doc["tags"] or "[]")
        doc["calls"] = [dict(c) for c in conn.execute("SELECT * FROM calls WHERE doc_id=? ORDER BY id", (doc_id,))]
        if with_text:
            parts = [r["text"] for r in conn.execute(
                "SELECT text, seq FROM passages WHERE doc_id=? ORDER BY CAST(seq AS INTEGER)", (doc_id,))]
            # passages overlap; strip the overlap when re-joining
            text = parts[0] if parts else ""
            for p in parts[1:]:
                text += p[PASSAGE_OVERLAP:]
            doc["text"] = text if len(text) <= max_chars else text[:max_chars] + f"\n[...truncated, {len(text)} chars total]"
    return doc


def update_document(doc_id: int, *, summary: Optional[str] = None, tags: Optional[list[str]] = None,
                    bank: Optional[str] = None, title: Optional[str] = None, authors: Optional[str] = None,
                    published_at: Optional[str] = None, status: Optional[str] = None) -> None:
    fields = {k: v for k, v in dict(summary=summary, bank=bank, title=title, authors=authors,
                                     published_at=published_at, status=status).items() if v is not None}
    if tags is not None:
        fields["tags"] = json.dumps(tags)
    if not fields:
        return
    with connect() as conn:
        conn.execute(f"UPDATE documents SET {', '.join(f'{k}=?' for k in fields)} WHERE id=?",
                     [*fields.values(), doc_id])


def _fts_query(query: str) -> str:
    """Make free text safe for FTS5 MATCH: quote each term, OR them together."""
    terms = [t for t in "".join(c if c.isalnum() or c in " -" else " " for c in query).split() if len(t) > 1]
    return " OR ".join(f'"{t}"' for t in terms)


def search(query: str, *, bank: Optional[str] = None, since_days: Optional[int] = None,
           source: Optional[str] = None, limit: int = 8) -> list[dict]:
    """Best-matching passages (BM25), one hit per document, with document metadata."""
    match = _fts_query(query)
    if not match:
        return []
    cond, params = ["passages MATCH ?"], [match]
    if bank:
        cond.append("d.bank LIKE ?")
        params.append(f"%{bank}%")
    if source:
        cond.append("d.source LIKE ?")
        params.append(f"{source}%")
    if since_days:
        cond.append("COALESCE(d.published_at, d.ingested_at) >= ?")
        params.append((datetime.now(timezone.utc) - timedelta(days=since_days)).isoformat()[:10])
    sql = (f"SELECT d.id, d.bank, d.title, d.published_at, d.source, d.url, d.status, d.summary, "
           f"snippet(passages, 0, '«', '»', ' … ', 40) AS excerpt, bm25(passages) AS score "
           f"FROM passages JOIN documents d ON d.id = passages.doc_id "
           f"WHERE {' AND '.join(cond)} ORDER BY score LIMIT ?")
    with connect() as conn:
        rows = conn.execute(sql, params + [limit * 4]).fetchall()
    seen, out = set(), []
    for r in rows:
        if r["id"] in seen:
            continue
        seen.add(r["id"])
        out.append(dict(r))
        if len(out) >= limit:
            break
    return out


def list_documents(status: Optional[str] = None, bank: Optional[str] = None, since_days: Optional[int] = None,
                   limit: int = 50) -> list[dict]:
    cond, params = [], []
    if status:
        cond.append("status=?")
        params.append(status)
    if bank:
        cond.append("bank LIKE ?")
        params.append(f"%{bank}%")
    if since_days:
        cond.append("ingested_at >= ?")
        params.append((datetime.now(timezone.utc) - timedelta(days=since_days)).isoformat())
    where = f"WHERE {' AND '.join(cond)}" if cond else ""
    with connect() as conn:
        rows = conn.execute(f"SELECT id, source, bank, title, published_at, ingested_at, status, url, n_chars, "
                            f"summary FROM documents {where} ORDER BY ingested_at DESC LIMIT ?",
                            params + [limit]).fetchall()
    return [dict(r) for r in rows]


def record_calls(doc_id: int, calls: list[dict]) -> int:
    doc = get_document(doc_id)
    bank = doc["bank"] or "unknown"
    now = _now()
    with connect() as conn:
        conn.executemany(
            "INSERT INTO calls (doc_id, bank, published_at, recorded_at, kind, market, target_date, value, unit, "
            "direction, statement) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            [(doc_id, c.get("bank") or bank, doc["published_at"], now, c["kind"], c["market"].strip(),
              c.get("target_date"), c.get("value"), c.get("unit"), c.get("direction"), c["statement"])
             for c in calls])
    return len(calls)


def query_calls(market: Optional[str] = None, bank: Optional[str] = None, kind: Optional[str] = None,
                since_days: Optional[int] = 365, latest_only: bool = False, limit: int = 200) -> list[dict]:
    cond, params = [], []
    if market:
        cond.append("c.market LIKE ?")
        params.append(f"%{market}%")
    if bank:
        cond.append("c.bank LIKE ?")
        params.append(f"%{bank}%")
    if kind:
        cond.append("c.kind = ?")
        params.append(kind)
    if since_days:
        cond.append("COALESCE(c.published_at, c.recorded_at) >= ?")
        params.append((datetime.now(timezone.utc) - timedelta(days=since_days)).isoformat()[:10])
    where = f"WHERE {' AND '.join(cond)}" if cond else ""
    with connect() as conn:
        rows = [dict(r) for r in conn.execute(
            f"SELECT c.*, d.title FROM calls c JOIN documents d ON d.id = c.doc_id {where} "
            f"ORDER BY COALESCE(c.published_at, c.recorded_at) DESC, c.id DESC LIMIT ?", params + [limit])]
    if not latest_only:
        return rows
    latest: dict[tuple, dict] = {}
    for r in rows:   # newest first: keep the first per (bank, market, kind, target_date)
        latest.setdefault((r["bank"].lower(), r["market"].lower(), r["kind"], r["target_date"]), r)
    return list(latest.values())


def mark_sweep(source: str, result: str) -> None:
    with connect() as conn:
        conn.execute("INSERT INTO sweeps (source, last_run, last_result) VALUES (?,?,?) "
                     "ON CONFLICT(source) DO UPDATE SET last_run=excluded.last_run, last_result=excluded.last_result",
                     (source, _now(), result[:500]))


def stats() -> dict:
    with connect() as conn:
        by_status = {r["status"]: r["n"] for r in conn.execute("SELECT status, COUNT(*) n FROM documents GROUP BY status")}
        by_bank = [dict(r) for r in conn.execute(
            "SELECT COALESCE(bank, 'unknown') bank, COUNT(*) n, MAX(COALESCE(published_at, ingested_at)) latest "
            "FROM documents GROUP BY bank ORDER BY n DESC LIMIT 30")]
        by_source = {r["source"]: r["n"] for r in conn.execute("SELECT source, COUNT(*) n FROM documents GROUP BY source")}
        n_calls = conn.execute("SELECT COUNT(*) FROM calls").fetchone()[0]
        sweeps = [dict(r) for r in conn.execute("SELECT * FROM sweeps ORDER BY last_run DESC")]
    return {"documents_by_status": by_status, "documents_by_bank": by_bank, "documents_by_source": by_source,
            "calls": n_calls, "sweeps": sweeps}
