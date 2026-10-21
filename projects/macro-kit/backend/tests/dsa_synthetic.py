"""Deterministic synthetic inputs for the debt sustainability monitor (tests and the
frontend fixture): a UK-sized public sector, Bank of England curves and quarterly
macro history, with no downloads. The OBR forecast is the real one shipped in
backend/data/obr/."""
from __future__ import annotations

import zlib

import numpy as np
import pandas as pd

import debt_sustainability as ds
import fiscal_data as fd

LAST_CURVE_DAY = pd.Timestamp("2026-10-20")


def _rng(name: str) -> np.random.Generator:
    return np.random.default_rng(zlib.crc32(name.encode()))


def pusf() -> fd.Pusf:
    idx = pd.period_range("1997-04", "2026-09", freq="M")
    n = len(idx)
    t = np.arange(n) / 12.0
    rng = _rng("dsa:pusf")
    gdp_c = 900_000 * 1.042 ** t                                   # £m a year, centred
    debt_pct = 40 + 50 * (1 - np.exp(-np.maximum(t - 10, 0) / 6))     # 40% → about 89%
    psnd_exboe = debt_pct / 100 * gdp_c
    month = np.array([p.month for p in idx])
    season = np.where(month == 1, -1.4, np.where(month == 7, 0.2, 0.12))
    psnb = gdp_c / 12 * (0.035 + 0.25 * season / 12 * 12 / 12) + rng.normal(0, 1500, n)
    netinv = gdp_c / 12 * 0.022
    receipts = gdp_c / 12 * 0.39
    df = pd.DataFrame({
        "psnb": psnb, "cbd": psnb - netinv, "net_investment": netinv, "receipts": receipts, "tme": receipts + psnb,
        "interest_paid": psnd_exboe * 0.042 / 12, "interest_received": psnd_exboe * 0.012 / 12,
        "cg_interest_ex_uplift": psnd_exboe * 0.026 / 12, "il_uplift": psnd_exboe * 0.008 / 12,
        "apf_net_interest": -psnd_exboe * 0.003 / 12,
        "psnd": psnd_exboe * 1.05 / 1000, "psnd_pct": debt_pct * 1.05,
        "psnd_exboe": psnd_exboe, "psnd_exboe_pct": debt_pct,
        "psnfl": psnd_exboe * 0.91 / 1000, "psnfl_pct": debt_pct * 0.91,
        "gilts": psnd_exboe * 0.94, "tbills": np.full(n, 90_000.0), "nsandi": np.full(n, 250_000.0),
        "apf_gilts": np.full(n, 400_000.0), "apf_loan": np.full(n, 520_000.0),
    }, index=idx)
    return fd.Pusf(monthly=df, release_date=pd.Timestamp("2026-10-21"), next_release="20 November 2026", editions=["2026-10-21"])


def curves(move: float = 0.0, move_from: str = "2026-04-01") -> dict[str, pd.DataFrame]:
    """Flat-ish curves since 2025; ``move`` pp added to every curve from ``move_from``."""
    days = pd.bdate_range("2025-01-02", LAST_CURVE_DAY)
    shift = np.where(days >= pd.Timestamp(move_from), move, 0.0)[:, None]

    def frame(mats, level, slope):
        base = level + slope * np.asarray(mats)[None, :]
        return pd.DataFrame(base + shift, index=days, columns=[float(m) for m in mats])

    return {
        "nominal": frame(np.arange(0.5, 40.01, 0.5), 4.2, 0.02),
        "real": frame(np.arange(2.5, 40.01, 0.5), 1.0, 0.02),
        "inflation": frame(np.arange(2.5, 40.01, 0.5), 3.2, 0.0) - shift,     # breakevens unchanged
        "ois": frame(np.arange(0.5, 25.01, 0.5), 4.0, 0.0),
    }


def quarterly() -> pd.DataFrame:
    idx = pd.period_range("1985Q1", "2026Q2", freq="Q")
    n = len(idx)
    rng = _rng("dsa:quarterly")
    g = np.zeros(n)
    infl = np.zeros(n)
    br = np.zeros(n)
    for i in range(1, n):
        g[i] = 0.5 + 0.3 * g[i - 1] + rng.normal(0, 0.6)
        infl[i] = 0.5 + 0.5 * infl[i - 1] + rng.normal(0, 0.5)
        br[i] = 0.95 * br[i - 1] + 0.05 * 4.0 + rng.normal(0, 0.3)
    br = np.clip(br + 4.0 - br[-8:].mean(), 0.1, None)
    br[-8:] = 4.0                                                     # matches the flat OIS curve
    real = 300_000 * np.exp(np.cumsum(g) / 100)
    deflator = np.exp(np.cumsum(infl) / 100)
    return pd.DataFrame({
        "bank_rate": br, "gilt_5y": br + 0.4, "gilt_10y": br + 0.7 + rng.normal(0, 0.1, n), "gilt_20y": br + 1.0,
        "real_gdp": real, "nominal_gdp": real * deflator * 2.4,
    }, index=idx)


def inputs(move: float = 0.0) -> ds.Inputs:
    return ds.Inputs(pusf(), curves(move), quarterly(), fd.load_efo(ds._root() / "uploads" / "obr"),
                     *ds.load_register())
