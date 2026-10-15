"""
Browser access to sell-side research portals (Playwright, Chromium).

One background thread owns a persistent Chromium profile (var/browser-profile)
and one page per portal; Playwright's sync objects can't cross threads, so
every operation is queued to that thread. Agents only navigate within each
portal's allowed domains and never handle credentials: the PM logs in by hand
once per portal in a visible browser window (`login`), and the headless
browser then reuses the session cookies.

    python -m pod.research.browser login <portal id>     # opens a window to log in
    python -m pod.research.browser check <portal id>     # is the session still valid?
"""
from __future__ import annotations

import queue
import re
import sys
import threading
from concurrent.futures import Future
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import urljoin, urlparse

import yaml

from pod.research import ingest, store
from runtime_paths import state_path

PORTALS_FILE = Path(__file__).parent / "portals.yaml"
PROFILE_DIR = state_path("browser-profile")
PROFILE_DIR.mkdir(parents=True, exist_ok=True)
TEXT_LIMIT = 6000
LINK_LIMIT = 80
LOGIN_TIMEOUT_S = 600
_LOGIN_URL = re.compile(r"(login|signin|sign-in|sso|auth|logon|saml)", re.IGNORECASE)


class PortalError(RuntimeError):
    pass


def portals() -> dict[str, dict]:
    cfg = yaml.safe_load(PORTALS_FILE.read_text(encoding="utf-8"))
    return {p["id"]: p for p in cfg.get("portals", [])}


def portal(portal_id: str) -> dict:
    p = portals().get(portal_id)
    if not p:
        raise PortalError(f"Unknown portal {portal_id!r}. Configured: {', '.join(portals())}")
    if not p.get("enabled", True):
        raise PortalError(f"Portal {portal_id!r} is disabled in portals.yaml")
    return p


def allowed(p: dict, url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return any(host == d or host.endswith("." + d) for d in p.get("allowed_domains", []))


# ── login state (stored in the research DB) ─────────────────────────────────

def _sessions_table() -> None:
    with store.connect() as conn:
        conn.execute("CREATE TABLE IF NOT EXISTS portal_sessions (portal_id TEXT PRIMARY KEY, "
                     "logged_in_at TEXT, last_ok_at TEXT, last_status TEXT)")


def record_session(portal_id: str, *, logged_in: bool = False, status: str = "ok") -> None:
    _sessions_table()
    now = datetime.now(timezone.utc).isoformat()
    with store.connect() as conn:
        conn.execute("INSERT INTO portal_sessions (portal_id, logged_in_at, last_ok_at, last_status) VALUES (?,?,?,?) "
                     "ON CONFLICT(portal_id) DO UPDATE SET "
                     "logged_in_at = COALESCE(excluded.logged_in_at, portal_sessions.logged_in_at), "
                     "last_ok_at = CASE WHEN excluded.last_status = 'ok' THEN excluded.last_ok_at ELSE portal_sessions.last_ok_at END, "
                     "last_status = excluded.last_status",
                     (portal_id, now if logged_in else None, now, status))


def portal_status() -> list[dict]:
    _sessions_table()
    with store.connect() as conn:
        rows = {r["portal_id"]: dict(r) for r in conn.execute("SELECT * FROM portal_sessions")}
        sweeps = {r["source"]: dict(r) for r in conn.execute("SELECT * FROM sweeps")}
    out = []
    for pid, p in portals().items():
        s = rows.get(pid, {})
        out.append({"id": pid, "name": p["name"], "bank": p.get("bank"), "start_url": p["start_url"],
                    "enabled": p.get("enabled", True), "logged_in_at": s.get("logged_in_at"),
                    "last_ok_at": s.get("last_ok_at"), "last_status": s.get("last_status") or "never logged in",
                    "last_sweep": sweeps.get(f"portal:{pid}")})
    return out


# ── the browser worker ──────────────────────────────────────────────────────

class _Worker:
    """Owns Playwright on one thread; run(fn) executes fn(worker) there and returns its result."""

    def __init__(self):
        self._jobs: "queue.Queue[tuple[Callable, Future]]" = queue.Queue()
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self.context = None
        self.pages: dict[str, Any] = {}
        self.headless = True

    def _ensure_thread(self) -> None:
        with self._lock:
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._loop, daemon=True, name="portal-browser")
                self._thread.start()

    def _loop(self) -> None:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            self.pw = pw
            while True:
                fn, fut = self._jobs.get()
                if fut.set_running_or_notify_cancel():
                    try:
                        fut.set_result(fn(self))
                    except BaseException as exc:   # noqa: BLE001 — surfaced to the caller
                        fut.set_exception(exc)

    def run(self, fn: Callable[["_Worker"], Any], timeout: float = 120) -> Any:
        self._ensure_thread()
        fut: Future = Future()
        self._jobs.put((fn, fut))
        return fut.result(timeout=timeout)

    # called on the worker thread only
    def open_context(self, headless: bool = True) -> None:
        if self.context is not None and self.headless == headless:
            return
        self.close_context()
        self.context = self.pw.chromium.launch_persistent_context(
            str(PROFILE_DIR), headless=headless, accept_downloads=True,
            viewport={"width": 1400, "height": 1000})
        self.headless = headless

    def close_context(self) -> None:
        if self.context is not None:
            try:
                self.context.close()
            finally:
                self.context = None
                self.pages = {}

    def page(self, portal_id: str):
        self.open_context(headless=True)
        pg = self.pages.get(portal_id)
        if pg is None or pg.is_closed():
            pg = self.context.new_page()
            self.pages[portal_id] = pg
        return pg


