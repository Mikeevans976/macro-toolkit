"""
Bloomberg for the pod: economic calendar and news.

Economic calendar
    One ReferenceDataRequest over the tickers in pod/econ_universe.yaml, using
    the release-date, survey and latest-value fields named there. Verify the
    tickers and fields on the Terminal / with the Bloomberg admin.

News
    Headlines arrive through a B-PIPE subscription and are stored locally
    (var/bloomberg_news.db), so agents can query recent news by text, time and
    ticker. The service, topics and field names depend on the firm's B-PIPE
    news entitlements, so they are configuration, not code:

        BBG_NEWS_SUBSCRIPTIONS   semicolon-separated subscription strings,
                                 exactly as given by the Bloomberg admin
        BBG_NEWS_FIELDS          comma-separated fields to request (optional)
        BBG_NEWS_HEADLINE_FIELDS element names that hold the headline
                                 (default: HEADLINE,STORY_HEADLINE,NEWS_HEADLINE)

    Run the subscriber with `python -m pod.bloomberg news-subscriber`, or set
    BBG_NEWS_AUTOSTART=1 to start it with the API server.

Nothing here has run against a live Bloomberg connection yet.
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import sys
import threading
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

import yaml

from runtime_paths import state_path

logger = logging.getLogger(__name__)

UNIVERSE_FILE = Path(__file__).parent / "econ_universe.yaml"
NEWS_DB = state_path("bloomberg_news.db")


class BloombergNotConnected(RuntimeError):
    pass


def status() -> dict:
    """What is configured and available, without connecting."""
    try:
        import blpapi  # noqa: F401
        installed = True
    except ImportError:
        installed = False
    return {
        "blpapi_installed": installed,
        "host": f"{os.environ.get('BBG_HOST', 'localhost')}:{os.environ.get('BBG_PORT', '8194')}",
        "bpipe_app_auth": bool(os.environ.get("BBG_APP_NAME")),
        "tls": bool(os.environ.get("BBG_TLS_CLIENT_CREDENTIALS")),
        "news_subscriptions_configured": bool(os.environ.get("BBG_NEWS_SUBSCRIPTIONS")),
        "news_subscriber_running": _subscriber_thread is not None and _subscriber_thread.is_alive(),
        "news_items_stored": news_count(),
        "latest_news_at": latest_news_time(),
    }


def _bbg():
    """The bbg module, or a clear error the agent can act on."""
    try:
        import bbg
        bbg._require_blpapi()
        return bbg
    except ImportError as exc:
        raise BloombergNotConnected(
            "Bloomberg is not connected on this server (blpapi missing). Use official release "
            "calendars and newswires via web_search instead, and say so.") from exc


# ── economic calendar ───────────────────────────────────────────────────────

def universe() -> dict:
    return yaml.safe_load(UNIVERSE_FILE.read_text(encoding="utf-8"))


def _parse_date(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value)
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d", "%Y%m%d", "%m/%d/%Y"):
        try:
            return datetime.strptime(text[:19] if "T" in text else text[:10], fmt).isoformat()
        except ValueError:
            continue
    return text


def _future_dates(rows: Any) -> list[str]:
    """Pull every date-like value out of the bulk future-release field, whatever its column names."""
    out = []
    for row in rows or []:
        values = row.values() if isinstance(row, dict) else [row]
        for v in values:
            d = _parse_date(v)
            if d and d[:4].isdigit():
                out.append(d)
    return sorted(set(out))


def build_calendar(raw: dict[str, dict], uni: dict, start: date, end: date) -> list[dict]:
    """Pure: turn bdp output into calendar rows within [start, end]. Separated for testing."""
    f = uni["fields"]
    rows = []
    for region, items in uni["regions"].items():
        for item in items:
            data = raw.get(item["ticker"], {})
            dates = _future_dates(data.get(f["future_release_dates"]))
            last = _parse_date(data.get(f["last_release_date"]))
            candidates = dates + ([last] if last else [])
            for d in candidates:
                day = date.fromisoformat(d[:10])
                if start <= day <= end:
                    rows.append({
                        "release": d, "region": region, "indicator": item["name"], "ticker": item["ticker"],
                        "importance": item.get("importance", 2),
                        "consensus_median": data.get(f["consensus_median"]),
                        "consensus_high": data.get(f["consensus_high"]),
                        "consensus_low": data.get(f["consensus_low"]),
                        "n_forecasts": data.get(f["n_forecasts"]),
                        "latest_value": data.get(f["latest_value"]),
                        "relevance": data.get(f["relevance"]),
                        "errors": data.get("_errors"),
                    })
    return sorted(rows, key=lambda r: (r["release"], r["importance"]))


def econ_calendar(regions: Optional[list[str]] = None, days_ahead: int = 7, days_back: int = 0,
                  max_importance: int = 3) -> dict:
    bbg = _bbg()
    uni = universe()
    if regions:
        uni = {**uni, "regions": {r: v for r, v in uni["regions"].items() if r in regions}}
    uni["regions"] = {r: [i for i in items if i.get("importance", 2) <= max_importance]
                      for r, items in uni["regions"].items()}
    tickers = [i["ticker"] for items in uni["regions"].values() for i in items]
    if not tickers:
        return {"rows": [], "note": "No tickers for that filter in econ_universe.yaml."}
    raw = bbg.bdp(tickers, list(uni["fields"].values()))
    today = date.today()
    rows = build_calendar(raw, uni, today - timedelta(days=days_back), today + timedelta(days=days_ahead))
    return {"source": "bloomberg", "window": [str(today - timedelta(days=days_back)), str(today + timedelta(days=days_ahead))],
            "rows": rows, "universe_size": len(tickers)}


# ── news store ───────────────────────────────────────────────────────────────

def _news_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(NEWS_DB)
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS news_items (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            story_id     TEXT UNIQUE,
            received_at  TEXT NOT NULL,
            published_at TEXT,
            source       TEXT NOT NULL,
            headline     TEXT NOT NULL,
            body         TEXT,
            tickers      TEXT,      -- JSON list
            topics       TEXT,      -- JSON list
            raw          TEXT       -- JSON of the original message
        );
        CREATE INDEX IF NOT EXISTS idx_news_time ON news_items(received_at);
    """)
    return conn


