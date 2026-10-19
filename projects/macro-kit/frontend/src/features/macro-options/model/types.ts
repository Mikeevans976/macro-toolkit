// Shared types of the Macro Options Monitor (ER Euribor options).
//
// Every tab works on a `Market`: the contracts and option expiries live at one snapshot,
// a call pricer per expiry and the OIS meeting path. A market is either live (built from
// the backend snapshot, see live.ts) or simulated in the browser (simulation.ts).

// Quarterly packs: whites = contracts 1–4, reds = 5–8, greens = 9–12.
// Colour follows the pack (hue) and position within it (light → dark), fixed per contract.
export type PackId = 'whites' | 'reds' | 'greens'
export const PACKS: { id: PackId; label: string; shades: string[] }[] = [
  { id: 'whites', label: 'Whites', shades: ['#eef2f6', '#cdd5de', '#aab4bf', '#87929e'] },
  { id: 'reds',   label: 'Reds',   shades: ['#f3bfb4', '#e8a091', '#dd8270', '#c8695a'] },
  { id: 'greens', label: 'Greens', shades: ['#b5e3cf', '#8fd1b6', '#6fc2a2', '#4fa784'] },
]

export const N_QUARTERLIES = 12   // whites + reds + greens

/** Pack and colour of the contract in position `slot` (0–11) */
export function packOf(slot: number): { pack: PackId; color: string } {
  const pk = PACKS[Math.min(2, Math.floor(slot / 4))]
  return { pack: pk.id, color: pk.shades[slot % 4] }
}

export interface Contract {
  id: string         // "ERZ6"
  label: string
  year: number
  month: number      // 1–12, contract month
  pack: PackId
  color: string
}

export interface OptionExpiry {
  id: string         // "2026-11" — option month
  label: string      // "13 Nov 26" — expiry date
  code: string       // "ERX6" — ICE option month code
  kind: 'serial' | 'quarterly' | 'standard'
  date: Date         // expiry, London wall-clock stored as UTC
}

/** One expiry's option prices: a call pricer on any strike plus the listed OTM quotes */
export interface Chain {
  F: number
  T: number          // years
  atmVol: number     // annualised normal vol at the money, price units
  call: (K: number) => number                                    // undiscounted call premium
  quotes: { strike: number; type: 'C' | 'P'; market: number }[]  // listed OTM premia, ascending strike
  flags: string[]
}

export interface Meeting { decision: Date; effective: Date; estimated: boolean }

/** An ECB meeting with its OIS-implied expected move */
export interface PathMeeting extends Meeting { expBp: number }

export interface OISeries {
  dates: Date[]            // business days, ascending
  strikes: number[]        // ascending
  calls: number[][]        // [day][strike], lots
  puts: number[][]
  F: number[]              // futures settlement per day
}

export type MarketSource = 'live' | 'settlement' | 'simulation'

export interface Market {
  source: MarketSource
  snap: Date                                            // effective snapshot, London wall-clock as UTC
  contracts: Contract[]
  expiries: (c: Contract) => OptionExpiry[]
  F: (c: Contract) => number
  chain: (c: Contract, e: OptionExpiry) => Chain | null
  path: PathMeeting[]                                   // OIS meeting expectations after the snapshot
  dfr: number | null                                    // ECB deposit rate at the snapshot, if known
  note: string | null
  simOpenInterest?: (c: Contract, e: OptionExpiry, through: Date) => OISeries
}

export interface DistPoint {
  strike: number
  rate: number
  pdf: number
  cdf: number
}

export interface DistStats {
  mass: number
  mean: number
  std: number
  skew: number
  q05: number
  q25: number
  q50: number
  q75: number
  q95: number
  negDensity: number
}

export interface DistResult {
  F: number
  atmVol: number     // annualised normal vol at the money, price units
  T: number          // years
  h: number
  points: DistPoint[]
  stats: DistStats
}
