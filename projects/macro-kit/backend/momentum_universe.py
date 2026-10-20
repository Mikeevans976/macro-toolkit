"""
momentum_universe.py — default universe of the Momentum / CTA monitor.

Two kinds of rows:

* CTA markets (``cta=True``): liquid futures that trend followers actually
  trade. They make up the model CTA portfolio (positions, flows, sizing and
  the calibration against the SG Trend Index). Generic tickers are fetched
  ratio back-adjusted (see momentum._adjusted_ticker).
* Reference rows (``cta=False``): cash yields, curves and spreads, DXY. They
  get the same trend signals and regime, but no dollar sizing.

``expr`` is a ticker expression in mean_reversion.parse_expression syntax, so
curves are written as weighted sums of yield tickers. ``scale`` multiplies the
expression (100 turns a yield spread in % into bp).

Bloomberg BVAL Bund curve: BV{TT}0910 BVLI Index (as in egb_rv.BVAL_CURVES).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Kind = Literal["price", "level"]


@dataclass(frozen=True)
class Market:
    id: str
    label: str
    group: str
    expr: str
    kind: Kind = "price"
    unit: str = "price"          # price | pct (yield, %) | bp
    cta: bool = False
    sector: str | None = None    # CTA risk-budget bucket (cta rows only)
    scale: float = 1.0


# Display order of the groups in the monitor.
GROUPS: list[str] = [
    "Bond futures", "STIR futures", "Yields", "Curves & spreads",
    "FX futures", "Equity index futures", "Commodity futures",
]

# Share of the model portfolio's risk per sector, split equally within a
# sector. A common shape for diversified trend programmes; the calibration
# rescales the total, not the split.
SECTOR_RISK: dict[str, float] = {
    "bonds": 0.25, "stir": 0.10, "fx": 0.20, "equities": 0.25, "commodities": 0.20,
}

# Daily returns of a diversified trend-following index, used to calibrate.
CTA_INDEX = "NEIXCTAT Index"   # SG Trend Index


def _f(id: str, label: str, group: str, ticker: str, sector: str) -> Market:
    return Market(id=id, label=label, group=group, expr=ticker, cta=True, sector=sector)


def _y(id: str, label: str, ticker: str) -> Market:
    return Market(id=id, label=label, group="Yields", expr=ticker, kind="level", unit="pct")


def _c(id: str, label: str, expr: str) -> Market:
    return Market(id=id, label=label, group="Curves & spreads", expr=expr, kind="level",
                  unit="bp", scale=100.0)


_DE = {t: f"BV{t:02d}0910 BVLI Index" for t in (2, 5, 10, 30)}
_IT10 = "BV100905 BVLI Index"
_FR10 = "BV100915 BVLI Index"

UNIVERSE: list[Market] = [
    # ── Bond futures ────────────────────────────────────────────────────────
    _f("tu", "US 2y (TU)", "Bond futures", "TU1 Comdty", "bonds"),
    _f("fv", "US 5y (FV)", "Bond futures", "FV1 Comdty", "bonds"),
    _f("ty", "US 10y (TY)", "Bond futures", "TY1 Comdty", "bonds"),
    _f("us", "US Bond (US)", "Bond futures", "US1 Comdty", "bonds"),
    _f("du", "Schatz (DU)", "Bond futures", "DU1 Comdty", "bonds"),
    _f("oe", "Bobl (OE)", "Bond futures", "OE1 Comdty", "bonds"),
    _f("rx", "Bund (RX)", "Bond futures", "RX1 Comdty", "bonds"),
    _f("ub", "Buxl (UB)", "Bond futures", "UB1 Comdty", "bonds"),
    _f("oat", "OAT (OAT)", "Bond futures", "OAT1 Comdty", "bonds"),
    _f("ik", "BTP (IK)", "Bond futures", "IK1 Comdty", "bonds"),
    _f("g", "Gilt (G)", "Bond futures", "G 1 Comdty", "bonds"),
    _f("jb", "JGB 10y (JB)", "Bond futures", "JB1 Comdty", "bonds"),
    _f("xm", "Australia 10y (XM)", "Bond futures", "XM1 Comdty", "bonds"),
    _f("cn", "Canada 10y (CN)", "Bond futures", "CN1 Comdty", "bonds"),
    # ── STIR futures (4th generic: about a year forward) ────────────────────
    _f("sfr", "SOFR 3m, 4th (SFR)", "STIR futures", "SFR4 Comdty", "stir"),
    _f("er", "Euribor 3m, 4th (ER)", "STIR futures", "ER4 Comdty", "stir"),
    _f("sfi", "SONIA 3m, 4th (SFI)", "STIR futures", "SFI4 Comdty", "stir"),
    # ── Yields ──────────────────────────────────────────────────────────────
    _y("us2", "US 2y", "USGG2YR Index"),
    _y("us5", "US 5y", "USGG5YR Index"),
    _y("us10", "US 10y", "USGG10YR Index"),
    _y("us30", "US 30y", "USGG30YR Index"),
    _y("de2", "Germany 2y", _DE[2]),
    _y("de5", "Germany 5y", _DE[5]),
    _y("de10", "Germany 10y", _DE[10]),
    _y("de30", "Germany 30y", _DE[30]),
    _y("fr10", "France 10y", _FR10),
    _y("it10", "Italy 10y", _IT10),
    _y("uk2", "UK 2y", "GUKG2 Index"),
    _y("uk10", "UK 10y", "GUKG10 Index"),
    _y("uk30", "UK 30y", "GUKG30 Index"),
    _y("jp10", "Japan 10y", "GJGB10 Index"),
    # ── Curves & spreads (bp) ───────────────────────────────────────────────
    _c("us2s10s", "US 2s10s", "USGG10YR Index - USGG2YR Index"),
    _c("us5s30s", "US 5s30s", "USGG30YR Index - USGG5YR Index"),
    _c("de2s10s", "Germany 2s10s", f"{_DE[10]} - {_DE[2]}"),
    _c("de10s30s", "Germany 10s30s", f"{_DE[30]} - {_DE[10]}"),
    _c("uk2s10s", "UK 2s10s", "GUKG10 Index - GUKG2 Index"),
    _c("itde10", "BTP-Bund 10y", f"{_IT10} - {_DE[10]}"),
    _c("frde10", "OAT-Bund 10y", f"{_FR10} - {_DE[10]}"),
    # ── FX futures, quoted USD per unit: long = long the currency ──────────
    _f("ec", "EUR (EC)", "FX futures", "EC1 Curncy", "fx"),
    _f("bp", "GBP (BP)", "FX futures", "BP1 Curncy", "fx"),
    _f("jy", "JPY (JY)", "FX futures", "JY1 Curncy", "fx"),
    _f("sf", "CHF (SF)", "FX futures", "SF1 Curncy", "fx"),
    _f("ad", "AUD (AD)", "FX futures", "AD1 Curncy", "fx"),
    _f("cd", "CAD (CD)", "FX futures", "CD1 Curncy", "fx"),
    _f("nv", "NZD (NV)", "FX futures", "NV1 Curncy", "fx"),
    _f("pe", "MXN (PE)", "FX futures", "PE1 Curncy", "fx"),
    Market(id="dxy", label="Dollar index (DXY spot)", group="FX futures", expr="DXY Curncy"),
    # ── Equity index futures ────────────────────────────────────────────────
    _f("es", "S&P 500 (ES)", "Equity index futures", "ES1 Index", "equities"),
    _f("nq", "Nasdaq 100 (NQ)", "Equity index futures", "NQ1 Index", "equities"),
    _f("rty", "Russell 2000 (RTY)", "Equity index futures", "RTY1 Index", "equities"),
    _f("vg", "Euro Stoxx 50 (VG)", "Equity index futures", "VG1 Index", "equities"),
    _f("gx", "DAX (GX)", "Equity index futures", "GX1 Index", "equities"),
    _f("cf", "CAC 40 (CF)", "Equity index futures", "CF1 Index", "equities"),
    _f("z", "FTSE 100 (Z)", "Equity index futures", "Z 1 Index", "equities"),
    _f("nk", "Nikkei 225 (NK)", "Equity index futures", "NK1 Index", "equities"),
    _f("tp", "TOPIX (TP)", "Equity index futures", "TP1 Index", "equities"),
    _f("hi", "Hang Seng (HI)", "Equity index futures", "HI1 Index", "equities"),
    _f("xp", "ASX SPI 200 (XP)", "Equity index futures", "XP1 Index", "equities"),
    # ── Commodity futures ───────────────────────────────────────────────────
    _f("cl", "WTI crude (CL)", "Commodity futures", "CL1 Comdty", "commodities"),
    _f("co", "Brent crude (CO)", "Commodity futures", "CO1 Comdty", "commodities"),
    _f("ho", "Heating oil (HO)", "Commodity futures", "HO1 Comdty", "commodities"),
    _f("ng", "Natural gas (NG)", "Commodity futures", "NG1 Comdty", "commodities"),
    _f("gc", "Gold (GC)", "Commodity futures", "GC1 Comdty", "commodities"),
    _f("si", "Silver (SI)", "Commodity futures", "SI1 Comdty", "commodities"),
    _f("hg", "Copper (HG)", "Commodity futures", "HG1 Comdty", "commodities"),
    _f("c", "Corn (C)", "Commodity futures", "C 1 Comdty", "commodities"),
    _f("s", "Soybeans (S)", "Commodity futures", "S 1 Comdty", "commodities"),
    _f("w", "Wheat (W)", "Commodity futures", "W 1 Comdty", "commodities"),
]

BY_ID: dict[str, Market] = {m.id: m for m in UNIVERSE}
BY_EXPR: dict[str, Market] = {m.expr: m for m in UNIVERSE}


def risk_weights() -> dict[str, float]:
    """Risk weight of each CTA market: sector budget split equally within the sector."""
    counts: dict[str, int] = {}
    for m in UNIVERSE:
        if m.cta:
            counts[m.sector] = counts.get(m.sector, 0) + 1
    return {m.id: SECTOR_RISK[m.sector] / counts[m.sector] for m in UNIVERSE if m.cta}
