import os
from datetime import timedelta
from pathlib import Path

import yaml
from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
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
from uk_heatmap import (
    get_uk_daily_factors,
    get_uk_fair_value,
    get_uk_yield_pca,
    get_uk_pc_regressions,
)
from us_heatmap import (
    get_us_daily_factors,
    get_us_fair_value,
    get_us_yield_pca,
    get_us_pc_regressions,
)
from japan_heatmap import (
    get_jp_daily_factors,
    get_jp_fair_value,
    get_jp_yield_pca,
    get_jp_pc_regressions,
)
from canada_heatmap import (
    get_ca_daily_factors,
    get_ca_fair_value,
    get_ca_yield_pca,
    get_ca_pc_regressions,
)
from sweden_heatmap import (
    get_se_daily_factors,
    get_se_fair_value,
    get_se_yield_pca,
    get_se_pc_regressions,
)
from norway_heatmap import (
    get_no_daily_factors,
    get_no_fair_value,
    get_no_yield_pca,
    get_no_pc_regressions,
)
from switzerland_heatmap import (
    get_ch_daily_factors,
    get_ch_fair_value,
    get_ch_yield_pca,
    get_ch_pc_regressions,
)
from australia_heatmap import (
    get_au_daily_factors,
    get_au_fair_value,
    get_au_yield_pca,
    get_au_pc_regressions,
)
from new_zealand_heatmap import (
    get_nz_daily_factors,
    get_nz_fair_value,
    get_nz_yield_pca,
    get_nz_pc_regressions,
)
from seasonality_backtester import (
    fetch_bbg_expression,
    get_seasonality_stats,
    get_seasonality_heatmap,
    run_seasonality_backtest,
)
from print_analysis import fetch_print_vs_consensus, fetch_market_reaction
from momentum import compute_cta_signals

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


@app.get("/api/tools/uk-heatmap/factors")
async def uk_daily_factors(current_user: dict = Depends(get_current_user)):
    """Daily macro factor estimates from the UK mixed-frequency DFM (Block 1)."""
    return get_uk_daily_factors()


@app.get("/api/tools/uk-heatmap/yield-pca")
async def uk_yield_pca(current_user: dict = Depends(get_current_user)):
    """Daily Gilt yield PC scores, loadings and explained variance (Block 2)."""
    return get_uk_yield_pca()


@app.get("/api/tools/uk-heatmap/pc-regressions")
async def uk_pc_regressions(current_user: dict = Depends(get_current_user)):
    """OLS regression of Gilt yield PCs on UK macro factors (no intercept)."""
    return get_uk_pc_regressions()


@app.get("/api/tools/uk-heatmap/fair-value")
async def uk_fair_value(current_user: dict = Depends(get_current_user)):
    """Daily 10y Gilt: actual, PCA reconstruction, macro fair value, rich/cheap."""
    return get_uk_fair_value()


@app.get("/api/tools/us-heatmap/factors")
async def us_daily_factors(current_user: dict = Depends(get_current_user)):
    """Daily macro factor estimates from the US mixed-frequency DFM (Block 1)."""
    return get_us_daily_factors()


@app.get("/api/tools/us-heatmap/yield-pca")
async def us_yield_pca(current_user: dict = Depends(get_current_user)):
    """Daily UST yield PC scores, loadings and explained variance (Block 2)."""
    return get_us_yield_pca()


@app.get("/api/tools/us-heatmap/pc-regressions")
async def us_pc_regressions(current_user: dict = Depends(get_current_user)):
    """OLS regression of UST yield PCs on US macro factors (no intercept)."""
    return get_us_pc_regressions()


@app.get("/api/tools/us-heatmap/fair-value")
async def us_fair_value(current_user: dict = Depends(get_current_user)):
    """Daily 10y UST: actual, PCA reconstruction, macro fair value, rich/cheap."""
    return get_us_fair_value()


@app.get("/api/tools/japan-heatmap/factors")
async def jp_daily_factors(current_user: dict = Depends(get_current_user)):
    """Daily macro factor estimates from the Japan mixed-frequency DFM (Block 1)."""
    return get_jp_daily_factors()


