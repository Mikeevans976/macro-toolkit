import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import PageTitle, { headerBar } from '../components/PageTitle'
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  ComposedChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Cell,
  Area,
} from 'recharts'
import { authFetch } from '../api/client'

// ─── Styling constants (matching dark theme) ─────────────────────────────────

const stickyBg = '#07090c'

const cardStyle: React.CSSProperties = {
  background: '#0b0f14',
  border: '1px solid rgba(150,178,205,0.09)',
  borderRadius: 6,
  padding: '24px 28px',
  marginBottom: 24,
}

// ─── Z-score colour coding ────────────────────────────────────────────────────

function zColour(z: number): string {
  if (z < -2)  return '#d9705e'
  if (z < -1)  return '#d48853'
  if (z <= 1)  return '#9aa5b1'
  if (z <= 2)  return '#6aa9cc'
  return '#3f7699'
}

const BUCKET_COLOURS: Record<string, string> = {
  whites: '#e4eaf1',
  reds:   '#ecaa9c',
  greens: '#9dd6bd',
  blues:  '#a9d2e8',
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface StatusData {
  initialised: boolean
  euribor_contract_count: number
  daily_obs_count: number
  cot_obs_count: number
  date_range: { start: string | null; end: string | null }
  last_knowledge_date: string | null
}

interface BucketData {
  net_dv01_eur: number
  zscore_1y: number
  zscore_3y: number
  history: { date: string; net_dv01_eur: number; zscore_1y: number }[]
}

interface DV01Panel {
  as_of_date: string
  buckets: Record<string, BucketData>
  total_net_dv01_eur: number
  total_zscore_1y: number
}

interface CrowdingPanel {
  as_of_date: string
  total: {
    percentile_rank: number
    recent_share_10d: number
    position_now: number
    position_10d_ago: number
  }
  by_bucket: Record<string, { percentile_rank: number; recent_share_10d: number; zscore_1y: number }>
  history: { date: string; percentile_rank: number; recent_share_10d: number }[]
}

interface CoGPanel {
  as_of_date: string
  cog_years: number
  cog_zscore: number
  history: { date: string; cog_years: number; cog_zscore: number }[]
}

interface QuadrantWindow {
  share_long_build: number
  share_short_build: number
  share_short_covering: number
  share_long_liquidation: number
  share_build: number
  share_liquidation: number
}

interface QuadrantPanel {
  as_of_date: string
  rolling_5d: QuadrantWindow
  rolling_10d: QuadrantWindow
  history: { date: string; share_long_build_5d: number; share_short_build_5d: number; share_short_covering_5d: number; share_long_liquidation_5d: number }[]
}

interface CurvePosPanel {
  as_of_date: string
  curve_zscore: number
  curve_weekly_change: number
  curve_dv01_flow_today: number
  history: { date: string; curve_zscore: number; curve_dv01_flow: number }[]
}

interface COTPanel {
  as_of_date: string
  r2: number
  nowcast_today: number
  nowcast_uncertainty: number
  last_cot_report_date: string
  last_cot_value: number
  days_since_cot: number
  history: { date: string; nowcast: number; cot_reported: number | null; uncertainty_upper: number; uncertainty_lower: number }[]
}

interface ContractRow {
  contract_id: string
  display_name: string
  pack: string | null
  generic_rank: number | null
  days_to_expiry: number | null
  is_draining: boolean
  settlement_price: number
  open_interest: number
  doi: number
  dr_bp: number
  dv01_flow_eur: number
  position_zscore: number | null
  hard_label: string
  p_long_build: number
  p_short_build: number
  p_short_covering: number
  p_long_liquidation: number
  estimator: string
  regime: string
}

interface StripPanel {
  as_of_date: string
  as_of_trade_date: string | null
  contracts: ContractRow[]
}

interface ContractHistoryRow {
  date: string
  settlement_price: number
  rate: number
  open_interest: number
  doi: number
  dr_bp: number
  oi_zscore: number
  position_zscore: number
  hard_label: string
  p_long_build: number
  p_short_build: number
  p_short_covering: number
  p_long_liquidation: number
  dv01_flow_eur: number
  estimator: string
  regime: string
  is_draining: boolean
}

interface ContractHistory {
  contract_id: string
  display_name: string
  history: ContractHistoryRow[]
  error?: string
}

interface DashboardData {
  as_of_date: string
  generated_at: string
  panels: {
    dv01_by_bucket?: DV01Panel
    crowding?: CrowdingPanel
    centre_of_gravity?: CoGPanel
    quadrant_mix?: QuadrantPanel
    curve_positioning?: CurvePosPanel
    cot_reconciliation?: COTPanel
    contract_strip?: StripPanel
  }
}

// ─── API helpers ──────────────────────────────────────────────────────────────

async function apiFetch<T>(path: string): Promise<T> {
  const res = await authFetch(path)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HTTP ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

async function apiPost<T>(path: string): Promise<T> {
  const res = await authFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HTTP ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}


// ─── Sub-components ──────────────────────────────────────────────────────────

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 500, color: '#e4eaf1', letterSpacing: '-0.01em' }}>{title}</div>
      {subtitle && <div style={{ fontSize: 12, color: '#9aa5b1', marginTop: 3 }}>{subtitle}</div>}
    </div>
  )
}

// ─── Panel 1: DV01 by Bucket ─────────────────────────────────────────────────

