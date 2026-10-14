"""
Mean Reversion — Ornstein-Uhlenbeck engine.

Implements Chapter 2 of Huggins & Schaller, "Fixed Income Relative Value Analysis" (2024):
  - Expression parser  : weighted sum of Bloomberg tickers
  - Data layer         : Bloomberg BDH → simulation fallback
  - PMLE estimation    : OU parameters (k, μ, σ) via L-BFGS-B on log-parameterisation
  - Stanton diagnostic : nonparametric drift + diffusion bucket charts
  - Transition densities: analytical forward distributions at 1W / 2W / 1M / 3M / 6M / 1Y
  - Sharpe profile     : annualised SR vs holding horizon (converging-trade basis)
  - First passage times: Monte Carlo hitting-time analysis

Entry point
-----------
  result = analyse(expression, start_date, end_date, target, stop, n_sims)
"""

from __future__ import annotations

import re
from typing import Optional

import numpy as np
import pandas as pd
from scipy.optimize import minimize
from scipy.stats import norm as sp_norm, gaussian_kde

# ── Expression parser ──────────────────────────────────────────────────────────

_YELLOW = r'(?:Index|Curncy|Comdty|Corp|Govt|Equity|Mtge|Muni|Pfd)'

def parse_expression(expr: str) -> list[tuple[float, str]]:
    """
    Parse a weighted-sum expression of Bloomberg tickers.

    Handles
    -------
    "USGG10YR Index"
    "USGG10YR Index - USGG2YR Index"
    "2 * USGG5YR Index - USGG2YR Index - USGG10YR Index"
    "GDBR10 Index - 2 * GDBR5 Index + GDBR2 Index"
    """
    expr = expr.strip()
    if not expr.startswith('-'):
        expr = '+' + expr

    token_re = re.compile(
        rf'([+-])\s*(\d+(?:\.\d+)?)?\s*\*?\s*((?:[\w\d\.]+\s+)+{_YELLOW})\b'
    )

    terms: list[tuple[float, str]] = []
    for m in token_re.finditer(expr):
        sign_str, coeff_str, ticker = m.groups()
        sign = -1.0 if sign_str == '-' else 1.0
        coeff = float(coeff_str) if coeff_str else 1.0
        terms.append((sign * coeff, ticker.strip()))

    if not terms:
        raise ValueError(f"No Bloomberg tickers found in expression: {expr!r}")
    return terms


# ── Data layer ─────────────────────────────────────────────────────────────────

def _bbg_fetch(ticker: str, start: str, end: str) -> Optional[pd.Series]:
    """Fetch daily BDH series via Bloomberg. Returns None on any failure."""
    try:
        from bbg import blp
        df = blp.bdh(ticker, ['PX_LAST'], start, end)
        if df.empty:
            return None
        s = df['PX_LAST'].dropna()
        s.index = pd.to_datetime(s.index)
        return s
    except Exception:
        return None


def _simulate_level(
    ticker: str,
    dates: pd.DatetimeIndex,
    rng: np.random.Generator,
) -> pd.Series:
    """
    Synthetic single-ticker level series for simulation mode.
    Uses a slow-reverting OU to mimic a yield/spread level.
    Parameters are tuned by yellow key.
    """
    yk = ticker.split()[-1]
    # (mu, k_annual, sigma_annual, x0)
    params = {
        'Curncy': (0.50, 0.04, 0.60, 0.50),
        'Comdty': (100., 0.02, 8.00, 95.0),
        'Equity': (4500., 0.05, 300., 4200.),
    }
    mu, k, sigma, x0 = params.get(yk, (3.50, 0.03, 0.40, 3.20))

    dt = 1 / 252
    exp_k = np.exp(-k * dt)
    std_step = sigma * np.sqrt((1 - np.exp(-2 * k * dt)) / (2 * k))

    n = len(dates)
    x = np.empty(n)
    x[0] = x0
    eps = rng.standard_normal(n)
    for i in range(1, n):
        x[i] = mu + (x[i - 1] - mu) * exp_k + std_step * eps[i]
    return pd.Series(x, index=dates)


def build_series(
    terms: list[tuple[float, str]],
    start: str,
    end: str,
) -> tuple[pd.Series, bool]:
    """
    Fetch each unique ticker and form the weighted composite.
    Falls back to simulation for any ticker that Bloomberg can't serve.

    Returns (composite_series, simulation_mode_flag).
    """
    dates = pd.bdate_range(start, end)
    rng = np.random.default_rng(42)
    sim_mode = False
    components: dict[str, pd.Series] = {}

    for _, ticker in terms:
        if ticker in components:
            continue
        s = _bbg_fetch(ticker, start, end)
        if s is None:
            s = _simulate_level(ticker, dates, rng)
            sim_mode = True
        else:
            s = s.reindex(dates).ffill()
        components[ticker] = s

    df = pd.DataFrame(components).dropna()
    composite = sum(w * df[t] for w, t in terms)
    return composite.rename('value'), sim_mode


# ── OU estimation (PMLE) ───────────────────────────────────────────────────────

def _neg_ll(log_params: np.ndarray, x: np.ndarray, dt: float) -> float:
    """
    Negative log-likelihood for the OU process.
    Parameterised as (log_k, mu, log_sigma) to enforce k > 0, sigma > 0
    without requiring constrained optimisation.

    Transition density: N(mu + (x_t - mu)*exp(-k*dt), sigma^2*(1-exp(-2k*dt))/(2k))
    """
    k = np.exp(log_params[0])
    mu = log_params[1]
    sigma = np.exp(log_params[2])

    exp_k = np.exp(-k * dt)
    cond_mean = mu + (x[:-1] - mu) * exp_k
    cond_var = sigma ** 2 * (1 - np.exp(-2 * k * dt)) / (2 * k)
    if cond_var <= 0:
        return 1e12

    resid = x[1:] - cond_mean
    ll = -0.5 * (np.log(2 * np.pi * cond_var) + resid ** 2 / cond_var)
    return float(-ll.sum())


