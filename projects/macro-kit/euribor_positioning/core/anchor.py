"""
Stage 7 — Kalman anchoring to COT (§8.1–§8.4).

Combines daily OI-price flow (high frequency, level-ambiguous) with weekly
COT net positions (low frequency, directly observed) via a Kalman filter.

State equation (daily, every business day t):
    x(t) = λ · x(t-1) + β · f(t) + η(t),    η(t) ~ N(0, Q)

Measurement equation (Fridays only — publication_date of COT):
    z(t) = x(t) + ε(t),    ε(t) ~ N(0, R)

Timing discipline (§8.3):
    COT measurement update enters on publication_date (Friday), NOT report_date (Tuesday).
    Getting this wrong produces a 3-day look-ahead.

MLE parameter estimation:
    Estimate θ = (λ, β, Q, R) by maximising the innovation log-likelihood over
    observation Fridays. Transforms: λ = sigmoid(θ_λ), β = exp(θ_β),
    Q = exp(θ_Q), R = exp(θ_R).
"""

from __future__ import annotations

import math
from datetime import date
from typing import Optional

import numpy as np
import pandas as pd
from scipy.optimize import minimize

from .spreads import spread_adjusted_quadrant_signal

# COT categories recognised in cot_obs
COT_CATEGORIES = ["investment_firms", "commercial", "other_financial", "other"]


# ---------------------------------------------------------------------------
# Pure math helpers
# ---------------------------------------------------------------------------

def _sigmoid(x: float) -> float:
    """Numerically-stable sigmoid: output in (0, 1)."""
    if x >= 0:
        return 1.0 / (1.0 + math.exp(-x))
    ex = math.exp(x)
    return ex / (1.0 + ex)


def _logit(p: float, eps: float = 1e-6) -> float:
    """Inverse sigmoid (logit). Clamps p away from 0/1."""
    p = max(eps, min(1.0 - eps, p))
    return math.log(p / (1.0 - p))


# ---------------------------------------------------------------------------
# Core Kalman filter (pure Python loop — sequential by design)
# ---------------------------------------------------------------------------

def run_kalman_filter(
    dates: list[date],
    flow_series: pd.Series,
    cot_series: pd.Series,
    params: dict,
    lam: Optional[float] = None,
    beta: Optional[float] = None,
    Q: Optional[float] = None,
    R: Optional[float] = None,
) -> pd.DataFrame:
    """
    Run the Kalman filter over [dates[0], dates[-1]].

    Args:
        dates       : list of trade_dates (business days), sorted ascending
        flow_series : index=trade_date, values=f_t (daily flow signal)
        cot_series  : index=publication_date (Fridays), values=net position z_t
        params      : full params dict (uses params["kalman"])
        lam, beta, Q, R : filter parameters; if None, uses MLE-estimated values

    Returns DataFrame indexed by trade_date with columns:
        f_t, z_t (NaN on non-observation days),
        x_pred, P_pred,
        x_est, P_est,
        innovation (NaN on non-obs days),
        S (innovation variance, NaN on non-obs days),
        K (Kalman gain, NaN on non-obs days),
        is_observation_day (bool),
    """
    kp = params.get("kalman", {})

    # Defaults from params if not provided
    if lam is None:
        lam = float(kp.get("lambda_init", 0.95))
    if beta is None:
        beta = float(kp.get("beta_init", 1.0))
    if Q is None:
        Q = float(kp.get("q_init", 1e4))
    if R is None:
        R = float(kp.get("r_init", 1e5))

    init_var = float(kp.get("init_variance", 1e8))

    # Reindex flow series to the full date list, fill gaps with 0.0
    flow_s = flow_series.reindex(dates, fill_value=0.0)

    # Build lookup: trade_date → z_t for observation Fridays
    # cot_series is indexed by publication_date
    cot_lookup: dict[date, float] = {}
    for pub_d, z_val in cot_series.items():
        if isinstance(pub_d, pd.Timestamp):
            pub_d = pub_d.date()
        if not pd.isna(z_val):
            cot_lookup[pub_d] = float(z_val)

    # Initialise state
    # x0 = first available COT observation; P0 = init_variance
    obs_dates_sorted = sorted(cot_lookup.keys())
    if obs_dates_sorted:
        x_prev = float(cot_lookup[obs_dates_sorted[0]])
    else:
        x_prev = 0.0
    P_prev = init_var

    records = []

    for t in dates:
        f_t = float(flow_s.get(t, 0.0))
        if pd.isna(f_t):
            f_t = 0.0

        # --- Predict ---
        x_pred = lam * x_prev + beta * f_t
        P_pred = lam * lam * P_prev + Q

        # Is there a COT observation published on this trade_date?
        z_t = cot_lookup.get(t)
        is_obs = z_t is not None

        if is_obs:
            # --- Update ---
            innovation = z_t - x_pred
            S = P_pred + R
            S = max(S, 1e-10)  # guard against degenerate solutions
            K = P_pred / S
            x_est = x_pred + K * innovation
            P_est = (1.0 - K) * P_pred
        else:
            innovation = float("nan")
            S = float("nan")
            K = float("nan")
            x_est = x_pred
            P_est = P_pred

        records.append({
            "f_t":               f_t,
            "z_t":               z_t if is_obs else float("nan"),
            "x_pred":            x_pred,
            "P_pred":            P_pred,
            "x_est":             x_est,
            "P_est":             P_est,
            "innovation":        innovation,
            "S":                 S,
            "K":                 K,
            "is_observation_day": is_obs,
        })

        x_prev = x_est
        P_prev = P_est

    df = pd.DataFrame(records, index=dates)
    df.index.name = "trade_date"
    return df


