# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Backend
```bash
# Activate venv (always do this first)
source .venv/bin/activate

# Run API server (dev, auto-reload)
uvicorn backend.main:app --reload --port 8000

# Install backend + dev/test dependencies (requirements.txt is fully pinned)
pip install -r backend/requirements-dev.txt

# Change dependencies: edit backend/requirements.in, then regenerate the pins
uv pip compile --universal --python-version 3.13 backend/requirements.in -o backend/requirements.txt

# Run all Python tests from projects/macro-kit/ (backend + Euribor positioning; config in pyproject.toml)
# RUN_SLOW=1 adds the fair-value-models contract case
pytest -q
# Lint Python (config in pyproject.toml)
ruff check .

# After an intentional change to an endpoint's output, refresh the contract snapshots
UPDATE_SNAPSHOTS=1 pytest backend/tests/test_api_contract.py

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
- **Auth**: JWT (8h expiry) + bcrypt. Users live in `var/users.json` — create with `create_user.py`.
- **Runtime state**: `var/` (gitignored; `$MACROKIT_STATE_DIR` overrides) holds `users.json`, the SQLite DBs and the pod sandbox. Resolve paths with `runtime_paths.state_path()`, never next to source.
- **Nav config**: `dashboard_config.yaml` — read on every request, no restart needed.

### Backend modules
| File | Role |
|------|------|
| `main.py` | FastAPI app: middleware, auth routes, router mounting, static file serving |
| `auth.py` | JWT + bcrypt auth |
| `dfm.py` | Mixed-frequency Dynamic Factor Model (Kalman filter/smoother) |
| `regional_heatmap.py` | Shared heatmap engine: DFM, yield PCA, fair value |
| `heatmap_regions.py` | One `HeatmapConfig` per region, keyed by URL slug |
| `heatmap_analytics.py` | Pure maths behind the heatmap page (regimes, scenarios, curve fair value) |
| `routers/` | One `APIRouter` per tool; `agents.py` holds the pod's `/api/agents` and `/api/pod` routes |
| `fair_value_models.py` | Fair value model logic |
| `macro_data_loader.py` | Loads macro series (Bloomberg/Haver) |
| `data_fetcher.py` | Data fetching utilities |
| `global_yields.py` | Global yield curve data |
| `swaps_rv.py` | Swap RV analytics (carry, roll, OIS pricing) |
| `curves_flies_config.py` | Config for curves/flies tool |
| `seasonality_backtester.py` | Seasonality backtest engine |
| `data/series_catalogue_*.json` | Single source of truth for indicator tickers/lags per region |

### Frontend pages
Each page in `frontend/src/pages/` corresponds to a tool tile in the dashboard. Most tool pages fetch from the backend (`/api/tools/...`); the ten regional heatmaps share one page driven entirely by the backend. MacroOptionsMonitor and parts of other pages still generate **deterministic synthetic data** in the browser.

### DFM (Dynamic Factor Model)
`dfm.py` implements a mixed-frequency Kalman filter/smoother. Monthly macro series are observed on the last business day of each month (NaN otherwise); yield PCs are handled in a separate downstream pipeline to avoid circularity. The Euro Area model runs 5 factors × 60 series with block-PCA initialisation.

### Tests
CI (`.github/workflows/macro-kit-ci.yml` at the repo root) runs ruff, both pytest suites, ESLint, Vitest and the frontend build on every PR touching `projects/macro-kit/`.

- `backend/tests/test_analytics.py` — swap RV analytics: hand-computable unit tests, self-consistency checks, end-to-end sanity checks on simulated data.
- `backend/tests/test_api_contract.py` — snapshot of every simulated-data endpoint (digest of keys/lengths/sums in `tests/snapshots/api_contract.json`), with the clock frozen. Any refactor must keep these passing; regenerate only for intentional output changes.
- `backend/tests/test_auth.py` (incl. every API route rejects anonymous requests), `test_agents_api.py` (run ownership, stream tickets, SSE tailing), `test_pod.py`, `euribor_positioning/tests/`.
- `frontend/src/test/pages.smoke.test.tsx` — every page renders with network stubbed.

Simulated data must be deterministic across processes: seed RNGs with `zlib.crc32(name.encode())`, never `hash()` (randomised per process). Format calendar dates with `toLocalISODate` (`frontend/src/lib/dates.ts`), never `toISOString().slice(0, 10)` on local-midnight Dates.

### Routers
New API routes go in `backend/routers/<tool>.py` as an `APIRouter` with Pydantic request models (see `routers/mean_reversion.py`), mounted in `main.py`. CPU-bound handlers are plain `def` (FastAPI runs them in a threadpool) — never `async def` without an `await`.

Agent run streams (`GET /api/agents/stream/{run_id}`) authenticate with a 60 s run-scoped ticket (`POST .../ticket`, see `openRunStream` in `frontend/src/api/client.ts`), never the session token, and tail the `events` table rather than an in-memory queue.

---

## Regional Heatmaps

The backend is the single source of truth: `GET /api/tools/heatmap/{region}` returns every section of the page (indicator z-scores, DFM factors, yield PCA, PC regressions, fair value, curve and breakeven regimes, scenario probabilities). The frontend renders it and does no modelling.

| Layer | File | Notes |
|-------|------|-------|
| Region config | `backend/heatmap_regions.py` | One `HeatmapConfig` per region, keyed by URL slug |
| Series metadata | `backend/data/series_catalogue_<region>.json` | DFM inputs (`dfm_col_index`), `heatmap_group` for the table, tickers/lags |
| Engine | `backend/regional_heatmap.py` | DFM (Kalman), yield PCA, regressions; `get_dashboard()` assembles the page payload |
| Page maths | `backend/heatmap_analytics.py` | Regime classification, look-back tables, dispersion, scenarios, curve fair value (pure, unit tested) |
| API | `backend/routers/heatmaps.py` | `/api/tools/heatmap/{region}` (+ the four single views) |
| Page | `frontend/src/features/heatmap/RegionalHeatmapPage.tsx` | One shared page; sections in `features/heatmap/sections/` |
| Routes | `frontend/src/features/heatmap/regions.ts` | Generates `/tools/{slug}-heatmap` routes in `App.tsx` |

### Adding a region

1. Create `backend/data/series_catalogue_<region>.json` (mirror an existing one: `dfm_col_index` 0..M-1, `dfm_factor`, `dfm_sign`, one `dfm_primary` per factor, `heatmap_group`)
2. Add a `HeatmapConfig` to `REGIONS` in `backend/heatmap_regions.py` (set `real_yield_10y_series_id` if the catalogue has a 10y linker yield; otherwise the breakeven is simulated)
3. Add the slug to `_REGIONS` in `backend/tests/test_api_contract.py` and run with `UPDATE_SNAPSHOTS=1`
4. Add the slug to `frontend/src/features/heatmap/regions.ts`, a flag in `TOOL_FLAG` (`components/Glyph.tsx`) and a tile in `dashboard_config.yaml`

After an intentional change to the dashboard payload, regenerate the frontend test fixture: `cd backend && python scripts/make_heatmap_fixture.py`.

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