def store_news(item: dict) -> bool:
    """Insert one item; returns False for duplicates (same story_id)."""
    with _news_conn() as conn:
        cur = conn.execute(
            "INSERT OR IGNORE INTO news_items (story_id, received_at, published_at, source, headline, body, "
            "tickers, topics, raw) VALUES (?,?,?,?,?,?,?,?,?)",
            (item.get("story_id"), datetime.now(timezone.utc).isoformat(), item.get("published_at"),
             item.get("source", "bloomberg"), item["headline"], item.get("body"),
             json.dumps(item.get("tickers") or []), json.dumps(item.get("topics") or []),
             json.dumps(item.get("raw"), default=str) if item.get("raw") is not None else None))
        return cur.rowcount == 1


def news_count() -> int:
    with _news_conn() as conn:
        return conn.execute("SELECT COUNT(*) FROM news_items").fetchone()[0]


def latest_news_time() -> Optional[str]:
    with _news_conn() as conn:
        row = conn.execute("SELECT MAX(received_at) FROM news_items").fetchone()
    return row[0] if row else None


def search_news(query: Optional[str] = None, hours: int = 24, ticker: Optional[str] = None,
                limit: int = 40) -> list[dict]:
    since = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    cond, params = ["received_at >= ?"], [since]
    for term in (query or "").split():
        cond.append("(headline LIKE ? OR body LIKE ?)")
        params += [f"%{term}%", f"%{term}%"]
    if ticker:
        cond.append("tickers LIKE ?")
        params.append(f"%{ticker}%")
    with _news_conn() as conn:
        rows = conn.execute(f"SELECT id, story_id, received_at, published_at, source, headline, body, tickers "
                            f"FROM news_items WHERE {' AND '.join(cond)} ORDER BY received_at DESC LIMIT ?",
                            params + [limit]).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["tickers"] = json.loads(d["tickers"] or "[]")
        if d.get("body") and len(d["body"]) > 600:
            d["body"] = d["body"][:600] + "…"
        out.append(d)
    return out


# ── B-PIPE news subscriber ──────────────────────────────────────────────────

