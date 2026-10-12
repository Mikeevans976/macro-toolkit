"""
CrewAI tool wrappers around existing analytics functions.

Each tool imports and calls the underlying Python function directly
(no HTTP round-trip — same process as FastAPI).  The _run() method
returns a compact text summary sized for LLM context (~1-2k chars).
"""
import json
import sys
import os
from pathlib import Path
from typing import Type

from crewai.tools import BaseTool
from pydantic import BaseModel, Field

# Ensure backend/ is importable regardless of working directory
_BACKEND_DIR = Path(__file__).parent.parent
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))


# ---------------------------------------------------------------------------
# Input schemas
# ---------------------------------------------------------------------------

class _Query(BaseModel):
    query: str = Field(
        default="current",
        description="Aspect to focus on, e.g. 'EUR macro outlook' or 'current'",
    )


# ---------------------------------------------------------------------------
# Tool 1: Macro Heatmap  (Macro Strategist)
# ---------------------------------------------------------------------------

class MacroHeatmapTool(BaseTool):
    name: str = "Macro Factor Heatmap"
    description: str = (
        "Returns the latest DFM macro factor scores (GlobalMacro, Growth, Inflation, "
        "Employment, Wages) for EUR, GBP, USD, and JPY rate markets. "
        "Use this to form a top-down macro view on rates direction."
    )
    args_schema: Type[BaseModel] = _Query

    def _run(self, query: str = "current") -> str:
        try:
            from euro_area_heatmap import get_daily_factors as ea_factors
            from uk_heatmap import get_uk_daily_factors as uk_factors
            from us_heatmap import get_us_daily_factors as us_factors
            from japan_heatmap import get_jp_daily_factors as jp_factors

            results = {}
            for label, fn in [("EUR", ea_factors), ("GBP", uk_factors),
                               ("USD", us_factors), ("JPY", jp_factors)]:
                data = fn()
                latest_idx = -1
                latest_date = data.dates[latest_idx] if data.dates else "N/A"
                factor_snapshot = {
                    name: round(float(vals[latest_idx]), 3)
                    for name, vals in data.factors.items()
                    if vals
                }
                results[label] = {"date": latest_date, "factors": factor_snapshot}

            lines = ["MACRO FACTOR SNAPSHOT (latest available date):"]
            for ccy, info in results.items():
                lines.append(f"\n{ccy} [{info['date']}]:")
                for factor, val in info["factors"].items():
                    direction = "↑" if val > 0.3 else ("↓" if val < -0.3 else "→")
                    lines.append(f"  {factor}: {val:+.3f} {direction}")
            return "\n".join(lines)
        except Exception as exc:
            return f"MacroHeatmapTool error: {exc}"


# ---------------------------------------------------------------------------
# Tool 2: Swaps RV Scanner  (RV Analyst)
# ---------------------------------------------------------------------------

class SwapsRVTool(BaseTool):
    name: str = "Swaps RV Scanner"
    description: str = (
        "Scans EUR ESTR swap curves and flies for relative value. "
        "Returns the top opportunities ranked by 1y z-score and carry/vol ratio. "
        "Use this to identify mispriced curve structures in rates."
    )
    args_schema: Type[BaseModel] = _Query

    def _run(self, query: str = "current") -> str:
        try:
            from swaps_rv import compute_rv

            data = compute_rv(currency="EUR")
            rv = data.get("rv_monitor", [])
            as_of = data.get("as_of", "N/A")

            # Sort by absolute z-score descending
            rv_sorted = sorted(rv, key=lambda x: abs(x.get("zscore_1y", 0)), reverse=True)
            top = rv_sorted[:12]

            lines = [f"EUR SWAPS RV MONITOR (as of {as_of}):"]
            lines.append(f"{'Label':<14} {'Val(bp)':>8} {'Z-1y':>7} {'Pctl':>6} {'Carry':>7} {'C/V':>6}")
            lines.append("-" * 56)
            for r in top:
                lines.append(
                    f"{r['label']:<14} {r['value_bps']:>8.1f} {r['zscore_1y']:>7.2f} "
                    f"{r['pctile_1y']:>6.0f} {r['carry1y_bps']:>7.1f} "
                    f"{(r['carry_vol_ratio'] or 0):>6.2f}"
                )
            return "\n".join(lines)
        except Exception as exc:
            return f"SwapsRVTool error: {exc}"