# ---------------------------------------------------------------------------
# MLE parameter estimation
# ---------------------------------------------------------------------------

def _neg_log_likelihood(
    theta: np.ndarray,
    dates: list[date],
    flow_series: pd.Series,
    cot_series: pd.Series,
    params: dict,
) -> float:
    """
    Negative log-likelihood for Kalman filter innovations.
    theta = [theta_lambda, theta_beta, theta_Q, theta_R]
    Uses reparametrisation for positivity/range constraints.
    """
    theta_lam, theta_beta, theta_Q_raw, theta_R_raw = theta

    lam  = _sigmoid(theta_lam)
    beta = math.exp(theta_beta)
    Q    = max(math.exp(theta_Q_raw), 1.0)
    R    = max(math.exp(theta_R_raw), 1.0)

    kp = params.get("kalman", {})
    init_var = float(kp.get("init_variance", 1e8))

    flow_s = flow_series.reindex(dates, fill_value=0.0)

    cot_lookup: dict[date, float] = {}
    for pub_d, z_val in cot_series.items():
        if isinstance(pub_d, pd.Timestamp):
            pub_d = pub_d.date()
        if not pd.isna(z_val):
            cot_lookup[pub_d] = float(z_val)

    obs_dates_sorted = sorted(cot_lookup.keys())
    if obs_dates_sorted:
        x_prev = float(cot_lookup[obs_dates_sorted[0]])
    else:
        x_prev = 0.0
    P_prev = init_var

    nll = 0.0
    two_pi = 2.0 * math.pi

    for t in dates:
        f_t = float(flow_s.get(t, 0.0))
        if pd.isna(f_t):
            f_t = 0.0

        x_pred = lam * x_prev + beta * f_t
        P_pred = lam * lam * P_prev + Q

        z_t = cot_lookup.get(t)
        if z_t is not None:
            innovation = z_t - x_pred
            S = P_pred + R
            S = max(S, 1e-10)
            K = P_pred / S
            x_est = x_pred + K * innovation
            P_est = (1.0 - K) * P_pred
            # Innovation log-likelihood contribution
            nll += 0.5 * (math.log(two_pi * S) + innovation * innovation / S)
        else:
            x_est = x_pred
            P_est = P_pred

        x_prev = x_est
        P_prev = P_est

    return nll


