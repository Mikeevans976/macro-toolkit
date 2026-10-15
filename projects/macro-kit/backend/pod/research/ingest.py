"""
Getting research into the library, without the LLM: text extraction, the drop
folder, and the research inbox (IMAP). Portal browsing is in browser.py; the
Librarian agent then summarises new documents and records their calls.

Research inbox (environment, e.g. backend/.env):
    RESEARCH_IMAP_HOST      e.g. imap.gmail.com or outlook.office365.com
    RESEARCH_IMAP_USER
    RESEARCH_IMAP_PASSWORD  an app password, never your main password
    RESEARCH_IMAP_FOLDER    folder or Gmail label holding research (default INBOX)
    RESEARCH_IMAP_SINCE_DAYS  how far back the first sweep looks (default 7)
Only messages not yet ingested are processed; messages are not modified.
"""
from __future__ import annotations

import email
import imaplib
import os
import re
import shutil
from datetime import date, timedelta
from email.header import decode_header, make_header
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Optional

from pod.research import store
from runtime_paths import state_path

DROP_DIR = state_path("research_inbox")         # drop PDFs/notes here; moved to research_files once ingested
DROP_DIR.mkdir(parents=True, exist_ok=True)
_SUFFIXES = {".pdf", ".html", ".htm", ".txt", ".md"}


# ── text extraction ─────────────────────────────────────────────────────────

