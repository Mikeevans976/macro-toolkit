# Euribor Futures Positioning Tracker

**Tool URL:** `/tools/euribor-positioning`  
**Package:** `projects/macro-kit/euribor_positioning/`  
**Backend router:** `projects/macro-kit/backend/euribor_positioning_router.py`  
**Frontend page:** `projects/macro-kit/frontend/src/pages/PositioningTracker.tsx`  
**DB (simulation):** `projects/macro-kit/backend/data/euribor_positioning.db`

---

## Purpose

Infer the net speculative positioning of market participants in Euribor interest rate futures from publicly available ICE data — without any broker flow data. The tool combines daily changes in open interest (ΔOI) with settlement price moves to estimate directional positioning, corrects for structural artefacts, and anchors the running signal to the weekly ICE Commitment of Traders (COT) report using a Kalman filter.

---

## Architecture overview

The pipeline runs through 10 stages. All numeric parameters live in `config/params.yaml` — no magic numbers in the code.

```
ICE EOD data                    ICE COT report
(settlement, OI, volume, VWAP)  (weekly net positions by investor type)
        |                               |
        v                               |
   Stage 1: Ingest → SQLite             |
        |                               |
        v                               |
   Stage 2: Roll structure / expiry drain
        |
        v
   Stage 3: Direction estimator + confidence weight + decay accumulation
        |
        v
   Stage 4: Quadrant classification (soft) + deadband + short-covering detector
        |
        v
   Stage 5: Spread detection + curve routing
        |
        v
   Stage 6: DV01 normalisation + centre of gravity
        |
        v
   Stage 7: Kalman filter anchoring ←── ICE COT (Fridays only)
        |
        v
   Stage 8: Dashboard panels (6)
        |
        v
   Stage 9: Structural artefact corrections (€STR migration, option delta)
        |
        v
   Stage 10: FastAPI router + React frontend
```

---

## Core data disciplines

These rules are enforced throughout the codebase and must never be violated:

| Rule | Reason |
|------|--------|
| `knowledge_date = trade_date + 1 business day` | All queries filter on `knowledge_date`, never `trade_date`. Prevents look-ahead. |
| Rate space: `Δr = −Δprice` | Conversion at ingestion only. Downstream code always works in rate space. |
| ΔOI at fixed-contract level | Never difference OI across roll transitions — the change would be entirely spurious. |
| Expiry drain exclusion | Front contract excluded when OI < 10% of trailing 63-day peak. |
| COT timing: publication_date | Measurement update on Friday publication, not Tuesday report date. Wrong timing inflates R² by 0.3–0.4. |
| No position levels until Stage 7 | The accumulated signal is level-ambiguous until Kalman anchoring. |

---

## Stage-by-stage detail

### Stage 1 — Data ingestion and storage (`data/`)

**Schema** (`data/schema.sql`): 4 tables.

- `contracts`: one row per contract (`FEI_2025H`). PK = `contract_id`. Fields: `root`, `expiry_date`, `last_trading_day`, `contract_type` (quarterly/serial), `listing_date`.
- `daily_obs`: daily settlement price, open interest, volume, VWAP, open price per contract per trade date. PK = `(contract_id, trade_date)`.
- `daily_obs_revisions`: append-only log of OI revisions (§7.5 integrity).
- `cot_obs`: weekly COT report. PK = `(report_date, category)`. Fields: `publication_date` (Friday), `long_positions`, `short_positions`, `spreading_positions`.

**Integrity check (§4.8)**: at ingestion, `|ΔOI| ≤ volume` must hold. Violations raise `ValueError` — a single contract cannot change OI by more than the day's trading volume.

**Simulated data** (`ingest_ice_eod.simulate_eod_data`): seeds the DB with synthetic but structurally valid data for 2 years, using correlated Brownian motion so that the base signal correlates meaningfully with the simulated COT.

### Stage 2 — Roll structure (`core/rolls.py`)

**IMM calendar**: Euribor quarterly contracts expire on the third Wednesday of March (H), June (M), September (U), December (Z).