def estimate_parameters(
    dates: list[date],
    flow_series: pd.Series,
    cot_series: pd.Series,
    params: dict,
) -> dict:
    """
    Estimate λ, β, Q, R by maximum likelihood.

    Returns:
        {"lambda": float, "beta": float, "Q": float, "R": float,
         "log_likelihood": float, "n_obs": int, "converged": bool}
    """
    kp = params.get("kalman", {})
    lam_init  = float(kp.get("lambda_init", 0.95))
    beta_init = float(kp.get("beta_init", 1.0))
    q_init    = float(kp.get("q_init", 1e4))
    r_init    = float(kp.get("r_init", 1e5))
    max_iter  = int(kp.get("max_iter", 500))

    # Initial values in unconstrained space
    theta0 = np.array([
        _logit(lam_init),
        math.log(max(beta_init, 1e-8)),
        math.log(max(q_init, 1.0)),
        math.log(max(r_init, 1.0)),
    ])

    # Count observations (Fridays with COT data within the date range)
    dates_set = set(dates)
    n_obs = 0
    for pub_d in cot_series.index:
        if isinstance(pub_d, pd.Timestamp):
            pub_d = pub_d.date()
        if pub_d in dates_set and not pd.isna(cot_series.loc[pub_d] if hasattr(cot_series, "loc") else cot_series[pub_d]):
            n_obs += 1

    result = minimize(
        _neg_log_likelihood,
        theta0,
        args=(dates, flow_series, cot_series, params),
        method="L-BFGS-B",
        options={"maxiter": max_iter, "ftol": 1e-10, "gtol": 1e-6},
    )

    theta_opt = result.x
    lam_opt  = _sigmoid(theta_opt[0])
    beta_opt = math.exp(theta_opt[1])
    Q_opt    = max(math.exp(theta_opt[2]), 1.0)
    R_opt    = max(math.exp(theta_opt[3]), 1.0)

    return {
        "lambda":          lam_opt,
        "beta":            beta_opt,
        "Q":               Q_opt,
        "R":               R_opt,
        "log_likelihood":  -float(result.fun),
        "n_obs":           n_obs,
        "converged":       bool(result.success),
    }


# ---------------------------------------------------------------------------
# R² computation
# ---------------------------------------------------------------------------

def compute_r2(
    filter_df: pd.DataFrame,
    cot_series: pd.Series,
) -> float:
    """
    Compute R² between x_est and z on observation Fridays.

    R² = 1 - SS_res / SS_tot
    where:
        residuals = z(t) - x_est(t)  for all Fridays with COT data
        SS_res = sum(residuals²)
        SS_tot = sum((z(t) - mean(z))²)
    """
    obs_mask = filter_df["is_observation_day"]
    if not obs_mask.any():
        return float("nan")

    obs_df = filter_df[obs_mask]
    z_vals = obs_df["z_t"].dropna()
    x_vals = obs_df["x_est"].reindex(z_vals.index)

    if len(z_vals) < 2:
        return float("nan")

    residuals = z_vals - x_vals
    ss_res = float((residuals ** 2).sum())
    ss_tot = float(((z_vals - z_vals.mean()) ** 2).sum())

    if ss_tot == 0.0:
        return 1.0 if ss_res == 0.0 else 0.0

    return float(1.0 - ss_res / ss_tot)


# ---------------------------------------------------------------------------
# COT net position helper
# ---------------------------------------------------------------------------

def _fetch_cot_series(conn, category: str) -> pd.Series:
    """
    Fetch COT net position (long - short) for a category, indexed by publication_date.
    Returns pd.Series with date index.
    """
    rows = conn.execute(
        """
        SELECT publication_date, long_positions, short_positions
        FROM cot_obs
        WHERE category = ?
        ORDER BY publication_date
        """,
        (category,),
    ).fetchall()

    if not rows:
        return pd.Series(dtype=float)

    records = [(date.fromisoformat(r["publication_date"]), int(r["long_positions"]) - int(r["short_positions"])) for r in rows]
    pub_dates, net_pos = zip(*records)
    return pd.Series(net_pos, index=list(pub_dates), dtype=float)


