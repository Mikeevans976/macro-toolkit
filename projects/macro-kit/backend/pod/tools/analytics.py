"""
Analytics tools: thin wrappers over the macro-kit backend modules.

Handlers call the same functions the dashboard API routes use (in-process,
no HTTP). Returned objects are compacted by the registry, so handlers only
pre-select and sort what matters; they don't format text.

Every payload keeps the module's `data_source` / `as_of` fields where they
exist, so agents can tell live Bloomberg data from simulation.
"""
import threading
import time

from pod.tools import Tool, register, schema


def _bloomberg_connected() -> bool:
    try:
        import blpapi  # noqa: F401
        return True
    except ImportError:
        return False


_BBG = _bloomberg_connected()


def _source(data: dict) -> str:
    """The payload's own data_source, else what the module falls back to without blpapi."""
    if data.get("data_source"):
        return data["data_source"]
    if data.get("simulation_mode") is True:
        return "simulation"
    return "bloomberg" if _BBG else "simulation (Bloomberg not connected)"

# ---------------------------------------------------------------------------
# Regional heatmaps (DFM factors, fair value, PC regressions, yield PCA)
# ---------------------------------------------------------------------------

# region code → slug in heatmap_regions.REGIONS (the shared regional heatmap engine)
_REGIONS = {
    "EA": "euro-area", "UK": "uk", "US": "us", "JP": "japan", "CA": "canada",
    "SE": "sweden", "NO": "norway", "CH": "switzerland", "AU": "australia", "NZ": "new-zealand",
    "MX": "mexico", "CN": "china", "IN": "india", "BR": "brazil", "KR": "south-korea",
    "ZA": "south-africa", "PL": "poland", "ID": "indonesia",
    "HU": "hungary", "CZ": "czech-republic", "RO": "romania", "TR": "turkey", "IL": "israel",
    "CL": "chile", "CO": "colombia", "PE": "peru", "TH": "thailand", "MY": "malaysia",
    "PH": "philippines", "TW": "taiwan",
}
_REGION_ENUM = list(_REGIONS)
_ENGINES: dict = {}
_ENGINES_LOCK = threading.Lock()


def _region_fn(region: str, kind: str):
    """Bound method `get_<kind>` of the region's RegionalHeatmap engine (built once, then cached)."""
    if region not in _REGIONS:
        raise ValueError(f"Unknown region {region!r}. Use one of {_REGION_ENUM}")
    with _ENGINES_LOCK:
        if region not in _ENGINES:
            from heatmap_regions import REGIONS
            from regional_heatmap import RegionalHeatmap
            _ENGINES[region] = RegionalHeatmap(REGIONS[_REGIONS[region]])
    return getattr(_ENGINES[region], f"get_{kind}")


def macro_factors(regions: list[str] | None = None) -> dict:
    out = {}
    for region in regions or _REGION_ENUM:
        get = _region_fn(region, "daily_factors")
        data = get()
        dates = list(data.dates)
        snap = {}
        for name, vals in data.factors.items():
            vals = list(vals)
            if not vals:
                continue
            snap[name] = {
                "latest": vals[-1],
                "chg_1m": vals[-1] - vals[-22] if len(vals) > 22 else None,
                "chg_3m": vals[-1] - vals[-64] if len(vals) > 64 else None,
            }
        out[region] = {"as_of": dates[-1] if dates else None, "data_source": get.__self__.macro_source,
                       "factors": snap}
    return out


register(Tool(
    name="macro_factors",
    description=(
        "Latest dynamic-factor-model (DFM) macro factor scores with 1m and 3m changes, per region. "
        "Every region has Global Macro, Growth and Inflation; DM regions add Employment and Wages; "
        "EM regions add whichever of Employment, Wages, External (trade, reserves, FX) and Credit "
        "(China) their data support. Regions: " + ", ".join(_REGION_ENUM) + ". Omit `regions` for all."
    ),
    input_schema=schema({
        "regions": {"type": "array", "items": {"type": "string", "enum": _REGION_ENUM}},
    }),
    handler=macro_factors,
))


