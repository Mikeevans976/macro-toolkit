import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import {
  BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, ComposedChart, Line,
  Scatter, ZAxis, ScatterChart,
} from 'recharts'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Release {
  date: string
  release_date: string | null
  actual: number | null
  avg: number | null
  median: number | null
  high: number | null
  low: number | null
  n: number | null
  surprise: number | null
  z_score: number | null
}

interface Summary {
  n_releases: number
  mean_surprise: number | null
  std_surprise: number | null
  pct_beats: number | null
  pct_misses: number | null
  pct_inline: number | null
}

interface PrintVsConsensusData {
  ticker: string
  releases: Release[]
  summary: Summary
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BG = '#080d1a'
const ACCENT = '#6366f1'
const ACCENT_DIM = 'rgba(99,102,241,0.15)'
const ACCENT_BORDER = 'rgba(99,102,241,0.35)'
const GREEN = '#22c55e'
const RED = '#ef4444'
const MUTED = '#475569'

const cardStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.07)',
  borderRadius: 12, padding: '16px 20px',
}

type Tab = 'print-vs-consensus'

const TABS: { id: Tab; label: string }[] = [
  { id: 'print-vs-consensus', label: 'Print vs Consensus' },
]

type ConsensusMode = 'avg' | 'median'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(val: number | null, dp = 2): string {
  if (val == null) return '—'
  return val.toFixed(dp)
}

function fmtSurprise(val: number | null, dp = 2): string {
  if (val == null) return '—'
  const s = val.toFixed(dp)
  return val > 0 ? `+${s}` : s
}

function getSurprise(r: Release, mode: ConsensusMode): number | null {
  if (r.actual == null) return null
  const ref = mode === 'avg' ? r.avg : r.median
  if (ref == null) return null
  return parseFloat((r.actual - ref).toFixed(4))
}

function surpriseColor(val: number | null): string {
  if (val == null) return MUTED
  if (val > 0) return GREEN
  if (val < 0) return RED
  return MUTED
}

function zColor(z: number | null): string {
  if (z == null) return MUTED
  const abs = Math.abs(z)
  if (abs >= 2) return z > 0 ? GREEN : RED
  if (abs >= 1) return z > 0 ? '#86efac' : '#fca5a5'
  return '#94a3b8'
}

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const ALL_MONTHS  = [1,2,3,4,5,6,7,8,9,10,11,12]

/** Recompute summary stats + z-scores from a filtered subset of releases. */
function applyFilters(releases: Release[], selectedYears: number[], selectedMonths: number[]): Release[] {
  const filtered = releases.filter(r => {
    const d = new Date(r.date)
    return selectedYears.includes(d.getFullYear()) && selectedMonths.includes(d.getMonth() + 1)
  })

  const surprises = filtered.map(r => r.surprise).filter((s): s is number => s != null)
  if (surprises.length < 2) return filtered.map(r => ({ ...r, z_score: null }))

  const mean = surprises.reduce((a, b) => a + b, 0) / surprises.length
  const std  = Math.sqrt(surprises.reduce((a, b) => a + (b - mean) ** 2, 0) / (surprises.length - 1))

  return filtered.map(r => ({
    ...r,
    z_score: r.surprise != null && std > 1e-9 ? parseFloat(((r.surprise - mean) / std).toFixed(2)) : null,
  }))
}