def estimate_ou(series: pd.Series) -> dict:
    """
    Estimate OU parameters via PMLE on daily data.

    Returns
    -------
    k               : speed of mean reversion (annualised)
    mu              : long-run mean
    sigma           : instantaneous annualised volatility
    half_life_days  : ln(2)/k * 252 business days
    stationary_std  : sigma / sqrt(2k)  (unconditional std)
    current         : latest observation
    current_zscore  : (current - mu) / stationary_std
    """
    x = series.dropna().values.astype(float)
    dt = 1 / 252

    # OLS initial guess on discretised OU: dx/dt = a + b*x  →  k = -b, mu = -a/b
    dx = np.diff(x)
    xl = x[:-1]
    x_std = float(xl.std())

    if x_std < 1e-12:
        k0, mu0, sigma0 = 0.5, float(np.mean(x)), max(float(np.std(dx) * np.sqrt(252)), 1e-6)
    else:
        b, a = np.polyfit(xl, dx / dt, 1)
        k0 = max(-b, 0.05)
        mu0 = (-a / b) if abs(b) > 1e-12 else float(np.mean(x))
        sigma0 = max(float(np.std(dx) * np.sqrt(1 / dt)), 1e-6)

    x0 = [np.log(k0), mu0, np.log(sigma0)]
    res = minimize(
        _neg_ll, x0, args=(x, dt),
        method='L-BFGS-B',
        options={'maxiter': 10_000, 'ftol': 1e-14, 'gtol': 1e-8},
    )

    k = float(np.exp(res.x[0]))
    mu = float(res.x[1])
    sigma = float(np.exp(res.x[2]))

    stat_std = sigma / np.sqrt(2 * k)
    half_life = np.log(2) / k * 252      # business days
    current = float(x[-1])
    zscore = (current - mu) / stat_std if stat_std > 1e-14 else 0.0

    return dict(
        k=k, mu=mu, sigma=sigma,
        half_life_days=float(half_life),
        stationary_std=float(stat_std),
        current=current,
        current_zscore=float(zscore),
    )


# ── Polynomial / inverse-polynomial drift estimation (PMLE via OLS) ───────────

def _poly_long_run_mean(a: float, b: float, c: float, d: float,
                        xl: np.ndarray, mode: str) -> float:
    """
    Find the long-run mean as the real root of f(x) = 0 closest to the sample mean.

    Polynomial    : a + bx + cx² + dx³ = 0  → roots of [d, c, b, a]
    Inverse-poly  : a/x + bx + cx² + dx³ = 0
                    multiply by x: a + bx² + cx³ + dx⁴ = 0  → roots of [d, c, b, 0, a]
    """
    x_mean = float(np.mean(xl))
    try:
        coeffs = [d, c, b, a] if mode == 'polynomial' else [d, c, b, 0.0, a]
        roots = np.roots(coeffs)
        real_roots = np.real(roots[np.abs(np.imag(roots)) < 1e-6])
        if mode == 'inverse_polynomial':
            real_roots = real_roots[real_roots != 0.0]
        if len(real_roots) == 0:
            return x_mean
        return float(real_roots[np.argmin(np.abs(real_roots - x_mean))])
    except Exception:
        return x_mean


def _poly_k_at_mean(a: float, b: float, c: float, d: float,
                    mu: float, mode: str) -> float:
    """
    Linearised speed of mean reversion: k ≈ −f′(μ).

    Polynomial    : f′(x) = b + 2cx + 3dx²
    Inverse-poly  : f′(x) = −a/x² + b + 2cx + 3dx²
    """
    if mode == 'polynomial':
        k = -(b + 2 * c * mu + 3 * d * mu ** 2)
    else:
        inv_term = -a / mu ** 2 if abs(mu) > 1e-10 else 0.0
        k = -(inv_term + b + 2 * c * mu + 3 * d * mu ** 2)
    return max(float(k), 1e-6)


