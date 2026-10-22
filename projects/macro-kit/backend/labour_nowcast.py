"""
UK Labour Market Nowcast (Quant Macro section).

Tracks Bank of England staff's indicator-based measure of underlying employment
growth, as described in the Monetary Policy Report since May 2025: a dynamic factor
model following Doz, Giannone and Reichlin (2011) on monthly employment indicators,
whose common component is scaled to LFS employment growth (three months on three
months) over 2000-19.

  Factor model     two-step DGR: principal components (EM for the ragged panel), an
                   AR(2) for the factor, then the Kalman filter and smoother once
  Scaling          LFS 3m/3m growth regressed on the factor's three-month average
  Contributions    the smoother is linear in the data, so each indicator's part of the
                   estimate is exact and they add up; news = change in contributions
  Next prints      LFS employment growth and unemployment rate, HMRC payrolls flash
  Bank's charts    employment implied by GDP momentum (six lags), demand/supply SVAR
                   (sign restrictions, Nov 2000 - Dec 2019), unemployment projections
                   against the Bank's own, staff judgements from each MPR

State lives under var/labour_nowcast/ (downloads, saved parameters, payload, run
history). Parameters are re-estimated only by the Refit button (or when none fit the
data); new data go through the saved parameters in a background update.
"""
from __future__ import annotations

import dataclasses
import json
import logging
import math
import threading
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

import labour_data as ld
from runtime_paths import state_path
from settings import settings

logger = logging.getLogger(__name__)

COUNTRIES = {
    "uk": {
        "title": "UK Labour Market Nowcast", "country": "GB", "loader": "uk",
        "catalogue": "series_catalogue_labour_uk.json", "staff": "boe_labour_staff_uk.json",
        # LFS series are three-month averages: the quarter's value is its last month
        "target": "lfs_employment", "employment": "lfs_employment", "active": "lfs_active",
        "unemployment": "lfs_unemployment_rate", "real_wage": "real_awe", "flash": "payrolls",
        "next_print": "growth3", "quarter_average": False, "gdp": "uk",
        "labels": {"target": "LFS employment", "target_short": "LFS", "unemployment": "LFS unemployment rate",
                   "institution": "Bank of England", "staff": "Bank staff", "report": "MPR",
                   "method": "Bank of England staff method", "flash": "HMRC payrolls"},
    },
    "us": {
        "title": "US Labour Market Nowcast", "country": "US", "loader": "us",
        "catalogue": "series_catalogue_labour_us.json", "staff": "fed_labour_staff_us.json",
        # Payrolls are monthly levels; the unemployment rate is compared as a quarterly average (SEP)
        "target": "payrolls", "employment": "household_employment", "active": "labour_force",
        "unemployment": "unemployment_rate", "real_wage": "real_ahe", "flash": None,
        "next_print": "change", "quarter_average": True, "gdp": "us",
        "labels": {"target": "Nonfarm payrolls", "target_short": "Payrolls", "unemployment": "Unemployment rate",
                   "institution": "Federal Reserve", "staff": "FOMC", "report": "FOMC statement",
                   "method": "Bank of England-style factor model on US labour indicators", "flash": None},
    },
}
ROOT: Path | None = None             # tests point this at a temporary directory
INPUTS = None                        # tests: slug -> ld.LabourData (no downloads)
QUARTERLY = None                     # tests: slug -> quarterly GDP growth (% q/q)
HISTORY_KEPT = 400
Z95 = 1.959964


def _now() -> str:
    return pd.Timestamp.now().isoformat(timespec="seconds")


def _r(x, d: int = 3):
    if x is None:
        return None
    x = float(x)
    return round(x, d) if math.isfinite(x) else None


def _root() -> Path:
    root = ROOT if ROOT is not None else state_path("labour_nowcast")
    root.mkdir(parents=True, exist_ok=True)
    return root


def _read(path: Path) -> dict | list | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except Exception:
        logger.warning("Labour nowcast: unreadable %s", path, exc_info=True)
        return None


def _write(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)


# ---------------------------------------------------------------------------
# Dynamic factor model (Doz, Giannone and Reichlin, 2011)
# ---------------------------------------------------------------------------

@dataclass
class Params:
    ids: list[str]                 # indicators in the model, in order
    mean: np.ndarray               # standardisation over the estimation sample
    sd: np.ndarray
    lam: np.ndarray                # loadings on the (unit-variance) factor
    phi: np.ndarray                # AR(2) coefficients of the factor
    q: float                       # factor innovation variance
    r: np.ndarray                  # idiosyncratic variances (standardised units)
    a: float = 0.0                 # LFS growth = a + b · three-month average of the factor
    b: float = 1.0
    r2: float = float("nan")
    resid_sd: float = float("nan")
    fitted_at: str = ""
    data_through: str = ""

    def to_json(self) -> dict:
        return {k: (v.tolist() if isinstance(v, np.ndarray) else v) for k, v in dataclasses.asdict(self).items()}

    @classmethod
    def from_json(cls, d: dict) -> "Params":
        arr = {"mean", "sd", "lam", "phi", "r"}
        return cls(**{k: (np.asarray(v, dtype=float) if k in arr else v) for k, v in d.items()})


