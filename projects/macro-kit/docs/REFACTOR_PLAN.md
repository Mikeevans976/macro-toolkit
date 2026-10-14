# macro-kit — Refactor & Improvement Plan

_Drafted 2026-10-12 from a read-through of `backend/`, `frontend/`, `euribor_positioning/`, CI config and project docs. Implementation started 2026-10-13; see §8 for what is done._

---

## 1. Goals

1. **Reliability.** Keep secrets and runtime state out of the code, stop the event loop being blocked, and run the tests on every change.
2. **Simplicity.** Remove the large-scale copy-paste, especially the ten regional heatmap pages and their 40 hand-wired routes, and delete dead code.
3. **Performance.** Split the 2 MB frontend bundle, cache expensive computations, and bound user-controlled workloads.
4. **Scalability of the codebase.** Adding a region or a tool should mean adding config, not copying a 1,200-line file.
5. **Usability.** Handle auth expiry, errors and loading states the same way on every page.

Rule for every phase: **no behaviour change unless stated.** Each step ships as its own small PR that keeps `pytest` and `npm run build` green.

---

## 2. Current state: key findings

| # | Area | Finding | Evidence | Impact |
|---|------|---------|----------|--------|
| F1 | Security | Hard-coded fallback JWT secret | `backend/auth.py:12-15`: `SECRET_KEY` defaults to `"dev-secret-key-change-in-production-…"` | Anyone can forge tokens if the env var is forgotten in a deploy |
| F2 | Security | JWT passed in a query string for SSE | `main.py` `/api/agents/stream/{run_id}?token=…` | Tokens end up in access logs and browser history |
| F3 | Security / DoS | Untyped `payload: dict` bodies with no limit on `n_sims` | `main.py` mean-reversion routes: `int(payload.get("n_sims", 10_000))` | One request can pin a CPU indefinitely; bad input gives a 500 instead of a 422 |
| F4 | Reliability | CPU-heavy numpy/scipy work runs inside `async def` routes | e.g. `mean_reversion_*`, `pca_analysis`, `correlation_regimes_scan`, heatmap routes | Blocks the event loop, so every other user (including SSE streams) stalls while it runs |
| F5 | Simplicity | 40 near-identical heatmap routes and 10 near-identical wrapper modules | `main.py` lines ~197-395; `backend/{uk,us,japan,…}_heatmap.py` differ only in config | ~250 lines of boilerplate; adding a region touches 3 backend files |
| F6 | Simplicity | 10 regional heatmap pages, 700-3,400 lines each, re-implementing the same Jacobi PCA, `matInv`, `ols`, `zscoreToColors` and chart sections | `frontend/src/pages/*Heatmap.tsx` (≈11k lines total); `CLAUDE.md` even documents a "build it with 4 `cat >>` appends" workaround | Bug fixes have to be made 10 times; files too large to edit safely |
| F7 | Correctness / dead code | Heatmap pages use **client-side synthetic data** and never call the backend heatmap endpoints | `grep "heatmap/" frontend/src` returns nothing | Two divergent implementations of the same model; the backend DFM is not reachable from the UI |
| F8 | Dead code | Legacy CrewAI agent stack is still present, but only `agents/storage.py` is used (by `pod/`) | `agents/{agents,crew,tasks,tools,general_tools}.py` (~1.5k lines) are imported only by each other; `crewai` and `duckduckgo-search` are still in `requirements.txt` | Heavy install, confusing ownership, `pod/` depends on a "legacy" package |
| F9 | Duplication | 24 pages define their own `cardStyle`; 15 pages hand-roll `fetch` with `Authorization: Bearer` (29 occurrences); no shared API client | `grep "const cardStyle"`, `grep Bearer` | Inconsistent 401 and error handling; theme drift |
| F10 | Performance | One 2.0 MB JS bundle; all 30 pages are imported eagerly in `App.tsx` | `frontend/dist/assets/index-*.js` = 2,032,695 B | Slow first load; any page change invalidates the whole cache |
| F11 | Tooling | `npm run lint` is broken: there is no ESLint config and ESLint is not installed | No `.eslintrc*`/`eslint.config.*`; `node_modules/.bin` has no eslint | The documented "0 warnings" gate does not exist |
| F12 | Tooling | No CI runs tests or builds; the only workflows are Claude review bots | `.github/workflows/{claude,claude-code-review}.yml` | 180 tests (53 backend + 127 positioning) only run if someone remembers |
| F13 | Packaging | Imports rely on `sys.path` hacks and on the cwd being `backend/` | `euribor_positioning_router.py:18`, `agents/tools.py:19`, every test file; `Procfile` runs `cd backend && uvicorn main:app` while CLAUDE.md says `uvicorn backend.main:app` | Commands work or fail depending on where they are run; no `pyproject.toml` |
| F14 | Config | `ANALYTICS_DATA_SOURCE` is read ad hoc in 7+ modules, each with its own default (`"csv"`), while `data_fetcher.get_fetcher` only knows `bloomberg`/`haver` | `grep ANALYTICS_DATA_SOURCE backend` | Each tool has its own idea of what "live" means; no single switch to check |
| F15 | Observability | 92 `except Exception` blocks and only one module uses `logging` | `grep -c` | Failures are swallowed or turned into generic 500s with no trace |
| F16 | Reliability | Agent runs stream through an in-process `queue` dict, and the SSE handler replays stored events **and** then drains the live queue | `main.py` `agents_stream`, `pod/engine.get_queue` | Duplicate events are possible; only works with one worker process; polling `sleep(0.3)` |
| F17 | Repo hygiene | Binary and runtime files sit in source dirs: `Mean Reversion.xls` (tracked, 630 KB), `backend/data/Screenshot…png` (1.1 MB), `*.db` files in `backend/data/`, `__pycache__`/`.pytest_cache` dirs, slide builders in `docs/` | `ls`, `git ls-files` | Noise; risk of committing state |
| F18 | Docs | Docs disagree with the code: README calls the UI "dark space-themed"; CLAUDE.md says pages "mostly use synthetic data" and only a few call the API (17 do); the CLAUDE.md test command misses `test_pod.py` and the positioning suite | README, CLAUDE.md | Onboarding friction; wrong guidance for agents |
| F19 | Auth | `users.json` is re-read from disk on every authenticated request; `datetime.utcnow()` is deprecated; `python-jose` is pinned to 3.3.0, an unmaintained release with CVEs | `auth.py` | Small perf cost; security debt |
| F20 | Dependencies | Unpinned `>=` ranges in `requirements.txt` and no lockfile | `backend/requirements.txt` | Builds can't be reproduced |
| F21 | Security | The repo-root `Makefile` auto-creates a user with a **plaintext default password** | `Makefile` seeded a named user with a hard-coded password; the same password was used in `euribor_positioning/tests/test_integration.py` | The credential is in git history; every fresh `make backend` gets a known login |
| F22 | Structure | `backend/` is flat: ~35 modules mixing 40-line region wrappers, 1k-line engines, auth, config and data access | `ls backend/` | No grouping by tool or layer; hard to see what belongs to what |
| F23 | Structure | `backend/data/` mixes reference data (catalogue JSON), docs (catalogue `.md`), runtime state (`*.db`, `-shm`, `-wal`) and a screenshot; a second `macro-kit/data/` holds simulated CSVs | `ls backend/data data` | Unclear which data dir a tool reads; runtime state sits next to source |
| F24 | Structure | `euribor_positioning/` lives outside `backend/` but is imported by it through `sys.path`; `pod/` imports its storage from the legacy `agents/` | `euribor_positioning_router.py:18`, `pod/storage.py:13` | Package boundaries and ownership point the wrong way |
| F25 | Structure | `docs/` holds slide builders (`build_ic_slides*.py`) and `.key`/`.pptx` binaries; `sandbox/` (pod runtime scratch) is a committed folder | `ls docs docs/slides sandbox` | Docs are hard to find; runtime paths are hard-coded |
| F26 | Repo root | The root of `Team-Massimo-Marzeglia-Analytics/` has stray `backend/` and `frontend/` folders (only `users.json`, `node_modules`, `__pycache__`), plus personal files (HEIC photo, PDFs including a textbook, one-off scripts `ecb_probs.py`, `make_synthetic.py`); the `Makefile` works out at run time whether the app is at the root or under `projects/macro-kit/` | `ls` at repo root, `Makefile` `APP_DIR` | Leftovers from the move into `projects/`; branches with different layouts; risk of committing copyrighted or personal files |

