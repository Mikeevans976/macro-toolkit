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
- **Settings**: `backend/settings.py` loads `.env` (project root or `backend/`) and validates every setting once; import it, don't read `os.environ` directly. `MACROKIT_ENV=prod` requires `SECRET_KEY`. All variables are listed in `.env.example`.
- **Auth**: JWT (8h expiry) + bcrypt, failed logins rate-limited per IP and per username (429). Users live in `var/users.json` — create with `create_user.py`.
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
| `macro_options.py` | Euribor options for the Macro Options Monitor: chains, smile fit + call grid, €STR OIS meeting path, open interest |
| `nowcast.py` | Quant Macro engine: mixed-frequency DFM (statsmodels `DynamicFactorMQ`), quarterly moments, news/weights, survey bridge |
| `quant_macro.py` | Quant Macro models (`MODELS`), saved fits and background jobs (update / refit / backtest), payload (quarters, next print, evolution, catalysts, central bank) and the real-time backtest |
| `vintages.py` | Quant Macro real-time data: SQLite vintage store (`var/quant_macro/vintages.db`), ONS revisions triangles, source assembly |
| `curves_flies_config.py` | Config for curves/flies tool |
| `seasonality_backtester.py` | Seasonality backtest engine |
| `data/series_catalogue_*.json` | Single source of truth for indicator tickers/lags per region |

### Frontend pages
Each page in `frontend/src/pages/` corresponds to a tool tile in the dashboard. Most tool pages fetch from the backend (`/api/tools/...`); the 30 regional heatmaps (10 DM, 20 EM) share one page driven entirely by the backend. Parts of some pages still generate **deterministic synthetic data** in the browser. The Macro Options Monitor (`features/macro-options/`) reads Euribor option chains from `backend/macro_options.py` (live, or a past day's settlement) and only falls back to its in-browser simulation without Bloomberg.

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
New API routes go in `backend/routers/<tool>.py` as an `APIRouter` with Pydantic request models (see `routers/mean_reversion.py`), mounted in `main.py`.

Response models live in `backend/schemas/` (`response_model=` on the route); the frontend's API types are generated from them. After changing a response model: `cd backend && python scripts/export_openapi.py`, then `cd frontend && npm run gen:api`, and use the types from `src/api/schema.ts` (see `features/heatmap/types.ts`). A backend test and a CI step fail when either file is stale. Typed so far: heatmaps and auth; the other tool routes and the pod routes still return untyped dicts. CPU-bound handlers are plain `def` (FastAPI runs them in a threadpool) — never `async def` without an `await`.

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

30 regions: 10 DM (`bloc="dm"`, "Macro Fundamentals") and 20 EM (`bloc="em"`, "EM Macro Fundamentals": Mexico, China, India, Brazil, South Korea, South Africa, Poland, Indonesia, Hungary, Czech Republic, Romania, Turkey, Israel, Chile, Colombia, Peru, Thailand, Malaysia, Philippines, Taiwan; see `docs/EM_HEATMAPS_PLAN.md`). The engine is generic over:
- **Factor set** (`HeatmapConfig.factors`): "Global Macro" first, then one per catalogue `dfm_factor` group. DM uses Growth/Inflation/Employment/Wages; EM regions swap in `External` (trade, reserves, REER) or `Credit` (China) where labour data are thin. Every group needs exactly one `dfm_primary`.
- **Curve legs** (`short_tenor`, `long_tenor` = fair-value tenor, `ultra_tenor` or None): regime names (`3s10s`…) and the fair-value table follow them.
- **Breakeven** (`breakeven=False` → no section, scenarios from the curve only; else `breakeven_10y_series_id` (quoted) or `real_yield_10y_series_id` (nominal − real), falling back to simulated).
- **Live window**: simulated data use the fixed 2023-06 → 2025-06 grid; live data the last `LIVE_YEARS` (5) years. Live macro needs every primary + 75% of series with data; dead series are dropped and listed in `data_source.missing_series`.
- **Catalogue `transform`**: `yoy`, `diff_yoy`, `sum12` (monthly flows, e.g. net jobs), applied after fetching.

EM curves use Bloomberg BVAL constant-maturity curves (`BV{tenor}{curve} BVLI Index`); EM "generic" tickers (`G…YR Index`) have multi-month gaps.

### Adding a region

1. Create `backend/data/series_catalogue_<region>.json` (mirror an existing one: `dfm_col_index` 0..M-1, `dfm_factor`, `dfm_sign`, one `dfm_primary` per factor, `heatmap_group`, optional `transform`). Check every ticker on the Terminal: `cd backend && python scripts/probe_catalogue.py data/series_catalogue_<region>.json`
2. Add a `HeatmapConfig` to `REGIONS` in `backend/heatmap_regions.py` (EM regions: the `_em(...)` helper)
3. Add the slug to `_REGIONS` in `backend/tests/test_api_contract.py` and run with `UPDATE_SNAPSHOTS=1` (add `-k heatmap` to refresh only heatmap entries; the updater merges per key)
4. Add the slug, `bloc` and ISO `country` code to `frontend/src/features/heatmap/regions.ts` (and the flag import in `components/CountryFlag.tsx`), a tile in `dashboard_config.yaml` and the region code in `pod/tools/analytics.py`

After an intentional change to the dashboard payload, regenerate the frontend test fixtures (UK = DM shape, China = EM shape): `cd backend && python scripts/make_heatmap_fixture.py`.

---

## Quant Macro

Nowcasts and forecasts of growth, inflation and labour-market variables per G10 market: the next print, the current and next quarters, and the central bank's own staff estimates alongside. One page (`frontend/src/features/quant-macro/NowcastPage.tsx`) driven by `GET /api/tools/quant-macro/{model}`. Nothing heavy runs on a page load: the parameters are saved (`var/quant_macro/<slug>/model.json`) and only re-estimated by `POST .../{model}/refit` (the page's Refit button) or when no saved fit matches the data (first run, a change of data source or series list). New data go through the saved parameters in a background `update` job (on a new day; hourly with live data). The real-time backtest runs only on `POST .../{model}/backtest` (Run full backtest, ~5–10 min, background); `GET .../backtest` returns the last saved run or null, and `GET .../status` the fit/run times and job progress.