def em_pca(Z: np.ndarray, iters: int = 500, tol: float = 1e-8) -> tuple[np.ndarray, np.ndarray]:
    """First principal component of a panel with missing values (Stock and Watson EM)."""
    miss = np.isnan(Z)
    Zf = np.where(miss, 0.0, Z)
    prev = np.inf
    for _ in range(iters):
        u, s, vt = np.linalg.svd(Zf, full_matrices=False)
        f, lam = u[:, 0] * s[0], vt[0]
        fit = np.outer(f, lam)
        Zf = np.where(miss, fit, Z)
        ssr = float(((Z - fit)[~miss] ** 2).sum())
        if abs(prev - ssr) < tol * max(ssr, 1.0):
            break
        prev = ssr
    scale = f.std()
    return f / scale, lam * scale


def _ar2(f: np.ndarray, ok: np.ndarray) -> tuple[np.ndarray, float]:
    """OLS AR(2) on the months where f and its two lags are all in the sample."""
    rows = [t for t in range(2, len(f)) if ok[t] and ok[t - 1] and ok[t - 2]]
    X = np.column_stack([f[[t - 1 for t in rows]], f[[t - 2 for t in rows]]])
    y = f[rows]
    phi, *_ = np.linalg.lstsq(X, y, rcond=None)
    # keep the AR stationary (roots outside the unit circle)
    if np.abs(np.roots([1, -phi[0], -phi[1]])).max() >= 0.995:
        phi = phi * 0.99 / np.abs(np.roots([1, -phi[0], -phi[1]])).max()
    resid = y - X @ phi
    return phi, float(resid.var())


