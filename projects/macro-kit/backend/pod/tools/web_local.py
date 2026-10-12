"""
Local web search / fetch, used in place of Anthropic's server tools when an
agent runs on a non-Anthropic model (OpenRouter). Same names, so prompts and
permissions don't change. Not registered in REGISTRY: the runner swaps them in.
"""
import re

import httpx

from pod.tools import Tool, schema

_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
_FETCH_LIMIT = 8000


def web_search(query: str, max_results: int = 6) -> object:
    from duckduckgo_search import DDGS
    with DDGS() as ddgs:
        results = list(ddgs.text(query, max_results=min(max(1, max_results), 10)))
    if not results:
        return f"No results for {query!r}."
    return [{"title": r.get("title"), "url": r.get("href"), "snippet": r.get("body")} for r in results]


def _html_to_text(html: str) -> str:
    html = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r"<(br|p|div|li|h[1-6]|tr)[^>]*>", "\n", html, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", html)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def web_fetch(url: str) -> str:
    if not url.startswith(("http://", "https://")):
        raise ValueError("url must start with http:// or https://")
    r = httpx.get(url, headers={"User-Agent": _UA}, timeout=15, follow_redirects=True)
    r.raise_for_status()
    if "pdf" in r.headers.get("content-type", ""):
        raise ValueError("URL is a PDF; download it with python_sandbox and read it with sandbox_read.")
    text = _html_to_text(r.text)
    return f"[{url}]\n\n" + (text if len(text) <= _FETCH_LIMIT else text[:_FETCH_LIMIT] + "\n[...truncated]")


LOCAL_WEB_TOOLS = {
    "web_search": Tool(
        "web_search", "Search the web (DuckDuckGo). Returns title, URL and snippet per result.",
        schema({"query": {"type": "string"}, "max_results": {"type": "integer", "minimum": 1, "maximum": 10}}, ["query"]),
        web_search,
    ),
    "web_fetch": Tool(
        "web_fetch", "Fetch a web page and return its text (first 8000 characters).",
        schema({"url": {"type": "string"}}, ["url"]),
        web_fetch,
    ),
}
