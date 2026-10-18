import { useEffect, useMemo, useState } from 'react'
import axios from 'axios'

// ─── Types (from /api/tools/swaps-rv/candidates) ──────────────────────────────

type Basis = 'neutral' | 'standard'
type CheckKey = 'carry' | 'residual' | 'reversion' | 'delivered' | 'stable'

interface Candidate {
  label: string
  group: 'curve' | 'fly'
  basis: Basis                   // 'standard' when no neutral weights exist
  weights: number[]
  trade: string                  // Flattener / Steepener / Receive belly / Pay belly
  zscore_1y: number
  residual_zscore: number | null
  deviation_bp: number           // today minus the 1y mean
  half_life_days: number | null  // AR(1) on the last year; null = no mean reversion
  expected_reversion_bp: number  // part of the deviation expected to revert within a year
  carry_bp: number               // 1y carry in the trade direction
  expected_bp: number            // reversion + carry
  vol3m_bp: number               // annualised 3m realised vol
  score: number | null           // expected / vol
  factor_share: number
  carry_hit_rate_2y: number | null
  checks: Record<CheckKey, boolean>
  n_agree: number                // of carry, residual, reversion, delivered
}

interface CandidatesData {
  currency: string
  as_of: string
  basis: Basis
  candidates: Candidate[]
}

type Row = Candidate & { currency: string }

const MONO = "'Geist Mono', ui-monospace, monospace"
const signed = (v: number, d = 1) => `${v > 0 ? '+' : ''}${v.toFixed(d)}`

const CHECKS: { key: CheckKey; short: string; title: string }[] = [
  { key: 'carry',     short: 'Carry',  title: 'Carry is positive in the trade direction' },
  { key: 'residual',  short: 'Resid',  title: 'The Beta Monitor regression residual points the same way (|residual Z| ≥ 1)' },
  { key: 'reversion', short: 'MR',     title: 'The structure mean-reverts: AR(1) half-life under a year' },
  { key: 'delivered', short: 'Hist',   title: "Carry has been delivered: the carry backtest's hit rate ≥ 50% over the last 2y" },
  { key: 'stable',    short: 'Hedge',  title: 'The factor-neutral hedge is stable (always true for the standard basis)' },
]

type Agreement = 'all' | 'three' | 'any'
const AGREEMENT: [Agreement, string][] = [['all', 'All agree'], ['three', '≥ 3 of 4'], ['any', 'Any']]
const MIN_Z = [1, 1.5, 2]

type SortKey = 'score' | 'zscore_1y' | 'expected_bp' | 'carry_bp' | 'half_life_days' | 'label' | 'currency'