---

## 3. Folder structure

### 3.1 Assessment of the current layout

**Keep:**
- The top-level `backend/` / `frontend/` / `docs/` split.
- `euribor_positioning/`'s internal layout (`config/`, `core/`, `data/`, `outputs/`, `tests/`, one test file per core module). This is the model the rest of the backend should follow.
- `backend/pod/`'s internal layout (`tools/`, `skills/`, YAML config next to the code that reads it).

**Change:** see F22-F26. In short: a flat backend, data folders that mix reference data with runtime state, package boundaries held together by `sys.path`, binaries and scripts in `docs/`, and leftovers at the repo root.

### 3.2 Target layout (end state)

```
Team-Massimo-Marzeglia-Analytics/      # repo root: README, .gitignore, CI only; no app code, no personal files
  projects/
    macro-kit/
      pyproject.toml                   # one installable package `macrokit`; pytest, ruff, mypy config
      Makefile                         # dev / test / lint / build / ci (no credentials)
      .env.example                     # every setting, documented
      dashboard_config.yaml
      backend/macrokit/
        app.py                         # create_app(): middleware, routers, static files
        settings.py                    # pydantic-settings: SECRET_KEY (required), DATA_SOURCE, CORS, STATE_DIR
        auth/                          # router + deps; user store cached, reloads on mtime change
        data/                          # DataSource protocol: simulated | csv | bloomberg | haver
          catalogues/                  # series_catalogue_*.json (reference data only)
          simulated/                   # the CSVs now in macro-kit/data/
        tools/<tool>/                  # one package per tool: service.py (pure), schemas.py, router.py
          heatmap/                     # ONE router: /api/tools/heatmap/{region}/{view}; regions.yaml
        pod/                           # agent pod; owns its run storage (agents/ deleted)
        positioning/                   # euribor_positioning moved here, same internal layout
      backend/tests/                   # mirrors macrokit/ (tests/tools/test_swaps_rv.py, tests/positioning/…)
      frontend/src/
        api/client.ts                  # one fetch wrapper: auth header, 401 → /login, typed errors
        hooks/useApi.ts                # loading/error/data + abort on unmount
        components/ui/                 # Card, Section, StatTile, ChartFrame, ZScoreLegend…
        lib/math/                      # pca.ts, ols.ts, matrix.ts (unit tested)
        features/<feature>/            # heatmap/, mean-reversion/, pca-analysis/…: components, hooks, model
        pages/                         # thin route components, lazy loaded
      docs/
        catalogues/                    # series_catalogue_*.md, egb_bond_finder.md
        adr/
        *.md                           # technical docs only
      presentations/                   # slide builders + .key/.pptx (or moved out of the repo / to LFS)
      var/                             # GITIGNORED runtime state: *.db, pod sandbox/, users.json
```

