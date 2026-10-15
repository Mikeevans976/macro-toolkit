"""
Tools for Bloomberg data (calendar, news, reference data) and the research
library (search, documents, tracked calls, sweeps, portal browsing).
"""
from pod import bloomberg
from pod.research import browser, ingest, store
from pod.tools import Tool, register, schema

# ── Bloomberg ────────────────────────────────────────────────────────────────

register(Tool(
    name="econ_calendar",
    description=(
        "Bloomberg economic calendar for the tracked releases (pod/econ_universe.yaml): release date/time, "
        "consensus median/high/low, number of forecasts, latest value, relevance. Regions: US, EA, UK, JP "
        "(and any added to the universe). importance 1 = market-moving."
    ),
    input_schema=schema({
        "regions": {"type": "array", "items": {"type": "string"}},
        "days_ahead": {"type": "integer", "minimum": 0, "maximum": 60},
        "days_back": {"type": "integer", "minimum": 0, "maximum": 30},
        "max_importance": {"type": "integer", "enum": [1, 2, 3]},
    }),
    handler=bloomberg.econ_calendar,
    max_chars=9000,
))


def bloomberg_news(query: str = "", hours: int = 24, ticker: str = "", limit: int = 40) -> object:
    items = bloomberg.search_news(query or None, hours, ticker or None, limit)
    if items:
        return items
    st = bloomberg.status()
    if not st["news_items_stored"]:
        raise bloomberg.BloombergNotConnected(
            "No Bloomberg news has been received yet (the B-PIPE news subscriber is not running or not "
            "configured). Use newswires via web_search instead and say so.")
    return f"No Bloomberg headlines match in the last {hours}h."


register(Tool(
    name="bloomberg_news",
    description="Search Bloomberg headlines received via B-PIPE (newest first), by words, look-back hours and ticker.",
    input_schema=schema({
        "query": {"type": "string"},
        "hours": {"type": "integer", "minimum": 1, "maximum": 720},
        "ticker": {"type": "string"},
        "limit": {"type": "integer", "minimum": 1, "maximum": 100},
    }),
    handler=bloomberg_news,
    max_chars=9000,
))


def bloomberg_reference(tickers: list[str], fields: list[str]) -> object:
    if len(tickers) > 50 or len(fields) > 20:
        raise ValueError("At most 50 tickers and 20 fields per call.")
    bloomberg._bbg()
    import bbg
    return bbg.bdp(tickers, fields)


register(Tool(
    name="bloomberg_reference",
    description="Bloomberg reference data (BDP) for up to 50 tickers and 20 fields, e.g. ECO_SURVEY_MEDIAN or PX_LAST.",
    input_schema=schema({
        "tickers": {"type": "array", "items": {"type": "string"}},
        "fields": {"type": "array", "items": {"type": "string"}},
    }, ["tickers", "fields"]),
    handler=bloomberg_reference,
))

# ── research library ─────────────────────────────────────────────────────────


def research_search(query: str, bank: str = "", since_days: int = 0, source: str = "", limit: int = 8) -> object:
    hits = store.search(query, bank=bank or None, since_days=since_days or None, source=source or None, limit=limit)
    return hits or f"No library documents match {query!r}. The library holds {sum(store.stats()['documents_by_status'].values())} documents."


register(Tool(
    name="research_search",
    description=(
        "Full-text search of the sell-side research library (best match first, one hit per document) with "
        "excerpt, bank, date and summary. Filter by bank, recency (since_days) or source (portal, email, upload)."
    ),
    input_schema=schema({
        "query": {"type": "string"},
        "bank": {"type": "string"},
        "since_days": {"type": "integer", "minimum": 0},
        "source": {"type": "string"},
        "limit": {"type": "integer", "minimum": 1, "maximum": 20},
    }, ["query"]),
    handler=research_search,
    max_chars=9000,
))


def research_document(doc_id: int, include_text: bool = True) -> dict:
    return store.get_document(doc_id, with_text=include_text)


register(Tool(
    name="research_document",
    description="One library document: metadata, summary, recorded calls and (by default) its text, up to 12,000 characters.",
    input_schema=schema({"doc_id": {"type": "integer"}, "include_text": {"type": "boolean"}}, ["doc_id"]),
    handler=research_document,
    max_chars=14000,
))


def research_list(status: str = "", bank: str = "", since_days: int = 0, limit: int = 30) -> object:
    return store.list_documents(status or None, bank or None, since_days or None, limit) or "No documents match."


register(Tool(
    name="research_list",
    description="List library documents, newest first. status 'new' = ingested but not yet summarised.",
    input_schema=schema({
        "status": {"type": "string", "enum": ["new", "processed", "failed"]},
        "bank": {"type": "string"},
        "since_days": {"type": "integer", "minimum": 0},
        "limit": {"type": "integer", "minimum": 1, "maximum": 100},
    }),
    handler=research_list,
))


def research_update(doc_id: int, summary: str, tags: list[str], bank: str = "", title: str = "",
                    authors: str = "", published_at: str = "") -> str:
    store.update_document(doc_id, summary=summary, tags=tags, bank=bank or None, title=title or None,
                          authors=authors or None, published_at=published_at or None, status="processed")
    return f"Document #{doc_id} marked processed."


