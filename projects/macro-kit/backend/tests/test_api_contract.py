"""
API contract tests — pin the shape and values of every simulated-data GET
endpoint so refactors (router split, heatmap collapse, DataSource seam; see
docs/REFACTOR_PLAN.md) can be shown to be behaviour-preserving.

Each response is reduced to a compact *digest*: for every JSON path (list
indices collapsed to ``[]``) we record dict key sets, list lengths, numeric
count/sum/sum-of-squares/min/max and a hash of string values. Digests are
compared to ``snapshots/api_contract.json`` with a small relative tolerance.

Regenerate after an intentional change:
    UPDATE_SNAPSHOTS=1 pytest tests/test_api_contract.py
Include the slow fair-value-models endpoint (~45 s):
    RUN_SLOW=1 pytest tests/test_api_contract.py
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import warnings
from pathlib import Path

import pytest
import time_machine

from fastapi.testclient import TestClient

import main
from auth import get_current_user

SNAPSHOT = Path(__file__).parent / "snapshots" / "api_contract.json"
UPDATE = os.environ.get("UPDATE_SNAPSHOTS") == "1"
RUN_SLOW = os.environ.get("RUN_SLOW") == "1"
REL_TOL = 1e-6
# Endpoints default their as-of date to "today"; pin it so snapshots are stable.
FROZEN_NOW = "2026-06-30T12:00:00+00:00"
ABS_TOL = 1e-9

_REGIONS = ["euro-area", "uk", "us", "japan", "canada", "sweden",
            "norway", "switzerland", "australia", "new-zealand",
            "mexico", "china", "india", "brazil", "south-korea", "south-africa", "poland", "indonesia",
            "hungary", "czech-republic", "romania", "turkey", "israel", "chile",
            "colombia", "peru", "thailand", "malaysia", "philippines", "taiwan"]
_VIEWS = ["factors", "yield-pca", "pc-regressions", "fair-value"]

CASES: list[str] = (
    ["/api/dashboard"]
    + [f"/api/tools/{r}-heatmap/{v}" for r in _REGIONS for v in _VIEWS]
    + [f"/api/tools/heatmap/{r}" for r in _REGIONS]      # full dashboard payload
    + [
        "/api/tools/global-yields",
        "/api/tools/pca-analysis",
        "/api/tools/correlation-regimes/scan",
        "/api/tools/inflation-fixings/eur",
        "/api/tools/inflation-fixings/gbp",
        "/api/tools/inflation-fixings/usd",
        "/api/tools/egb-rv",
        "/api/tools/swaps-rv",
        "/api/tools/fitted-bond-curves",
        "/api/tools/fitted-bond-curves/new-issue?maturity=2035-02-15",
        "/api/tools/swap-spreads",
        "/api/tools/swap-spreads?target=JPY",
        "/api/tools/swap-spreads/bond?bond_id=JGB-10Y&target=USD",
        "/api/tools/swap-spreads/funding",
        "/api/tools/swap-spreads/funding?zero=true&btp_downgrade=true&settlement=cash",
        "/api/tools/option-cdf/USD/10y",
        "/api/tools/inflation-pca/dbrei",
        "/api/tools/momentum/cta-signals?ticker=TY1%20Comdty",
        "/api/tools/momentum/cta-signals?ticker=USGG10YR%20Index%20-%20USGG2YR%20Index&pctile_years=3",
        "/api/tools/momentum/monitor",
        "/api/tools/print-analysis/print-vs-consensus?ticker=NFP%20TCH%20Index",
    ]
)
SLOW_CASES: list[str] = ["/api/tools/fair-value-models"]

def _seasonality_series() -> dict:
    import numpy as np
    import pandas as pd
    d = pd.bdate_range("2018-01-01", "2023-12-29")
    v = 2.0 + np.cumsum(np.random.default_rng(7).normal(0, 0.03, len(d)))
    return {"dates": d.strftime("%Y-%m-%d").tolist(), "values": np.round(v, 4).tolist()}


_SEAS = _seasonality_series()
_MR = {"expression": "USGG10YR Index - USGG2YR Index", "start_date": "2018-01-01", "end_date": "2026-06-30"}
POST_CASES: list[tuple[str, dict]] = [
    ("/api/tools/mean-reversion/analyse", {**_MR, "model_type": "linear_ou", "n_sims": 2000}),
    ("/api/tools/mean-reversion/analyse", {**_MR, "model_type": "polynomial", "n_sims": 2000,
                                           "fit_start": "2020-01-01", "target": 0.5, "stop": -0.5}),
    ("/api/tools/mean-reversion/stanton", {**_MR, "n_buckets": 20}),
    ("/api/tools/mean-reversion/stanton", {**_MR, "n_buckets": 20, "sim_sde": "linear_ou"}),
    ("/api/tools/mean-reversion/stanton", {**_MR, "n_buckets": 15, "sim_sde": "inverse_polynomial"}),
    ("/api/tools/mean-reversion/forward-dist", {**_MR, "sim_sde": "linear_ou", "n_sims": 2000}),
    ("/api/tools/mean-reversion/sharpe-mc", {**_MR, "sim_sde": "polynomial", "n_sims": 2000}),
    ("/api/tools/mean-reversion/forward-hist", {**_MR, "sim_sde": "linear_ou", "n_sims": 2000,
                                                "target_date": "2026-12-31"}),
    ("/api/tools/seasonality/stats", _SEAS),
    ("/api/tools/seasonality/heatmap", _SEAS),
    ("/api/tools/seasonality/backtest", {**_SEAS, "rule": {"type": "dow", "bins": [0, 4], "direction": -1}}),
    ("/api/tools/seasonality/backtest", {**_SEAS, "rule": {"type": "tom", "bins": [-1, 1], "direction": 1}}),
    ("/api/tools/print-analysis/market-reaction", {
        "market_ticker": "GDBR10 Index",
        "releases": [{"period": f"2024-{m:02d}", "release_date": f"2024-{m:02d}-15", "surprise": (m - 6) / 10}
                     for m in range(1, 13)]}),
]


def _post_key(url: str, body: dict) -> str:
    return f"POST {url} {json.dumps(body, sort_keys=True)}"


# ---------------------------------------------------------------------------
# Digest
# ---------------------------------------------------------------------------

def _digest(obj) -> dict:
    out: dict[str, dict] = {}

    def node(path: str) -> dict:
        return out.setdefault(path, {})

    def walk(o, path: str) -> None:
        if isinstance(o, dict):
            n = node(path)
            n["keys"] = sorted(set(n.get("keys", [])) | set(o.keys()))
            for k, v in o.items():
                walk(v, f"{path}.{k}")
        elif isinstance(o, list):
            n = node(path)
            n["n_items"] = n.get("n_items", 0) + len(o)
            for v in o:
                walk(v, f"{path}[]")
        elif isinstance(o, bool):
            n = node(path)
            n["n_bool"] = n.get("n_bool", 0) + 1
            n["n_true"] = n.get("n_true", 0) + int(o)
        elif isinstance(o, (int, float)):
            n = node(path)
            x = float(o)
            if math.isfinite(x):
                n["n_num"] = n.get("n_num", 0) + 1
                n["sum"] = n.get("sum", 0.0) + x
                n["sumsq"] = n.get("sumsq", 0.0) + x * x
                n["min"] = min(n.get("min", x), x)
                n["max"] = max(n.get("max", x), x)
            else:
                n["n_nonfinite"] = n.get("n_nonfinite", 0) + 1
        elif isinstance(o, str):
            n = node(path)
            n["n_str"] = n.get("n_str", 0) + 1
            h = hashlib.sha1((n.get("str_sha1", "") + "\x00" + o).encode()).hexdigest()
            n["str_sha1"] = h
        elif o is None:
            n = node(path)
            n["n_null"] = n.get("n_null", 0) + 1
    walk(obj, "$")
    return out


def _close(a: float, b: float) -> bool:
    return math.isclose(a, b, rel_tol=REL_TOL, abs_tol=ABS_TOL * max(1.0, abs(a), abs(b)))


def _diff(expected: dict, actual: dict, limit: int = 15) -> list[str]:
    problems: list[str] = []
    for path in sorted(set(expected) | set(actual)):
        e, a = expected.get(path), actual.get(path)
        if e is None or a is None:
            problems.append(f"{path}: {'missing' if a is None else 'unexpected'}")
            continue
        for k in sorted(set(e) | set(a)):
            ev, av = e.get(k), a.get(k)
            if isinstance(ev, float) and isinstance(av, (int, float)):
                ok = _close(ev, float(av))
            else:
                ok = ev == av
            if not ok:
                problems.append(f"{path}.{k}: expected {ev!r}, got {av!r}")
        if len(problems) >= limit:
            break
    return problems


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def client():
    main.app.dependency_overrides[get_current_user] = lambda: {
        "username": "contract-test", "full_name": "Contract Test"}
    with warnings.catch_warnings(), time_machine.travel(FROZEN_NOW, tick=False):
        warnings.simplefilter("ignore")
        yield TestClient(main.app)
    main.app.dependency_overrides.clear()


@pytest.fixture(scope="module")
def snapshot():
    data = json.loads(SNAPSHOT.read_text()) if SNAPSHOT.exists() else {}
    yield data
    if UPDATE:
        SNAPSHOT.parent.mkdir(parents=True, exist_ok=True)
        SNAPSHOT.write_text(json.dumps(data, indent=1, sort_keys=True) + "\n")


def _check(client, snapshot, url: str, body: dict | None = None) -> None:
    key = url if body is None else _post_key(url, body)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        resp = client.get(url) if body is None else client.post(url, json=body)
    assert resp.status_code == 200, f"{key} -> {resp.status_code}: {resp.text[:300]}"
    actual = _digest(resp.json())
    if UPDATE:
        snapshot[key] = actual
        return
    assert key in snapshot, f"No snapshot for {key}; run with UPDATE_SNAPSHOTS=1"
    problems = _diff(snapshot[key], actual)
    assert not problems, f"{key} drifted from snapshot:\n  " + "\n  ".join(problems)


@pytest.mark.parametrize("url", CASES)
def test_contract(client, snapshot, url):
    _check(client, snapshot, url)


@pytest.mark.parametrize("url,body", POST_CASES, ids=[f"{u.rsplit('/', 1)[1]}-{i}" for i, (u, _) in enumerate(POST_CASES)])
def test_contract_post(client, snapshot, url, body):
    _check(client, snapshot, url, body)


@pytest.mark.skipif(not (RUN_SLOW or UPDATE), reason="slow endpoint; set RUN_SLOW=1")
@pytest.mark.parametrize("url", SLOW_CASES)
def test_contract_slow(client, snapshot, url):
    _check(client, snapshot, url)


# ---------------------------------------------------------------------------
# Input validation (bounded request bodies)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("body", [
    {**_MR, "sim_sde": "linear_ou", "n_sims": 10_000_000},     # over the cap
    {**_MR, "sim_sde": "not_a_model"},                          # unknown SDE
    {"sim_sde": "linear_ou"},                                   # missing expression
    {**_MR, "sim_sde": "linear_ou", "n_sims": "lots"},          # wrong type
])
def test_mean_reversion_rejects_bad_input(client, body):
    resp = client.post("/api/tools/mean-reversion/forward-dist", json=body)
    assert resp.status_code == 422, resp.text[:200]


# ---------------------------------------------------------------------------
# Transport
# ---------------------------------------------------------------------------

def test_large_responses_are_gzipped(client):
    resp = client.get("/api/tools/swaps-rv", headers={"Accept-Encoding": "gzip"})
    assert resp.status_code == 200
    assert resp.headers.get("content-encoding") == "gzip"


def test_gzip_never_buffers_sse():
    # GZipMiddleware must pass agent SSE streams through uncompressed; older
    # Starlette releases compressed (and so buffered) text/event-stream.
    from starlette.middleware import gzip
    assert "text/event-stream" in getattr(gzip, "DEFAULT_EXCLUDED_CONTENT_TYPES", ())


# ---------------------------------------------------------------------------
# Heatmaps: canonical /api/tools/heatmap/{region}/{view} == legacy URLs
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("region", _REGIONS)
@pytest.mark.parametrize("view", _VIEWS)
def test_heatmap_canonical_matches_legacy_snapshot(client, snapshot, region, view):
    if UPDATE:
        pytest.skip("canonical URLs are checked against the legacy snapshots")
    resp = client.get(f"/api/tools/heatmap/{region}/{view}")
    assert resp.status_code == 200
    problems = _diff(snapshot[f"/api/tools/{region}-heatmap/{view}"], _digest(resp.json()))
    assert not problems, "\n".join(problems)


@pytest.mark.parametrize("url", [
    "/api/tools/heatmap/atlantis/factors",
    "/api/tools/heatmap/uk/not-a-view",
    "/api/tools/atlantis-heatmap/factors",
])
def test_heatmap_rejects_unknown_region_or_view(client, url):
    assert client.get(url).status_code == 422


@pytest.mark.parametrize("url,body", [
    ("/api/tools/seasonality/stats", {"dates": ["2024-01-02", "2024-01-03"], "values": [1.0]}),   # length mismatch
    ("/api/tools/seasonality/backtest", {**_SEAS, "rule": {"type": "lunar", "bins": [0], "direction": 1}}),
    ("/api/tools/seasonality/backtest", {**_SEAS, "rule": {"type": "dow", "bins": [0], "direction": 3}}),
    ("/api/tools/print-analysis/market-reaction", {"releases": []}),                              # no ticker
])
def test_dict_payload_routes_reject_bad_input(client, url, body):
    assert client.post(url, json=body).status_code == 422


def test_live_only_endpoint_without_bloomberg_is_503(client):
    resp = client.get("/api/tools/seasonality/data", params={"expression": "GDBR10 Index"})
    assert resp.status_code == 503
    assert "Bloomberg" in resp.json()["detail"]
