"""
Mixed-frequency Dynamic Factor Model — Kalman filter/smoother.

State space form (daily frequency):

  Transition:   f_t = A f_{t-1} + η_t,   η_t ~ N(0, Q)
  Observation:  y_t = Λ f_t  + ε_t,      ε_t ~ N(0, R)

Missing observations (NaN) are handled natively — the update step is
skipped for missing rows, so monthly series are simply observed on their
release day and unobserved (NaN) on all other days.

Block structure
---------------
Block 1 — macro indicators (monthly):
  Observed on the last business day of each month.
  Between releases: NaN → Kalman propagates on transition alone.

Block 2 — yield PCs (daily, separate pipeline):
  NOT included here. Yields are explained by the factors as a downstream
  step, avoiding the circularity of using yields to identify factors that
  are then used to predict yields.
"""

from __future__ import annotations

import numpy as np
from typing import Optional


# ---------------------------------------------------------------------------
# Forward filter
# ---------------------------------------------------------------------------

def kalman_filter(
    Y: np.ndarray,                    # [T, M]  observations, NaN = missing
    Lambda: np.ndarray,               # [M, K]  loadings
    A: np.ndarray,                    # [K, K]  transition
    Q: np.ndarray,                    # [K, K]  state noise covariance
    R: np.ndarray,                    # [M, M]  observation noise covariance
    f0: Optional[np.ndarray] = None,  # [K]     initial state mean
    P0: Optional[np.ndarray] = None,  # [K, K]  initial state covariance
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, float]:
    """
    Forward Kalman filter with missing-observation handling.

    Returns
    -------
    f_filt  : [T, K]    filtered state means
    P_filt  : [T, K, K] filtered state covariances
    f_pred  : [T, K]    predicted state means  (needed by smoother)
    P_pred  : [T, K, K] predicted state covariances
    loglik  : float     Gaussian log-likelihood
    """
    T, M = Y.shape
    K = A.shape[0]

    f = np.zeros(K) if f0 is None else f0.copy()
    P = np.eye(K) * 10.0 if P0 is None else P0.copy()

    f_filt = np.zeros((T, K))
    P_filt = np.zeros((T, K, K))
    f_pred = np.zeros((T, K))
    P_pred = np.zeros((T, K, K))
    loglik = 0.0

    for t in range(T):
        # ── Prediction ────────────────────────────────────────────────────
        f_p = A @ f
        P_p = A @ P @ A.T + Q
        f_pred[t] = f_p
        P_pred[t] = P_p

        # ── Update (skip entirely if all observations missing) ─────────────
        obs = ~np.isnan(Y[t])
        if obs.any():
            Lam = Lambda[obs]                       # [M_obs, K]
            R_o = R[np.ix_(obs, obs)]               # [M_obs, M_obs]
            y   = Y[t, obs]                         # [M_obs]

            innov = y - Lam @ f_p                   # [M_obs]
            S     = Lam @ P_p @ Lam.T + R_o         # [M_obs, M_obs]

            try:
                S_inv = np.linalg.inv(S)
            except np.linalg.LinAlgError:
                S_inv = np.linalg.pinv(S)

            K_gain = P_p @ Lam.T @ S_inv            # [K, M_obs]
            f = f_p + K_gain @ innov
            P = (np.eye(K) - K_gain @ Lam) @ P_p

            # Log-likelihood contribution
            sign, logdet = np.linalg.slogdet(S)
            if sign > 0:
                loglik -= 0.5 * (
                    obs.sum() * np.log(2 * np.pi)
                    + logdet
                    + float(innov @ S_inv @ innov)
                )
        else:
            f = f_p
            P = P_p

        f_filt[t] = f
        P_filt[t] = P

    return f_filt, P_filt, f_pred, P_pred, loglik


# ---------------------------------------------------------------------------
# RTS backward smoother
# ---------------------------------------------------------------------------

def kalman_smoother(
    f_filt: np.ndarray,   # [T, K]
    P_filt: np.ndarray,   # [T, K, K]
    f_pred: np.ndarray,   # [T, K]
    P_pred: np.ndarray,   # [T, K, K]
    A:      np.ndarray,   # [K, K]
) -> tuple[np.ndarray, np.ndarray]:
    """
    Rauch-Tung-Striebel (RTS) backward smoother.

    Returns
    -------
    f_smooth : [T, K]    smoothed state means
    P_smooth : [T, K, K] smoothed state covariances
    """
    T, K = f_filt.shape
    f_smooth = np.zeros((T, K))
    P_smooth = np.zeros((T, K, K))

    f_smooth[-1] = f_filt[-1]
    P_smooth[-1] = P_filt[-1]

    for t in range(T - 2, -1, -1):
        try:
            P_pred_inv = np.linalg.inv(P_pred[t + 1])
        except np.linalg.LinAlgError:
            P_pred_inv = np.linalg.pinv(P_pred[t + 1])

        G = P_filt[t] @ A.T @ P_pred_inv                              # smoother gain
        f_smooth[t] = f_filt[t] + G @ (f_smooth[t + 1] - f_pred[t + 1])
        P_smooth[t] = P_filt[t] + G @ (P_smooth[t + 1] - P_pred[t + 1]) @ G.T

    return f_smooth, P_smooth


# ---------------------------------------------------------------------------
# Parameter estimation helpers
# ---------------------------------------------------------------------------

def estimate_ar1_daily(monthly_factors: np.ndarray) -> np.ndarray:
    """
    Estimate per-factor AR(1) coefficient from monthly observations.
    Returns AR coefficients, one per factor. [K]
    """
    K = monthly_factors.shape[1]
    ar = np.zeros(K)
    for k in range(K):
        x = monthly_factors[:, k]
        ar[k] = np.dot(x[:-1], x[1:]) / np.dot(x[:-1], x[:-1])
        ar[k] = np.clip(ar[k], 0.5, 0.999)
    return ar


def estimate_loadings_ols(
    factors: np.ndarray,      # [T, K]
    observations: np.ndarray, # [T, M]
) -> np.ndarray:
    """
    OLS estimate of loadings: obs = factors @ Lambda.T + noise.
    Returns Lambda [M, K].
    """
    FtF_inv = np.linalg.inv(factors.T @ factors)
    Lambda = (FtF_inv @ factors.T @ observations).T
    return Lambda