def estimate_model(series: pd.Series, model_type: str = 'linear_ou') -> tuple[dict, dict]:
    """
    Estimate the drift model and return (ou_params, model_info).

    ou_params
        Always in OU format (k, mu, sigma, half_life_days, stationary_std,
        current, current_zscore).  For polynomial models k and mu come from
        the linearisation at the estimated long-run mean so that the forward
        analytics (forward distributions, Sharpe, FPT) remain consistent.

    model_info
        Display-oriented dict: sde, coefficients, derived quantities,
        estimation method description.
    """
    x = series.dropna().values.astype(float)
    dt = 1 / 252
    current = float(x[-1])

    # ── Linear OU ──────────────────────────────────────────────────────────────
    if model_type == 'linear_ou':
        ou = estimate_ou(series)
        model_info = {
            'model_type': 'linear_ou',
            'sde':        'dx = κ(μ − x) dt + σ dW',
            'coefficients': [
                {'symbol': 'κ', 'name': 'Speed of mean reversion (annualised)', 'value': round(ou['k'],     6)},
                {'symbol': 'μ', 'name': 'Long-run mean',                         'value': round(ou['mu'],    6)},
                {'symbol': 'σ', 'name': 'Instantaneous volatility (annualised)', 'value': round(ou['sigma'], 6)},
            ],
            'derived': [
                {'symbol': 't½',  'name': 'Half-life',     'value': f"{ou['half_life_days']:.1f} bdays", 'note': 'ln(2)/κ × 252'},
                {'symbol': 'σ∞',  'name': 'Stationary σ',  'value': round(ou['stationary_std'], 6),       'note': 'σ / √(2κ)'},
                {'symbol': 'z',   'name': 'Current z-score','value': round(ou['current_zscore'], 3),       'note': '(x − μ) / σ∞'},
            ],
            'estimation_method': 'Exact MLE — closed-form OU transition density',
            'estimation_detail': (
                'Parameters (κ, μ, σ) maximise the exact log-likelihood '
                'ℓ = Σ log N(x_{t+1}; μ+(x_t−μ)e^{−κΔt}, σ²(1−e^{−2κΔt})/(2κ)). '
                'Optimised via L-BFGS-B in the log-parameterisation (log κ, μ, log σ) '
                'to enforce positivity without box constraints.'
            ),
            'constraint_note': None,
        }
        return ou, model_info

    # ── Polynomial or inverse-polynomial ──────────────────────────────────────
    dx = np.diff(x)
    xl = x[:-1]
    y_rate = dx / dt      # discretised dx/dt used as response

    mode = 'polynomial' if model_type == 'polynomial' else 'inverse_polynomial'

    if mode == 'inverse_polynomial':
        # Exclude the bottom 1% of |x| to avoid near-zero singularities
        threshold = max(np.percentile(np.abs(xl), 1), 1e-8)
        safe = np.abs(xl) > threshold
        xl_fit = xl[safe]
        y_fit  = y_rate[safe]
    else:
        xl_fit = xl
        y_fit  = y_rate

    if mode == 'polynomial':
        X = np.column_stack([np.ones(len(xl_fit)), xl_fit, xl_fit ** 2, xl_fit ** 3])
        syms  = ['a', 'b', 'c', 'd']
        descs = ['Constant', 'Linear  (x)', 'Quadratic (x²)', 'Cubic  (x³)']
        sde   = 'dx = (a + bx + cx² + dx³) dt + σ dW'
    else:
        X = np.column_stack([1 / xl_fit, xl_fit, xl_fit ** 2, xl_fit ** 3])
        syms  = ['a', 'b', 'c', 'd']
        descs = ['Inverse (1/x)', 'Linear  (x)', 'Quadratic (x²)', 'Cubic  (x³)']
        sde   = 'dx = (a/x + bx + cx² + dx³) dt + σ dW'

    beta, _, _, _ = np.linalg.lstsq(X, y_fit, rcond=None)
    a, b, c, d = float(beta[0]), float(beta[1]), float(beta[2]), float(beta[3])

    resid = y_fit - X @ beta
    sigma = max(float(np.std(resid) * np.sqrt(dt)), 1e-8)

    # Long-run mean and linearised OU parameters
    mu    = _poly_long_run_mean(a, b, c, d, xl, mode)
    k     = _poly_k_at_mean(a, b, c, d, mu, mode)
    stat_std  = sigma / np.sqrt(2 * k)
    half_life = np.log(2) / k * 252
    zscore    = (current - mu) / stat_std if stat_std > 1e-14 else 0.0

    ou_params = dict(
        k=k, mu=mu, sigma=sigma,
        half_life_days=half_life,
        stationary_std=stat_std,
        current=current,
        current_zscore=zscore,
    )

    # Constraint diagnostics (H&S p.26)
    if mode == 'polynomial':
        ok = d <= 0
        constraint_note = (
            f'd ≤ 0 required so drift does not explode as x → ∞  '
            f'(H&S §2 p.26). Estimated d = {d:.6f} — {"✓ satisfied" if ok else "⚠ violated — interpret with caution"}.'
        )
    else:
        ok = a >= 0
        constraint_note = (
            f'a ≥ 0 needed so zero acts as a reflecting barrier for x > 0  '
            f'(H&S §2 p.26). Estimated a = {a:.6f} — {"✓ satisfied" if ok else "⚠ violated — interpret with caution"}.'
        )

    model_info = {
        'model_type': model_type,
        'sde':        sde,
        'coefficients': [
            {'symbol': s, 'name': n, 'value': round(v, 8)}
            for s, n, v in zip(syms, descs, [a, b, c, d])
        ] + [
            {'symbol': 'σ', 'name': 'Instantaneous volatility (annualised)', 'value': round(sigma, 6)},
        ],
        'derived': [
            {'symbol': 'μ*',  'name': 'Est. long-run mean',       'value': round(mu, 6),    'note': 'Nearest real root of f(x) = 0'},
            {'symbol': 'κ*',  'name': 'Linearised reversion speed','value': round(k, 6),     'note': "−f′(μ*), annualised"},
            {'symbol': 't½*', 'name': 'Half-life (approx)',        'value': f"{half_life:.1f} bdays", 'note': 'ln(2)/κ* × 252'},
            {'symbol': 'z',   'name': 'Current z-score',           'value': round(zscore, 3),'note': '(x − μ*) / (σ/√(2κ*))'},
        ],
        'estimation_method': 'PMLE — OLS on discretised drift',
        'estimation_detail': (
            'Minimises Σ (x_{t+1} − x_t − f(x_t)Δt)² by OLS, regressing '
            '(x_{t+1}−x_t)/Δt on the basis functions evaluated at x_t.  '
            'Equivalent to the PMLE objective under local normality '
            '(H&S §2.3 — valid for daily data).  '
            'σ is recovered from the OLS residual standard deviation: σ̂ = std(ε) × √(1/Δt).'
        ),
        'constraint_note': constraint_note,
    }

    return ou_params, model_info