### 3.3 Migration map

| Current | Target | Notes |
|---------|--------|-------|
| `backend/<tool>.py` (swaps_rv, egb_rv, mean_reversion, …) | `macrokit/tools/<tool>/service.py` | Route handlers move out of `main.py` into `tools/<tool>/router.py` |
| `backend/{uk,us,japan,…}_heatmap.py` + `regional_heatmap.py` + `dfm.py` | `macrokit/tools/heatmap/{engine.py,dfm.py,regions.yaml}` | The ten wrappers are deleted |
| `backend/{data_fetcher,macro_data_loader,bbg}.py` | `macrokit/data/` | Behind the `DataSource` protocol |
| `backend/*_config.py` (`curves_flies_config`, `egb_expressions_config`) | Next to the tool that uses them | |
| `backend/data/series_catalogue_*.json` | `macrokit/data/catalogues/` | |
| `backend/data/*.md` | `docs/catalogues/` | |
| `backend/data/*.db*`, `backend/users.json`, `sandbox/` | `var/` (path from `settings.STATE_DIR`) | Gitignored |
| `backend/data/Screenshot…png`, `Mean Reversion.xls` | Out of the repo, or `docs/assets/` via LFS if they are needed | |
| `macro-kit/data/*.csv` | `macrokit/data/simulated/` | |
| `euribor_positioning/` | `macrokit/positioning/` | Removes the `sys.path` hack; its `cli.py` becomes a `pyproject` script entry |
| `agents/storage.py` | `macrokit/pod/runs_storage.py` | Rest of `agents/` deleted |
| `docs/build_ic_slides*.py`, `docs/slides/` | `presentations/` | |
| `backend/scripts/simulate_*.py` | `macro-kit/scripts/` | Dev tooling, not part of the server package |
| Repo-root `backend/`, `frontend/`, `__pycache__/` | Delete | Untracked leftovers (only `users.json`, `node_modules`, caches) |
| Repo-root personal files (HEIC, PDFs, `ecb_probs.py`, `make_synthetic.py`, `generate_diagnostic_prompts_pdf.py`) | Move out of the repo, or into a gitignored `scratch/` | Never commit the textbook PDF |

Do the moves as **mechanical PRs with no logic changes** (`git mv` + import fixes), so `git log --follow` keeps history and reviews stay trivial. Order: `var/` and repo-root clean-up first (no imports affected), then data, then `positioning/`, then tools one by one.

---

## 4. Phased plan

### Phase 0: Safety net (≈1-2 days, do first)

Goal: lock in current behaviour so later refactors can be checked against it.

1. **CI workflow** `.github/workflows/ci.yml`: `pip install` → `pytest backend/tests euribor_positioning/tests`; `npm ci` → `npm run build` (+ lint once it exists). Required on PRs. *(F12)*
2. **Fix linting**: add `eslint` 9 + `typescript-eslint` + `eslint-plugin-react-hooks` with a flat config. Start with warnings allowed, then ratchet to `--max-warnings 0`. Add **ruff** (lint + format) for Python. *(F11)*
3. **API golden tests**: for every GET route, call it once on simulated data and snapshot the JSON shape and key values (`backend/tests/test_api_contract.py`, using `TestClient`). This guards Phases 2-3.
4. **Frontend smoke test**: Vitest + React Testing Library rendering each page under a mocked API, asserting no throw. This guards Phase 4.
5. **Repo hygiene**: move `Mean Reversion.xls`, the screenshot and the slide builders out of the source tree (or to Git LFS / `docs/assets/`); confirm `*.db`, `__pycache__` and `.pytest_cache` are ignored and untracked. *(F17)*
6. **Remove the Makefile credential** *(F21)*: delete the auto-create-user step (or make it read `ADMIN_USERNAME`/`ADMIN_PASSWORD` from `.env`, matching `auth.bootstrap_admin`). Change that password anywhere it was used; it stays in git history, so treat it as public.
7. **Repo-root clean-up** *(F26)*: delete the untracked root `backend/`, `frontend/` and `__pycache__/`; move personal files and one-off scripts out of the repo or into a gitignored `scratch/`. Once all branches use the `projects/macro-kit/` layout, drop the `APP_DIR` detection from the Makefile.
8. **Runtime state dir** *(F23, F25)*: introduce a gitignored `var/` and point the SQLite DBs, `users.json` and the pod sandbox at it through one `STATE_DIR` setting (see §3.3).

