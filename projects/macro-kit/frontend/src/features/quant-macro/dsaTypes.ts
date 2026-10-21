/**
 * Payloads of GET /api/tools/quant-macro/dsa/{country} and .../status, generated from
 * backend/schemas/debt_sustainability.py via src/api/schema.ts (`npm run gen:api`).
 */
import type { components } from '../../api/schema'

type S = components['schemas']

export type Dsa = S['DebtSustainability']
export type DsaRule = S['DsaRule']
export type DsaProjectionRow = S['DsaProjectionRow']
export type DsaFanRow = S['DsaFanRow']
export type DsaDynamicsRow = S['DsaDynamicsRow']
export type DsaInterest = S['DsaInterest']
export type DsaFinancing = S['DsaFinancing']
export type DsaScenario = S['DsaScenario']
export type DsaTracker = S['DsaTracker']
export type DsaMarket = S['DsaMarket']
export type DsaStatus = S['DsaStatus']
export type DsaUpload = S['DsaUpload']