# ── Stanton diagnostic ─────────────────────────────────────────────────────────

def stanton_diagnostic(
    series: pd.Series,
    n_buckets: int = 20,
    sim_sde: str | None = None,
) -> list[dict]:
    """
    Nonparametric drift and diffusion diagnostics (Stanton, 1997).

    Algorithm
    ---------
    1. Group observations into n_buckets equal-width buckets (2nd–98th percentile).
    2. For each bucket compute avg_change (drift proxy) and std_change (diffusion proxy).
    3. If sim_sde is one of 'linear_ou' | 'polynomial' | 'inverse_polynomial',
       estimate that model on the series, simulate a long stationary path, and
       return sim_avg_change / sim_std_change per bucket for overlay (Figure 2.12).
       - linear_ou           : exact AR(1) via lfilter
       - polynomial          : Euler-Maruyama,  f(x) = a + bx + cx² + dx³
       - inverse_polynomial  : Euler-Maruyama,  f(x) = a/x + bx + cx² + dx³
    """
    x = series.dropna().values.astype(float)
    dx = np.diff(x)
    xl = x[:-1]

    lo, hi = np.percentile(xl, 2), np.percentile(xl, 98)
    if lo >= hi:
        return []

    edges = np.linspace(lo, hi, n_buckets + 1)
    out = []
    for i in range(n_buckets):
        mask = (xl >= edges[i]) & (xl < edges[i + 1])
        if mask.sum() < 3:
            continue
        out.append({
            'midpoint':   float((edges[i] + edges[i + 1]) / 2),
            'avg_change': float(dx[mask].mean()),
            'std_change': float(dx[mask].std()),
            'n_obs':      int(mask.sum()),
        })

    # ── Simulated overlay ───────────────────────────────────────────────────────
    if sim_sde and out:
        ou_p, m_info = estimate_model(series, model_type=sim_sde)
        k     = float(ou_p['k'])
        mu    = float(ou_p['mu'])
        sigma = float(ou_p['sigma'])
        dt    = 1 / 252
        n_sim = max(200_000, len(x) * 200)
        rng   = np.random.default_rng(0)
        sig   = sigma   # diffusion used by the sparse-bucket fallback; poly models override below

        if sim_sde == 'linear_ou':
            # Exact AR(1) discretisation via lfilter
            from scipy.signal import lfilter
            exp_k    = np.exp(-k * dt)
            var_step = sigma ** 2 * (1 - np.exp(-2 * k * dt)) / (2 * k)
            std_step = float(np.sqrt(max(var_step, 1e-14)))
            u        = mu * (1 - exp_k) + rng.standard_normal(n_sim) * std_step
            zi       = np.array([exp_k * mu])
            sim, _   = lfilter([1.0], [1.0, -exp_k], u, zi=zi)
        else:
            # Euler-Maruyama for polynomial / inverse-polynomial drift
            coeffs = {c['symbol']: c['value'] for c in m_info['coefficients']}
            a_c = coeffs.get('a', 0.0)
            b_c = coeffs.get('b', 0.0)
            c_c = coeffs.get('c', 0.0)
            d_c = coeffs.get('d', 0.0)
            sig = coeffs.get('σ', sigma)
            sig_dt = sig * np.sqrt(dt)
            eps = rng.standard_normal(n_sim - 1) * sig_dt
            sim = np.empty(n_sim)
            sim[0] = mu
            if sim_sde == 'polynomial':
                for t in range(n_sim - 1):
                    xt = sim[t]
                    sim[t + 1] = xt + (a_c + b_c * xt + c_c * xt ** 2 + d_c * xt ** 3) * dt + eps[t]
            else:  # inverse_polynomial
                for t in range(n_sim - 1):
                    xt = sim[t]
                    drift = (a_c / xt + b_c * xt + c_c * xt ** 2 + d_c * xt ** 3) if abs(xt) > 1e-8 else 0.0
                    sim[t + 1] = xt + drift * dt + eps[t]

        sim_dx = np.diff(sim)
        sim_xl = sim[:-1]

        edge_idx = 0
        for row in out:
            mid = row['midpoint']
            while edge_idx < n_buckets and abs((edges[edge_idx] + edges[edge_idx + 1]) / 2 - mid) > 1e-10:
                edge_idx += 1
            if edge_idx >= n_buckets:
                break
            mask_s = (sim_xl >= edges[edge_idx]) & (sim_xl < edges[edge_idx + 1])
            if mask_s.sum() >= 3:
                row['sim_avg_change'] = float(sim_dx[mask_s].mean())
                row['sim_std_change'] = float(sim_dx[mask_s].std())
            else:
                row['sim_avg_change'] = float(k * (mu - mid) * dt)
                row['sim_std_change'] = float(sig * np.sqrt(dt))
            edge_idx += 1

    return out


# ── Transition densities ───────────────────────────────────────────────────────

_HORIZONS = [7, 14, 30, 60, 90, 180, 252]
_H_LABELS = {7: '1W', 14: '2W', 30: '1M', 60: '2M', 90: '3M', 180: '6M', 252: '1Y'}


def _add_horizon_dates(td_list: list[dict], last_date: pd.Timestamp) -> None:
    """Attach ISO horizon_date strings (last_date + N business days) in place."""
    for item in td_list:
        item['horizon_date'] = (
            last_date + pd.offsets.BDay(item['horizon_days'])
        ).strftime('%Y-%m-%d')