**Tenor buckets** by generic rank (expiry rank among active quarterly contracts):

| Ranks | Bucket | Approx. horizon |
|-------|--------|-----------------|
| 1–4 | Whites | 0–1 year |
| 5–8 | Reds | 1–2 years |
| 9–12 | Greens | 2–3 years |
| 13–16 | Blues | 3–4 years |

**Expiry drain**: A contract is flagged `is_draining = True` when its OI falls below `10%` of its trailing 63-day peak OI. Draining contracts are excluded from all signal and DV01 calculations to avoid contaminating the signal with forced expiry liquidation.

**ΔOI discipline**: `LAG() OVER (PARTITION BY contract_id ORDER BY trade_date)` — the window function partitions by contract, so ΔOI is never crossed across different contracts.

### Stage 3 — Base signal (`core/base_signal.py`)

For each contract-day:

**Direction estimator** (priority chain):
1. `sign(settlement − VWAP)` if VWAP available — intraday average is the best reference
2. `sign(settlement − open)` if open available
3. `sign(settlement − prev_settlement)` — fallback, logged as `fallback_close_to_close`

**Confidence weight**:
```
σ(t) = EWMA of |Δr| over 60 days (shifted to avoid look-ahead)
w(t) = min(|Δr(t)| / σ(t), 2.0)
```
Large moves relative to recent volatility carry more weight. Cap at 2.0 prevents outlier dominance.

**Turnover regime**: Identifies whether volume-OI relationship suggests position transfer vs. churn:
- Churn (high volume, low ΔOI): `w_adjusted = w × 0.2` — mostly noise
- Transfer (low volume, high ΔOI): `w_adjusted = w × 1.5` — highly informative
- Normal: `w_adjusted = w × 1.0`

**Flow**:
```
flow(t) = w_adjusted(t) × direction(t) × ΔOI(t)
```

**Exponential decay accumulation**:
```
P(t) = λ·P(t−1) + flow(t)
λ = exp(−ln2 / H)
```

Half-lives by bucket (configurable in `params.yaml`):

| Bucket | Half-life |
|--------|-----------|
| Whites | 30 days |
| Reds | 45 days |
| Greens | 60 days |
| Blues | 90 days |

Shorter-dated contracts are more actively traded and positional "memory" decays faster.

**What is deliberately not exposed**: Raw position levels `P(t)`. Only `weekly_change_position` (P(t) − P(t−5)) and `zscore_position` are exposed before Stage 7. Absolute levels are level-ambiguous until Kalman anchoring.

### Stage 4 — Quadrant classification (`core/quadrants.py`)

Each contract-day is placed into a flow quadrant based on the joint sign of the rate move and OI change. All in rate space:

| | ΔOI > 0 (positions opened) | ΔOI < 0 (positions closed) |
|---|---|---|
| **Δr < 0 (rates fell, bullish)** | Long build | Short covering |
| **Δr > 0 (rates rose, bearish)** | Short build | Long liquidation |

**Soft assignment** (§5.1): Rather than a hard sign rule, soft probabilities are computed:

```
p_dir_long = sigmoid(−Δr / σ) = 1 / (1 + exp(Δr/σ))
p_oi_up    = 1.0 if ΔOI > 0, 0.0 if ΔOI < 0, 0.5 if ΔOI = 0

p_long_build      = p_oi_up × p_dir_long
p_short_build     = p_oi_up × (1 − p_dir_long)
p_short_covering  = (1 − p_oi_up) × p_dir_long
p_long_liquidation= (1 − p_oi_up) × (1 − p_dir_long)
```

**Deadband** (§5.3): noisy observations are suppressed and marked "unclassified":
- Price deadband: `|Δr| < k × σ` where k = 0.30 (configurable)
- OI deadband: `|ΔOI| < max(0.5% × OI_{t−1}, rolling 60d median |ΔOI|)`

Deadband rows contribute zero flow.

