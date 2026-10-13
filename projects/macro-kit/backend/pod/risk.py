"""
Book-level risk from the trade ledger: rate-risk aggregation, parametric
scenario P&L, limit checks, and sizing arithmetic.

Scope and honesty: this works from the `pnl_per_bp_k` each trade carries
(set at sizing), not from live positions or market data. It covers rate
trades in tenor buckets; FX and other trades are listed but carry no
scenario P&L until an FX/vol risk model exists. Scenarios are hypothetical
parametric shocks, not historical replays.
"""
from pathlib import Path

import yaml

from pod import book

LIMITS_FILE = Path(__file__).parent / "limits.yaml"
RATE_BUCKETS = ["2y", "5y", "10y", "30y"]

# Hypothetical shocks in bp by bucket (positive = yields up)
SCENARIOS: dict[str, dict[str, float]] = {
    "parallel_up_25": {"2y": 25, "5y": 25, "10y": 25, "30y": 25},
    "parallel_up_50": {"2y": 50, "5y": 50, "10y": 50, "30y": 50},
    "parallel_up_100": {"2y": 100, "5y": 100, "10y": 100, "30y": 100},
    "parallel_down_25": {"2y": -25, "5y": -25, "10y": -25, "30y": -25},
    "parallel_down_50": {"2y": -50, "5y": -50, "10y": -50, "30y": -50},
    "parallel_down_100": {"2y": -100, "5y": -100, "10y": -100, "30y": -100},
    "bear_steepener": {"2y": 10, "5y": 25, "10y": 40, "30y": 50},
    "bull_steepener": {"2y": -50, "5y": -35, "10y": -20, "30y": -10},
    "bear_flattener": {"2y": 50, "5y": 35, "10y": 20, "30y": 10},
    "bull_flattener": {"2y": -10, "5y": -25, "10y": -40, "30y": -50},
    "front_end_repricing_hawkish": {"2y": 40, "5y": 20, "10y": 8, "30y": 3},
    "front_end_repricing_dovish": {"2y": -40, "5y": -20, "10y": -8, "30y": -3},
    "long_end_term_premium_shock": {"2y": 0, "5y": 10, "10y": 30, "30y": 60},
}

DEFAULT_STATUSES = ["live", "pm_approved"]


def limits() -> dict:
    return yaml.safe_load(LIMITS_FILE.read_text(encoding="utf-8"))


def book_risk(statuses: list[str] | None = None, extra_trade_ids: list[int] | None = None) -> dict:
    """Aggregate risk for trades in `statuses` plus any `extra_trade_ids` (e.g. a trade being reviewed)."""
    statuses = statuses or DEFAULT_STATUSES
    trades = {t["id"]: t for t in book.list_trades(statuses=statuses, limit=500)}
    for tid in extra_trade_ids or []:
        trades.setdefault(tid, book.get(tid))

    by_bucket = dict.fromkeys(RATE_BUCKETS, 0.0)
    unsized, non_rate = [], []
    for t in trades.values():
        if t["pnl_per_bp_k"] is None:
            unsized.append(t["id"])
        elif t["bucket"] in by_bucket:
            by_bucket[t["bucket"]] += t["pnl_per_bp_k"]
        else:
            non_rate.append(t["id"])

    scenario_pnl = {name: round(sum(by_bucket[b] * shock[b] for b in RATE_BUCKETS), 1)
                    for name, shock in SCENARIOS.items()}
    worst = min(scenario_pnl.items(), key=lambda kv: kv[1])

    lim = limits()
    breaches = []
    for b in RATE_BUCKETS:
        cap = lim["max_abs_pnl_per_bp_k"].get(b)
        if cap is not None and abs(by_bucket[b]) > cap:
            breaches.append(f"{b} |P&L per bp| {abs(by_bucket[b]):.1f}k > limit {cap}k")
    total = sum(abs(v) for v in by_bucket.values())
    if total > lim["total_abs_pnl_per_bp_k"]:
        breaches.append(f"total |P&L per bp| {total:.1f}k > limit {lim['total_abs_pnl_per_bp_k']}k")
    if -worst[1] > lim["max_scenario_loss_k"]:
        breaches.append(f"worst scenario {worst[0]} loses {-worst[1]:.0f}k > limit {lim['max_scenario_loss_k']}k")
    for t in trades.values():
        if t["max_loss_k"] and t["max_loss_k"] > lim["max_single_trade_loss_k"]:
            breaches.append(f"trade #{t['id']} max loss {t['max_loss_k']:.0f}k > limit {lim['max_single_trade_loss_k']}k")
    live = sum(1 for t in trades.values() if t["status"] == "live")
    if live > lim["max_live_trades"]:
        breaches.append(f"{live} live trades > limit {lim['max_live_trades']}")

    return {
        "statuses_included": statuses,
        "trades": [{k: t[k] for k in ("id", "title", "status", "bucket", "risk_factor", "pnl_per_bp_k", "max_loss_k")}
                   for t in trades.values()],
        "pnl_per_bp_k_by_bucket": {b: round(v, 2) for b, v in by_bucket.items()},
        "total_abs_pnl_per_bp_k": round(total, 2),
        "scenario_pnl_k": scenario_pnl,
        "worst_scenario": {"name": worst[0], "pnl_k": worst[1]},
        "limit_breaches": breaches,
        "limits_are_placeholders": bool(lim.get("placeholder")),
        "unsized_trade_ids": unsized,
        "non_rate_trade_ids_without_scenario_pnl": non_rate,
        "caveat": "Parametric hypothetical shocks on sized ledger trades; no market data, correlations or FX/vol risk.",
    }


def size_from_stop(max_loss_k: float, stop_distance_bp: float, direction_sign: int) -> dict:
    """DV01-style size so the loss at the stop equals max_loss_k.

    direction_sign: -1 if the trade gains when yields fall (long duration / receiver), +1 if it gains when they rise.
    """
    if stop_distance_bp <= 0:
        raise ValueError("stop_distance_bp must be positive")
    per_bp = max_loss_k / stop_distance_bp
    return {"pnl_per_bp_k": round(per_bp * (1 if direction_sign > 0 else -1), 3), "max_loss_k": round(max_loss_k, 1),
            "method": "loss at stop = |P&L per bp| x stop distance"}


def size_from_vol(target_daily_vol_k: float, daily_vol_bp: float, direction_sign: int) -> dict:
    """Vol-target size: |P&L per bp| x daily vol (bp) = target daily P&L vol (k)."""
    if daily_vol_bp <= 0:
        raise ValueError("daily_vol_bp must be positive")
    per_bp = target_daily_vol_k / daily_vol_bp
    return {"pnl_per_bp_k": round(per_bp * (1 if direction_sign > 0 else -1), 3),
            "method": "|P&L per bp| x daily vol (bp) = target daily vol (k)"}
