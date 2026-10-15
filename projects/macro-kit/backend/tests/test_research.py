"""
Tests for the research library (pod/research/) and the Bloomberg layer (pod/bloomberg.py).

No network and no Bloomberg: stores are redirected to a temp dir, emails are built
in memory, Bloomberg parsing is tested on plain-Python payloads, and the portal
browser runs against a local HTTP server (skipped if Playwright's Chromium is missing).
"""
import asyncio
import email.message
import sys
import threading
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pod import bloomberg  # noqa: E402
from pod.research import browser, ingest, store  # noqa: E402


def make_pdf(text: str) -> bytes:
    """A minimal one-page PDF containing `text` (enough for pdfplumber)."""
    stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode()
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out, offsets = bytearray(b"%PDF-1.4\n"), []
    for i, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    out += b"".join(b"%010d 00000 n \n" % o for o in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    return bytes(out)


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DB_PATH", tmp_path / "research.db")
    monkeypatch.setattr(store, "FILES_DIR", tmp_path / "files")
    monkeypatch.setattr(ingest, "DROP_DIR", tmp_path / "inbox")
    monkeypatch.setattr(bloomberg, "NEWS_DB", tmp_path / "news.db")
    for d in ("files", "inbox"):
        (tmp_path / d).mkdir()


ECB_NOTE = ("ECB outlook: we now expect the deposit rate to reach 1.75% by end-2027, a cut lower than before. "
            "We recommend receiving 2y EUR swaps. Inflation is falling faster than the ECB projects. ") * 5


# ── store ───────────────────────────────────────────────────────────────────

def test_add_search_and_dedupe():
    doc_id, created = store.add_document(ECB_NOTE, source="upload", title="ECB outlook", bank="Bank A",
                                         published_at="2026-10-01")
    assert created
    again, created2 = store.add_document("  " + ECB_NOTE.upper(), source="email", title="dup")
    assert again == doc_id and not created2                       # whitespace/case-insensitive dedupe
    hits = store.search("deposit rate receiving")
    assert hits[0]["id"] == doc_id and "«" in hits[0]["excerpt"]
    assert store.search("deposit", bank="Bank B") == []
    assert store.search("!!") == []                                # unsafe query → no crash


def test_long_document_round_trips_through_passages():
    text = "".join(f"Paragraph {i} about gilts and the BoE. " for i in range(400))
    doc_id, _ = store.add_document(text, source="upload", title="Long note")
    assert store.get_document(doc_id, with_text=True, max_chars=10**6)["text"] == text.strip()


def test_calls_track_revisions_and_latest_consensus():
    d1, _ = store.add_document("note one " * 50, source="upload", title="Old", bank="Bank A", published_at="2026-09-01")
    d2, _ = store.add_document("note two " * 50, source="upload", title="New", bank="Bank A", published_at="2026-10-01")
    d3, _ = store.add_document("note three " * 50, source="upload", title="B", bank="Bank B", published_at="2026-10-02")
    call = dict(kind="forecast", market="ECB deposit rate", target_date="end-2027", unit="%")
    store.record_calls(d1, [{**call, "value": 2.0, "statement": "2.0% by end-2027"}])
    store.record_calls(d2, [{**call, "value": 1.75, "statement": "1.75% by end-2027"}])
    store.record_calls(d3, [{**call, "value": 1.5, "statement": "1.5% by end-2027"}])
    history = store.query_calls(market="ECB deposit", since_days=3650)
    assert [c["value"] for c in history if c["bank"] == "Bank A"] == [1.75, 2.0]   # newest first: a revision
    latest = store.query_calls(market="ecb deposit", since_days=3650, latest_only=True)
    assert sorted(c["value"] for c in latest) == [1.5, 1.75]


def test_update_marks_processed_and_stats():
    doc_id, _ = store.add_document(ECB_NOTE, source="upload", title="t")
    store.update_document(doc_id, summary="Cuts to 1.75%.", tags=["ECB", "EUR rates"], bank="Bank A", status="processed")
    doc = store.get_document(doc_id)
    assert doc["status"] == "processed" and doc["tags"] == ["ECB", "EUR rates"]
    assert store.stats()["documents_by_status"] == {"processed": 1}


# ── ingestion ───────────────────────────────────────────────────────────────

def test_pdf_and_drop_folder():
    (ingest.DROP_DIR / "ecb.pdf").write_bytes(make_pdf("ECB deposit rate forecast 1.75 percent"))
    (ingest.DROP_DIR / "notes.txt").write_text(ECB_NOTE)
    (ingest.DROP_DIR / "image.png").write_bytes(b"x")
    res = ingest.sweep_drop_folder()
    assert len(res["added"]) == 2 and not res["failed"]
    assert not (ingest.DROP_DIR / "ecb.pdf").exists() and (ingest.DROP_DIR / "image.png").exists()
    assert store.search("forecast percent")[0]["title"].startswith("ECB deposit rate")


def test_email_with_attachment_and_body_only(tmp_path):
    msg = email.message.EmailMessage()
    msg["Subject"], msg["From"], msg["Date"] = "Rates weekly", "Strategist <rates@bank-a.com>", "Mon, 12 Oct 2026 07:00:00 +0000"
    msg.set_content("See attached.")
    msg.add_attachment(make_pdf("Gilts look cheap versus swaps"), maintype="application", subtype="pdf",
                       filename="gilts.pdf")
    (doc_id, created), = ingest.ingest_message(msg, tmp_path)
    doc = store.get_document(doc_id)
    assert created and doc["source"] == "email" and doc["bank"] == "bank-a" and doc["published_at"].startswith("2026-10-12")

    body = email.message.EmailMessage()
    body["Subject"], body["From"] = "FX flash", "fx@bank-b.co.uk"
    body.set_content("<p>" + "USD looks rich versus rate differentials. " * 10 + "</p><a href='https://x.bank-b.co.uk/n/1'>link</a>",
                     subtype="html")
    (doc2, _), = ingest.ingest_message(body, tmp_path)
    text = store.get_document(doc2, with_text=True)["text"]
    assert "USD looks rich" in text and "https://x.bank-b.co.uk/n/1" in text and "<p>" not in text


def test_inbox_skipped_without_config(monkeypatch):
    for k in ("RESEARCH_IMAP_HOST", "RESEARCH_IMAP_USER", "RESEARCH_IMAP_PASSWORD"):
        monkeypatch.delenv(k, raising=False)
    assert "skipped" in ingest.sweep_inbox()


# ── Bloomberg (pure parts) ──────────────────────────────────────────────────

def test_calendar_rows_from_bdp_payload():
    uni = bloomberg.universe()
    f = uni["fields"]
    soon = (date.today() + timedelta(days=2)).isoformat()
    far = (date.today() + timedelta(days=40)).isoformat()
    raw = {"NFP TCH Index": {f["future_release_dates"]: [{"Release Date": soon}, {"Release Date": far}],
                             f["consensus_median"]: 150.0, f["latest_value"]: 142.0},
           "USURTOT Index": {"_errors": [{"message": "Unknown field"}]}}
    rows = bloomberg.build_calendar(raw, {**uni, "regions": {"US": uni["regions"]["US"][:2]}},
                                    date.today(), date.today() + timedelta(days=7))
    assert len(rows) == 1 and rows[0]["indicator"].startswith("Nonfarm") and rows[0]["consensus_median"] == 150.0


def test_econ_calendar_without_bloomberg_is_a_clear_error():
    with pytest.raises(bloomberg.BloombergNotConnected, match="web_search"):
        bloomberg.econ_calendar()


def test_news_message_mapping_store_and_search():
    payload = {"MessageData": {"HEADLINE": "ECB's Lagarde says inflation fight not over", "STORY_ID": "S1",
                               "TICKERS": ["EUR Curncy"], "TIME_OF_ARRIVAL": "2026-10-14T07:01:00"}}
    item = bloomberg.message_to_item(payload, "//blp/news/topic")
    assert item["headline"].startswith("ECB's Lagarde") and item["story_id"] == "S1"
    assert bloomberg.store_news(item) and not bloomberg.store_news(item)        # duplicate story ignored
    assert bloomberg.search_news("Lagarde inflation")[0]["story_id"] == "S1"
    assert bloomberg.search_news(ticker="EUR")[0]["headline"] == item["headline"]
    assert bloomberg.message_to_item({"x": 1}, "t") is None


def test_news_subscriber_needs_configuration(monkeypatch):
    monkeypatch.delenv("BBG_NEWS_SUBSCRIPTIONS", raising=False)
    with pytest.raises(bloomberg.BloombergNotConnected, match="BBG_NEWS_SUBSCRIPTIONS"):
        bloomberg.run_news_subscriber()


# ── research sweep workflow (fake model client) ─────────────────────────────

def test_research_sweep_processes_new_documents(monkeypatch, tmp_path):
    import agents.storage as runs_storage
    from pod import storage as pod_storage, workflows
    from pod.runner import Runner
    from tests.test_pod import FakeClient, message, text, tool_use
    monkeypatch.setattr(runs_storage, "_DB_PATH", tmp_path / "runs.db")
    pod_storage.init_db()
    monkeypatch.setattr(browser, "portal_status", lambda: [
        {"id": "jpm", "name": "JPM", "enabled": True, "last_status": "never logged in", "last_sweep": None}])
    (ingest.DROP_DIR / "n.txt").write_text(ECB_NOTE)

    def script(params):
        task = params["messages"][0]["content"]
        if "Process these new library documents" in task and len(params["messages"]) == 1:
            import re
            doc_id = int(re.search(r"#(\d+)", task).group(1))
            return message([tool_use("research_update", {"doc_id": doc_id, "summary": "ECB to 1.75%.", "tags": ["ECB"]}, "u"),
                            tool_use("record_research_calls", {"doc_id": doc_id, "calls": [
                                {"kind": "forecast", "market": "ECB deposit rate", "target_date": "end-2027",
                                 "value": 1.75, "unit": "%", "statement": "1.75% by end-2027"}]}, "c")], "tool_use")
        return message([text("digest")], "end_turn")

    runner = Runner("run-1", lambda *a: None, 4, client=FakeClient(script))
    r = asyncio.run(workflows.research_sweep(runner, "sweep"))
    assert r.text == "digest"
    assert store.list_documents(status="processed")[0]["summary"] == "ECB to 1.75%."
    assert store.query_calls(market="ECB", since_days=None)[0]["value"] == 1.75
    from pod import book
    assert "JPM" in book.list_alerts()[0]["message"]                 # portal needing login was flagged


# ── portal browser against a local fake portal ──────────────────────────────

class _Portal(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        pages = {
            "/": b"<html><body><h1>Research</h1><a href='/latest'>Latest research</a>"
                 b"<a href='https://elsewhere.example.org/x'>Outside</a></body></html>",
            "/latest": b"<html><body><a href='/notes/ecb.pdf'>ECB: one more cut</a>"
                       b"<a href='/notes/fx.html'>FX weekly</a></body></html>",
            "/notes/fx.html": b"<html><body><p>" + b"The dollar looks rich versus rates. " * 20 + b"</p></body></html>",
            "/expired": b"<html><body><form><input type='password'></form></body></html>",
        }
        if self.path == "/notes/ecb.pdf":
            body, ctype = make_pdf("ECB one more cut to 1.75 percent"), "application/pdf"
        elif self.path in pages:
            body, ctype = pages[self.path], "text/html"
        else:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.end_headers()
        self.wfile.write(body)


def _chromium_available() -> bool:
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            return Path(pw.chromium.executable_path).exists()
    except Exception:
        return False


@pytest.mark.skipif(not _chromium_available(), reason="Playwright Chromium not installed")
def test_portal_browse_fetch_and_expiry(tmp_path, monkeypatch):
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Portal)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://localhost:{server.server_address[1]}"
    cfg = tmp_path / "portals.yaml"
    cfg.write_text(f"portals:\n  - id: fake\n    name: Fake Bank\n    bank: Fake Bank\n    start_url: {base}/\n"
                   f"    allowed_domains: [localhost]\n    enabled: true\n")
    monkeypatch.setattr(browser, "PORTALS_FILE", cfg)
    monkeypatch.setattr(browser, "PROFILE_DIR", tmp_path / "profile")
    try:
        view = browser.open_page("fake")
        assert not view["login_required"] and [link["text"] for link in view["links"]] == ["Latest research"]
        view = browser.click("fake", "Latest research")
        assert view["links"][0]["pdf"] and view["links"][0]["text"] == "ECB: one more cut"
        res = browser.fetch_document("fake", view["links"][0]["url"], title="ECB: one more cut", published_at="2026-10-13")
        assert res["created"] and store.get_document(res["doc_id"])["bank"] == "Fake Bank"
        assert store.search("cut percent")[0]["source"] == "portal:fake"
        html = browser.fetch_document("fake", f"{base}/notes/fx.html", title="FX weekly")
        assert "dollar looks rich" in store.get_document(html["doc_id"], with_text=True)["text"]
        with pytest.raises(browser.PortalError, match="outside"):
            browser.open_page("fake", "https://elsewhere.example.org/x")
        expired = browser.open_page("fake", f"{base}/expired")
        assert expired["login_required"] and "SESSION EXPIRED" in expired["text"]
        assert next(p for p in browser.portal_status() if p["id"] == "fake")["last_status"] == "login required"
    finally:
        browser._worker.run(lambda w: w.close_context())
        server.shutdown()
