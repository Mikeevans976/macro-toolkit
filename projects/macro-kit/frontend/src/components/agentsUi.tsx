import React from 'react'
import { accent, fg, fontNum, ink, line, line2, neg, pos, warn } from '../theme'

// Shared types and small components for the Agents pages (AgentsPod, AgentPage).
// Shapes mirror backend/pod/roster.py roster_entry() and /api/agents/runs/{id}.

export interface AgentInfo {
  id: string
  name: string
  role: string
  desk: string
  desk_name: string
  reports_to: string
  tools: string[]
  specialist_tools: string[]
  skills: string[]
  model: 'opus' | 'sonnet' | 'haiku'
  model_id: string
  effort: string
  is_manager: boolean
  enabled: boolean
  blocked_on: string[]
  model_override?: string | null
  model_label?: string
}

export interface ModelOption {
  spec: string            // "<provider>:<id>"
  id: string
  name: string
  input_per_mtok?: number
  output_per_mtok?: number
  context_length?: number
}

export interface ModelCatalogue {
  anthropic: ModelOption[]
  openrouter: ModelOption[]
  anthropic_configured: boolean
  openrouter_configured: boolean
  openrouter_error: string | null
}

export function modelLabel(spec: string | null | undefined, catalogue?: ModelCatalogue | null): string {
  if (!spec) return ''
  const all = catalogue ? [...catalogue.anthropic, ...catalogue.openrouter] : []
  const hit = all.find(m => m.spec === spec)
  if (hit) return hit.spec.startsWith('anthropic:') ? hit.name.replace(/^Claude /, '') : hit.id.split('/').pop() ?? hit.id
  return spec.split(':').pop()?.split('/').pop() ?? spec
}

export interface StreamEvent {
  type: string
  agent: string
  content: string
  timestamp?: string
  run_id?: string
}

export interface RunSummary {
  run_id: string
  created_at: string
  question: string
  status: 'pending' | 'running' | 'done' | 'error'
  agent_id: string
}

export interface PodView {
  agent_id: string
  market: string
  direction: string
  conviction: number
  horizon: string
  instrument: string
  catalysts: string[]
  invalidation: string
  rationale: string
  evidence: { tool: string; as_of: string; data_source: string }[]
}

export interface UsageRow {
  agent_id: string
  model: string
  turns: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
}

export const AGENTS_MARK = '#9e9fe2'   // categoryColor.agents

export const MODEL_LABEL: Record<string, string> = {
  opus: 'Opus 5.5',
  sonnet: 'Sonnet 5.5',
  haiku: 'Haiku 5.5',
}