**Short-covering confidence detector** (§5.4): The short-covering quadrant gets a probability boost when all four conditions hold:
1. ΔOI < 0 (positions closed)
2. Δr < 0 (rates fell)
3. Volume > 1.5× trailing 20d average (forced/urgent execution)
4. Price impact > 1.5× trailing 20d average (market moved against the seller)

This signature — falling rates as shorts are squeezed out at high volume with large price impact — is strong evidence of a short squeeze. The boost multiplier is up to 2.0×, renormalised across all four probabilities.

**Quadrant-adjusted flow**:
```
flow_quadrant(t) = |ΔOI(t)| × net_dir_prob(t) × w_adjusted(t)
net_dir_prob = p_long_build − p_short_build − p_long_liquidation + p_short_covering
```

### Stage 5 — Spread detection (`core/spreads.py`)

Spread traders (butterflies, pack trades, calendar spreads) are neutral to outright direction — including their ΔOI in the outright signal adds noise. The detector identifies spread activity via a 3-level hierarchy (no double-counting):

1. **Bundles** (8 consecutive quarterly contracts): coefficient of variation of `|ΔOI|` across the 8 legs < 0.35
2. **Packs** (4 consecutive quarterly contracts): CV < 0.30
3. **Calendar spreads** (pairs within 4-rank distance): rolling 60d `|corr(ΔOI_i, ΔOI_j)| > 0.50` and `|ΔOI_i / ΔOI_j| ∈ [1/1.5, 1.5]`

Spread-attributed flow is **routed to a separate `curve_positioning` series** rather than discarded. It is used in Dashboard Panel 5 (curve steepener/flattener activity). Outright OI is reduced by the matched spread lot count.

### Stage 6 — DV01 normalisation (`core/dv01.py`)

All flows and positions are converted to EUR DV01:
```
DV01 = EUR 25 per basis point per contract
```

Three reporting levels:

1. **Total net DV01** across the strip (excluding draining contracts)
2. **Per tenor bucket** (whites / reds / greens / blues)
3. **OI-weighted centre of gravity in years**:
   ```
   CoG = Σ(|DV01_i| × TTM_i) / Σ(|DV01_i|)
   ```
   where TTM = time to maturity in years. Tells you whether risk is concentrated at the front (CoG close to 0) or the back (CoG close to 4).

Z-scores use a trailing 252-day window. Vol-scaled risk (`risk_dv01 = dv01 × vol_scaled_factor`) normalises for the current rate volatility environment.

### Stage 7 — Kalman filter anchoring (`core/anchor.py`)

The daily accumulated signal P(t) is a level-ambiguous relative measure. The Kalman filter fuses it with the weekly COT report (which directly measures absolute net positions) to produce a properly anchored estimate.

**State-space model**:

```
State equation (every business day t):
    x(t) = λ·x(t−1) + β·f(t) + η(t),    η(t) ~ N(0, Q)

Measurement equation (Fridays only — COT publication date):
    z(t) = x(t) + ε(t),    ε(t) ~ N(0, R)
```

- `x(t)` = Kalman state (latent position level)
- `f(t)` = daily flow signal (from Stage 5 spread-adjusted signal)
- `z(t)` = COT net position (long − short) for a given investor category

**Parameters** `(λ, β, Q, R)` are estimated by **maximum likelihood** over the full history. The innovation log-likelihood is:
```
ℓ = −½ Σ_t [log(2π S(t)) + innovation(t)² / S(t)]
```
where `S(t) = P_pred(t) + R` is the innovation variance. Optimisation uses L-BFGS-B with reparametrisation: `λ = sigmoid(θ_λ)` (forces λ ∈ (0,1)), `β = exp(θ_β)`, `Q = exp(θ_Q)`, `R = exp(θ_R)` (forces positivity).

**Kalman predict/update cycle** (each business day):
```python
# Predict
x_pred = λ · x_prev + β · f(t)
P_pred = λ² · P_prev + Q

# Update (on Fridays with COT data)
innovation = z(t) - x_pred
S = P_pred + R
K = P_pred / S         # Kalman gain
x_est = x_pred + K · innovation
P_est = (1 - K) · P_pred
```