**Done when:** a PR that breaks a test, the build or the lint fails CI.

### Phase 1: Security & reliability quick wins (≈2 days)

1. **Settings module** (`pydantic-settings`): `SECRET_KEY` **required** when `ENV != dev`, so startup fails loudly instead of using the fallback. Also holds CORS origins, data source and file paths. *(F1, F14)*
2. **Auth hardening**: replace `python-jose` with `PyJWT`; use `datetime.now(UTC)`; cache `users.json` and reload it when its mtime changes; add a login rate limit (e.g. `slowapi`, 5/min/IP). *(F19)*
3. **SSE auth**: exchange the bearer token for a short-lived (60 s), run-scoped stream ticket (`POST /api/agents/stream-ticket`), or switch the client to `fetch` + `ReadableStream` so the `Authorization` header can be sent. Strip query tokens from the access log. *(F2)*
4. **Typed request bodies**: replace every `payload: dict` with Pydantic models that set bounds (`n_sims: conint(ge=100, le=50_000)`, date validation, expression length limit). *(F3)*
5. **Stop blocking the event loop**: make CPU-bound route handlers plain `def` (FastAPI runs them in its threadpool), or wrap them with `await run_in_threadpool(...)`. For the heaviest jobs (Monte-Carlo, correlation scan) consider a `ProcessPoolExecutor`, since numpy releases the GIL only partly. *(F4)*
6. **Logging**: configure `logging` once in `app.py` (JSON in prod). Replace bare `except Exception:` with specific exceptions, or log with `logger.exception` and re-raise as an `HTTPException` with a stable error code. Add a request-id middleware. *(F15)*
7. **Pin dependencies**: switch to `uv` (or `pip-tools`) and commit a lockfile; keep `requirements.txt` generated from it for the Procfile. *(F20)*

**Done when:** the app refuses to boot in prod without `SECRET_KEY`; an oversized `n_sims` returns 422; a running Monte-Carlo no longer freezes the `/api/me` latency check.

### Phase 2: Backend structure (≈4-5 days)

1. **Proper packaging**: add `pyproject.toml`; make `backend/` and `euribor_positioning/` importable packages; remove every `sys.path.insert`; align the Procfile, CLAUDE.md and README on one entrypoint (`uvicorn macrokit.app:app`). *(F13)*
2. **Split `main.py` (1,113 lines) into routers**, one `APIRouter` per tool (`tools/<tool>/router.py`), registered in `create_app()`. `main.py` becomes a ~30-line shim during the transition.
3. **Collapse the heatmap layer** *(F5)*:
   - Move the ten `HeatmapConfig` instances into `heatmap/regions.yaml` (or a single `regions.py` dict).
   - One router: `GET /api/tools/heatmap/{region}/{factors|yield-pca|pc-regressions|fair-value}`, with `region` validated against the registry.
   - Keep the old URLs as thin aliases for one release, then remove them.
   - Delete the ten `*_heatmap.py` wrapper files.
4. **Unify data access** *(F14)*: one `DataSource` protocol with `simulated`, `csv`, `bloomberg` and `haver` implementations, chosen once from settings and injected via `Depends(get_data_source)`. Every module that currently reads `os.environ["ANALYTICS_DATA_SOURCE"]` is rewritten to take the source as an argument, which also makes it trivially testable.
5. **Caching**: wrap deterministic heavy computations (heatmap DFM, fitted curves, PCA on fixed inputs) in a small TTL cache keyed on (data-source, inputs, as-of-date). Precompute heatmaps at startup in simulated mode. Use `functools.lru_cache` for pure functions and `cachetools.TTLCache` where live data can change.
6. **Remove the legacy agents stack** *(F8)*: move `agents/storage.py` into `pod/runs_storage.py`, update `pod/` and `main.py` imports, delete `agents/{agents,crew,tasks,tools,general_tools}.py`, and drop `crewai` and `duckduckgo-search` from requirements. Check first that nothing in the frontend still calls a CrewAI-only route.
7. **Agent run streaming** *(F16)*: give every event a monotonically increasing `seq`. On SSE connect, replay events with `seq > Last-Event-ID` and then tail them, with no separate in-memory queue. That fixes duplicates, lets clients resume, and works across multiple workers (SQLite/WAL now, Redis pub/sub later if needed).
8. **Response models**: return Pydantic schemas (not bare dicts or dataclasses) so OpenAPI is accurate. Then generate TypeScript types with `openapi-typescript` for Phase 4.

**Done when:** the Phase 0 contract tests pass unchanged (apart from the deliberately aliased heatmap URLs); `main.py` is gone or trivial; `grep sys.path` returns nothing; adding a region is one YAML entry.

