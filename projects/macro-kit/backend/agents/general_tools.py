"""
General-purpose agent tools.

All file, directory, and database operations are sandboxed to SANDBOX_ROOT.
Any attempt to read or write outside that directory raises an error —
the agent sees the error message and cannot proceed outside the boundary.

Tools
-----
SandboxFileReadTool     — read any file under SANDBOX_ROOT (text + PDF)
SandboxFileWriteTool    — write / overwrite a file under SANDBOX_ROOT
SandboxFileEditTool     — targeted patch (old_text → new_text) in a sandbox file
SandboxDirectoryTool    — list contents of SANDBOX_ROOT or a subdirectory
SandboxSQLiteTool       — run SQL against a .db file under SANDBOX_ROOT
PythonCodeTool          — execute Python code in a subprocess (cwd=SANDBOX_ROOT)
WebSearchTool           — DuckDuckGo search, returns top results as plain text
WebFetchTool            — fetch a URL and return readable text
"""
import re
import sqlite3
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path
from typing import Optional, Type

import httpx
from crewai.tools import BaseTool
from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Sandbox root
# ---------------------------------------------------------------------------

SANDBOX_ROOT = Path(
    "/Users/gerardo/projects/Team-Massimo-Marzeglia-Analytics"
    "/projects/macro-kit/sandbox"
).resolve()

SANDBOX_ROOT.mkdir(parents=True, exist_ok=True)


def _safe(raw: str) -> Path:
    """
    Resolve *raw* relative to SANDBOX_ROOT and verify it stays inside.
    Raises ValueError if the path would escape the sandbox.
    """
    # Strip leading slashes so absolute paths become relative
    clean = raw.lstrip("/\\")
    resolved = (SANDBOX_ROOT / clean).resolve()
    try:
        resolved.relative_to(SANDBOX_ROOT)
    except ValueError:
        raise ValueError(
            f"Path '{raw}' resolves outside the sandbox ({SANDBOX_ROOT}). "
            "Only paths under the sandbox directory are permitted."
        )
    return resolved


# ---------------------------------------------------------------------------
# Input schemas
# ---------------------------------------------------------------------------

class _PathInput(BaseModel):
    path: str = Field(
        description="Relative path inside the sandbox, e.g. 'report.txt' or 'data/prices.csv'."
    )

class _WriteInput(BaseModel):
    path: str = Field(description="Relative path inside the sandbox.")
    content: str = Field(description="Full text content to write to the file.")

class _EditInput(BaseModel):
    path: str = Field(description="Relative path inside the sandbox.")
    old_text: str = Field(description="Exact text to find and replace. Must be unique in the file.")
    new_text: str = Field(description="Replacement text.")

class _SQLInput(BaseModel):
    db_filename: str = Field(
        description="SQLite database filename inside the sandbox, e.g. 'analysis.db'."
    )
    sql: str = Field(description="SQL statement to execute (SELECT, INSERT, CREATE, …).")

class _CodeInput(BaseModel):
    code: str = Field(description="Python code to execute. Working directory is the sandbox.")

class _SearchInput(BaseModel):
    query: str = Field(description="Search query string.")
    max_results: int = Field(default=6, description="Number of results to return (max 10).")

class _FetchInput(BaseModel):
    url: str = Field(description="Full URL to fetch, e.g. 'https://example.com/article'.")


# ---------------------------------------------------------------------------
# Tool 1: SandboxFileReadTool
# ---------------------------------------------------------------------------

