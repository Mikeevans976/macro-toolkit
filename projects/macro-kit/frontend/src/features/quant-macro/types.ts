/**
 * Payloads of GET /api/tools/quant-macro/{model} and .../backtest, generated from
 * backend/schemas/quant_macro.py via src/api/schema.ts. Change the backend model
 * and run `npm run gen:api`; don't hand-edit shapes here.
 */
import type { components } from '../../api/schema'

type S = components['schemas']

export type Nowcast = S['Nowcast']
export type QuarterRow = S['NowcastQuarter']
export type PathPoint = S['NowcastPathPoint']
export type NextPrint = S['NowcastNextPrint']
export type EvolutionStep = S['NowcastStep']
export type Indicator = S['NowcastIndicator']
export type CentralBank = S['NowcastCentralBank']
export type Backtest = S['NowcastBacktest']
export type Release = S['NowcastRelease']
export type Status = S['NowcastStatus']
export type Job = S['NowcastJob']
