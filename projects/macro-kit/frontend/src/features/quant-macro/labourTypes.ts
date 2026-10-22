/**
 * Payloads of GET /api/tools/quant-macro/labour/{country} and .../status, generated from
 * backend/schemas/labour_nowcast.py via src/api/schema.ts (`npm run gen:api`).
 */
import type { components } from '../../api/schema'

type S = components['schemas']

export type Labour = S['LabourNowcast']
export type LabourPoint = S['LabourPoint']
export type LabourContribution = S['LabourContribution']
export type LabourIndicator = S['LabourIndicator']
export type LabourStaffReport = S['LabourStaffReport']
export type LabourSvar = S['LabourSvar']
export type LabourGdpImplied = S['LabourGdpImplied']
export type LabourStatus = S['LabourStatus']
export type LabourJob = S['LabourJob']

// Indicator groups: house hues in an order that passes the categorical checks on the dark surface.
export const LABOUR_GROUP_COLOR: Record<string, string> = { 'Bank surveys': '#3b8fd0', 'Official data': '#c27f20', 'Private surveys': '#a07ae0' }