### Phase 3: Decide the heatmap source of truth (needs a product decision)

The frontend heatmaps generate their own synthetic z-scores, PCA and OLS in the browser, while the backend has a full DFM/Kalman implementation that nothing calls *(F7)*. Recommendation: **the backend becomes the single source of truth.** Pages fetch `/api/tools/heatmap/{region}/*` and the browser-side maths is deleted. That removes thousands of lines and means "live data" switches on in one place.

If browser-side synthetic rendering must stay (e.g. for offline demos), move it behind the same `DataSource` seam as a `simulated` backend source rather than keeping a second implementation in TypeScript.

### Phase 4: Frontend structure (≈5-7 days, after Phase 3)

1. **API client** *(F9)*: `src/api/client.ts` adds the bearer token, handles JSON and typed errors, redirects to `/login` on 401 and supports `AbortController`. Pair it with a `useApi` hook, or adopt **TanStack Query** for caching, retries and deduplication. Replace all 29 hand-rolled `Bearer` fetches.
2. **Route-level code splitting** *(F10)*: `React.lazy` + `Suspense` for every page in `App.tsx`; `manualChunks` for `recharts`. Target: initial JS under 300 KB gzip, and each page in its own chunk.
3. **Generic regional heatmap** *(F6)*:
   - `features/heatmap/RegionalHeatmapPage.tsx` built from shared sections (`HeatmapTable`, `YieldPCChart`, `PCRegressionSection`, `FairValueSection`, `CurveDynamicsSection`, `BEDynamicsSection`).
   - `features/heatmap/regions/*.ts` holds only what differs per region (tenors, labels, central bank, benchmark names), or this comes from the backend registry.
   - Pages become `<RegionalHeatmapPage region="uk" />`; routing uses `/tools/heatmap/:region`.
   - Delete the CLAUDE.md "`cat >>` in four chunks" section, since no file should need it.
4. **Shared maths library**: move `jacobi`/PCA, `matInv`, `ols` and `zscoreToColors` into `src/lib/math/` with Vitest unit tests checked against numpy reference outputs. Used by `PCAAnalysis`, `PrintAnalysis` and any remaining page that genuinely needs client-side maths.
5. **UI primitives**: a `Card`/`Panel` component that replaces the 24 `cardStyle` copies, plus `Section`, `StatTile`, `ChartFrame`, `LoadingState` and `ErrorState`, all built on the `theme.ts` tokens.
6. **Break up the largest pages**: `PCAAnalysis.tsx` (5.7k lines), `EuroAreaHeatmap` (3.4k), `MeanReversion` (3.1k), `SeasonalityBacktester` (3.0k), `MacroOptionsMonitor` (2.6k). Rule of thumb: no file over ~600 lines. Split each into `components/`, `hooks/` (data and state) and `model/` (pure computation, unit tested).
7. **Performance hygiene**: memoise heavy derived data (`useMemo`) and lift static synthetic data to module scope or JSON. Down-sample long daily series before handing them to Recharts (e.g. LTTB to ~1k points), and virtualise large tables.
8. **Routes from config**: generate the `<Route>` list from a typed registry shared with `Glyph.tsx` / `dashboard_config.yaml`, so adding a tool doesn't touch three files.

**Done when:** the bundle-size budget is enforced in CI (e.g. `size-limit`); all pages use the API client; heatmap pages share one implementation.

### Phase 5: Docs & developer experience (≈1 day, alongside the other phases)

1. Rewrite README and CLAUDE.md to match reality: stack, the single run command, how to add a tool or region (now config-driven), the full test commands, and the graphite/glacier visual system. *(F18)*
2. A `Makefile` or `justfile` with `dev`, `test`, `lint`, `build` and `ci`.
3. `.env.example` that lists every setting.
4. An ADR folder (`docs/adr/`) recording the Phase 3 decision and the pod storage design.

---

## 5. Prioritisation summary

| Priority | Item | Effort | Risk |
|----------|------|--------|------|
| P0 | Remove the Makefile default password and change it | XS | None |
| P0 | CI + lint + contract tests (Phase 0) | S | Low |
| P1 | Repo-root clean-up + `var/` state dir | S | Low, no imports affected |
| P1 | Folder restructure (§3.3), done as mechanical `git mv` PRs | M | Low-medium, covered by contract tests |
| P0 | Required `SECRET_KEY`, typed and bounded bodies, threadpool for CPU routes | S | Low |
| P1 | SSE auth ticket, PyJWT, logging, locked deps | S-M | Low |
| P1 | Packaging + router split + heatmap route collapse | M | Medium, covered by contract tests |
| P1 | Remove the CrewAI legacy stack | S | Low, after confirming no callers |
| P1 | Frontend API client + lazy routes | M | Low |
| P2 | Unified `DataSource` + caching | M | Medium, live paths are hard to test without a Bloomberg terminal; mock at the fetcher boundary |
| P2 | Heatmap source-of-truth decision + generic heatmap page | L | Medium-high; needs visual regression checks (Playwright screenshots) |
| P3 | Breaking up the remaining mega-pages | L | Medium; do it page by page, opportunistically |

