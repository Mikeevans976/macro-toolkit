"""
Where runtime state lives: SQLite DBs, users.json and the pod sandbox.

Everything goes under one gitignored directory, ``var/`` in the project root,
or ``$MACROKIT_STATE_DIR`` if set (e.g. a mounted volume in production).

Installs that predate ``var/`` keep working: if a file still exists at its old
location and not in ``var/``, the old location is used and a warning says how
to move it. Nothing is moved automatically (moving a live SQLite DB under a
running server can corrupt it). An explicit ``$MACROKIT_STATE_DIR`` always
wins: the legacy fallback applies only to the default ``var/`` location, so a
state dir set for tests or a preview never touches the real files.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)

BACKEND_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BACKEND_DIR.parent
_EXPLICIT_STATE_DIR = bool(os.environ.get("MACROKIT_STATE_DIR"))
STATE_DIR = Path(os.environ.get("MACROKIT_STATE_DIR") or PROJECT_ROOT / "var").resolve()


def state_path(name: str, legacy: Path | None = None) -> Path:
    """Path of runtime file/dir ``name`` in STATE_DIR (parent dir created)."""
    new = STATE_DIR / name
    if legacy is not None and not _EXPLICIT_STATE_DIR and legacy.exists() and not new.exists():
        logger.warning("Using legacy runtime path %s; stop the server and move it to %s", legacy, new)
        return legacy
    new.parent.mkdir(parents=True, exist_ok=True)
    return new
