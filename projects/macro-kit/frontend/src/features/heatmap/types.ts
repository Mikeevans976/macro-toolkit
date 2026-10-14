/**
 * Payload of GET /api/tools/heatmap/{region}. Generated from the backend's
 * Pydantic models (backend/schemas/heatmap.py) via src/api/schema.ts; do not
 * hand-edit shapes here, change the backend model and run `npm run gen:api`.
 */
import type { components } from '../../api/schema'

type S = components['schemas']

export type HeatmapDashboard = S['HeatmapDashboard']
export type CurveRegimes = S['CurveRegimes']
export type Breakeven = S['Breakeven']
export type Indicator = S['Indicator']
export type CurveFVRow = S['CurveFVRow']
export type ScenarioProbs = S['ScenarioProbs']
export type Source = S['DataSources']['macro']
export type ScenarioKey = keyof ScenarioProbs

/** A look-back row of either kind, indexed by regime key in the shared table. */
export type LookbackRow = (S['CurveLookback'] | S['BreakevenLookback']) & Record<string, number | string>