---

## 6. Risks & mitigations

- **Silent numerical changes during refactors.** Contract tests snapshot key numbers with tolerances, and maths moved into `lib/math` is checked against numpy fixtures.
- **Visual regressions when merging the heatmap pages.** Take Playwright screenshots of each region before and after; diff and review them manually.
- **Live data paths that CI can't exercise.** Keep the vendor SDKs behind the `DataSource` interface, test with recorded fixtures, and keep a manual "live smoke" checklist in `docs/BBG_HAVER_SETUP.md`.
- **Ongoing feature work conflicting with big moves.** Do the mechanical moves (file splits, renames) in short PRs merged quickly, and announce freeze windows for `main.py` and the heatmap pages.

---

## 7. Out of scope (for now)

- Replacing SQLite with Postgres. Only revisit if multi-instance deployment is needed after Phase 2.7.
- Moving away from Recharts, or a full redesign. The current visual system stays as is.
- Changes to model methodology (DFM, positioning signal). This plan is structural only.

---

## 8. Progress log

### 2026-10-13: Phase 0 complete (except deletions and `var/`), Phase 1 mostly complete

**Done**
- **CI** `.github/workflows/macro-kit-ci.yml` (repo root): ruff, backend pytest (incl. slow contract case), positioning pytest, ESLint, Vitest, build. Triggers only on `projects/macro-kit/**`. *(F12)*
- **Linting:** ESLint 9 flat config, 0 errors (98 warnings left to ratchet; `no-explicit-any` is a warning for now). `ruff.toml` gates on real errors only (E9/F63/F7/F82). *(F11)*
- **API contract tests** `backend/tests/test_api_contract.py`: 54 GET cases + 8 POST cases + 1 slow case, digest snapshots, frozen clock (`time-machine`). Validation and gzip tests too.
- **Frontend smoke tests:** Vitest renders all 28 pages with the network stubbed; `src/lib/dates.test.ts`.
- **Repo hygiene:** slide builders and decks → `presentations/`; workbook → `docs/assets/`; screenshot and personal root files → gitignored repo-root `scratch/`. *(F17, F25, F26)*
- **Makefile credential removed** (password must still be changed wherever it was used). *(F21)*
- **Auth:** no hard-coded secret (random per-process key + warning when `SECRET_KEY` unset); PyJWT replaces `python-jose`; tz-aware expiry; `users.json` cached by mtime; `test_auth.py`. *(F1, F19)*
- **Bounded, typed bodies:** mean-reversion routes moved to `backend/routers/mean_reversion.py` with Pydantic models (`n_sims ≤ 50k`, SDE `Literal`, expression ≤ 500 chars); bad input → 422. *(F3; first step of the Phase 2 router split)*
- **Event loop:** 69 non-awaiting `async def` tool/auth routes are now `def`. Checked live: `/api/me` stays at ~5 ms while a 73 s request runs. *(F4)*
- **GZip** responses ≥1 KB (SSE excluded); `logging.basicConfig`; `.env.example`; CLAUDE.md commands, tests and routers sections updated. *(F15 partial, F18 partial)*

**Bugs found and fixed along the way**

| # | Bug | Fix |
|---|-----|-----|
| F27 | Simulated PCA-analysis and print-analysis data changed on every server restart: RNG seeded with Python's per-process-randomised `hash()` | `zlib.crc32` seeds (`pca_analysis.py`, `print_analysis.py`) |
| F28 | Month labels in InflationFixingsMonitor built with `toISOString()` on local-midnight Dates: in London every BST month showed as the previous month (26 duplicate labels, April missing); in CET every month shifted back by one | `monthLabel(t)` from calendar fields |
| F29 | Same bug class in SeasonalityBacktester's synthetic business days (in BST, Mondays were labelled as Sundays), plus InflationPCA and the PCA date pickers | `toLocalISODate` in `src/lib/dates.ts` |
| F30 | `fitted_bond_curves.AS_OF` captured "today" at import, so a long-running server reported its start date indefinitely | resolved per call (`_today()`) |
| F31 | Stanton overlay with `sim_sde=linear_ou` crashed (`UnboundLocalError: sig`) whenever a simulated bucket was sparse | default `sig = sigma` |
| F32 | `/mean-reversion/analyse` returned 500 when a custom target/stop was already crossed (all paths hit on the same day → singular KDE) | skip the KDE when hit days have no spread; the frontend already handles an empty `kde` |
| F33 | Fair Value Models: 67 s cold compute + 11.8 MB response; the first visitor after every restart waited over a minute | numpy standardisation + `check_input=False` + vectorised output (byte-identical output, 67 s → 18 s); background warm-up at startup; gzip → **1.2 s / 1.35 MB per visit** |