def transition_densities(ou: dict, n_days: int = 252) -> list[dict]:
    """
    Analytical OU transition density at every business day 1..n_days.

    Returns daily percentile bands (p5, p25, mean, p75, p95) for fan-chart
    rendering.  horizon_label is populated only for the 7 standard horizons
    (used by the probability table in the frontend).

    Conditional mean : mu + (x_now - mu) * exp(-k * tau)
    Conditional var  : sigma^2 * (1 - exp(-2k*tau)) / (2k)
    """
    k, mu, sigma, x_now = ou['k'], ou['mu'], ou['sigma'], ou['current']
    out = []
    for tau_d in range(1, n_days + 1):
        tau = tau_d / 252
        cm = mu + (x_now - mu) * np.exp(-k * tau)
        cv = sigma ** 2 * (1 - np.exp(-2 * k * tau)) / (2 * k)
        cs = float(np.sqrt(max(cv, 1e-14)))
        out.append({
            'horizon_days':        tau_d,
            'horizon_label':       _H_LABELS.get(tau_d, ''),
            'mean':                float(cm),
            'std':                 cs,
            'p5':                  float(sp_norm.ppf(0.05, cm, cs)),
            'p25':                 float(sp_norm.ppf(0.25, cm, cs)),
            'p75':                 float(sp_norm.ppf(0.75, cm, cs)),
            'p95':                 float(sp_norm.ppf(0.95, cm, cs)),
            'prob_above_current':  float(1 - sp_norm.cdf(x_now, cm, cs)),
        })
    return out


# ── Monte Carlo transition densities (for nonlinear SDEs) ─────────────────────

def _simulate_paths(
    fit_series: pd.Series,
    sim_sde: str,
    n_steps: int,
    n_sims: int = 10_000,
    x_now: float | None = None,
) -> tuple[np.ndarray, float]:
    """
    Shared MC engine: simulate n_sims Euler-Maruyama paths of n_steps business-day
    steps starting from x_now.  Returns (paths, x_now_used); paths has shape
    (n_sims, n_steps + 1) with paths[:, 0] == x_now.
    """
    ou_p, m_info = estimate_model(fit_series, model_type=sim_sde)
    k     = float(ou_p['k'])
    mu    = float(ou_p['mu'])
    sigma = float(ou_p['sigma'])
    if x_now is None:
        x_now = float(ou_p['current'])
    dt = 1 / 252

    x_arr   = fit_series.dropna().values.astype(float)
    obs_std = float(np.std(x_arr))
    clip_lo = mu - 20 * obs_std
    clip_hi = mu + 20 * obs_std

    rng   = np.random.default_rng(0)
    paths = np.empty((n_sims, n_steps + 1))
    paths[:, 0] = x_now

    if sim_sde == 'linear_ou':
        exp_k    = np.exp(-k * dt)
        var_step = sigma ** 2 * (1 - np.exp(-2 * k * dt)) / (2 * k)
        std_step = float(np.sqrt(max(var_step, 1e-14)))
        eps = rng.standard_normal((n_sims, n_steps)) * std_step
        for t in range(n_steps):
            paths[:, t + 1] = np.clip(
                mu + (paths[:, t] - mu) * exp_k + eps[:, t], clip_lo, clip_hi
            )
    else:
        coeffs    = {c['symbol']: c['value'] for c in m_info['coefficients']}
        a_c       = coeffs.get('a', 0.0)
        b_c       = coeffs.get('b', 0.0)
        c_c       = coeffs.get('c', 0.0)
        d_c       = coeffs.get('d', 0.0)
        sig       = coeffs.get('σ', sigma)
        sig_dt    = sig * np.sqrt(dt)
        eps       = rng.standard_normal((n_sims, n_steps)) * sig_dt
        # Cap drift so badly-constrained polynomial coefficients cannot cause
        # instant explosion — allow at most 10× diffusion magnitude per step.
        drift_cap = 10.0 * sig / np.sqrt(dt)

        if sim_sde == 'polynomial':
            for t in range(n_steps):
                xt    = paths[:, t]
                drift = np.clip(
                    a_c + b_c * xt + c_c * xt ** 2 + d_c * xt ** 3,
                    -drift_cap, drift_cap,
                )
                paths[:, t + 1] = np.clip(xt + drift * dt + eps[:, t], clip_lo, clip_hi)
        else:  # inverse_polynomial
            for t in range(n_steps):
                xt   = paths[:, t]
                safe = np.where(np.abs(xt) > 1e-6, xt, np.sign(xt + 1e-30) * 1e-6)
                drift = np.clip(
                    a_c / safe + b_c * xt + c_c * xt ** 2 + d_c * xt ** 3,
                    -drift_cap, drift_cap,
                )
                paths[:, t + 1] = np.clip(xt + drift * dt + eps[:, t], clip_lo, clip_hi)

    return paths, x_now