function DV01Panel({ panel }: { panel: DV01Panel }) {
  const buckets = ['whites', 'reds', 'greens', 'blues']
  const barData = buckets.map(b => ({
    name: b.charAt(0).toUpperCase() + b.slice(1),
    bucket: b,
    net_dv01: panel.buckets[b]?.net_dv01_eur ?? 0,
    zscore_1y: panel.buckets[b]?.zscore_1y ?? 0,
  }))

  function CustomTooltip({ active, payload, label }: any) {
    if (!active || !payload?.length) return null
    const d = payload[0].payload
    return (
      <div style={{ background: 'rgba(7,9,12,0.96)', border: '1px solid rgba(200,220,240,0.12)', borderRadius: 6, padding: '10px 14px', fontSize: 12 }}>
        <div style={{ color: '#e4eaf1', fontWeight: 600, marginBottom: 4 }}>{label}</div>
        <div style={{ color: '#9aa5b1' }}>Net DV01 <span style={{ color: '#e4eaf1' }}>{d.net_dv01.toFixed(0)} EUR</span></div>
        <div style={{ color: '#9aa5b1' }}>Z-score 1y <span style={{ color: zColour(d.zscore_1y) }}>{d.zscore_1y.toFixed(2)}</span></div>
      </div>
    )
  }

  return (
    <div className="hub-frame" style={cardStyle}>
      <SectionHeader title="Net DV01 by Tenor Bucket" subtitle="EUR per bp · colour = 1y z-score" />
      <div style={{ display: 'flex', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
        {buckets.map(b => {
          const data = panel.buckets[b]
          if (!data) return null
          const z = data.zscore_1y
          return (
            <div key={b} style={{ flex: 1, minWidth: 120, background: 'rgba(200,220,240,0.03)', border: `1px solid ${BUCKET_COLOURS[b]}33`, borderRadius: 6, padding: '12px 14px' }}>
              <div style={{ fontSize: 11, color: BUCKET_COLOURS[b], fontWeight: 600, marginBottom: 4, textTransform: 'capitalize' }}>{b}</div>
              <div style={{ fontSize: 18, fontWeight: 600, color: '#e4eaf1', fontFamily: "'Geist Mono', ui-monospace, monospace" }}>
                {data.net_dv01_eur >= 0 ? '+' : ''}{(data.net_dv01_eur / 1e6).toFixed(1)}M
              </div>
              <div style={{ fontSize: 11, marginTop: 4, color: zColour(z) }}>Z: {z >= 0 ? '+' : ''}{z.toFixed(2)}</div>
            </div>
          )
        })}
        <div style={{ flex: 1, minWidth: 120, background: 'rgba(200,220,240,0.03)', border: '1px solid rgba(200,220,240,0.1)', borderRadius: 6, padding: '12px 14px' }}>
          <div style={{ fontSize: 11, color: '#c6ced8', fontWeight: 600, marginBottom: 4 }}>TOTAL</div>
          <div style={{ fontSize: 18, fontWeight: 600, color: '#e4eaf1', fontFamily: "'Geist Mono', ui-monospace, monospace" }}>
            {panel.total_net_dv01_eur >= 0 ? '+' : ''}{(panel.total_net_dv01_eur / 1e6).toFixed(1)}M
          </div>
          <div style={{ fontSize: 11, marginTop: 4, color: zColour(panel.total_zscore_1y) }}>Z: {panel.total_zscore_1y >= 0 ? '+' : ''}{panel.total_zscore_1y.toFixed(2)}</div>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={barData} margin={{ top: 8, right: 20, bottom: 8, left: 40 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.05)" />
          <XAxis dataKey="name" tick={{ fill: '#9aa5b1', fontSize: 12 }} />
          <YAxis tickFormatter={v => `${(v / 1e6).toFixed(0)}M`} tick={{ fill: '#9aa5b1', fontSize: 11 }} />
          <Tooltip content={<CustomTooltip />} />
          <ReferenceLine y={0} stroke="rgba(200,220,240,0.2)" />
          <Bar dataKey="net_dv01" radius={[4, 4, 0, 0]}>
            {barData.map((entry) => (
              <Cell key={entry.bucket} fill={zColour(entry.zscore_1y)} fillOpacity={0.8} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// ─── Panel 2: Crowding ────────────────────────────────────────────────────────

function CrowdingPanel({ panel }: { panel: CrowdingPanel }) {
  const pct = panel.total.percentile_rank
  const pctPct = Math.round(pct * 100)

  function gaugeColour(p: number): string {
    if (p > 0.8) return '#d9705e'
    if (p > 0.6) return '#d48853'
    if (p < 0.2) return '#6aa9cc'
    if (p < 0.4) return '#9aa5b1'
    return '#5fb592'
  }

  const gc = gaugeColour(pct)
  const recentShare = panel.total.recent_share_10d

  return (
    <div className="hub-frame" style={cardStyle}>
      <SectionHeader title="Crowding" subtitle="Kalman-anchored percentile rank of total position" />
      <div style={{ display: 'flex', gap: 24, alignItems: 'center', marginBottom: 20, flexWrap: 'wrap' }}>
        {/* Gauge */}
        <div style={{ textAlign: 'center', minWidth: 120 }}>
          <div style={{ fontSize: 48, fontWeight: 600, color: gc, fontFamily: "'Geist Mono', ui-monospace, monospace", lineHeight: 1 }}>
            {pctPct}%
          </div>
          <div style={{ fontSize: 11, color: '#8995a2', marginTop: 4 }}>Percentile rank (1y)</div>
          <div style={{ marginTop: 8, height: 6, width: '100%', background: 'rgba(200,220,240,0.06)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ width: `${pctPct}%`, height: '100%', background: gc, borderRadius: 3, transition: 'width 0.5s' }} />
          </div>
        </div>
        {/* Recent share badge */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ background: 'rgba(200,220,240,0.03)', border: '1px solid rgba(200,220,240,0.07)', borderRadius: 6, padding: '10px 14px' }}>
            <div style={{ fontSize: 11, color: '#8995a2', marginBottom: 4 }}>Recent build (10d share)</div>
            <div style={{ fontSize: 20, fontWeight: 600, fontFamily: "'Geist Mono', ui-monospace, monospace", color: recentShare > 0 ? '#6aa9cc' : '#d48853' }}>
              {recentShare >= 0 ? '+' : ''}{(recentShare * 100).toFixed(1)}%
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {Object.entries(panel.by_bucket).map(([b, d]) => (
              <div key={b} style={{ background: `${BUCKET_COLOURS[b]}11`, border: `1px solid ${BUCKET_COLOURS[b]}44`, borderRadius: 6, padding: '6px 10px', minWidth: 80 }}>
                <div style={{ fontSize: 10, color: BUCKET_COLOURS[b], textTransform: 'capitalize', marginBottom: 2 }}>{b}</div>
                <div style={{ fontSize: 13, fontWeight: 600, fontFamily: "'Geist Mono', ui-monospace, monospace", color: '#e4eaf1' }}>{Math.round(d.percentile_rank * 100)}%</div>
              </div>
            ))}
          </div>
        </div>
      </div>
      {panel.history.length > 0 && (
        <ResponsiveContainer width="100%" height={100}>
          <LineChart data={panel.history.slice(-60)} margin={{ top: 4, right: 12, bottom: 4, left: 40 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.04)" />
            <XAxis dataKey="date" tick={{ fill: '#8995a2', fontSize: 9 }} tickFormatter={d => d.slice(5)} interval="preserveStartEnd" />
            <YAxis domain={[0, 1]} tickFormatter={v => `${Math.round(v * 100)}%`} tick={{ fill: '#8995a2', fontSize: 9 }} />
            <Tooltip formatter={(v: number) => `${(v * 100).toFixed(1)}%`} contentStyle={{ background: 'rgba(7,9,12,0.95)', border: '1px solid rgba(200,220,240,0.1)', borderRadius: 6 }} labelStyle={{ color: '#c6ced8' }} itemStyle={{ color: '#e4eaf1' }} />
            <ReferenceLine y={0.8} stroke="#ef444444" strokeDasharray="4 2" />
            <ReferenceLine y={0.2} stroke="#3b82f644" strokeDasharray="4 2" />
            <Line type="monotone" dataKey="percentile_rank" stroke={gc} dot={false} strokeWidth={1.5} />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}


// ─── Panel 3: Centre of Gravity ───────────────────────────────────────────────

function CoGPanel({ panel }: { panel: CoGPanel }) {
  return (
    <div className="hub-frame" style={cardStyle}>
      <SectionHeader title="Centre of Gravity" subtitle="OI-weighted maturity in years · 60-day history" />
      <div style={{ display: 'flex', gap: 24, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ background: 'rgba(200,220,240,0.03)', border: '1px solid rgba(200,220,240,0.07)', borderRadius: 6, padding: '12px 16px', minWidth: 120 }}>
          <div style={{ fontSize: 11, color: '#8995a2', marginBottom: 4 }}>CoG (years)</div>
          <div style={{ fontSize: 24, fontWeight: 600, color: '#e4eaf1', fontFamily: "'Geist Mono', ui-monospace, monospace" }}>
            {panel.cog_years.toFixed(2)}y
          </div>
        </div>
        <div style={{ background: 'rgba(200,220,240,0.03)', border: '1px solid rgba(200,220,240,0.07)', borderRadius: 6, padding: '12px 16px', minWidth: 120 }}>
          <div style={{ fontSize: 11, color: '#8995a2', marginBottom: 4 }}>Z-score (1y)</div>
          <div style={{ fontSize: 24, fontWeight: 600, fontFamily: "'Geist Mono', ui-monospace, monospace", color: zColour(panel.cog_zscore) }}>
            {panel.cog_zscore >= 0 ? '+' : ''}{panel.cog_zscore.toFixed(2)}
          </div>
        </div>
      </div>
      {panel.history.length > 0 && (
        <ResponsiveContainer width="100%" height={160}>
          <LineChart data={panel.history.slice(-60)} margin={{ top: 8, right: 20, bottom: 8, left: 40 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.05)" />
            <XAxis dataKey="date" tick={{ fill: '#9aa5b1', fontSize: 9 }} tickFormatter={d => d.slice(5)} interval="preserveStartEnd" />
            <YAxis domain={['auto', 'auto']} tick={{ fill: '#9aa5b1', fontSize: 10 }} tickFormatter={v => `${v.toFixed(1)}y`} />
            <Tooltip
              formatter={(v: number) => `${v.toFixed(2)}y`}
              contentStyle={{ background: 'rgba(7,9,12,0.95)', border: '1px solid rgba(200,220,240,0.1)', borderRadius: 6 }}
              labelStyle={{ color: '#c6ced8' }}
              itemStyle={{ color: '#e4eaf1' }}
            />
            <Line type="monotone" dataKey="cog_years" stroke="#a9d2e8" dot={false} strokeWidth={1.5} name="CoG (y)" />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}

// ─── Panel 4: Quadrant Mix ────────────────────────────────────────────────────

function QuadrantPanel({ panel }: { panel: QuadrantPanel }) {
  const QUAD_COLOURS: Record<string, string> = {
    long_build:        '#6aa9cc',
    short_build:       '#d9705e',
    short_covering:    '#5fb592',
    long_liquidation:  '#d48853',
  }

  function WindowBar({ title, data }: { title: string; data: QuadrantWindow }) {
    const items = [
      { key: 'long_build',       label: 'Long Build',       value: data.share_long_build,       colour: QUAD_COLOURS.long_build },
      { key: 'short_build',      label: 'Short Build',      value: data.share_short_build,      colour: QUAD_COLOURS.short_build },
      { key: 'short_covering',   label: 'Short Covering',   value: data.share_short_covering,   colour: QUAD_COLOURS.short_covering },
      { key: 'long_liquidation', label: 'Long Liquidation', value: data.share_long_liquidation, colour: QUAD_COLOURS.long_liquidation },
    ]
    return (
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ fontSize: 12, color: '#c6ced8', fontWeight: 600, marginBottom: 8 }}>{title}</div>
        <div style={{ display: 'flex', height: 28, borderRadius: 4, overflow: 'hidden', marginBottom: 8 }}>
          {items.map(it => (
            <div key={it.key} style={{ width: `${it.value * 100}%`, background: it.colour, opacity: 0.8 }} title={`${it.label}: ${(it.value * 100).toFixed(1)}%`} />
          ))}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {items.map(it => (
            <div key={it.key} style={{ fontSize: 11, color: it.colour, display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: it.colour, display: 'inline-block', opacity: 0.8 }} />
              {it.label}: <strong>{(it.value * 100).toFixed(1)}%</strong>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="hub-frame" style={cardStyle}>
      <SectionHeader title="Quadrant Mix" subtitle="Share of DV01 flow by market behaviour — rolling windows" />
      <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
        <WindowBar title="5-Day Window" data={panel.rolling_5d} />
        <WindowBar title="10-Day Window" data={panel.rolling_10d} />
      </div>
    </div>
  )
}

// ─── Panel 5: Curve Positioning ───────────────────────────────────────────────

function CurvePosPanel({ panel }: { panel: CurvePosPanel }) {
  return (
    <div className="hub-frame" style={cardStyle}>
      <SectionHeader title="Curve Positioning" subtitle="Spread-attributed z-score history" />
      <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ background: 'rgba(200,220,240,0.03)', border: '1px solid rgba(200,220,240,0.07)', borderRadius: 6, padding: '12px 16px' }}>
          <div style={{ fontSize: 11, color: '#8995a2', marginBottom: 4 }}>Curve Z-score</div>
          <div style={{ fontSize: 22, fontWeight: 600, fontFamily: "'Geist Mono', ui-monospace, monospace", color: zColour(panel.curve_zscore) }}>
            {panel.curve_zscore >= 0 ? '+' : ''}{panel.curve_zscore.toFixed(2)}
          </div>
        </div>
        <div style={{ background: 'rgba(200,220,240,0.03)', border: '1px solid rgba(200,220,240,0.07)', borderRadius: 6, padding: '12px 16px' }}>
          <div style={{ fontSize: 11, color: '#8995a2', marginBottom: 4 }}>Weekly change</div>
          <div style={{ fontSize: 22, fontWeight: 600, fontFamily: "'Geist Mono', ui-monospace, monospace", color: panel.curve_weekly_change >= 0 ? '#6aa9cc' : '#d48853' }}>
            {panel.curve_weekly_change >= 0 ? '+' : ''}{panel.curve_weekly_change.toFixed(2)}
          </div>
        </div>
        <div style={{ background: 'rgba(200,220,240,0.03)', border: '1px solid rgba(200,220,240,0.07)', borderRadius: 6, padding: '12px 16px' }}>
          <div style={{ fontSize: 11, color: '#8995a2', marginBottom: 4 }}>DV01 flow today</div>
          <div style={{ fontSize: 22, fontWeight: 600, fontFamily: "'Geist Mono', ui-monospace, monospace", color: '#e4eaf1' }}>
            {panel.curve_dv01_flow_today >= 0 ? '+' : ''}{(panel.curve_dv01_flow_today / 1e3).toFixed(1)}K
          </div>
        </div>
      </div>
      {panel.history.length > 0 && (
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={panel.history.slice(-252)} margin={{ top: 8, right: 20, bottom: 8, left: 40 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.05)" />
            <XAxis dataKey="date" tick={{ fill: '#9aa5b1', fontSize: 9 }} tickFormatter={d => d.slice(5)} interval="preserveStartEnd" />
            <YAxis tick={{ fill: '#9aa5b1', fontSize: 10 }} />
            <Tooltip
              contentStyle={{ background: 'rgba(7,9,12,0.95)', border: '1px solid rgba(200,220,240,0.1)', borderRadius: 6 }}
              labelStyle={{ color: '#c6ced8' }}
              itemStyle={{ color: '#e4eaf1' }}
            />
            <ReferenceLine y={2}  stroke="#3b82f644" strokeDasharray="4 2" />
            <ReferenceLine y={-2} stroke="#ef444444" strokeDasharray="4 2" />
            <ReferenceLine y={0}  stroke="rgba(200,220,240,0.15)" />
            <Line type="monotone" dataKey="curve_zscore" stroke="#a9d2e8" dot={false} strokeWidth={1.5} name="Curve Z" />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}


// ─── Panel 6: COT Reconciliation ──────────────────────────────────────────────

function COTPanel({ panel }: { panel: COTPanel }) {
  const r2Colour = panel.r2 >= 0.6 ? '#5fb592' : panel.r2 >= 0.3 ? '#d48853' : '#d9705e'

  return (
    <div className="hub-frame" style={cardStyle}>
      <SectionHeader title="COT Reconciliation" subtitle="Kalman nowcast vs reported COT" />
      <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ background: 'rgba(200,220,240,0.03)', border: '1px solid rgba(200,220,240,0.07)', borderRadius: 6, padding: '12px 16px' }}>
          <div style={{ fontSize: 11, color: '#8995a2', marginBottom: 4 }}>Nowcast today</div>
          <div style={{ fontSize: 22, fontWeight: 600, fontFamily: "'Geist Mono', ui-monospace, monospace", color: '#e4eaf1' }}>
            {panel.nowcast_today >= 0 ? '+' : ''}{Math.round(panel.nowcast_today).toLocaleString()}
          </div>
          <div style={{ fontSize: 10, color: '#8995a2', marginTop: 2 }}>±{Math.round(panel.nowcast_uncertainty).toLocaleString()}</div>
        </div>
        <div style={{ background: 'rgba(200,220,240,0.03)', border: '1px solid rgba(200,220,240,0.07)', borderRadius: 6, padding: '12px 16px' }}>
          <div style={{ fontSize: 11, color: '#8995a2', marginBottom: 4 }}>Last COT report</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#e4eaf1' }}>{panel.last_cot_report_date || '—'}</div>
          <div style={{ fontSize: 10, color: '#8995a2', marginTop: 2 }}>{panel.days_since_cot}d ago</div>
        </div>
        <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', background: `${r2Colour}11`, border: `1px solid ${r2Colour}44`, borderRadius: 6, padding: '12px 16px' }}>
          <div style={{ fontSize: 10, color: '#8995a2', marginBottom: 2 }}>R²</div>
          <div style={{ fontSize: 22, fontWeight: 600, fontFamily: "'Geist Mono', ui-monospace, monospace", color: r2Colour }}>
            {panel.r2.toFixed(3)}
          </div>
        </div>
      </div>
      {panel.history.length > 0 && (
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={panel.history.slice(-260)} margin={{ top: 8, right: 20, bottom: 8, left: 40 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.05)" />
            <XAxis dataKey="date" tick={{ fill: '#9aa5b1', fontSize: 9 }} tickFormatter={d => d.slice(5)} interval="preserveStartEnd" />
            <YAxis tick={{ fill: '#9aa5b1', fontSize: 10 }} tickFormatter={v => (v / 1000).toFixed(0) + 'K'} />
            <Tooltip
              contentStyle={{ background: 'rgba(7,9,12,0.95)', border: '1px solid rgba(200,220,240,0.1)', borderRadius: 6 }}
              labelStyle={{ color: '#c6ced8' }}
              itemStyle={{ color: '#e4eaf1' }}
              formatter={(v: number) => [Math.round(v).toLocaleString(), '']}
            />
            <Line type="monotone" dataKey="nowcast" stroke="#a9d2e8" dot={false} strokeWidth={1.5} name="Nowcast" />
            <Line type="monotone" dataKey="cot_reported" stroke="#dfbb78" dot={{ r: 3, fill: '#dfbb78' }} strokeWidth={0} name="COT Reported" connectNulls={false} />
            <Line type="monotone" dataKey="uncertainty_upper" stroke="#93c5fd33" dot={false} strokeWidth={1} strokeDasharray="4 2" name="Upper ±1σ" />
            <Line type="monotone" dataKey="uncertainty_lower" stroke="#93c5fd33" dot={false} strokeWidth={1} strokeDasharray="4 2" name="Lower ±1σ" />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}

// ─── Panel 7: Contract Strip ──────────────────────────────────────────────────

const QUAD_COLOURS: Record<string, string> = {
  long_build:        '#6aa9cc',
  short_build:       '#d9705e',
  short_covering:    '#5fb592',
  long_liquidation:  '#d48853',
  unclassified:      '#9aa5b1',
}

function fmtOI(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000)     return `${(n / 1_000).toFixed(0)}k`
  return String(n)
}

function fmtDV01(n: number): string {
  const abs = Math.abs(n)
  const sign = n >= 0 ? '+' : ''
  if (abs >= 1_000_000) return `${sign}${(n / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000)     return `${sign}${(n / 1_000).toFixed(1)}k`
  return `${sign}${n.toFixed(0)}`
}

function ContractStripPanel({
  panel,
  selectedContractId,
  onSelectContract,
}: {
  panel: StripPanel
  selectedContractId?: string | null
  onSelectContract?: (contractId: string) => void
}) {
  const thStyle: React.CSSProperties = {
    textAlign: 'right',
    padding: '6px 10px',
    color: '#8995a2',
    fontWeight: 500,
    fontSize: 11,
    whiteSpace: 'nowrap',
    borderBottom: '1px solid rgba(200,220,240,0.08)',
  }
  const thLeft: React.CSSProperties = { ...thStyle, textAlign: 'left' }
  const tdStyle: React.CSSProperties = {
    textAlign: 'right',
    padding: '5px 10px',
    fontSize: 12,
    fontFamily: "'Geist Mono', ui-monospace, monospace",
    borderBottom: '1px solid rgba(200,220,240,0.04)',
    whiteSpace: 'nowrap',
  }
  const tdLeft: React.CSSProperties = { ...tdStyle, textAlign: 'left', fontFamily: 'inherit' }

  // Soft probability mini-bar (4 segments)
  function ProbBar({ c }: { c: ContractRow }) {
    const segs = [
      { p: c.p_long_build,       color: QUAD_COLOURS.long_build },
      { p: c.p_short_build,      color: QUAD_COLOURS.short_build },
      { p: c.p_short_covering,   color: QUAD_COLOURS.short_covering },
      { p: c.p_long_liquidation, color: QUAD_COLOURS.long_liquidation },
    ]
    return (
      <div style={{ display: 'flex', height: 4, width: 60, borderRadius: 2, overflow: 'hidden', gap: 0 }}>
        {segs.map((s, i) => (
          <div key={i} style={{ width: `${s.p * 100}%`, background: s.color, opacity: 0.75 }} />
        ))}
      </div>
    )
  }

  return (
    <div className="hub-frame" style={cardStyle}>
      <SectionHeader
        title="Contract Strip"
        subtitle={`Per-contract snapshot · ${panel.as_of_trade_date ?? panel.as_of_date}`}
      />
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={thLeft}>Contract</th>
              <th style={thStyle}>OI</th>
              <th style={thStyle}>ΔOI</th>
              <th style={thStyle}>Δr bp</th>
              <th style={thStyle}>DV01 Flow</th>
              <th style={thStyle}>Pos Z</th>
              <th style={thLeft}>Quadrant</th>
              <th style={thStyle}>Exp</th>
            </tr>
          </thead>
          <tbody>
            {panel.contracts.map(c => {
              const qc = QUAD_COLOURS[c.hard_label] ?? QUAD_COLOURS.unclassified
              const bc = BUCKET_COLOURS[c.pack ?? ''] ?? '#c6ced8'
              const draining = c.is_draining
              const isSelected = selectedContractId === c.contract_id
              return (
                <tr
                  key={c.contract_id}
                  onClick={() => onSelectContract?.(c.contract_id)}
                  style={{
                    opacity: draining ? 0.38 : 1,
                    cursor: onSelectContract ? 'pointer' : 'default',
                    background: isSelected ? 'rgba(106,169,204,0.09)' : undefined,
                    outline: isSelected ? '1px solid rgba(106,169,204,0.35)' : undefined,
                  }}
                >
                  {/* Contract name + bucket chip */}
                  <td style={tdLeft}>
                    <span style={{ fontWeight: 600, fontFamily: "'Geist Mono', ui-monospace, monospace", color: bc, fontSize: 13 }}>
                      {c.display_name}
                    </span>
                    {draining && (
                      <span style={{
                        marginLeft: 6, fontSize: 9, color: '#d9705e',
                        background: 'rgba(217,112,94,0.12)', padding: '1px 5px', borderRadius: 3,
                        verticalAlign: 'middle',
                      }}>drain</span>
                    )}
                    {c.regime === 'churn' && !draining && (
                      <span style={{
                        marginLeft: 6, fontSize: 9, color: '#c6ced8',
                        background: 'rgba(162,174,187,0.1)', padding: '1px 5px', borderRadius: 3,
                        verticalAlign: 'middle',
                      }}>churn</span>
                    )}
                  </td>
                  {/* OI */}
                  <td style={{ ...tdStyle, color: '#c6ced8' }}>{fmtOI(c.open_interest)}</td>
                  {/* ΔOI */}
                  <td style={{ ...tdStyle, color: c.doi >= 0 ? '#6aa9cc' : '#d9705e' }}>
                    {c.doi >= 0 ? '+' : ''}{fmtOI(c.doi)}
                  </td>
                  {/* Δr bp — negative = rates fell = bullish = blue */}
                  <td style={{ ...tdStyle, color: c.dr_bp <= 0 ? '#6aa9cc' : '#d9705e' }}>
                    {c.dr_bp >= 0 ? '+' : ''}{c.dr_bp.toFixed(1)}
                  </td>
                  {/* DV01 flow */}
                  <td style={{ ...tdStyle, color: c.dv01_flow_eur >= 0 ? '#6aa9cc' : '#d9705e' }}>
                    {fmtDV01(c.dv01_flow_eur)}
                  </td>
                  {/* Position z-score */}
                  <td style={{ ...tdStyle, color: c.position_zscore != null ? zColour(c.position_zscore) : '#8995a2' }}>
                    {c.position_zscore != null
                      ? `${c.position_zscore >= 0 ? '+' : ''}${c.position_zscore.toFixed(2)}`
                      : '—'}
                  </td>
                  {/* Quadrant label + mini prob bar */}
                  <td style={tdLeft}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <span style={{
                        display: 'inline-block',
                        background: `${qc}1a`, color: qc,
                        border: `1px solid ${qc}55`,
                        padding: '1px 7px', borderRadius: 4, fontSize: 11, fontWeight: 500,
                        letterSpacing: '0.01em',
                      }}>
                        {c.hard_label.replace(/_/g, ' ')}
                      </span>
                      <ProbBar c={c} />
                    </div>
                  </td>
                  {/* Days to expiry */}
                  <td style={{
                    ...tdStyle,
                    color: c.days_to_expiry != null && c.days_to_expiry < 30 ? '#d48853' : '#9aa5b1',
                  }}>
                    {c.days_to_expiry != null ? `${c.days_to_expiry}d` : '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}


// ─── Contract Detail Panel ────────────────────────────────────────────────────

function ContractDetailPanel({
  history,
  displayName,
  onClose,
}: {
  history: ContractHistory
  displayName: string
  onClose: () => void
}) {
  const data = history.history

  if (!data.length) {
    return (
      <div className="hub-frame" style={cardStyle}>
        <div style={{ color: '#8995a2', textAlign: 'center', padding: 32 }}>No history available</div>
      </div>
    )
  }

  // Tick formatter: show only month/year transitions to avoid clutter
  function dateTick(val: string) {
    if (!val) return ''
    const d = new Date(val)
    return `${d.toLocaleString('default', { month: 'short' })} ${String(d.getFullYear()).slice(2)}`
  }

  // Custom tooltip shared across charts
  function CustomTooltip({ active, payload, label }: any) {
    if (!active || !payload?.length) return null
    return (
      <div style={{ background: 'rgba(7,9,12,0.97)', border: '1px solid rgba(200,220,240,0.12)', borderRadius: 6, padding: '8px 12px', fontSize: 11 }}>
        <div style={{ color: '#c6ced8', marginBottom: 4 }}>{label}</div>
        {payload.map((p: any, i: number) => (
          <div key={i} style={{ color: p.color ?? '#e4eaf1' }}>
            {p.name}: <span style={{ fontFamily: "'Geist Mono', ui-monospace, monospace" }}>{typeof p.value === 'number' ? p.value.toFixed(2) : p.value}</span>
          </div>
        ))}
      </div>
    )
  }

  // Subsample ticks to ~8 labels
  const ticks: string[] = []
  const step = Math.max(1, Math.floor(data.length / 8))
  for (let i = 0; i < data.length; i += step) ticks.push(data[i].date)

  return (
    <div className="hub-frame" style={{ ...cardStyle, borderColor: 'rgba(106,169,204,0.25)' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <span style={{ fontSize: 16, fontWeight: 600, fontFamily: "'Geist Mono', ui-monospace, monospace", color: '#a9d2e8' }}>{displayName}</span>
          <span style={{ fontSize: 12, color: '#8995a2', marginLeft: 10 }}>
            {data.length}d history · last {data[data.length - 1]?.date}
          </span>
        </div>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', color: '#8995a2', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}
        >×</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>

        {/* Chart 1: Open Interest + ΔOI */}
        <div>
          <div style={{ fontSize: 11, color: '#8995a2', marginBottom: 8 }}>Open Interest &amp; ΔOI</div>
          <ResponsiveContainer width="100%" height={160}>
            <ComposedChart data={data} margin={{ top: 4, right: 12, bottom: 4, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.04)" />
              <XAxis dataKey="date" ticks={ticks} tickFormatter={dateTick} tick={{ fill: '#8995a2', fontSize: 10 }} />
              <YAxis yAxisId="oi" orientation="left" tickFormatter={v => fmtOI(v)} tick={{ fill: '#8995a2', fontSize: 10 }} />
              <YAxis yAxisId="doi" orientation="right" tickFormatter={v => fmtOI(v)} tick={{ fill: '#8995a2', fontSize: 10 }} />
              <Tooltip content={<CustomTooltip />} />
              <Line yAxisId="oi" type="monotone" dataKey="open_interest" name="OI" stroke="#c6ced8" dot={false} strokeWidth={1.5} />
              <Bar yAxisId="doi" dataKey="doi" name="ΔOI" radius={[1, 1, 0, 0]}>
                {data.map((d, i) => (
                  <Cell key={i} fill={d.doi >= 0 ? '#6aa9cc' : '#d9705e'} fillOpacity={0.7} />
                ))}
              </Bar>
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* Chart 2: Rate (basis points from par) */}
        <div>
          <div style={{ fontSize: 11, color: '#8995a2', marginBottom: 8 }}>Rate (100 − price)</div>
          <ResponsiveContainer width="100%" height={160}>
            <ComposedChart data={data} margin={{ top: 4, right: 12, bottom: 4, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.04)" />
              <XAxis dataKey="date" ticks={ticks} tickFormatter={dateTick} tick={{ fill: '#8995a2', fontSize: 10 }} />
              <YAxis tick={{ fill: '#8995a2', fontSize: 10 }} tickFormatter={v => `${v.toFixed(2)}%`} />
              <Tooltip content={<CustomTooltip />} />
              <Area
                type="monotone"
                dataKey="rate"
                name="Rate %"
                stroke="#a08bd2"
                fill="rgba(160,139,210,0.08)"
                dot={false}
                strokeWidth={1.5}
              />
              <Bar dataKey="dr_bp" name="Δr bp" radius={[1, 1, 0, 0]} yAxisId={undefined}>
                {data.map((d, i) => (
                  <Cell key={i} fill={d.dr_bp <= 0 ? '#3b82f680' : '#ef444480'} />
                ))}
              </Bar>
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* Chart 3: Position Z-score */}
        <div>
          <div style={{ fontSize: 11, color: '#8995a2', marginBottom: 8 }}>Position Z-score (252d)</div>
          <ResponsiveContainer width="100%" height={160}>
            <ComposedChart data={data} margin={{ top: 4, right: 12, bottom: 4, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.04)" />
              <XAxis dataKey="date" ticks={ticks} tickFormatter={dateTick} tick={{ fill: '#8995a2', fontSize: 10 }} />
              <YAxis tick={{ fill: '#8995a2', fontSize: 10 }} />
              <Tooltip content={<CustomTooltip />} />
              <ReferenceLine y={0} stroke="rgba(200,220,240,0.15)" />
              <ReferenceLine y={2} stroke="rgba(217,112,94,0.3)" strokeDasharray="4 2" />
              <ReferenceLine y={-2} stroke="rgba(106,169,204,0.3)" strokeDasharray="4 2" />
              <Bar dataKey="position_zscore" name="Pos Z" radius={[1, 1, 0, 0]}>
                {data.map((d, i) => (
                  <Cell key={i} fill={d.position_zscore >= 0 ? '#6aa9cc' : '#d9705e'} fillOpacity={0.75} />
                ))}
              </Bar>
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* Chart 4: Quadrant probabilities over time */}
        <div>
          <div style={{ fontSize: 11, color: '#8995a2', marginBottom: 8 }}>Daily Quadrant Probabilities</div>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={data} margin={{ top: 4, right: 12, bottom: 4, left: 8 }} stackOffset="expand">
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.04)" />
              <XAxis dataKey="date" ticks={ticks} tickFormatter={dateTick} tick={{ fill: '#8995a2', fontSize: 10 }} />
              <YAxis tickFormatter={v => `${Math.round(v * 100)}%`} tick={{ fill: '#8995a2', fontSize: 10 }} />
              <Tooltip
                content={({ active, payload, label }: any) => {
                  if (!active || !payload?.length) return null
                  return (
                    <div style={{ background: 'rgba(7,9,12,0.97)', border: '1px solid rgba(200,220,240,0.12)', borderRadius: 6, padding: '8px 12px', fontSize: 11 }}>
                      <div style={{ color: '#c6ced8', marginBottom: 4 }}>{label}</div>
                      {payload.map((p: any, i: number) => (
                        <div key={i} style={{ color: p.fill }}>
                          {p.name}: {(p.value * 100).toFixed(0)}%
                        </div>
                      ))}
                    </div>
                  )
                }}
              />
              <Bar dataKey="p_long_build" name="Long Build" stackId="q" fill={QUAD_COLOURS.long_build} fillOpacity={0.8} />
              <Bar dataKey="p_short_build" name="Short Build" stackId="q" fill={QUAD_COLOURS.short_build} fillOpacity={0.8} />
              <Bar dataKey="p_short_covering" name="Short Cover" stackId="q" fill={QUAD_COLOURS.short_covering} fillOpacity={0.8} />
              <Bar dataKey="p_long_liquidation" name="Long Liq" stackId="q" fill={QUAD_COLOURS.long_liquidation} fillOpacity={0.8} />
            </BarChart>
          </ResponsiveContainer>
        </div>

      </div>
    </div>
  )
}


// ─── Status Bar ───────────────────────────────────────────────────────────────

function StatusBar({
  status,
  onInit,
  initLoading,
}: {
  status: StatusData
  onInit: () => void
  initLoading: boolean
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
      background: status.initialised ? 'rgba(95,181,146,0.06)' : 'rgba(214,173,102,0.06)',
      border: `1px solid ${status.initialised ? 'rgba(95,181,146,0.2)' : 'rgba(214,173,102,0.2)'}`,
      borderRadius: 6, padding: '12px 18px', marginBottom: 24,
    }}>
      <div style={{
        width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
        background: status.initialised ? '#5fb592' : '#d6ad66',
      }} />
      <div style={{ fontSize: 13, color: '#c6ced8' }}>
        {status.initialised
          ? `DB ready · ${status.daily_obs_count.toLocaleString()} daily obs · ${status.cot_obs_count.toLocaleString()} COT reports`
          : 'DB not initialised'}
      </div>
      {status.last_knowledge_date && (
        <div style={{ fontSize: 12, color: '#8995a2' }}>Last data: {status.last_knowledge_date}</div>
      )}
      {!status.initialised && (
        <button
          onClick={onInit}
          disabled={initLoading}
          style={{
            marginLeft: 'auto', padding: '6px 18px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: initLoading ? 'not-allowed' : 'pointer',
            border: '1px solid rgba(214,173,102,0.4)', background: 'rgba(214,173,102,0.1)', color: '#dfbb78',
            opacity: initLoading ? 0.6 : 1,
          }}
        >
          {initLoading ? 'Initialising…' : 'Initialise DB'}
        </button>
      )}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

// ─── Instrument registry (mirrors params.yaml) ───────────────────────────────

const INSTRUMENTS: { key: string; label: string; type: 'stir' | 'bond'; currency: string }[] = [
  { key: 'euribor',   label: 'Euribor 3M',    type: 'stir', currency: 'EUR' },
  { key: 'sofr',      label: 'SOFR 3M',       type: 'stir', currency: 'USD' },
  { key: 'sonia',     label: 'SONIA 3M',      type: 'stir', currency: 'GBP' },
  { key: 'schatz',    label: 'Schatz 2y',     type: 'bond', currency: 'EUR' },
  { key: 'bobl',      label: 'Bobl 5y',       type: 'bond', currency: 'EUR' },
  { key: 'bund',      label: 'Bund 10y',      type: 'bond', currency: 'EUR' },
  { key: 'buxl',      label: 'Buxl 30y',      type: 'bond', currency: 'EUR' },
  { key: 'oat',       label: 'OAT 10y',       type: 'bond', currency: 'EUR' },
  { key: 'btp',       label: 'BTP 10y',       type: 'bond', currency: 'EUR' },
  { key: 'ust2',      label: 'US 2y Note',    type: 'bond', currency: 'USD' },
  { key: 'ust5',      label: 'US 5y Note',    type: 'bond', currency: 'USD' },
  { key: 'ust10',     label: 'US 10y Note',   type: 'bond', currency: 'USD' },
  { key: 'ust30',     label: 'US 30y Bond',   type: 'bond', currency: 'USD' },
  { key: 'ust_ultra', label: 'US Ultra Bond', type: 'bond', currency: 'USD' },
]

// ─── Main component ───────────────────────────────────────────────────────────

const STIR_INSTRUMENTS = new Set(['euribor', 'sofr', 'sonia'])

export default function PositioningTracker() {
  const navigate = useNavigate()
  const [instrument, setInstrument]           = useState('euribor')
  const [status, setStatus]                   = useState<StatusData | null>(null)
  const [dashboard, setDashboard]             = useState<DashboardData | null>(null)
  const [loading, setLoading]                 = useState(true)
  const [error, setError]                     = useState<string | null>(null)
  const [initLoading, setInitLoading]         = useState(false)
  const [selectedContract, setSelectedContract] = useState<string | null>(null)
  const [contractHistory, setContractHistory] = useState<ContractHistory | null>(null)
  const [historyLoading, setHistoryLoading]   = useState(false)

  const isStir = STIR_INSTRUMENTS.has(instrument)

  async function fetchAll(inst: string = instrument) {
    setLoading(true)
    setError(null)
    setSelectedContract(null)
    setContractHistory(null)
    try {
      const st = await apiFetch<StatusData>('/api/positioning/status')
      setStatus(st)
      if (st.initialised) {
        const db = await apiFetch<DashboardData>(`/api/positioning/dashboard?instrument=${inst}`)
        setDashboard(db)
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('401')) {
        localStorage.removeItem('access_token')
        navigate('/login', { replace: true })
      } else {
        setError(msg)
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchAll(instrument)
  }, [instrument])

  async function handleSelectContract(contractId: string) {
    if (!isStir) return
    // Toggle: clicking the selected contract deselects it
    if (selectedContract === contractId) {
      setSelectedContract(null)
      setContractHistory(null)
      return
    }
    setSelectedContract(contractId)
    setHistoryLoading(true)
    try {
      const hist = await apiFetch<ContractHistory>(
        `/api/positioning/contract/${encodeURIComponent(contractId)}?instrument=${instrument}`
      )
      setContractHistory(hist)
    } catch {
      setContractHistory(null)
    } finally {
      setHistoryLoading(false)
    }
  }

  async function handleInit() {
    setInitLoading(true)
    setError(null)
    try {
      await apiPost('/api/positioning/init')
      await fetchAll(instrument)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setInitLoading(false)
    }
  }

  const panels = dashboard?.panels
  const instrumentLabel = INSTRUMENTS.find(i => i.key === instrument)?.label ?? instrument

  return (
    <div style={{ minHeight: '100vh', background: stickyBg, color: '#e4eaf1', padding: '0 0 80px 0' }}>

      {/* Header */}
      <div style={{
        ...headerBar,
        padding: '12px 32px', display: 'flex', alignItems: 'center', gap: 16,
        flexWrap: 'wrap',
      }}>
        <PageTitle
          category="Futures / Swaps / Vol"
          categoryId="futures-swaps-vol"
          title={`${instrumentLabel} Positioning`}
          subtitle="Net DV01 by strip bucket · spread-corrected · Kalman-anchored"
        />
        <span style={{ width: 1, alignSelf: 'stretch', background: 'rgba(150,178,205,0.09)', margin: '2px 4px' }} />

        {/* Instrument selector */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {/* STIR group */}
          {INSTRUMENTS.filter(i => i.type === 'stir').map(i => (
            <button
              key={i.key}
              onClick={() => setInstrument(i.key)}
              style={{
                padding: '4px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                border: instrument === i.key ? '1px solid #6aa9cc' : '1px solid rgba(200,220,240,0.12)',
                background: instrument === i.key ? 'rgba(106,169,204,0.18)' : 'rgba(200,220,240,0.04)',
                color: instrument === i.key ? '#a9d2e8' : '#c6ced8',
                fontWeight: instrument === i.key ? 600 : 400,
              }}
            >{i.label}</button>
          ))}
          <span style={{ color: 'rgba(200,220,240,0.15)', alignSelf: 'center' }}>|</span>
          {/* Bond group */}
          {INSTRUMENTS.filter(i => i.type === 'bond').map(i => (
            <button
              key={i.key}
              onClick={() => setInstrument(i.key)}
              style={{
                padding: '4px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                border: instrument === i.key ? '1px solid #a08bd2' : '1px solid rgba(200,220,240,0.12)',
                background: instrument === i.key ? 'rgba(160,139,210,0.18)' : 'rgba(200,220,240,0.04)',
                color: instrument === i.key ? '#cbbde8' : '#c6ced8',
                fontWeight: instrument === i.key ? 600 : 400,
              }}
            >{i.label}</button>
          ))}
        </div>

        {dashboard && (
          <span className="hub-num" style={{ marginLeft: 'auto', fontSize: 11, color: '#9aa5b1', display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#6fc2a2', boxShadow: '0 0 0 3px rgba(111,194,162,0.12)' }} />
            As of {dashboard.as_of_date}
          </span>
        )}
      </div>

      <div style={{ maxWidth: 1400, margin: '0 auto', padding: '32px 32px 0' }}>

        {loading && (
          <div style={{ textAlign: 'center', padding: 80, color: '#8995a2' }}>Loading…</div>
        )}

        {error && (
          <div style={{ color: '#e2826f', padding: 24, background: 'rgba(217,112,94,0.08)', border: '1px solid rgba(217,112,94,0.2)', borderRadius: 6, marginBottom: 24 }}>
            Error: {error}
          </div>
        )}

        {!loading && status && (
          <StatusBar status={status} onInit={handleInit} initLoading={initLoading} />
        )}

        {!loading && status && !status.initialised && (
          <div className="hub-frame" style={cardStyle}>
            <div style={{ textAlign: 'center', padding: '40px 0', color: '#8995a2' }}>
              <div style={{ fontSize: 16, marginBottom: 8, color: '#c6ced8' }}>Database not initialised</div>
              <div style={{ fontSize: 13 }}>Click "Initialise DB" above to seed contracts and simulate 2 years of data.</div>
            </div>
          </div>
        )}

        {!loading && panels && (
          <>
            {panels.contract_strip && !('error' in panels.contract_strip) && (
              <>
                <ContractStripPanel
                  panel={panels.contract_strip as StripPanel}
                  selectedContractId={isStir ? selectedContract : null}
                  onSelectContract={isStir ? handleSelectContract : undefined}
                />
                {/* Contract detail panel — STIR only */}
                {isStir && selectedContract && (
                  <div>
                    {historyLoading && (
                      <div className="hub-frame" style={{ ...cardStyle, textAlign: 'center', color: '#8995a2' }}>Loading contract history…</div>
                    )}
                    {!historyLoading && contractHistory && (
                      <ContractDetailPanel
                        history={contractHistory}
                        displayName={contractHistory.display_name}
                        onClose={() => { setSelectedContract(null); setContractHistory(null) }}
                      />
                    )}
                  </div>
                )}
              </>
            )}
            {panels.dv01_by_bucket && !('error' in panels.dv01_by_bucket) && (
              <DV01Panel panel={panels.dv01_by_bucket as DV01Panel} />
            )}
            {panels.crowding && !('error' in panels.crowding) && (
              <CrowdingPanel panel={panels.crowding as CrowdingPanel} />
            )}
            {panels.centre_of_gravity && !('error' in panels.centre_of_gravity) && (
              <CoGPanel panel={panels.centre_of_gravity as CoGPanel} />
            )}
            {panels.quadrant_mix && !('error' in panels.quadrant_mix) && (
              <QuadrantPanel panel={panels.quadrant_mix as QuadrantPanel} />
            )}
            {panels.curve_positioning && !('error' in panels.curve_positioning) && (
              <CurvePosPanel panel={panels.curve_positioning as CurvePosPanel} />
            )}
            {panels.cot_reconciliation && !('error' in panels.cot_reconciliation) && (
              <COTPanel panel={panels.cot_reconciliation as COTPanel} />
            )}
          </>
        )}

      </div>
    </div>
  )
}