**Still open / found but not fixed**
- `/api/tools/seasonality/data` is Bloomberg-only and returns an unhandled 500 without a terminal (no simulated path). *(F14)*
- Seasonality stats derive day-of-week via `getDay()` on UTC-parsed `YYYY-MM-DD` Dates, which shifts by a day for users west of UTC.
- `stanton_diagnostic` polynomial overlays run a pure-Python Euler loop of ≥200k steps per request (performance).
- `test_pod.py::test_hierarchy` and `::test_morning_briefing_order` fail against the in-progress (uncommitted) pod changes. Not touched.
- Needs a human: delete the untracked repo-root `backend/` (stale `users.json`), `frontend/` (`node_modules`) and `__pycache__/`; change the old Makefile password.
- `var/` state dir and SSE stream tickets are deferred until the in-progress `backend/pod/` work lands, because both touch pod storage and stream code.

**Next:** Phase 1 leftovers (SSE ticket, lockfile via `uv`), then Phase 2: `pyproject.toml` packaging, the rest of the router split, and the heatmap route collapse (contract tests already cover all 40 heatmap URLs).

### 2026-10-13 (cont.): Phase 2 backend structure, Phase 4 frontend foundations

**Done** (branch `refactor/macro-kit-phase-0-1`, one commit per step)
- **CrewAI stack removed** (`agents/{agents,crew,tasks,tools,general_tools}.py`, `crewai` dependency); `agents/storage.py` stays for the pod. *(F8, partial)*
- **Heatmap collapse:** `heatmap_regions.py` (10 configs, verified identical) + `routers/heatmaps.py` → `GET /api/tools/heatmap/{region}/{view}`. Legacy URLs are kept as hidden aliases; the 10 wrapper modules are deleted. *(F5)*
- **Router split:** all 23 remaining tool routes moved verbatim into 13 `routers/<tool>.py`, with auth at router level. `main.py` went from 1,113 to ~420 lines (app setup, auth, dashboard, agents, static). A new test checks that all 44 API routes return 401 without a token. *(Phase 2.2)*
- **Typed bodies everywhere:** seasonality stats/heatmap/backtest and print-analysis market-reaction now use Pydantic models; no `payload: dict` remains outside the agent routes. *(F3)*
- **`pyproject.toml`:** a single `pytest` runs both suites (308 tests); ruff config folded in; `sys.path` hacks removed from tests (except `test_pod.py`). *(F13, partial)*
- **`BloombergUnavailable` → 503** with a clear message (previously a bare 500). *(F14, partial)*
- **Frontend code-splitting:** every page is `React.lazy`, with vendor chunks for React and Recharts. Initial JS went from **2,032 KB to ~240 KB (81 KB gzipped)**. *(F10)*
- **Shared API client** `src/api/client.ts`: `authFetch` + an axios interceptor. Every page now sends an expired session (401) to `/login`; before, `fetch` pages silently rendered nothing. *(F9, partial)*
- **Heatmap de-duplication (step 1):** `src/lib/math/linalg.ts` and `src/features/heatmap/styles.ts` replace 715 duplicated lines. DOM-hash snapshots (clock and TZ pinned), taken before the change, are unchanged after it. *(F6, partial)*

**More bugs found and fixed**

| # | Bug | Fix |
|---|-----|-----|
| F34 | All three seasonality POST endpoints returned 500: `resample("BQ")` was removed in pandas 3 | `"BQE"` |
| F35 | Seasonality backtest called `.strftime` on numpy `datetime64`, so it had never worked | `.dt.strftime` |

**Found, not fixed**
- The seasonality POST routes are not called by the frontend (it computes in-browser). Delete them or wire them up, as part of Phase 3.
- The heatmap copies have drifted: `ols`, `Legend`, `formatCellValue`, `HeatmapTable` and the section components exist in 2–10 variants each. Merging them into one generic page needs the Phase 3 decision, because it changes either data source or rendering.

**Next (blocked or needing a decision)**
- **Phase 3 decision** (backend vs browser as the heatmap source of truth) before building a generic `RegionalHeatmapPage`.
- **Waiting on the in-progress pod work:** the SSE stream ticket, the `var/` state dir, moving agent routes out of `main.py`, and the `macrokit` package rename (it rewrites imports inside `pod/`).
- Lockfile (`uv`), ratcheting the ESLint warnings (98), widening the ruff rule set.

### 2026-10-13 (cont.): pod work landed; agent routes, SSE, `var/`, lockfile

**Done**
- **Pod work committed** as its own commit (trade ledger, risk engine, roster/skills, ledger UI); all suites green on it.
- **Agent/pod routes → `routers/agents.py`** with Pydantic bodies; sync handlers are `def`. `main.py` is now ~200 lines (app setup, auth, dashboard, router mounting, static). *(Phase 2.2 complete)*
- **SSE stream tickets:** the client exchanges its session token for a 60 s, run-scoped ticket (`POST /api/agents/stream/{run_id}/ticket`, `openRunStream` in `api/client.ts`). Tickets are rejected as bearer tokens; the 8 h token no longer appears in URLs or access logs. *(F2)*
- **SSE tails the `events` table** (SSE `id` = row id, `Last-Event-ID` resume, keep-alives, 30-minute stall timeout) instead of an in-memory queue. *(F16)*
- **`var/` runtime state dir** (`backend/runtime_paths.py`, `$MACROKIT_STATE_DIR` override) for `users.json`, both SQLite DBs and the pod sandbox. Legacy locations keep working until moved; nothing is moved automatically. *(F23, F25)*
- **Pinned dependencies:** `requirements.in` (ranges) → `requirements.txt` (full pins via `uv pip compile --universal`, seeded from the tested venv). *(F20)*