| Layer | File | Notes |
|-------|------|-------|
| Engine | `backend/nowcast.py` | Bańbura–Modugno DFM (Global + Soft/Real/Labour blocks, AR(1) idiosyncratics, EM). Quarterly growth = (g_t + 2g_t-1 + 3g_t-2 + 2g_t-3 + g_t-4)/3 of the monthly target; its variance uses smoothed cross-month covariances. News and weights from statsmodels `news()` |
| Models | `backend/quant_macro.py` | `MODELS` (one `NowcastSpec` per market × variable); state under `var/quant_macro/` (`ROOT` overrides it in tests) |
| Vintages | `backend/vintages.py` | Every value with the day it became public. Sources per series (catalogue `vintages`): ONS revisions triangles (`ONS_DATASETS`, link read from the dataset page each day), Bloomberg first print (`ACTUAL_RELEASE`) + latest after `settle_days`, daily snapshots from the first live run; surveys unrevised |
| Panel | `backend/data/series_catalogue_nowcast_<cc>.json` | id, blocks, group, transform (`none`/`diff`/`log_diff`), `release_lag_days`, `vintages` (ONS dataset, settle days, simulated revision size), simulation DGP |
| Central bank | `backend/data/central_bank_nowcasts_<cc>.json` | Staff estimates entered by hand from the bank's publications, with URL; mark implied values in `note` |
| Page | `frontend/src/features/quant-macro/` | `models.ts` generates `/tools/{toolId}` routes; fixtures from `backend/scripts/make_nowcast_fixture.py` |

Vintages are real-time: `Panel.vintage(d)` rebuilds the data as published on day d, first prints and revisions included; values are stored in ticker units and transformed per vintage. News splits each change into releases (weight × surprise), revisions (weight × revision) and grouped older revisions, and adds up exactly. The backtest re-estimates on the first day of each calendar quarter with that day's data and scores against the first estimate (and today's value). ONS monthly GDP vintages start in July 2018 (monthly GDP did not exist before), retail sales in 2020 and RTI payrolls in Dec 2019; earlier periods use the Bloomberg fallback. An ONS series whose values disagree with the Bloomberg ticker is ignored (units check). Live data need the target and 60% of the panel, else the payload falls back to simulation and lists `missing_series`. 2020-03 to 2021-06 is treated as missing. Back up `var/quant_macro/vintages.db`: the snapshots cannot be recreated.

### Adding a model

1. Catalogue + (optional) central-bank file in `backend/data/`; probe tickers with `python scripts/probe_catalogue.py data/series_catalogue_nowcast_<cc>.json`
2. A `NowcastSpec` in `MODELS` (`backend/quant_macro.py`)
3. An entry in `QUANT_MACRO_MODELS` (`frontend/src/features/quant-macro/models.ts`) and a tile under `quant-macro` in `dashboard_config.yaml`

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
| `frontend/src/components/CountryFlag.tsx` | SVG country flags (`country-flag-icons`) for the regional heatmaps; never emoji flags (Windows renders them as letter pairs) |

Rules: numbers use Geist Mono (`fontFamily: "'Geist Mono', ui-monospace, monospace"`), text uses Geist; no emoji, glows or scale-on-hover; panel radius 6; colour only where it carries meaning. Pages don't need their own back button — the rail handles navigation. Use hex (not `var()`) in page inline styles, since pages build colours like `` `${c}22` ``.
