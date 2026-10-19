// The live market: a backend snapshot (/api/tools/macro-options/snapshot) as a Market.
//
// The backend fits each expiry's smile to the Bloomberg quotes and prices calls on a fine
// strike grid (grid_lo + i·grid_h); the pricer here reads that grid, interpolating linearly
// between nodes (exact at every node, and every strike the page asks for is one).

import type { components } from '../../../api/schema'
import { MONTHS, parseLondon } from './calendar'
import { packOf } from './types'
import type { Chain, Contract, Market, OISeries, OptionExpiry, PathMeeting } from './types'

export type SnapshotPayload = components['schemas']['MacroOptionsSnapshot']
export type OpenInterestPayload = components['schemas']['OpenInterest']
type ExpiryChain = components['schemas']['ExpiryChain']

function gridPricer(e: ExpiryChain): (K: number) => number {
  const { grid_lo: lo, grid_h: h, calls } = e
  const n = calls.length
  return (K: number) => {
    const x = (K - lo) / h
    if (x <= 0) return calls[0] + (lo - K)          // deep in the money: slope −1
    if (x >= n - 1) return calls[n - 1]             // deep out of the money: ~0
    const i = Math.floor(x + 1e-9), w = x - i
    return w < 1e-9 ? calls[i] : calls[i] + w * (calls[i + 1] - calls[i])
  }
}

function toChain(e: ExpiryChain): Chain {
  return {
    F: e.F, T: e.T, atmVol: e.atm_vol, call: gridPricer(e), flags: e.flags,
    quotes: e.quotes.map(q => ({ strike: q.strike, type: q.type, market: q.price })),
  }
}

function toExpiry(e: ExpiryChain): OptionExpiry {
  const date = parseLondon(e.expiry)
  return {
    id: e.id, code: e.code, kind: e.kind, date,
    label: `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${String(date.getUTCFullYear()).slice(2)}`,
  }
}

export function liveMarket(p: SnapshotPayload): Market {
  const snap = parseLondon(p.as_of!)
  const contracts: Contract[] = p.contracts.map((c, slot) => ({ id: c.id, label: c.id, year: c.year, month: c.month, ...packOf(slot) }))
  const rows = new Map(p.contracts.map(c => [c.id, c]))
  const expiries = new Map(p.contracts.map(c => [c.id, c.expiries.map(toExpiry)]))
  const chains = new Map<string, Chain>()
  const path: PathMeeting[] = p.ois_path.map(m => ({
    decision: parseLondon(m.decision), effective: parseLondon(m.effective), estimated: m.estimated, expBp: m.exp_bp,
  }))
  return {
    source: p.live ? 'live' : 'settlement', snap, contracts, path,
    dfr: p.rates?.dfr ?? null, note: p.note,
    expiries: c => expiries.get(c.id) ?? [],
    F: c => rows.get(c.id)?.F ?? NaN,
    chain: (c, e) => {
      const key = `${c.id}|${e.id}`
      const hit = chains.get(key)
      if (hit) return hit
      const row = rows.get(c.id)?.expiries.find(x => x.id === e.id)
      if (!row) return null
      const ch = toChain(row)
      chains.set(key, ch)
      return ch
    },
  }
}

export function liveOpenInterest(p: OpenInterestPayload): OISeries {
  return {
    dates: p.dates.map(d => new Date(`${d}T21:00:00Z`)),
    strikes: p.strikes, calls: p.calls, puts: p.puts, F: p.F,
  }
}