**More bugs found and fixed**

| # | Bug | Fix |
|---|-----|-----|
| F36 | Late or reconnecting SSE clients got every early event twice (stored replay **and** the live queue, which still held them) | Single DB-tailing loop |
| F37 | Run queues were never removed from the in-process dict, so memory grew with every run | Queue removed |
| F38 | Any logged-in user could read or stream any other user's run by id (the run list was filtered by user, the detail and stream were not) | Owner-only; 404 otherwise |
| F39 | The auth-coverage test skipped all `/api/pod/*` routes and any path containing "stream" | Now covers both (50 routes) |
| F40 | `httpx` was never declared, but the pod (`pod/models.py`, `runner.py`, `web_local.py`) and `TestClient` import it; it only arrived via `crewai`. Once CrewAI was removed, a fresh deploy failed at startup and CI failed at collection | Declared in `requirements.in`; verified by importing all 64 backend modules in a fresh venv built only from the pins |
| F41 | Global Yields built its date grid, Bloomberg fetch and PCA once at import: a running server never showed new days or refreshed live data, and the contract snapshot silently depended on the real date | Model built lazily, cached per calendar day; snapshot now follows the frozen clock |

**Deliberately not done yet**
- **`macrokit` package rename:** it rewrites almost every backend import, so it would conflict with the unmerged `merge/mm-bbg` live-Bloomberg work. Do it right after that merge, as one mechanical PR.
- **Moving existing state into `var/`** on machines that already have `backend/users.json` / `backend/data/*.db` (stop the server first): `mkdir -p var && mv backend/users.json backend/data/agent_runs.db* backend/data/euribor_positioning.db* var/ && mv sandbox var/`.

- **ruff widened to all of pyflakes** (`E9` + `F`): 58 unused imports, 29 dead assignments (each reviewed; none hid a bug), 7 f-strings removed.

**Next:** the Phase 3 decision; the `macrokit` rename after the `mm-bbg` merge; ratchet the ESLint warnings (98, mostly `no-explicit-any` in page code).

### 2026-10-14: Phase 3 decided and done: the backend is the heatmap source of truth

**Decision:** the backend is the single source of truth for the regional heatmaps (owner's call, 2026-10-14).

**Done**
- **`GET /api/tools/heatmap/{region}`** returns the whole page: indicator z-score table (rows from each catalogue's `heatmap_group`), DFM factors with 1m/3m/12m/z summary, yield PCA, PC regressions with fitted series, 10y fair value plus the curve fair-value table, 2s10s/2s30s regime analytics, 10y breakeven regimes and scenario probabilities. ~30 KB gzipped per region.
- **`heatmap_analytics.py`** ports the browser maths; tests check it against a literal transcription of the pages' loops.
- **One shared page:** `features/heatmap/RegionalHeatmapPage.tsx` plus five section modules replace the ten page files (~11,000 lines → ~900; one 29 KB chunk). URLs are unchanged. Every region now gets every section the Euro Area page had (2s30s, look-back tables, scenario probabilities). `src/lib/math/linalg.ts` is deleted (no users left). *(F6, F7)*
- **Breakevens:** nominal minus a live 10y real yield where the catalogue has one (US, Sweden, Norway); otherwise simulated, and the page says so.

**Bugs found by putting the backend model on screen**

| # | Bug | Fix |
|---|-----|-----|
| F42 | Simulation-mode DFM applied the **monthly** AR(1) estimate as a **daily** transition, so factors decayed to ~0 between month ends (spikes; daily autocorrelation ~0.8) | Monthly AR converted to daily (a^(1/h)), innovation variance rescaled; autocorrelation now ≥0.99 |
| F43 | Simulated factors had half-lives of days and std ~0.1, so simulated 10y yields moved ~8 bp in two years and the curve PCs were mostly noise | Persistent factors in σ units, AR(1) yield idiosyncratic noise: 10y ranges of 70–125 bp, daily moves 3–4 bp, PC1 R² on macro 0.56–0.92 |
| F44 | `MACROKIT_STATE_DIR` set explicitly still fell back to legacy files (found when a preview's `create_user.py` wrote to the real `backend/users.json`; reverted) | An explicit state dir always wins; legacy fallback only for the default `var/` |

**Visible changes for users:** the heatmaps now show backend model output (different numbers from the old browser synthetics); the UK indicator table lists the catalogue's 48 DFM series instead of the page's 90 hard-coded rows; the "Latest / As of MTG / Change" columns showed invented strings and now show real levels only with live data.

**Not done:** the regional date grid is still fixed (Jun 2023 – Jun 2025) even in live mode; extending it to today is a separate change because it moves every number. The seasonality POST routes are still unused.
