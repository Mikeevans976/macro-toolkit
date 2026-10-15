import React, { useEffect, useRef, useState } from 'react'
import axios from 'axios'
import { accent, fg, fontNum, ink, line, line2, neg, pos, warn } from '../theme'
import { Chip, SectionLabel, formatDate } from './agentsUi'

// Research library panel (Research Librarian page) and Bloomberg status (News / Calendar pages).
// Backend: backend/routers/research.py, backend/pod/research/.

interface PortalStatus {
  id: string
  name: string
  bank: string
  enabled: boolean
  logged_in_at: string | null
  last_ok_at: string | null
  last_status: string
  last_sweep: { last_run: string; last_result: string } | null
  login_window_open: boolean
}

interface LibraryStatus {
  library: {
    documents_by_status: Record<string, number>
    documents_by_bank: { bank: string; n: number; latest: string }[]
    calls: number
    sweeps: { source: string; last_run: string; last_result: string }[]
  }
  portals: PortalStatus[]
  inbox_configured: boolean
  drop_folder: string
}

interface DocRow {
  id: number
  bank: string | null
  title: string
  published_at: string | null
  ingested_at?: string
  source: string
  status: string
  summary: string | null
  excerpt?: string
  url?: string | null
}

interface CallRow {
  id: number
  bank: string
  market: string
  kind: string
  target_date: string | null
  value: number | null
  unit: string | null
  direction: string | null
  statement: string
  published_at: string | null
  title: string
  doc_id: number
}

const button = (tone: string = fg[2]): React.CSSProperties => ({
  background: 'transparent', border: `1px solid ${tone}66`, borderRadius: 5, color: tone,
  fontSize: 11, padding: '3px 9px', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
})
const input: React.CSSProperties = {
  background: ink[1], border: `1px solid ${line2}`, borderRadius: 5, color: fg[1],
  fontSize: 12, padding: '5px 8px', fontFamily: 'inherit', outline: 'none',
}
const cell: React.CSSProperties = { padding: '6px 8px', borderBottom: `1px solid ${line}`, textAlign: 'left', verticalAlign: 'top' }

function statusTone(s: string) {
  return s === 'ok' ? pos : s === 'login required' ? neg : fg[3]
}

function render(text: string) {
  // search excerpts mark matches with «…»
  return text.split(/(«[^»]*»)/).map((p, i) =>
    p.startsWith('«') ? <mark key={i} style={{ background: `${accent}33`, color: fg[1], padding: 0 }}>{p.slice(1, -1)}</mark> : p)
}