class SandboxFileReadTool(BaseTool):
    name: str = "Sandbox File Reader"
    description: str = (
        "Reads a file inside the sandbox and returns its contents as text. "
        "Supports plain text files (.txt, .csv, .md, .json, .py, etc.) and PDFs. "
        "Use this to inspect data files, reports, or code inside the sandbox."
    )
    args_schema: Type[BaseModel] = _PathInput

    def _run(self, path: str) -> str:
        try:
            target = _safe(path)
        except ValueError as e:
            return f"[SANDBOX ERROR] {e}"

        if not target.exists():
            return f"[ERROR] File not found: {path}"
        if not target.is_file():
            return f"[ERROR] '{path}' is a directory, not a file. Use Sandbox Directory Lister instead."

        suffix = target.suffix.lower()

        # PDF via pdfplumber
        if suffix == ".pdf":
            try:
                import pdfplumber
                with pdfplumber.open(str(target)) as pdf:
                    pages = [p.extract_text() or "" for p in pdf.pages[:20]]
                text = "\n\n---PAGE BREAK---\n\n".join(pages).strip()
                if len(text) > 8000:
                    text = text[:8000] + "\n\n[…truncated at 8000 chars]"
                return text or "[PDF contained no extractable text]"
            except Exception as exc:
                return f"[PDF ERROR] {exc}"

        # Plain text
        try:
            raw = target.read_text(encoding="utf-8", errors="replace")
        except Exception as exc:
            return f"[READ ERROR] {exc}"

        if len(raw) > 8000:
            raw = raw[:8000] + "\n\n[…truncated at 8000 chars]"
        return raw


# ---------------------------------------------------------------------------
# Tool 2: SandboxFileWriteTool
# ---------------------------------------------------------------------------

class SandboxFileWriteTool(BaseTool):
    name: str = "Sandbox File Writer"
    description: str = (
        "Creates or overwrites a file inside the sandbox with the given content. "
        "Parent directories are created automatically. "
        "Use this to save analysis results, reports, or data files."
    )
    args_schema: Type[BaseModel] = _WriteInput

    def _run(self, path: str, content: str) -> str:
        try:
            target = _safe(path)
        except ValueError as e:
            return f"[SANDBOX ERROR] {e}"

        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
            return f"[OK] Written {len(content)} characters to sandbox/{path}"
        except Exception as exc:
            return f"[WRITE ERROR] {exc}"


# ---------------------------------------------------------------------------
# Tool 3: SandboxFileEditTool
# ---------------------------------------------------------------------------

class SandboxFileEditTool(BaseTool):
    name: str = "Sandbox File Editor"
    description: str = (
        "Makes a targeted edit to an existing file in the sandbox by replacing "
        "an exact block of text with new text. "
        "The old_text must match exactly (including whitespace). "
        "Use this to update specific sections of a file without rewriting it entirely."
    )
    args_schema: Type[BaseModel] = _EditInput

    def _run(self, path: str, old_text: str, new_text: str) -> str:
        try:
            target = _safe(path)
        except ValueError as e:
            return f"[SANDBOX ERROR] {e}"

        if not target.exists():
            return f"[ERROR] File not found: {path}"

        try:
            original = target.read_text(encoding="utf-8", errors="replace")
        except Exception as exc:
            return f"[READ ERROR] {exc}"

        count = original.count(old_text)
        if count == 0:
            return f"[ERROR] old_text not found in {path}. Check for exact whitespace/newline match."
        if count > 1:
            return f"[ERROR] old_text matches {count} locations in {path}. Provide more context to make it unique."

        updated = original.replace(old_text, new_text, 1)
        try:
            target.write_text(updated, encoding="utf-8")
            return f"[OK] Edit applied to sandbox/{path}"
        except Exception as exc:
            return f"[WRITE ERROR] {exc}"


# ---------------------------------------------------------------------------
# Tool 4: SandboxDirectoryTool
# ---------------------------------------------------------------------------