register(Tool(
    name="research_update",
    description=(
        "Record a document's summary (3-6 sentences: main call, reasoning, what changed vs prior views), tags "
        "(markets, regions, themes), and corrected bank/title/authors/published_at (YYYY-MM-DD). Marks it processed."
    ),
    input_schema=schema({
        "doc_id": {"type": "integer"},
        "summary": {"type": "string"},
        "tags": {"type": "array", "items": {"type": "string"}},
        "bank": {"type": "string"},
        "title": {"type": "string"},
        "authors": {"type": "string"},
        "published_at": {"type": "string"},
    }, ["doc_id", "summary", "tags"]),
    handler=research_update,
    writes=True,
))

_CALL = {
    "type": "object",
    "properties": {
        "kind": {"type": "string", "enum": ["forecast", "trade", "view"]},
        "market": {"type": "string", "description": "Normalised key, e.g. 'ECB deposit rate', 'UST 10y', 'EUR 2s10s', 'EURUSD', 'US core PCE YoY'"},
        "target_date": {"type": "string", "description": "e.g. '2027-12-31', 'Q2 2027', 'end-2027'; empty for open views"},
        "value": {"type": "number"},
        "unit": {"type": "string", "description": "%, bp or level"},
        "direction": {"type": "string", "description": "for trades/views: long, short, steepener, higher, lower..."},
        "statement": {"type": "string", "description": "The call in one short sentence, close to the bank's words"},
        "bank": {"type": "string"},
    },
    "required": ["kind", "market", "statement"],
    "additionalProperties": False,
}


def record_research_calls(doc_id: int, calls: list[dict]) -> str:
    n = store.record_calls(doc_id, calls)
    return f"Recorded {n} call(s) from document #{doc_id}."


register(Tool(
    name="record_research_calls",
    description=(
        "Record the forecasts, trade recommendations and directional views in a document, so the pod can track "
        "each bank's calls over time. Use consistent market names across documents."
    ),
    input_schema=schema({"doc_id": {"type": "integer"}, "calls": {"type": "array", "items": _CALL}}, ["doc_id", "calls"]),
    handler=record_research_calls,
    writes=True,
))


def research_calls(market: str = "", bank: str = "", kind: str = "", since_days: int = 365,
                   latest_only: bool = False) -> object:
    rows = store.query_calls(market or None, bank or None, kind or None, since_days or None, latest_only)
    return rows or "No recorded calls match."


register(Tool(
    name="research_calls",
    description=(
        "Tracked sell-side calls: filter by market (e.g. 'ECB deposit rate'), bank, kind and recency. "
        "latest_only=true gives each bank's most recent call per market and target date: the current "
        "street consensus and its dispersion. Without it you see revisions over time."
    ),
    input_schema=schema({
        "market": {"type": "string"},
        "bank": {"type": "string"},
        "kind": {"type": "string", "enum": ["forecast", "trade", "view"]},
        "since_days": {"type": "integer", "minimum": 0},
        "latest_only": {"type": "boolean"},
    }),
    handler=research_calls,
    max_chars=10000,
))

register(Tool(
    name="research_stats",
    description="Library coverage: documents by status, bank and source; number of calls; last sweep of each source.",
    input_schema=schema(),
    handler=store.stats,
))


def research_sweep_inputs() -> dict:
    return {"drop_folder": ingest.sweep_drop_folder(), "email": ingest.sweep_inbox()}


register(Tool(
    name="research_sweep_inputs",
    description="Ingest new research from the drop folder and the research inbox (IMAP). Portals are browsed separately.",
    input_schema=schema(),
    handler=research_sweep_inputs,
    writes=True,
))

# ── portals ──────────────────────────────────────────────────────────────────

register(Tool(
    name="portal_list",
    description="Configured research portals with login status and last sweep.",
    input_schema=schema(),
    handler=browser.portal_status,
))

register(Tool(
    name="portal_open",
    description=(
        "Open a research portal page with the PM's saved session (start page if no url). Returns the page text, "
        "numbered links within the portal (PDFs first) and whether a login is required. Only the portal's "
        "allowed domains can be opened."
    ),
    input_schema=schema({"portal_id": {"type": "string"}, "url": {"type": "string"}}, ["portal_id"]),
    handler=browser.open_page,
    max_chars=12000,
))

register(Tool(
    name="portal_click",
    description="Click the first element showing this text on the portal's current page (menus, tabs, filters, 'next'). Returns the new page.",
    input_schema=schema({"portal_id": {"type": "string"}, "text": {"type": "string"}}, ["portal_id", "text"]),
    handler=browser.click,
    max_chars=12000,
))

register(Tool(
    name="portal_fetch",
    description=(
        "Download a research document (PDF or research page) from a portal with the saved session and add it "
        "to the library. Pass title, bank, authors and published_at (YYYY-MM-DD) when the listing shows them."
    ),
    input_schema=schema({
        "portal_id": {"type": "string"},
        "url": {"type": "string"},
        "title": {"type": "string"},
        "bank": {"type": "string"},
        "authors": {"type": "string"},
        "published_at": {"type": "string"},
    }, ["portal_id", "url"]),
    handler=browser.fetch_document,
    writes=True,
))
