// Macro Options Monitor model: the live adapter, Breeden–Litzenberger on a chain, and the
// simulated market's calendar.
import { describe, expect, it } from 'vitest'
import { serialExpiry } from '../features/macro-options/model/calendar'
import { bachelierCall, extractDistribution } from '../features/macro-options/model/distribution'
import { liveMarket } from '../features/macro-options/model/live'
import type { SnapshotPayload } from '../features/macro-options/model/live'
import { fitOutcomes } from '../features/macro-options/model/outcomes'
import { simMarket } from '../features/macro-options/model/simulation'

const F = 97.1, T = 0.4, VOL = 0.6, H = 0.0125

function payload(): SnapshotPayload {
  const lo = 94.0
  const calls = Array.from({ length: 497 }, (_, i) => bachelierCall(F, lo + i * H, T, VOL))
  const quotes = Array.from({ length: 33 }, (_, i) => +(96.1 + 0.0625 * i).toFixed(4)).map(k => {
    const c = bachelierCall(F, k, T, VOL)
    return k >= F
      ? { strike: k, type: 'C' as const, price: c, iv: VOL, source: 'settle' as const }
      : { strike: k, type: 'P' as const, price: c - (F - k), iv: VOL, source: 'settle' as const }
  })
  return {
    data_source: 'bloomberg', live: false, as_of: '2026-10-16T16:15', note: null,
    contracts: [
      { id: 'ERZ6', ticker: 'ERZ6 Comdty', year: 2026, month: 12, F: 97.2, ltd: '2026-12-14', expiries: [] },
      {
        id: 'ERH7', ticker: 'ERH7 Comdty', year: 2027, month: 3, F, ltd: '2027-03-15', expiries: [{
          id: '2027-03', code: 'ERH7', kind: 'standard', expiry: '2027-03-15T10:00', T, F, atm_vol: VOL,
          grid_lo: lo, grid_h: H, calls, quotes, n_fit: quotes.length, fit_rmse_ticks: 0, flags: [],
        }],
      },
    ],
    meetings: [],
    ois_path: [
      { decision: '2026-10-29T13:15', effective: '2026-11-04T00:00', estimated: false, rate: 2.5, exp_bp: 0, cumulative_bp: 0 },
      { decision: '2026-12-17T13:15', effective: '2026-12-23T00:00', estimated: false, rate: 2.75, exp_bp: 25, cumulative_bp: 25 },
    ],
    rates: { dfr: 2.5, estr: 2.44, ois: [] },
  }
}

describe('live market', () => {
  const m = liveMarket(payload())

  it('maps contracts, expiries and the snapshot', () => {
    expect(m.source).toBe('settlement')
    expect(m.snap.toISOString()).toBe('2026-10-16T16:15:00.000Z')
    expect(m.contracts.map(c => c.id)).toEqual(['ERZ6', 'ERH7'])
    expect(m.contracts[1].pack).toBe('whites')
    const [e] = m.expiries(m.contracts[1])
    expect(e.label).toBe('15 Mar 27')
    expect(e.date.toISOString()).toBe('2027-03-15T10:00:00.000Z')
    expect(m.expiries(m.contracts[0])).toEqual([])
    expect(m.dfr).toBe(2.5)
    expect(m.path[1].expBp).toBe(25)
  })

  it('prices off the call grid, exactly at nodes and linearly between them', () => {
    const ch = m.chain(m.contracts[1], m.expiries(m.contracts[1])[0])!
    expect(ch.call(97.0)).toBeCloseTo(bachelierCall(F, 97.0, T, VOL), 10)
    expect(ch.call(97.00625)).toBeCloseTo((ch.call(97.0) + ch.call(97.0125)) / 2, 10)
    expect(ch.call(90)).toBeCloseTo(ch.call(94) + 4, 6)            // below the grid: intrinsic slope
    expect(ch.call(105)).toBeLessThan(1e-9)
  })

  it('recovers the Bachelier density at every strike width', () => {
    const ch = m.chain(m.contracts[1], m.expiries(m.contracts[1])[0])!
    for (const h of [0.0125, 0.025, 0.0625, 0.125, 0.25]) {
      const d = extractDistribution(ch, h)
      expect(d.stats.mass).toBeGreaterThan(0.99)
      expect(d.stats.mean).toBeCloseTo(F, 2)
      expect(d.stats.std).toBeCloseTo(VOL * Math.sqrt(T), 1)
      expect(d.stats.negDensity).toBe(0)
    }
  })

  it('fits outcomes from the listed quotes and the OIS path', () => {
    const c = m.contracts[1]
    const e = m.expiries(c)[0]
    const fit = fitOutcomes(c, m.chain(c, e)!, e, m.path, 2.5, 10, true)!
    expect(fit.realised.length).toBe(2)
    expect(fit.probs.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6)
    expect(fit.oisBp).toBeCloseTo(25, 6)                            // both meetings before the fixing window
  })
})

describe('simulated market', () => {
  it('lists serials only on the first two quarterlies, expiring on Fridays', () => {
    const m = simMarket(new Date('2026-10-16T12:00:00Z'))
    const [z6, h7, m7] = m.contracts
    expect(m.expiries(z6).map(e => e.code)).toEqual(['ERX6', 'ERZ6'])
    expect(m.expiries(h7).map(e => e.code)).toEqual(['ERF7', 'ERG7', 'ERH7'])
    expect(m.expiries(m7).map(e => e.code)).toEqual(['ERM7'])
    expect(m.expiries(z6)[0].date.toISOString()).toBe('2026-11-13T10:00:00.000Z')
    expect(m.chain(z6, m.expiries(z6)[1])!.quotes.length).toBeGreaterThan(4)
  })

  it('matches the Bloomberg serial expiry dates', () => {
    expect(serialExpiry(2026, 10).toISOString().slice(0, 10)).toBe('2026-10-16')
    expect(serialExpiry(2027, 1).toISOString().slice(0, 10)).toBe('2027-01-15')
    expect(serialExpiry(2027, 2).toISOString().slice(0, 10)).toBe('2027-02-12')
  })
})
