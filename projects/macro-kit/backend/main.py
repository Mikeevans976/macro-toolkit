import logging
import threading
from contextlib import asynccontextmanager
from datetime import timedelta
from pathlib import Path

import yaml
from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.security import OAuth2PasswordRequestForm
from fastapi.staticfiles import StaticFiles

# First: loads the .env files and validates configuration (fails fast in prod).
from settings import settings

# No-op if the host (e.g. a configured uvicorn/gunicorn) already set up logging.
logging.basicConfig(
    level=settings.log_level,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("analytics_hub")

from auth import (
    ACCESS_TOKEN_EXPIRE_HOURS,
    authenticate_user,
    bootstrap_admin,
    create_access_token,
    get_current_user,
    login_limiter,
)

# Create admin user from env vars on first deploy (no-op if users.json exists)
bootstrap_admin()

from agents.storage import init_db

init_db()

from bbg import BloombergUnavailable
from schemas.auth import Me, Token
from fair_value_models import get_fair_value_models_data  # startup warm-up
from euribor_positioning_router import router as positioning_router
from routers import (
    agents,
    correlation_regimes,
    egb_rv,
    fair_value_models,
    fitted_bond_curves,
    global_yields,
    heatmaps,
    inflation_fixings,
    inflation_pca,
    mean_reversion,
    momentum,
    option_cdf,
    pca_analysis,
    print_analysis,
    seasonality,
    swaps_rv,
)



@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Fair Value Models takes ~20 s to compute and is cached in-process; warm it
    # in the background so the first visitor after a restart doesn't wait.
    # Set PRECOMPUTE_ON_STARTUP=0 to skip (e.g. while iterating with --reload).
    if settings.precompute_on_startup:
        def _warm() -> None:
            try:
                get_fair_value_models_data()
                logger.info("Fair Value Models cache warmed")
            except Exception:
                logger.exception("Fair Value Models warm-up failed; will compute on first request")
        threading.Thread(target=_warm, name="fvm-warmup", daemon=True).start()
    yield


app = FastAPI(title="Analytics Hub API", version="1.0.0", lifespan=lifespan)

# Compress large JSON payloads (Fair Value Models ~12 MB -> ~1.4 MB). Starlette
# skips text/event-stream, so agent SSE streams are not buffered.
app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=5)



@app.exception_handler(BloombergUnavailable)
def _bloomberg_unavailable(_request, exc: BloombergUnavailable):
    # Live-only endpoints (e.g. seasonality data) when no Bloomberg connection exists.
    return JSONResponse(status_code=503, content={
        "detail": "Bloomberg data is not available on this server (blpapi not installed / Terminal not running)."})


# Include routers
app.include_router(positioning_router)
for _tool in (
    agents,
    correlation_regimes,
    egb_rv,
    fair_value_models,
    fitted_bond_curves,
    global_yields,
    heatmaps,
    inflation_fixings,
    inflation_pca,
    mean_reversion,
    momentum,
    option_cdf,
    pca_analysis,
    print_analysis,
    seasonality,
    swaps_rv,
):
    app.include_router(_tool.router)

# CORS for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
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


@app.post("/api/auth/login", response_model=Token)
def login(request: Request, form_data: OAuth2PasswordRequestForm = Depends()):
    # Failed attempts are limited per client IP and per username (auth.LoginRateLimiter).
    keys = (f"ip:{request.client.host if request.client else 'unknown'}",
            f"user:{form_data.username.strip().lower()}")
    wait = login_limiter.retry_after(*keys)
    if wait:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Too many failed login attempts. Try again in {wait} seconds.",
            headers={"Retry-After": str(wait)},
        )
    user = authenticate_user(form_data.username, form_data.password)
    if not user:
        login_limiter.record_failure(*keys)
        logger.warning("Failed login for %r from %s", form_data.username, keys[0][3:])
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    login_limiter.reset(keys[1])
    access_token = create_access_token(
        data={"sub": user["username"]},
        expires_delta=timedelta(hours=ACCESS_TOKEN_EXPIRE_HOURS),
    )
    return {"access_token": access_token, "token_type": "bearer"}


# ---------------------------------------------------------------------------
# Protected API routes (tool routes live in routers/)
# ---------------------------------------------------------------------------


@app.get("/api/me", response_model=Me)
def read_me(current_user: dict = Depends(get_current_user)):
    return {
        "username": current_user["username"],
        "full_name": current_user.get("full_name", ""),
    }


@app.get("/api/dashboard")
def get_dashboard(current_user: dict = Depends(get_current_user)):
    config = load_dashboard_config()
    return config


# ---------------------------------------------------------------------------
# Serve React build (static files) — mount last so API routes take priority
# ---------------------------------------------------------------------------

FRONTEND_DIST = Path(__file__).parent.parent / "frontend" / "dist"

if FRONTEND_DIST.exists():
    # Serve static assets (JS, CSS, images) first
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIST / "assets")), name="assets")

    # Catch-all: serve index.html for any non-API path so React Router handles routing
    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str):
        index = FRONTEND_DIST / "index.html"
        return FileResponse(str(index))


if __name__ == "__main__":
    import uvicorn

    port = settings.port
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