# ---------------------------------------------------------------------------
# Full anchoring pipeline
# ---------------------------------------------------------------------------

def build_anchor(
    conn,
    start_date: date,
    end_date: date,
    as_of_date: date,
    params: dict,
    category: str = "investment_firms",
    instrument_roots: list[str] | None = None,
) -> dict:
    """
    Full anchoring pipeline for one COT category.

    Steps:
    1. Get daily aggregate flow from spread_adjusted_quadrant_signal() —
       sum flow_quadrant across non-draining contracts
    2. Get COT net position (long - short) for the category, indexed by publication_date
    3. Estimate parameters by MLE
    4. Run Kalman filter with estimated parameters
    5. Compute R²

    Returns {
        "filter_df": pd.DataFrame,    # full filter output
        "params_fitted": dict,         # λ, β, Q, R, log_likelihood
        "r2": float,
        "category": str,
        "start_date": date,
        "end_date": date,
    }
    """
    # Step 1: Daily aggregate flow (sum flow_quadrant across non-draining contracts)
    adj_df, _curve_df = spread_adjusted_quadrant_signal(
        conn, start_date, end_date, as_of_date, params, instrument_roots=instrument_roots
    )

    if adj_df.empty:
        raise ValueError(
            f"spread_adjusted_quadrant_signal returned empty DataFrame for "
            f"{start_date} – {end_date}"
        )

    # Aggregate: sum flow_quadrant across all non-draining contracts per trade_date
    adj_reset = adj_df.reset_index()
    non_draining = adj_reset[~adj_reset["is_draining"]]
    daily_flow = non_draining.groupby("trade_date")["flow_quadrant"].sum()
    daily_flow = daily_flow.sort_index()

    # Build the list of business days
    dates = sorted(daily_flow.index.tolist())

    # Step 2: COT net positions indexed by publication_date
    cot_series = _fetch_cot_series(conn, category)

    if cot_series.empty:
        raise ValueError(f"No COT data found for category={category!r}")

    # Restrict COT series to the date range (with some tolerance for boundary)
    cot_series = cot_series[
        (cot_series.index >= start_date) & (cot_series.index <= end_date)
    ]

    if cot_series.empty:
        raise ValueError(
            f"No COT data in range {start_date} – {end_date} for category={category!r}"
        )

    # Step 3: Estimate parameters by MLE
    params_fitted = estimate_parameters(dates, daily_flow, cot_series, params)

    # Step 4: Run Kalman filter
    filter_df = run_kalman_filter(
        dates=dates,
        flow_series=daily_flow,
        cot_series=cot_series,
        params=params,
        lam=params_fitted["lambda"],
        beta=params_fitted["beta"],
        Q=params_fitted["Q"],
        R=params_fitted["R"],
    )

    # Step 5: Compute R²
    r2 = compute_r2(filter_df, cot_series)

    return {
        "filter_df":     filter_df,
        "params_fitted": params_fitted,
        "r2":            r2,
        "category":      category,
        "start_date":    start_date,
        "end_date":      end_date,
    }


def build_anchor_all_categories(
    conn,
    start_date: date,
    end_date: date,
    as_of_date: date,
    params: dict,
    instrument_roots: list[str] | None = None,
) -> dict[str, dict]:
    """
    Run build_anchor() for each COT category.
    Returns dict keyed by category name.
    Primary output is ["investment_firms"].
    """
    results: dict[str, dict] = {}
    for category in COT_CATEGORIES:
        try:
            results[category] = build_anchor(
                conn, start_date, end_date, as_of_date, params, category=category,
                instrument_roots=instrument_roots,
            )
        except Exception as exc:
            # Store error result so one failure doesn't block others
            results[category] = {
                "filter_df":     pd.DataFrame(),
                "params_fitted": {},
                "r2":            float("nan"),
                "category":      category,
                "start_date":    start_date,
                "end_date":      end_date,
                "error":         str(exc),
            }
    return results
