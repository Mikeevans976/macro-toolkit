import os
from datetime import timedelta
from pathlib import Path

import yaml
from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordRequestForm
from fastapi.staticfiles import StaticFiles

from auth import (
    ACCESS_TOKEN_EXPIRE_HOURS,
    authenticate_user,
    create_access_token,
    get_current_user,
)
from swaps_rv import compute_rv
from global_yields import get_global_yields_data
from fair_value_models import get_fair_value_models_data
from euro_area_heatmap import (
    get_daily_factors,
    get_fair_value,
    get_yield_pca,
    get_pc_regressions,
)

app = FastAPI(title="Analytics Hub API", version="1.0.0")

# CORS for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173",
                   "http://localhost:5174", "http://127.0.0.1:5174"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Path to dashboard config (project root, one level above backend/)
CONFIG_PATH = Path(__file__).parent.parent / "dashboard_config.yaml"


def load_dashboard_config() -> dict:
    if not CONFIG_PATH.exists():
        raise HTTPException(
            status_code=500,
            detail=f"Dashboard config not found at {CONFIG_PATH}",
        )
    with open(CONFIG_PATH, "r") as f:
        return yaml.safe_load(f)


# ---------------------------------------------------------------------------
# Auth routes
# ---------------------------------------------------------------------------


@app.post("/api/auth/login")
async def login(form_data: OAuth2PasswordRequestForm = Depends()):
    user = authenticate_user(form_data.username, form_data.password)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    access_token = create_access_token(
        data={"sub": user["username"]},
        expires_delta=timedelta(hours=ACCESS_TOKEN_EXPIRE_HOURS),
    )
    return {"access_token": access_token, "token_type": "bearer"}


# ---------------------------------------------------------------------------
# Protected API routes
# ---------------------------------------------------------------------------


@app.get("/api/me")
async def read_me(current_user: dict = Depends(get_current_user)):
    return {
        "username": current_user["username"],
        "full_name": current_user.get("full_name", ""),
    }


@app.get("/api/dashboard")
async def get_dashboard(current_user: dict = Depends(get_current_user)):
    config = load_dashboard_config()
    return config


@app.get("/api/tools/euro-area-heatmap/factors")
async def ea_daily_factors(current_user: dict = Depends(get_current_user)):
    """Daily macro factor estimates from the mixed-frequency DFM (Block 1)."""
    return get_daily_factors()


@app.get("/api/tools/euro-area-heatmap/yield-pca")
async def ea_yield_pca(current_user: dict = Depends(get_current_user)):
    """Daily Bund yield PC scores, loadings and explained variance (Block 2)."""
    return get_yield_pca()


@app.get("/api/tools/euro-area-heatmap/pc-regressions")
async def ea_pc_regressions(current_user: dict = Depends(get_current_user)):
    """OLS regression of Bund yield PCs on macro factors (no intercept)."""
    return get_pc_regressions()


@app.get("/api/tools/euro-area-heatmap/fair-value")
async def ea_fair_value(current_user: dict = Depends(get_current_user)):
    """Daily 10y Bund: actual, PCA reconstruction, macro fair value, rich/cheap."""
    return get_fair_value()


@app.get("/api/tools/global-yields")
async def global_yields(current_user: dict = Depends(get_current_user)):
    """PCA factor model on global 10y yields: factors, residuals, fair-value table."""
    return get_global_yields_data()


@app.get("/api/tools/fair-value-models")
async def fair_value_models(current_user: dict = Depends(get_current_user)):
    """Rolling Elastic Net fair value models for HICPxT inflation swaps."""
    return get_fair_value_models_data()


@app.get("/api/tools/swaps-rv")
async def get_swaps_rv(
    date: str | None = None,
    current_user: dict = Depends(get_current_user),
):
    return compute_rv(as_of_date=date)


# ---------------------------------------------------------------------------
# Serve React build (static files) — mount last so API routes take priority
# ---------------------------------------------------------------------------

FRONTEND_DIST = Path(__file__).parent.parent / "frontend" / "dist"

if FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIST), html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
