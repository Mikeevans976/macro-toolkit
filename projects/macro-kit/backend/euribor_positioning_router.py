"""
Stage 10 — FastAPI router for the Euribor Futures Positioning Tracker.

Mounts at /api/positioning. All endpoints require JWT authentication.
The euribor_positioning package lives one level above this backend directory;
sys.path is patched at import time so the package is importable.
"""

from __future__ import annotations

import sys
from datetime import date
from pathlib import Path
from typing import Optional

# Make the euribor_positioning package importable from the project root
_PKG_ROOT = str(Path(__file__).parent.parent)
if _PKG_ROOT not in sys.path:
    sys.path.insert(0, _PKG_ROOT)

from fastapi import APIRouter, Depends, HTTPException

from auth import get_current_user
from runtime_paths import state_path

# ---------------------------------------------------------------------------
# Package imports
# ---------------------------------------------------------------------------

from euribor_positioning.data.db import (
    connect as _db_connect,
    init_db as _init_db,
    load_params as _load_params,
)
from euribor_positioning.data.contract_calendar import generate_contracts
from euribor_positioning.data.ingest_ice_eod import simulate_eod_data
from euribor_positioning.data.ingest_ice_cot import simulate_cot_data
from euribor_positioning.outputs.dashboard import build_dashboard, panel_contract_history
from euribor_positioning.outputs.diagnostics import (
    diagnostic_estimator_quality,
    diagnostic_price_impact,
)

# ---------------------------------------------------------------------------
# DB path override — the app's DB lives in the runtime state dir (var/)
# ---------------------------------------------------------------------------

_DB_PATH = state_path("euribor_positioning.db", legacy=Path(__file__).parent / "data" / "euribor_positioning.db")


def _get_params() -> dict:
    """Load params and override the database path to the runtime state dir."""
    params = _load_params()
    params["database"]["path"] = str(_DB_PATH)
    return params


def _get_conn():
    return _db_connect(_DB_PATH)


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/api/positioning", tags=["positioning"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _db_status() -> dict:
    """Return DB health metrics. Never raises — DB not existing → initialised=False."""
    if not _DB_PATH.exists():
        return {
            "initialised": False,
            "euribor_contract_count": 0,
            "daily_obs_count": 0,
            "cot_obs_count": 0,
            "date_range": {"start": None, "end": None},
            "last_knowledge_date": None,
        }
    try:
        with _get_conn() as conn:
            contract_count = conn.execute(
                "SELECT COUNT(*) FROM contracts WHERE root = 'FEI'"
            ).fetchone()[0]
            daily_obs = conn.execute(
                "SELECT COUNT(*) FROM daily_obs"
            ).fetchone()[0]
            cot_obs = conn.execute(
                "SELECT COUNT(*) FROM cot_obs"
            ).fetchone()[0]
            dates = conn.execute(
                "SELECT MIN(trade_date), MAX(trade_date) FROM daily_obs"
            ).fetchone()
            date_start = dates[0]
            date_end = dates[1]
            last_kd = conn.execute(
                "SELECT MAX(knowledge_date) FROM daily_obs"
            ).fetchone()[0]
        return {
            "initialised": contract_count > 0,
            "euribor_contract_count": contract_count,
            "daily_obs_count": daily_obs,
            "cot_obs_count": cot_obs,
            "date_range": {"start": date_start, "end": date_end},
            "last_knowledge_date": last_kd,
        }
    except Exception:
        # Tables don't exist yet or other schema issue
        return {
            "initialised": False,
            "euribor_contract_count": 0,
            "daily_obs_count": 0,
            "cot_obs_count": 0,
            "date_range": {"start": None, "end": None},
            "last_knowledge_date": None,
        }


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/status")
def get_status(current_user=Depends(get_current_user)):
    """DB health check."""
    return _db_status()


