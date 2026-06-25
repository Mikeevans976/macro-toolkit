"""
HICPxT Inflation Swap Fair Value Models — synthetic data.
Rolling Elastic Net. Replace _simulate() with live BBG pulls when ready.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.linear_model import ElasticNet
from sklearn.preprocessing import StandardScaler

# ─── Configuration ────────────────────────────────────────────────────────────

DATES: pd.DatetimeIndex = pd.bdate_range("2004-01-02", "2024-12-31")
T: int = len(DATES)
_RNG = np.random.default_rng(20240101)

ROLL_WINDOW: int = 500   # ~2 calendar years
MIN_WINDOW:  int = 252   # minimum obs before first fit
OUTPUT_STEP: int = 5     # subsample every N days for API response

_GROUPS = [
    {"id": "outright", "label": "Outright HICPxT",
     "model_ids": ["hicp_1y", "hicp_2y", "hicp_5y", "hicp_10y", "hicp_15y", "hicp_20y", "hicp_30y"]},
    {"id": "forward",  "label": "Forward Swaps",
     "model_ids": ["hicp_1y1y", "hicp_2y1y", "hicp_2y2y", "hicp_2y3y", "hicp_5y5y", "hicp_10y10y", "hicp_20y10y"]},
]

_MODEL_DEFS: list[dict] = [
    # Group 1: Outright
    {"id": "hicp_1y",    "title": "EUR 1Y HICPxT",    "group": "outright",
     "x_names": ["1Y Swap",    "log(Brent)", "log(Gas)"],
     "x_keys":  ["EESWE1",     "log_Brent",  "log_Gas"],
     "y_key":   "EUSWI1"},
    {"id": "hicp_2y",    "title": "EUR 2Y HICPxT",    "group": "outright",
     "x_names": ["2Y Swap",    "log(Brent)", "log(Gas)"],
     "x_keys":  ["EESWE2",     "log_Brent",  "log_Gas"],
     "y_key":   "EUSWI2"},
    {"id": "hicp_5y",    "title": "EUR 5Y HICPxT",    "group": "outright",
     "x_names": ["5Y Swap",    "log(Brent)", "log(Gas)"],
     "x_keys":  ["EESWE5",     "log_Brent",  "log_Gas"],
     "y_key":   "EUSWI5"},
    {"id": "hicp_10y",   "title": "EUR 10Y HICPxT",   "group": "outright",
     "x_names": ["10Y Swap",   "log(Brent)", "log(Gas)"],
     "x_keys":  ["EESWE10",    "log_Brent",  "log_Gas"],
     "y_key":   "EUSWI10"},
    {"id": "hicp_15y",   "title": "EUR 15Y HICPxT",   "group": "outright",
     "x_names": ["15Y Swap",   "log(Brent)", "log(Gas)"],
     "x_keys":  ["EESWE15",    "log_Brent",  "log_Gas"],
     "y_key":   "EUSWI15"},
    {"id": "hicp_20y",   "title": "EUR 20Y HICPxT",   "group": "outright",
     "x_names": ["20Y Swap",   "log(Brent)", "log(Gas)"],
     "x_keys":  ["EESWE20",    "log_Brent",  "log_Gas"],
     "y_key":   "EUSWI20"},
    {"id": "hicp_30y",   "title": "EUR 30Y HICPxT",   "group": "outright",
     "x_names": ["30Y Swap",   "log(Brent)", "log(Gas)"],
     "x_keys":  ["EESWE30",    "log_Brent",  "log_Gas"],
     "y_key":   "EUSWI30"},
    # Group 2: Forward Swaps
    {"id": "hicp_1y1y",   "title": "EUR 1Y1Y HICPxT",   "group": "forward",
     "x_names": ["1Y1Y ESTR",   "log(Brent)", "log(Gas)"],
     "x_keys":  ["ESTR_1Y1Y",   "log_Brent",  "log_Gas"],
     "y_key":   "HICP_1Y1Y"},
    {"id": "hicp_2y1y",   "title": "EUR 2Y1Y HICPxT",   "group": "forward",
     "x_names": ["2Y1Y ESTR",   "log(Brent)", "log(Gas)"],
     "x_keys":  ["ESTR_2Y1Y",   "log_Brent",  "log_Gas"],
     "y_key":   "HICP_2Y1Y"},
    {"id": "hicp_2y2y",   "title": "EUR 2Y2Y HICPxT",   "group": "forward",
     "x_names": ["2Y2Y ESTR",   "log(Brent)", "log(Gas)"],
     "x_keys":  ["ESTR_2Y2Y",   "log_Brent",  "log_Gas"],
     "y_key":   "HICP_2Y2Y"},
    {"id": "hicp_2y3y",   "title": "EUR 2Y3Y HICPxT",   "group": "forward",
     "x_names": ["2Y3Y ESTR",   "log(Brent)", "log(Gas)"],
     "x_keys":  ["ESTR_2Y3Y",   "log_Brent",  "log_Gas"],
     "y_key":   "HICP_2Y3Y"},
    {"id": "hicp_5y5y",   "title": "EUR 5Y5Y HICPxT",   "group": "forward",
     "x_names": ["5Y5Y ESTR",   "log(Brent)", "log(Gas)"],
     "x_keys":  ["ESTR_5Y5Y",   "log_Brent",  "log_Gas"],
     "y_key":   "HICP_5Y5Y"},
    {"id": "hicp_10y10y", "title": "EUR 10Y10Y HICPxT", "group": "forward",
     "x_names": ["10Y10Y ESTR", "log(Brent)", "log(Gas)", "1M Swaption Vol"],
     "x_keys":  ["ESTR_10Y10Y", "log_Brent",  "log_Gas",  "SMOVEU1M"],
     "y_key":   "HICP_10Y10Y"},
    {"id": "hicp_20y10y", "title": "EUR 20Y10Y HICPxT", "group": "forward",
     "x_names": ["20Y10Y ESTR", "log(Brent)", "log(Gas)", "1M Swaption Vol"],
     "x_keys":  ["ESTR_20Y10Y", "log_Brent",  "log_Gas",  "SMOVEU1M"],
     "y_key":   "HICP_20Y10Y"},
]

# ─── Simulation ───────────────────────────────────────────────────────────────

def _simulate() -> dict[str, np.ndarray]:
    """Return dict mapping key → [T] array of simulated market data."""

    years = np.array([(d.year + d.dayofyear / 365.0) for d in DATES])

    # ── Latent factors ──────────────────────────────────────────────────────
    # F_rates: global rates/inflation cycle, AR(0.9990), slow trend
    F_rates = np.zeros(T)
    for t in range(1, T):
        F_rates[t] = 0.9990 * F_rates[t - 1] + _RNG.normal(0, 0.012)

    # Inflation super-cycle overlay: low until 2022, surge 2021-2023, ease 2024
    supercycle = np.zeros(T)
    for i, y in enumerate(years):
        if y < 2014:
            supercycle[i] = 0.5 - (y - 2004) * 0.06          # 3.5→2.9 slow decline
        elif y < 2016:
            supercycle[i] = -0.3 - (y - 2014) * 0.20         # falls toward zero
        elif y < 2021:
            supercycle[i] = -0.7 + (y - 2016) * 0.04         # near zero / slightly neg
        elif y < 2022.5:
            supercycle[i] = -0.5 + (y - 2021) * 2.133        # sharp surge
        elif y < 2023.5:
            supercycle[i] = 2.7 - (y - 2022.5) * 1.8         # peak then ease
        else:
            supercycle[i] = 0.9 - (y - 2023.5) * 0.6         # continued easing
    supercycle = np.clip(supercycle, -0.8, 2.8)
    F_rates += supercycle

    # F_energy: energy price factor, AR(0.975)
    F_energy = np.zeros(T)
    for t in range(1, T):
        F_energy[t] = 0.975 * F_energy[t - 1] + _RNG.normal(0, 0.028)

    # Energy bumps
    def _bump_energy(center_year: float, height: float, width: float = 0.30):
        F_energy[:] += height * np.exp(-0.5 * ((years - center_year) / width) ** 2)

    _bump_energy(2008.5, 1.5, 0.30)   # 2008 oil spike
    _bump_energy(2009.0, -1.8, 0.25)  # crash
    _bump_energy(2012.0, 0.8, 0.40)   # recovery plateau
    _bump_energy(2016.0, -1.2, 0.30)  # 2016 trough
    _bump_energy(2020.25, -2.5, 0.20) # COVID crash
    _bump_energy(2022.3, 3.0, 0.25)   # 2022 energy crisis
    _bump_energy(2023.0, -2.2, 0.30)  # crash back

    # F_risk: credit/stress factor, AR(0.978)
    F_risk = np.zeros(T)
    for t in range(1, T):
        F_risk[t] = 0.978 * F_risk[t - 1] + _RNG.normal(0, 0.020)

    def _bump_risk(center_year: float, height: float, width: float = 0.25):
        F_risk[:] += height * np.exp(-0.5 * ((years - center_year) / width) ** 2)

    _bump_risk(2008.75, 2.0, 0.30)
    _bump_risk(2011.50, 1.0, 0.25)
    _bump_risk(2020.25, 2.5, 0.20)
    _bump_risk(2022.25, 0.9, 0.20)

    # ── Nominal swap rates (EESWE1..30) ─────────────────────────────────────
    # Params: (mean_bps_as_pct, sensitivity_to_F_rates, idio_std)
    nom_params = {
        "EESWE1":  (0.015, 0.90, 0.012),
        "EESWE2":  (0.015, 0.88, 0.012),
        "EESWE5":  (0.018, 0.82, 0.013),
        "EESWE10": (0.020, 0.76, 0.014),
        "EESWE15": (0.021, 0.73, 0.014),
        "EESWE20": (0.022, 0.70, 0.015),
        "EESWE30": (0.022, 0.68, 0.015),
    }
    out: dict[str, np.ndarray] = {}
    for key, (mean_level, sens, idio_std) in nom_params.items():
        idio = np.zeros(T)
        for t in range(1, T):
            idio[t] = 0.990 * idio[t - 1] + _RNG.normal(0, idio_std)
        series = mean_level + sens * 0.01 * F_rates + idio
        out[key] = np.clip(series, -0.01, 0.065)

    # ── ESTR forward rates ──────────────────────────────────────────────────
    # ESTR forwards slightly below corresponding nominal (no term premium)
    estr_params = {
        "ESTR_1Y1Y":   (0.013, 0.88, 0.013),
        "ESTR_2Y1Y":   (0.014, 0.85, 0.013),
        "ESTR_2Y2Y":   (0.015, 0.83, 0.013),
        "ESTR_2Y3Y":   (0.016, 0.81, 0.013),
        "ESTR_5Y5Y":   (0.019, 0.75, 0.014),
        "ESTR_10Y10Y": (0.021, 0.70, 0.014),
        "ESTR_20Y10Y": (0.021, 0.68, 0.015),
    }
    for key, (mean_level, sens, idio_std) in estr_params.items():
        idio = np.zeros(T)
        for t in range(1, T):
            idio[t] = 0.990 * idio[t - 1] + _RNG.normal(0, idio_std)
        series = mean_level + sens * 0.01 * F_rates + idio
        out[key] = np.clip(series, -0.01, 0.060)

    # ── Brent crude ─────────────────────────────────────────────────────────
    # Simulate log-Brent directly, then exponentiate
    log_brent_base = np.zeros(T)
    brent_idio = np.zeros(T)
    for t in range(1, T):
        brent_idio[t] = 0.980 * brent_idio[t - 1] + _RNG.normal(0, 0.025)
    log_brent_base = np.log(50) + 0.30 * F_energy + brent_idio

    # Deterministic shape anchors
    brent_shape = np.zeros(T)
    for i, y in enumerate(years):
        if y < 2004.5:
            brent_shape[i] = np.log(42)
        elif y < 2008.5:
            brent_shape[i] = np.log(42) + (y - 2004.5) / 4.0 * (np.log(130) - np.log(42))
        elif y < 2009.3:
            brent_shape[i] = np.log(130) - (y - 2008.5) / 0.8 * (np.log(130) - np.log(35))
        elif y < 2012.5:
            brent_shape[i] = np.log(35) + (y - 2009.3) / 3.2 * (np.log(110) - np.log(35))
        elif y < 2016.2:
            brent_shape[i] = np.log(110) - (y - 2012.5) / 3.7 * (np.log(110) - np.log(28))
        elif y < 2019.5:
            brent_shape[i] = np.log(28) + (y - 2016.2) / 3.3 * (np.log(80) - np.log(28))
        elif y < 2020.3:
            brent_shape[i] = np.log(80) - (y - 2019.5) / 0.8 * (np.log(80) - np.log(20))
        elif y < 2022.5:
            brent_shape[i] = np.log(20) + (y - 2020.3) / 2.2 * (np.log(130) - np.log(20))
        elif y < 2024.0:
            brent_shape[i] = np.log(130) - (y - 2022.5) / 1.5 * (np.log(130) - np.log(80))
        else:
            brent_shape[i] = np.log(80)

    # Blend deterministic shape with stochastic component
    log_brent = 0.60 * brent_shape + 0.40 * log_brent_base
    brent = np.exp(log_brent)
    brent = np.clip(brent, 15.0, 145.0)
    out["log_Brent"] = np.log(brent)

    # ── Gas TTF ─────────────────────────────────────────────────────────────
    gas_idio = np.zeros(T)
    for t in range(1, T):
        gas_idio[t] = 0.975 * gas_idio[t - 1] + _RNG.normal(0, 0.030)

    gas_shape = np.zeros(T)
    for i, y in enumerate(years):
        if y < 2021.0:
            gas_shape[i] = np.log(20) + (np.log(30) - np.log(20)) * (y - 2004) / 17.0
        elif y < 2022.5:
            gas_shape[i] = np.log(30) + (y - 2021.0) / 1.5 * (np.log(300) - np.log(30))
        elif y < 2023.3:
            gas_shape[i] = np.log(300) - (y - 2022.5) / 0.8 * (np.log(300) - np.log(30))
        else:
            gas_shape[i] = np.log(30) + (y - 2023.3) / 0.7 * (np.log(40) - np.log(30))
    gas_shape = np.clip(gas_shape, np.log(12), np.log(320))

    log_gas = 0.55 * gas_shape + 0.45 * (np.log(20) + 0.35 * F_energy + gas_idio)
    gas = np.exp(log_gas)
    gas = np.clip(gas, 10.0, 330.0)
    out["log_Gas"] = np.log(gas)

    # ── EUR 1M Swaption Vol (SMOVEU1M) ─────────────────────────────────────
    vol_idio = np.zeros(T)
    for t in range(1, T):
        vol_idio[t] = 0.980 * vol_idio[t - 1] + _RNG.normal(0, 3.0)
    smoveu = 70.0 + 15.0 * F_risk + vol_idio
    out["SMOVEU1M"] = np.clip(smoveu, 45.0, 130.0)

    # ── HICPxT outright rates (EUSWI1..30) ──────────────────────────────────
    hicp_out_params = {
        "EUSWI1":  ("EESWE1",  0.88, 0.22, 0.13, 0.015),
        "EUSWI2":  ("EESWE2",  0.87, 0.21, 0.12, 0.015),
        "EUSWI5":  ("EESWE5",  0.86, 0.20, 0.12, 0.016),
        "EUSWI10": ("EESWE10", 0.85, 0.18, 0.11, 0.016),
        "EUSWI15": ("EESWE15", 0.84, 0.17, 0.11, 0.017),
        "EUSWI20": ("EESWE20", 0.83, 0.16, 0.10, 0.017),
        "EUSWI30": ("EESWE30", 0.82, 0.15, 0.10, 0.018),
    }
    for key, (swap_key, b1, b2, b3, idio_std) in hicp_out_params.items():
        idio = np.zeros(T)
        for t in range(1, T):
            idio[t] = 0.960 * idio[t - 1] + _RNG.normal(0, idio_std)
        series = b1 * out[swap_key] + b2 * out["log_Brent"] * 0.1 + b3 * out["log_Gas"] * 0.05 + idio
        out[key] = np.clip(series + 0.005, -0.005, 0.060)

    # ── HICPxT forward rates ─────────────────────────────────────────────────
    hicp_fwd_params = {
        "HICP_1Y1Y":   ("ESTR_1Y1Y",   0.85, 0.18, 0.12, None, 0.0180),
        "HICP_2Y1Y":   ("ESTR_2Y1Y",   0.84, 0.17, 0.11, None, 0.0180),
        "HICP_2Y2Y":   ("ESTR_2Y2Y",   0.83, 0.16, 0.11, None, 0.0185),
        "HICP_2Y3Y":   ("ESTR_2Y3Y",   0.82, 0.16, 0.10, None, 0.0185),
        "HICP_5Y5Y":   ("ESTR_5Y5Y",   0.82, 0.15, 0.10, None, 0.0190),
        "HICP_10Y10Y": ("ESTR_10Y10Y", 0.81, 0.14, 0.09, -0.0015, 0.0200),
        "HICP_20Y10Y": ("ESTR_20Y10Y", 0.80, 0.13, 0.09, -0.0015, 0.0200),
    }
    for key, (estr_key, b1, b2, b3, b4_vol, idio_std) in hicp_fwd_params.items():
        idio = np.zeros(T)
        for t in range(1, T):
            idio[t] = 0.960 * idio[t - 1] + _RNG.normal(0, idio_std)
        series = (
            b1 * out[estr_key]
            + b2 * out["log_Brent"] * 0.10
            + b3 * out["log_Gas"] * 0.05
            + idio
        )
        if b4_vol is not None:
            series += b4_vol * (out["SMOVEU1M"] - 70.0) * 0.001
        out[key] = np.clip(series + 0.008, 0.002, 0.065)

    # Verify no NaN
    for k, v in out.items():
        assert not np.any(np.isnan(v)), f"NaN found in {k}"

    return out


# ─── Rolling Elastic Net ──────────────────────────────────────────────────────

def _rolling_elastic_net(X: np.ndarray, y: np.ndarray, feature_names: list[str]) -> dict:
    """Fit rolling ElasticNet and return chart-ready dict."""

    en = ElasticNet(alpha=0.01, l1_ratio=0.5, max_iter=2000, tol=1e-4, warm_start=True)
    scaler = StandardScaler()

    n = len(y)
    fitted_full = np.full(n, np.nan)
    residuals_full = np.full(n, np.nan)
    r2_full = np.full(n, np.nan)
    coef_full = np.full((n, len(feature_names)), np.nan)

    fit_indices = list(range(MIN_WINDOW, n, OUTPUT_STEP))
    if fit_indices and fit_indices[-1] != n - 1:
        fit_indices.append(n - 1)

    for t in fit_indices:
        start = max(0, t - ROLL_WINDOW + 1)
        Xw = X[start : t + 1]
        yw = y[start : t + 1]

        Xw_sc = scaler.fit_transform(Xw)
        en.fit(Xw_sc, yw)

        # Predict on last point
        x_last = scaler.transform(X[t : t + 1])
        fitted_full[t] = float(en.predict(x_last)[0])
        residuals_full[t] = y[t] - fitted_full[t]
        coef_full[t] = en.coef_

        # In-sample R²
        y_pred_w = en.predict(Xw_sc)
        ss_res = np.sum((yw - y_pred_w) ** 2)
        ss_tot = np.sum((yw - yw.mean()) ** 2)
        r2_full[t] = 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0

    # Forward-fill between steps using pandas
    idx = pd.RangeIndex(n)
    fitted_s = pd.Series(fitted_full, index=idx).ffill().bfill()
    resid_s = pd.Series(residuals_full, index=idx).ffill().bfill()
    r2_s = pd.Series(r2_full, index=idx).ffill().bfill()

    coef_df = pd.DataFrame(coef_full, columns=feature_names)
    coef_df = coef_df.ffill().bfill()

    # Rolling sigma bands — centre on rolling mean, bfill then ffill to avoid NaN
    resid_roll_mean = resid_s.rolling(252, min_periods=60).mean().bfill().ffill()
    resid_roll_std  = resid_s.rolling(252, min_periods=60).std().bfill().ffill()
    sigma1_hi = (resid_roll_mean + 1.0 * resid_roll_std)
    sigma1_lo = (resid_roll_mean - 1.0 * resid_roll_std)
    sigma2_hi = (resid_roll_mean + 2.0 * resid_roll_std)
    sigma2_lo = (resid_roll_mean - 2.0 * resid_roll_std)

    # Subsample for output
    step_idx = list(range(MIN_WINDOW, n, OUTPUT_STEP))
    if step_idx and step_idx[-1] != n - 1:
        step_idx.append(n - 1)

    dates_out = [DATES[i].strftime("%Y-%m-%d") for i in step_idx]
    actual_out = [round(float(y[i]), 4) for i in step_idx]
    fitted_out = [round(float(fitted_s.iloc[i]), 4) for i in step_idx]
    resid_out = [round(float(resid_s.iloc[i]), 4) for i in step_idx]
    s1hi = [round(float(sigma1_hi.iloc[i]), 4) for i in step_idx]
    s1lo = [round(float(sigma1_lo.iloc[i]), 4) for i in step_idx]
    s2hi = [round(float(sigma2_hi.iloc[i]), 4) for i in step_idx]
    s2lo = [round(float(sigma2_lo.iloc[i]), 4) for i in step_idx]
    r2_out = [round(float(r2_s.iloc[i]), 4) for i in step_idx]

    coef_series: dict[str, list[float]] = {}
    for name in feature_names:
        coef_series[name] = [round(float(coef_df[name].iloc[i]), 4) for i in step_idx]

    last_valid_mask = ~np.isnan(coef_full[:, 0])
    last_valid = int(np.where(last_valid_mask)[0][-1]) if last_valid_mask.any() else -1
    latest_coefs: dict[str, float] = {}
    if last_valid >= 0:
        for j, name in enumerate(feature_names):
            latest_coefs[name] = round(float(coef_full[last_valid, j]), 4)
    else:
        latest_coefs = {name: 0.0 for name in feature_names}

    # Scatter: residual vs forward returns
    SCATTER_STEP = max(1, n // 400)
    scatter_idx = list(range(MIN_WINDOW, n, SCATTER_STEP))
    sc_resid, sc_fwd20, sc_fwd200, sc_fwd400 = [], [], [], []
    for i in scatter_idx:
        r = resid_s.iloc[i]
        if np.isnan(r):
            continue
        for fwd_list, horizon in [(sc_fwd20, 20), (sc_fwd200, 200), (sc_fwd400, 400)]:
            if i + horizon < n:
                fwd_ret = round(float(y[i + horizon] - y[i]), 4)
                fwd_list.append(fwd_ret)
            else:
                fwd_list.append(None)  # type: ignore[arg-type]

        sc_resid.append(round(float(r), 4))

    # OLS trend lines for scatter
    def _ols_line(xs: list, ys: list, n_pts: int = 30) -> dict[str, list[float]]:
        pairs = [(x, y_) for x, y_ in zip(xs, ys) if y_ is not None]
        if len(pairs) < 5:
            return {"x": [], "y": []}
        xv = np.array([p[0] for p in pairs])
        yv = np.array([p[1] for p in pairs])
        coef = np.polyfit(xv, yv, 1)
        x_min, x_max = float(xv.min()), float(xv.max())
        x_line = np.linspace(x_min, x_max, n_pts)
        y_line = np.polyval(coef, x_line)
        return {"x": [round(float(v), 4) for v in x_line],
                "y": [round(float(v), 4) for v in y_line]}

    scatter_trend = {
        "20d":  _ols_line(sc_resid, sc_fwd20),
        "200d": _ols_line(sc_resid, sc_fwd200),
        "400d": _ols_line(sc_resid, sc_fwd400),
    }

    return {
        "dates":        dates_out,
        "actual":       actual_out,
        "fitted":       fitted_out,
        "residuals":    resid_out,
        "sigma1_hi":    s1hi,
        "sigma1_lo":    s1lo,
        "sigma2_hi":    s2hi,
        "sigma2_lo":    s2lo,
        "rolling_r2":   r2_out,
        "coef_names":   feature_names,
        "coef_series":  coef_series,
        "latest_coefs": latest_coefs,
        "scatter": {
            "residuals": sc_resid,
            "fwd20d":  [v if v is not None else None for v in sc_fwd20],
            "fwd200d": [v if v is not None else None for v in sc_fwd200],
            "fwd400d": [v if v is not None else None for v in sc_fwd400],
        },
        "scatter_trend": scatter_trend,
    }


# ─── Pre-compute ──────────────────────────────────────────────────────────────

_VARS = _simulate()

_RESULTS: dict[str, dict] = {}
for _m in _MODEL_DEFS:
    _X = np.column_stack([_VARS[k] for k in _m["x_keys"]])
    _y = _VARS[_m["y_key"]]
    _RESULTS[_m["id"]] = {
        "title": _m["title"],
        "group": _m["group"],
        **_rolling_elastic_net(_X, _y, _m["x_names"]),
    }


def get_fair_value_models_data() -> dict:
    return {
        "groups":    _GROUPS,
        "model_ids": [m["id"] for m in _MODEL_DEFS],
        "models":    _RESULTS,
    }