_worker = _Worker()


def _looks_like_login(pg) -> bool:
    if _LOGIN_URL.search(pg.url):
        return True
    try:
        return pg.locator("input[type=password]").count() > 0
    except Exception:
        return False


def _view(pg, p: dict) -> dict:
    """What the agent sees of a page: URL, title, text, numbered links within the portal."""
    text = pg.inner_text("body") if pg.locator("body").count() else ""
    links, seen = [], set()
    for a in pg.locator("a[href]").all()[:600]:
        try:
            href = urljoin(pg.url, a.get_attribute("href") or "")
            label = " ".join((a.inner_text() or "").split())[:140]
        except Exception:
            continue
        if not href.startswith("http") or href in seen or not allowed(p, href):
            continue
        seen.add(href)
        links.append({"text": label, "url": href,
                      "pdf": href.lower().split("?")[0].endswith(".pdf")})
    links.sort(key=lambda link: (not link["pdf"], -len(link["text"])))
    login = _looks_like_login(pg)
    return {"portal": p["id"], "url": pg.url, "title": pg.title(), "login_required": login,
            "text": text[:TEXT_LIMIT] + ("\n[...truncated]" if len(text) > TEXT_LIMIT else ""),
            "links": [{"n": i + 1, **link} for i, link in enumerate(links[:LINK_LIMIT])]}


def _after_navigation(pg, p: dict) -> dict:
    try:
        pg.wait_for_load_state("networkidle", timeout=15000)
    except Exception:
        pass
    view = _view(pg, p)
    record_session(p["id"], status="login required" if view["login_required"] else "ok")
    if view["login_required"]:
        view["text"] = (f"SESSION EXPIRED or not logged in for {p['name']}. Stop browsing this portal and raise "
                        f"an alert asking the PM to log in (python -m pod.research.browser login {p['id']}).")
        view["links"] = []
    return view


# ── operations used by the agent tools ──────────────────────────────────────

def open_page(portal_id: str, url: Optional[str] = None) -> dict:
    p = portal(portal_id)
    target = url or p["start_url"]
    if not allowed(p, target):
        raise PortalError(f"{target} is outside {p['name']}'s allowed domains {p['allowed_domains']}")

    def job(w: _Worker):
        pg = w.page(portal_id)
        pg.goto(target, wait_until="domcontentloaded", timeout=45000)
        return _after_navigation(pg, p)
    return _worker.run(job)