@app.get("/api/tools/japan-heatmap/yield-pca")
async def jp_yield_pca(current_user: dict = Depends(get_current_user)):
    """Daily JGB yield PC scores, loadings and explained variance (Block 2)."""
    return get_jp_yield_pca()


@app.get("/api/tools/japan-heatmap/pc-regressions")
async def jp_pc_regressions(current_user: dict = Depends(get_current_user)):
    """OLS regression of JGB yield PCs on Japan macro factors (no intercept)."""
    return get_jp_pc_regressions()


@app.get("/api/tools/japan-heatmap/fair-value")
async def jp_fair_value(current_user: dict = Depends(get_current_user)):
    """Daily 10y JGB: actual, PCA reconstruction, macro fair value, rich/cheap."""
    return get_jp_fair_value()


@app.get("/api/tools/canada-heatmap/factors")
async def ca_daily_factors(current_user: dict = Depends(get_current_user)):
    return get_ca_daily_factors()

@app.get("/api/tools/canada-heatmap/yield-pca")
async def ca_yield_pca(current_user: dict = Depends(get_current_user)):
    return get_ca_yield_pca()

@app.get("/api/tools/canada-heatmap/pc-regressions")
async def ca_pc_regressions(current_user: dict = Depends(get_current_user)):
    return get_ca_pc_regressions()

@app.get("/api/tools/canada-heatmap/fair-value")
async def ca_fair_value(current_user: dict = Depends(get_current_user)):
    return get_ca_fair_value()


@app.get("/api/tools/sweden-heatmap/factors")
async def se_daily_factors(current_user: dict = Depends(get_current_user)):
    return get_se_daily_factors()

@app.get("/api/tools/sweden-heatmap/yield-pca")
async def se_yield_pca(current_user: dict = Depends(get_current_user)):
    return get_se_yield_pca()

@app.get("/api/tools/sweden-heatmap/pc-regressions")
async def se_pc_regressions(current_user: dict = Depends(get_current_user)):
    return get_se_pc_regressions()

@app.get("/api/tools/sweden-heatmap/fair-value")
async def se_fair_value(current_user: dict = Depends(get_current_user)):
    return get_se_fair_value()


@app.get("/api/tools/norway-heatmap/factors")
async def no_daily_factors(current_user: dict = Depends(get_current_user)):
    return get_no_daily_factors()

@app.get("/api/tools/norway-heatmap/yield-pca")
async def no_yield_pca(current_user: dict = Depends(get_current_user)):
    return get_no_yield_pca()

@app.get("/api/tools/norway-heatmap/pc-regressions")
async def no_pc_regressions(current_user: dict = Depends(get_current_user)):
    return get_no_pc_regressions()

@app.get("/api/tools/norway-heatmap/fair-value")
async def no_fair_value(current_user: dict = Depends(get_current_user)):
    return get_no_fair_value()


@app.get("/api/tools/switzerland-heatmap/factors")
async def ch_daily_factors(current_user: dict = Depends(get_current_user)):
    return get_ch_daily_factors()

@app.get("/api/tools/switzerland-heatmap/yield-pca")
async def ch_yield_pca(current_user: dict = Depends(get_current_user)):
    return get_ch_yield_pca()

@app.get("/api/tools/switzerland-heatmap/pc-regressions")
async def ch_pc_regressions(current_user: dict = Depends(get_current_user)):
    return get_ch_pc_regressions()

@app.get("/api/tools/switzerland-heatmap/fair-value")
async def ch_fair_value(current_user: dict = Depends(get_current_user)):
    return get_ch_fair_value()


@app.get("/api/tools/australia-heatmap/factors")
async def au_daily_factors(current_user: dict = Depends(get_current_user)):
    return get_au_daily_factors()

@app.get("/api/tools/australia-heatmap/yield-pca")
async def au_yield_pca(current_user: dict = Depends(get_current_user)):
    return get_au_yield_pca()

@app.get("/api/tools/australia-heatmap/pc-regressions")
async def au_pc_regressions(current_user: dict = Depends(get_current_user)):
    return get_au_pc_regressions()

@app.get("/api/tools/australia-heatmap/fair-value")
async def au_fair_value(current_user: dict = Depends(get_current_user)):
    return get_au_fair_value()


