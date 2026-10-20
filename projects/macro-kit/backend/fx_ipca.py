"""
FX IPCA — Instrumented Principal Components for currency excess returns.

Methodology (Kelly, Pruitt & Su, "Characteristics are covariances", JFE 2019)
---------------------------------------------------------------------------
Monthly USD-based excess return of being long currency i from t to t+1:

    r[i,t+1] = alpha[i,t] + beta[i,t]' f[t+1] + e[i,t+1]
    beta[i,t]  = z[i,t]' Gamma_beta        (L x K)
    alpha[i,t] = z[i,t]' Gamma_alpha       (L,)  — zero in the restricted model

z[i,t] are characteristics known at t (carry, momentum, value, implied vol,
risk reversal, plus a constant), ranked cross-sectionally to [-0.5, 0.5] with
missing values at the median (0). The constant lets the model find a dollar
factor.

Estimation is alternating least squares on the managed-portfolio moments
ZZ[t] = Z[t]'Z[t] and X[t] = Z[t]'r[t+1]: given Gamma the factors are
cross-sectional regressions, given the factors Gamma is one pooled regression.
Identification: Gamma_beta'Gamma_beta = I, factors orthogonal with descending
variance and positive means, Gamma_alpha orthogonal to Gamma_beta.

Outputs: total / predictive R² by K (with and without alpha), the Gamma_beta
map, factor returns labelled against the dollar and carry factors, the
bootstrap Wald test of Gamma_alpha = 0, the current cross-section (conditional
betas, expected returns, residuals) and an expanding-window out-of-sample
backtest.

Data
----
Bloomberg month-end spot, 1M forward points, 1M ATM vol and 25-delta risk
reversals when ANALYTICS_DATA_SOURCE=bloomberg (universe in
data/series_catalogue_fx_ipca.json), otherwise a deterministic simulation
generated from a two-factor IPCA model (dollar + carry with crashes) with a
3M-momentum alpha, so the tool has known structure to recover.
"""
from __future__ import annotations

import json
import math
import threading
import time
import warnings
import zlib
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from settings import settings

_CATALOGUE_PATH = Path(__file__).parent / "data" / "series_catalogue_fx_ipca.json"

CHARACTERISTICS: list[dict[str, str]] = [
    {"id": "carry", "label": "Carry", "description": "Annualised 1M forward discount vs USD (rate differential)"},
    {"id": "mom_3m", "label": "Momentum 3M", "description": "Excess return over the last 3 months"},
    {"id": "mom_12m", "label": "Momentum 12-1M", "description": "Excess return from 12 to 2 months ago"},
    {"id": "value", "label": "Value (5y reversal)", "description": "Minus the excess return from 60 to 13 months ago"},
    {"id": "ivol", "label": "Implied vol", "description": "1M ATM implied volatility"},
    {"id": "skew", "label": "Risk reversal", "description": "1M 25-delta risk reversal, positive = currency calls bid"},
    {"id": "const", "label": "Constant", "description": "Common loading on every currency (dollar exposure)"},
]
CHAR_IDS = [c["id"] for c in CHARACTERISTICS]

K_MAX = 4
MIN_CROSS_SECTION = 8      # months with fewer live currencies are not fitted
OOS_MIN_TRAIN = 60         # months before the first out-of-sample forecast
OOS_REFIT_EVERY = 12       # refit Gamma once a year in the backtest
MAX_ABS_RETURN = 0.5       # log-return guard against redenominations / bad prints
CACHE_TTL_S = 6 * 3600

_LOCK = threading.Lock()
_PANEL_CACHE: dict[str, tuple[float, "Panel"]] = {}
_RESULT_CACHE: dict[tuple, tuple[float, dict]] = {}


def _load_catalogue() -> dict:
    with open(_CATALOGUE_PATH, "r", encoding="utf-8") as fh:
        return json.load(fh)


# ─── Panel ────────────────────────────────────────────────────────────────────


@dataclass
class Panel:
    dates: pd.DatetimeIndex      # month-ends (formation dates)
    codes: list[str]
    R: np.ndarray                # (T, N) excess return realised from t to t+1
    raw: dict[str, np.ndarray]   # characteristic id -> (T, N) raw values (no const)
    alive: np.ndarray            # (T, N) currency has spot + forward at t
    data_source: str
    missing_series: list[str]
    partial_month: bool = False  # last row is today, not a month-end