def click(portal_id: str, text: str) -> dict:
    """Click the first element showing `text` on the portal's current page (menus, tabs, search results)."""
    p = portal(portal_id)

    def job(w: _Worker):
        pg = w.pages.get(portal_id)
        if pg is None or pg.is_closed():
            raise PortalError("Open the portal first with portal_open.")
        pg.get_by_text(text, exact=False).first.click(timeout=15000)
        if not allowed(p, pg.url):
            pg.go_back()
            raise PortalError(f"That click left {p['name']}'s allowed domains; went back.")
        return _after_navigation(pg, p)
    return _worker.run(job)


def fetch_document(portal_id: str, url: str, *, title: Optional[str] = None, bank: Optional[str] = None,
                   authors: Optional[str] = None, published_at: Optional[str] = None) -> dict:
    """Download a document with the portal session and add it to the library."""
    p = portal(portal_id)
    if not allowed(p, url):
        raise PortalError(f"{url} is outside {p['name']}'s allowed domains")
    tmp = state_path("research_tmp")
    tmp.mkdir(parents=True, exist_ok=True)

    def job(w: _Worker):
        w.open_context(headless=True)
        resp = w.context.request.get(url, timeout=60000)
        if not resp.ok:
            raise PortalError(f"Download failed: HTTP {resp.status}")
        ctype = resp.headers.get("content-type", "")
        if "pdf" in ctype or url.lower().split("?")[0].endswith(".pdf"):
            path = tmp / f"portal-{portal_id}.pdf"
            path.write_bytes(resp.body())
            return path, None
        # an HTML research page: render it so client-side content is included
        pg = w.page(portal_id)
        pg.goto(url, wait_until="domcontentloaded", timeout=45000)
        try:
            pg.wait_for_load_state("networkidle", timeout=15000)
        except Exception:
            pass
        if _looks_like_login(pg):
            record_session(portal_id, status="login required")
            raise PortalError(f"Session expired for {p['name']}; ask the PM to log in again.")
        return None, pg.inner_text("body")

    path, html_text = _worker.run(job, timeout=180)
    source, bank = f"portal:{portal_id}", bank or p.get("bank")
    if path is not None:
        doc_id, created = ingest.ingest_file(path, source=source, title=title, bank=bank, authors=authors,
                                             published_at=published_at, url=url)
        path.unlink(missing_ok=True)
    else:
        doc_id, created = store.add_document(html_text or "", source=source, title=title or url, bank=bank,
                                             authors=authors, published_at=published_at, url=url)
    record_session(portal_id, status="ok")
    return {"doc_id": doc_id, "created": created,
            "note": "Added to the library." if created else "Already in the library (duplicate content)."}


def login(portal_id: str, timeout_s: int = LOGIN_TIMEOUT_S) -> dict:
    """Open a visible window at the portal for the PM to log in; returns when that window is closed."""
    p = portal(portal_id)

    def job(w: _Worker):
        w.open_context(headless=False)
        pg = w.context.new_page()
        pg.goto(p["start_url"], wait_until="domcontentloaded", timeout=45000)
        pg.bring_to_front()
        try:
            pg.wait_for_event("close", timeout=timeout_s * 1000)
        except Exception:
            pass                   # timed out: keep whatever session exists
        w.close_context()          # back to headless on next use
    _worker.run(job, timeout=timeout_s + 60)
    record_session(portal_id, logged_in=True, status="ok")
    return {"portal": portal_id, "status": "Login window closed; session saved. Run a check to confirm."}


def check(portal_id: str) -> dict:
    view = open_page(portal_id)
    return {"portal": portal_id, "logged_in": not view["login_required"], "url": view["url"], "title": view["title"]}


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] in ("login", "check"):
        fn = login if sys.argv[1] == "login" else check
        print(fn(sys.argv[2]))
    else:
        print("usage: python -m pod.research.browser login|check <portal id>\n"
              f"portals: {', '.join(portals())}")