def transition_densities_mc(
    series: pd.Series,
    sim_sde: str,
    n_sims: int = 10_000,
    horizons: list[int] = _HORIZONS,
    x_now: float | None = None,
) -> list[dict]:
    """
    Monte Carlo forward distributions — daily snapshots for 1 year.
    Returns same field layout as transition_densities() for drop-in use.
    """
    n_steps = 252
    paths, x_now = _simulate_paths(series, sim_sde, n_steps, n_sims, x_now)

    out = []
    for tau_d in range(1, n_steps + 1):
        snap = paths[:, tau_d]
        snap = snap[np.isfinite(snap)]
        if len(snap) == 0:
            snap = np.array([x_now])
        out.append({
            'horizon_days':       tau_d,
            'horizon_label':      _H_LABELS.get(tau_d, ''),
            'mean':               float(np.mean(snap)),
            'std':                float(np.std(snap)),
            'p5':                 float(np.percentile(snap, 5)),
            'p25':                float(np.percentile(snap, 25)),
            'p75':                float(np.percentile(snap, 75)),
            'p95':                float(np.percentile(snap, 95)),
            'prob_above_current': float(np.mean(snap > x_now)),
        })
    return out


def forward_histogram(
    fit_series: pd.Series,
    sim_sde: str,
    horizon_days: int,
    n_sims: int = 10_000,
    n_bins: int = 60,
    n_grid: int = 300,
    x_now: float | None = None,
) -> dict:
    """
    Terminal distribution at a fixed horizon: histogram + KDE at 3 bandwidths.

    Returns a unified x-grid with density values so the frontend can render
    a ComposedChart with an Area (histogram step-function) and three Line
    overlays (narrow / Scott's / wide KDE) — cf. H&S Figures 2.13 and 2.14.
    """
    paths, x_now_used = _simulate_paths(
        fit_series, sim_sde, horizon_days, n_sims, x_now
    )
    snap = paths[:, horizon_days]
    snap = snap[np.isfinite(snap)]
    if len(snap) < 10:
        snap = np.full(100, x_now_used)

    # Density-normalised histogram
    hist_counts, edges = np.histogram(snap, bins=n_bins, density=True)

    # KDE at three bandwidths relative to Scott's rule
    kde_base   = gaussian_kde(snap)
    bw_factor  = float(kde_base.factor)
    kde_narrow = gaussian_kde(snap, bw_method=bw_factor * 0.5)
    kde_medium = gaussian_kde(snap, bw_method=bw_factor * 1.0)
    kde_wide   = gaussian_kde(snap, bw_method=bw_factor * 2.0)

    # Unified x grid slightly wider than the histogram range
    margin = 0.15 * (edges[-1] - edges[0])
    x_lo   = edges[0]  - margin
    x_hi   = edges[-1] + margin
    x_grid = np.linspace(x_lo, x_hi, n_grid)

    # Step-function histogram density on the grid (each grid point takes the
    # density of the bin it falls in; points outside the range get 0)
    bin_idx      = np.searchsorted(edges[1:], x_grid, side='left')
    bin_idx      = np.clip(bin_idx, 0, n_bins - 1)
    hist_on_grid = hist_counts[bin_idx]
    hist_on_grid[x_grid < edges[0]]  = 0.0
    hist_on_grid[x_grid > edges[-1]] = 0.0

    data = [
        {
            'x':      round(float(xi), 6),
            'hist':   round(float(hi), 6),
            'narrow': round(float(kde_narrow(xi)[0]), 6),
            'medium': round(float(kde_medium(xi)[0]), 6),
            'wide':   round(float(kde_wide(xi)[0]), 6),
        }
        for xi, hi in zip(x_grid, hist_on_grid)
    ]

    return {
        'horizon_days': horizon_days,
        'x_now':        float(x_now_used),
        'bw_scott':     round(bw_factor * float(np.std(snap)), 6),
        'data':         data,
        'stats': {
            'mean': float(np.mean(snap)),
            'std':  float(np.std(snap)),
            'p5':   float(np.percentile(snap, 5)),
            'p25':  float(np.percentile(snap, 25)),
            'p75':  float(np.percentile(snap, 75)),
            'p95':  float(np.percentile(snap, 95)),
        },
    }


# ── Sharpe profile ─────────────────────────────────────────────────────────────

def sharpe_profile_mc(
    fit_series: pd.Series,
    sim_sde: str,
    x_now: float | None = None,
    n_sims: int = 10_000,
) -> list[dict]:
    """
    Monte Carlo Sharpe profile for polynomial / inverse-polynomial SDEs.

    Simulates n_sims paths for 252 steps, then at each horizon τ_d computes:

        SR(τ_d) = |mean(x_{τ_d} − x_0)| / std(x_{τ_d} − x_0) × √(252 / τ_d)

    where the sign of the expected return is always taken in the convergence
    direction so SR ≥ 0.  Returns the same schema as sharpe_profile().
    """
    horizons = (
        list(range(1, 11))
        + list(range(12, 32, 3))
        + list(range(35, 91, 5))
        + [100, 120, 150, 180, 210, 252]
    )
    n_steps = max(horizons)
    paths, x_now_used = _simulate_paths(fit_series, sim_sde, n_steps, n_sims, x_now)

    out = []
    for tau_d in horizons:
        pnl = paths[:, tau_d] - x_now_used
        pnl = pnl[np.isfinite(pnl)]
        if len(pnl) < 10:
            continue
        exp_ret = float(np.mean(pnl))
        std_ret = float(np.std(pnl))
        if std_ret < 1e-14:
            continue
        sr = abs(exp_ret) / std_ret * np.sqrt(252 / tau_d)
        out.append({'horizon_days': tau_d, 'annualised_sharpe': float(sr)})
    return out