def _transition(phi: np.ndarray) -> np.ndarray:
    return np.array([[phi[0], phi[1], 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])


@dataclass
class Smoothed:
    mean: np.ndarray                    # (T, 3): f_t, f_{t-1}, f_{t-2}
    cov: np.ndarray                     # (T, 3, 3)
    gains: list = field(default_factory=list)     # per t: (observed columns, K_t)
    J: list = field(default_factory=list)         # smoother gains

    @property
    def fbar(self) -> np.ndarray:
        return self.mean.mean(axis=1)

    @property
    def fbar_var(self) -> np.ndarray:
        return self.cov.sum(axis=(1, 2)) / 9.0


def kalman_smooth(X: np.ndarray, p: Params) -> Smoothed:
    """Kalman filter and RTS smoother with state [f_t, f_{t-1}, f_{t-2}] (NaN = missing)."""
    T, _ = X.shape
    A = _transition(p.phi)
    Qm = np.zeros((3, 3))
    Qm[0, 0] = p.q
    # stationary covariance as the initial condition
    P = np.eye(3) * p.q
    for _ in range(500):
        P = A @ P @ A.T + Qm
    s = np.zeros(3)
    a_pred = np.zeros((T, 3))
    P_pred = np.zeros((T, 3, 3))
    s_f = np.zeros((T, 3))
    P_f = np.zeros((T, 3, 3))
    gains = []
    for t in range(T):
        if t > 0:
            s = A @ s
            P = A @ P @ A.T + Qm
        a_pred[t], P_pred[t] = s, P
        obs = np.where(~np.isnan(X[t]))[0]
        if len(obs):
            H = np.zeros((len(obs), 3))
            H[:, 0] = p.lam[obs]
            F = H @ P @ H.T + np.diag(p.r[obs])
            K = P @ H.T @ np.linalg.inv(F)
            s = s + K @ (X[t, obs] - H @ s)
            P = P - K @ H @ P
            gains.append((obs, K, H))
        else:
            gains.append((obs, None, None))
        s_f[t], P_f[t] = s, P
    mean = s_f.copy()
    cov = P_f.copy()
    Js = [None] * T
    for t in range(T - 2, -1, -1):
        J = P_f[t] @ A.T @ np.linalg.pinv(P_pred[t + 1])
        mean[t] = s_f[t] + J @ (mean[t + 1] - a_pred[t + 1])
        cov[t] = P_f[t] + J @ (cov[t + 1] - P_pred[t + 1]) @ J.T
        Js[t] = J
    return Smoothed(mean, cov, gains, Js)


def smooth_linear(X: np.ndarray, sm: Smoothed, p: Params) -> np.ndarray:
    """The smoothed state for other data with the same missing pattern, reusing the gains.

    The smoother is linear in the data (zero initial mean), so running it on one
    indicator at a time (others set to zero) splits the estimate exactly."""
    T = X.shape[0]
    A = _transition(p.phi)
    s = np.zeros(3)
    a_pred = np.zeros((T, 3))
    s_f = np.zeros((T, 3))
    for t in range(T):
        if t > 0:
            s = A @ s
        a_pred[t] = s
        obs, K, H = sm.gains[t]
        if K is not None:
            s = s + K @ (X[t, obs] - H @ s)
        s_f[t] = s
    mean = s_f.copy()
    for t in range(T - 2, -1, -1):
        mean[t] = s_f[t] + sm.J[t] @ (mean[t + 1] - a_pred[t + 1])
    return mean


def _excluded(index: pd.PeriodIndex, windows) -> np.ndarray:
    out = np.zeros(len(index), dtype=bool)
    for a, b in windows:
        out |= (index >= pd.Period(a, "M")) & (index <= pd.Period(b, "M"))
    return out


def panel(data: ld.LabourData, cat: dict, horizon_to: pd.Period) -> tuple[pd.DataFrame, list[dict]]:
    """Transformed factor indicators on a monthly grid running to ``horizon_to``."""
    series = [s for s in cat["series"] if s.get("factor") and s["id"] in data.monthly and data.monthly[s["id"]].notna().sum() >= 24]
    idx = pd.period_range(cat["_meta"]["start"], max(horizon_to, data.monthly.index.max()), freq="M")
    X = pd.DataFrame({s["id"]: ld.transform(data.monthly[s["id"]], s["transform"]) for s in series}).reindex(idx)
    return X, series


def estimate(X: pd.DataFrame, lfs: pd.Series, cat: dict, data_through: str) -> Params:
    """Step 1 of DGR: standardise, principal component (EM), AR(2), variances; then the scaling."""
    excl = _excluded(X.index, cat["_meta"]["exclude"])
    data_rows = X.notna().any(axis=1).to_numpy()
    est = data_rows & ~excl
    mean = X[est].mean().to_numpy()
    sd = X[est].std().to_numpy()
    Z = ((X.to_numpy() - mean) / sd)[est]
    f_est, lam = em_pca(Z)
    f = np.full(len(X), np.nan)
    f[est] = f_est
    phi, q = _ar2(np.nan_to_num(f), est)
    resid = Z - np.outer(f_est, lam)
    r = np.clip(np.nanvar(resid, axis=0), 0.05, None)
    p = Params(list(X.columns), mean, sd, lam, phi, q, r, fitted_at=_now(), data_through=data_through)
    # sign: the factor rises with employment growth
    sm = kalman_smooth(standardise(X, p), p)
    lo, hi = cat["_meta"]["scale_window"]
    w = (X.index >= pd.Period(lo, "M")) & (X.index <= pd.Period(hi, "M"))
    y = lfs.reindex(X.index).to_numpy()
    ok = w & ~np.isnan(y)
    if np.corrcoef(sm.fbar[ok], y[ok])[0, 1] < 0:
        p.lam = -p.lam
        sm = kalman_smooth(standardise(X, p), p)
    scale(p, sm.fbar, y, ok)
    return p


def scale(p: Params, fbar: np.ndarray, y: np.ndarray, ok: np.ndarray) -> None:
    """LFS growth = a + b · fbar over the scaling window (in place)."""
    Xr = np.column_stack([np.ones(ok.sum()), fbar[ok]])
    (a, b), *_ = np.linalg.lstsq(Xr, y[ok], rcond=None)
    res = y[ok] - Xr @ np.array([a, b])
    p.a, p.b = float(a), float(b)
    p.r2 = float(1 - res.var() / y[ok].var())
    p.resid_sd = float(res.std(ddof=2))


def standardise(X: pd.DataFrame, p: Params) -> np.ndarray:
    Z = X.reindex(columns=p.ids).to_numpy()
    return (Z - p.mean) / p.sd


# ---------------------------------------------------------------------------
# Bank of England companion analyses
# ---------------------------------------------------------------------------

def gdp_implied(under_q: pd.Series, gdp_q: pd.Series, window=("2000Q1", "2019Q4"), lags: int = 6,
                exclude=("2020Q1", "2021Q2")) -> tuple[pd.Series, dict]:
    """Underlying employment (quarterly) regressed on six lags of GDP growth (q/q, %).

    Quarters whose lags reach into the pandemic are left out of the implied path."""
    g = gdp_q.copy()
    X = pd.concat({f"l{k}": g.shift(k) for k in range(1, lags + 1)}, axis=1)
    idx = X.index.union(under_q.index)
    last = g.dropna().index.max()
    X = X.reindex(idx.union(pd.PeriodIndex([last + 1], freq="Q")))
    X.loc[last + 1] = [g.get(last + 1 - k, np.nan) for k in range(1, lags + 1)]     # one quarter past the GDP data
    X = X.sort_index()
    y = under_q.reindex(X.index)
    w = (X.index >= pd.Period(window[0], "Q")) & (X.index <= pd.Period(window[1], "Q"))
    ok = w & X.notna().all(axis=1).to_numpy() & y.notna().to_numpy()
    A = np.column_stack([np.ones(ok.sum()), X[ok].to_numpy()])
    beta, *_ = np.linalg.lstsq(A, y[ok].to_numpy(), rcond=None)
    fit_rows = X.notna().all(axis=1)
    implied = pd.Series(np.column_stack([np.ones(fit_rows.sum()), X[fit_rows].to_numpy()]) @ beta, index=X.index[fit_rows])
    lo, hi = pd.Period(exclude[0], "Q"), pd.Period(exclude[1], "Q")
    implied = implied[[not any(lo <= q - k <= hi for k in range(1, lags + 1)) for q in implied.index]]
    res = y[ok].to_numpy() - A @ beta
    return implied, {"r2": float(1 - res.var() / y[ok].var()), "lags": lags, "sample": f"{window[0]} to {window[1]}"}


def _var_ols(Y: np.ndarray, p: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    T = len(Y)
    X = np.column_stack([np.ones(T - p)] + [Y[p - k:T - k] for k in range(1, p + 1)])
    B, *_ = np.linalg.lstsq(X, Y[p:], rcond=None)
    U = Y[p:] - X @ B
    return B, U, np.cov(U.T)


def svar_decomposition(y: pd.DataFrame, est=("2000-11", "2019-12"), decomp_from: str = "2022-01", max_p: int = 6) -> dict:
    """Bivariate SVAR on [underlying employment growth, real AWE growth] (3m/3m, monthly)
    identified by sign restrictions on impact: demand moves both the same way, supply in
    opposite directions. The rotation closest to the median of the accepted impacts
    (Fry and Pagan, 2011) gives the historical decomposition, which adds up exactly."""
    y = y.dropna()
    Ye = y.loc[est[0]:est[1]].to_numpy()
    aic = []
    for p in range(1, max_p + 1):
        _, U, S = _var_ols(Ye[max_p - p:], p)
        aic.append(np.log(np.linalg.det(S)) + 2 * p * 4 / len(U))
    p = int(np.argmin(aic)) + 1
    B, _, S = _var_ols(Ye, p)
    C = np.linalg.cholesky(S)
    accepted = []
    for th in np.linspace(0, np.pi, 2001)[:-1]:
        Q = np.array([[np.cos(th), -np.sin(th)], [np.sin(th), np.cos(th)]])
        imp = C @ Q
        imp = imp * np.sign(imp[0])[None, :]                     # employment response positive
        same = (imp[1] > 0)
        if same.sum() == 1:
            d, s = int(np.argmax(same)), int(np.argmin(same))
            accepted.append(np.column_stack([imp[:, d], imp[:, s]]))
    if not accepted:
        return {"ok": False}
    stack = np.stack(accepted)
    med = np.median(stack, axis=0)
    sdv = stack.std(axis=0) + 1e-12
    best = stack[np.argmin((((stack - med) / sdv) ** 2).sum(axis=(1, 2)))]
    # Reduced-form residuals over the full sample with the estimated coefficients
    Yall = y.to_numpy()
    T = len(Yall)
    X = np.column_stack([np.ones(T - p)] + [Yall[p - k:T - k] for k in range(1, p + 1)])
    U = Yall[p:] - X @ B
    idx = y.index[p:]
    E = np.linalg.solve(best, U.T).T                            # structural shocks: demand, supply
    start = idx.get_loc(pd.Period(decomp_from, "M")) if pd.Period(decomp_from, "M") in idx else max(len(idx) - 48, 0)
    A = [B[1 + 2 * k:3 + 2 * k].T for k in range(p)]           # lag matrices (2x2)
    n = len(idx) - start
    Psi = [np.eye(2)]
    for h in range(1, n):
        Psi.append(sum(A[k] @ Psi[h - 1 - k] for k in range(min(p, h))))
    contrib = np.zeros((n, 2, 2))                               # time, variable, shock
    for t in range(n):
        for s_ in range(t + 1):
            contrib[t] += Psi[t - s_] @ best * E[start + s_][None, :]
    actual = Yall[p + start:, :]
    baseline = actual - contrib.sum(axis=2)
    rows = [{"month": str(idx[start + t]), "employment": float(actual[t, 0]), "baseline": float(baseline[t, 0]),
             "demand": float(contrib[t, 0, 0]), "supply": float(contrib[t, 0, 1])} for t in range(n)]
    return {"ok": True, "lags": p, "accepted": len(accepted), "rows": rows,
            "impact": {"demand": best[:, 0].tolist(), "supply": best[:, 1].tolist()}, "sample": f"{est[0]} to {est[1]}"}


# ---------------------------------------------------------------------------
# Payload
# ---------------------------------------------------------------------------

def _quarter_end(m: pd.Period) -> bool:
    return m.month % 3 == 0


def build(slug: str, data: ld.LabourData, gdp_q: pd.Series | None, params: Params | None, refit: bool,
          progress=lambda s: None) -> tuple[dict, Params]:
    cfg = COUNTRIES[slug]
    cat = ld.catalogue(cfg["catalogue"])
    staff = ld.staff_judgements(cfg["staff"])
    mo = data.monthly
    lfs = ld.transform(mo[cfg["target"]], "growth3")          # the target's 3m/3m growth (%)
    last_lfs = lfs.dropna().index.max()
    # horizon: the next LFS print and the two quarters after the latest LFS quarter
    q_ends = [m for m in pd.period_range(last_lfs + 1, last_lfs + 6, freq="M") if _quarter_end(m)][:2]
    horizon = max([last_lfs + 1] + q_ends)
    X, series = panel(data, cat, horizon)
    data_through = str(X.dropna(how="all").index.max())
    if params is None or refit or params.ids != list(X.columns):
        progress("Estimating the factor model")
        params = estimate(X, lfs, cat, data_through)
    progress("Kalman smoother")
    Z = standardise(X, params)
    excl = _excluded(X.index, cat["_meta"]["exclude"])
    Z[excl] = np.nan                                          # the pandemic months carry no information
    sm = kalman_smooth(Z, params)
    fbar, fvar = sm.fbar, sm.fbar_var
    under = params.a + params.b * fbar
    under_sd = abs(params.b) * np.sqrt(fvar)
    last_data = X.dropna(how="all").index.max()
    idx = X.index

    progress("Contributions")
    contrib = {}
    for j, sid in enumerate(params.ids):
        Zi = np.where(np.isnan(Z), np.nan, 0.0)
        Zi[:, j] = Z[:, j]
        contrib[sid] = params.b * smooth_linear(Zi, sm, params).mean(axis=1)

    progress("Next prints and projections")
    pos = {m: k for k, m in enumerate(idx)}
    k_next = pos[last_lfs + 1]
    recent = (lfs - pd.Series(under, index=idx)).dropna().loc[str(last_lfs - 23):]
    noise = max(params.resid_sd, float(recent.std()) if len(recent) > 6 else 0.0)
    release = next((s_.next_release for s_ in data.sources.values() if s_.next_release), None)
    if release is None and cfg["next_print"] == "change":
        # BLS Employment Situation: usually the first Friday of the month after the reference month
        first = (last_lfs + 2).start_time
        release = (first + pd.Timedelta(days=(4 - first.dayofweek) % 7)).strftime("%d %B %Y") + " (typical)"
    if cfg["next_print"] == "change":
        # monthly change (thousands): the underlying 3m/3m rate spread over three months, plus
        # the month-to-month noise of the published change around it
        lvl = mo[cfg["target"]]
        implied = lvl.shift(1) * pd.Series(under, index=idx).reindex(lvl.index) / 300
        chg = lvl.diff()
        resid = (chg - implied).dropna()
        resid = resid[~_excluded(resid.index, cat["_meta"]["exclude"])]
        lo_w, hi_w = cat["_meta"]["scale_window"]
        sd_hist = float(resid.loc[lo_w:hi_w].std()) if len(resid.loc[lo_w:hi_w]) > 12 else float(resid.std())
        sd_recent = float(resid.iloc[-24:].std()) if len(resid) > 30 else sd_hist
        noise_c = max(sd_hist, sd_recent)
        base = float(lvl[last_lfs])
        mean_c = base * under[k_next] / 300
        sd_c = math.hypot(base * under_sd[k_next] / 300, noise_c)
        lfs_next = {
            "kind": "change", "units": "000s", "period": str(last_lfs + 1), "release": release,
            "forecast": _r(mean_c, 1), "sd": _r(sd_c, 1), "lo": _r(mean_c - Z95 * sd_c, 1), "hi": _r(mean_c + Z95 * sd_c, 1),
            "latest_period": str(last_lfs), "latest": _r(chg.get(last_lfs), 1), "noise_sd": _r(noise_c, 1),
            "noise_sd_2000_19": _r(sd_hist, 1), "underlying": _r(under[k_next]),
        }
    else:
        lfs_next = {
            "kind": "growth3", "units": "% 3m/3m", "period": str(last_lfs + 1), "release": release,
            "forecast": _r(under[k_next]), "sd": _r(math.hypot(under_sd[k_next], noise)),
            "lo": _r(under[k_next] - Z95 * math.hypot(under_sd[k_next], noise)), "hi": _r(under[k_next] + Z95 * math.hypot(under_sd[k_next], noise)),
            "latest_period": str(last_lfs), "latest": _r(lfs[last_lfs]), "noise_sd": _r(noise), "noise_sd_2000_19": _r(params.resid_sd),
            "underlying": _r(under[k_next]),
        }

    # Unemployment rate: the latest LFS levels (three-month averages) rolled forward a month
    # at a time, employment by underlying growth and the labour force by its trend over the
    # past year (a 3m/3m rate spread evenly over its three months)
    emp, act = mo[cfg["employment"]], mo[cfg["active"]]
    last_emp = min(emp.dropna().index.max(), act.dropna().index.max())
    g_lf = float(ld.transform(act, "growth3").dropna().iloc[-12:].mean())

    def level(series: pd.Series, m: pd.Period, growth) -> float:
        if m <= last_emp:
            return float(series[m])
        return level(series, m - 1, growth) * (1 + growth(m) / 300)

    u_obs = mo[cfg["unemployment"]]

    def rate(m: pd.Period, shift: float) -> float:
        if m <= last_emp and pd.notna(u_obs.get(m, np.nan)):
            return float(u_obs[m])
        e = level(emp, m, lambda mm: under[pos[mm]] + shift * under_sd[pos[mm]])
        return 100 * (1 - e / level(act, m, lambda mm: g_lf))

    unemp = []
    for m in q_ends:
        k = pos[m]
        months = [m - 2, m - 1, m] if cfg["quarter_average"] else [m]
        u = {name: float(np.mean([rate(mm, shift) for mm in months]))
             for name, shift in (("mid", 0.0), ("lo", -Z95), ("hi", Z95))}
        boe = [{"report": r["report"], "value": x["value"]} for r in staff["reports"] for x in r["unemployment"] if x["period"] == f"{m.year}Q{m.quarter}"]
        unemp.append({"period": f"{m.year}Q{m.quarter}", "month": str(m), "projection": _r(u["mid"], 2), "lo": _r(u["hi"], 2), "hi": _r(u["lo"], 2),
                      "employment_growth": _r(under[k]), "boe": boe[-1] if boe else None})
    unemp_latest = {"period": str(u_obs.dropna().index.max()), "value": _r(u_obs.dropna().iloc[-1], 2)}

    # A separate timelier payroll measure (UK: HMRC flash) from the factor (3m/3m growth regression)
    pay = mo[cfg["flash"]].dropna() if cfg["flash"] and cfg["flash"] in mo else pd.Series(dtype=float)
    payroll_next = None
    if len(pay) > 36:
        g3 = ld.transform(pay, "growth3")
        y = g3.reindex(idx).to_numpy()
        win = ((idx >= pd.Period("2015-01", "M")) & (idx <= pd.Period("2019-12", "M"))) | (idx >= pd.Period("2022-01", "M"))
        ok = win & ~np.isnan(y) & (np.arange(len(idx)) < pos[pay.index.max()])          # leave out the flash month
        A = np.column_stack([np.ones(ok.sum()), fbar[ok]])
        beta, *_ = np.linalg.lstsq(A, y[ok], rcond=None)
        res_sd = float((y[ok] - A @ beta).std(ddof=2))
        nm = pay.index.max() + 1
        if nm in pos:
            g = beta[0] + beta[1] * fbar[pos[nm]]
            lvl = pay[nm - 3] * (1 + g / 100)
            sd_lvl = pay[nm - 3] * res_sd / 100
            payroll_next = {"period": str(nm), "change_k": _r((lvl - pay.iloc[-1]) / 1000, 1),
                            "lo_k": _r((lvl - Z95 * sd_lvl - pay.iloc[-1]) / 1000, 1), "hi_k": _r((lvl + Z95 * sd_lvl - pay.iloc[-1]) / 1000, 1),
                            "growth3": _r(g), "latest_period": str(pay.index.max()),
                            "latest_change_k": _r((pay.iloc[-1] - pay.iloc[-2]) / 1000, 1), "latest_growth3": _r(g3.iloc[-1])}

    progress("Bank of England companion charts")
    under_s = pd.Series(under, index=idx)
    q_under = under_s[[m for m in idx if _quarter_end(m) and m <= last_data]]
    q_under.index = pd.PeriodIndex([pd.Period(f"{m.year}Q{m.quarter}") for m in q_under.index], freq="Q")
    gdp_block = None
    if gdp_q is not None and len(gdp_q.dropna()) > 30:
        implied, ginfo = gdp_implied(q_under, gdp_q)
        gdp_block = {**ginfo, "rows": [{"quarter": str(q), "implied": _r(v), "underlying": _r(q_under.get(q))}
                                       for q, v in implied.items() if q >= pd.Period("2015Q1")],
                     "latest_gdp_quarter": str(gdp_q.dropna().index.max())}
    awe = ld.transform(mo[cfg["real_wage"]], "growth3") if cfg["real_wage"] in mo else None
    svar = None
    if awe is not None:
        yy = pd.DataFrame({"employment": under_s[under_s.index <= last_data], "real_awe": awe.reindex(idx)})
        yy = yy[~_excluded(yy.index, cat["_meta"]["exclude"]) | (yy.index < pd.Period("2020-01", "M"))]
        yy = yy.loc[:"2019-12"].combine_first(yy.loc["2021-07":]) if len(yy.loc["2021-07":]) else yy
        try:
            svar = svar_decomposition(yy)
        except Exception:
            logger.warning("Labour nowcast: SVAR failed", exc_info=True)
            svar = None

    progress("Assembling")
    rows = []
    start = pd.Period("2005-01", "M")
    for k, m in enumerate(idx):
        if m < start:
            continue
        kind = "pandemic" if excl[k] else ("estimate" if m <= last_data else "projection")
        rows.append({"month": str(m), "kind": kind, "underlying": _r(under[k]), "lo": _r(under[k] - Z95 * under_sd[k]),
                     "hi": _r(under[k] + Z95 * under_sd[k]), "lfs": _r(lfs.get(m)),
                     "payrolls": _r(ld.transform(pay, "growth3").get(m)) if len(pay) else None})
    c_rows = []
    for k, m in enumerate(idx):
        if m < last_data - 35 or m > last_data:
            continue
        c_rows.append({"month": str(m), "constant": _r(params.a, 4), "total": _r(under[k], 4),
                       "contributions": {sid: _r(contrib[sid][k], 4) for sid in params.ids}})
    k_last = pos[last_data]
    indicators = []
    for s in cat["series"]:
        sid = s["id"]
        raw = mo[sid].dropna() if sid in mo else pd.Series(dtype=float)
        tr = X[sid].dropna() if sid in X else pd.Series(dtype=float)
        j = params.ids.index(sid) if sid in params.ids else None
        indicators.append({
            "id": sid, "name": s["name"], "short": s["short"], "group": s["group"], "source": s["source"], "units": s["units"],
            "transform": s["transform"], "notes": s.get("notes", ""), "in_model": j is not None,
            "missing": data.missing.get(sid), "latest_month": str(raw.index.max()) if len(raw) else None,
            "latest": _r(raw.iloc[-1]) if len(raw) else None, "latest_transformed": _r(tr.iloc[-1]) if len(tr) else None,
            "z": _r((tr.iloc[-1] - params.mean[j]) / params.sd[j], 2) if j is not None and len(tr) else None,
            "loading": _r(params.lam[j]) if j is not None else None,
            "contribution": _r(contrib[sid][k_last]) if j is not None else None,
            "first_month": str(tr.index.min()) if len(tr) else None,
        })
    latest_staff = staff["reports"][-1] if staff["reports"] else None
    payload = {
        "slug": slug, "title": COUNTRIES[slug]["title"], "country": COUNTRIES[slug]["country"],
        "as_of": pd.Timestamp.today().strftime("%Y-%m-%d"), "computed_at": _now(),
        "data_source": data.source,
        "labels": cfg["labels"],
        "latest": {"month": str(last_data), "underlying": _r(under[k_last]), "lo": _r(under[k_last] - Z95 * under_sd[k_last]),
                   "hi": _r(under[k_last] + Z95 * under_sd[k_last]),
                   "previous_month": str(last_data - 1), "previous": _r(under[k_last - 1]),
                   "three_months_ago": _r(under[k_last - 3]),
                   "boe_report": latest_staff["report"] if latest_staff else None,
                   "boe_text": latest_staff["underlying_text"] if latest_staff else None,
                   "boe_value": latest_staff["underlying_value"] if latest_staff else None},
        "series": rows,
        "contributions": c_rows,
        "indicators": indicators,
        "next_prints": {"lfs_employment": lfs_next, "unemployment": unemp, "unemployment_latest": unemp_latest,
                        "labour_force_growth": _r(g_lf), "payrolls": payroll_next},
        "gdp_implied": gdp_block,
        "svar": svar if svar and svar.get("ok") else None,
        "staff": staff["reports"],
        "staff_method": staff["_meta"]["method"],
        "sources": {k: dataclasses.asdict(v) for k, v in data.sources.items()},
        "model": {
            "fitted_at": params.fitted_at, "data_through": params.data_through, "n_indicators": len(params.ids),
            "ids": params.ids, "phi": [_r(v) for v in params.phi], "q": _r(params.q), "a": _r(params.a), "b": _r(params.b),
            "r2": _r(params.r2), "resid_sd": _r(params.resid_sd), "scale_window": cat["_meta"]["scale_window"],
            "exclude": cat["_meta"]["exclude"], "missing": len([i for i in indicators if not i["in_model"]]),
        },
    }
    return payload, params


# ---------------------------------------------------------------------------
# News between runs
# ---------------------------------------------------------------------------

def news(prev: dict | None, payload: dict) -> dict | None:
    """What moved the estimate for the latest month both runs cover, by indicator."""
    if not prev or not prev.get("contributions"):
        return None
    pc = {r["month"]: r for r in prev["contributions"]}
    cur = {r["month"]: r for r in payload["contributions"]}
    common = sorted(set(pc) & set(cur))
    if not common:
        return None
    m = common[-1]
    same_model = prev.get("model", {}).get("fitted_at") == payload["model"]["fitted_at"]
    by = {sid: _r((cur[m]["contributions"].get(sid) or 0) - (pc[m]["contributions"].get(sid) or 0), 4)
          for sid in cur[m]["contributions"]}
    return {"month": m, "previous_computed_at": prev.get("computed_at"), "previous": pc[m]["total"], "current": cur[m]["total"],
            "change": _r((cur[m]["total"] or 0) - (pc[m]["total"] or 0), 4), "by_indicator": by, "same_model": same_model,
            "new_month": payload["latest"]["month"] if payload["latest"]["month"] != prev.get("latest", {}).get("month") else None}


# ---------------------------------------------------------------------------
# Jobs and API
# ---------------------------------------------------------------------------

@dataclass
class Job:
    kind: str
    state: str = "idle"
    step: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    error: str | None = None


_jobs: dict[tuple[str, str], Job] = {}
_lock = threading.Lock()
_compute_lock = threading.Lock()
_payloads: dict[str, dict] = {}


def _dir(slug: str) -> Path:
    d = _root() / slug
    d.mkdir(parents=True, exist_ok=True)
    return d


def _quarterly_gdp(slug: str) -> pd.Series | None:
    """Real GDP growth, % q/q: UK from the ONS, US from the US GDP nowcast's panel (q/q saar / 4)."""
    if QUARTERLY is not None:
        return QUARTERLY(slug)
    try:
        if COUNTRIES[slug]["gdp"] == "us":
            import quant_macro as qm

            spec = qm.MODELS["us-gdp"]
            g = qm.load_panel(spec, pd.Timestamp.today().normalize(), settings.data_source).values[spec.target].dropna()
            g = g[[m.month % 3 == 0 for m in g.index]] / 4
            g.index = pd.PeriodIndex([m.asfreq("Q") for m in g.index], freq="Q")
            return g
        import fiscal_data as fd

        q = fd.quarterly_history(_root() / "sources")
        return 100 * np.log(q["real_gdp"]).diff().dropna()
    except Exception:
        logger.warning("Labour nowcast: GDP history unavailable", exc_info=True)
        return None


def load_data(slug: str) -> ld.LabourData:
    if INPUTS is not None:
        return INPUTS(slug)
    if COUNTRIES[slug]["loader"] == "us":
        return ld.load_us(_root() / "sources" / slug, settings.data_source)
    return ld.load(_root() / "sources", settings.data_source)


def _update(slug: str, job: Job | None, refit: bool = False) -> dict:
    with _compute_lock:
        def progress(s: str) -> None:
            if job:
                job.step = s
        progress("Downloading data")
        data = load_data(slug)
        saved = _read(_dir(slug) / "model.json")
        params = Params.from_json(saved) if saved else None
        payload, params = build(slug, data, _quarterly_gdp(slug), params, refit, progress)
        _write(_dir(slug) / "model.json", params.to_json())
        prev = _payloads.get(slug) or _read(_dir(slug) / "payload.json")
        payload["news"] = news(prev, payload)
        _write(_dir(slug) / "payload.json", payload)
        hist = _read(_dir(slug) / "history.json") or []
        hist.append({"computed_at": payload["computed_at"], "month": payload["latest"]["month"],
                     "underlying": payload["latest"]["underlying"], "fitted_at": params.fitted_at})
        _write(_dir(slug) / "history.json", hist[-HISTORY_KEPT:])
        payload["runs"] = hist[-60:]
        _payloads[slug] = payload
        return payload


def _start(slug: str, kind: str, work) -> Job:
    with _lock:
        job = _jobs.get((slug, kind))
        if job and job.state == "running":
            return job
        job = _jobs[(slug, kind)] = Job(kind, state="running", started_at=_now(), step="Queued")

    def run() -> None:
        try:
            work(job)
            job.state = "done"
        except Exception as exc:
            logger.exception("Labour nowcast %s %s failed", slug, kind)
            job.state, job.error = "error", f"{type(exc).__name__}: {exc}"
        finally:
            job.finished_at = _now()

    threading.Thread(target=run, name=f"labour-{slug}-{kind}", daemon=True).start()
    return job


def _job(slug: str, kind: str) -> Job:
    with _lock:
        return _jobs.get((slug, kind)) or Job(kind)


def _stale(payload: dict) -> bool:
    return payload.get("as_of") != pd.Timestamp.today().strftime("%Y-%m-%d")


def get_labour(slug: str) -> dict:
    """Saved payload; refreshed in the background on a new day, computed here only on first use."""
    payload = _payloads.get(slug) or _read(_dir(slug) / "payload.json")
    if payload is None:
        with _compute_lock:
            payload = _payloads.get(slug)
        if payload is None:
            return _update(slug, None)
    if "runs" not in payload:
        payload["runs"] = (_read(_dir(slug) / "history.json") or [])[-60:]
    _payloads[slug] = payload
    if _stale(payload) and _job(slug, "refit").state != "running":
        _start(slug, "update", lambda job: _update(slug, job))
    return payload


def start_job(slug: str, kind: str) -> dict:
    _start(slug, kind, lambda job: _update(slug, job, refit=(kind == "refit")))
    return get_status(slug)


def get_status(slug: str) -> dict:
    payload = _payloads.get(slug) or _read(_dir(slug) / "payload.json") or {}
    model = _read(_dir(slug) / "model.json") or {}
    return {"slug": slug, "computed_at": payload.get("computed_at"), "as_of": payload.get("as_of"),
            "model_fitted_at": model.get("fitted_at"), "model_data_through": model.get("data_through"),
            "jobs": {k: dataclasses.asdict(_job(slug, k)) for k in ("update", "refit")}}


def warm_cache() -> None:
    for slug in COUNTRIES:
        get_labour(slug)
