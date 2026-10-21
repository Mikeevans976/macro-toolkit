"""
UK debt sustainability monitor (Quant Macro section).

Answers: is the debt path stable, how much headroom against the fiscal rules is
left at today's market prices, and what could break it.

  OBR baseline     the latest Economic and fiscal outlook, as published
  Market baseline  the same forecast with debt interest re-priced on today's Bank of
                   England curves (OIS, nominal, real, implied RPI) instead of the curves
                   in the OBR's market cut-off window: live headroom against the rules
  Interest model   gilt-by-gilt cash flows (DMO list, or a reconstruction), new issuance
                   at forward yields, linkers uplifted by RPI, floating debt (bills, NS&I,
                   APF reserves) at the Bank Rate path; only differences between curve
                   sets are used, so its level never replaces the OBR's
  Stochastic       quarterly VAR shocks to growth, inflation, Bank Rate and gilt yields,
                   cyclical and reaction-function primary balance, 5,000 paths to the
                   extension year: fan charts and probabilities of meeting the rules
  Scenarios        deterministic shocks through the same linear map

State lives under var/debt_sustainability/ (downloads, uploads, the last payload).
Nothing heavy runs on a page load; the payload is rebuilt in the background when
new data arrive (at most hourly), or by the page's Refresh button.
"""
from __future__ import annotations

import dataclasses
import json
import logging
import math
import threading
import zlib
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

import fiscal_data as fd
from runtime_paths import state_path

logger = logging.getLogger(__name__)

COUNTRIES = {"uk": {"title": "UK Debt Sustainability", "country": "GB"}}
ROOT: Path | None = None            # tests point this at a temporary directory
N_PATHS = 5000
REFRESH_MINUTES = 60
PCTS = (5, 10, 25, 50, 75, 90, 95)
COVID = (pd.Period("2020Q1"), pd.Period("2021Q4"))


def _now() -> str:
    return pd.Timestamp.now().isoformat(timespec="seconds")


def _r(x, d: int = 2):
    if x is None:
        return None
    x = float(x)
    return round(x, d) if math.isfinite(x) else None


def _root() -> Path:
    root = ROOT if ROOT is not None else state_path("debt_sustainability")
    root.mkdir(parents=True, exist_ok=True)
    return root