On non-observation days, `x_est = x_pred` (prediction-only step).

**R²** is computed on observation Fridays only:
```
R² = 1 − SS_res / SS_tot
```

A well-fitted model achieves R² > 0.30 (the acceptance threshold).

**COT categories**: The filter runs independently for each of the four COT categories (investment_firms, commercial, other_financial, other). The primary output is `investment_firms`.

### Stage 8 — Dashboard panels (`outputs/dashboard.py`)

Six panels, each independently error-isolated:

| Panel | Content |
|-------|---------|
| 1. DV01 by bucket | Net EUR DV01 per tenor bucket with 1y and 3y z-scores and history |
| 2. Crowding | Percentile rank of total position (Kalman x_est) and 10-day recency share |
| 3. Centre of gravity | OI-weighted risk CoG in years with trailing z-score |
| 4. Quadrant mix | Rolling 5d/10d share of long-build / short-build / short-covering / long-liquidation |
| 5. Curve positioning | Spread-attributed curve DV01 flow (steepener vs flattener) with z-score |
| 6. COT reconciliation | Kalman nowcast vs reported COT with uncertainty bands and fitted R² |

`build_dashboard()` calls `build_anchor()` once and passes the result as a cache to Panels 2 and 6 to avoid recomputing.

### Stage 9 — Structural artefact corrections (`core/corrections.py`)

**€STR migration correction** (§7.4): During the Euribor→€STR migration period, large falls in Euribor OI were matched by equal rises in €STR OI (FEF contracts) — these are position transfers, not position closings. Detection criteria:
- Euribor aggregate ΔOI < 0
- €STR aggregate ΔOI > 500 lots
- `|Δ€STR OI| / |ΔEuribor OI| ∈ [0.70, 1.30]`

On flagged days, the matched OI is proportionally subtracted from each Euribor contract's ΔOI before computing flow.

**Option delta flows** (§7.1): On option expiry dates (3rd Friday of every month) and within 2 calendar days of ECB meetings, large OI moves are often from option delta hedging — mechanical, not positioning. A row is flagged when:
1. Calendar trigger (3rd Friday or ECB proximity), AND
2. `|ΔOI| > 2% × trailing 20-day mean |ΔOI|`

Flagged rows get `w_adjusted × 0.3` — their contribution to the signal is reduced by 70%.

The final output column is `flow_final`. `dv01_flow_final = flow_final × EUR 25`.

### Stage 10 — API and frontend (`backend/euribor_positioning_router.py`)

**FastAPI router** (all endpoints JWT-protected):

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/positioning/status` | DB health, date range, contract/obs counts |
| POST | `/api/positioning/init` | Seed DB with contracts + 2-year simulation |
| GET | `/api/positioning/dashboard?as_of=YYYY-MM-DD` | All 6 panels |
| GET | `/api/positioning/panel/{name}` | Single panel by name |
| GET | `/api/positioning/diagnostics?days=252` | Signal quality diagnostics |

If the DB does not exist, `GET /status` returns `{"initialised": false}` (not a 500 error).

**React frontend** (`PositioningTracker.tsx`): Six sub-components, one per panel. Dark theme (`#080d1a`). Bucket colour coding: whites = slate, reds = red, greens = green, blues = blue. Z-score colour scale: < −2 red, −2 to −1 orange, neutral grey, 1 to 2 light blue, > 2 deep blue.

---

## Configuration (`config/params.yaml`)

All tunable values in one place:

