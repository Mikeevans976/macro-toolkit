// Data hooks of the Macro Options Monitor: the market at a snapshot (live, a past day's
// settlement, or the in-browser simulation when the backend has no Bloomberg) and the
// open-interest history of one option series.

import { useEffect, useMemo, useState } from 'react'
import { authFetch } from '../../api/client'
import { londonNow, snapToSession, toDateInput } from './model/calendar'
import { liveMarket, liveOpenInterest } from './model/live'
import type { OpenInterestPayload, SnapshotPayload } from './model/live'
import { simMarket } from './model/simulation'
import type { Contract, Market, OISeries, OptionExpiry } from './model/types'

const LIVE_TTL_MS = 5 * 60 * 1000
const snapshots = new Map<string, { at: number; p: Promise<SnapshotPayload> }>()
const oiCache = new Map<string, Promise<OpenInterestPayload>>()

async function getJson<T>(url: string, ok: (j: unknown) => boolean): Promise<T> {
  const res = await authFetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const j: unknown = await res.json().catch(() => null)
  // An old server answers unknown /api routes with the SPA's index.html
  if (!ok(j)) throw new Error('unexpected response')
  return j as T
}

const isSnapshot = (j: unknown) => !!j && typeof (j as SnapshotPayload).data_source === 'string' && Array.isArray((j as SnapshotPayload).contracts)

/** "live" for today (or later), else the date: the backend's snapshot key */
export function snapshotKey(date: string): string {
  return date >= toDateInput(londonNow()) ? 'live' : date
}

function fetchSnapshot(key: string): Promise<SnapshotPayload> {
  const hit = snapshots.get(key)
  if (hit && (key !== 'live' || Date.now() - hit.at < LIVE_TTL_MS)) return hit.p
  const url = key === 'live' ? '/api/tools/macro-options/snapshot' : `/api/tools/macro-options/snapshot?date=${key}`
  const p = getJson<SnapshotPayload>(url, isSnapshot)
  p.catch(() => snapshots.delete(key))
  snapshots.set(key, { at: Date.now(), p })
  return p
}

type MarketState = { market: Market | null; loading: boolean }

/** The market for a snapshot key; `simAt` is the moment the simulation uses if it has to */
export function useMarket(key: string, simAt: Date): MarketState {
  const [res, setRes] = useState<{ key: string; payload: SnapshotPayload | null; error: string | null } | null>(null)
  useEffect(() => {
    let live = true
    fetchSnapshot(key)
      .then(payload => { if (live) setRes({ key, payload, error: null }) })
      .catch((err: Error) => { if (live) setRes({ key, payload: null, error: err.message }) })
    return () => { live = false }
  }, [key])
  const simKey = simAt.getTime()
  return useMemo(() => {
    if (!res || res.key !== key) return { market: null, loading: true }
    if (res.error) return { market: simMarket(simAt, `Backend unavailable (${res.error}): simulated data.`), loading: false }
    const p = res.payload!
    if (p.data_source === 'simulation' || !p.as_of) {
      return { market: simMarket(simAt, p.note ?? 'Bloomberg unavailable: simulated data.'), loading: false }
    }
    return { market: liveMarket(p), loading: false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [res, key, simKey])
}

/** Markets at several moments (Cross-time tab): simulated synchronously, else fetched by date */
export function useMarketsAt(source: Market['source'], moments: Date[]): (Market | null)[] {
  const keys = moments.map(d => snapshotKey(toDateInput(d)))
  const [got, setGot] = useState<Record<string, Market>>({})
  const sim = source === 'simulation'
  useEffect(() => {
    if (sim) return
    let live = true
    keys.forEach(k => {
      if (got[k]) return
      fetchSnapshot(k).then(p => {
        if (live && p.data_source === 'bloomberg' && p.as_of) setGot(g => ({ ...g, [k]: liveMarket(p) }))
      }).catch(() => { /* that date stays unavailable */ })
    })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sim, keys.join(',')])
  return useMemo(
    () => (sim ? moments.map(d => simMarket(snapToSession(d))) : keys.map(k => got[k] ?? null)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sim, keys.join(','), moments.map(d => d.getTime()).join(','), got],
  )
}

const isOI = (j: unknown) => !!j && typeof (j as OpenInterestPayload).data_source === 'string' && Array.isArray((j as OpenInterestPayload).dates)

/** Daily open interest of one option series up to `through` (null while loading) */
export function useOpenInterest(market: Market, c: Contract, e: OptionExpiry | null, through: Date):
    { series: OISeries | null; loading: boolean; note: string | null } {
  const simSeries = useMemo(
    () => (market.simOpenInterest && e ? market.simOpenInterest(c, e, through) : null),
    [market, c, e, through],
  )
  const url = e && !market.simOpenInterest
    ? `/api/tools/macro-options/open-interest?contract=${c.id}&expiry=${e.id}&through=${toDateInput(through)}`
    : null
  const [got, setGot] = useState<{ url: string; series: OISeries | null; note: string | null } | null>(null)
  useEffect(() => {
    if (!url) return
    let live = true
    let p = oiCache.get(url)
    if (!p) {
      p = getJson<OpenInterestPayload>(url, isOI)
      p.catch(() => oiCache.delete(url!))
      oiCache.set(url, p)
    }
    p.then(r => { if (live) setGot({ url, series: r.dates.length ? liveOpenInterest(r) : null, note: r.note }) })
      .catch(err => { if (live) setGot({ url, series: null, note: `Open interest unavailable (${err.message}).` }) })
    return () => { live = false }
  }, [url])
  if (!url) return { series: simSeries, loading: false, note: null }
  return got?.url === url ? { series: got.series, loading: false, note: got.note } : { series: null, loading: true, note: null }
}