def _read(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except Exception:
        logger.warning("Debt sustainability: unreadable %s", path, exc_info=True)
        return None


def _write(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)


# ---------------------------------------------------------------------------
# Curves
# ---------------------------------------------------------------------------

@dataclass
class CurveSet:
    """One day's spot curves (or a window average): maturity (years) → % a year."""
    date: pd.Timestamp
    nominal: pd.Series
    real: pd.Series
    inflation: pd.Series
    ois: pd.Series
    label: str = ""

    def _z(self, kind: str, m):
        c = getattr(self, kind)
        return np.interp(np.asarray(m, dtype=float), c.index.to_numpy(float), c.to_numpy(float))

    def fwd(self, kind: str, a, b):
        """Average forward rate between a and b years ahead (continuous compounding)."""
        a = np.maximum(np.asarray(a, dtype=float), 0.0)
        b = np.maximum(np.asarray(b, dtype=float), a + 1e-6)
        za, zb = self._z(kind, np.maximum(a, 1e-6)), self._z(kind, b)
        return (zb * b - za * a) / (b - a)

    def shifted(self, **bp) -> "CurveSet":
        """Parallel shift in percentage points, e.g. shifted(ois=1, nominal=1)."""
        out = dataclasses.replace(self)
        for k, v in bp.items():
            setattr(out, k, getattr(self, k) + v)
        return out


def curve_set(curves: dict[str, pd.DataFrame], date: pd.Timestamp, window: int = 1, label: str = "") -> CurveSet | None:
    """Spot curves on (or the average of the ``window`` business days up to) ``date``."""
    rows = {}
    for kind, df in curves.items():
        sub = df.loc[:date].tail(window)
        if sub.empty:
            return None
        s = sub.mean().dropna()
        if s.empty:
            return None
        rows[kind] = s
    last = max(df.loc[:date].index.max() for df in curves.values())
    return CurveSet(date=pd.Timestamp(last), label=label, **rows)


def cutoff_date(efo: dict) -> pd.Timestamp:
    """Last day of the OBR's fiscal-forecast market window (10 working days)."""
    edition = fd._edition_date(efo["edition"])
    if efo.get("fiscal_cutoff"):
        d = pd.Timestamp(f"{efo['fiscal_cutoff']} {edition.year}")
        return d if d <= edition else d - pd.DateOffset(years=1)
    return edition - pd.DateOffset(months=1)


# ---------------------------------------------------------------------------
# Rate paths by financial year
# ---------------------------------------------------------------------------

def _months(fy: int) -> pd.DatetimeIndex:
    return pd.date_range(pd.Timestamp(fy, 4, 15), periods=12, freq="MS") + pd.Timedelta(days=14)


def _tau(dates, asof: pd.Timestamp) -> np.ndarray:
    return np.asarray((pd.DatetimeIndex(dates) - asof).days, dtype=float) / 365.25


def bank_rate_path(cs: CurveSet, fys: list[int], realized: pd.Series) -> np.ndarray:
    """Average Bank Rate per FY: realised months before the curve date, OIS forwards after."""
    out = []
    for fy in fys:
        m = _months(fy)
        tau = _tau(m, cs.date)
        fwd = cs.fwd("ois", tau - 1 / 24, tau + 1 / 24)
        past = np.array([realized.get(pd.Period(d, "M"), np.nan) for d in m])
        last = realized.dropna().iloc[-1] if realized.notna().any() else fwd[0]
        past = np.where(np.isnan(past), last, past)
        out.append(np.where(tau < 0, past, fwd).mean())
    return np.array(out)


def issue_yields(cs: CurveSet, fys: list[int], maturity: float, kind: str = "nominal") -> np.ndarray:
    """Yield at issue per FY for a given maturity: average over the year's months of the
    forward rate from issue to maturity (today's spot for months already past)."""
    out = []
    for fy in fys:
        tau = np.maximum(_tau(_months(fy), cs.date), 0.0)
        out.append(cs.fwd(kind, tau, tau + maturity).mean())
    return np.array(out)


def inflation_shift(today: CurveSet, ref: CurveSet, fys: list[int]) -> np.ndarray:
    """Change in market-implied RPI inflation per FY (calendar month by calendar month)."""
    out = []
    for fy in fys:
        m = _months(fy)
        t1, t0 = _tau(m, today.date), _tau(m, ref.date)
        d = today.fwd("inflation", t1 - 1 / 24, t1 + 1 / 24) - ref.fwd("inflation", t0 - 1 / 24, t0 + 1 / 24)
        out.append(np.where(t1 < 0, 0.0, d).mean())
    return np.array(out)


# ---------------------------------------------------------------------------
# Debt portfolio and the interest model
# ---------------------------------------------------------------------------

@dataclass
class Portfolio:
    as_of: pd.Timestamp
    conv: pd.DataFrame                 # amount (£bn nominal), coupon (%), mat (FY start year)
    linkers: pd.DataFrame              # amount (£bn incl. uplift), coupon (% real), mat
    bills: float                       # £bn
    nsandi: float
    reserves: float                    # APF loan ≈ reserves created by QE
    apf: float                         # APF gilt holdings, £bn nominal
    apf_coupon: float                  # %
    source: str                        # "dmo" | "reconstructed"
    note: str


def _truncated_exp_weights(mean: float, max_m: int) -> tuple[np.ndarray, np.ndarray]:
    m = np.arange(1, max_m + 1, dtype=float) - 0.5
    lo, hi = 0.1, 500.0
    for _ in range(80):
        tau = math.sqrt(lo * hi)
        w = np.exp(-m / tau)
        if (w * m).sum() / w.sum() < mean:
            lo = tau
        else:
            hi = tau
    return m, w / w.sum()


def build_portfolio(pusf: fd.Pusf, rules: dict, register: pd.DataFrame | None, br_last_fy: float) -> Portfolio:
    """Debt stock today: gilts from the DMO list (or reconstructed), floating debt from the ONS."""
    mo = pusf.monthly
    last = lambda k: float(mo[k].dropna().iloc[-1]) / 1000.0          # noqa: E731  (£m → £bn)
    as_of = mo[["gilts"]].dropna().index[-1].to_timestamp(how="end").normalize()
    fy0 = fd.fy_of(pd.Period(as_of, "M"))
    bills, nsandi, reserves, apf = last("tbills"), last("nsandi"), last("apf_loan"), last("apf_gilts")
    gilts = last("gilts")
    fy_tab = fd.fiscal_years(mo)
    complete = fy_tab[fy_tab["months"] == 12]
    cg_int = float(complete["cg_interest_ex_uplift"].iloc[-1]) / 1000.0

    if register is not None and len(register):
        r = register.copy()
        r["mat"] = [fd.fy_of(pd.Period(d, "M")) for d in r["maturity"]]
        r = r[r["mat"] >= fy0]
        r["amount"] = np.where(r["index_linked"] & r["uplifted"].notna(), r["uplifted"], r["nominal"]) / 1000.0
        conv = r.loc[~r["index_linked"], ["amount", "coupon", "mat"]].reset_index(drop=True)
        conv["coupon"] = conv["coupon"].fillna(conv["coupon"].median())
        link = r.loc[r["index_linked"], ["amount", "coupon", "mat"]].reset_index(drop=True)
        link["coupon"] = link["coupon"].fillna(0.5)
        apf_coupon = float(np.average(conv["coupon"], weights=conv["amount"]))
        return Portfolio(as_of, conv, link, bills, nsandi, reserves, apf, apf_coupon, "dmo",
                         f"DMO gilts in issue: {len(conv)} conventional and {len(link)} index-linked gilts.")

    syn = rules["synthetic_register"]
    share = syn["linker_share"]
    m_c, w_c = _truncated_exp_weights(syn["avg_maturity_conventional"], syn["max_maturity"])
    m_l, w_l = _truncated_exp_weights(syn["avg_maturity_linkers"], syn["max_maturity"])
    conv_stock, link_stock = gilts * (1 - share), gilts * share
    link_coupon = 0.4
    floating = (bills + nsandi) * br_last_fy / 100.0
    coupon = (cg_int - link_stock * link_coupon / 100.0 - floating) / conv_stock * 100.0
    coupon = float(np.clip(coupon, 0.5, 6.0))
    mats = fy0 + np.floor((as_of - pd.Timestamp(fy0, 4, 1)).days / 365.25 + m_c).astype(int)
    conv = pd.DataFrame({"amount": conv_stock * w_c, "coupon": coupon, "mat": mats})
    mats_l = fy0 + np.floor((as_of - pd.Timestamp(fy0, 4, 1)).days / 365.25 + m_l).astype(int)
    link = pd.DataFrame({"amount": link_stock * w_l, "coupon": link_coupon, "mat": mats_l})
    return Portfolio(as_of, conv, link, bills, nsandi, reserves, apf, coupon, "reconstructed",
                     f"Reconstructed from ONS totals (£{gilts:,.0f}bn of gilts, {share:.0%} index-linked, average maturity "
                     f"{syn['avg_maturity_conventional']:.0f}y conventional / {syn['avg_maturity_linkers']:.0f}y linkers); "
                     f"conventional coupon {coupon:.2f}% calibrated to the £{cg_int:.1f}bn of interest the ONS recorded in "
                     f"the last complete year. Upload the DMO gilts-in-issue (D1A) report for the gilt-by-gilt version.")


@dataclass
class RatePaths:
    bank_rate: np.ndarray               # % per FY
    rpi: np.ndarray                     # % per FY
    nominal: dict[float, np.ndarray]    # maturity → issue yield per FY
    real: dict[float, np.ndarray]


def rate_paths(cs: CurveSet, fys: list[int], realized_br: pd.Series, rpi: np.ndarray, mix: dict) -> RatePaths:
    nominal = {b["maturity"]: issue_yields(cs, fys, b["maturity"]) for k, b in mix.items() if k in ("short", "medium", "long")}
    real = {mix["index_linked"]["maturity"]: issue_yields(cs, fys, mix["index_linked"]["maturity"], "real")}
    return RatePaths(bank_rate_path(cs, fys, realized_br), rpi, nominal, real)


def run_interest(p: Portfolio, fys: list[int], rp: RatePaths, cgncr: np.ndarray, mix: dict, apf_cfg: dict,
                 extra_need: np.ndarray | None = None) -> dict[str, np.ndarray]:
    """Debt interest by FY (£bn), central government net of the APF.

    Coupons and uplift are on all gilts; the APF's gilt coupons come back to the
    Treasury, and the reserves that financed them cost Bank Rate. A gilt maturing,
    and a gilt issued, during a year pays half a year's interest that year."""
    n = len(fys)
    conv = [(float(a), float(c), int(m)) for a, c, m in p.conv[["amount", "coupon", "mat"]].itertuples(index=False)]
    link = [[float(a), float(c), int(m)] for a, c, m in p.linkers[["amount", "coupon", "mat"]].itertuples(index=False)]
    bills, nsandi, reserves, apf = p.bills, p.nsandi, p.reserves, p.apf
    out = {k: np.zeros(n) for k in ("conventional", "uplift", "linker_coupon", "floating", "apf_offset", "total",
                                    "redemptions", "gross_issuance", "conv_issuance", "fixed_issuance", "floating_stock", "linker_stock",
                                    "conv_stock", "gilt_stock")}
    extra = np.zeros(n) if extra_need is None else extra_need
    q, price = apf_cfg["reduction_per_year_bn"], apf_cfg["average_price"]
    for k, fy in enumerate(fys):
        br, infl = rp.bank_rate[k], rp.rpi[k]
        w = lambda m: 1.0 if m > fy else 0.5 if m == fy else 0.0     # noqa: E731
        conv_int = sum(a * c / 100 * w(m) for a, c, m in conv)
        redeem = sum(a for a, c, m in conv if m == fy)
        upl = cpn = 0.0
        for row in link:
            a, c, m = row
            if m < fy:
                continue
            upl += a * infl / 100 * w(m)
            cpn += a * c / 100 * w(m)
            row[0] = a * (1 + infl / 100)
            if m == fy:
                redeem += row[0]
        conv = [x for x in conv if x[2] > fy]
        link = [x for x in link if x[2] > fy]
        sold = min(q, apf)
        apf_avg, res_avg = apf - sold / 2, max(reserves - sold * price / 2, 0.0)
        apf -= sold
        reserves = max(reserves - sold * price, 0.0)
        need = cgncr[k] + redeem + extra[k]
        new_conv = 0.0
        for key in ("short", "medium", "long"):
            b = mix[key]
            amt = need * b["share"]
            y = rp.nominal[b["maturity"]][k]
            conv.append((amt, y, fy + max(int(round(b["maturity"])), 1)))
            conv_int += amt * y / 100 * 0.5
            new_conv += amt
        il = mix["index_linked"]
        amt = need * il["share"]
        ry = rp.real[il["maturity"]][k]
        link.append([amt * (1 + infl / 100 * 0.5), ry, fy + int(il["maturity"])])
        upl += amt * infl / 100 * 0.25
        cpn += amt * ry / 100 * 0.5
        bills_avg = bills + need * mix["bills"]["share"] / 2
        bills += need * mix["bills"]["share"]
        floating = (bills_avg + nsandi + res_avg) * br / 100
        offset = apf_avg * p.apf_coupon / 100
        out["conventional"][k], out["uplift"][k], out["linker_coupon"][k] = conv_int, upl, cpn
        out["floating"][k], out["apf_offset"][k] = floating, offset
        out["total"][k] = conv_int + upl + cpn + floating - offset
        out["redemptions"][k], out["gross_issuance"][k], out["conv_issuance"][k] = redeem, need, new_conv
        out["fixed_issuance"][k] = new_conv + amt          # conventional and index-linked: coupon set at issue
        out["floating_stock"][k] = bills_avg + nsandi + res_avg
        out["linker_stock"][k] = sum(x[0] for x in link)
        out["conv_stock"][k] = sum(x[0] for x in conv)
        out["gilt_stock"][k] = out["linker_stock"][k] + out["conv_stock"][k]
    return out


# ---------------------------------------------------------------------------
# Baselines (OBR and market-consistent) with the extension years
# ---------------------------------------------------------------------------

@dataclass
class Baseline:
    years: list[int]                   # FY start years, first forecast year → extension
    obr_n: int                         # how many of them are OBR years
    gdp: np.ndarray                    # £bn, FY
    gdp_c: np.ndarray                  # £bn, centred end-March
    pd_pct: np.ndarray                 # primary deficit, % GDP
    netinv: np.ndarray                 # £bn
    interest: np.ndarray               # CG debt interest net of APF, £bn
    net_interest: np.ndarray           # net debt interest (A.9), £bn
    psnb: np.ndarray
    cbd: np.ndarray
    psnfl: np.ndarray                  # £bn end-March
    psnd: np.ndarray                   # PSND ex BoE, £bn end-March
    psnfl0: float                      # end-March before the first year
    psnd0: float
    gdp_c0: float
    receipts: np.ndarray               # £bn
    real_growth: np.ndarray
    deflator: np.ndarray

    def pct(self, name: str) -> np.ndarray:
        v = getattr(self, name)
        return 100 * v / (self.gdp_c if name in ("psnfl", "psnd") else self.gdp)


def obr_baseline(efo: dict, ext_last: int, interest_model: np.ndarray) -> Baseline:
    """OBR forecast from its first forecast year, extended to ``ext_last``.

    ``interest_model`` (on the same years) shapes debt interest after the OBR horizon;
    it is anchored to the OBR's last year."""
    ys = [fd.fy_start(y) for y in efo["years"]]
    o = efo["outturn_years"]
    det, pct, bn = efo["determinants"], efo["pct_gdp"], efo["bn"]
    sl = slice(o, None)
    years = ys[o:]
    obr_n = len(years)
    years = years + list(range(years[-1] + 1, ext_last + 1))
    n_ext = len(years) - obr_n
    g_nom = np.array(det["nominal_gdp_growth"][sl] + [det["nominal_gdp_growth"][-1]] * n_ext)
    gdp = np.array(det["nominal_gdp_bn"][sl], dtype=float)
    gdp_c = np.array(det["nominal_gdp_centred_bn"][sl], dtype=float)
    for _ in range(n_ext):
        gdp = np.append(gdp, gdp[-1] * (1 + g_nom[len(gdp)] / 100))
        gdp_c = np.append(gdp_c, gdp_c[-1] * (1 + g_nom[len(gdp_c)] / 100))
    ext = lambda v: np.array(list(v[sl]) + [v[-1]] * n_ext, dtype=float)        # noqa: E731
    pd_pct = ext(pct["primary_deficit"])
    netinv = ext(pct["net_investment"]) * gdp / 100
    interest = np.array(bn["cg_debt_interest"][sl], dtype=float)
    net_int = np.array(bn["net_debt_interest"][sl], dtype=float)
    gap = interest[-1] - net_int[-1]
    for k in range(obr_n, len(years)):
        interest = np.append(interest, interest[obr_n - 1] + interest_model[k] - interest_model[obr_n - 1])
        net_int = np.append(net_int, interest[-1] - gap)
    psnb = np.array(bn["psnb"][sl], dtype=float)
    psnb = np.append(psnb, pd_pct[obr_n:] * gdp[obr_n:] / 100 + net_int[obr_n:])
    cbd = psnb - netinv
    cbd[:obr_n] = bn["cbd"][sl]
    psnfl = np.array(bn["psnfl"][sl], dtype=float)
    psnd = np.array(bn["psnd_exboe"][sl], dtype=float)
    # Beyond the horizon the stocks rise by borrowing plus the average of the OBR's
    # final three years' other changes (financial transactions, valuation), as % of GDP.
    def _other(stock: np.ndarray, before: float) -> float:
        s = np.concatenate([[before], stock[:obr_n]])
        return float(np.mean((np.diff(s) - psnb[:obr_n])[-3:] / gdp[obr_n - 3:obr_n]))
    psnfl0, psnd0 = float(bn["psnfl"][o - 1]), float(bn["psnd_exboe"][o - 1])
    o_fl, o_nd = _other(psnfl, psnfl0), _other(psnd, psnd0)
    for k in range(obr_n, len(years)):
        psnfl = np.append(psnfl, psnfl[-1] + psnb[k] + o_fl * gdp[k])
        psnd = np.append(psnd, psnd[-1] + psnb[k] + o_nd * gdp[k])
    receipts = ext(pct["receipts"]) * gdp / 100
    return Baseline(years, obr_n, gdp, gdp_c, pd_pct, netinv, interest, net_int, psnb, cbd, psnfl, psnd,
                    psnfl0, psnd0, float(det["nominal_gdp_centred_bn"][o - 1]), receipts,
                    ext(det["real_gdp_growth"]), ext(det["gdp_deflator"]))


def with_interest(b: Baseline, d_int: np.ndarray) -> Baseline:
    """The baseline with debt interest changed by d_int (£bn per year): borrowing, the
    current budget and the debt stocks follow (interest on interest included)."""
    cum = np.cumsum(d_int)
    return dataclasses.replace(
        b, interest=b.interest + d_int, net_interest=b.net_interest + d_int, psnb=b.psnb + d_int,
        cbd=b.cbd + d_int, psnfl=b.psnfl + cum, psnd=b.psnd + cum)


def rule_headroom(b: Baseline, target: int) -> dict:
    k = b.years.index(target)
    fl = b.pct("psnfl")
    prev = 100 * b.psnfl0 / b.gdp_c0 if k == 0 else fl[k - 1]
    pp = prev - fl[k]
    return {
        "stability_bn": -b.cbd[k],
        "investment_pp": pp,
        "investment_bn": pp / 100 * b.gdp_c[k],
    }


# ---------------------------------------------------------------------------
# History: debt dynamics from the ONS
# ---------------------------------------------------------------------------

def history_table(pusf: fd.Pusf, q: pd.DataFrame) -> pd.DataFrame:
    """Complete financial years: ratios and the debt-dynamics decomposition of PSND ex BoE."""
    fy = fd.fiscal_years(pusf.monthly)
    fy = fy[fy["months"] == 12].copy()
    gq = q["nominal_gdp"].dropna()
    gdp_fy = gq.groupby([p.year if p.quarter >= 2 else p.year - 1 for p in gq.index]).agg(["sum", "count"])
    gdp_fy = gdp_fy.loc[gdp_fy["count"] == 4, "sum"] / 1000.0
    fy["gdp"] = gdp_fy.reindex(fy.index)
    fy["gdp_c"] = fy["psnd_exboe"] / fy["psnd_exboe_pct"] * 100 / 1000.0       # £bn, centred end-March
    for k in ("psnb", "cbd", "net_investment", "receipts", "interest_paid", "interest_received",
              "cg_interest_ex_uplift", "il_uplift", "apf_net_interest", "psnd_exboe"):
        fy[k] = fy[k] / 1000.0
    fy["net_interest"] = fy["interest_paid"] - fy["interest_received"]
    fy["cg_interest"] = fy["cg_interest_ex_uplift"] + fy["il_uplift"] - fy["apf_net_interest"]
    fy["primary"] = fy["psnb"] - fy["net_interest"]
    fy = fy.dropna(subset=["gdp_c", "psnd_exboe_pct"])
    return fy


def decompose(years: list[int], d: np.ndarray, d0: float, debt0: float, debt: np.ndarray, gdp_c: np.ndarray,
              gdp_c0: float, net_int: np.ndarray, primary: np.ndarray) -> list[dict]:
    """Δ(debt/GDP) = growth effect + interest effect + primary deficit + other (exact)."""
    rows = []
    prev_d, prev_y, prev_debt = d0, gdp_c0, debt0
    for k, fy in enumerate(years):
        g = gdp_c[k] / prev_y - 1
        growth = prev_d * (1 / (1 + g) - 1)
        inter = 100 * net_int[k] / gdp_c[k]
        prim = 100 * primary[k] / gdp_c[k]
        change = d[k] - prev_d
        i_eff = 100 * net_int[k] / prev_debt
        rows.append({
            "year": fd.fy_label(fy), "debt": d[k], "change": change, "growth": growth, "interest": inter,
            "primary": prim, "other": change - growth - inter - prim,
            "effective_rate": i_eff, "nominal_growth": 100 * g, "r_minus_g": i_eff - 100 * g,
            "stabilising_primary": -prev_d * (i_eff / 100 - g) / (1 + g),
        })
        prev_d, prev_y, prev_debt = d[k], gdp_c[k], debt[k]
    return rows


# ---------------------------------------------------------------------------
# Stochastic projections
# ---------------------------------------------------------------------------

def var_shocks(q: pd.DataFrame, n_q: int, n_paths: int, seed: int) -> tuple[np.ndarray, dict]:
    """Simulated quarterly deviations from baseline of [real growth, deflator inflation,
    Bank Rate, 10y gilt] (annualised %, levels) from a VAR(2) estimated since 1993
    (pandemic quarters excluded). Shape (paths, quarters, 4)."""
    d = pd.DataFrame({
        "growth": 400 * np.log(q["real_gdp"]).diff(),
        "inflation": 400 * np.log(q["nominal_gdp"] / q["real_gdp"]).diff(),
        "bank_rate": q["bank_rate"],
        "gilt_10y": q["gilt_10y"],
    }).loc["1993Q1":].dropna()
    y = d.to_numpy()
    idx = d.index
    keep = [t for t in range(2, len(y))
            if not any(COVID[0] <= idx[t - j] <= COVID[1] for j in range(3))]
    X = np.column_stack([np.ones(len(keep)), y[[t - 1 for t in keep]], y[[t - 2 for t in keep]]])
    Y = y[keep]
    B, *_ = np.linalg.lstsq(X, Y, rcond=None)
    resid = Y - X @ B
    sigma = np.cov(resid.T)
    A1, A2 = B[1:5].T, B[5:9].T
    rng = np.random.default_rng(seed)
    eps = rng.multivariate_normal(np.zeros(4), sigma, size=(n_paths, n_q))
    dev = np.zeros((n_paths, n_q, 4))
    for t in range(n_q):
        x1 = dev[:, t - 1] if t >= 1 else 0.0
        x2 = dev[:, t - 2] if t >= 2 else 0.0
        dev[:, t] = (x1 @ A1.T if t >= 1 else 0) + (x2 @ A2.T if t >= 2 else 0) + eps[:, t]
    eig = np.abs(np.linalg.eigvals(np.block([[A1, A2], [np.eye(4), np.zeros((4, 4))]]))).max()
    info = {
        "sample": f"{idx[0]} to {idx[-1]}", "observations": len(keep), "max_eigenvalue": float(eig),
        "shock_sd": {c: float(np.sqrt(sigma[i, i])) for i, c in enumerate(d.columns)},
    }
    return dev, info


def to_fiscal_years(dev_q: np.ndarray, first_q: pd.Period, fys: list[int]) -> np.ndarray:
    """Average quarterly deviations over each FY (quarters Q2..Q1). Shape (paths, years, 4)."""
    out = np.zeros((dev_q.shape[0], len(fys), dev_q.shape[2]))
    for k, fy in enumerate(fys):
        qs = [pd.Period(f"{fy}Q2") + i for i in range(4)]
        idx = [(p - first_q).n for p in qs if 0 <= (p - first_q).n < dev_q.shape[1]]
        if idx:
            out[:, k] = dev_q[:, idx].mean(axis=1)
    return out


@dataclass
class Sensitivity:
    """Linear response of debt interest (£bn) to rate and inflation deviations, from the
    interest model: floating debt reprices at once, each year's gilt issuance fixes its
    coupon until it matures (half a year in the year of issue; real yields on new
    linkers are taken to move with nominal yields), index-linked debt is uplifted by RPI."""
    floating: np.ndarray       # £bn of floating-rate debt per FY
    issuance: np.ndarray       # £bn of fixed-coupon issuance (conventional and index-linked) per FY
    linkers: np.ndarray        # £bn of index-linked debt per FY
    buckets: list[tuple[float, float]]   # (share of that issuance, maturity in years)

    def kernel(self, n: int) -> np.ndarray:
        """K[s, t]: share of year-s issuance still paying its year-s yield in year t."""
        K = np.zeros((n, n))
        for s in range(n):
            for t in range(s, n):
                age = t - s
                K[s, t] = sum(w * (0.5 if age == 0 else 1.0 if age < m else 0.0) for w, m in self.buckets)
        return K

    def interest(self, br: np.ndarray, gilt: np.ndarray, infl: np.ndarray) -> np.ndarray:
        """Deviations (paths, years) in pp → interest deviation (paths, years) £bn."""
        n = gilt.shape[-1]
        fixed = (gilt * self.issuance / 100) @ self.kernel(n)
        return br * self.floating / 100 + fixed + infl * self.linkers / 100


def sensitivity(model: dict[str, np.ndarray], mix: dict) -> Sensitivity:
    fixed = ("short", "medium", "long", "index_linked")
    total = sum(mix[b]["share"] for b in fixed)
    return Sensitivity(floating=model["floating_stock"], issuance=model["fixed_issuance"], linkers=model["linker_stock"],
                       buckets=[(mix[b]["share"] / total, mix[b]["maturity"]) for b in fixed])


def project(b: Baseline, sens: Sensitivity, growth: np.ndarray, infl: np.ndarray, br: np.ndarray, gilt: np.ndarray,
            pb_shock: np.ndarray, cyc: dict, rho: float) -> dict[str, np.ndarray]:
    """Debt paths for deviations from the baseline (arrays (paths, years), pp)."""
    paths, n = growth.shape
    nom = (1 + (growth + infl) / 100).cumprod(axis=1)
    gdp, gdp_c = b.gdp * nom, b.gdp_c * nom
    d_int = sens.interest(br, gilt, infl)
    gap = np.zeros(paths)
    fl, nd = np.full(paths, b.psnfl0), np.full(paths, b.psnd0)
    other_fl = np.diff(np.concatenate([[b.psnfl0], b.psnfl])) - b.psnb
    other_nd = np.diff(np.concatenate([[b.psnd0], b.psnd])) - b.psnb
    base_nd = 100 * b.psnd / b.gdp_c
    out = {k: np.zeros((paths, n)) for k in ("psnfl_pct", "psnd_pct", "psnb_pct", "cbd_bn", "interest_bn", "interest_receipts")}
    prev_dev = np.zeros(paths)
    for k in range(n):
        gap = cyc["gap_persistence"] * gap + growth[:, k]
        pd_pct = b.pd_pct[k] - cyc["pb_semi_elasticity"] * gap - rho * prev_dev + pb_shock[:, k]
        interest = b.interest[k] + d_int[:, k]
        net_int = b.net_interest[k] + d_int[:, k]
        psnb = pd_pct * gdp[:, k] / 100 + net_int
        fl = fl + psnb + other_fl[k] * nom[:, k]
        nd = nd + psnb + other_nd[k] * nom[:, k]
        out["psnfl_pct"][:, k] = 100 * fl / gdp_c[:, k]
        out["psnd_pct"][:, k] = 100 * nd / gdp_c[:, k]
        out["psnb_pct"][:, k] = 100 * psnb / gdp[:, k]
        out["cbd_bn"][:, k] = psnb - b.netinv[k] / b.gdp[k] * gdp[:, k]
        out["interest_bn"][:, k] = interest
        out["interest_receipts"][:, k] = 100 * interest / (b.receipts[k] * nom[:, k])
        prev_dev = out["psnd_pct"][:, k] - base_nd[k]
    return out


def bohn(hist: pd.DataFrame) -> dict:
    """Fiscal reaction: primary surplus (% GDP) on lagged debt (% GDP) and real growth."""
    h = hist.copy()
    h["ps"] = -100 * h["primary"] / h["gdp_c"]
    h["d_lag"] = h["psnd_exboe_pct"].shift(1)
    h["g"] = 100 * (h["gdp_c"] / h["gdp_c"].shift(1) - 1)
    h = h.dropna(subset=["ps", "d_lag", "g"])
    h = h[~h.index.isin([2020, 2021])]
    if len(h) < 8:
        return {"rho": None, "se": None, "r2": None, "n": len(h), "used": 0.0, "resid_sd": 1.0}
    X = np.column_stack([np.ones(len(h)), h["d_lag"], h["g"]])
    y = h["ps"].to_numpy()
    beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    res = y - X @ beta
    s2 = res @ res / (len(y) - 3)
    se = np.sqrt(np.diag(s2 * np.linalg.inv(X.T @ X)))
    r2 = 1 - (res @ res) / ((y - y.mean()) @ (y - y.mean()))
    rho = float(beta[1])
    used = float(np.clip(rho, 0.0, 0.1)) if rho / se[1] > 1.0 else 0.0
    return {"rho": rho, "se": float(se[1]), "r2": float(r2), "n": int(len(y)), "used": used,
            # growth effects are modelled separately, so the residual is capped at 1% of GDP
            "resid_sd": float(np.clip(np.sqrt(s2), 0.3, 1.0)),
            "sample": f"{fd.fy_label(int(h.index[0]))} to {fd.fy_label(int(h.index[-1]))}"}


# ---------------------------------------------------------------------------
# Payload
# ---------------------------------------------------------------------------

SCENARIOS = [
    # id, name, description, deviations per year from the first projection year:
    # growth, inflation (deflator ≈ RPI), Bank Rate, 10y gilt (pp), primary deficit (% GDP)
    ("rates_100", "Rates +100bp", "Bank Rate and gilt yields 1pp higher for good from next year.",
     dict(br=[0, 1], gilt=[0, 1])),
    ("term_premium", "Gilt term-premium shock", "Gilt yields 1.5pp higher with an unchanged Bank Rate (a fiscal risk premium).",
     dict(gilt=[0, 1.5])),
    ("growth", "Recession", "Real growth 2pp lower for two years; automatic stabilisers widen the deficit.",
     dict(growth=[0, -2, -2, 0])),
    ("inflation", "Inflation shock", "Inflation 3pp higher for two years, Bank Rate 1.5pp and gilts 1pp higher in response.",
     dict(inflation=[0, 3, 3, 0], br=[0, 1.5, 1.5, 0.5], gilt=[0, 1, 1, 0.5])),
    ("replay_2022", "2022 replay", "As in 2022–23: inflation up 6pp then 3pp, Bank Rate up 3pp, gilts up 2.5pp, growth 1pp lower.",
     dict(inflation=[0, 6, 3, 0], br=[0, 2, 3, 1.5], gilt=[0, 2.5, 2, 1.5], growth=[0, -1, -1, 0])),
    ("replay_2008", "2008 replay", "As in 2008–10: growth 5pp lower then 1pp, deficit 3% of GDP wider for three years, Bank Rate cut 3pp.",
     dict(growth=[0, -5, -1, 0], br=[0, -3, -3, -2], gilt=[0, -1, -1, -0.5], pd=[0, 3, 3, 2])),
    ("combined", "Combined adverse", "Recession plus a gilt risk premium: growth 1.5pp lower for two years, gilts 1.5pp and Bank Rate 1pp higher.",
     dict(growth=[0, -1.5, -1.5, 0], gilt=[0, 1.5], br=[0, 1], pd=[0, 0.5, 0.5, 0.5])),
]


def _scenario_path(spec: list[float], n: int) -> np.ndarray:
    """[a, b, c] → a, b, c then the last value held (a single trailing value persists)."""
    out = np.zeros(n)
    for k in range(n):
        out[k] = spec[min(k, len(spec) - 1)]
    return out


def _fy_rows(years: list[int], arrays: dict[str, np.ndarray], d: int = 2) -> list[dict]:
    return [{"year": fd.fy_label(y), **{k: _r(v[i], d) for k, v in arrays.items()}} for i, y in enumerate(years)]


def _realized_bank_rate(q: pd.DataFrame) -> pd.Series:
    br = q["bank_rate"].dropna()
    return pd.Series({pd.Period(p.start_time, "M") + i: v for p, v in br.items() for i in range(3)})


def load_register() -> tuple[pd.DataFrame | None, dict | None]:
    folder = _root() / "uploads" / "dmo"
    files = sorted(folder.glob("*")) if folder.exists() else []
    files = [f for f in files if f.suffix.lower() in (".csv", ".xlsx", ".xls", ".xml")]
    if not files:
        return None, None
    f = files[-1]
    try:
        reg = fd.parse_gilt_register(f.read_bytes(), f.name)
        return reg, {"file": f.name, "uploaded": pd.Timestamp(f.stat().st_mtime, unit="s").isoformat(timespec="seconds"), "gilts": len(reg)}
    except Exception as exc:
        logger.warning("Debt sustainability: could not read %s (%s)", f.name, exc)
        return None, {"file": f.name, "error": str(exc)}


@dataclass
class Inputs:
    pusf: fd.Pusf
    curves: dict[str, pd.DataFrame]
    quarterly: pd.DataFrame
    efo: dict
    register: pd.DataFrame | None = None
    register_meta: dict | None = None


def load_inputs(progress=lambda s: None) -> Inputs:
    root = _root()
    progress("Downloading ONS public sector finances")
    pusf = fd.load_pusf(root / "sources" / "ons_pusf")
    if pusf is None:
        raise RuntimeError("ONS public sector finances unavailable (offline and never downloaded)")
    progress("Downloading Bank of England yield curves")
    curves = fd.update_boe_curves(root / "sources" / "boe_curves")
    progress("Downloading quarterly macro history")
    q = fd.quarterly_history(root / "sources" / "macro")
    efo = fd.load_efo(root / "uploads" / "obr")
    register, register_meta = load_register()
    return Inputs(pusf, curves, q, efo, register, register_meta)


def build_payload(slug: str = "uk", progress=lambda s: None, inputs: Inputs | None = None) -> dict:
    rules = fd.fiscal_rules()
    mix, cyc = rules["issuance_mix"], rules["cyclical"]
    target = fd.fy_start(rules["target_year"])
    ext_last = fd.fy_start(rules["extension"]["last_year"])
    inp = inputs or load_inputs(progress)
    pusf, curves, q, efo = inp.pusf, inp.curves, inp.quarterly, inp.efo
    register, register_meta = inp.register, inp.register_meta

    progress("Pricing the debt")
    cut = cutoff_date(efo)
    cs_cut = curve_set(curves, cut, window=10, label="OBR market window")
    last_day = min(df.index.max() for df in curves.values())
    cs_today = curve_set(curves, last_day, label="Latest")
    if cs_cut is None or cs_today is None:
        raise RuntimeError("Bank of England curves do not cover the OBR market window")

    o = efo["outturn_years"]
    years = [fd.fy_start(y) for y in efo["years"][o:]]
    years = years + list(range(years[-1] + 1, ext_last + 1))
    n = len(years)
    obr_n = len(efo["years"]) - o
    realized = _realized_bank_rate(q)
    rpi_obr = np.array(efo["determinants"]["rpi"][o:] + [efo["determinants"]["rpi"][-1]] * (n - obr_n))
    fy_hist = fd.fiscal_years(pusf.monthly)
    complete = fy_hist[fy_hist["months"] == 12]
    br_last = float(np.nanmean([realized.get(pd.Period(f"{int(complete.index[-1]) + (1 if m < 4 else 0)}-{m:02d}", "M"), np.nan)
                                for m in range(1, 13)]))
    port = build_portfolio(pusf, rules, register, br_last)

    # Financing need before interest effects: OBR CGNCR, then borrowing plus the OBR's
    # final-years gap between the cash requirement and borrowing.
    gdp_obr = np.array(efo["determinants"]["nominal_gdp_bn"][o:], dtype=float)
    cgncr = np.array(efo["pct_gdp"]["cgncr"][o:]) * gdp_obr / 100
    base_tmp = obr_baseline(efo, ext_last, np.zeros(n))
    gap_cash = float(np.mean((cgncr - np.array(efo["bn"]["psnb"][o:]))[-3:]))
    cgncr = np.append(cgncr, base_tmp.psnb[obr_n:] + gap_cash)

    def run(cs: CurveSet, rpi: np.ndarray, extra=None) -> dict[str, np.ndarray]:
        return run_interest(port, years, rate_paths(cs, years, realized, rpi, mix), cgncr, mix, rules["apf"], extra)

    rpi_mkt = rpi_obr + inflation_shift(cs_today, cs_cut, years)
    m_cut = run(cs_cut, rpi_obr)
    m_today = run(cs_today, rpi_mkt)
    m_today = run(cs_today, rpi_mkt, m_today["total"] - m_cut["total"])    # the extra interest is borrowed too
    d_int = m_today["total"] - m_cut["total"]
    # Attribution, in sequence: the passage of time (unchanged curves rolled to today,
    # realised Bank Rate), then the Bank Rate path, gilt yields (nominal and real) and
    # RPI; scaled per year to the total, which also carries interest on the extra interest.
    step0 = dataclasses.replace(cs_cut, date=cs_today.date)
    step1 = dataclasses.replace(step0, ois=cs_today.ois)
    step2 = dataclasses.replace(step1, nominal=cs_today.nominal, real=cs_today.real)
    t0, t1, t2 = (run(c, rpi_obr)["total"] for c in (step0, step1, step2))
    t3 = run(cs_today, rpi_mkt)["total"]
    parts = {"time": t0 - m_cut["total"], "bank_rate": t1 - t0, "gilts": t2 - t1, "inflation": t3 - t2}
    raw = sum(parts.values())
    scale = np.divide(d_int, raw, out=np.ones(n), where=np.abs(raw) > 1e-9)
    attribution = {k: v * scale for k, v in parts.items()}

    obr = obr_baseline(efo, ext_last, m_cut["total"])
    mkt_raw = obr_baseline(efo, ext_last, m_today["total"])
    # For OBR years the market baseline is the OBR's interest plus the repricing; beyond,
    # obr_baseline already anchors the model's shape to the OBR's last year.
    d_full = np.where(np.arange(n) < obr_n, d_int, mkt_raw.interest - obr.interest + d_int[obr_n - 1])
    mkt = with_interest(obr, d_full)

    h_obr, h_mkt = rule_headroom(obr, target), rule_headroom(mkt, target)
    kt = years.index(target)

    progress("Headroom history")
    hist_rows = []
    dates = [d for d in curves["ois"].loc[cut:].index if all(d in df.index for df in curves.values())]
    dates = sorted(set(dates[::5]) | {dates[-1]})          # weekly, plus the latest day
    for d in dates:
        cs = curve_set(curves, d)
        r_d = rpi_obr + inflation_shift(cs, cs_cut, years)
        m_d = run(cs, r_d)
        m_d = run(cs, r_d, m_d["total"] - m_cut["total"])
        dd = m_d["total"] - m_cut["total"]
        hb = rule_headroom(with_interest(obr, np.where(np.arange(n) < obr_n, dd, dd[obr_n - 1])), target)
        hist_rows.append({"date": d.strftime("%Y-%m-%d"), "stability_bn": _r(hb["stability_bn"]),
                          "investment_bn": _r(hb["investment_bn"]), "gilt_10y": _r(float(cs._z("nominal", 10)), 3),
                          "bank_rate_2y": _r(float(cs.fwd("ois", 1.5, 2.5)), 3)})

    progress("Sensitivities")
    sens_rows = {}
    for key, cs_b, r_b in (("rates_100", cs_today.shifted(ois=1, nominal=1, real=1), rpi_mkt),
                           ("bank_rate_100", cs_today.shifted(ois=1), rpi_mkt),
                           ("gilts_100", cs_today.shifted(nominal=1, real=1), rpi_mkt),
                           ("rpi_100", cs_today, rpi_mkt + 1)):
        sens_rows[key] = run(cs_b, r_b)["total"] - m_today["total"]

    progress("Debt dynamics")
    hist = history_table(pusf, q)
    h_years = [int(y) for y in hist.index]
    dyn_hist = decompose(h_years[1:], hist["psnd_exboe_pct"].to_numpy()[1:], float(hist["psnd_exboe_pct"].iloc[0]),
                         float(hist["psnd_exboe"].iloc[0]), hist["psnd_exboe"].to_numpy()[1:], hist["gdp_c"].to_numpy()[1:],
                         float(hist["gdp_c"].iloc[0]), hist["net_interest"].to_numpy()[1:], hist["primary"].to_numpy()[1:])
    gdp_c0 = efo["determinants"]["nominal_gdp_centred_bn"][o - 1]
    d0 = 100 * mkt.psnd0 / gdp_c0

    def dyn(b: Baseline) -> list[dict]:
        return decompose(b.years, b.pct("psnd"), d0, b.psnd0, b.psnd, b.gdp_c, gdp_c0, b.net_interest,
                         b.pd_pct * b.gdp / 100)
    dyn_obr, dyn_mkt = dyn(obr), dyn(mkt)

    progress("Stochastic projections")
    seed = zlib.crc32(f"dsa:{slug}".encode())
    first_q = pd.Period(f"{years[0]}Q2")
    n_q = 4 * n
    dev_q, var_info = var_shocks(q, n_q, N_PATHS, seed)
    dev = to_fiscal_years(dev_q, first_q, years)
    k_now = next((i for i, y in enumerate(years) if pd.Timestamp(y + 1, 3, 31) >= last_day), 0)
    dev[:, :k_now] = 0                       # completed years are not shocked
    rho = bohn(hist)
    rng = np.random.default_rng(seed + 1)
    pb_shock = rng.normal(0, rho["resid_sd"], size=(N_PATHS, n))
    pb_shock[:, :k_now] = 0
    sens = sensitivity(m_today, mix)
    sim = project(mkt, sens, dev[..., 0], dev[..., 1], dev[..., 2], dev[..., 3], pb_shock, cyc, rho["used"])
    fan = {key: [{"year": fd.fy_label(y), **{f"p{p}": _r(np.percentile(sim[key][:, i], p)) for p in PCTS}}
                 for i, y in enumerate(years)] for key in ("psnfl_pct", "psnd_pct", "psnb_pct", "interest_receipts")}
    fl = sim["psnfl_pct"]
    prob = {
        "stability": float((sim["cbd_bn"][:, kt] <= 0).mean()),
        "investment": float((fl[:, kt] < fl[:, kt - 1]).mean()) if kt > 0 else None,
        "both": float(((sim["cbd_bn"][:, kt] <= 0) & (fl[:, kt] < fl[:, kt - 1])).mean()) if kt > 0 else None,
        "debt_falling_end": float((sim["psnd_pct"][:, -1] < sim["psnd_pct"][:, -6]).mean()),
        "debt_above_100": float((sim["psnd_pct"][:, -1] > 100).mean()),
        "end_year": fd.fy_label(years[-1]),
        "from_year": fd.fy_label(years[-6]),
    }

    progress("Scenarios")
    scen = []
    mkt_bank = bank_rate_path(cs_today, years, realized)
    for sid, name, desc, spec in SCENARIOS:
        a = {k: _scenario_path(spec.get(k, [0]), n)[None, :] for k in ("growth", "inflation", "br", "gilt", "pd")}
        for k in a:
            a[k][:, :k_now] = 0
        a["br"] = np.maximum(a["br"], 0.1 - mkt_bank[None, :])          # Bank Rate floor at 0.1%
        res = project(mkt, sens, a["growth"], a["inflation"], a["br"], a["gilt"], a["pd"], cyc, 0.0)
        flp = res["psnfl_pct"][0]
        scen.append({
            "id": sid, "name": name, "description": desc,
            "stability_bn": _r(-res["cbd_bn"][0, kt]),
            "investment_pp": _r(flp[kt - 1] - flp[kt]) if kt > 0 else None,
            "psnd_end": _r(res["psnd_pct"][0, -1]), "interest_end": _r(res["interest_bn"][0, -1]),
            "paths": [{"year": fd.fy_label(y), "psnfl_pct": _r(res["psnfl_pct"][0, i]), "psnd_pct": _r(res["psnd_pct"][0, i]),
                       "psnb_pct": _r(res["psnb_pct"][0, i]), "interest_bn": _r(res["interest_bn"][0, i])}
                      for i, y in enumerate(years)],
        })

    progress("Assembling")
    payload = {
        "slug": slug,
        "title": COUNTRIES[slug]["title"],
        "country": COUNTRIES[slug]["country"],
        "as_of": last_day.strftime("%Y-%m-%d"),
        "computed_at": _now(),
        "target_year": rules["target_year"],
        "sources": _sources(pusf, efo, cs_cut, cs_today, port, register_meta, cut),
        "rules": _rules(rules, h_obr, h_mkt, attribution, kt, prob, mkt, hist_rows),
        "projection": _projection(hist, obr, mkt, years, obr_n),
        "fan": fan,
        "probabilities": prob,
        "dynamics": {"history": _clean(dyn_hist), "obr": _clean(dyn_obr), "market": _clean(dyn_mkt)},
        "interest": _interest(years, obr_n, obr, mkt, m_cut, m_today, sens_rows, efo, hist),
        "financing": _financing(port, years, m_today, mkt, pusf),
        "scenarios": scen,
        "tracker": _tracker(pusf, efo),
        "market": _market(curves, cs_cut, cs_today),
        "model": {
            "var": var_info, "bohn": {k: (_r(v, 4) if isinstance(v, float) else v) for k, v in rho.items()},
            "paths": N_PATHS, "cyclical": cyc, "issuance_mix": mix, "apf": rules["apf"],
            "rules_note": rules["target_note"], "extension_note": rules["extension"]["note"],
        },
    }
    return payload


def _clean(rows: list[dict]) -> list[dict]:
    return [{k: (_r(v) if isinstance(v, (float, np.floating)) else v) for k, v in r.items()} for r in rows]


def _sources(pusf, efo, cs_cut, cs_today, port, register_meta, cut) -> dict:
    return {
        "pusf_release": pusf.release_date.strftime("%Y-%m-%d") if pusf.release_date is not None else None,
        "pusf_next_release": pusf.next_release,
        "pusf_latest_month": str(pusf.monthly["psnb"].dropna().index[-1]),
        "pusf_editions": pusf.editions,
        "obr_edition": efo["edition"],
        "obr_source": efo.get("source"),
        "obr_cutoff": cut.strftime("%Y-%m-%d"),
        "curves_cutoff": cs_cut.date.strftime("%Y-%m-%d"),
        "curves_latest": cs_today.date.strftime("%Y-%m-%d"),
        "register_source": port.source,
        "register_note": port.note,
        "register_upload": register_meta,
    }


def _rules(rules, h_obr, h_mkt, attribution, kt, prob, mkt, hist_rows) -> list[dict]:
    out = []
    for r in rules["rules"]:
        if r["id"] == "stability":
            ob, mk = h_obr["stability_bn"], h_mkt["stability_bn"]
            attr = {k: -v[kt] for k, v in attribution.items()}
            p = prob["stability"]
            extra = {"unit": "£bn", "obr_pp": None, "market_pp": None}
        else:
            ob, mk = h_obr["investment_bn"], h_mkt["investment_bn"]
            # PSNFL rises by the extra borrowing; the rule compares the ratio with the year
            # before, so the target year's extra borrowing counts, less the growth of the
            # earlier extra debt's denominator
            g_ratio = mkt.gdp_c[kt] / mkt.gdp_c[kt - 1]
            attr = {k: -(np.cumsum(v)[kt] - np.cumsum(v)[kt - 1] * g_ratio) for k, v in attribution.items()}
            p = prob["investment"]
            extra = {"unit": "£bn", "obr_pp": _r(h_obr["investment_pp"]), "market_pp": _r(h_mkt["investment_pp"])}
        out.append({**r, "obr_bn": _r(ob, 1), "market_bn": _r(mk, 1), "change_bn": _r(mk - ob, 1),
                    "attribution": {k: _r(v, 1) for k, v in attr.items()}, "probability": _r(p, 3),
                    "history": [{"date": h["date"], "value": h[f"{r['id']}_bn"]} for h in hist_rows], **extra})
    return out


def _projection(hist: pd.DataFrame, obr: Baseline, mkt: Baseline, years: list[int], obr_n: int) -> list[dict]:
    rows = []
    for fy, h in hist.iterrows():
        rows.append({"year": fd.fy_label(int(fy)), "kind": "outturn",
                     "psnfl_pct": _r(h["psnfl_pct"]), "psnd_pct": _r(h["psnd_exboe_pct"]),
                     "psnb_pct": _r(100 * h["psnb"] / h["gdp"]) if pd.notna(h["gdp"]) else None,
                     "cbd_bn": _r(h["cbd"]), "interest_bn": _r(h["cg_interest"]),
                     "interest_receipts": _r(100 * h["cg_interest"] / h["receipts"]),
                     "obr_psnfl_pct": None, "obr_psnd_pct": None, "obr_psnb_pct": None, "obr_cbd_bn": None, "obr_interest_bn": None})
    fl_m, nd_m, nb_m = mkt.pct("psnfl"), mkt.pct("psnd"), mkt.pct("psnb")
    fl_o, nd_o, nb_o = obr.pct("psnfl"), obr.pct("psnd"), obr.pct("psnb")
    last_outturn = int(hist.index.max())
    for k, fy in enumerate(years):
        if fy <= last_outturn:
            continue
        rows.append({"year": fd.fy_label(fy), "kind": "forecast" if k < obr_n else "extension",
                     "psnfl_pct": _r(fl_m[k]), "psnd_pct": _r(nd_m[k]), "psnb_pct": _r(nb_m[k]),
                     "cbd_bn": _r(mkt.cbd[k], 1), "interest_bn": _r(mkt.interest[k], 1),
                     "interest_receipts": _r(100 * mkt.interest[k] / mkt.receipts[k]),
                     "obr_psnfl_pct": _r(fl_o[k]), "obr_psnd_pct": _r(nd_o[k]), "obr_psnb_pct": _r(nb_o[k]),
                     "obr_cbd_bn": _r(obr.cbd[k], 1), "obr_interest_bn": _r(obr.interest[k], 1)})
    return rows


def _interest(years, obr_n, obr, mkt, m_cut, m_today, sens_rows, efo, hist) -> dict:
    rows = []
    for k, fy in enumerate(years):
        rows.append({
            "year": fd.fy_label(fy), "kind": "forecast" if k < obr_n else "extension",
            "obr": _r(obr.interest[k], 1), "market": _r(mkt.interest[k], 1), "change": _r(mkt.interest[k] - obr.interest[k], 1),
            "conventional": _r(m_today["conventional"][k], 1), "index_linked": _r(m_today["uplift"][k] + m_today["linker_coupon"][k], 1),
            "floating": _r(m_today["floating"][k], 1), "apf_offset": _r(-m_today["apf_offset"][k], 1),
            "model_total": _r(m_today["total"][k], 1), "model_obr_curves": _r(m_cut["total"][k], 1),
            "effective_rate": _r(100 * mkt.interest[k] / (mkt.psnd[k - 1] if k else mkt.psnd0)),
            **{f"sens_{key}": _r(v[k], 1) for key, v in sens_rows.items()},
        })
    h = [{"year": fd.fy_label(int(fy)), "interest": _r(r["cg_interest"], 1), "uplift": _r(r["il_uplift"], 1),
          "apf": _r(-r["apf_net_interest"], 1)} for fy, r in hist.iterrows() if pd.notna(r["cg_interest"])]
    s = efo.get("sensitivities", {})
    return {"rows": rows, "history": h,
            "obr_reckoner": {"rates_1pp_bn": s.get("rates_1pp_bn"), "rpi_1pp_bn": s.get("rpi_1pp_bn"), "year": s.get("year")}}


def _financing(port: Portfolio, years, m_today, mkt: Baseline, pusf: fd.Pusf) -> dict:
    conv = port.conv.groupby("mat")["amount"].sum()
    link = port.linkers.groupby("mat")["amount"].sum()
    mats = sorted(set(conv.index) | set(link.index))
    profile = [{"year": fd.fy_label(int(m)), "conventional": _r(conv.get(m, 0.0), 1), "index_linked": _r(link.get(m, 0.0), 1)}
               for m in mats if m <= years[0] + 50]
    total_gilts = port.conv["amount"].sum() + port.linkers["amount"].sum()
    fy_now = fd.fy_of(pd.Period(port.as_of, "M"))          # the portfolio is today's: earlier years are history
    wam = lambda df: float(np.average(df["mat"] - fy_now + 0.5, weights=df["amount"])) if len(df) else None  # noqa: E731
    floating = port.bills + port.nsandi + port.reserves
    debt = float(pusf.monthly["psnd_exboe"].dropna().iloc[-1]) / 1000.0
    return {
        "profile": profile,
        "gross": [{"year": fd.fy_label(y), "redemptions": _r(m_today["redemptions"][k], 1),
                   "net_need": _r(m_today["gross_issuance"][k] - m_today["redemptions"][k], 1),
                   "gross": _r(m_today["gross_issuance"][k], 1), "gross_pct": _r(100 * m_today["gross_issuance"][k] / mkt.gdp[k])}
                  for k, y in enumerate(years) if y >= fy_now],
        "gilts_bn": _r(total_gilts, 0),
        "linker_share": _r(port.linkers["amount"].sum() / total_gilts, 3),
        "avg_maturity_conventional": _r(wam(port.conv), 1),
        "avg_maturity_linkers": _r(wam(port.linkers), 1),
        "bills_bn": _r(port.bills, 0), "nsandi_bn": _r(port.nsandi, 0), "reserves_bn": _r(port.reserves, 0),
        "apf_bn": _r(port.apf, 0), "apf_share": _r(port.apf / total_gilts, 3),
        "floating_share": _r((floating + port.linkers["amount"].sum()) / debt, 3),
        "repricing_1y_bn": _r(floating + port.conv.loc[port.conv["mat"] <= fy_now, "amount"].sum()
                              + port.linkers["amount"].sum(), 0),
        "debt_bn": _r(debt, 0),
        "as_of": port.as_of.strftime("%Y-%m-%d"),
    }


def _tracker(pusf: fd.Pusf, efo: dict) -> dict:
    mo = pusf.monthly["psnb"].dropna() / 1000.0
    last = mo.index[-1]
    fy = fd.fy_of(last)
    cur = mo[[fd.fy_of(p) == fy for p in mo.index]]
    prev = mo[[fd.fy_of(p) == fy - 1 for p in mo.index]]
    n_m = len(cur)
    # Share of the full year borrowed by the same month in the last three normal years
    shares = []
    for y in range(fy - 1, fy - 8, -1):
        s = mo[[fd.fy_of(p) == y for p in mo.index]]
        if y not in (2020, 2021) and len(s) == 12 and abs(s.sum()) > 1:
            shares.append(s.iloc[:n_m].sum() / s.sum())
        if len(shares) == 3:
            break
    share = float(np.mean(shares)) if shares else n_m / 12
    label = fd.fy_label(fy)
    obr_fy = efo["bn"]["psnb"][efo["years"].index(label)] if label in efo["years"] else None
    prev_total = float(prev.sum()) if len(prev) == 12 else None
    months = []
    for i in range(12):
        p = pd.Period(year=fy if i < 9 else fy + 1, month=(i + 3) % 12 + 1, freq="M")
        q_ = pd.Period(year=fy - 1 if i < 9 else fy, month=(i + 3) % 12 + 1, freq="M")
        prof = (prev.get(q_) * obr_fy / prev_total) if (obr_fy and prev_total and q_ in prev.index) else None
        months.append({"month": str(p), "current": _r(cur.get(p), 1), "previous": _r(prev.get(q_), 1), "obr_profile": _r(prof, 1)})
    ytd = float(cur.sum())
    ytd_prev = float(prev.iloc[:n_m].sum())
    nxt = last + 1
    nxt_q = pd.Period(year=nxt.year - 1, month=nxt.month, freq="M")
    nxt_fc = float(prev[nxt_q] * obr_fy / prev_total) if (obr_fy and prev_total and nxt_q in prev.index) else None
    return {
        "year": label, "months_observed": n_m, "latest_month": str(last),
        "ytd_bn": _r(ytd, 1), "ytd_previous_bn": _r(ytd_prev, 1),
        "ytd_obr_profile_bn": _r(ytd_prev * obr_fy / prev_total, 1) if (obr_fy and prev_total) else None,
        "obr_full_year_bn": obr_fy, "implied_full_year_bn": _r(ytd / share, 1) if share > 0.05 else None,
        "previous_full_year_bn": _r(prev_total, 1),
        "typical_share": _r(share, 3),
        "next_release": pusf.next_release, "next_month": str(nxt), "next_month_forecast_bn": _r(nxt_fc, 1),
        "months": months,
    }


def _market(curves: dict[str, pd.DataFrame], cs_cut: CurveSet, cs_today: CurveSet) -> dict:
    def gauges(cs: CurveSet) -> dict:
        return {
            "gilt_2y": float(cs._z("nominal", 2)), "gilt_10y": float(cs._z("nominal", 10)), "gilt_30y": float(cs._z("nominal", 30)),
            "real_10y": float(cs._z("real", 10)), "rpi_10y": float(cs._z("inflation", 10)),
            "rpi_5y5y": float(cs.fwd("inflation", 5, 10)), "ois_2y": float(cs._z("ois", 2)), "ois_10y": float(cs._z("ois", 10)),
            "gilt_ois_10y": 100 * float(cs._z("nominal", 10) - cs._z("ois", 10)),
            "term_10s30s": 100 * float(cs._z("nominal", 30) - cs._z("nominal", 10)),
        }
    year_ago = curve_set(curves, cs_today.date - pd.DateOffset(years=1))
    t, c = gauges(cs_today), gauges(cs_cut)
    y = gauges(year_ago) if year_ago is not None else {}
    labels = {
        "gilt_2y": ("2y gilt", "%"), "gilt_10y": ("10y gilt", "%"), "gilt_30y": ("30y gilt", "%"),
        "real_10y": ("10y real yield", "%"), "rpi_10y": ("10y implied RPI", "%"), "rpi_5y5y": ("5y5y implied RPI", "%"),
        "ois_2y": ("2y OIS", "%"), "ois_10y": ("10y OIS", "%"), "gilt_ois_10y": ("10y gilt − OIS", "bp"),
        "term_10s30s": ("10s30s gilt curve", "bp"),
    }
    rows = [{"id": k, "label": lab, "unit": u, "latest": _r(t[k], 3), "obr_window": _r(c[k], 3),
             "year_ago": _r(y.get(k), 3) if y else None} for k, (lab, u) in labels.items()]
    nom, ois = curves["nominal"], curves["ois"]
    idx = nom.index.intersection(ois.index)
    z = lambda df, m: pd.Series(np.array([np.interp(m, df.columns.to_numpy(float), r) for r in df.loc[idx].to_numpy(float)]), index=idx)  # noqa: E731
    g10, g30, o10 = z(nom.ffill(axis=1).bfill(axis=1), 10), z(nom.ffill(axis=1).bfill(axis=1), 30), z(ois.ffill(axis=1).bfill(axis=1), 10)
    series = [{"date": d.strftime("%Y-%m-%d"), "gilt_10y": _r(g10[d], 3), "gilt_30y": _r(g30[d], 3),
               "gilt_ois_10y": _r(100 * (g10[d] - o10[d]), 1)} for d in idx]
    curve = [{"maturity": m, "latest": _r(float(cs_today._z("nominal", m)), 3), "obr_window": _r(float(cs_cut._z("nominal", m)), 3),
              "ois_latest": _r(float(cs_today._z("ois", m)), 3) if m <= float(cs_today.ois.index.max()) else None}
             for m in (0.5, 1, 2, 3, 5, 7, 10, 15, 20, 25, 30, 40)]
    return {"gauges": rows, "series": series, "curve": curve}


# ---------------------------------------------------------------------------
# Jobs and API
# ---------------------------------------------------------------------------

@dataclass
class Job:
    kind: str
    state: str = "idle"                # idle | running | done | error
    step: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    error: str | None = None


_jobs: dict[str, Job] = {}
_lock = threading.Lock()
_compute_lock = threading.Lock()
_payloads: dict[str, dict] = {}


def _payload_path(slug: str) -> Path:
    return _root() / slug / "payload.json"


INPUTS = None                       # tests: a function returning Inputs (no downloads)


def _update(slug: str, job: Job | None) -> dict:
    with _compute_lock:
        progress = (lambda s: setattr(job, "step", s)) if job else (lambda s: None)
        payload = build_payload(slug, progress=progress, inputs=INPUTS() if INPUTS else None)
        _write(_payload_path(slug), payload)
        _payloads[slug] = payload
        return payload


def _start(slug: str) -> Job:
    with _lock:
        job = _jobs.get(slug)
        if job and job.state == "running":
            return job
        job = _jobs[slug] = Job("update", state="running", started_at=_now(), step="Queued")

    def run() -> None:
        try:
            _update(slug, job)
            job.state = "done"
        except Exception as exc:
            logger.exception("Debt sustainability %s update failed", slug)
            job.state, job.error = "error", f"{type(exc).__name__}: {exc}"
        finally:
            job.finished_at = _now()

    threading.Thread(target=run, name=f"dsa-{slug}", daemon=True).start()
    return job


def _stale(payload: dict) -> bool:
    age = pd.Timestamp.now() - pd.Timestamp(payload.get("computed_at") or "1970-01-01")
    return age > pd.Timedelta(minutes=REFRESH_MINUTES)


def get_dsa(slug: str) -> dict:
    """Saved payload; refreshed in the background when over an hour old, computed here only on first use."""
    payload = _payloads.get(slug) or _read(_payload_path(slug))
    if payload is None:
        with _compute_lock:
            payload = _payloads.get(slug)
        if payload is None:
            return _update(slug, None)
    _payloads[slug] = payload
    if _stale(payload):
        _start(slug)
    return payload


def start_refresh(slug: str) -> dict:
    _start(slug)
    return get_status(slug)


def get_status(slug: str) -> dict:
    payload = _payloads.get(slug) or _read(_payload_path(slug)) or {}
    with _lock:
        job = _jobs.get(slug) or Job("update")
    return {"slug": slug, "computed_at": payload.get("computed_at"), "as_of": payload.get("as_of"),
            "job": dataclasses.asdict(job)}


def save_upload(slug: str, filename: str, data: bytes) -> dict:
    """An OBR EFO PDF or a DMO gilts-in-issue report → saved, then a refresh."""
    name = Path(filename).name
    if data[:4] == b"%PDF" or name.lower().endswith(".pdf"):
        folder = _root() / "uploads" / "obr"
        folder.mkdir(parents=True, exist_ok=True)
        pdf = folder / name
        pdf.write_bytes(data)
        efo = fd.parse_efo_pdf(pdf, "uploaded")
        stamp = fd._edition_date(efo["edition"]).strftime("%Y-%m")
        _write(folder / f"efo_{stamp}.json", efo)
        kind, detail = "obr", f"OBR Economic and fiscal outlook, {efo['edition']}"
    else:
        reg = fd.parse_gilt_register(data, name)
        folder = _root() / "uploads" / "dmo"
        folder.mkdir(parents=True, exist_ok=True)
        stamp = pd.Timestamp.now().strftime("%Y%m%d-%H%M%S")
        (folder / f"{stamp}_{name}").write_bytes(data)
        kind, detail = "dmo", f"DMO gilts in issue: {len(reg)} gilts ({int(reg['index_linked'].sum())} index-linked)"
    _start(slug)
    return {"kind": kind, "detail": detail, "status": get_status(slug)}


def warm_cache() -> None:
    for slug in COUNTRIES:
        get_dsa(slug)
