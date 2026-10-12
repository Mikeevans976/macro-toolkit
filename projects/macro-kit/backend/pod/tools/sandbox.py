"""
Sandbox tools: files, SQLite and local Python, all confined to
projects/macro-kit/sandbox/. Ported from agents/general_tools.py without the
CrewAI wrappers. Paths that resolve outside the sandbox raise, which the
runner returns to the agent as an error result.
"""
import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

from pod.tools import Tool, register, schema

_BACKEND_DIR = Path(__file__).resolve().parents[2]
SANDBOX_ROOT = (_BACKEND_DIR.parent / "sandbox").resolve()
_READ_LIMIT = 8000


def _safe(raw: str) -> Path:
    resolved = (SANDBOX_ROOT / raw.lstrip("/\\")).resolve()
    try:
        resolved.relative_to(SANDBOX_ROOT)
    except ValueError:
        raise ValueError(f"Path '{raw}' is outside the sandbox. Use paths relative to the sandbox root.")
    return resolved


def sandbox_read(path: str) -> str:
    target = _safe(path)
    if not target.is_file():
        raise FileNotFoundError(f"No file at sandbox/{path}")
    if target.suffix.lower() == ".pdf":
        import pdfplumber
        with pdfplumber.open(str(target)) as pdf:
            text = "\n\n---PAGE BREAK---\n\n".join((p.extract_text() or "") for p in pdf.pages[:20]).strip()
        text = text or "[PDF contained no extractable text]"
    else:
        text = target.read_text(encoding="utf-8", errors="replace")
    return text if len(text) <= _READ_LIMIT else text[:_READ_LIMIT] + f"\n[...truncated at {_READ_LIMIT} chars]"


def sandbox_write(path: str, content: str) -> str:
    target = _safe(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return f"Wrote {len(content)} characters to sandbox/{path}"


def sandbox_edit(path: str, old_text: str, new_text: str) -> str:
    target = _safe(path)
    original = target.read_text(encoding="utf-8", errors="replace")
    count = original.count(old_text)
    if count != 1:
        raise ValueError(f"old_text matches {count} locations in {path}; it must match exactly once.")
    target.write_text(original.replace(old_text, new_text, 1), encoding="utf-8")
    return f"Edited sandbox/{path}"


def sandbox_list(path: str = "") -> str:
    target = _safe(path) if path.strip() else SANDBOX_ROOT
    if not target.is_dir():
        raise NotADirectoryError(f"No directory at sandbox/{path}")
    lines = [f"sandbox/{path}"]
    for entry in sorted(target.iterdir(), key=lambda p: (p.is_file(), p.name)):
        lines.append(f"  {entry.name}/" if entry.is_dir() else f"  {entry.name}  ({entry.stat().st_size:,} B)")
    return "\n".join(lines) if len(lines) > 1 else lines[0] + "\n  (empty)"


def sqlite_sandbox(db_filename: str, sql: str) -> object:
    with sqlite3.connect(str(_safe(db_filename))) as conn:
        conn.row_factory = sqlite3.Row
        cur = conn.execute(sql)
        if cur.description:
            rows = [dict(r) for r in cur.fetchmany(200)]
            return {"rows": rows, "truncated_at_200": len(rows) == 200}
        return f"OK. Rows affected: {cur.rowcount}"


def python_sandbox(code: str) -> str:
    with tempfile.NamedTemporaryFile("w", suffix=".py", dir=SANDBOX_ROOT, delete=False, encoding="utf-8") as f:
        f.write(code)
        script = Path(f.name)
    try:
        result = subprocess.run([sys.executable, str(script)], cwd=SANDBOX_ROOT,
                                capture_output=True, text=True, timeout=60,
                                env={**os.environ, "PYTHONPATH": str(_BACKEND_DIR)})
    except subprocess.TimeoutExpired:
        raise TimeoutError("Python execution timed out after 60 seconds.")
    finally:
        script.unlink(missing_ok=True)
    parts = [result.stdout.strip()]
    if result.stderr.strip():
        parts.append(f"[stderr]\n{result.stderr.strip()}")
    if result.returncode != 0:
        parts.append(f"[exit code {result.returncode}]")
    return "\n\n".join(p for p in parts if p) or "[no output]"


SANDBOX_ROOT.mkdir(parents=True, exist_ok=True)

_path = {"type": "string", "description": "Path relative to the sandbox root"}

register(Tool("sandbox_read", "Read a text or PDF file from the sandbox.",
              schema({"path": _path}, ["path"]), sandbox_read))
register(Tool("sandbox_write", "Create or overwrite a file in the sandbox.",
              schema({"path": _path, "content": {"type": "string"}}, ["path", "content"]),
              sandbox_write, writes=True))
register(Tool("sandbox_edit", "Replace one exact, unique block of text in a sandbox file.",
              schema({"path": _path, "old_text": {"type": "string"}, "new_text": {"type": "string"}},
                     ["path", "old_text", "new_text"]),
              sandbox_edit, writes=True))
register(Tool("sandbox_list", "List files in the sandbox (or a subdirectory).",
              schema({"path": _path}), sandbox_list))
register(Tool("sqlite_sandbox", "Run SQL against a SQLite file in the sandbox (created if missing).",
              schema({"db_filename": {"type": "string"}, "sql": {"type": "string"}}, ["db_filename", "sql"]),
              sqlite_sandbox, writes=True))
register(Tool(
    "python_sandbox",
    "Run Python in a subprocess with the server's environment (pandas, numpy, scipy; the "
    "macro-kit backend modules are importable). Working directory is the sandbox; "
    "60 s timeout. Returns stdout/stderr.",
    schema({"code": {"type": "string"}}, ["code"]),
    python_sandbox,
))