# ---------------------------------------------------------------------------
# Tool 3: EGB RV Scanner  (RV Analyst)
# ---------------------------------------------------------------------------

class EGBRVTool(BaseTool):
    name: str = "EGB RV Scanner"
    description: str = (
        "Scans Euro Government Bond (EGB) relative value — spread curves, "
        "cross-country flies, and country-specific cheapness. "
        "Use this alongside Swaps RV to find government bond opportunities."
    )
    args_schema: Type[BaseModel] = _Query

    def _run(self, query: str = "current") -> str:
        try:
            from egb_rv import compute_egb_rv

            data = compute_egb_rv()
            as_of = data.get("as_of", "N/A")
            rv = data.get("rv_monitor", [])
            if not rv:
                return f"EGB RV: no data available (as_of={as_of})"

            rv_sorted = sorted(rv, key=lambda x: abs(x.get("zscore_1y", 0)), reverse=True)
            top = rv_sorted[:12]

            lines = [f"EGB RV MONITOR (as of {as_of}):"]
            lines.append(f"{'Label':<18} {'Val(bp)':>8} {'Z-1y':>7} {'Pctl':>6} {'Carry':>7}")
            lines.append("-" * 54)
            for r in top:
                lines.append(
                    f"{r['label']:<18} {r['value_bps']:>8.1f} {r['zscore_1y']:>7.2f} "
                    f"{r['pctile_1y']:>6.0f} {r['carry1y_bps']:>7.1f}"
                )
            return "\n".join(lines)
        except Exception as exc:
            return f"EGBRVTool error: {exc}"


# ---------------------------------------------------------------------------
# Tool 4: Inflation Monitor  (Inflation Watcher)
# ---------------------------------------------------------------------------

class InflationTool(BaseTool):
    name: str = "Inflation Fixings Monitor"
    description: str = (
        "Returns EUR HICP, GBP RPI, and USD CPI implied fixings from swap markets. "
        "Shows YoY rates, MoM seasonally-adjusted, and trend vs prior months. "
        "Use this to assess inflation market pricing."
    )
    args_schema: Type[BaseModel] = _Query

    def _run(self, query: str = "current") -> str:
        try:
            from hicp_fixings import get_hicp_fixings
            from rpi_fixings import get_rpi_fixings
            from us_cpi_fixings import get_us_cpi_fixings

            lines = ["INFLATION FIXINGS SNAPSHOT:"]

            for label, fn in [("EUR HICP-XT", get_hicp_fixings),
                               ("GBP RPI", get_rpi_fixings),
                               ("USD CPI", get_us_cpi_fixings)]:
                try:
                    data = fn()
                    fixings = data.get("fixings", [])[:6]
                    as_of = data.get("as_of_date", "N/A")
                    lines.append(f"\n{label} (as of {as_of}):")
                    lines.append(f"  {'Month':<10} {'YoY%':>6} {'MoM SA%':>8}")
                    for f in fixings:
                        month = f.get("calendar_month", "N/A")
                        yoy = f.get("yoy_implied", 0) or 0
                        mom_sa = f.get("mom_sa", 0) or 0
                        lines.append(f"  {month:<10} {yoy:>6.2f} {mom_sa:>8.3f}")
                except Exception as inner_exc:
                    lines.append(f"\n{label}: error — {inner_exc}")

            return "\n".join(lines)
        except Exception as exc:
            return f"InflationTool error: {exc}"


# ---------------------------------------------------------------------------
# Tool 5: Momentum / CTA Signals  (Positioning Monitor)
# ---------------------------------------------------------------------------