def sharpe_profile(ou: dict) -> list[dict]:
    """
    Annualised Sharpe ratio of the convergence trade at each holding horizon.

    SR(τ) = |E[x_{t+τ} - x_t]| / Std[x_{t+τ} - x_t] × sqrt(252 / τ_bdays)

    The expected return is always measured in the direction of convergence
    (i.e. we assume the analyst enters in the correct direction), so SR ≥ 0.

    Key insight from H&S: SR declines with horizon for OU because the
    return contribution from mean reversion shrinks faster than risk grows.
    """
    k, mu, sigma, x_now = ou['k'], ou['mu'], ou['sigma'], ou['current']

    # Dense grid: daily for first 10 days, then sparsening
    horizons = (
        list(range(1, 11))
        + list(range(12, 32, 3))
        + list(range(35, 91, 5))
        + [100, 120, 150, 180, 210, 252]
    )

    out = []
    for tau_d in horizons:
        tau = tau_d / 252
        exp_ret = abs(mu - x_now) * (1 - np.exp(-k * tau))   # always ≥ 0
        cv = sigma ** 2 * (1 - np.exp(-2 * k * tau)) / (2 * k)
        cs = float(np.sqrt(max(cv, 1e-14)))
        if cs < 1e-14:
            continue
        sr = (exp_ret / cs) * np.sqrt(252 / tau_d)
        out.append({'horizon_days': tau_d, 'annualised_sharpe': float(sr)})
    return out


# ── First passage times ────────────────────────────────────────────────────────

def first_passage_times(
    ou: dict,
    target: float,
    stop: Optional[float] = None,
    n_sims: int = 5_000,
    max_days: int = 365,
) -> dict:
    """
    Monte Carlo first passage time (FPT) analysis.

    Simulates n_sims daily OU paths from x_now and records:
    - hitting time to target  (in the direction of mean reversion)
    - hitting time to stop    (away from mean reversion direction)

    Returns probability of hitting within 5 / 10 / 20 / 30 / 50 business days,
    plus histogram data for density rendering.
    """
    k, mu, sigma, x_now = ou['k'], ou['mu'], ou['sigma'], ou['current']
    dt = 1 / 252

    rng = np.random.default_rng(0)
    exp_k = np.exp(-k * dt)
    std_step = sigma * np.sqrt((1 - np.exp(-2 * k * dt)) / (2 * k))

    # Simulate all paths at once (vectorised over simulations)
    eps = rng.standard_normal((n_sims, max_days))
    paths = np.empty((n_sims, max_days + 1))
    paths[:, 0] = x_now
    for t in range(max_days):
        paths[:, t + 1] = mu + (paths[:, t] - mu) * exp_k + std_step * eps[:, t]

    def _stats(boundary: float, going_down: bool) -> dict:
        """Compute hitting-time statistics for a single boundary."""
        check = paths[:, 1:]                                        # skip t=0
        crossed = (check <= boundary) if going_down else (check >= boundary)
        any_hit = crossed.any(axis=1)
        # argmax returns first True index (0-indexed from step 1 → add 1 for days)
        first_idx = np.where(any_hit, np.argmax(crossed, axis=1) + 1, -1)
        hit_days = first_idx[any_hit].astype(float)
        total = n_sims

        if len(hit_days) == 0:
            return {
                'histogram': [], 'hit_days_raw': [], 'kde': [], 'total': total,
                'prob_5d': 0., 'prob_10d': 0., 'prob_20d': 0.,
                'prob_30d': 0., 'prob_50d': 0.,
                'mean_days': None, 'median_days': None, 'pct_hit': 0.,
            }

        # Default histogram (auto binning) kept for backward compatibility
        n_bins = min(50, max(5, len(set(hit_days.astype(int)))))
        hist, edges = np.histogram(hit_days, bins=n_bins, range=(1, max_days))
        bin_width_auto = float(edges[1] - edges[0])
        histogram = [
            {
                'days':    float((edges[i] + edges[i + 1]) / 2),
                'density': float(hist[i] / (total * bin_width_auto)),
            }
            for i in range(len(hist)) if hist[i] > 0
        ]

        # KDE on a daily grid 1..max_days (Scott's rule). A KDE needs spread:
        # when every path hits on the same day (e.g. the level is already at or
        # through the target) the covariance is singular, so return no curve.
        if len(hit_days) >= 2 and np.ptp(hit_days) > 0:
            kde_est  = gaussian_kde(hit_days)
            x_grid   = np.arange(1, max_days + 1, dtype=float)
            kde_vals = kde_est(x_grid)
            kde_data = [{'days': int(d), 'density': round(float(v), 8)}
                        for d, v in zip(x_grid, kde_vals)]
        else:
            kde_data = []

        return {
            'histogram':    histogram,
            'hit_days_raw': hit_days.astype(int).tolist(),   # raw for frontend rebinning
            'kde':          kde_data,
            'total':        int(total),
            'prob_5d':      float((hit_days <= 5).sum()  / total * 100),
            'prob_10d':     float((hit_days <= 10).sum() / total * 100),
            'prob_20d':     float((hit_days <= 20).sum() / total * 100),
            'prob_30d':     float((hit_days <= 30).sum() / total * 100),
            'prob_50d':     float((hit_days <= 50).sum() / total * 100),
            'mean_days':    float(hit_days.mean()),
            'median_days':  float(np.median(hit_days)),
            'pct_hit':      float(len(hit_days) / total * 100),
        }

    going_down = target < x_now
    result = {'to_target': _stats(target, going_down)}
    if stop is not None:
        result['to_stop'] = _stats(stop, not going_down)
    return result


# ── Main entry point ───────────────────────────────────────────────────────────