@router.post("/init")
def initialise_db(current_user=Depends(get_current_user)):
    """
    Initialise DB, seed contracts (FEI 2010–2030), and simulate 2 years of data.
    Idempotent — safe to call repeatedly.
    """
    try:
        import datetime

        params = _get_params()

        # 1. Create schema
        _init_db(_DB_PATH)

        # 2. Seed contracts FEI 2010–2030
        root = params["contracts"]["euribor_root"]
        contracts = generate_contracts(root, 2010, 2030, include_serials=False)
        with _get_conn() as conn:
            conn.executemany(
                """INSERT OR IGNORE INTO contracts
                   (contract_id, root, expiry_date, last_trading_day, contract_type, listing_date)
                   VALUES (:contract_id, :root, :expiry_date, :last_trading_day, :contract_type, :listing_date)""",
                contracts,
            )

        # 3. Simulate 2 years of EOD + COT data
        end_date = datetime.date.today()
        start_date = end_date - datetime.timedelta(days=2 * 365 + 30)

        # Re-seed contracts for the simulation window year range
        sim_contracts = generate_contracts(
            root, start_date.year - 1, end_date.year + 2, include_serials=False
        )
        with _get_conn() as conn:
            conn.executemany(
                """INSERT OR IGNORE INTO contracts
                   (contract_id, root, expiry_date, last_trading_day, contract_type, listing_date)
                   VALUES (:contract_id, :root, :expiry_date, :last_trading_day, :contract_type, :listing_date)""",
                sim_contracts,
            )

        simulate_eod_data(start_date, end_date, sim_contracts, params=params, db_path=_DB_PATH)
        simulate_cot_data(start_date, end_date, params=params, db_path=_DB_PATH)

        status = _db_status()
        return {
            "status": "ok",
            "message": (
                f"DB initialised with {status['euribor_contract_count']} contracts, "
                f"{status['daily_obs_count']} daily obs, "
                f"{status['cot_obs_count']} COT obs."
            ),
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/dashboard")
def get_dashboard(
    as_of: Optional[str] = None,
    instrument: str = "euribor",
    current_user=Depends(get_current_user),
):
    """Full dashboard — all seven panels."""
    status = _db_status()
    if not status["initialised"]:
        return {"error": "not_initialised", "hint": "POST /api/positioning/init"}

    try:
        params = _get_params()

        # Resolve as_of date
        if as_of:
            as_of_date = date.fromisoformat(as_of)
        elif status["last_knowledge_date"]:
            as_of_date = date.fromisoformat(status["last_knowledge_date"])
        else:
            as_of_date = date.today()

        with _get_conn() as conn:
            result = build_dashboard(conn, as_of_date, params, instrument=instrument)
        return result
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/diagnostics")
def get_diagnostics(
    days: int = 252,
    current_user=Depends(get_current_user),
):
    """Estimator quality + price impact diagnostics for the trailing `days` period."""
    status = _db_status()
    if not status["initialised"]:
        return {"error": "not_initialised", "hint": "POST /api/positioning/init"}

    try:
        import datetime

        params = _get_params()
        end_date = date.today()
        start_date = end_date - datetime.timedelta(days=int(days * 1.5))

        with _get_conn() as conn:
            quality = diagnostic_estimator_quality(
                conn, start_date, end_date, end_date, params
            )
            try:
                impact = diagnostic_price_impact(
                    conn, start_date, end_date, end_date, params
                )
            except Exception:
                impact = {}

        return {"estimator_quality": quality, "price_impact": impact}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


_VALID_PANELS = frozenset([
    "dv01_by_bucket",
    "crowding",
    "centre_of_gravity",
    "quadrant_mix",
    "curve_positioning",
    "cot_reconciliation",
    "contract_strip",
])

from euribor_positioning.outputs.dashboard import (
    panel_dv01_by_bucket,
    panel_crowding,
    panel_centre_of_gravity,
    panel_quadrant_mix,
    panel_curve_positioning,
    panel_cot_reconciliation,
    panel_contract_strip,
)

_PANEL_FNS = {
    "dv01_by_bucket":     panel_dv01_by_bucket,
    "crowding":           panel_crowding,
    "centre_of_gravity":  panel_centre_of_gravity,
    "quadrant_mix":       panel_quadrant_mix,
    "curve_positioning":  panel_curve_positioning,
    "cot_reconciliation": panel_cot_reconciliation,
    "contract_strip":     panel_contract_strip,
}


@router.get("/panel/{panel_name}")
def get_panel(
    panel_name: str,
    as_of: Optional[str] = None,
    instrument: str = "euribor",
    current_user=Depends(get_current_user),
):
    """Single panel by name."""
    if panel_name not in _VALID_PANELS:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown panel '{panel_name}'. Valid panels: {sorted(_VALID_PANELS)}",
        )

    status = _db_status()
    if not status["initialised"]:
        return {"error": "not_initialised", "hint": "POST /api/positioning/init"}

    try:
        params = _get_params()

        if as_of:
            as_of_date = date.fromisoformat(as_of)
        elif status["last_knowledge_date"]:
            as_of_date = date.fromisoformat(status["last_knowledge_date"])
        else:
            as_of_date = date.today()

        fn = _PANEL_FNS[panel_name]
        with _get_conn() as conn:
            result = fn(conn, as_of_date, params, instrument=instrument)
        return result
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/contract/{contract_id}")
def get_contract_history(
    contract_id: str,
    instrument: str = "euribor",
    days: int = 252,
    current_user=Depends(get_current_user),
):
    """Time-series history for a single contract (OI, rate, position z-score, quadrant)."""
    status = _db_status()
    if not status["initialised"]:
        return {"error": "not_initialised", "hint": "POST /api/positioning/init"}

    try:
        params = _get_params()

        as_of_date = (
            date.fromisoformat(status["last_knowledge_date"])
            if status["last_knowledge_date"]
            else date.today()
        )

        with _get_conn() as conn:
            result = panel_contract_history(
                conn, as_of_date, params,
                contract_id=contract_id,
                lookback_days=days,
                instrument=instrument,
            )
        return result
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
