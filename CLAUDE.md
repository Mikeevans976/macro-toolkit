# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Backend
```bash
# Activate venv (always do this first)
source .venv/bin/activate

# Run API server (dev, auto-reload)
uvicorn backend.main:app --reload --port 8000

# Run backend tests
cd backend && pytest tests/test_analytics.py -v

# Add a user
python backend/create_user.py <username> <password> "<Full Name>"
```

### Frontend
```bash
cd frontend
npm run dev        # Dev server at http://localhost:5173 (proxies /api → :8000)
npm run build      # TypeScript compile + Vite build → frontend/dist/
npm run lint       # ESLint (0 max-warnings)
```

**Always run `cd frontend && npm run build` after modifying any `.tsx` file** — TypeScript errors are only caught at build time.

### Production
```bash
cd frontend && npm run build && cd .. && python backend/main.py
# Serves API + built frontend at http://localhost:8000
```

---

## Architecture

### Stack
- **Backend**: FastAPI + Python, Uvicorn. Runs on port 8000.
- **Frontend**: React + Vite + TypeScript + Tailwind CSS. Dev server on port 5173; proxies `/api` to backend.
- **Auth**: JWT (8h expiry) + bcrypt. `users.json` is gitignored — create with `create_user.py`.
- **Nav config**: `dashboard_config.yaml` — read on every request, no restart needed.

### Backend modules
| File | Role |
|------|------|
| `main.py` | FastAPI app, all API routes, static file serving |
| `auth.py` | JWT + bcrypt auth |
| `dfm.py` | Mixed-frequency Dynamic Factor Model (Kalman filter/smoother) |
| `euro_area_heatmap.py` | DFM, PCA, fair value, API functions for Euro Area |
| `uk_heatmap.py` | Same for UK |
| `fair_value_models.py` | Fair value model logic |
| `macro_data_loader.py` | Loads macro series (Bloomberg/Haver) |
| `data_fetcher.py` | Data fetching utilities |
| `global_yields.py` | Global yield curve data |
| `swaps_rv.py` | Swap RV analytics (carry, roll, OIS pricing) |
| `curves_flies_config.py` | Config for curves/flies tool |
| `seasonality_backtester.py` | Seasonality backtest engine |
| `data/series_catalogue_*.json` | Single source of truth for indicator tickers/lags per region |

### Frontend pages
Each page in `frontend/src/pages/` corresponds to a tool tile in the dashboard. Pages are self-contained; most use **deterministic synthetic data** (no live API calls) for rendering. Backend API calls are made only by a few pages (e.g. SwapsRV, SeasonalityBacktester).

### DFM (Dynamic Factor Model)
`dfm.py` implements a mixed-frequency Kalman filter/smoother. Monthly macro series are observed on the last business day of each month (NaN otherwise); yield PCs are handled in a separate downstream pipeline to avoid circularity. The Euro Area model runs 5 factors × 60 series with block-PCA initialisation.

### Tests
Backend tests live in `backend/tests/`. `test_analytics.py` covers swap RV analytics with three layers: unit tests with hand-computable answers, self-consistency checks, and end-to-end sanity checks on simulated data. Run with `pytest`.

---

## Adding a Regional Heatmap (UK pattern)

The Euro Area heatmap (`EuroAreaHeatmap.tsx`) is the reference implementation. The UK heatmap was built by following this pattern.

### Where things live

| Layer | File | Notes |
|-------|------|-------|
| Backend model | `backend/<region>_heatmap.py` | DFM, PCA, fair value, API functions |
| Series metadata | `backend/data/series_catalogue_<region>.json` | Single source of truth for indicator tickers/lags |
| API routes | `backend/main.py` | 4 endpoints wired per region |
| Frontend page | `frontend/src/pages/<Region>Heatmap.tsx` | Self-contained, synthetic data (no live API calls) |
| Routing | `frontend/src/App.tsx` | One route entry per region |
| Nav config | `dashboard_config.yaml` | Tool entry under `macro-fundamentals` category |

### Frontend page structure

Each regional heatmap page is a single self-contained `.tsx` file (~1,200 lines). All sections are pure computation + recharts rendering:

1. **Imports + Types** — `Indicator`, `Group`
2. **Date columns** — `generateMonths()` → 25 months Jun '23–Jun '25
3. **Z-score generator** — deterministic sin/cos with per-indicator seeds
4. **`GROUPS_META`** — hardcoded indicator metadata (name, latest, units, z-score params)
5. **Gilt/Bund yields** — synthetic monthly yield arrays per tenor
6. **Jacobi PCA** — in-browser PCA on the yield matrix
7. **Color helpers + Legend + HeatmapTable** — reusable across regions
8. **DFM factors** — `computeFactor()` averages z-scores across indicator groups
9. **OLS helpers** — `matInv`, `ols` for PC regressions
10. **`YieldPCChart`** — PC1/PC2/PC3 line charts + loadings table
11. **`PCRegressionSection`** — OLS of yield PCs on macro factors
12. **`[Region]FairValueSection`** — fair value via PCA inversion + rich/cheap chart
13. **`CurveDynamicsSection`** — 2s10s daily directionality (63-day rolling)
14. **`BEDynamicsSection`** — 10y breakeven regime analysis
15. **Main page component** — header, nav, sections composed together

Key styling constants (copy exactly): `cardStyle`, `stickyBg = '#080d1a'`, z-score color thresholds.

### UK vs Euro Area differences

| | Euro Area | UK |
|--|-----------|-----|
| Yield tenors | 2/3/5/7/10/15/20/30y (8) | 2/5/10/20/30y (5) |
| Central bank | ECB (DFR) | BoE Bank Rate |
| Benchmark bond | Bund | Gilt |
| Benchmark rate | EURIBOR / ESTR | SONIA |
| FX | EUR/USD | GBP/USD, GBP/EUR |
| Equity | EuroStoxx 50 | FTSE 100, FTSE 250 |
| Inflation measure | HICP | CPI / CPIH / RPI |

### Critical implementation note — output token limit

**`EuroAreaHeatmap.tsx` is 3,441 lines. Writing any regional heatmap in a single `Write` call will fail** — Claude Code's output is capped at 32,000 tokens.

**The fix: build the file with multiple `cat >>` bash appends, each ~600 lines:**

```bash
cat > frontend/src/pages/UKHeatmap.tsx << 'EOF'
# Part 1: imports, types, data, HeatmapTable
EOF

cat >> frontend/src/pages/UKHeatmap.tsx << 'EOF'
# Part 2: DFM, OLS, YieldPCChart, PCRegressionSection
EOF

cat >> frontend/src/pages/UKHeatmap.tsx << 'EOF'
# Part 3: fair value, curve dynamics
EOF

cat >> frontend/src/pages/UKHeatmap.tsx << 'EOF'
# Part 4: BE dynamics, main page component
EOF
```

Use single-quoted `'EOF'` to prevent shell variable/dollar-sign expansion in JSX/TypeScript.

### Adding another region (e.g. US, Japan)

1. Create `backend/data/series_catalogue_<region>.json` — mirror the UK schema
2. Create `backend/<region>_heatmap.py` — copy `uk_heatmap.py`, adapt series/tickers
3. Wire 4 routes in `backend/main.py`
4. Add entry in `dashboard_config.yaml` under `macro-fundamentals`
5. Create `frontend/src/pages/<Region>Heatmap.tsx` using the 4-chunk `cat >>` approach
6. Add import + route in `frontend/src/App.tsx`