export function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem('access_token') ?? ''}` }
}

export function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

// ── Markdown (headings, bullets, numbered lists, bold, tables) ──────────────

function inline(text: string): (string | JSX.Element)[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i} style={{ color: fg[1], fontWeight: 600 }}>{part.slice(2, -2)}</strong>
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={i} style={{ fontFamily: fontNum, fontSize: 12, color: fg[1] }}>{part.slice(1, -1)}</code>
    }
    return part
  })
}

function table(lines: string[], key: number): JSX.Element {
  const rows = lines
    .filter(l => !/^\s*\|?\s*:?-{2,}/.test(l))
    .map(l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()))
  const [head, ...body] = rows
  const cell: React.CSSProperties = { padding: '5px 10px', borderBottom: `1px solid ${line}`, textAlign: 'left', verticalAlign: 'top' }
  return (
    <div key={key} style={{ overflowX: 'auto', margin: '8px 0' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%' }}>
        <thead>
          <tr>{head.map((h, i) => <th key={i} className="hub-eyebrow" style={{ ...cell, fontWeight: 400 }}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j} style={{ ...cell, color: fg[2] }}>{inline(c)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function Markdown({ text }: { text: string }) {
  const blocks = text.split(/\n\n+/)
  return (
    <>
      {blocks.map((para, i) => {
        const trimmed = para.trim()
        const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed)
        if (heading && !trimmed.includes('\n')) {
          const level = heading[1].length
          return (
            <div key={i} style={{
              color: fg[1], fontSize: level <= 2 ? 14 : 13, fontWeight: 500,
              letterSpacing: '-0.01em', margin: '16px 0 6px',
            }}>
              {inline(heading[2])}
            </div>
          )
        }
        const lines = trimmed.split('\n')
        if (lines.length > 1 && lines.every(l => l.trim().startsWith('|'))) return table(lines, i)
        const bullet = /^\s*([-*]|\d+\.)\s+/
        if (lines.every(l => bullet.test(l) || /^\s{2,}\S/.test(l))) {
          const ordered = /^\s*\d+\./.test(lines[0])
          const Tag = ordered ? 'ol' : 'ul'
          return (
            <Tag key={i} style={{ margin: '6px 0', paddingLeft: 20 }}>
              {lines.map((l, j) => (
                <li key={j} style={{ color: fg[2], fontSize: 13, lineHeight: 1.6 }}>{inline(l.replace(bullet, '').trim())}</li>
              ))}
            </Tag>
          )
        }
        return (
          <p key={i} style={{ color: fg[2], fontSize: 13, lineHeight: 1.7, margin: '6px 0', whiteSpace: 'pre-wrap' }}>
            {inline(trimmed)}
          </p>
        )
      })}
    </>
  )
}

// ── Small pieces ─────────────────────────────────────────────────────────────

export function Chip({ children, color, mono }: { children: React.ReactNode; color?: string; mono?: boolean }) {
  return (
    <span style={{
      display: 'inline-block',
      border: `1px solid ${color ? `${color}55` : line2}`,
      borderRadius: 4,
      color: color ?? fg[2],
      fontSize: 10.5,
      fontFamily: mono ? fontNum : undefined,
      padding: '1px 6px',
      lineHeight: 1.6,
      whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  )
}

export function StatusChip({ status }: { status: RunSummary['status'] | 'idle' }) {
  const color = status === 'done' ? pos : status === 'error' ? neg : status === 'idle' ? fg[3] : warn
  return <Chip color={color} mono>{status.toUpperCase()}</Chip>
}

export function Spinner({ size = 12, color = accent }: { size?: number; color?: string }) {
  return (
    <span style={{
      display: 'inline-block', width: size, height: size, flexShrink: 0,
      border: `1.5px solid ${color}`, borderTopColor: 'transparent', borderRadius: '50%',
      animation: 'agents-spin 0.8s linear infinite',
    }} />
  )
}

export function SectionLabel({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
      <span className="hub-eyebrow">{children}</span>
      {right && <span style={{ marginLeft: 'auto' }}>{right}</span>}
    </div>
  )
}

export const KEYFRAMES = `
  @keyframes agents-spin { to { transform: rotate(360deg); } }
  @keyframes agents-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