def rank_cross_section(X: np.ndarray, alive: np.ndarray) -> np.ndarray:
    """Rank each row among live, non-missing entries onto [-0.5, 0.5]; missing -> 0."""
    out = np.zeros_like(X, dtype=float)
    for t in range(X.shape[0]):
        ok = alive[t] & np.isfinite(X[t])
        n = int(ok.sum())
        if n < 2:
            continue
        ranks = pd.Series(X[t, ok]).rank(method="average").to_numpy()
        out[t, ok] = (ranks - 1.0) / (n - 1.0) - 0.5
    return out


def build_characteristics(R: np.ndarray, carry: np.ndarray, ivol: np.ndarray,
                          rr: np.ndarray) -> dict[str, np.ndarray]:
    """Raw characteristics at each formation date, using only returns realised by then.

    R[t] is realised at t+1, so the return known at t is R[t-1]."""
    past = pd.DataFrame(R).shift(1)
    mom_3m = past.rolling(3, min_periods=3).sum()
    mom_12m = past.shift(1).rolling(11, min_periods=11).sum()
    lt = past.shift(12).rolling(48, min_periods=36)
    value = -lt.mean() * 48
    return {
        "carry": carry,
        "mom_3m": mom_3m.to_numpy(),
        "mom_12m": mom_12m.to_numpy(),
        "value": value.to_numpy(),
        "ivol": ivol,
        "skew": rr,
    }


def instruments(panel: Panel) -> np.ndarray:
    """Z (T, N, L): ranked characteristics plus a constant, in CHAR_IDS order."""
    cols = [rank_cross_section(panel.raw[c], panel.alive) for c in CHAR_IDS if c != "const"]
    cols.append(np.ones_like(panel.R))
    Z = np.stack(cols, axis=-1)
    return np.where(panel.alive[..., None], Z, 0.0)


# ─── IPCA estimation ──────────────────────────────────────────────────────────


@dataclass
class Moments:
    ZZ: np.ndarray   # (T, L, L)
    X: np.ndarray    # (T, L)
    RR: np.ndarray   # (T,)  sum of squared returns
    N: np.ndarray    # (T,)  observations per month


def managed_moments(Z: np.ndarray, R: np.ndarray, mask: np.ndarray) -> Moments:
    Zm = np.where(mask[..., None], Z, 0.0)
    Rm = np.where(mask, R, 0.0)
    return Moments(
        ZZ=np.einsum("tnl,tnm->tlm", Zm, Zm),
        X=np.einsum("tnl,tn->tl", Zm, Rm),
        RR=(Rm ** 2).sum(axis=1),
        N=mask.sum(axis=1),
    )


@dataclass
class IPCAFit:
    gamma_beta: np.ndarray            # (L, K)
    gamma_alpha: np.ndarray | None    # (L,)
    factors: np.ndarray               # (T, K)
    n_iter: int
    converged: bool


def _factor_step(m: Moments, Gb: np.ndarray, Ga: np.ndarray | None) -> np.ndarray:
    A = Gb.T @ (m.ZZ @ Gb)                       # (T, K, K)
    b = m.X if Ga is None else m.X - m.ZZ @ Ga
    b = b @ Gb
    A = A + 1e-10 * np.eye(Gb.shape[1])
    return np.linalg.solve(A, b[..., None])[..., 0]


def _gamma_step(m: Moments, F: np.ndarray, alpha: bool) -> tuple[np.ndarray, np.ndarray | None]:
    K = F.shape[1]
    T, L = m.X.shape
    Fa = np.column_stack([F, np.ones(T)]) if alpha else F
    Ka = Fa.shape[1]
    # Normal equations of the pooled regression: sum_t kron(f f', Z'Z) vec(Gamma) = sum_t kron(f, Z'r)
    FF = (Fa[:, :, None] * Fa[:, None, :]).reshape(T, Ka * Ka)
    M = (FF.T @ m.ZZ.reshape(T, L * L)).reshape(Ka, Ka, L, L).transpose(0, 2, 1, 3).reshape(Ka * L, Ka * L)
    rhs = (Fa.T @ m.X).reshape(Ka * L)
    G = np.linalg.lstsq(M, rhs, rcond=None)[0].reshape(Ka, L).T
    return G[:, :K], (G[:, K] if alpha else None)