function Toggle<T extends string | number>({ options, value, onChange }: {
  options: [T, string][]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div style={{
      display: 'flex', background: 'rgba(200,220,240,0.04)', border: '1px solid rgba(200,220,240,0.08)',
      borderRadius: 6, padding: 3, gap: 2,
    }}>
      {options.map(([v, txt]) => (
        <button key={String(v)} onClick={() => onChange(v)} style={{
          padding: '3px 10px', borderRadius: 5, fontSize: 11, fontWeight: 600, border: 'none',
          cursor: value === v ? 'default' : 'pointer',
          background: value === v ? 'rgba(106,169,204,0.25)' : 'transparent',
          color: value === v ? '#a9d2e8' : '#9aa5b1',
        }}>{txt}</button>
      ))}
    </div>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function TradeCandidates({ currencies, universe, asOf, dataStamp, onSelect }: {
  currencies: string[]
  universe: string
  asOf?: string                 // omitted: each currency's latest date
  dataStamp?: string | null     // changes on a data refresh, so the candidates reload too
  onSelect: (currency: string, label: string) => void
}) {
  const [basis, setBasis] = useState<Basis>('neutral')
  const [minZ, setMinZ] = useState(1.5)
  const [agreement, setAgreement] = useState<Agreement>('all')
  const [sortKey, setSortKey] = useState<SortKey>('score')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [ccyFilter, setCcyFilter] = useState<string>('all')
  const [data, setData] = useState<CandidatesData[] | null>(null)
  const [failed, setFailed] = useState<string[]>([])
  const ccyKey = currencies.join(',')

  // Every currency in parallel; one that fails is reported without hiding the others
  useEffect(() => {
    let cancelled = false
    setData(null)
    setFailed([])
    const headers = { Authorization: `Bearer ${localStorage.getItem('access_token') ?? ''}` }
    const ccys = ccyKey.split(',')
    Promise.allSettled(ccys.map(ccy => {
      const params = new URLSearchParams({ currency: ccy, universe, basis })
      if (asOf) params.set('date', asOf)
      return axios.get<CandidatesData>(`/api/tools/swaps-rv/candidates?${params}`, { headers }).then(res => {
        const d = res.data as Partial<CandidatesData> | undefined
        if (!d || typeof d !== 'object' || !Array.isArray(d.candidates)) throw new Error('unexpected response')
        return { ...(d as CandidatesData), currency: ccy }
      })
    })).then(results => {
      if (cancelled) return
      setFailed(ccys.filter((_, i) => results[i].status === 'rejected'))
      setData(results.flatMap(r => r.status === 'fulfilled' ? [r.value] : []))
    })
    return () => { cancelled = true }
  }, [ccyKey, universe, asOf, dataStamp, basis])

  const rows = useMemo(() => {
    if (!data) return []
    const need = agreement === 'all' ? 4 : agreement === 'three' ? 3 : 0
    const all: Row[] = data.flatMap(d => d.candidates.map(c => ({ ...c, currency: d.currency })))
    const kept = all.filter(c =>
      (ccyFilter === 'all' || c.currency === ccyFilter) &&
      Math.abs(c.zscore_1y) >= minZ && c.n_agree >= need && (agreement === 'any' || c.checks.stable))
    return kept.sort((a, b) => {
      const av = sortKey === 'zscore_1y' ? Math.abs(a.zscore_1y) : a[sortKey]
      const bv = sortKey === 'zscore_1y' ? Math.abs(b.zscore_1y) : b[sortKey]
      const cmp = typeof av === 'string'
        ? av.localeCompare(bv as string)
        : ((av as number | null) ?? -Infinity) - ((bv as number | null) ?? -Infinity)
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [data, ccyFilter, minZ, agreement, sortKey, sortDir])

  function sortBy(k: SortKey) {
    if (sortKey === k) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(k); setSortDir(k === 'label' || k === 'currency' ? 'asc' : 'desc') }
  }

  const th: React.CSSProperties = {
    textAlign: 'right', padding: '8px 10px', fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
    letterSpacing: '0.05em', whiteSpace: 'nowrap', borderBottom: '1px solid rgba(200,220,240,0.08)',
  }
  const td: React.CSSProperties = { textAlign: 'right', padding: '7px 10px', fontSize: 12, fontFamily: MONO, color: '#c6ced8' }
  const sortTh = (k: SortKey, label: string, title?: string, align: 'left' | 'right' = 'right') => (
    <th key={k} title={title} onClick={() => sortBy(k)} style={{
      ...th, textAlign: align, cursor: 'pointer', userSelect: 'none', color: sortKey === k ? '#a9d2e8' : '#9aa5b1',
    }}>{label}{sortKey === k ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''}</th>
  )
  const total = data ? data.filter(d => ccyFilter === 'all' || d.currency === ccyFilter).reduce((n, d) => n + d.candidates.length, 0) : 0
  const asOfs = data ? [...new Set(data.map(d => d.as_of))] : []

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={{ maxWidth: 760 }}>
          <h2 style={{ color: '#eef2f6', fontSize: 16, fontWeight: 600, margin: 0 }}>Trade candidates</h2>
          <p style={{ color: '#8995a2', fontSize: 12, marginTop: 4, lineHeight: 1.5 }}>
            Mean-reversion trades where the signals agree. Rich (Z &gt; 0) is expected to fall, cheap to rise.
            Expected 1y P&amp;L = the part of today's deviation from the 1y mean that an AR(1) on the last year says reverts
            within a year, plus carry in the trade direction; score = expected P&amp;L ÷ 3m realised vol (annualised).
            {basis === 'neutral' && ' Neutral basis: the factor-neutral version of each structure (unstable hedges need "Any").'}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {currencies.length > 1 && (
            <Toggle<string> options={[['all', 'All'], ...currencies.map(c => [c, c] as [string, string])]} value={ccyFilter} onChange={setCcyFilter} />
          )}
          <Toggle<Basis> options={[['neutral', 'Neutral'], ['standard', 'Standard']]} value={basis} onChange={setBasis} />
          <Toggle<number> options={MIN_Z.map(z => [z, `|Z| ≥ ${z}`])} value={minZ} onChange={setMinZ} />
          <Toggle<Agreement> options={AGREEMENT} value={agreement} onChange={setAgreement} />
        </div>
      </div>

      {failed.length > 0 && (
        <div style={{ color: '#e2826f', fontSize: 12, marginBottom: 10 }}>
          Could not load {failed.join(', ')}{data && data.length > 0 ? '; showing the other currencies.' : '.'}
        </div>
      )}
      {!data ? (
        <div style={{ color: '#8995a2', fontSize: 12 }}>Loading trade candidates…</div>
      ) : rows.length === 0 ? (
        <div style={{ color: '#8995a2', fontSize: 12, padding: '12px 0' }}>
          No structure with |Z| ≥ {minZ} passes these checks today. Loosen the filters to see near misses.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {currencies.length > 1 && sortTh('currency', 'Ccy', undefined, 'left')}
                {sortTh('label', 'Structure', undefined, 'left')}
                <th style={{ ...th, textAlign: 'left', color: '#9aa5b1' }}>Trade</th>
                {sortTh('zscore_1y', 'Z', '1y Z-score of the structure traded (sorts by |Z|)')}
                <th style={{ ...th, color: '#9aa5b1' }} title="Today minus the 1y mean, bp">Dev.</th>
                {sortTh('half_life_days', 'Half-life', 'AR(1) half-life of the level over the last year, trading days')}
                <th style={{ ...th, color: '#9aa5b1' }} title="Part of the deviation expected to revert within a year, bp">Reversion</th>
                {sortTh('carry_bp', 'Carry', '1y carry in the trade direction, bp')}
                {sortTh('expected_bp', 'Exp. 1y', 'Expected reversion + carry, bp')}
                <th style={{ ...th, color: '#9aa5b1' }} title="3m realised vol, annualised bp">Vol</th>
                {sortTh('score', 'Score', 'Expected 1y P&L ÷ vol')}
                <th style={{ ...th, color: '#9aa5b1' }} title="Carry backtest hit rate, last 2y">Carry hit</th>
                {CHECKS.map(c => <th key={c.key} style={{ ...th, textAlign: 'center', color: '#9aa5b1' }} title={c.title}>{c.short}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map(c => (
                <tr key={`${c.currency}|${c.label}`} onClick={() => onSelect(c.currency, c.label)} title={`Open ${c.currency} ${c.label}`}
                  style={{ cursor: 'pointer', borderTop: '1px solid rgba(200,220,240,0.05)' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(200,220,240,0.03)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                >
                  {currencies.length > 1 && <td style={{ ...td, textAlign: 'left', color: '#a9d2e8' }}>{c.currency}</td>}
                  <td style={{ ...td, textAlign: 'left', color: '#e4eaf1' }}>
                    {c.label}
                    {c.basis === 'neutral' && (
                      <span title={`Neutral weights ${c.weights.map(w => w.toFixed(2)).join(' / ')}`}
                        style={{ color: '#77828f', fontSize: 10, marginLeft: 6 }}>N</span>
                    )}
                  </td>
                  <td style={{ ...td, textAlign: 'left', fontFamily: 'inherit', color: '#c6ced8' }}>{c.trade}</td>
                  <td style={{ ...td, color: c.zscore_1y > 0 ? '#e2826f' : '#6fc2a2' }}>{signed(c.zscore_1y, 2)}</td>
                  <td style={td}>{signed(c.deviation_bp)}</td>
                  <td style={td}>{c.half_life_days === null ? '—' : `${c.half_life_days.toFixed(0)}d`}</td>
                  <td style={td}>{c.expected_reversion_bp.toFixed(1)}</td>
                  <td style={{ ...td, color: c.carry_bp >= 0 ? '#6fc2a2' : '#e2826f' }}>{signed(c.carry_bp)}</td>
                  <td style={{ ...td, color: '#e4eaf1' }}>{signed(c.expected_bp)}</td>
                  <td style={td}>{c.vol3m_bp.toFixed(1)}</td>
                  <td style={{ ...td, color: '#e4eaf1', fontWeight: 600 }}>{c.score === null ? '—' : c.score.toFixed(2)}</td>
                  <td style={td}>{c.carry_hit_rate_2y === null ? '—' : `${Math.round(c.carry_hit_rate_2y * 100)}%`}</td>
                  {CHECKS.map(k => (
                    <td key={k.key} style={{ ...td, textAlign: 'center' }} title={k.title}>
                      <span style={{
                        display: 'inline-block', width: 8, height: 8, borderRadius: 4,
                        background: c.checks[k.key] ? '#6fc2a2' : 'transparent',
                        border: `1px solid ${c.checks[k.key] ? '#6fc2a2' : 'rgba(200,220,240,0.25)'}`,
                      }} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ color: '#77828f', fontSize: 11, marginTop: 8 }}>
            {rows.length} of {total} structures{asOfs.length ? ` · as of ${asOfs.join(' / ')}` : ''}. Very short half-lives (a few days) mean the deviation is mostly day-to-day
            noise, which the vol in the score already penalises. The residual and carry-history checks use the standard
            structure. Not a recommendation: costs, liquidity and event risk are not included.
          </div>
        </div>
      )}
    </div>
  )
}