class SandboxDirectoryTool(BaseTool):
    name: str = "Sandbox Directory Lister"
    description: str = (
        "Lists the contents of the sandbox directory (or a subdirectory within it). "
        "Shows files and folders with sizes. "
        "Use this to discover what files are available before reading or editing them."
    )
    args_schema: Type[BaseModel] = _PathInput

    def _run(self, path: str = "") -> str:
        try:
            target = _safe(path) if path.strip() else SANDBOX_ROOT
        except ValueError as e:
            return f"[SANDBOX ERROR] {e}"

        if not target.exists():
            return f"[ERROR] Path not found: {path or '(sandbox root)'}"
        if not target.is_dir():
            return f"[ERROR] '{path}' is a file, not a directory."

        lines = [f"Contents of sandbox/{path or ''}:"]
        entries = sorted(target.iterdir(), key=lambda p: (p.is_file(), p.name))
        for entry in entries:
            if entry.is_dir():
                lines.append(f"  📁  {entry.name}/")
            else:
                size = entry.stat().st_size
                size_str = f"{size:,} B" if size < 1024 else f"{size/1024:.1f} KB"
                lines.append(f"  📄  {entry.name}  ({size_str})")
        if len(lines) == 1:
            lines.append("  (empty)")
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Tool 5: SandboxSQLiteTool
# ---------------------------------------------------------------------------

class SandboxSQLiteTool(BaseTool):
    name: str = "Sandbox SQLite Tool"
    description: str = (
        "Executes SQL against a SQLite database file inside the sandbox. "
        "Supports SELECT, INSERT, UPDATE, DELETE, CREATE TABLE, etc. "
        "The database file is created automatically if it does not exist. "
        "Returns query results as a formatted table."
    )
    args_schema: Type[BaseModel] = _SQLInput

    def _run(self, db_filename: str, sql: str) -> str:
        try:
            db_path = _safe(db_filename)
        except ValueError as e:
            return f"[SANDBOX ERROR] {e}"

        try:
            conn = sqlite3.connect(str(db_path))
            conn.row_factory = sqlite3.Row
            cur = conn.cursor()
            cur.execute(sql)

            if cur.description:
                cols = [d[0] for d in cur.description]
                rows = cur.fetchmany(200)
                conn.commit()
                conn.close()

                col_widths = [max(len(c), max((len(str(r[c])) for r in rows), default=0)) for c in cols]
                sep = "-+-".join("-" * w for w in col_widths)
                header = " | ".join(c.ljust(col_widths[i]) for i, c in enumerate(cols))
                lines = [header, sep]
                for row in rows:
                    lines.append(" | ".join(str(row[c]).ljust(col_widths[i]) for i, c in enumerate(cols)))
                if len(rows) == 200:
                    lines.append("[…truncated at 200 rows]")
                return "\n".join(lines)
            else:
                conn.commit()
                conn.close()
                return f"[OK] Query executed. Rows affected: {cur.rowcount}"

        except sqlite3.Error as exc:
            return f"[SQL ERROR] {exc}"
        except Exception as exc:
            return f"[ERROR] {exc}"


# ---------------------------------------------------------------------------
# Tool 6: PythonCodeTool
# ---------------------------------------------------------------------------

_PYTHON = sys.executable  # same interpreter as the running server


class PythonCodeTool(BaseTool):
    name: str = "Python Code Executor"
    description: str = (
        "Executes Python code in a subprocess. "
        "The working directory is the sandbox, so relative file paths land there. "
        "stdout and stderr are returned. Timeout: 60 seconds. "
        "All standard library modules and installed packages (pandas, numpy, etc.) are available. "
        "Use this for data analysis, calculations, chart generation, or file processing."
    )
    args_schema: Type[BaseModel] = _CodeInput

    def _run(self, code: str) -> str:
        # Write code to a temp file inside the sandbox so imports from
        # relative paths resolve correctly
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", dir=str(SANDBOX_ROOT),
            delete=False, encoding="utf-8"
        ) as f:
            f.write(code)
            tmp_path = Path(f.name)

        try:
            result = subprocess.run(
                [_PYTHON, str(tmp_path)],
                cwd=str(SANDBOX_ROOT),
                capture_output=True,
                text=True,
                timeout=60,
            )
            output_parts = []
            if result.stdout.strip():
                output_parts.append(result.stdout.strip())
            if result.stderr.strip():
                output_parts.append(f"[stderr]\n{result.stderr.strip()}")
            if result.returncode != 0:
                output_parts.append(f"[exit code {result.returncode}]")
            return "\n\n".join(output_parts) if output_parts else "[No output]"
        except subprocess.TimeoutExpired:
            return "[ERROR] Code execution timed out after 60 seconds."
        except Exception as exc:
            return f"[ERROR] {exc}"
        finally:
            tmp_path.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Tool 7: WebSearchTool