def macro_fair_value(region: str, view: str = "fair_value") -> object:
    kind = {"fair_value": "fair_value", "pc_regressions": "pc_regressions", "yield_pca": "yield_pca"}[view]
    return _region_fn(region, kind)()


register(Tool(
    name="macro_fair_value",
    description=(
        "Macro fair value of a region's benchmark 10y yield. view='fair_value': actual vs "
        "PCA reconstruction vs macro fair value, rich/cheap. view='pc_regressions': OLS of "
        "yield PCs on macro factors. view='yield_pca': yield PC scores, loadings, explained variance."
    ),
    input_schema=schema({
        "region": {"type": "string", "enum": _REGION_ENUM},
        "view": {"type": "string", "enum": ["fair_value", "pc_regressions", "yield_pca"]},
    }, ["region"]),
    handler=macro_fair_value,
))

# ---------------------------------------------------------------------------
# Rates RV
# ---------------------------------------------------------------------------

def _top_by_abs_z(rows: list[dict], top_n: int, key: str = "zscore_1y") -> list[dict]:
    return sorted(rows, key=lambda r: abs(r.get(key) or 0), reverse=True)[:top_n]


def swaps_rv(currency: str = "EUR", top_n: int = 15, as_of_date: str | None = None) -> dict:
    from swaps_rv import compute_rv
    data = compute_rv(currency=currency, as_of_date=as_of_date)
    return {
        "as_of": data.get("as_of"),
        "data_source": _source(data),
        "currency": currency,
        "top_by_abs_zscore": _top_by_abs_z(data.get("rv_monitor", []), top_n),
    }


register(Tool(
    name="swaps_rv",
    description=(
        "Swap curve and fly relative value monitor: level (bp), 1y z-score and percentile, "
        "1y carry+roll, carry/vol ratio. Returns the structures with the largest |z-score|."
    ),
    input_schema=schema({
        "currency": {"type": "string", "description": "Swap currency, default EUR"},
        "top_n": {"type": "integer", "minimum": 1, "maximum": 40},
        "as_of_date": {"type": "string", "description": "YYYY-MM-DD; default latest"},
    }),
    handler=swaps_rv,
))


def egb_rv(top_n: int = 15, use_individual_bonds: bool = False, as_of_date: str | None = None) -> dict:
    from egb_rv import compute_egb_rv
    data = compute_egb_rv(as_of_date=as_of_date, use_individual_bonds=use_individual_bonds)
    return {
        "as_of": data.get("as_of"),
        "data_source": _source(data),
        "top_by_abs_zscore": _top_by_abs_z(data.get("rv_monitor", []), top_n),
    }


register(Tool(
    name="egb_rv",
    description=(
        "Euro government bond RV: country spread curves, cross-country flies and spreads vs "
        "swaps, with level, 1y z-score, percentile and carry. Set use_individual_bonds=true "
        "to use specific bonds instead of generic yields."
    ),
    input_schema=schema({
        "top_n": {"type": "integer", "minimum": 1, "maximum": 40},
        "use_individual_bonds": {"type": "boolean"},
        "as_of_date": {"type": "string", "description": "YYYY-MM-DD; default latest"},
    }),
    handler=egb_rv,
))


def egb_bond_finder(country: str, target_years: list[int], as_of_date: str | None = None) -> dict:
    from egb_bond_finder import build_egb_bond_map
    return build_egb_bond_map({country: target_years}, as_of_date=as_of_date)


register(Tool(
    name="egb_bond_finder",
    description=(
        "Find the individual government bond closest to each target maturity for a country "
        "(e.g. country='Italy', target_years=[2, 5, 10, 30])."
    ),
    input_schema=schema({
        "country": {"type": "string"},
        "target_years": {"type": "array", "items": {"type": "integer"}},
        "as_of_date": {"type": "string"},
    }, ["country", "target_years"]),
    handler=egb_bond_finder,
))

