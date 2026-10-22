"""Deterministic synthetic inputs for the Labour Market Nowcast (tests and the frontend
fixture): a latent employment cycle driving survey and official indicators with the same
coverage and publication lags as the real ones, and no downloads."""
from __future__ import annotations

import zlib

import numpy as np
import pandas as pd

import labour_data as ld

LAST = pd.Period("2026-09", "M")


def _rng(name: str) -> np.random.Generator:
    return np.random.default_rng(zlib.crc32(name.encode()))


def factor(n: int) -> np.ndarray:
    rng = _rng("labour:factor")
    f = np.zeros(n)
    for t in range(2, n):
        f[t] = 1.2 * f[t - 1] - 0.3 * f[t - 2] + rng.normal(0, 0.35)
    return f


def data(tweak: dict | None = None) -> ld.LabourData:
    """``tweak`` overrides the latest value of a series, e.g. {"agents_employment": 2.0}."""
    idx = pd.period_range("2000-01", LAST, freq="M")
    n = len(idx)
    f = factor(n)
    rng = _rng("labour:noise")

    def level(mean_growth, load, noise, start=100.0):
        g = mean_growth + load * f + rng.normal(0, noise, n)
        return start * np.cumprod(1 + g / 100)

    def survey(load, noise, centre=0.0):
        return centre + load * f + rng.normal(0, noise, n)

    df = pd.DataFrame({
        "lfs_employment": level(0.07, 0.06, 0.12, 27_000.0),
        "lfs_active": level(0.075, 0.02, 0.05, 28_400.0),
        "vacancies": level(0.1, 0.8, 1.5, 650.0),
        "real_awe": level(0.08, 0.05, 0.3, 450.0),
        "payrolls": level(0.08, 0.05, 0.03, 26_000_000.0),
        "agents_employment": survey(0.6, 0.3, 0.5),
        "agents_recruitment": survey(0.7, 0.4, 0.0),
        "dmp_realised": survey(0.5, 0.25, 1.0),
        "dmp_expected": survey(0.6, 0.25, 1.5),
    }, index=idx)
    df["lfs_unemployment_rate"] = 100 * (1 - df["lfs_employment"] / df["lfs_active"])
    # coverage and publication lags as in the real data
    df.loc[: pd.Period("2001-07", "M"), "vacancies"] = np.nan
    df.loc[: pd.Period("2014-09", "M"), "payrolls"] = np.nan
    df.loc[: pd.Period("2016-12", "M"), ["dmp_realised", "dmp_expected"]] = np.nan
    df.loc[LAST - 1:, ["lfs_employment", "lfs_active", "lfs_unemployment_rate"]] = np.nan
    df.loc[LAST:, ["vacancies", "real_awe", "agents_employment", "agents_recruitment"]] = np.nan
    for k, v in (tweak or {}).items():
        last = df[k].last_valid_index()
        df.loc[last, k] = v
    missing = {s["id"]: "Bloomberg series (data source is not Bloomberg)" for s in ld.catalogue()["series"] if s["source"] == "bloomberg"}
    sources = {"lms": ld.SourceInfo("ONS Labour Market Statistics", "lms.csv", str(LAST - 2), "2026-10-20", "17 November 2026"),
               "rti": ld.SourceInfo("HMRC PAYE RTI (ONS)", "rtisa.xlsx", str(LAST)),
               "agents": ld.SourceInfo("Bank of England Agents' scores", "agentsscores.xlsx", str(LAST - 1)),
               "dmp": ld.SourceInfo("Decision Maker Panel", "monthly-dmp-data.xlsx", str(LAST))}
    return ld.LabourData(df, sources, missing)


def gdp() -> pd.Series:
    """Quarterly real GDP growth (q/q %) loosely tied to the same cycle."""
    idx = pd.period_range("1995Q1", "2026Q2", freq="Q")
    rng = _rng("labour:gdp")
    f = factor(3 * len(idx) + 60)[60::3][: len(idx)]
    return pd.Series(0.45 + 0.3 * f + rng.normal(0, 0.3, len(idx)), index=idx)