# ---------------------------------------------------------------------------

class WebSearchTool(BaseTool):
    name: str = "Web Search"
    description: str = (
        "Searches the web via DuckDuckGo and returns the top results as plain text. "
        "Each result includes the title, URL, and a short snippet. "
        "Use this to look up current events, data, documentation, or any public information."
    )
    args_schema: Type[BaseModel] = _SearchInput

    def _run(self, query: str, max_results: int = 6) -> str:
        try:
            from duckduckgo_search import DDGS
            max_results = min(max(1, max_results), 10)
            with DDGS() as ddgs:
                results = list(ddgs.text(query, max_results=max_results))

            if not results:
                return f"No results found for: {query}"

            lines = [f"Web search results for: {query}\n"]
            for i, r in enumerate(results, 1):
                lines.append(f"{i}. {r.get('title', 'No title')}")
                lines.append(f"   {r.get('href', '')}")
                snippet = r.get("body", "")
                if snippet:
                    lines.append(f"   {textwrap.shorten(snippet, width=200)}")
                lines.append("")
            return "\n".join(lines)
        except Exception as exc:
            return f"[SEARCH ERROR] {exc}"


# ---------------------------------------------------------------------------
# Tool 8: WebFetchTool
# ---------------------------------------------------------------------------

_HTML_TAG_RE = re.compile(r"<[^>]+>")
_WHITESPACE_RE = re.compile(r"\n{3,}")


def _html_to_text(html: str) -> str:
    """Very light HTML stripper — no external dep required."""
    # Remove scripts and styles entirely
    html = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", html, flags=re.DOTALL | re.IGNORECASE)
    # Replace block elements with newlines
    html = re.sub(r"<(br|p|div|li|h[1-6]|tr)[^>]*>", "\n", html, flags=re.IGNORECASE)
    # Strip remaining tags
    text = _HTML_TAG_RE.sub("", html)
    # Collapse whitespace
    text = _WHITESPACE_RE.sub("\n\n", text)
    return text.strip()


class WebFetchTool(BaseTool):
    name: str = "Web Page Fetcher"
    description: str = (
        "Fetches the content of a URL and returns it as readable plain text. "
        "HTML tags are stripped; only the text content is returned. "
        "Use this to read a specific article, documentation page, or data source after finding it via Web Search."
    )
    args_schema: Type[BaseModel] = _FetchInput

    def _run(self, url: str) -> str:
        try:
            headers = {
                "User-Agent": (
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/120.0.0.0 Safari/537.36"
                )
            }
            response = httpx.get(url, headers=headers, timeout=15, follow_redirects=True)
            response.raise_for_status()

            content_type = response.headers.get("content-type", "")
            if "pdf" in content_type:
                return "[ERROR] URL points to a PDF. Download it to the sandbox and use Sandbox File Reader instead."

            text = _html_to_text(response.text)
            if len(text) > 8000:
                text = text[:8000] + "\n\n[…truncated at 8000 chars]"
            return f"[{url}]\n\n{text}"
        except httpx.HTTPStatusError as exc:
            return f"[HTTP ERROR] {exc.response.status_code} — {url}"
        except httpx.RequestError as exc:
            return f"[REQUEST ERROR] {exc}"
        except Exception as exc:
            return f"[ERROR] {exc}"


# ---------------------------------------------------------------------------
# Convenience export: all general tools as instances
# ---------------------------------------------------------------------------

ALL_GENERAL_TOOLS = [
    SandboxFileReadTool(),
    SandboxFileWriteTool(),
    SandboxFileEditTool(),
    SandboxDirectoryTool(),
    SandboxSQLiteTool(),
    PythonCodeTool(),
    WebSearchTool(),
    WebFetchTool(),
]