_subscriber_thread: Optional[threading.Thread] = None
_HEADLINE_FIELDS = [f.strip() for f in os.environ.get(
    "BBG_NEWS_HEADLINE_FIELDS", "HEADLINE,STORY_HEADLINE,NEWS_HEADLINE").split(",") if f.strip()]


def _find(obj: Any, names: list[str]) -> Any:
    """Depth-first search for the first key in `names` inside nested dicts/lists."""
    if isinstance(obj, dict):
        for n in names:
            if obj.get(n):
                return obj[n]
        for v in obj.values():
            hit = _find(v, names)
            if hit:
                return hit
    elif isinstance(obj, list):
        for v in obj:
            hit = _find(v, names)
            if hit:
                return hit
    return None


def message_to_item(payload: dict, topic: str) -> Optional[dict]:
    """Pure: map one subscription message (as plain Python) to a news item. None if no headline."""
    headline = _find(payload, _HEADLINE_FIELDS)
    if not headline:
        return None
    return {
        "story_id": str(_find(payload, ["STORY_ID", "SUID", "NEWS_STORY_ID", "ID_BB_NEWS"]) or "") or None,
        "published_at": _find(payload, ["TIME_OF_ARRIVAL", "PUBLISHED_AT", "TIME", "DATE_TIME"]),
        "source": "bloomberg",
        "headline": str(headline),
        "body": _find(payload, ["BODY", "STORY_BODY", "SUMMARY"]),
        "tickers": _find(payload, ["TICKERS", "SECURITIES", "ASSOCIATED_TICKERS"]) or [],
        "topics": [topic],
        "raw": payload,
    }


def run_news_subscriber(stop: Optional[threading.Event] = None) -> None:
    """Blocking loop: subscribe to BBG_NEWS_SUBSCRIPTIONS and store every headline."""
    subs = [s.strip() for s in os.environ.get("BBG_NEWS_SUBSCRIPTIONS", "").split(";") if s.strip()]
    if not subs:
        raise BloombergNotConnected("BBG_NEWS_SUBSCRIPTIONS is not set; ask the Bloomberg admin for the news "
                                    "subscription strings your B-PIPE entitlements allow.")
    bbg = _bbg()
    import blpapi
    fields = [f.strip() for f in os.environ.get("BBG_NEWS_FIELDS", "").split(",") if f.strip()]
    session = bbg.open_session()
    try:
        sub_list = blpapi.SubscriptionList()
        for i, topic in enumerate(subs):
            sub_list.add(topic, fields or None, None, blpapi.CorrelationId(i))
        session.subscribe(sub_list)
        logger.info("Bloomberg news: subscribed to %d topic(s)", len(subs))
        while not (stop and stop.is_set()):
            event = session.nextEvent(1000)
            if event.eventType() != blpapi.Event.SUBSCRIPTION_DATA:
                for msg in event:
                    if event.eventType() == blpapi.Event.SUBSCRIPTION_STATUS:
                        logger.info("Bloomberg news status: %s", msg)
                continue
            for msg in event:
                topic = subs[msg.correlationId().value()] if msg.correlationId().value() < len(subs) else "?"
                item = message_to_item(bbg.element_to_python(msg.asElement()), topic)
                if item:
                    store_news(item)
    finally:
        session.stop()


def start_news_subscriber_thread() -> Optional[threading.Thread]:
    """Start the subscriber in the background if configured (BBG_NEWS_AUTOSTART=1)."""
    global _subscriber_thread
    if os.environ.get("BBG_NEWS_AUTOSTART") != "1" or not os.environ.get("BBG_NEWS_SUBSCRIPTIONS"):
        return None

    def loop():
        try:
            run_news_subscriber()
        except Exception:
            logger.exception("Bloomberg news subscriber stopped")

    _subscriber_thread = threading.Thread(target=loop, daemon=True, name="bbg-news")
    _subscriber_thread.start()
    return _subscriber_thread


if __name__ == "__main__":
    if sys.argv[1:] == ["news-subscriber"]:
        logging.basicConfig(level=logging.INFO)
        run_news_subscriber()
    else:
        print("usage: python -m pod.bloomberg news-subscriber")