# ---------------------------------------------------------------------------
# Inflation
# ---------------------------------------------------------------------------

def inflation_fixings(markets: list[str] | None = None, n_months: int = 6) -> dict:
    from hicp_fixings import get_hicp_fixings
    from rpi_fixings import get_rpi_fixings
    from us_cpi_fixings import get_us_cpi_fixings
    fns = {"EUR": get_hicp_fixings, "GBP": get_rpi_fixings, "USD": get_us_cpi_fixings}
    out = {}
    for m in markets or list(fns):
        data = fns[m]()
        out[m] = {
            "as_of": data.get("as_of_date"),
            "data_source": data.get("data_source"),
            "fixings": data.get("fixings", [])[:n_months],
        }
    return out


register(Tool(
    name="inflation_fixings",
    description=(
        "Swap-implied monthly inflation fixings: EUR HICPxT, GBP RPI, USD CPI. Implied YoY, "
        "MoM seasonally adjusted, for the next n_months fixings."
    ),
    input_schema=schema({
        "markets": {"type": "array", "items": {"type": "string", "enum": ["EUR", "GBP", "USD"]}},
        "n_months": {"type": "integer", "minimum": 1, "maximum": 24},
    }),
    handler=inflation_fixings,
))


# The elastic-net fits take over a minute; cache them for 30 minutes.
_FVM_CACHE: dict = {}
_FVM_LOCK = threading.Lock()


def _fvm_data() -> dict:
    from fair_value_models import get_fair_value_models_data
    with _FVM_LOCK:
        if not _FVM_CACHE or time.time() - _FVM_CACHE["at"] > 1800:
            _FVM_CACHE.update(at=time.time(), data=get_fair_value_models_data())
        return _FVM_CACHE["data"]


def fair_value_models(model_id: str | None = None) -> dict:
    data = _fvm_data()
    if model_id is None:
        return {"data_source": data.get("data_source"), "model_ids": data.get("model_ids"),
                "hint": "Call again with model_id for one model's fit, residual and drivers."}
    if model_id not in data.get("models", {}):
        raise ValueError(f"Unknown model_id {model_id!r}. Options: {data.get('model_ids')}")
    return {"data_source": data.get("data_source"), "model_id": model_id, **data["models"][model_id]}


register(Tool(
    name="fair_value_models",
    description=(
        "Rolling elastic-net fair value models for EUR HICPxT inflation swaps (spot and forward "
        "tenors). Call without model_id to list models, then with model_id for one model."
    ),
    input_schema=schema({"model_id": {"type": "string"}}),
    handler=fair_value_models,
))


def inflation_pca(curve_id: str) -> dict:
    from inflation_pca import get_inflation_pca_data
    return get_inflation_pca_data(curve_id)


register(Tool(
    name="inflation_pca",
    description=(
        "PCA-neutral butterfly analysis on an inflation-linked bond curve "
        "(e.g. curve_id='dbrei'; invalid ids return the list of valid ones)."
    ),
    input_schema=schema({"curve_id": {"type": "string"}}, ["curve_id"]),
    handler=inflation_pca,
))

# ---------------------------------------------------------------------------
# Curve structure
# ---------------------------------------------------------------------------

def pca_analysis(curve: str = "bund", tenors: list[int] | None = None, n_factors: int = 3,
                 use_changes: bool = False, start_date: str | None = None) -> dict:
    from pca_analysis import get_pca_data
    return get_pca_data(curve_id=curve, tenors=tenors or [2, 5, 7, 10], n_factors=n_factors,
                        use_changes=use_changes, start_date=start_date)