def _normalize(Gb: np.ndarray, Ga: np.ndarray | None, F: np.ndarray):
    """Rotate to the KPS identification: Gb'Gb = I, F'F diagonal descending, mean(F) > 0,
    Ga orthogonal to Gb. Fitted values z'(Ga + Gb f) are unchanged."""
    if Ga is not None:
        c = np.linalg.solve(Gb.T @ Gb, Gb.T @ Ga)
        Ga = Ga - Gb @ c
        F = F + c
    L1 = np.linalg.cholesky(Gb.T @ Gb)
    Gb = Gb @ np.linalg.inv(L1.T)
    F = F @ L1
    w, V = np.linalg.eigh(F.T @ F / len(F))
    V = V[:, np.argsort(w)[::-1]]
    Gb, F = Gb @ V, F @ V
    s = np.sign(F.mean(axis=0))
    s[s == 0] = 1.0
    return Gb * s, Ga, F * s


def fit_ipca(m: Moments, K: int, alpha: bool = False,
             gamma0: tuple[np.ndarray, np.ndarray | None] | None = None,
             max_iter: int = 2000, tol: float = 1e-7) -> IPCAFit:
    """Alternating least squares on managed-portfolio moments."""
    L = m.X.shape[1]
    if gamma0 is not None:
        Gb = gamma0[0].copy()
        Ga = (gamma0[1].copy() if gamma0[1] is not None else np.zeros(L)) if alpha else None
    else:
        U, _, _ = np.linalg.svd(m.X.T, full_matrices=False)
        Gb = U[:, :K].copy()
        Ga = np.zeros(L) if alpha else None
    F = _factor_step(m, Gb, Ga)
    converged = False
    it = 0
    for it in range(1, max_iter + 1):
        Gb_n, Ga_n = _gamma_step(m, F, alpha)
        F_n = _factor_step(m, Gb_n, Ga_n)
        Gb_n, Ga_n, F_n = _normalize(Gb_n, Ga_n, F_n)
        diff = float(np.abs(Gb_n - Gb).max())
        if alpha:
            diff = max(diff, float(np.abs(Ga_n - Ga).max()))
        Gb, Ga, F = Gb_n, Ga_n, F_n
        if diff < tol:
            converged = True
            break
    return IPCAFit(gamma_beta=Gb, gamma_alpha=Ga, factors=F, n_iter=it, converged=converged)


def r2_stats(m: Moments, fit: IPCAFit) -> dict[str, float]:
    """Total R² (realised factors) and predictive R² (factor means), pooled over the panel."""
    Ga = fit.gamma_alpha if fit.gamma_alpha is not None else np.zeros(m.X.shape[1])
    G_tot = Ga + fit.factors @ fit.gamma_beta.T                  # (T, L)
    G_pred = Ga + fit.gamma_beta @ fit.factors.mean(axis=0)      # (L,)

    def sse(G):
        G = np.broadcast_to(G, m.X.shape)
        return float((m.RR - 2 * (G * m.X).sum(1) + np.einsum("tl,tlm,tm->t", G, m.ZZ, G)).sum())

    denom = float(m.RR.sum())
    return {"total_r2": 1 - sse(G_tot) / denom, "pred_r2": 1 - sse(G_pred) / denom}


def alpha_test(m: Moments, K: int, n_boot: int, seed: int,
               unrestricted: IPCAFit | None = None) -> dict:
    """KPS residual bootstrap of W = Gamma_alpha'Gamma_alpha under Gamma_alpha = 0."""
    fit = unrestricted or fit_ipca(m, K, alpha=True)
    W = float(fit.gamma_alpha @ fit.gamma_alpha)
    fitted_beta = np.einsum("tlm,mk,tk->tl", m.ZZ, fit.gamma_beta, fit.factors)
    d = m.X - fitted_beta - m.ZZ @ fit.gamma_alpha
    rng = np.random.default_rng(seed)
    T = len(m.X)
    exceed = 0
    for _ in range(n_boot):
        idx = rng.integers(0, T, size=T)
        q = rng.standard_t(5, size=T) * math.sqrt(3 / 5)
        mb = Moments(ZZ=m.ZZ, X=fitted_beta + q[:, None] * d[idx], RR=m.RR, N=m.N)
        fb = fit_ipca(mb, K, alpha=True, gamma0=(fit.gamma_beta, None), tol=1e-5, max_iter=300)
        exceed += float(fb.gamma_alpha @ fb.gamma_alpha) >= W
    return {"wald": W, "pvalue": (exceed + 1) / (n_boot + 1), "n_boot": n_boot}


# ─── Portfolio helpers ────────────────────────────────────────────────────────