```yaml
signal:
  confidence_weight_cap: 2.0          # cap on |Δr|/σ weight
  ewma_vol_span: 60                    # span for EWMA volatility
  halflife_whites_days: 30
  halflife_reds_days: 45
  halflife_greens_days: 60
  halflife_blues_days: 90

expiry_drain:
  fraction_of_3m_peak: 0.10           # OI < 10% of peak → draining
  lookback_business_days: 63

quadrant:
  deadband_k: 0.30                    # price deadband: |Δr| < k × σ
  deadband_oi_fraction: 0.005
  short_covering_multiplier_max: 2.0
  short_covering_volume_threshold: 1.5
  short_covering_impact_threshold: 1.5

spreads:
  pack_cv_threshold: 0.30
  bundle_cv_threshold: 0.35
  pair_corr_threshold: 0.50
  pair_ratio_max: 1.50
  rolling_corr_window: 60

kalman:
  init_variance: 1.0e8                # large P0 = high initial uncertainty
  lambda_init: 0.95
  r2_threshold: 0.30                  # acceptance test

migration:
  ratio_lower: 0.70
  ratio_upper: 1.30
  min_estr_oi_change: 500

options:
  ecb_proximity_days: 2
  large_oi_move_pct: 0.02
  option_downweight: 0.3
```

---

## Running the tool

**Seed the DB** (first time or after clearing):
```bash
curl -X POST http://localhost:8000/api/positioning/init \
  -H "Authorization: Bearer <token>"
```

**Dashboard for a specific date**:
```bash
curl "http://localhost:8000/api/positioning/dashboard?as_of=2025-06-30" \
  -H "Authorization: Bearer <token>"
```

**With real ICE data** (CLI):
```bash
# After activating venv and cd to euribor_positioning package parent
euribor-positioning ingest-eod <file.csv> --trade-date 2025-06-30
euribor-positioning ingest-cot <file.csv> --report-date 2025-06-24   # must be a Tuesday
euribor-positioning check    # run §4.8 integrity checks
```

---

## Test coverage

127 tests across 10 test files in `euribor_positioning/tests/`:

| File | Tests | What is tested |
|------|-------|----------------|
| `test_integrity.py` | 9 | §4.8 integrity checks at ingestion |
| `test_rolls.py` | 7 | ΔOI partitioning, expiry drain, tenor bucketing, roll neutrality |
| `test_base_signal.py` | 23 | Direction estimator, confidence weights, decay accumulation, halflife calibration |
| `test_quadrants.py` | 13 | Soft assignment, deadband, short-covering multiplier |
| `test_spreads.py` | 12 | Bundle/pack/calendar detection, curve routing, no double-counting |
| `test_dv01.py` | 13 | 3-level DV01 report, CoG, vol scaling |
| `test_anchor.py` | 14 | Kalman predict/update, MLE convergence, R², COT timing discipline |
| `test_dashboard.py` | 14 | All 6 panels return valid JSON, panel isolation on error |
| `test_corrections.py` | 14 | Migration ratio detection, option delta flagging, flow_final |
| `test_integration.py` | 8 | Full API round-trip (TestClient), auth, init→dashboard→diagnostics |

Run from the macro-kit root (venv activated):
```bash
cd projects/macro-kit
pytest euribor_positioning/tests/ -v
```

---

## Key design decisions

**Why rate space?** Euribor futures prices move inversely with the rate. Working in rate space (`Δr = −Δprice`) means positive flow always corresponds to bullish (receiving) positioning, and the DV01 sign convention is consistent across the entire strip. The conversion happens once at ingestion.

**Why soft quadrant assignment?** A hard sign rule (e.g. "if Δr < 0 and ΔOI > 0 then long build") would create discontinuities at zero. Small moves near zero are genuinely ambiguous — the logistic function correctly assigns them high uncertainty (p ≈ 0.5) rather than forcing a false precision.

**Why Kalman rather than regression?** The COT report is low-frequency (weekly) and the flow signal is high-frequency (daily). The Kalman filter is the theoretically correct way to combine these two sources: it handles the mixed-frequency problem, propagates uncertainty, and allows the high-frequency signal to nowcast between COT publication dates. A simple OLS regression would require choosing a fixed lag and would not propagate uncertainty.

**Why not use COT directly?** The COT report has a 3-day publication lag and is low-frequency. It also only covers four broad investor categories and does not break down by tenor. The ΔOI signal provides daily tenor-level resolution; COT provides the absolute level anchor.