def html_to_text(html: str) -> str:
    html = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r"<(br|p|div|li|h[1-6]|tr)[^>]*>", "\n", html, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", html)
    text = re.sub(r"&nbsp;", " ", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def extract_text(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        import pdfplumber
        with pdfplumber.open(str(path)) as pdf:
            return "\n\n".join((p.extract_text() or "") for p in pdf.pages[:120])
    raw = path.read_text(encoding="utf-8", errors="replace")
    return html_to_text(raw) if suffix in (".html", ".htm") else raw


def _guess_title(text: str, fallback: str) -> str:
    for line in text.splitlines():
        line = line.strip()
        if 12 <= len(line) <= 160:
            return line
    return fallback


def ingest_file(path: Path, *, source: str, title: Optional[str] = None, bank: Optional[str] = None,
                authors: Optional[str] = None, published_at: Optional[str] = None,
                url: Optional[str] = None) -> tuple[int, bool]:
    """Extract, store a copy under var/research_files, and index. Returns (doc_id, created)."""
    text = extract_text(path)
    h = store.content_hash(text or path.name)
    kept = store.FILES_DIR / f"{h[:16]}{path.suffix.lower()}"
    if not kept.exists():
        shutil.copy2(path, kept)
    return store.add_document(text, source=source, title=title or _guess_title(text, path.stem),
                              bank=bank, authors=authors, published_at=published_at, url=url,
                              file_path=str(kept))


# ── drop folder ─────────────────────────────────────────────────────────────

def sweep_drop_folder() -> dict:
    added, duplicates, failed = [], 0, []
    for path in sorted(DROP_DIR.glob("**/*")):
        if not path.is_file() or path.suffix.lower() not in _SUFFIXES:
            continue
        try:
            doc_id, created = ingest_file(path, source="upload")
            if created:
                added.append(doc_id)
            else:
                duplicates += 1
            path.unlink()   # a copy is kept in research_files
        except Exception as exc:
            failed.append(f"{path.name}: {type(exc).__name__}: {exc}")
    result = {"source": "drop-folder", "folder": str(DROP_DIR), "added": added, "duplicates": duplicates,
              "failed": failed}
    store.mark_sweep("drop-folder", f"{len(added)} added, {duplicates} duplicates, {len(failed)} failed")
    return result


# ── research inbox (IMAP) ───────────────────────────────────────────────────

def imap_configured() -> bool:
    return all(os.environ.get(k) for k in ("RESEARCH_IMAP_HOST", "RESEARCH_IMAP_USER", "RESEARCH_IMAP_PASSWORD"))


def _decode(value: Optional[str]) -> str:
    return str(make_header(decode_header(value))) if value else ""


def _sender_bank(sender: str) -> Optional[str]:
    """Best guess at the bank from the sender's domain (the Librarian corrects it when processing)."""
    m = re.search(r"@([\w.-]+)", sender)
    if not m:
        return None
    parts = m.group(1).lower().split(".")
    return parts[-2] if len(parts) >= 2 else parts[0]


def ingest_message(msg: email.message.Message, tmp_dir: Path) -> list[tuple[int, bool]]:
    """Ingest a research email: each PDF/HTML attachment as a document, else the body itself."""
    subject = _decode(msg.get("Subject")) or "(no subject)"
    sender = _decode(msg.get("From"))
    try:
        published = parsedate_to_datetime(msg.get("Date")).isoformat()
    except Exception:
        published = None
    bank = _sender_bank(sender)
    results, body_html, body_text = [], None, None
    for part in msg.walk():
        if part.is_multipart():
            continue
        ctype = part.get_content_type()
        filename = _decode(part.get_filename())
        payload = part.get_payload(decode=True) or b""
        if filename and Path(filename).suffix.lower() in _SUFFIXES:
            target = tmp_dir / re.sub(r"[^\w.\-]+", "_", filename)
            target.write_bytes(payload)
            results.append(ingest_file(target, source="email", title=f"{subject} — {filename}", bank=bank,
                                       authors=sender, published_at=published))
        elif ctype == "text/html" and body_html is None:
            body_html = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
        elif ctype == "text/plain" and body_text is None:
            body_text = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
    if not results:
        text = html_to_text(body_html) if body_html else (body_text or "")
        links = re.findall(r"https?://[^\s\"'<>]+", body_html or body_text or "")
        if links:
            text += "\n\nLinks in the email:\n" + "\n".join(dict.fromkeys(links[:30]))
        if len(text.strip()) > 200:
            results.append(store.add_document(text, source="email", title=subject, bank=bank,
                                              authors=sender, published_at=published))
    return results


def sweep_inbox(max_messages: int = 200) -> dict:
    if not imap_configured():
        return {"source": "email", "skipped": "RESEARCH_IMAP_HOST / USER / PASSWORD not set"}
    folder = os.environ.get("RESEARCH_IMAP_FOLDER", "INBOX")
    since_days = int(os.environ.get("RESEARCH_IMAP_SINCE_DAYS", "7"))
    since = (date.today() - timedelta(days=since_days)).strftime("%d-%b-%Y")
    tmp_dir = state_path("research_tmp")
    tmp_dir.mkdir(parents=True, exist_ok=True)
    added, duplicates, failed = [], 0, []
    imap = imaplib.IMAP4_SSL(os.environ["RESEARCH_IMAP_HOST"])
    try:
        imap.login(os.environ["RESEARCH_IMAP_USER"], os.environ["RESEARCH_IMAP_PASSWORD"])
        imap.select(f'"{folder}"', readonly=True)        # never marks messages read
        _, data = imap.search(None, "SINCE", since)
        ids = data[0].split()[-max_messages:]
        for mid in ids:
            try:
                _, msg_data = imap.fetch(mid, "(BODY.PEEK[])")
                msg = email.message_from_bytes(msg_data[0][1])
                for doc_id, created in ingest_message(msg, tmp_dir):
                    if created:
                        added.append(doc_id)
                    else:
                        duplicates += 1
            except Exception as exc:
                failed.append(f"message {mid.decode()}: {type(exc).__name__}: {exc}")
    finally:
        try:
            imap.logout()
        except Exception:
            pass
        shutil.rmtree(tmp_dir, ignore_errors=True)
    store.mark_sweep("email", f"{len(added)} added, {duplicates} duplicates, {len(failed)} failed")
    return {"source": "email", "folder": folder, "since": since, "added": added,
            "duplicates": duplicates, "failed": failed[:10]}
