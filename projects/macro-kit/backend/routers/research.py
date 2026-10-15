"""
Research library and Bloomberg feed API (backend/pod/research/, backend/pod/bloomberg.py).

    GET  /api/pod/research/status                  library stats, portals, inbox, Bloomberg
    GET  /api/pod/research/documents?q=&bank=      search (q) or list newest
    GET  /api/pod/research/documents/{id}          one document with its text and calls
    GET  /api/pod/research/calls                   tracked sell-side calls
    POST /api/pod/research/upload                  add files to the library (multipart)
    POST /api/pod/research/portals/{id}/login      open a visible browser window to log in
    POST /api/pod/research/portals/{id}/check      is the saved session still valid?
    GET  /api/pod/bloomberg/status                 B-PIPE configuration and news feed state

The login window opens on the machine running the backend; it is for local use.
"""
from __future__ import annotations

import asyncio
import re
import threading
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from auth import get_current_user
from pod import bloomberg
from pod.research import browser, ingest, store

router = APIRouter(tags=["research"], dependencies=[Depends(get_current_user)])

MAX_UPLOAD_BYTES = 40 * 1024 * 1024
_login_threads: dict[str, threading.Thread] = {}


@router.get("/api/pod/research/status")
async def research_status():
    portals = await asyncio.to_thread(browser.portal_status)
    for p in portals:
        t = _login_threads.get(p["id"])
        p["login_window_open"] = bool(t and t.is_alive())
    return {
        "library": await asyncio.to_thread(store.stats),
        "portals": portals,
        "inbox_configured": ingest.imap_configured(),
        "drop_folder": str(ingest.DROP_DIR),
        "bloomberg": await asyncio.to_thread(bloomberg.status),
    }


@router.get("/api/pod/research/documents")
async def research_documents(q: Optional[str] = None, bank: Optional[str] = None,
                             status: Optional[str] = None, since_days: Optional[int] = None, limit: int = 50):
    limit = max(1, min(limit, 200))
    if q:
        return {"documents": await asyncio.to_thread(store.search, q, bank=bank, since_days=since_days, limit=limit)}
    return {"documents": await asyncio.to_thread(store.list_documents, status, bank, since_days, limit)}


@router.get("/api/pod/research/documents/{doc_id}")
async def research_document(doc_id: int):
    try:
        return {"document": await asyncio.to_thread(store.get_document, doc_id, True, 60000)}
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/api/pod/research/calls")
async def research_calls(market: Optional[str] = None, bank: Optional[str] = None, kind: Optional[str] = None,
                         since_days: int = 365, latest_only: bool = False):
    return {"calls": await asyncio.to_thread(store.query_calls, market, bank, kind, since_days, latest_only)}


@router.post("/api/pod/research/upload")
async def research_upload(files: list[UploadFile] = File(...)):
    results = []
    for f in files:
        name = re.sub(r"[^\w.\-]+", "_", f.filename or "upload")
        if not name.lower().endswith((".pdf", ".html", ".htm", ".txt", ".md")):
            results.append({"file": name, "error": "Only PDF, HTML, text and Markdown files are accepted."})
            continue
        data = await f.read(MAX_UPLOAD_BYTES + 1)
        if len(data) > MAX_UPLOAD_BYTES:
            results.append({"file": name, "error": "File is larger than 40 MB."})
            continue
        path = ingest.DROP_DIR / name
        path.write_bytes(data)
        try:
            doc_id, created = await asyncio.to_thread(ingest.ingest_file, path, source="upload")
            results.append({"file": name, "doc_id": doc_id, "created": created})
        except Exception as exc:
            results.append({"file": name, "error": f"{type(exc).__name__}: {exc}"})
        finally:
            path.unlink(missing_ok=True)
    return {"results": results}


@router.post("/api/pod/research/portals/{portal_id}/login")
async def portal_login(portal_id: str):
    try:
        browser.portal(portal_id)
    except browser.PortalError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    running = _login_threads.get(portal_id)
    if running and running.is_alive():
        return {"portal": portal_id, "status": "A login window is already open."}

    def _run():
        try:
            browser.login(portal_id)
        except Exception:
            pass

    t = threading.Thread(target=_run, daemon=True, name=f"portal-login-{portal_id}")
    _login_threads[portal_id] = t
    t.start()
    return {"portal": portal_id, "status": "A browser window has opened on the server machine. Log in, then close "
                                         "the window; the session is saved for the Research Librarian."}


@router.post("/api/pod/research/portals/{portal_id}/check")
async def portal_check(portal_id: str):
    try:
        return await asyncio.to_thread(browser.check, portal_id)
    except browser.PortalError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Could not reach the portal: {type(exc).__name__}: {exc}")


@router.get("/api/pod/bloomberg/status")
async def bloomberg_status():
    return await asyncio.to_thread(bloomberg.status)