function computeSummary(releases: Release[]): Summary {
  const surprises = releases.map(r => r.surprise).filter((s): s is number => s != null)
  const n = surprises.length
  if (n === 0) return { n_releases: releases.length, mean_surprise: null, std_surprise: null, pct_beats: null, pct_misses: null, pct_inline: null }

  const mean   = surprises.reduce((a, b) => a + b, 0) / n
  const std    = n > 1 ? Math.sqrt(surprises.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0
  const beats  = surprises.filter(s => s > 0).length
  const misses = surprises.filter(s => s < 0).length
  const inline_ = surprises.filter(s => s === 0).length

  return {
    n_releases:    releases.length,
    mean_surprise: parseFloat(mean.toFixed(4)),
    std_surprise:  parseFloat(std.toFixed(4)),
    pct_beats:     parseFloat((100 * beats  / n).toFixed(1)),
    pct_misses:    parseFloat((100 * misses / n).toFixed(1)),
    pct_inline:    parseFloat((100 * inline_ / n).toFixed(1)),
  }
}

// ─── Toggle Selector (reused for years and months) ───────────────────────────

function ToggleSelector<T extends number>({ label, items, labelOf, selected, onChange }: {
  label: string
  items: T[]
  labelOf: (item: T) => string
  selected: T[]
  onChange: (items: T[]) => void
}) {
  const allSelected = selected.length === items.length

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', whiteSpace: 'nowrap' }}>
        {label}
      </div>
      <button
        onClick={() => onChange(items)}
        style={{
          background: allSelected ? ACCENT_DIM : 'rgba(255,255,255,0.04)',
          border: `1px solid ${allSelected ? ACCENT_BORDER : 'rgba(255,255,255,0.07)'}`,
          borderRadius: 5, padding: '2px 9px',
          color: allSelected ? ACCENT : '#475569', fontSize: 10, fontWeight: 700, cursor: 'pointer',
        }}>All</button>
      <button
        onClick={() => onChange([])}
        style={{
          background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)',
          borderRadius: 5, padding: '2px 9px',
          color: '#475569', fontSize: 10, cursor: 'pointer',
        }}>None</button>
      <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.08)' }} />
      {items.map(item => {
        const active = selected.includes(item)
        return (
          <button key={item} onClick={() => {
            onChange(active ? selected.filter(x => x !== item) : [...selected, item].sort((a, b) => a - b))
          }} style={{
            background: active ? ACCENT_DIM : 'rgba(255,255,255,0.03)',
            border: `1px solid ${active ? ACCENT_BORDER : 'rgba(255,255,255,0.06)'}`,
            borderRadius: 5, padding: '2px 8px',
            color: active ? ACCENT : '#475569',
            fontSize: 10, fontWeight: active ? 700 : 400, cursor: 'pointer',
          }}>{labelOf(item)}</button>
        )
      })}
    </div>
  )
}