@app.get("/api/tools/new-zealand-heatmap/factors")
async def nz_daily_factors(current_user: dict = Depends(get_current_user)):
    return get_nz_daily_factors()

@app.get("/api/tools/new-zealand-heatmap/yield-pca")
async def nz_yield_pca(current_user: dict = Depends(get_current_user)):
    return get_nz_yield_pca()

@app.get("/api/tools/new-zealand-heatmap/pc-regressions")
async def nz_pc_regressions(current_user: dict = Depends(get_current_user)):
    return get_nz_pc_regressions()

@app.get("/api/tools/new-zealand-heatmap/fair-value")
async def nz_fair_value(current_user: dict = Depends(get_current_user)):
    return get_nz_fair_value()


@app.get("/api/tools/global-yields")
async def global_yields(current_user: dict = Depends(get_current_user)):
    """PCA factor model on global 10y yields: factors, residuals, fair-value table."""
    return get_global_yields_data()


@app.get("/api/tools/fair-value-models")
async def fair_value_models(current_user: dict = Depends(get_current_user)):
    """Rolling Elastic Net fair value models for HICPxT inflation swaps."""
    return get_fair_value_models_data()


@app.get("/api/tools/seasonality/data")
async def seasonality_data(
    expression: str,
    start: str = "2010-01-01",
    current_user: dict = Depends(get_current_user),
):
    """
    Fetch and evaluate a Bloomberg expression, returning a daily time series.
    expression examples:
      'GDBR10 Index'
      'GDBR10 Index - GDBR2 Index'
      'GDBR30 Index - 2 * GDBR10 Index + GDBR2 Index'
    """
    return fetch_bbg_expression(expression, start=start)


@app.post("/api/tools/seasonality/stats")
async def seasonality_stats(
    payload: dict,
    current_user: dict = Depends(get_current_user),
):
    """Seasonal statistics across all dimensions for a fetched time series."""
    dates  = payload["dates"]
    values = payload["values"]
    return get_seasonality_stats(dates, values)


@app.post("/api/tools/seasonality/heatmap")
async def seasonality_heatmap(
    payload: dict,
    current_user: dict = Depends(get_current_user),
):
    """Month × day-of-week mean return matrix."""
    dates  = payload["dates"]
    values = payload["values"]
    return get_seasonality_heatmap(dates, values)


@app.post("/api/tools/seasonality/backtest")
async def seasonality_backtest(
    payload: dict,
    current_user: dict = Depends(get_current_user),
):
    """Run a seasonality-driven backtest given a rule definition."""
    dates  = payload["dates"]
    values = payload["values"]
    rule   = payload.get("rule", {"type": "dow", "bins": [0], "direction": 1})
    return run_seasonality_backtest(dates, values, rule)


@app.get("/api/tools/print-analysis/print-vs-consensus")
async def print_vs_consensus(
    ticker: str,
    start: str = "2010-01-01",
    current_user: dict = Depends(get_current_user),
):
    """
    Fetch historical economic prints + Bloomberg survey consensus for a ticker.
    ticker: Bloomberg ticker with yellow key, e.g. "UKPRIC YOY Index"
    """
    return fetch_print_vs_consensus(ticker=ticker, start=start)


@app.post("/api/tools/print-analysis/market-reaction")
async def market_reaction(
    payload: dict,
    current_user: dict = Depends(get_current_user),
):
    """
    Compute day-of-release market moves for a given instrument.
    payload: { market_ticker: str, releases: [{period, release_date, surprise}] }
    """
    return fetch_market_reaction(
        market_ticker=payload["market_ticker"],
        releases=payload.get("releases", []),
    )


@app.get("/api/tools/momentum/cta-signals")
async def cta_signals(
    ticker: str,
    start: str = "2010-01-01",
    current_user: dict = Depends(get_current_user),
):
    return compute_cta_signals(ticker=ticker, start=start)


@app.get("/api/tools/swaps-rv")
async def get_swaps_rv(
    date: str | None = None,
    currency: str = "EUR",
    current_user: dict = Depends(get_current_user),
):
    return compute_rv(currency=currency, as_of_date=date)


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

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
