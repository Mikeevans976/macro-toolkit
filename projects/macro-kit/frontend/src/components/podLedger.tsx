import React, { useEffect, useState } from 'react'
import axios from 'axios'
import { accent, fg, fontNum, ink, line, line2, neg, pos, warn } from '../theme'
import { Chip, SectionLabel, formatDate } from './agentsUi'

// Trade ledger and alerts panels for the pod page. The PM's ledger actions
// (approve, reject, mark live, close) go through /api/pod/trades/{id}/decision;
// agents can never take them. Status machine: backend/pod/book.py.

export interface Trade {
  id: number
  created_at: string
  updated_at: string
  proposed_by: string
  status: string
  title: string
  thesis: string
  instrument: string
  direction: string
  risk_factor: string
  bucket: string
  conviction: number
  horizon: string
  entry_level: string | null
  target: string | null
  stop: string | null
  invalidation: string
  pnl_per_bp_k: number | null
  max_loss_k: number | null
  red_team_verdict: string | null
  kill_criteria: string | null
  events?: { created_at: string; actor: string; action: string; from_status: string | null; to_status: string | null; note: string | null }[]
}

export interface Alert {
  id: number
  created_at: string
  agent_id: string
  level: 'info' | 'warning' | 'critical'
  message: string
  trade_id: number | null
}

const OPEN = ['proposed', 'sponsored', 'challenged', 'sized', 'risk_approved', 'pm_approved', 'live']
const STATUS_COLOR: Record<string, string> = {
  proposed: fg[3], sponsored: fg[2], challenged: fg[2], sized: fg[2],
  risk_approved: warn, pm_approved: accent, live: pos, closed: fg[4], rejected: neg,
}
const VERDICT_COLOR: Record<string, string> = { proceed: pos, 'proceed-smaller': warn, rework: warn, reject: neg }

// PM actions available from each status
const PM_ACTIONS: Record<string, { action: string; label: string; tone: string }[]> = {
  risk_approved: [{ action: 'pm_approve', label: 'Approve', tone: pos }, { action: 'pm_reject', label: 'Reject', tone: neg }],
  pm_approved: [{ action: 'mark_live', label: 'Mark live', tone: accent }, { action: 'pm_reject', label: 'Reject', tone: neg }],
  live: [{ action: 'close', label: 'Close', tone: fg[2] }],
  proposed: [{ action: 'pm_reject', label: 'Reject', tone: neg }],
  sponsored: [{ action: 'pm_reject', label: 'Reject', tone: neg }],
  challenged: [{ action: 'pm_reject', label: 'Reject', tone: neg }],
  sized: [{ action: 'pm_reject', label: 'Reject', tone: neg }],
}

const smallButton = (tone: string): React.CSSProperties => ({
  background: 'transparent', border: `1px solid ${tone}66`, borderRadius: 5, color: tone,
  fontSize: 11, padding: '3px 9px', cursor: 'pointer', fontFamily: 'inherit',
})

