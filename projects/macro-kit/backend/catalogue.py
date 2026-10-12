"""
Catalogue loading with a verified-ticker overlay.

Why this exists
---------------
Two folders hold catalogue data and they play different roles:

  backend/data/                            — structural source of truth.
      Complete series lists, contiguous dfm_col_index 0..m_macro-1, dfm_factor,
      dfm_sign and dfm_primary. The heatmap engine validates all of this strictly,
      so it must come from here.

  backend/data_new_tickers/                — verified vendor tickers.
      The subset of series whose Bloomberg/Haver tickers have actually been
      confirmed against the terminal. Structurally incomplete (sparse
      dfm_col_index, missing dfm_primary), so it cannot be read on its own.

read_catalogue() merges the two: structure from data/, tickers from the verified
folder. A series absent from the verified folder has its tickers set to None, so
live mode never requests an unconfirmed ticker — a wrong-but-valid ticker returns
the wrong series silently, which is worse than no series at all. Series with no
ticker are skipped by data_fetcher and left as NaN columns for the Kalman filter,
which is a supported path.

Point VERIFIED_TICKER_DIR at a new folder as more tickers are confirmed:

    $env:ANALYTICS_VERIFIED_TICKER_DIR = "C:\\...\\backend\\data_new_tickers_20261001"

Set it to the string "none" to disable the overlay and use data/ tickers as-is.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

_BACKEND = Path(__file__).parent

_DEFAULT_VERIFIED_DIR = _BACKEND / "data_new_tickers"

_env_dir = os.environ.get("ANALYTICS_VERIFIED_TICKER_DIR", "").strip()
if _env_dir.lower() in ("none", "off", "0"):
    VERIFIED_TICKER_DIR: Path | None = None
elif _env_dir:
    VERIFIED_TICKER_DIR = Path(_env_dir)
else:
    VERIFIED_TICKER_DIR = _DEFAULT_VERIFIED_DIR

# Fail loudly on a missing folder. Silently skipping the overlay would fall back
# to the unverified tickers in data/, many of which return no data at all — the
# exact outcome this module exists to prevent. Set the env var to "none" to
# disable the overlay on purpose.
if VERIFIED_TICKER_DIR is not None and not VERIFIED_TICKER_DIR.is_dir():
    raise FileNotFoundError(
        f"verified-ticker folder not found: {VERIFIED_TICKER_DIR}\n"
        "Point ANALYTICS_VERIFIED_TICKER_DIR at the folder holding the confirmed "
        'tickers, or set it to "none" to use the tickers in data/ as-is.'
    )

_TICKER_FIELDS = ("ticker_bloomberg", "ticker_haver")

# filename -> (kept, nulled), populated as catalogues load. Read by
# overlay_report() for a startup summary.
_STATS: dict[str, tuple[int, int]] = {}


def read_catalogue(path: str | Path) -> dict:
    """
    Load a catalogue JSON, overlaying verified tickers when available.

    Only entries under the top-level "series" key that use the
    id / ticker_bloomberg / ticker_haver schema are touched; every other key and
    field is passed through untouched, so structural metadata is preserved.

    Falls back to returning the file unchanged when no verified counterpart
    exists, so an unrecognised catalogue still loads exactly as before.
    """
    path = Path(path)
    raw = json.loads(path.read_text(encoding="utf-8"))

    if VERIFIED_TICKER_DIR is None:
        return raw

    verified_path = VERIFIED_TICKER_DIR / path.name
    if not verified_path.exists():
        return raw

    verified = json.loads(verified_path.read_text(encoding="utf-8"))
    by_id = {
        e["id"]: e
        for e in verified.get("series", [])
        if isinstance(e, dict) and e.get("id")
    }
    if not by_id:
        # Nothing verified for this catalogue (e.g. an empty work-in-progress
        # file) — leave the structural tickers alone rather than blanking them.
        return raw

    kept = nulled = 0
    for entry in raw.get("series", []):
        if not isinstance(entry, dict) or not entry.get("id"):
            continue
        if not any(f in entry for f in _TICKER_FIELDS):
            continue
        match = by_id.get(entry["id"])
        for field in _TICKER_FIELDS:
            if field not in entry:
                continue
            value = match.get(field) if match else None
            entry[field] = value
            if value:
                kept += 1
            elif match is None:
                nulled += 1

    _STATS[path.name] = (kept, nulled)
    return raw


def overlay_report() -> str:
    """One-line-per-catalogue summary of what the overlay did."""
    if VERIFIED_TICKER_DIR is None:
        return "verified-ticker overlay: disabled"
    lines = [f"verified-ticker overlay from {VERIFIED_TICKER_DIR.name}:"]
    for name in sorted(_STATS):
        kept, nulled = _STATS[name]
        lines.append(f"  {name:34s} {kept:4d} verified tickers, {nulled:4d} unverified nulled")
    return "\n".join(lines)