register(Tool(
    name="pca_analysis",
    description=(
        "PCA on a yield curve: eigenvalues, loadings, factor scores, residuals per tenor and "
        "OU mean-reversion stats on residuals. Default curve 'bund', tenors [2,5,7,10]."
    ),
    input_schema=schema({
        "curve": {"type": "string"},
        "tenors": {"type": "array", "items": {"type": "integer"}},
        "n_factors": {"type": "integer", "minimum": 1, "maximum": 5},
        "use_changes": {"type": "boolean"},
        "start_date": {"type": "string"},
    }),
    handler=pca_analysis,
))


def fitted_bond_curves(as_of: str = "", functional_form: str = "cubic_spline") -> dict:
    from fitted_bond_curves import compute_fitted_curve
    data = compute_fitted_curve(functional_form=functional_form, as_of=as_of)
    bonds = sorted(data.get("bonds", []), key=lambda b: abs(b.get("residual_bp") or 0), reverse=True)
    return {k: v for k, v in data.items() if k not in ("bonds", "curve")} | {"bonds_by_abs_residual": bonds}


register(Tool(
    name="fitted_bond_curves",
    description=(
        "Fitted Bund discount curve (Hagan-West style spline): fit quality, rich/cheap residual "
        "per bond (sorted by |residual|), benchmark bonds."
    ),
    input_schema=schema({
        "as_of": {"type": "string", "description": "YYYY-MM-DD; default latest"},
        "functional_form": {"type": "string"},
    }),
    handler=fitted_bond_curves,
))


def fitted_bond_detail(bond_id: str, as_of: str = "") -> dict:
    from fitted_bond_curves import get_bond_detail
    return get_bond_detail(bond_id=bond_id, as_of=as_of)


register(Tool(
    name="fitted_bond_detail",
    description="Residual history, OU mean-reversion analysis and forward fan for one bond on the fitted curve.",
    input_schema=schema({"bond_id": {"type": "string"}, "as_of": {"type": "string"}}, ["bond_id"]),
    handler=fitted_bond_detail,
))


def new_issue_pricing(maturity: str, coupon: float | None = None, size_bn: float = 20.0) -> dict:
    from fitted_bond_curves import predict_new_issue
    return predict_new_issue(maturity=maturity, coupon=coupon, size_bn=size_bn)


register(Tool(
    name="new_issue_pricing",
    description="Fair yield for a hypothetical new bond issue off the fitted curve (maturity as YYYY-MM-DD).",
    input_schema=schema({
        "maturity": {"type": "string"},
        "coupon": {"type": "number"},
        "size_bn": {"type": "number"},
    }, ["maturity"]),
    handler=new_issue_pricing,
))


def global_yields() -> dict:
    from global_yields import get_global_yields_data
    return get_global_yields_data()


register(Tool(
    name="global_yields",
    description=(
        "Factor model for global 10y yields (Global / DM / EM factors): explained variance, "
        "country residuals and fair-value table."
    ),
    input_schema=schema(),
    handler=global_yields,
))


def mean_reversion(expression: str, start_date: str = "2018-01-01", model_type: str = "linear_ou",
                   target: float | None = None, stop: float | None = None) -> dict:
    from mean_reversion import analyse
    return analyse(expression=expression, start_date=start_date, model_type=model_type,
                   target=target, stop=stop, n_sims=2000)


register(Tool(
    name="mean_reversion",
    description=(
        "Fit an Ornstein-Uhlenbeck (or related) model to a Bloomberg expression, e.g. "
        "'GDBR10 Index - GDBR2 Index': half-life, long-run mean, current deviation, hit "
        "probabilities for an optional target and stop, simulated Sharpe."
    ),
    input_schema=schema({
        "expression": {"type": "string"},
        "start_date": {"type": "string"},
        "model_type": {"type": "string"},
        "target": {"type": "number"},
        "stop": {"type": "number"},
    }, ["expression"]),
    handler=mean_reversion,
))

# ---------------------------------------------------------------------------
# Options / probabilities
# ---------------------------------------------------------------------------