_MOMENTUM_TICKERS = [
    "GTEEUR10Y",   # EUR 10y
    "GTGBP10Y",    # GBP 10y
    "GTDEM2Y",     # EUR 2y
    "USGG10YR",    # USD 10y
    "USGG2YR",     # USD 2y
]

class MomentumTool(BaseTool):
    name: str = "CTA Momentum Signals"
    description: str = (
        "Returns multi-lookback CTA trend signals for key G10 rate instruments. "
        "Each signal is +1 (long), -1 (short), or 0 (neutral). "
        "Use this to understand systematic positioning pressure."
    )
    args_schema: Type[BaseModel] = _Query

    def _run(self, query: str = "current") -> str:
        try:
            from momentum import compute_cta_signals

            def fmt(v):
                if v is None:
                    return "  N/A"
                return f"{v:>5.2f}"

            lines = ["CTA MOMENTUM SIGNALS (1M / 3M / 6M / 12M | composite):"]
            lines.append(f"{'Ticker':<14} {'1M':>6} {'3M':>6} {'6M':>6} {'12M':>6} {'Composite':>10} {'Label':<12}")
            lines.append("-" * 66)

            for ticker in _MOMENTUM_TICKERS:
                data = compute_cta_signals(ticker)
                cur = data.get("current", {})
                sigs = cur.get("signals", {})
                composite = cur.get("composite")
                label = cur.get("label", "")
                row = (
                    f"{ticker:<14} "
                    f"{fmt(sigs.get('1M')):>6} "
                    f"{fmt(sigs.get('3M')):>6} "
                    f"{fmt(sigs.get('6M')):>6} "
                    f"{fmt(sigs.get('12M')):>6} "
                    f"{fmt(composite):>10} "
                    f"{label:<12}"
                )
                lines.append(row)

            return "\n".join(lines)
        except Exception as exc:
            return f"MomentumTool error: {exc}"


# ---------------------------------------------------------------------------
# Tool 6: Correlation Regimes  (Positioning Monitor)
# ---------------------------------------------------------------------------

class CorrelationRegimesTool(BaseTool):
    name: str = "Correlation Regime Scanner"
    description: str = (
        "Scans for pairs of rate instruments where the recent correlation has "
        "broken down vs. the prior regime. Returns pairs with the largest "
        "correlation shift and their z-stat. "
        "Use this to flag cross-market dislocation."
    )
    args_schema: Type[BaseModel] = _Query

    def _run(self, query: str = "current") -> str:
        try:
            from correlation_regimes import run_scan

            data = run_scan()
            pairs = data.get("pairs", [])
            source = data.get("data_source", "simulation")
            as_of = data.get("as_of", "N/A")

            # Build id → label lookup
            label_map = {s["id"]: s["label"] for s in data.get("series", [])}

            if not pairs:
                return "Correlation scan: no significant regime breaks detected."

            # Already sorted by z_break descending; take top 10
            top = pairs[:10]

            lines = [f"CORRELATION REGIME SCANNER (as of {as_of}, source: {source}):"]
            lines.append(f"{'Pair':<32} {'ρ regime':>9} {'ρ recent':>9} {'Δρ':>6} {'Z':>6} {'Flip':>5}")
            lines.append("-" * 72)
            for p in top:
                s1 = label_map.get(p.get("series1", ""), p.get("series1", "?"))[:15]
                s2 = label_map.get(p.get("series2", ""), p.get("series2", "?"))[:15]
                pair_label = f"{s1} / {s2}"
                flip = "YES" if p.get("sign_flip") else "no"
                lines.append(
                    f"{pair_label:<32} "
                    f"{p.get('rho_long', 0):>9.3f} "
                    f"{p.get('rho_short', 0):>9.3f} "
                    f"{p.get('delta', 0):>6.3f} "
                    f"{p.get('z_break', 0):>6.2f} "
                    f"{flip:>5}"
                )
            return "\n".join(lines)
        except Exception as exc:
            return f"CorrelationRegimesTool error: {exc}"
