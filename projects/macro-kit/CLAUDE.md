# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Backend
```bash
# Activate venv (always do this first)
source .venv/bin/activate

# Run API server (dev, auto-reload)
uvicorn backend.main:app --reload --port 8000

# Install backend + dev/test dependencies
pip install -r backend/requirements-dev.txt

# Run backend tests (incl. API contract snapshots; RUN_SLOW=1 adds fair-value-models)
cd backend && pytest -q
# Run Euribor positioning tests (from projects/macro-kit/)
pytest -q euribor_positioning
# Lint Python (from projects/macro-kit/; config in ruff.toml)
ruff check .

# After an intentional change to an endpoint's output, refresh the contract snapshots
cd backend && UPDATE_SNAPSHOTS=1 pytest tests/test_api_contract.py

# Add a user
python backend/create_user.py <username> <password> "<Full Name>"
```

### Frontend
```bash
cd frontend
npm run dev        # Dev server at http://localhost:5173 (proxies /api → :8000)
npm run build      # TypeScript compile + Vite build → frontend/dist/
npm run lint       # ESLint 9 flat config (eslint.config.js); errors fail, warnings are being ratcheted down
npm test           # Vitest: unit tests + smoke-render of every page (src/test/)
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
| `regional_heatmap.py` | Shared heatmap engine: DFM, yield PCA, fair value |
| `heatmap_regions.py` | One `HeatmapConfig` per region, keyed by URL slug |
| `routers/` | Per-tool `APIRouter`s (`heatmaps.py`, `mean_reversion.py`) |
| `fair_value_models.py` | Fair value model logic |
| `macro_data_loader.py` | Loads macro series (Bloomberg/Haver) |
| `data_fetcher.py` | Data fetching utilities |
| `global_yields.py` | Global yield curve data |
| `swaps_rv.py` | Swap RV analytics (carry, roll, OIS pricing) |
| `curves_flies_config.py` | Config for curves/flies tool |
| `seasonality_backtester.py` | Seasonality backtest engine |
| `data/series_catalogue_*.json` | Single source of truth for indicator tickers/lags per region |

### Frontend pages
Each page in `frontend/src/pages/` corresponds to a tool tile in the dashboard. Most tool pages fetch from the backend (`/api/tools/...`); the ten regional heatmaps, MacroOptionsMonitor and parts of other pages still generate **deterministic synthetic data** in the browser (see docs/REFACTOR_PLAN.md, Phase 3).

### DFM (Dynamic Factor Model)
`dfm.py` implements a mixed-frequency Kalman filter/smoother. Monthly macro series are observed on the last business day of each month (NaN otherwise); yield PCs are handled in a separate downstream pipeline to avoid circularity. The Euro Area model runs 5 factors × 60 series with block-PCA initialisation.

### Tests
CI (`.github/workflows/macro-kit-ci.yml` at the repo root) runs ruff, both pytest suites, ESLint, Vitest and the frontend build on every PR touching `projects/macro-kit/`.

- `backend/tests/test_analytics.py` — swap RV analytics: hand-computable unit tests, self-consistency checks, end-to-end sanity checks on simulated data.
- `backend/tests/test_api_contract.py` — snapshot of every simulated-data endpoint (digest of keys/lengths/sums in `tests/snapshots/api_contract.json`), with the clock frozen. Any refactor must keep these passing; regenerate only for intentional output changes.
- `backend/tests/test_auth.py`, `backend/tests/test_pod.py`, `euribor_positioning/tests/`.
- `frontend/src/test/pages.smoke.test.tsx` — every page renders with network stubbed.

Simulated data must be deterministic across processes: seed RNGs with `zlib.crc32(name.encode())`, never `hash()` (randomised per process). Format calendar dates with `toLocalISODate` (`frontend/src/lib/dates.ts`), never `toISOString().slice(0, 10)` on local-midnight Dates.

### Routers
New API routes go in `backend/routers/<tool>.py` as an `APIRouter` with Pydantic request models (see `routers/mean_reversion.py`), mounted in `main.py`. CPU-bound handlers are plain `def` (FastAPI runs them in a threadpool) — never `async def` without an `await`.

---

## Adding a Regional Heatmap (UK pattern)

The Euro Area heatmap (`EuroAreaHeatmap.tsx`) is the reference implementation. The UK heatmap was built by following this pattern.

### Where things live

| Layer | File | Notes |
|-------|------|-------|
| Backend config | `backend/heatmap_regions.py` | One `HeatmapConfig` entry per region (engine: `regional_heatmap.py`) |
| Series metadata | `backend/data/series_catalogue_<region>.json` | Single source of truth for indicator tickers/lags |
| API routes | `backend/routers/heatmaps.py` | Automatic: `/api/tools/heatmap/{region}/{factors,yield-pca,pc-regressions,fair-value}` |
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

Key styling constants (copy exactly): `cardStyle`, `stickyBg = '#07090c'`, z-score color thresholds (dark-ground diverging scale in `zscoreToColors`).


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
2. Add a `HeatmapConfig` entry to `REGIONS` in `backend/heatmap_regions.py` (routes appear automatically)
3. Add the 4 new URLs to `_REGIONS` in `backend/tests/test_api_contract.py` and run with `UPDATE_SNAPSHOTS=1`
4. Add entry in `dashboard_config.yaml` under `macro-fundamentals`
5. Create `frontend/src/pages/<Region>Heatmap.tsx` using the 4-chunk `cat >>` approach
6. Add import + route in `frontend/src/App.tsx`

---

## Visual system

The UI follows a graphite / glacier design system ("calm instrument"). Do not reintroduce Tailwind's saturated defaults.

| Where | What |
|------|------|
| `frontend/src/index.css` | CSS tokens (`--ink-*`, `--fg-*`, `--accent`, `--pos/neg/warn`), `.hub-frame`, `.hub-eyebrow`, `.hub-num`, Recharts overrides |
| `frontend/src/theme.ts` | Same tokens for inline styles / Recharts props, `categoryColor`, `series`, `chart` presets |
| `frontend/tailwind.config.js` | `slate`/`gray` remapped to graphite, `blue`/`sky` to glacier; `ink`, `fg`, `accent`, `pos`, `neg`, `warn`, `hairline` |
| `frontend/src/components/AppShell.tsx` | Fixed left rail (MM monogram, launchpad, ⌘K tool palette, recent tools, sign-out) wrapping every protected route |
| `frontend/src/components/Glyph.tsx` | Monoline icon set; `TOOL_GLYPH` maps tool id → glyph (add new tools here, not emoji in YAML) |

Rules: numbers use Geist Mono (`fontFamily: "'Geist Mono', ui-monospace, monospace"`), text uses Geist; no emoji, glows or scale-on-hover; panel radius 6; colour only where it carries meaning. Pages don't need their own back button — the rail handles navigation. Use hex (not `var()`) in page inline styles, since pages build colours like `` `${c}22` ``.