def option_implied_cdf(ccy: str, tail: str) -> dict:
    from option_derived_cdf import get_option_cdf_params
    return get_option_cdf_params(ccy, tail)


register(Tool(
    name="option_implied_cdf",
    description=(
        "Swaption-implied distribution parameters by expiry for an underlying swap tail "
        "(e.g. ccy='EUR', tail='10y'). Use to read what the options market prices."
    ),
    input_schema=schema({"ccy": {"type": "string"}, "tail": {"type": "string"}}, ["ccy", "tail"]),
    handler=option_implied_cdf,
))

# ---------------------------------------------------------------------------
# Positioning / technicals / regimes
# ---------------------------------------------------------------------------

_CTA_ROW_KEYS = ("id", "label", "group", "last", "chg_1w", "regime", "direction", "stretched",
                 "position", "position_chg_1w", "flip_price", "flip_sigma", "flow_flat_1w",
                 "notional_usd", "flow_flat_1w_usd", "flow_adv_pct")


def cta_momentum(tickers: list[str] | None = None, group: str | None = None) -> dict:
    """Without tickers: the cross-asset monitor (model CTA positions, regimes,
    flows, sector totals, calibration). With tickers: per-series detail."""
    from momentum import compute_cta_signals, get_monitor
    if tickers:
        out = {}
        for t in tickers:
            try:
                d = compute_cta_signals(t)
            except (LookupError, ValueError) as e:
                out[t] = {"error": str(e)}
                continue
            out[t] = {"data_source": d["data_source"], "kind": d["kind"], **d["current"],
                      "triggers": d["triggers"],
                      "scenarios_1w": [s for s in d["scenarios"] if s["horizon_days"] == 5]}
        return out
    mon = get_monitor()
    rows = [{k: r[k] for k in _CTA_ROW_KEYS} for r in mon["rows"]
            if group is None or r["group"].lower().startswith(group.lower())]
    return {"data_source": mon["data_source"], "as_of": mon["as_of"], "note": mon["note"],
            "model": mon["model"], "calibration": mon["calibration"], "sectors": mon["sectors"],
            "model_pnl_1m_pct": mon["pnl"]["model_1m"], "rows": rows}


register(Tool(
    name="cta_momentum",
    description=(
        "CTA trend-following model. With no tickers: cross-asset monitor of ~70 markets (bond, "
        "STIR, FX, equity, commodity futures plus yields and curves): trend regime (Strong "
        "momentum / Momentum / Fading / Reversal / Range / Mixed), model CTA position (% of max), "
        "1w change, next-day flip level, flat-price 1w flow and $ notional, sector totals and the "
        "fit to the SG Trend Index. Optional group filter ('Bond', 'Equity', 'FX', 'Commodity', "
        "'Yields', 'Curves', 'STIR'). With tickers (any Bloomberg expression, e.g. 'TY1 Comdty', "
        "'USGG10YR Index - USGG2YR Index'): per-series signals, triggers and 1w scenarios."
    ),
    input_schema=schema({"tickers": {"type": "array", "items": {"type": "string"}},
                         "group": {"type": "string"}}),
    handler=cta_momentum,
))


def correlation_regimes(top_n: int = 10, long_window: int | None = None,
                        short_window: int | None = None, min_abs_corr: float | None = None) -> dict:
    from correlation_regimes import run_scan
    data = run_scan(long_window=long_window, short_window=short_window, min_abs_corr=min_abs_corr)
    labels = {s["id"]: s["label"] for s in data.get("series", [])}
    pairs = []
    for p in data.get("pairs", [])[:top_n]:
        pairs.append({**p, "label1": labels.get(p.get("series1")), "label2": labels.get(p.get("series2"))})
    return {k: data.get(k) for k in ("as_of", "data_source", "long_window", "short_window",
                                     "n_pairs_total", "n_pairs_qualified")} | {"top_breaks": pairs}