def rank_weights(signal: np.ndarray, ok: np.ndarray) -> np.ndarray:
    """Dollar-neutral rank weights: +1 gross long, -1 gross short."""
    w = np.zeros_like(signal, dtype=float)
    if ok.sum() < 2:
        return w
    r = pd.Series(signal[ok]).rank().to_numpy()
    r = r - r.mean()
    gross = np.abs(r).sum()
    if gross > 0:
        w[ok] = 2 * r / gross
    return w


def perf_stats(r: np.ndarray) -> dict[str, float | None]:
    r = r[np.isfinite(r)]
    if len(r) < 2:
        return {"mean_ann": None, "vol_ann": None, "sharpe": None, "max_dd": None}
    cum = np.cumsum(r)
    dd = cum - np.maximum.accumulate(np.concatenate([[0.0], cum]))[1:]
    vol = float(r.std(ddof=1) * math.sqrt(12))
    mean = float(r.mean() * 12)
    return {"mean_ann": mean, "vol_ann": vol, "sharpe": mean / vol if vol > 0 else None,
            "max_dd": float(dd.min())}


def dollar_and_carry(panel: Panel, mask: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Equal-weight dollar factor and top-minus-bottom-third carry factor (Lustig et al.)."""
    T = len(panel.dates)
    dol = np.full(T, np.nan)
    hml = np.full(T, np.nan)
    for t in range(T):
        ok = mask[t] & np.isfinite(panel.raw["carry"][t])
        if ok.sum() < 3:
            continue
        r, c = panel.R[t, ok], panel.raw["carry"][t, ok]
        dol[t] = r.mean()
        n3 = max(1, len(c) // 3)
        order = np.argsort(c)
        hml[t] = r[order[-n3:]].mean() - r[order[:n3]].mean()
    return dol, hml


def _corr(a: np.ndarray, b: np.ndarray) -> float | None:
    ok = np.isfinite(a) & np.isfinite(b)
    if ok.sum() < 3 or a[ok].std() == 0 or b[ok].std() == 0:
        return None
    return float(np.corrcoef(a[ok], b[ok])[0, 1])


# ─── Data: Bloomberg ──────────────────────────────────────────────────────────


def _bloomberg_panel() -> Panel | None:
    try:
        from bbg import bdh, bdp
    except ImportError:
        return None
    cat = _load_catalogue()
    ccys = cat["currencies"]
    end = pd.Timestamp.today().normalize()
    tickers = sorted({c[k] for c in ccys for k in ("spot", "fwd", "vol", "rr")})
    try:
        raw = bdh(tickers, "PX_LAST", cat["start"], end.strftime("%Y-%m-%d"), periodicity="MONTHLY")
        scales = bdp([c["fwd"] for c in ccys], "FWD_SCALE")
    except Exception as exc:
        warnings.warn(f"[fx_ipca] Bloomberg request failed: {exc}", stacklevel=2)
        return None
    if raw is None or raw.empty:
        return None
    px = raw.xs("PX_LAST", axis=1, level=1)
    # Month-end rows; the final row is today's value when the month is still running
    px = px.groupby(px.index.to_period("M")).last()
    partial = px.index[-1] == end.to_period("M") and end != (end + pd.offsets.MonthEnd(0))
    dates = px.index.to_timestamp(how="end").normalize()
    if partial:
        dates = dates[:-1].append(pd.DatetimeIndex([end]))

    def col(t):
        return px[t].to_numpy(dtype=float) if t in px.columns else np.full(len(px), np.nan)

    codes, missing = [], []
    S_usd, F_usd, vol, rr = [], [], [], []
    for c in ccys:
        spot, pts = col(c["spot"]), col(c["fwd"])
        if np.isfinite(spot).sum() < 36 or np.isfinite(pts).sum() < 36:
            missing.append(c["code"])
            continue
        sc = scales.get(c["fwd"], {}).get("FWD_SCALE")
        scale = float(sc) if sc is not None else float(c["fwd_scale"])
        fwd = spot + pts / 10 ** scale
        sign = 1.0 if c["quote"] == "direct" else -1.0
        s, f = sign * np.log(spot), sign * np.log(fwd)
        carry = 12 * (s - f)
        if np.nanmedian(np.abs(carry)) > 1.0:   # wrong points scale
            missing.append(c["code"])
            continue
        codes.append(c["code"])
        S_usd.append(s)
        F_usd.append(f)
        vol.append(col(c["vol"]) / 100)
        rr.append(sign * col(c["rr"]) / 100)
        for k in ("vol", "rr"):
            if np.isfinite(col(c[k])).sum() < 12:
                missing.append(c[k])
    if len(codes) < MIN_CROSS_SECTION:
        return None
    s, f = np.column_stack(S_usd), np.column_stack(F_usd)
    R = np.full_like(s, np.nan)
    R[:-1] = s[1:] - f[:-1]
    if partial:
        R[-2] = np.nan       # month not finished: return to today is not a monthly return
    R[np.abs(R) > MAX_ABS_RETURN] = np.nan
    carry = 12 * (s - f)
    alive = np.isfinite(carry)
    return Panel(dates=dates, codes=codes, R=R,
                 raw=build_characteristics(R, carry, np.column_stack(vol), np.column_stack(rr)),
                 alive=alive, data_source="bloomberg", missing_series=missing, partial_month=bool(partial))


# ─── Data: simulation ─────────────────────────────────────────────────────────

# Late starters in the simulated panel (unbalanced like the real one)
_SIM_START = {"CNH": "2010-09-30", "TRY": "2008-01-31", "ILS": "2007-06-30"}


def _simulated_panel() -> Panel:
    cat = _load_catalogue()
    ccys = cat["currencies"]
    rng = np.random.default_rng(zlib.crc32(b"fx_ipca"))
    last = (pd.Timestamp.today().normalize() - pd.offsets.MonthEnd(1)).normalize()
    dates = pd.date_range(cat["start"], last, freq="ME")
    T, N = len(dates), len(ccys)
    codes = [c["code"] for c in ccys]
    mu_c = np.array([c["sim_carry"] for c in ccys])
    mu_v = np.array([c["sim_vol"] for c in ccys])
    alive = np.ones((T, N), dtype=bool)
    for j, c in enumerate(codes):
        if c in _SIM_START:
            alive[:, j] = dates >= pd.Timestamp(_SIM_START[c])

    # Global risk regime (log-vol shock) and characteristics
    g = np.zeros(T)
    for t in range(1, T):
        g[t] = 0.9 * g[t - 1] + 0.25 * rng.standard_normal()
    carry = np.zeros((T, N))
    logv = np.zeros((T, N))
    carry[0], logv[0] = mu_c, np.log(mu_v)
    for t in range(1, T):
        carry[t] = mu_c + 0.96 * (carry[t - 1] - mu_c) + (0.002 + 0.03 * np.abs(mu_c)) * rng.standard_normal(N)
        logv[t] = np.log(mu_v) + 0.8 * (logv[t - 1] - np.log(mu_v)) + 0.1 * g[t] + 0.07 * rng.standard_normal(N)
    ivol = np.exp(logv)
    rr = -0.25 * (carry - carry.mean(axis=1, keepdims=True)) - 0.05 * (ivol - 0.09)
    rr = rr + 0.004 * rng.standard_normal((T, N))

    z_carry = rank_cross_section(carry, alive)
    z_vol = rank_cross_section(ivol, alive)
    z_skew = rank_cross_section(rr, alive)

    # Factors: dollar and carry; carry crashes coincide with dollar rallies
    crash = rng.random(T) < 0.04
    risk_scale = np.exp(0.6 * g)
    f_dol = 0.0005 + 0.018 * risk_scale * rng.standard_normal(T) - 0.02 * crash
    f_car = 0.004 + 0.012 * risk_scale * rng.standard_normal(T) - 0.05 * crash
    idio = (mu_v / math.sqrt(12)) * 0.55

    R = np.full((T, N), np.nan)
    for t in range(T - 1):            # last month's return is not realised yet
        ok = alive[t]
        past = R[max(0, t - 3):t]
        mom3 = np.where(np.isfinite(past).all(0), np.nansum(past, axis=0), np.nan) if t >= 3 else np.full(N, np.nan)
        z_mom = rank_cross_section(mom3[None, :], ok[None, :])[0]
        beta_dol = 1.0 + 0.6 * z_vol[t] - 0.3 * z_skew[t]
        beta_car = 1.4 * z_carry[t] + 0.3 * z_vol[t] - 0.5 * z_skew[t]
        r = 0.006 * z_mom + beta_dol * f_dol[t] + beta_car * f_car[t] + idio * rng.standard_normal(N)
        R[t] = np.where(ok, r, np.nan)

    carry = np.where(alive, carry, np.nan)
    ivol = np.where(alive, ivol, np.nan)
    rr = np.where(alive, rr, np.nan)
    return Panel(dates=dates, codes=codes, R=R, raw=build_characteristics(R, carry, ivol, rr),
                 alive=alive, data_source="simulation", missing_series=[])


def load_panel(refresh: bool = False) -> Panel:
    key = settings.data_source
    with _LOCK:
        hit = _PANEL_CACHE.get(key)
        if hit and not refresh and time.time() - hit[0] < CACHE_TTL_S:
            return hit[1]
    panel = _bloomberg_panel() if settings.data_source == "bloomberg" else None
    if panel is None:
        panel = _simulated_panel()
    with _LOCK:
        _PANEL_CACHE[key] = (time.time(), panel)
    return panel


# ─── Analysis ─────────────────────────────────────────────────────────────────


def _fit_mask(panel: Panel) -> tuple[np.ndarray, np.ndarray]:
    """Observation mask and the months that enter estimation."""
    mask = panel.alive & np.isfinite(panel.R)
    dates_ok = mask.sum(axis=1) >= MIN_CROSS_SECTION
    # Start once every characteristic is observed (value needs ~5 years of returns);
    # an all-missing characteristic is a zero instrument column and makes Z't Z singular
    for c in CHAR_IDS:
        if c == "const":
            continue
        covered = (np.isfinite(panel.raw[c]) & panel.alive).sum(axis=1) >= MIN_CROSS_SECTION
        if covered.any():
            dates_ok &= np.arange(len(covered)) >= int(np.argmax(covered))
    return mask & dates_ok[:, None], dates_ok


def _sub(m: Moments, idx: np.ndarray) -> Moments:
    return Moments(ZZ=m.ZZ[idx], X=m.X[idx], RR=m.RR[idx], N=m.N[idx])


def _iso(d: pd.Timestamp) -> str:
    return d.strftime("%Y-%m-%d")


def _num(x, nd: int = 6):
    return None if x is None or not np.isfinite(x) else round(float(x), nd)


def _oos_backtest(panel: Panel, Z: np.ndarray, mask: np.ndarray, dates_ok: np.ndarray, K: int) -> dict:
    m_all = managed_moments(Z, panel.R, mask)
    fit_idx = np.flatnonzero(dates_ok)
    if len(fit_idx) <= OOS_MIN_TRAIN + 12:
        return {"available": False}
    # Expected returns from data before t only: restricted (beta * lambda) and with alpha
    pred = np.full_like(panel.R, np.nan)
    pred_a = np.full_like(panel.R, np.nan)
    fit = fit_a = None
    for n, t in enumerate(fit_idx[OOS_MIN_TRAIN:]):
        if n % OOS_REFIT_EVERY == 0:
            train = _sub(m_all, fit_idx[fit_idx < t])
            g0 = (fit.gamma_beta, None) if fit is not None else None
            fit = fit_ipca(train, K, gamma0=g0, tol=1e-6, max_iter=500)
            fit_a = fit_ipca(train, K, alpha=True, gamma0=(fit.gamma_beta, None), tol=1e-6, max_iter=500)
            g = fit.gamma_beta @ fit.factors.mean(axis=0)
            g_a = fit_a.gamma_alpha + fit_a.gamma_beta @ fit_a.factors.mean(axis=0)
        pred[t] = Z[t] @ g
        pred_a[t] = Z[t] @ g_a
    oos = np.isfinite(pred) & mask

    def oos_r2(p):
        return 1 - float(((panel.R - p)[oos] ** 2).sum()) / float((panel.R[oos] ** 2).sum())

    dol, _ = dollar_and_carry(panel, mask)
    ids = ["ipca", "ipca_alpha", "carry", "dollar"]
    rets = {s: [] for s in ids}
    rows = []
    cum = dict.fromkeys(ids, 0.0)
    for t in fit_idx[OOS_MIN_TRAIN:]:
        ok = oos[t]
        carry_t = panel.raw["carry"][t]
        r = np.nan_to_num(panel.R[t])
        month = {
            "ipca": rank_weights(pred[t], ok) @ r,
            "ipca_alpha": rank_weights(pred_a[t], ok) @ r,
            "carry": rank_weights(np.nan_to_num(carry_t), ok & np.isfinite(carry_t)) @ r,
            "dollar": dol[t],
        }
        row = {"date": _iso(panel.dates[t])}
        for s in ids:
            rets[s].append(month[s])
            cum[s] += 0.0 if not np.isfinite(month[s]) else month[s]
            row[s] = _num(cum[s])
        rows.append(row)
    labels = {"ipca": "IPCA expected-return ranks", "ipca_alpha": "IPCA + alpha ranks",
              "carry": "Carry ranks", "dollar": "Dollar (equal-weight long FX)"}
    return {
        "available": True,
        "start": rows[0]["date"],
        "refit_every_months": OOS_REFIT_EVERY,
        "min_train_months": OOS_MIN_TRAIN,
        "pred_r2": _num(oos_r2(pred)),
        "pred_r2_alpha": _num(oos_r2(pred_a)),
        "strategies": [{"id": s, "label": labels[s], **perf_stats(np.array(rets[s]))} for s in ids],
        "series": rows,
    }


def _factor_label(c_dol, c_car) -> str:
    if c_dol is not None and abs(c_dol) >= 0.7 and abs(c_dol) >= abs(c_car or 0):
        return "Dollar-like"
    if c_car is not None and abs(c_car) >= 0.5:
        return "Carry-like"
    return "Unlabelled"


def _compute(panel: Panel, K: int, n_boot: int) -> dict:
    Z = instruments(panel)
    mask, dates_ok = _fit_mask(panel)
    fit_idx = np.flatnonzero(dates_ok)
    m = _sub(managed_moments(Z, panel.R, mask), fit_idx)
    seed = zlib.crc32(f"fx_ipca_boot_{K}".encode())

    selection, fits = [], {}
    for k in range(1, K_MAX + 1):
        fr = fit_ipca(m, k)
        fu = fit_ipca(m, k, alpha=True, gamma0=(fr.gamma_beta, None))
        fits[k] = (fr, fu)
        sr, su = r2_stats(m, fr), r2_stats(m, fu)
        selection.append({"k": k, "total_r2": _num(sr["total_r2"]), "pred_r2": _num(sr["pred_r2"]),
                          "total_r2_alpha": _num(su["total_r2"]), "pred_r2_alpha": _num(su["pred_r2"])})
    fit, fit_u = fits[K]
    test = alpha_test(m, K, n_boot, seed, unrestricted=fit_u) if n_boot > 0 else None

    # Factors vs observable dollar / carry factors
    dol, hml = dollar_and_carry(panel, mask)
    F = fit.factors
    lam = F.mean(axis=0)
    names = [f"F{j + 1}" for j in range(K)]
    factor_stats = []
    for j in range(K):
        c_dol, c_car = _corr(F[:, j], dol[fit_idx]), _corr(F[:, j], hml[fit_idx])
        factor_stats.append({"name": names[j], "label": _factor_label(c_dol, c_car),
                             **perf_stats(F[:, j]), "corr_dollar": _num(c_dol), "corr_carry": _num(c_car)})
    cum_f = np.cumsum(F, axis=0)
    cum_dol, cum_hml = np.nancumsum(dol[fit_idx]), np.nancumsum(hml[fit_idx])
    factor_series = [
        {"date": _iso(panel.dates[t]), **{names[j]: _num(cum_f[i, j]) for j in range(K)},
         "dollar": _num(cum_dol[i]), "carry": _num(cum_hml[i])}
        for i, t in enumerate(fit_idx)
    ]

    # Current cross-section (last formation date) and residuals
    resid = np.full_like(panel.R, np.nan)
    fitted = np.einsum("tnl,lk,tk->tn", Z[fit_idx], fit.gamma_beta, F)
    resid[fit_idx] = np.where(mask[fit_idx], panel.R[fit_idx] - fitted, np.nan)
    T_now = len(panel.dates) - 1
    Z_now = Z[T_now]
    betas_now = Z_now @ fit.gamma_beta
    exp_now = Z_now @ (fit.gamma_beta @ lam)
    alpha_now = Z_now @ fit_u.gamma_alpha
    last_fit = fit_idx[-1]
    rows = []
    for i, code in enumerate(panel.codes):
        if not panel.alive[T_now, i]:
            continue
        e = resid[:, i]
        e_ok = e[np.isfinite(e)]
        sd = e_ok.std(ddof=1) if len(e_ok) > 12 else np.nan
        last3 = e[max(0, last_fit - 2):last_fit + 1]
        r_i = panel.R[mask[:, i], i]
        rows.append({
            "code": code,
            "raw": {c: _num(panel.raw[c][T_now, i]) for c in CHAR_IDS if c != "const"},
            "rank": {c: _num(Z_now[i, j], 4) for j, c in enumerate(CHAR_IDS)},
            "betas": [_num(b, 4) for b in betas_now[i]],
            "exp_ret_ann": _num(12 * exp_now[i]),
            "alpha_ann": _num(12 * alpha_now[i]),
            "resid_last": _num(e[last_fit]),
            "resid_z_3m": _num(np.nansum(last3) / (sd * math.sqrt(3)) if np.isfinite(sd) and sd > 0
                               and np.isfinite(last3).all() else None, 3),
            "ts_r2": _num(1 - float((e_ok ** 2).sum()) / float((r_i ** 2).sum()) if len(r_i) else None, 4),
            "n_months": int(mask[:, i].sum()),
        })

    cat = {c["code"]: c for c in _load_catalogue()["currencies"]}
    for r in rows:
        r["name"], r["bloc"] = cat[r["code"]]["name"], cat[r["code"]]["bloc"]

    return {
        "data_source": panel.data_source,
        "missing_series": panel.missing_series,
        "partial_month": panel.partial_month,
        "as_of": _iso(panel.dates[-1]),
        "start": _iso(panel.dates[fit_idx[0]]),
        "end": _iso(panel.dates[last_fit]),
        "n_months": int(len(fit_idx)),
        "n_currencies": len(panel.codes),
        "n_obs": int(m.N.sum()),
        "k": K,
        "k_max": K_MAX,
        "characteristics": CHARACTERISTICS,
        "converged": bool(fit.converged and fit_u.converged),
        "model_selection": selection,
        "gamma_beta": [[_num(v, 4) for v in row] for row in fit.gamma_beta],
        "gamma_alpha": [_num(v, 5) for v in fit_u.gamma_alpha],
        "alpha_test": None if test is None else {k: _num(v, 6) if k != "n_boot" else v for k, v in test.items()},
        "factors": {"names": names, "stats": factor_stats, "lambda": [_num(v) for v in lam],
                    "series": factor_series},
        "cross_section": rows,
        "oos": _oos_backtest(panel, Z, mask, dates_ok, K),
        "_internal": {"fit": fit, "Z": Z, "mask": mask, "fit_idx": fit_idx, "resid": resid},
    }


def _cached(K: int, n_boot: int, refresh: bool) -> tuple[Panel, dict]:
    panel = load_panel(refresh)
    key = (panel.data_source, id(panel), K, n_boot)
    with _LOCK:
        hit = _RESULT_CACHE.get(key)
        if hit and not refresh and time.time() - hit[0] < CACHE_TTL_S:
            return panel, hit[1]
    res = _compute(panel, K, n_boot)
    with _LOCK:
        for k in [k for k in _RESULT_CACHE if k[1] != id(panel)]:
            del _RESULT_CACHE[k]
        _RESULT_CACHE[key] = (time.time(), res)
    return panel, res


def get_fx_ipca(k: int = 2, n_boot: int = 100, refresh: bool = False) -> dict:
    """Full page payload."""
    _, res = _cached(k, n_boot, refresh)
    return {key: v for key, v in res.items() if key != "_internal"}


def warm_cache() -> None:
    """Startup warm-up: fetch the panel and fit the default model."""
    get_fx_ipca()


def get_currency_detail(code: str, k: int = 2, n_boot: int = 100) -> dict:
    """Monthly history for one currency: conditional betas, realised vs fitted return, ranks."""
    panel, res = _cached(k, n_boot, False)
    if code not in panel.codes:
        raise KeyError(code)
    i = panel.codes.index(code)
    inn = res["_internal"]
    fit, Z, mask, resid = inn["fit"], inn["Z"], inn["mask"], inn["resid"]
    betas = Z[:, i, :] @ fit.gamma_beta
    pos = {t: n for n, t in enumerate(inn["fit_idx"])}
    series = []
    for t in range(len(panel.dates)):
        if not panel.alive[t, i]:
            continue
        n = pos.get(t)
        realised = panel.R[t, i] if mask[t, i] else np.nan
        fitted = Z[t, i] @ fit.gamma_beta @ fit.factors[n] if n is not None and mask[t, i] else np.nan
        series.append({
            "date": _iso(panel.dates[t]),
            **{f"beta_F{j + 1}": _num(betas[t, j], 4) for j in range(k)},
            "ret": _num(realised), "fitted": _num(fitted), "resid": _num(resid[t, i]),
            **{f"rank_{c}": _num(Z[t, i, j], 4) for j, c in enumerate(CHAR_IDS) if c != "const"},
        })
    row = next(r for r in res["cross_section"] if r["code"] == code) if any(
        r["code"] == code for r in res["cross_section"]) else None
    return {"code": code, "data_source": panel.data_source, "k": k, "current": row, "series": series}
