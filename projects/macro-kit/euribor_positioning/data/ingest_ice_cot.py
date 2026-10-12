"""
Ingest ICE Commitments of Traders (COT) reports into cot_obs.

COT timing (§8.3):
  report_date      = the Tuesday the positions describe
  publication_date = the following Friday (when data becomes available)

The Kalman filter (Stage 7) applies the measurement on publication_date,
not on report_date. This file enforces that distinction in the schema.

ICE COT file format (typical CSV columns):
  Category, Long, Short, Spreading, Traders, Change_Long, Change_Short
"""

import csv
import datetime
import io
from pathlib import Path

from .db import connect, get_db_path, load_params
from .contract_calendar import cot_publication_date


CATEGORY_ALIASES = {
    "investment firms":              "investment_firms",
    "investment firm":               "investment_firms",
    "asset manager/institutional":   "investment_firms",
    "leveraged funds":               "investment_firms",
    "commercial undertakings":       "commercial",
    "commercial":                    "commercial",
    "producer/merchant/processor/user": "commercial",
    "other financial institutions":  "other_financial",
    "other financial":               "other_financial",
    "other financials":              "other_financial",
    "swap dealers":                  "other_financial",
    "other":                         "other",
    "nonreportable positions":       "other",
}


def _normalise_category(raw: str) -> str | None:
    return CATEGORY_ALIASES.get(raw.strip().lower())


def _sniff_delimiter(line: str) -> str:
    for d in ("|", ",", "\t", ";"):
        if line.count(d) >= 2:
            return d
    return ","


def ingest_cot_file(
    filepath: str | Path,
    report_date: datetime.date | str,
    db_path: str | Path | None = None,
    params: dict | None = None,
) -> dict:
    """
    Parse an ICE COT file and insert into cot_obs.

    Args:
        filepath:    Path to ICE COT CSV file.
        report_date: The Tuesday the positions describe (NOT the publication date).
        db_path:     SQLite database path.

    Returns:
        dict with inserted, updated, skipped, errors counts.
    """
    if params is None:
        params = load_params()
    if db_path is None:
        db_path = get_db_path(params)
    if isinstance(report_date, str):
        report_date = datetime.date.fromisoformat(report_date)

    # report_date must be a Tuesday
    if report_date.weekday() != 1:
        raise ValueError(
            f"report_date must be a Tuesday (weekday=1), got {report_date} (weekday={report_date.weekday()})"
        )

    pub_date = cot_publication_date(report_date)

    text = Path(filepath).read_text()
    lines = [l for l in text.splitlines() if l.strip()]
    if not lines:
        return {"inserted": 0, "updated": 0, "skipped": 0, "errors": ["Empty file"]}

    delim = _sniff_delimiter(lines[0])
    reader = csv.DictReader(io.StringIO(text), delimiter=delim)

    stats = {"inserted": 0, "updated": 0, "skipped": 0, "errors": []}

    with connect(db_path) as conn:
        for row in reader:
            # Normalise keys
            norm = {k.strip().lower().replace(" ", "_"): v for k, v in row.items()}

            # Category
            raw_cat = norm.get("category", norm.get("trader_category", ""))
            category = _normalise_category(raw_cat)
            if category is None:
                stats["skipped"] += 1
                stats["errors"].append(f"Unknown category: {raw_cat!r}")
                continue

            try:
                longs  = int(float(norm.get("long", norm.get("long_positions", 0)) or 0))
                shorts = int(float(norm.get("short", norm.get("short_positions", 0)) or 0))
                spread = int(float(norm.get("spreading", norm.get("spreading_positions", 0)) or 0))
                n_trad = int(float(norm.get("traders", norm.get("number_of_traders", 0)) or 0))
            except (ValueError, KeyError) as e:
                stats["errors"].append(f"{category}: {e}")
                stats["skipped"] += 1
                continue

            existing = conn.execute(
                "SELECT 1 FROM cot_obs WHERE report_date=? AND category=?",
                (report_date.isoformat(), category),
            ).fetchone()

            if existing is None:
                conn.execute(
                    """INSERT INTO cot_obs
                       (report_date, publication_date, category,
                        long_positions, short_positions, spreading, n_traders)
                       VALUES (?,?,?,?,?,?,?)""",
                    (report_date.isoformat(), pub_date.isoformat(),
                     category, longs, shorts, spread, n_trad),
                )
                stats["inserted"] += 1
            else:
                conn.execute(
                    """UPDATE cot_obs SET
                       long_positions=?, short_positions=?, spreading=?, n_traders=?
                       WHERE report_date=? AND category=?""",
                    (longs, shorts, spread, n_trad, report_date.isoformat(), category),
                )
                stats["updated"] += 1

    return stats


def simulate_cot_data(
    start_date: datetime.date,
    end_date: datetime.date,
    params: dict,
    db_path: str | Path | None = None,
    seed: int = 42,
) -> None:
    """Generate synthetic COT data for testing. Inserts one row per category per Tuesday."""
    import numpy as np

    rng = np.random.default_rng(seed)
    if db_path is None:
        db_path = get_db_path(params)

    # Walk Tuesdays in range
    d = start_date
    while d.weekday() != 1:
        d += datetime.timedelta(days=1)

    categories = ["investment_firms", "commercial", "other_financial", "other"]
    base_positions = {
        "investment_firms": 800_000,
        "commercial":       400_000,
        "other_financial":  300_000,
        "other":            100_000,
    }

    with connect(db_path) as conn:
        while d <= end_date:
            pub = cot_publication_date(d)
            for cat in categories:
                base = base_positions[cat]
                noise = rng.normal(0, base * 0.05)
                longs  = int(base / 2 + noise)
                shorts = int(base / 2 - noise * 0.8)
                spread = int(base * 0.15 + rng.normal(0, base * 0.02))
                n_trad = int(rng.integers(40, 120))
                conn.execute(
                    """INSERT OR REPLACE INTO cot_obs
                       (report_date, publication_date, category,
                        long_positions, short_positions, spreading, n_traders)
                       VALUES (?,?,?,?,?,?,?)""",
                    (d.isoformat(), pub.isoformat(), cat, longs, shorts, spread, n_trad),
                )
            d += datetime.timedelta(weeks=1)