register(Tool(
    name="correlation_regimes",
    description=(
        "Cross-asset correlation-break scan: pairs whose recent correlation departs most from "
        "the regime correlation (Fisher-z), including sign flips."
    ),
    input_schema=schema({
        "top_n": {"type": "integer", "minimum": 1, "maximum": 40},
        "long_window": {"type": "integer"},
        "short_window": {"type": "integer"},
        "min_abs_corr": {"type": "number"},
    }),
    handler=correlation_regimes,
))


def correlation_pair(x: str, y: str) -> dict:
    from correlation_regimes import get_pair_detail
    return get_pair_detail(x=x, y=y)


register(Tool(
    name="correlation_pair",
    description="Rolling correlation and beta history for one pair of series ids from correlation_regimes.",
    input_schema=schema({"x": {"type": "string"}, "y": {"type": "string"}}, ["x", "y"]),
    handler=correlation_pair,
))


def euribor_positioning(as_of: str | None = None) -> dict:
    from datetime import date
    from euribor_positioning_router import _db_status, _get_conn, _get_params, build_dashboard
    status = _db_status()
    if not status["initialised"]:
        raise RuntimeError("Euribor positioning DB not initialised (POST /api/positioning/init).")
    as_of_date = date.fromisoformat(as_of or status["last_knowledge_date"] or date.today().isoformat())
    with _get_conn() as conn:
        return build_dashboard(conn, as_of_date, _get_params(), instrument="euribor")


register(Tool(
    name="euribor_positioning",
    description=(
        "Euribor futures positioning tracker dashboard: estimated positioning by contract and "
        "participant type, COT, flows and crowding signals."
    ),
    input_schema=schema({"as_of": {"type": "string", "description": "YYYY-MM-DD; default latest"}}),
    handler=euribor_positioning,
    max_chars=8000,
))

# ---------------------------------------------------------------------------
# Data releases / seasonality
# ---------------------------------------------------------------------------

def print_vs_consensus(ticker: str, start: str = "2015-01-01") -> dict:
    from print_analysis import fetch_print_vs_consensus
    return fetch_print_vs_consensus(ticker=ticker, start=start)


register(Tool(
    name="print_vs_consensus",
    description=(
        "History of an economic release vs Bloomberg survey consensus (surprises), e.g. "
        "ticker='UKPRIC YOY Index'."
    ),
    input_schema=schema({"ticker": {"type": "string"}, "start": {"type": "string"}}, ["ticker"]),
    handler=print_vs_consensus,
))


def seasonality(expression: str, start: str = "2010-01-01", rule: dict | None = None) -> dict:
    from seasonality_backtester import fetch_bbg_expression, get_seasonality_stats, run_seasonality_backtest
    series = fetch_bbg_expression(expression, start=start)
    dates, values = series["dates"], series["values"]
    out = {"expression": expression, "data_source": series.get("data_source"),
           "stats": get_seasonality_stats(dates, values)}
    if rule:
        out["backtest"] = run_seasonality_backtest(dates, values, rule)
    return out


register(Tool(
    name="seasonality",
    description=(
        "Seasonal statistics of a Bloomberg expression (by month, day of week, turn of month, "
        "quarter end). Optionally backtest a rule: {type: dow|month|dom_quintile|tom|quarter_end, "
        "bins: [ints], direction: 1|-1}."
    ),
    input_schema=schema({
        "expression": {"type": "string"},
        "start": {"type": "string"},
        "rule": {
            "type": "object",
            "properties": {
                "type": {"type": "string", "enum": ["dow", "month", "dom_quintile", "tom", "quarter_end"]},
                "bins": {"type": "array", "items": {"type": "integer"}},
                "direction": {"type": "integer", "enum": [1, -1]},
            },
            "required": ["type", "bins", "direction"],
            "additionalProperties": False,
        },
    }, ["expression"]),
    handler=seasonality,
))