def analyse(
    expression: str,
    start_date: str = '2018-01-01',
    end_date: Optional[str] = None,
    fit_start: Optional[str] = None,
    fit_end: Optional[str] = None,
    model_type: str = 'linear_ou',
    target: Optional[float] = None,
    stop: Optional[float] = None,
    n_sims: int = 5_000,
) -> dict:
    """
    Full mean reversion analysis for a Bloomberg ticker expression.

    Parameters
    ----------
    expression  : weighted sum of BBG tickers, e.g. "USGG10YR Index - USGG2YR Index"
    start_date  : history start for display (YYYY-MM-DD)
    end_date    : history end for display (defaults to today)
    fit_start   : start of estimation window (defaults to start_date)
    fit_end     : end of estimation window (defaults to end_date)
    model_type  : 'linear_ou' | 'polynomial' | 'inverse_polynomial'
    target      : FPT target level (defaults to half-way to mu)
    stop        : FPT stop level   (defaults to 2 × stationary_std away from current)
    n_sims      : number of Monte Carlo paths for FPT

    Returns
    -------
    Full analysis dict consumed by the MeanReversion frontend page.
    """
    if end_date is None:
        end_date = pd.Timestamp.today().strftime('%Y-%m-%d')

    terms = parse_expression(expression)
    series, sim_mode = build_series(terms, start_date, end_date)

    if len(series) < 30:
        raise ValueError(
            f'Insufficient data: only {len(series)} observations after alignment. '
            'Try a later start date or check that all tickers are valid.'
        )

    # Subset to the fit window for parameter estimation
    fit_series = series.loc[
        (fit_start if fit_start else series.index[0].strftime('%Y-%m-%d')):
        (fit_end   if fit_end   else series.index[-1].strftime('%Y-%m-%d'))
    ]
    if len(fit_series) < 30:
        raise ValueError(
            f'Insufficient data in fit window: only {len(fit_series)} observations. '
            'Widen the fit window.'
        )

    ou, model_info = estimate_model(fit_series, model_type)
    # Use the last observation of the *full* series as x_now — the fit window
    # may end before today, and the fan chart must start from the last visible point.
    x_now = float(series.dropna().iloc[-1])
    ou['current'] = x_now
    ou['current_zscore'] = (
        (x_now - ou['mu']) / ou['stationary_std']
        if ou['stationary_std'] > 1e-14 else 0.0
    )
    mu = ou['mu']
    stat_std = ou['stationary_std']
    direction = 1.0 if mu > x_now else -1.0   # expected direction of move

    sug_target = (
        target if target is not None
        else x_now + direction * 0.5 * abs(mu - x_now)
    )
    sug_stop = (
        stop if stop is not None
        else x_now - direction * 2.0 * stat_std
    )

    fpt = first_passage_times(ou, float(sug_target), float(sug_stop), n_sims)

    # ── Drift scatter (Figure 8 equivalent) ───────────────────────────────────
    fit_x   = fit_series.values.astype(float)
    sc_dev  = fit_x[:-1] - ou['mu']   # x_t − μ
    sc_dx   = np.diff(fit_x)           # Δx_t = x_{t+1} − x_t

    # OLS: Δx = a + b·(x − μ)  (b ≈ −κ·Δt under OU)
    cov_mat      = np.cov(sc_dev, sc_dx)
    b_slope      = float(cov_mat[0, 1] / cov_mat[0, 0]) if cov_mat[0, 0] > 0 else 0.0
    b_intercept  = float(np.mean(sc_dx) - b_slope * np.mean(sc_dev))
    ss_tot       = float(np.sum((sc_dx - sc_dx.mean()) ** 2))
    ss_res       = float(np.sum((sc_dx - (b_intercept + b_slope * sc_dev)) ** 2))
    r2           = float(1 - ss_res / ss_tot) if ss_tot > 1e-20 else 0.0

    # Subsample to ≤ 800 points for display
    n_sc = len(sc_dev)
    if n_sc > 800:
        rng_sc  = np.random.default_rng(42)
        idx_sc  = np.sort(rng_sc.choice(n_sc, 800, replace=False))
        sc_dev_out = sc_dev[idx_sc]
        sc_dx_out  = sc_dx[idx_sc]
    else:
        sc_dev_out = sc_dev
        sc_dx_out  = sc_dx

    drift_scatter = {
        'points':            [{'dev': round(float(d), 6), 'dx': round(float(dy), 6)}
                              for d, dy in zip(sc_dev_out, sc_dx_out)],
        'slope':             round(b_slope, 8),
        'intercept':         round(b_intercept, 8),
        'r2':                round(r2, 6),
        'theoretical_slope': round(-ou['k'] / 252, 8),   # −κ·Δt
    }

    # Return the full series so the chart matches the chosen history start date
    series_out = series

    return {
        'expression':    expression,
        'terms':         [{'weight': w, 'ticker': t} for w, t in terms],
        'simulation_mode': sim_mode,
        'model_type':    model_type,
        'fit_start':     fit_series.index[0].strftime('%Y-%m-%d'),
        'fit_end':       fit_series.index[-1].strftime('%Y-%m-%d'),
        'series': {
            'dates':  series_out.index.strftime('%Y-%m-%d').tolist(),
            'values': [round(float(v), 6) for v in series_out],
        },
        'ou_params':            ou,
        'model_info':           model_info,
        'stanton':              stanton_diagnostic(fit_series),
        'transition_densities': _add_horizon_dates(
                                    td := transition_densities(ou),
                                    series.index[-1],
                                ) or td,
        'sharpe_profile':       sharpe_profile(ou),
        'fpt':                  fpt,
        'drift_scatter':        drift_scatter,
        'suggested_target':     float(sug_target),
        'suggested_stop':       float(sug_stop),
    }
