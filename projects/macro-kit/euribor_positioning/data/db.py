"""Database connection and initialisation helpers."""

import sqlite3
from pathlib import Path
import yaml

_SCHEMA = Path(__file__).parent / "schema.sql"
_PARAMS = Path(__file__).parent.parent / "config" / "params.yaml"


def load_params() -> dict:
    with open(_PARAMS) as f:
        return yaml.safe_load(f)


def get_db_path(params: dict | None = None) -> Path:
    if params is None:
        params = load_params()
    return Path(params["database"]["path"])


def connect(db_path: Path | str | None = None) -> sqlite3.Connection:
    if db_path is None:
        db_path = get_db_path()
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db(db_path: Path | str | None = None) -> None:
    """Create all tables if they do not exist."""
    if db_path is None:
        db_path = get_db_path()
    schema = _SCHEMA.read_text()
    with connect(db_path) as conn:
        conn.executescript(schema)
    print(f"Database initialised at {db_path}")


def next_business_day(date) -> "datetime.date":
    """Return the next business day after date (Mon-Fri, no holiday calendar)."""
    import datetime
    if isinstance(date, str):
        date = datetime.date.fromisoformat(date)
    next_day = date + datetime.timedelta(days=1)
    while next_day.weekday() >= 5:   # 5=Sat, 6=Sun
        next_day += datetime.timedelta(days=1)
    return next_day
