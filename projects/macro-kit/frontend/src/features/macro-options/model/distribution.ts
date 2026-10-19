// ─── Methodology ──────────────────────────────────────────────────────────────
//
// Risk-neutral distribution of the underlying futures price at option expiry,
// extracted from call prices on an evenly spaced strike grid (Breeden–Litzenberger),
// with the grid spacing h chosen by the user:
//
//   PDF(K)  ≈ [C(K−h) − 2·C(K) + C(K+h)] / h²        (butterfly / h²)
//   CDF(K)  ≈ 1 + [C(K+h) − C(K−h)] / (2h)           (call spread / h)
//
// ICE Euribor options are premium-margined (futures-style), so no discounting.
// A wider h smooths noise in quoted prices but blurs the shape; a narrower h
// resolves more detail but amplifies price errors (watch for negative density).
//
// Live chains are listed every 6.25 bp at best, so the backend fits a smile to the
// quotes and prices calls on a 1.25 bp grid (every width here is a multiple of it);
// the simulated chain prices any strike directly.

import type { Chain, DistPoint, DistResult } from './types'

export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const d = 0.39894228 * Math.exp(-0.5 * x * x)
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return x >= 0 ? 1 - p : p
}

export function normPdf(x: number): number { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI) }

export function bachelierCall(F: number, K: number, T: number, vol: number): number {
  if (T <= 0 || vol <= 0) return Math.max(F - K, 0)
  const w = vol * Math.sqrt(T)
  const d = (F - K) / w
  return (F - K) * normCdf(d) + w * Math.exp(-0.5 * d * d) / Math.sqrt(2 * Math.PI)
}

function quantile(points: DistPoint[], p: number): number {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i]
    if (a.cdf <= p && b.cdf >= p) {
      const w = b.cdf > a.cdf ? (p - a.cdf) / (b.cdf - a.cdf) : 0
      return a.strike + w * (b.strike - a.strike)
    }
  }
  return p < 0.5 ? points[0].strike : points[points.length - 1].strike
}

// Below this a density value is rounding noise (live call prices come with 10 decimals)
const NEG_TOL = 1e-5

export function extractDistribution(chain: Chain, h: number): DistResult {
  const { F, atmVol, T } = chain
  const half = Math.max(0.25, 6 * atmVol * Math.sqrt(T))           // ±6σ covers the tails
  const lo   = Math.floor((F - half) / h) * h
  const n    = Math.ceil((2 * half) / h) + 2
  const strikes = Array.from({ length: n + 1 }, (_, i) => +(lo + i * h).toFixed(6))
  const calls = strikes.map(K => chain.call(K))

  const points: DistPoint[] = []
  for (let i = 1; i < strikes.length - 1; i++) {
    const K = strikes[i]
    points.push({
      strike: K,
      rate: 100 - K,
      pdf: (calls[i - 1] - 2 * calls[i] + calls[i + 1]) / (h * h),
      cdf: Math.min(1, Math.max(0, 1 + (calls[i + 1] - calls[i - 1]) / (2 * h))),
    })
  }

  const mass = points.reduce((a, p) => a + p.pdf, 0) * h
  const mean = points.reduce((a, p) => a + p.strike * p.pdf, 0) * h / mass
  const m2   = points.reduce((a, p) => a + (p.strike - mean) ** 2 * p.pdf, 0) * h / mass
  const m3   = points.reduce((a, p) => a + (p.strike - mean) ** 3 * p.pdf, 0) * h / mass
  const std  = Math.sqrt(m2)

  return {
    F, atmVol, T, h, points,
    stats: {
      mass, mean, std,
      skew: std > 0 ? m3 / std ** 3 : 0,
      q05: quantile(points, 0.05), q25: quantile(points, 0.25), q50: quantile(points, 0.50),
      q75: quantile(points, 0.75), q95: quantile(points, 0.95),
      negDensity: points.filter(p => p.pdf < -NEG_TOL).length,
    },
  }
}

// Express a point on the requested axis: futures price, or implied rate (100 − price)
export type AxisMode = 'price' | 'rate'

export function toAxis(points: DistPoint[], mode: AxisMode) {
  if (mode === 'price') return points.map(p => ({ x: p.strike, pdf: p.pdf, cdf: p.cdf, strike: p.strike, rate: p.rate }))
  // In rate space the density is unchanged; P(rate ≤ r) = 1 − P(price < 100 − r)
  return [...points].reverse().map(p => ({ x: p.rate, pdf: p.pdf, cdf: 1 - p.cdf, strike: p.strike, rate: p.rate }))
}