`

// One line of the live activity log
export function EventLine({ event, showAgent = true }: { event: StreamEvent; showAgent?: boolean }) {
  const kind = event.type
  const color = kind === 'task_done' ? pos : kind === 'tool_use' ? accent : kind === 'status' ? fg[3] : fg[3]
  const label = kind === 'task_done' ? 'done' : kind === 'tool_use' ? 'tool' : kind === 'thinking' ? 'think' : kind === 'status' ? 'status' : 'step'
  const isError = event.content.startsWith('Error:') || / failed: /.test(event.content)
  const text = event.content.length > 260 ? event.content.slice(0, 260) + '…' : event.content
  return (
    <div style={{ display: 'grid', gridTemplateColumns: showAgent ? '48px 190px 1fr' : '48px 1fr', gap: 10, padding: '3px 0', fontSize: 11.5, lineHeight: 1.5 }}>
      <span style={{ fontFamily: fontNum, fontSize: 10, color: isError ? neg : color, textTransform: 'uppercase', letterSpacing: '0.08em', paddingTop: 1 }}>
        {isError ? 'error' : label}
      </span>
      {showAgent && <span style={{ color: fg[2], overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{event.agent}</span>}
      <span style={{ color: kind === 'thinking' ? fg[3] : fg[2], fontStyle: kind === 'thinking' ? 'italic' : 'normal', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {text}
      </span>
    </div>
  )
}

// Table of structured views recorded with submit_view
export function ViewsTable({ views, names }: { views: PodView[]; names: Record<string, string> }) {
  if (!views.length) return <p style={{ color: fg[3], fontSize: 12, margin: 0 }}>No structured views were recorded in this run.</p>
  const cell: React.CSSProperties = { padding: '7px 10px', borderBottom: `1px solid ${line}`, verticalAlign: 'top', textAlign: 'left' }
  const simulated = (v: PodView) => v.evidence.some(e => /simul/i.test(e.data_source))
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
        <thead>
          <tr>
            {['Agent', 'Market', 'Direction', 'Conv.', 'Horizon', 'Instrument', 'Invalidation', 'Data'].map(h => (
              <th key={h} className="hub-eyebrow" style={{ ...cell, fontWeight: 400 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {views.map((v, i) => (
            <tr key={i} title={v.rationale}>
              <td style={{ ...cell, color: fg[3], whiteSpace: 'nowrap' }}>{names[v.agent_id] ?? v.agent_id}</td>
              <td style={{ ...cell, color: fg[1] }}>{v.market}</td>
              <td style={{ ...cell, color: fg[2] }}>{v.direction}</td>
              <td style={{ ...cell, fontFamily: fontNum, color: v.conviction >= 4 ? fg[1] : fg[2] }}>
                {'■'.repeat(v.conviction)}<span style={{ color: fg[4] }}>{'■'.repeat(5 - v.conviction)}</span>
              </td>
              <td style={{ ...cell, fontFamily: fontNum, color: fg[2] }}>{v.horizon}</td>
              <td style={{ ...cell, color: fg[2] }}>{v.instrument}</td>
              <td style={{ ...cell, color: fg[2] }}>{v.invalidation}</td>
              <td style={cell}>{simulated(v) ? <Chip color={warn} mono>SIM</Chip> : <Chip mono>LIVE</Chip>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function UsageSummary({ usage }: { usage: UsageRow[] }) {
  if (!usage.length) return null
  const sum = (k: keyof UsageRow) => usage.reduce((a, u) => a + (u[k] as number), 0)
  const items: [string, string][] = [
    ['Agents', String(usage.length)],
    ['Turns', String(sum('turns'))],
    ['Input', formatTokens(sum('input_tokens'))],
    ['Cache read', formatTokens(sum('cache_read_tokens'))],
    ['Output', formatTokens(sum('output_tokens'))],
  ]
  return (
    <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap' }}>
      {items.map(([k, v]) => (
        <div key={k} style={{ display: 'grid', gap: 2 }}>
          <span className="hub-eyebrow" style={{ fontSize: 9.5 }}>{k}</span>
          <span style={{ fontFamily: fontNum, fontSize: 13, color: fg[1] }}>{v}</span>
        </div>
      ))}
    </div>
  )
}

// Model chooser: a default entry, Claude tiers, and open-weight OpenRouter models (filterable)
export function ModelPicker({
  value, onChange, catalogue, defaultLabel, disabled, width = 300,
}: {
  value: string | null
  onChange: (spec: string | null) => void
  catalogue: ModelCatalogue | null
  defaultLabel: string
  disabled?: boolean
  width?: number
}) {
  const [filter, setFilter] = React.useState('')
  const f = filter.trim().toLowerCase()
  const open = (catalogue?.openrouter ?? []).filter(m => !f || m.id.toLowerCase().includes(f) || m.name.toLowerCase().includes(f))
  const price = (m: ModelOption) =>
    m.input_per_mtok != null ? ` · $${m.input_per_mtok}/$${m.output_per_mtok} per M` : ''
  const control: React.CSSProperties = {
    background: ink[1], border: `1px solid ${line2}`, borderRadius: 6, color: fg[1],
    fontSize: 12, padding: '5px 8px', fontFamily: 'inherit', outline: 'none',
  }
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <select
        value={value ?? ''}
        disabled={disabled || !catalogue}
        onChange={e => onChange(e.target.value || null)}
        style={{ ...control, width }}
      >
        <option value="">{defaultLabel}</option>
        <optgroup label="Claude (Anthropic)">
          {(catalogue?.anthropic ?? []).map(m => <option key={m.spec} value={m.spec}>{m.name}</option>)}
        </optgroup>
        <optgroup label={`Open-weight via OpenRouter${catalogue && !catalogue.openrouter_configured ? ' (key not set)' : ''}${f ? ` · matching "${filter}"` : ''}`}>
          {open.map(m => (
            <option key={m.spec} value={m.spec} disabled={!catalogue?.openrouter_configured}>
              {m.name}{price(m)}
            </option>
          ))}
        </optgroup>
        {value && ![...(catalogue?.anthropic ?? []), ...open].some(m => m.spec === value) && (
          <option value={value}>{value}</option>
        )}
      </select>
      <input
        value={filter}
        onChange={e => setFilter(e.target.value)}
        placeholder="Filter models"
        disabled={disabled || !catalogue}
        style={{ ...control, width: 110 }}
      />
    </span>
  )
}