function FilterBar({ allYears, selectedYears, onYears, selectedMonths, onMonths }: {
  allYears: number[]
  selectedYears: number[]
  onYears: (y: number[]) => void
  selectedMonths: number[]
  onMonths: (m: number[]) => void
}) {
  return (
    <div style={{ ...cardStyle, padding: '12px 16px', marginBottom: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <ToggleSelector
        label="Years"
        items={allYears}
        labelOf={y => String(y)}
        selected={selectedYears}
        onChange={onYears}
      />
      <div style={{ height: 1, background: 'rgba(255,255,255,0.06)' }} />
      <ToggleSelector
        label="Months"
        items={ALL_MONTHS}
        labelOf={m => MONTH_NAMES[m - 1]}
        selected={selectedMonths}
        onChange={onMonths}
      />
    </div>
  )
}

// ─── Summary Cards ────────────────────────────────────────────────────────────

function SummaryCards({ summary, ticker }: { summary: Summary; ticker: string }) {
  const cards = [
    { label: 'Releases',      value: String(summary.n_releases),                                       color: '#f1f5f9' },
    { label: 'Mean Surprise', value: fmtSurprise(summary.mean_surprise),                               color: surpriseColor(summary.mean_surprise) },
    { label: 'Std Surprise',  value: fmt(summary.std_surprise),                                        color: '#f1f5f9' },
    { label: '% Beats',       value: summary.pct_beats  != null ? `${summary.pct_beats}%`  : '—',     color: GREEN },
    { label: '% Misses',      value: summary.pct_misses != null ? `${summary.pct_misses}%` : '—',     color: RED },
  ]

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ fontSize: 12, color: MUTED, marginBottom: 10, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
        {ticker}
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {cards.map(c => (
          <div key={c.label} style={{ ...cardStyle, minWidth: 120, flex: '1 1 120px' }}>
            <div style={{ fontSize: 11, color: MUTED, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{c.label}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: c.color, fontVariantNumeric: 'tabular-nums' }}>{c.value}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Surprise Bar Chart ───────────────────────────────────────────────────────

function SurpriseChart({ releases, mode }: { releases: Release[]; mode: ConsensusMode }) {
  const data = [...releases]
    .map(r => ({ date: r.date.slice(0, 7), surprise: getSurprise(r, mode) }))
    .filter(r => r.surprise != null)
    .sort((a, b) => a.date.localeCompare(b.date))

  if (data.length === 0) return null

  return (
    <div style={{ ...cardStyle, marginBottom: 24 }}>
      <div style={{ fontSize: 11, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 16, fontWeight: 600 }}>
        Surprise History (Actual − Consensus {mode === 'avg' ? 'Avg' : 'Median'})
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }} barCategoryGap="20%">
          <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.05)" />
          <XAxis
            dataKey="date"
            tick={{ fill: '#475569', fontSize: 10 }}
            axisLine={false} tickLine={false}
            interval={Math.max(0, Math.floor(data.length / 10) - 1)}
          />
          <YAxis tick={{ fill: '#475569', fontSize: 10 }} axisLine={false} tickLine={false} width={40} />
          <Tooltip
            contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: '#94a3b8', marginBottom: 4 }}
            formatter={(val: number) => [fmtSurprise(val), 'Surprise']}
          />
          <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" />
          <Bar dataKey="surprise" radius={[2, 2, 0, 0]}>
            {data.map((entry, i) => (
              <Cell key={i} fill={(entry.surprise ?? 0) >= 0 ? GREEN : RED} fillOpacity={0.75} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// ─── Release Table ────────────────────────────────────────────────────────────

function ReleaseTable({ releases }: { releases: Release[] }) {
  const th: React.CSSProperties = {
    padding: '8px 12px', textAlign: 'right', fontSize: 11, fontWeight: 600,
    color: MUTED, textTransform: 'uppercase', letterSpacing: '0.06em',
    whiteSpace: 'nowrap', borderBottom: '1px solid rgba(255,255,255,0.07)',
  }
  const td: React.CSSProperties = {
    padding: '7px 12px', textAlign: 'right', fontSize: 12,
    color: '#cbd5e1', borderBottom: '1px solid rgba(255,255,255,0.04)',
    fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
  }

  return (
    <div style={{ ...cardStyle, overflowX: 'auto' }}>
      <div style={{ fontSize: 11, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12, fontWeight: 600 }}>
        Release History
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: 'left' }}>Period</th>
            <th style={{ ...th, textAlign: 'left' }}>Release Date</th>
            <th style={th}>Actual</th>
            <th style={th}>Avg</th>
            <th style={th}>Median</th>
            <th style={th}>High</th>
            <th style={th}>Low</th>
            <th style={th}>N</th>
            <th style={th}>Surprise</th>
            <th style={th}>Z-score</th>
          </tr>
        </thead>
        <tbody>
          {releases.map(r => (
            <tr key={r.date}>
              <td style={{ ...td, textAlign: 'left', color: '#94a3b8' }}>{r.date}</td>
              <td style={{ ...td, textAlign: 'left', color: '#64748b' }}>{r.release_date ?? '—'}</td>
              <td style={{ ...td, color: '#f1f5f9', fontWeight: 600 }}>{fmt(r.actual)}</td>
              <td style={td}>{fmt(r.avg)}</td>
              <td style={td}>{fmt(r.median)}</td>
              <td style={td}>{fmt(r.high)}</td>
              <td style={td}>{fmt(r.low)}</td>
              <td style={{ ...td, color: MUTED }}>{r.n ?? '—'}</td>
              <td style={{ ...td, color: surpriseColor(r.surprise), fontWeight: 600 }}>{fmtSurprise(r.surprise)}</td>
              <td style={{ ...td, color: zColor(r.z_score), fontWeight: 600 }}>{fmt(r.z_score)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Surprise Scatter Plot ────────────────────────────────────────────────────

function SurpriseScatter({ releases, mode }: { releases: Release[]; mode: ConsensusMode }) {
  const points = [...releases]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((r, i) => ({ i, date: r.date.slice(0, 7), surprise: getSurprise(r, mode) }))
    .filter((r): r is { i: number; date: string; surprise: number } => r.surprise != null)

  if (points.length === 0) return null

  // Rolling mean (5-period)
  const WINDOW = 5
  const rollingData = points.map((p, idx) => {
    const slice = points.slice(Math.max(0, idx - WINDOW + 1), idx + 1)
    const avg = slice.reduce((a, b) => a + b.surprise, 0) / slice.length
    return { i: p.i, date: p.date, rolling: parseFloat(avg.toFixed(3)) }
  })

  return (
    <div style={{ ...cardStyle, marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
          Surprises over Time (vs {mode === 'avg' ? 'Avg' : 'Median'})
        </div>
        <div style={{ fontSize: 10, color: MUTED }}>
          — {WINDOW}-release rolling avg
        </div>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="rgba(255,255,255,0.05)" />
          <XAxis
            dataKey="i" type="number"
            domain={[0, points.length - 1]}
            ticks={points.filter((_, i) => i % Math.max(1, Math.floor(points.length / 10)) === 0).map(p => p.i)}
            tickFormatter={i => points[i]?.date ?? ''}
            tick={{ fill: '#475569', fontSize: 10 }}
            axisLine={false} tickLine={false}
          />
          <YAxis tick={{ fill: '#475569', fontSize: 10 }} axisLine={false} tickLine={false} width={40} />
          <ZAxis range={[30, 30]} />
          <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" />
          <Tooltip
            contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 12 }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null
              const d = payload[0]?.payload
              if (!d) return null
              return (
                <div style={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '8px 12px', fontSize: 12 }}>
                  <div style={{ color: '#94a3b8', marginBottom: 4 }}>{d.date}</div>
                  <div style={{ color: surpriseColor(d.surprise) }}>Surprise: {fmtSurprise(d.surprise)}</div>
                </div>
              )
            }}
          />
          <Scatter
            data={points}
            dataKey="surprise"
            shape={(props: any) => {
              const { cx, cy, payload } = props
              const color = (payload.surprise ?? 0) >= 0 ? GREEN : RED
              return <circle cx={cx} cy={cy} r={4} fill={color} fillOpacity={0.8} stroke={color} strokeOpacity={0.3} strokeWidth={6} />
            }}
          />
          <Line
            data={rollingData}
            dataKey="rolling"
            type="monotone" dot={false}
            stroke={ACCENT} strokeWidth={2} strokeOpacity={0.85}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

// ─── Distribution Chart ───────────────────────────────────────────────────────

function DistributionChart({ releases, mode }: { releases: Release[]; mode: ConsensusMode }) {
  const surprises = releases.map(r => getSurprise(r, mode)).filter((s): s is number => s != null)
  if (surprises.length < 3) return null

  const mean = surprises.reduce((a, b) => a + b, 0) / surprises.length
  const std  = Math.sqrt(surprises.reduce((a, b) => a + (b - mean) ** 2, 0) / (surprises.length - 1))

  // Build histogram bins
  const N_BINS = Math.max(8, Math.min(20, Math.round(Math.sqrt(surprises.length) * 1.5)))
  const lo = Math.min(...surprises)
  const hi = Math.max(...surprises)
  const pad = (hi - lo) * 0.15
  const binMin = lo - pad
  const binMax = hi + pad
  const binW = (binMax - binMin) / N_BINS

  const counts = Array(N_BINS).fill(0)
  for (const s of surprises) {
    const i = Math.min(N_BINS - 1, Math.floor((s - binMin) / binW))
    counts[i]++
  }

  // Normal PDF scaled to histogram area (count × binWidth)
  const area = surprises.length * binW
  const normPdf = (x: number) =>
    (area / (std * Math.sqrt(2 * Math.PI))) * Math.exp(-0.5 * ((x - mean) / std) ** 2)

  const data = counts.map((count, i) => {
    const mid = binMin + (i + 0.5) * binW
    return {
      mid: parseFloat(mid.toFixed(3)),
      label: mid.toFixed(2),
      count,
      normal: parseFloat(normPdf(mid).toFixed(3)),
    }
  })

  return (
    <div style={{ ...cardStyle, marginTop: 24 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
          Surprise Distribution (vs {mode === 'avg' ? 'Mean' : 'Median'})
        </div>
        <div style={{ display: 'flex', gap: 16 }}>
          <span style={{ fontSize: 11, color: MUTED }}>
            μ <span style={{ color: surpriseColor(mean), fontWeight: 700 }}>{fmtSurprise(mean)}</span>
          </span>
          <span style={{ fontSize: 11, color: MUTED }}>
            σ <span style={{ color: '#f1f5f9', fontWeight: 700 }}>{std.toFixed(2)}</span>
          </span>
          <span style={{ fontSize: 11, color: MUTED }}>
            n <span style={{ color: '#f1f5f9', fontWeight: 700 }}>{surprises.length}</span>
          </span>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={data} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.05)" />
          <XAxis
            dataKey="label"
            tick={{ fill: '#475569', fontSize: 10 }}
            axisLine={false} tickLine={false}
            interval={Math.max(0, Math.floor(data.length / 8) - 1)}
          />
          <YAxis tick={{ fill: '#475569', fontSize: 10 }} axisLine={false} tickLine={false} width={28} />
          <Tooltip
            contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: '#94a3b8', marginBottom: 4 }}
            formatter={(val: number, name: string) => [
              name === 'count' ? val : val.toFixed(2),
              name === 'count' ? 'Frequency' : 'Normal fit',
            ]}
          />
          {/* Mean line */}
          <ReferenceLine
            x={mean.toFixed(2)}
            stroke={ACCENT} strokeDasharray="4 3" strokeWidth={1.5}
            label={{ value: 'μ', fill: ACCENT, fontSize: 10, position: 'top' }}
          />
          {/* ±1σ lines */}
          {[mean - std, mean + std].map((v, i) => (
            <ReferenceLine
              key={i} x={v.toFixed(2)}
              stroke="rgba(255,255,255,0.18)" strokeDasharray="3 3"
              label={{ value: i === 0 ? '-1σ' : '+1σ', fill: '#475569', fontSize: 9, position: 'top' }}
            />
          ))}
          <Bar dataKey="count" radius={[3, 3, 0, 0]} maxBarSize={48}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.mid >= 0 ? GREEN : RED} fillOpacity={0.55} />
            ))}
          </Bar>
          <Line
            dataKey="normal" type="monotone" dot={false}
            stroke={ACCENT} strokeWidth={2} strokeOpacity={0.85}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

// ─── Market Reaction ──────────────────────────────────────────────────────────

interface Reaction {
  period: string
  release_date: string
  market_move: number
}

interface MarketReactionData {
  market_ticker: string
  reactions: Reaction[]
}

interface ReactionPoint {
  period: string
  release_date: string
  surprise: number
  market_move: number
}

interface OLSResult {
  slope: number
  intercept: number
  r2: number
  corr: number
}

function computeOLS(pts: ReactionPoint[]): OLSResult | null {
  const n = pts.length
  if (n < 3) return null
  const xs = pts.map(p => p.surprise), ys = pts.map(p => p.market_move)
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0)
  const sxy = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0)
  if (sxx < 1e-12) return null
  const slope     = sxy / sxx
  const intercept = my - slope * mx
  const yHat  = xs.map(x => slope * x + intercept)
  const ssRes = ys.reduce((s, y, i) => s + (y - yHat[i]) ** 2, 0)
  const ssTot = ys.reduce((s, y) => s + (y - my) ** 2, 0)
  const r2   = ssTot > 1e-12 ? 1 - ssRes / ssTot : 0
  const corr = ssTot > 1e-12 ? sxy / Math.sqrt(sxx * ssTot) : 0
  return { slope, intercept, r2, corr }
}

function MarketSummaryCards({ pts, ticker }: { pts: ReactionPoint[]; ticker: string }) {
  const ols = computeOLS(pts)
  const beats  = pts.filter(p => p.surprise > 0)
  const misses = pts.filter(p => p.surprise < 0)
  const avgMove = (arr: ReactionPoint[]) =>
    arr.length ? arr.reduce((s, p) => s + p.market_move, 0) / arr.length : null

  const cards = [
    { label: 'Observations',  value: String(pts.length),                                                  color: '#f1f5f9' },
    { label: 'Correlation',   value: ols ? ols.corr.toFixed(2) : '—',                                    color: ols ? surpriseColor(ols.corr) : MUTED },
    { label: 'Sensitivity',   value: ols ? `${ols.slope.toFixed(2)}×` : '—',                             color: '#f1f5f9' },
    { label: 'R²',            value: ols ? ols.r2.toFixed(2) : '—',                                      color: '#f1f5f9' },
    { label: 'Avg on Beat',   value: avgMove(beats)  != null ? fmtSurprise(avgMove(beats))  : '—',       color: GREEN },
    { label: 'Avg on Miss',   value: avgMove(misses) != null ? fmtSurprise(avgMove(misses)) : '—',       color: RED },
  ]

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 11, color: MUTED, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 10 }}>
        {ticker}
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {cards.map(c => (
          <div key={c.label} style={{ ...cardStyle, minWidth: 100, flex: '1 1 100px', padding: '12px 16px' }}>
            <div style={{ fontSize: 10, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>{c.label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: c.color, fontVariantNumeric: 'tabular-nums' }}>{c.value}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function ReactionScatter({ pts, consensusMode }: { pts: ReactionPoint[]; consensusMode: ConsensusMode }) {
  const ols = computeOLS(pts)
  if (pts.length < 3) return null

  const xs = pts.map(p => p.surprise)
  const xMin = Math.min(...xs), xMax = Math.max(...xs)
  const xPad = Math.max((xMax - xMin) * 0.2, 0.1)

  const regLine = ols ? [
    { x: xMin - xPad, y: ols.intercept + ols.slope * (xMin - xPad) },
    { x: xMax + xPad, y: ols.intercept + ols.slope * (xMax + xPad) },
  ] : []

  return (
    <div style={{ ...cardStyle, marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
          Surprise vs Market Move (vs {consensusMode === 'avg' ? 'Mean' : 'Median'})
        </div>
        {ols && (
          <div style={{ fontSize: 11, color: MUTED }}>
            y = <span style={{ color: '#f1f5f9' }}>{ols.slope.toFixed(2)}</span>x
            {ols.intercept >= 0 ? ' + ' : ' − '}
            <span style={{ color: '#f1f5f9' }}>{Math.abs(ols.intercept).toFixed(2)}</span>
            {'  '}R² = <span style={{ color: '#f1f5f9' }}>{ols.r2.toFixed(2)}</span>
          </div>
        )}
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <ScatterChart margin={{ top: 8, right: 16, bottom: 24, left: 8 }}>
          <CartesianGrid stroke="rgba(255,255,255,0.05)" />
          <XAxis
            dataKey="x" type="number"
            domain={[xMin - xPad, xMax + xPad]}
            tickFormatter={(v: number) => v.toFixed(2)}
            tick={{ fill: '#475569', fontSize: 10 }} axisLine={false} tickLine={false}
            label={{ value: `Surprise (vs ${consensusMode === 'avg' ? 'Mean' : 'Median'})`, position: 'insideBottom', offset: -14, fill: '#475569', fontSize: 10 }}
          />
          <YAxis
            dataKey="y" type="number"
            tick={{ fill: '#475569', fontSize: 10 }} axisLine={false} tickLine={false} width={44}
            label={{ value: 'Market Move', angle: -90, position: 'insideLeft', offset: 8, fill: '#475569', fontSize: 10 }}
          />
          <ZAxis range={[40, 40]} />
          <ReferenceLine x={0} stroke="rgba(255,255,255,0.12)" />
          <ReferenceLine y={0} stroke="rgba(255,255,255,0.12)" />
          <Tooltip
            cursor={false}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null
              const d = payload[0]?.payload as ReactionPoint & { x: number; y: number }
              return (
                <div style={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '8px 12px', fontSize: 12 }}>
                  <div style={{ color: '#94a3b8', marginBottom: 4 }}>{d.period} → {d.release_date}</div>
                  <div style={{ color: surpriseColor(d.surprise) }}>Surprise: {fmtSurprise(d.surprise)}</div>
                  <div style={{ color: surpriseColor(d.market_move) }}>Move: {fmtSurprise(d.market_move)}</div>
                </div>
              )
            }}
          />
          {/* Actual data points */}
          <Scatter
            data={pts.map(p => ({ ...p, x: p.surprise, y: p.market_move }))}
            shape={(props: any) => {
              const { cx, cy, payload } = props
              const col = payload.surprise >= 0 ? GREEN : RED
              return <circle cx={cx} cy={cy} r={5} fill={col} fillOpacity={0.75} stroke={col} strokeOpacity={0.2} strokeWidth={8} />
            }}
          />
          {/* Regression line as connected scatter */}
          {regLine.length === 2 && (
            <Scatter
              data={regLine}
              line={{ stroke: ACCENT, strokeWidth: 2, strokeDasharray: '5 3' }}
              shape={() => <g />}
              legendType="none"
            />
          )}
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  )
}

function ReactionBars({ pts }: { pts: ReactionPoint[] }) {
  const data = [...pts]
    .sort((a, b) => a.release_date.localeCompare(b.release_date))
    .map(p => ({ date: p.release_date.slice(0, 7), move: p.market_move, surprise: p.surprise }))

  if (!data.length) return null

  return (
    <div style={{ ...cardStyle, marginBottom: 20 }}>
      <div style={{ fontSize: 11, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, marginBottom: 16 }}>
        Market Move per Release
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }} barCategoryGap="20%">
          <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.05)" />
          <XAxis dataKey="date" tick={{ fill: '#475569', fontSize: 10 }} axisLine={false} tickLine={false}
            interval={Math.max(0, Math.floor(data.length / 10) - 1)} />
          <YAxis tick={{ fill: '#475569', fontSize: 10 }} axisLine={false} tickLine={false} width={40} />
          <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" />
          <Tooltip
            contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: '#94a3b8', marginBottom: 4 }}
            formatter={(val: number, _: string, entry: any) => [
              `${fmtSurprise(val)} (surprise ${fmtSurprise(entry.payload.surprise)})`,
              'Market Move',
            ]}
          />
          <Bar dataKey="move" radius={[2, 2, 0, 0]}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.surprise >= 0 ? GREEN : RED} fillOpacity={0.7} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function MarketReaction({ allReleases, filteredReleases, consensusMode }: {
  allReleases: Release[]
  filteredReleases: Release[]
  consensusMode: ConsensusMode
}) {
  const [marketTicker, setMarketTicker] = useState('')
  const [loading, setLoading]           = useState(false)
  const [error, setError]               = useState<string | null>(null)
  const [rxData, setRxData]             = useState<MarketReactionData | null>(null)

  function handleFetch() {
    const t = marketTicker.trim()
    if (!t) return
    setLoading(true)
    setError(null)

    const token = localStorage.getItem('access_token')
    // Send all releases (full history) so reactions cover the entire dataset.
    // Filtering is applied client-side below.
    const payload = {
      market_ticker: t,
      releases: allReleases
        .filter(r => r.release_date && r.surprise != null)
        .map(r => ({ period: r.date, release_date: r.release_date, surprise: r.surprise })),
    }
    axios
      .post<MarketReactionData>('/api/tools/print-analysis/market-reaction', payload, {
        headers: { Authorization: `Bearer ${token}` },
      })
      .then(res => setRxData(res.data))
      .catch(err => setError(err.response?.data?.detail ?? err.message ?? 'Unknown error'))
      .finally(() => setLoading(false))
  }

  // Join reactions with filtered releases, computing surprise using current consensusMode
  const displayPts = useMemo<ReactionPoint[]>(() => {
    if (!rxData) return []
    const rxMap = new Map(rxData.reactions.map(r => [r.period, r.market_move]))
    return filteredReleases
      .map(r => {
        const move = rxMap.get(r.date)
        if (move == null) return null
        const surprise = getSurprise(r, consensusMode)
        if (surprise == null) return null
        return { period: r.date, release_date: r.release_date ?? '—', surprise, market_move: move }
      })
      .filter((x): x is ReactionPoint => x !== null)
  }, [rxData, filteredReleases, consensusMode])

  return (
    <div style={{ marginTop: 32 }}>
      {/* Section header */}
      <div style={{ fontSize: 13, fontWeight: 700, color: '#f1f5f9', marginBottom: 16, letterSpacing: '-0.01em' }}>
        Market Reaction
      </div>

      {/* Market ticker input */}
      <div style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
        <input
          value={marketTicker}
          onChange={e => setMarketTicker(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleFetch()}
          placeholder="Market instrument — e.g. GDBR10 Index"
          style={{
            flex: 1, background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8,
            padding: '8px 14px', color: '#f1f5f9', fontSize: 13, outline: 'none',
          }}
        />
        <button
          onClick={handleFetch}
          disabled={loading || !marketTicker.trim()}
          style={{
            background: loading || !marketTicker.trim() ? 'rgba(99,102,241,0.3)' : ACCENT,
            border: 'none', borderRadius: 8, padding: '8px 20px',
            color: '#fff', fontSize: 13, fontWeight: 600,
            cursor: loading || !marketTicker.trim() ? 'default' : 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {loading ? 'Fetching…' : 'Fetch'}
        </button>
      </div>

      {error && (
        <div style={{ ...cardStyle, color: RED, fontSize: 13, marginBottom: 16, borderColor: 'rgba(239,68,68,0.25)' }}>
          {error}
        </div>
      )}

      {rxData && displayPts.length > 0 && (
        <>
          <MarketSummaryCards pts={displayPts} ticker={rxData.market_ticker} />
          <ReactionScatter pts={displayPts} consensusMode={consensusMode} />
          <ReactionBars pts={displayPts} />
        </>
      )}

      {rxData && displayPts.length === 0 && !loading && (
        <div style={{ color: MUTED, fontSize: 13 }}>No aligned observations in the current year/month selection.</div>
      )}

      {!rxData && !loading && !error && (
        <div style={{ color: MUTED, fontSize: 13 }}>Enter a market instrument ticker to analyse the reaction.</div>
      )}
    </div>
  )
}

// ─── Print vs Consensus Tab ───────────────────────────────────────────────────

function PrintVsConsensus() {
  const [ticker, setTicker] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<PrintVsConsensusData | null>(null)
  const [selectedYears, setSelectedYears]   = useState<number[]>([])
  const [selectedMonths, setSelectedMonths] = useState<number[]>(ALL_MONTHS)
  const [consensusMode, setConsensusMode]   = useState<ConsensusMode>('avg')
  const inputRef = useRef<HTMLInputElement>(null)

  function handleFetch() {
    const t = ticker.trim()
    if (!t) return
    setLoading(true)
    setError(null)

    const token = localStorage.getItem('access_token')
    axios
      .get<PrintVsConsensusData>('/api/tools/print-analysis/print-vs-consensus', {
        params: { ticker: t, start: '2000-01-01' },
        headers: { Authorization: `Bearer ${token}` },
      })
      .then(res => {
        setData(res.data)
        // Initialise year selector to all available years
        const years = [...new Set(res.data.releases.map(r => new Date(r.date).getFullYear()))].sort()
        setSelectedYears(years)
      })
      .catch(err => {
        const detail = err.response?.data?.detail ?? err.message ?? 'Unknown error'
        setError(String(detail))
      })
      .finally(() => setLoading(false))
  }

  const allYears = useMemo(
    () => data ? [...new Set(data.releases.map(r => new Date(r.date).getFullYear()))].sort() : [],
    [data],
  )

  const filteredReleases = useMemo(
    () => data ? applyFilters(data.releases, selectedYears, selectedMonths) : [],
    [data, selectedYears, selectedMonths],
  )

  const summary = useMemo(() => computeSummary(filteredReleases), [filteredReleases])

  return (
    <div>
      {/* Ticker input */}
      <div style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 }}>
        <input
          ref={inputRef}
          value={ticker}
          onChange={e => setTicker(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleFetch()}
          placeholder="Bloomberg ticker — e.g. UKPRIC YOY Index"
          style={{
            flex: 1, background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8,
            padding: '8px 14px', color: '#f1f5f9', fontSize: 13, outline: 'none',
          }}
        />
        <button
          onClick={handleFetch}
          disabled={loading || !ticker.trim()}
          style={{
            background: loading || !ticker.trim() ? 'rgba(99,102,241,0.3)' : ACCENT,
            border: 'none', borderRadius: 8, padding: '8px 20px',
            color: '#fff', fontSize: 13, fontWeight: 600,
            cursor: loading || !ticker.trim() ? 'default' : 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {loading ? 'Fetching…' : 'Fetch'}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div style={{ ...cardStyle, color: RED, fontSize: 13, marginBottom: 20, borderColor: 'rgba(239,68,68,0.25)' }}>
          {error}
        </div>
      )}

      {/* Results */}
      {data && data.releases.length > 0 && (
        <>
          <FilterBar
            allYears={allYears} selectedYears={selectedYears} onYears={setSelectedYears}
            selectedMonths={selectedMonths} onMonths={setSelectedMonths}
          />
          {filteredReleases.length > 0 ? (
            <>
              <SummaryCards summary={summary} ticker={data.ticker} />
              {/* Consensus mode toggle */}
              <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
                {(['avg', 'median'] as ConsensusMode[]).map(m => {
                  const active = consensusMode === m
                  return (
                    <button key={m} onClick={() => setConsensusMode(m)} style={{
                      background: active ? ACCENT_DIM : 'rgba(255,255,255,0.04)',
                      border: `1px solid ${active ? ACCENT_BORDER : 'rgba(255,255,255,0.08)'}`,
                      borderRadius: 6, padding: '4px 12px',
                      color: active ? ACCENT : '#64748b',
                      fontSize: 12, fontWeight: active ? 700 : 400, cursor: 'pointer',
                    }}>
                      vs {m === 'avg' ? 'Mean' : 'Median'}
                    </button>
                  )
                })}
              </div>
              <SurpriseChart releases={filteredReleases} mode={consensusMode} />
              <SurpriseScatter releases={filteredReleases} mode={consensusMode} />
              <DistributionChart releases={filteredReleases} mode={consensusMode} />
              <ReleaseTable releases={filteredReleases} />
              <MarketReaction
                allReleases={data.releases}
                filteredReleases={filteredReleases}
                consensusMode={consensusMode}
              />
            </>
          ) : (
            <div style={{ color: MUTED, fontSize: 13 }}>No years selected.</div>
          )}
        </>
      )}

      {data && data.releases.length === 0 && !loading && (
        <div style={{ color: MUTED, fontSize: 13 }}>
          No releases found for <strong style={{ color: '#f1f5f9' }}>{data.ticker}</strong>.
        </div>
      )}

      {!data && !loading && !error && (
        <div style={{ color: MUTED, fontSize: 13 }}>Enter a Bloomberg ticker to load release history.</div>
      )}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function PrintAnalysis() {
  const navigate = useNavigate()
  const [activeTab, setActiveTab] = useState<Tab>('print-vs-consensus')

  return (
    <div style={{ minHeight: '100vh', background: BG, color: '#f1f5f9', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <header style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 24px', borderBottom: '1px solid rgba(255,255,255,0.06)',
        position: 'sticky', top: 0, background: BG, zIndex: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={() => navigate('/')}
            style={{
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.10)',
              borderRadius: 8, padding: '6px 14px',
              color: '#94a3b8', fontSize: 13, cursor: 'pointer',
            }}
          >
            ← Back
          </button>
          <div>
            <div style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 700, letterSpacing: '-0.01em' }}>
              Print Analysis
            </div>
            <div style={{ color: MUTED, fontSize: 11, marginTop: 1 }}>Technicals</div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 4 }}>
          {TABS.map(({ id, label }) => {
            const active = activeTab === id
            return (
              <button key={id} onClick={() => setActiveTab(id)} style={{
                background: active ? ACCENT_DIM : 'rgba(255,255,255,0.05)',
                border: `1px solid ${active ? ACCENT_BORDER : 'rgba(255,255,255,0.08)'}`,
                borderRadius: 7, padding: '5px 14px',
                color: active ? ACCENT : '#64748b',
                fontSize: 12, fontWeight: active ? 700 : 400, cursor: 'pointer',
              }}>
                {label}
              </button>
            )
          })}
        </div>
      </header>

      <main style={{ padding: '20px 24px' }}>
        {activeTab === 'print-vs-consensus' && <PrintVsConsensus />}
      </main>
    </div>
  )
}