export function AlertsPanel({ refreshKey, names }: { refreshKey: number; names: Record<string, string> }) {
  const [alerts, setAlerts] = useState<Alert[]>([])
  const load = () => axios.get('/api/pod/alerts').then(r => setAlerts(r.data.alerts ?? [])).catch(() => {})
  useEffect(() => { load() }, [refreshKey])
  if (!alerts.length) return null
  const ack = (id: number) => axios.post(`/api/pod/alerts/${id}/ack`).then(load)
  return (
    <div className="hub-frame" style={{ padding: '14px 20px', marginBottom: 16, borderColor: `${warn}44` }}>
      <SectionLabel>Alerts · {alerts.length}</SectionLabel>
      <div style={{ display: 'grid' }}>
        {alerts.map(a => {
          const tone = a.level === 'critical' ? neg : a.level === 'warning' ? warn : fg[3]
          return (
            <div key={a.id} style={{ display: 'grid', gridTemplateColumns: '78px 110px 170px 1fr auto', gap: 10, alignItems: 'start', padding: '6px 0', borderBottom: `1px solid ${line}`, fontSize: 12 }}>
              <span style={{ fontFamily: fontNum, fontSize: 10, color: tone, letterSpacing: '0.08em', paddingTop: 2 }}>{a.level.toUpperCase()}</span>
              <span style={{ fontFamily: fontNum, fontSize: 10.5, color: fg[3], paddingTop: 1 }}>{formatDate(a.created_at)}</span>
              <span style={{ color: fg[3] }}>{names[a.agent_id] ?? a.agent_id}{a.trade_id ? ` · #${a.trade_id}` : ''}</span>
              <span style={{ color: fg[2], whiteSpace: 'pre-wrap' }}>{a.message}</span>
              <button onClick={() => ack(a.id)} style={smallButton(fg[3])}>Dismiss</button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function LedgerPanel({ refreshKey, names }: { refreshKey: number; names: Record<string, string> }) {
  const [trades, setTrades] = useState<Trade[]>([])
  const [showAll, setShowAll] = useState(false)
  const [open, setOpen] = useState<Trade | null>(null)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = () => axios.get('/api/pod/trades').then(r => setTrades(r.data.trades ?? [])).catch(() => {})
  useEffect(() => { load() }, [refreshKey])

  const expand = (t: Trade) => {
    if (open?.id === t.id) { setOpen(null); return }
    setNote('')
    setError('')
    axios.get(`/api/pod/trades/${t.id}`).then(r => setOpen(r.data.trade)).catch(() => setOpen(t))
  }

  const decide = (t: Trade, action: string) => {
    setBusy(true)
    setError('')
    axios.post(`/api/pod/trades/${t.id}/decision`, { action, note })
      .then(r => { setOpen(r.data.trade); setNote(''); load() })
      .catch(err => setError(axios.isAxiosError(err) && err.response?.data?.detail ? String(err.response.data.detail) : 'Action failed'))
      .finally(() => setBusy(false))
  }

  const visible = showAll ? trades : trades.filter(t => OPEN.includes(t.status))
  const awaiting = trades.filter(t => t.status === 'risk_approved').length
  const cell: React.CSSProperties = { padding: '7px 8px', borderBottom: `1px solid ${line}`, textAlign: 'left', verticalAlign: 'top' }

  return (
    <div className="hub-frame" style={{ padding: '18px 20px', marginBottom: 16 }}>
      <SectionLabel right={
        <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {awaiting > 0 && <Chip color={warn} mono>{awaiting} AWAITING YOUR DECISION</Chip>}
          <button onClick={() => setShowAll(v => !v)} style={smallButton(fg[3])}>{showAll ? 'Open only' : 'Show all'}</button>
          <button onClick={load} style={smallButton(fg[3])}>Refresh</button>
        </span>
      }>
        Trade ledger · {visible.length}
      </SectionLabel>

      {visible.length === 0 ? (
        <p style={{ color: fg[3], fontSize: 12, margin: 0 }}>
          No {showAll ? '' : 'open '}trades. Run a Trade Review or a desk briefing; desk heads put the ideas they back on the ledger.
        </p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
            <thead>
              <tr>
                {['#', 'Trade', 'Status', 'Conv.', 'Red Team', 'P&L/bp', 'Max loss', 'Proposed by', 'Updated'].map(h => (
                  <th key={h} className="hub-eyebrow" style={{ ...cell, fontWeight: 400 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map(t => (
                <React.Fragment key={t.id}>
                  <tr onClick={() => expand(t)} style={{ cursor: 'pointer', background: open?.id === t.id ? ink[2] : 'transparent' }}>
                    <td style={{ ...cell, fontFamily: fontNum, color: fg[3] }}>{t.id}</td>
                    <td style={cell}>
                      <div style={{ color: fg[1] }}>{t.title}</div>
                      <div style={{ color: fg[3], fontSize: 11 }}>{t.instrument}</div>
                    </td>
                    <td style={cell}><Chip color={STATUS_COLOR[t.status]} mono>{t.status.replace('_', ' ').toUpperCase()}</Chip></td>
                    <td style={{ ...cell, fontFamily: fontNum, color: fg[2] }}>{t.conviction}</td>
                    <td style={cell}>{t.red_team_verdict ? <Chip color={VERDICT_COLOR[t.red_team_verdict]}>{t.red_team_verdict}</Chip> : <span style={{ color: fg[4] }}>—</span>}</td>
                    <td style={{ ...cell, fontFamily: fontNum, color: fg[2] }}>{t.pnl_per_bp_k != null ? `${t.pnl_per_bp_k}k` : '—'}</td>
                    <td style={{ ...cell, fontFamily: fontNum, color: fg[2] }}>{t.max_loss_k != null ? `${t.max_loss_k}k` : '—'}</td>
                    <td style={{ ...cell, color: fg[3] }}>{names[t.proposed_by] ?? t.proposed_by}</td>
                    <td style={{ ...cell, fontFamily: fontNum, fontSize: 10.5, color: fg[3], whiteSpace: 'nowrap' }}>{formatDate(t.updated_at)}</td>
                  </tr>
                  {open?.id === t.id && (
                    <tr>
                      <td colSpan={9} style={{ ...cell, background: ink[1], padding: '12px 14px' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr)', gap: 18 }}>
                          <div style={{ display: 'grid', gap: 6, fontSize: 12, color: fg[2] }}>
                            <div><span className="hub-eyebrow">Thesis </span>{open.thesis}</div>
                            <div><span className="hub-eyebrow">Risk factor </span>{open.risk_factor} · {open.bucket} · {open.direction} · {open.horizon}</div>
                            <div><span className="hub-eyebrow">Levels </span>entry {open.entry_level ?? '—'} · target {open.target ?? '—'} · stop {open.stop ?? '—'}</div>
                            <div><span className="hub-eyebrow">Invalidation </span>{open.invalidation}</div>
                            {open.kill_criteria && <div><span className="hub-eyebrow">Kill criteria </span>{open.kill_criteria}</div>}
                            {(PM_ACTIONS[open.status] ?? []).length > 0 && (
                              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
                                <input
                                  value={note}
                                  onChange={e => setNote(e.target.value)}
                                  placeholder="Note for the ledger (optional)"
                                  style={{ flex: 1, minWidth: 180, background: ink[0], border: `1px solid ${line2}`, borderRadius: 5, color: fg[1], fontSize: 12, padding: '5px 8px', fontFamily: 'inherit' }}
                                />
                                {PM_ACTIONS[open.status].map(a => (
                                  <button key={a.action} disabled={busy} onClick={() => decide(open, a.action)} style={smallButton(a.tone)}>{a.label}</button>
                                ))}
                              </div>
                            )}
                            {error && <div style={{ color: neg, fontSize: 11.5 }}>{error}</div>}
                          </div>
                          <div style={{ display: 'grid', gap: 4, alignContent: 'start' }}>
                            <span className="hub-eyebrow">History</span>
                            {(open.events ?? []).map((e, i) => (
                              <div key={i} style={{ fontSize: 11.5, color: fg[2], lineHeight: 1.45 }}>
                                <span style={{ fontFamily: fontNum, fontSize: 10, color: fg[4] }}>{formatDate(e.created_at)} </span>
                                <span style={{ color: fg[1] }}>{e.actor === 'pm' ? 'PM' : names[e.actor] ?? e.actor}</span>
                                {' '}{e.action}{e.to_status ? ` → ${e.to_status}` : ''}
                                {e.note && <div style={{ color: fg[3], paddingLeft: 8 }}>{e.note.length > 400 ? e.note.slice(0, 400) + '…' : e.note}</div>}
                              </div>
                            ))}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
