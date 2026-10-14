/** Payload of GET /api/tools/heatmap/{region} (backend/regional_heatmap.py get_dashboard). */

export type Source = 'live' | 'simulation'

export interface FactorSummary {
  current: number
  d1m: number | null
  d3m: number | null
  d12m: number | null
  zscore: number
}

export interface Regression {
  beta: number[]
  tstat: number[]
  r2: number
  adj_r2: number
  fitted: number[]
}

export interface CurveFVRow {
  label: string
  is_spread: boolean
  current: number
  fair_value: number
  resid_bp: number
  std_bp: number
  zscore: number
}

export interface LookbackRow { horizon: string; dispersion: number; [regime: string]: number | string }

export interface CurveRegimes {
  name: string                       // '2s10s' | '2s30s'
  dates: string[]
  bull_steep: number[]
  bull_flat: number[]
  bear_steep: number[]
  bear_flat: number[]
  dispersion: number[]
  dispersion_avg: number
  lookbacks: LookbackRow[]
}

export interface Breakeven {
  source: Source
  dates: string[]
  breakeven: number[]
  regime_dates: string[]
  expansion: number[]
  slowdown: number[]
  stagflation: number[]
  goldilocks: number[]
  dispersion: number[]
  dispersion_avg: number
  lookbacks: LookbackRow[]
}

export type ScenarioKey = 'hard_landing' | 'soft_landing' | 'no_landing' | 'reacceleration'
export type ScenarioProbs = Record<ScenarioKey, number>

export interface Scenarios {
  current: { curve: ScenarioProbs; breakeven: ScenarioProbs }
  dates: string[]
  curve: Record<ScenarioKey, number[]>
  breakeven: Record<ScenarioKey, number[]>
}

export interface Indicator {
  id: string
  name: string
  units: string
  factor: string
  zscores: (number | null)[]
  latest: number | null
  last_obs: string | null
}

export interface HeatmapDashboard {
  region: string
  display_name: string
  bond_name: string
  tenors: string[]
  period: { start: string; end: string }
  data_source: { macro: Source; yields: Source; breakeven: Source }
  factors: { dates: string[]; factors: Record<string, number[]>; smoothed: boolean; summary: Record<string, FactorSummary> }
  yield_pca: {
    dates: string[]
    pc_scores: Record<string, number[]>
    loadings: Record<string, number[]>
    explained_var: Record<string, number>
    tenor_names: string[]
  }
  regressions: { factor_names: string[]; pc1: Regression; pc2: Regression }
  fair_value: {
    dates: string[]
    actual: number[]
    pca_fitted: number[]
    macro_fair_value: number[]
    rich_cheap_bps: number[]
    curve_table: CurveFVRow[]
  }
  curve_regimes: CurveRegimes[]
  breakeven: Breakeven
  scenarios: Scenarios
  indicators: {
    months: string[]
    raw_values: boolean
    groups: { name: string; indicators: Indicator[] }[]
  }
}