export function ResearchLibraryPanel() {
  const [status, setStatus] = useState<LibraryStatus | null>(null)
  const [query, setQuery] = useState('')
  const [docs, setDocs] = useState<DocRow[]>([])
  const [openDoc, setOpenDoc] = useState<(DocRow & { calls: CallRow[]; text?: string }) | null>(null)
  const [market, setMarket] = useState('')
  const [calls, setCalls] = useState<CallRow[]>([])
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const loadStatus = () => axios.get('/api/pod/research/status').then(r => setStatus(r.data)).catch(() => {})
  const loadDocs = (q = query) =>
    axios.get('/api/pod/research/documents', { params: q ? { q, limit: 25 } : { limit: 25 } })
      .then(r => setDocs(r.data.documents ?? [])).catch(() => {})
  const loadCalls = (m = market) =>
    axios.get('/api/pod/research/calls', { params: { market: m || undefined, latest_only: true } })
      .then(r => setCalls(r.data.calls ?? [])).catch(() => {})

  useEffect(() => { loadStatus(); loadDocs(''); loadCalls('') }, [])
  useEffect(() => {
    // refresh while a login window is open so the status updates when it closes
    if (!status?.portals.some(p => p.login_window_open)) return
    const t = setInterval(loadStatus, 4000)
    return () => clearInterval(t)
  }, [status])

  const portalAction = (p: PortalStatus, action: 'login' | 'check') => {
    setBusy(`${action}:${p.id}`)
    setMessage('')
    axios.post(`/api/pod/research/portals/${p.id}/${action}`)
      .then(r => setMessage(action === 'login' ? r.data.status
        : r.data.logged_in ? `${p.name}: session is valid.` : `${p.name}: login required.`))
      .catch(err => setMessage(axios.isAxiosError(err) && err.response?.data?.detail ? String(err.response.data.detail) : 'Request failed'))
      .finally(() => { setBusy(null); loadStatus() })
  }

  const upload = (files: FileList | null) => {
    if (!files?.length) return
    const form = new FormData()
    Array.from(files).forEach(f => form.append('files', f))
    setBusy('upload')
    axios.post('/api/pod/research/upload', form)
      .then(r => {
        const res = r.data.results as { file: string; created?: boolean; error?: string }[]
        setMessage(res.map(x => x.error ? `${x.file}: ${x.error}` : `${x.file}: ${x.created ? 'added' : 'already in library'}`).join(' · '))
        loadStatus(); loadDocs()
      })
      .catch(() => setMessage('Upload failed'))
      .finally(() => { setBusy(null); if (fileRef.current) fileRef.current.value = '' })
  }

  const showDoc = (d: DocRow) => {
    if (openDoc?.id === d.id) { setOpenDoc(null); return }
    axios.get(`/api/pod/research/documents/${d.id}`).then(r => setOpenDoc(r.data.document)).catch(() => {})
  }

  const counts = status?.library.documents_by_status ?? {}
  const total = Object.values(counts).reduce((a, b) => a + b, 0)

  return (
    <div className="hub-frame" style={{ padding: '16px 18px', marginBottom: 18 }}>
      <SectionLabel right={
        <span style={{ display: 'flex', gap: 8, alignItems: 'center', fontFamily: fontNum, fontSize: 11, color: fg[3] }}>
          {total} docs · {counts.new ?? 0} new · {status?.library.calls ?? 0} calls
        </span>
      }>
        Research library
      </SectionLabel>

      {/* Portals */}
      <div style={{ overflowX: 'auto', marginBottom: 12 }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
          <thead>
            <tr>{['Portal', 'Session', 'Last valid', 'Last sweep', ''].map(h => <th key={h} className="hub-eyebrow" style={{ ...cell, fontWeight: 400 }}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {(status?.portals ?? []).map(p => (
              <tr key={p.id} style={{ opacity: p.enabled ? 1 : 0.5 }}>
                <td style={{ ...cell, color: fg[1] }}>{p.name}</td>
                <td style={cell}>
                  {p.login_window_open
                    ? <Chip color={warn} mono>WINDOW OPEN</Chip>
                    : <Chip color={statusTone(p.last_status)} mono>{p.last_status.toUpperCase()}</Chip>}
                </td>
                <td style={{ ...cell, fontFamily: fontNum, fontSize: 10.5, color: fg[3] }}>{p.last_ok_at ? formatDate(p.last_ok_at) : '—'}</td>
                <td style={{ ...cell, fontSize: 11, color: fg[3] }}>
                  {p.last_sweep ? <>{formatDate(p.last_sweep.last_run)}</> : '—'}
                </td>
                <td style={{ ...cell, display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                  <button style={button(accent)} disabled={!!busy || p.login_window_open} onClick={() => portalAction(p, 'login')}>Log in</button>
                  <button style={button()} disabled={!!busy} onClick={() => portalAction(p, 'check')}>{busy === `check:${p.id}` ? 'Checking…' : 'Check'}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 11.5, color: fg[3], marginBottom: 12 }}>
        <span>Inbox: {status?.inbox_configured ? <span style={{ color: pos }}>configured</span> : <span style={{ color: warn }}>not configured (RESEARCH_IMAP_* in .env)</span>}</span>
        <span>·</span>
        <input ref={fileRef} type="file" multiple accept=".pdf,.html,.htm,.txt,.md" style={{ display: 'none' }} onChange={e => upload(e.target.files)} />
        <button style={button()} disabled={!!busy} onClick={() => fileRef.current?.click()}>{busy === 'upload' ? 'Uploading…' : 'Upload research'}</button>
        <span>Log in opens a browser window on the machine running the backend; the Librarian never sees passwords.</span>
      </div>
      {message && <div style={{ fontSize: 11.5, color: fg[2], marginBottom: 12 }}>{message}</div>}

      {/* Search */}
      <form onSubmit={e => { e.preventDefault(); loadDocs() }} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search the library, e.g. 'ECB terminal rate'" style={{ ...input, flex: 1 }} />
        <button type="submit" style={button(accent)}>Search</button>
      </form>
      <div style={{ maxHeight: 320, overflowY: 'auto', marginBottom: 14 }}>
        {docs.length === 0 && <p style={{ fontSize: 12, color: fg[3], margin: 0 }}>{query ? 'No matches.' : 'The library is empty. Upload notes, configure the inbox, or log into a portal and run a Research Sweep.'}</p>}
        {docs.map(d => (
          <div key={d.id} style={{ borderBottom: `1px solid ${line}`, padding: '7px 2px' }}>
            <button onClick={() => showDoc(d)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', width: '100%', fontFamily: 'inherit' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <span style={{ fontFamily: fontNum, fontSize: 10.5, color: fg[4] }}>#{d.id}</span>
                <span style={{ fontSize: 12.5, color: fg[1] }}>{d.title}</span>
                <span style={{ marginLeft: 'auto', fontSize: 11, color: fg[3], whiteSpace: 'nowrap' }}>
                  {d.bank ?? '?'} · {(d.published_at ?? d.ingested_at ?? '').slice(0, 10)}
                </span>
                {d.status === 'new' && <Chip color={warn} mono>NEW</Chip>}
              </div>
              {(d.excerpt || d.summary) && (
                <div style={{ fontSize: 11.5, color: fg[3], marginTop: 3, lineHeight: 1.5 }}>{d.excerpt ? render(d.excerpt) : d.summary}</div>
              )}
            </button>
            {openDoc?.id === d.id && (
              <div style={{ background: ink[1], borderRadius: 5, padding: '10px 12px', marginTop: 6, fontSize: 12, color: fg[2], display: 'grid', gap: 6 }}>
                {openDoc.summary && <div><span className="hub-eyebrow">Summary </span>{openDoc.summary}</div>}
                <div style={{ fontSize: 11, color: fg[3] }}>Source: {openDoc.source}{openDoc.url ? <> · <a href={openDoc.url} target="_blank" rel="noreferrer" style={{ color: accent }}>original</a></> : null}</div>
                {openDoc.calls.length > 0 && (
                  <div>
                    <span className="hub-eyebrow">Calls</span>
                    {openDoc.calls.map(c => <div key={c.id} style={{ fontSize: 11.5 }}>· <b style={{ color: fg[1], fontWeight: 500 }}>{c.market}</b> {c.target_date ? `(${c.target_date})` : ''}: {c.statement}</div>)}
                  </div>
                )}
                {openDoc.text && <div style={{ maxHeight: 220, overflowY: 'auto', whiteSpace: 'pre-wrap', fontSize: 11.5, color: fg[3], borderTop: `1px solid ${line}`, paddingTop: 6 }}>{openDoc.text}</div>}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Tracked calls */}
      <form onSubmit={e => { e.preventDefault(); loadCalls() }} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
        <span className="hub-eyebrow">Street calls</span>
        <input value={market} onChange={e => setMarket(e.target.value)} placeholder="Market, e.g. 'ECB deposit rate'" style={{ ...input, flex: 1 }} />
        <button type="submit" style={button(accent)}>Show</button>
      </form>
      {calls.length === 0
        ? <p style={{ fontSize: 12, color: fg[3], margin: 0 }}>No tracked calls{market ? ` for "${market}"` : ''} yet.</p>
        : (
          <div style={{ overflowX: 'auto', maxHeight: 300, overflowY: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
              <thead>
                <tr>{['Market', 'Bank', 'Target', 'Value', 'Call', 'Date'].map(h => <th key={h} className="hub-eyebrow" style={{ ...cell, fontWeight: 400 }}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {calls.map(c => (
                  <tr key={c.id} title={`${c.title} (doc #${c.doc_id})`}>
                    <td style={{ ...cell, color: fg[1] }}>{c.market}</td>
                    <td style={{ ...cell, color: fg[2] }}>{c.bank}</td>
                    <td style={{ ...cell, fontFamily: fontNum, color: fg[3] }}>{c.target_date ?? '—'}</td>
                    <td style={{ ...cell, fontFamily: fontNum, color: fg[1] }}>{c.value != null ? `${c.value}${c.unit === '%' ? '%' : c.unit ? ` ${c.unit}` : ''}` : (c.direction ?? '—')}</td>
                    <td style={{ ...cell, color: fg[2] }}>{c.statement}</td>
                    <td style={{ ...cell, fontFamily: fontNum, fontSize: 10.5, color: fg[3], whiteSpace: 'nowrap' }}>{(c.published_at ?? '').slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  )
}

interface BbgStatus {
  blpapi_installed: boolean
  host: string
  bpipe_app_auth: boolean
  news_subscriptions_configured: boolean
  news_subscriber_running: boolean
  news_items_stored: number
  latest_news_at: string | null
}

export function BloombergStatusBox() {
  const [s, setS] = useState<BbgStatus | null>(null)
  useEffect(() => { axios.get('/api/pod/bloomberg/status').then(r => setS(r.data)).catch(() => {}) }, [])
  if (!s) return null
  const row = (label: string, ok: boolean, detail: string) => (
    <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', fontSize: 11.5 }}>
      <span style={{ width: 6, height: 6, borderRadius: 1, background: ok ? pos : warn, flexShrink: 0, transform: 'translateY(-1px)' }} />
      <span style={{ color: fg[2] }}>{label}</span>
      <span style={{ color: fg[3], marginLeft: 'auto', fontFamily: fontNum, fontSize: 10.5 }}>{detail}</span>
    </div>
  )
  return (
    <div style={{ marginBottom: 22 }}>
      <SectionLabel>Bloomberg</SectionLabel>
      <div style={{ display: 'grid', gap: 5 }}>
        {row('API (blpapi)', s.blpapi_installed, s.blpapi_installed ? s.host : 'not installed')}
        {row('B-PIPE app auth', s.bpipe_app_auth, s.bpipe_app_auth ? 'set' : 'not set')}
        {row('News feed', s.news_subscriber_running, s.news_subscriber_running ? 'running' : s.news_subscriptions_configured ? 'configured, stopped' : 'not configured')}
        {row('Headlines stored', s.news_items_stored > 0, `${s.news_items_stored}${s.latest_news_at ? ` · ${formatDate(s.latest_news_at)}` : ''}`)}
      </div>
      {!s.blpapi_installed && (
        <p style={{ fontSize: 11, color: fg[3], margin: '6px 0 0', lineHeight: 1.5 }}>
          Until Bloomberg is connected, this agent uses official calendars and newswires from the web.
        </p>
      )}
    </div>
  )
}
