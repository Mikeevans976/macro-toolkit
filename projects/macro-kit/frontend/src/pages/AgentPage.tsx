import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import axios from 'axios'
import Glyph, { toolGlyph } from '../components/Glyph'
import PageTitle, { headerBar } from '../components/PageTitle'
import { accent, fg, fontNum, ink, line, line2, neg } from '../theme'
import {
  AGENTS_MARK, AgentInfo, Chip, EventLine, KEYFRAMES, MODEL_LABEL, Markdown, ModelCatalogue, ModelPicker,
  PodView, RunSummary, SectionLabel, Spinner, StreamEvent, ViewsTable, authHeaders, formatDate, modelLabel,
} from '../components/agentsUi'

// One pod agent, chat-style. Any enabled agent id from backend/pod/roster.yaml works at /tools/agents/:agentId.

interface ChatMessage {
  id: string
  role: 'user' | 'agent'
  content: string
  timestamp: string
  runId?: string
}

// Starter prompts per agent
const TEMPLATES: Record<string, string[]> = {
  'deputy-pm': [
    'Summarise the latest house view and the three ideas you would put in front of the PM today.',
    'Which desk views currently conflict, and how would you resolve them?',
    'What is the biggest risk to the pod\'s current ideas over the next two weeks?',
  ],
  'red-team': [
    'Challenge this idea: receive EUR 2y swaps ahead of the next ECB meeting.',
    'Red-team the most recent desk views recorded this week.',
    'Which of the current consensus rates trades looks most crowded, and why?',
  ],
  'head-of-macro-research': [
    'Give me the macro regime across the ten G10 regions: where is momentum improving and deteriorating?',
    'Which regions show the biggest gap between macro fair value and the 10y yield?',
    'Where do macro factors and option-implied distributions disagree?',
  ],
  'head-of-rates': [
    'What are the two or three rates trades you would sponsor today, and why?',
    'Is EUR duration rich or cheap to macro, and what is the best expression?',
    'Where do curve RV and positioning point in the same direction?',
  ],
  'stir-strategist': [
    'What is priced for the next three ECB meetings, and where do you disagree?',
    'How is Euribor futures positioning distributed across the strip?',
    'Which front-end data release matters most this month, and what is the market sensitivity?',
  ],
  'curve-strategist': [
    'Is the Bund curve slope rich or cheap to its PCA and macro fair value?',
    'Which bonds look most rich or cheap on the fitted Bund curve?',
    'How fast has 2s10s mean-reverted historically, and what does that imply for horizon?',
  ],
  'swaps-rv-analyst': [
    'Run a full EUR swaps RV screen: top candidates with z-score, carry and half-life.',
    'Find flies with |z| above 1.5 and positive carry, and check them against PCA.',
    'Which curve trades look cheap but fail on carry or reversion speed?',
  ],
  'sovereign-spreads-analyst': [
    'Where is value in EGB spreads right now, and what are the structural reasons it might persist?',
    'Screen BTP-Bund and OAT-Bund curves for extremes.',
    'Price a hypothetical new 10y Bund issue off the fitted curve.',
  ],
  'inflation-strategist': [
    'Is EUR HICP pricing re-acceleration or disinflation over the next six fixings?',
    'Where do the inflation fair value models disagree most with market pricing?',
    'Compare EUR, GBP and USD implied fixings: which market looks most mispriced?',
  ],
  'positioning-flows-analyst': [
    'Which rates trades look most crowded right now?',
    'Where would trend-followers add or cut duration from here?',
    'Which correlation breaks matter for current pod ideas?',
  ],
}

function uid(): string {
  return Math.random().toString(36).slice(2)
}

export default function AgentPage() {
  const { agentId } = useParams<{ agentId: string }>()
  const navigate = useNavigate()
  const headers = authHeaders()

  const [roster, setRoster] = useState<AgentInfo[]>([])
  const [agent, setAgent] = useState<AgentInfo | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streamEvents, setStreamEvents] = useState<StreamEvent[]>([])
  const [question, setQuestion] = useState('')
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [history, setHistory] = useState<RunSummary[]>([])
  const [runViews, setRunViews] = useState<Record<string, PodView[]>>({})
  const [showBaseline, setShowBaseline] = useState(false)
  const [error, setError] = useState('')
  const [catalogue, setCatalogue] = useState<ModelCatalogue | null>(null)
  const [modelSaving, setModelSaving] = useState(false)

  const chatEndRef = useRef<HTMLDivElement>(null)
  const esRef = useRef<EventSource | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // ── Load agent + history ─────────────────────────────────────────────────
  useEffect(() => {
    if (!agentId) { navigate('/', { replace: true }); return }
    setAgent(null)
    setNotFound(false)
    setMessages([])
    setStreamEvents([])
    setStatus('idle')
    setError('')
    axios.get('/api/agents/roster?include_planned=true', { headers })
      .then(res => {
        const all = (res.data.roster ?? []) as AgentInfo[]
        setRoster(all)
        const found = all.find(a => a.id === agentId)
        if (found) setAgent(found)
        else setNotFound(true)
      })
      .catch(err => {
        if (axios.isAxiosError(err) && err.response?.status === 401) navigate('/login', { replace: true })
      })
    axios.get('/api/agents/models', { headers }).then(r => setCatalogue(r.data)).catch(() => {})
    loadHistory()
    return () => esRef.current?.close()
  }, [agentId])

  function saveModel(spec: string | null) {
    if (!agent) return
    setModelSaving(true)
    axios.put(`/api/agents/${agent.id}/model`, { model: spec }, { headers })
      .then(res => setAgent(a => a && { ...a, model_override: res.data.model_override }))
      .catch(err => setError(axios.isAxiosError(err) && err.response?.data?.detail
        ? String(err.response.data.detail) : 'Could not save the model choice.'))
      .finally(() => setModelSaving(false))
  }

  function loadHistory() {
    axios.get(`/api/agents/runs?agent_id=${agentId}`, { headers })
      .then(res => setHistory(res.data.runs ?? []))
      .catch(() => {})
  }

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamEvents])

  function loadViews(runId: string) {
    axios.get(`/api/agents/runs/${runId}`, { headers })
      .then(res => setRunViews(prev => ({ ...prev, [runId]: res.data.views ?? [] })))
      .catch(() => {})
  }

  // ── Send ─────────────────────────────────────────────────────────────────
  function send() {
    if (!question.trim() || status === 'running' || !agentId) return
    const q = question.trim()
    setMessages(prev => [...prev, { id: uid(), role: 'user', content: q, timestamp: new Date().toISOString() }])
    setStreamEvents([])
    setError('')
    setStatus('running')
    setQuestion('')

    axios.post(`/api/agents/${agentId}/run`, { question: q }, { headers })
      .then(res => openStream(res.data.run_id))
      .catch(err => {
        setStatus('error')
        setError(axios.isAxiosError(err) && err.response?.data?.detail
          ? String(err.response.data.detail)
          : 'Failed to start the run. Check that the backend is running and ANTHROPIC_API_KEY is set.')
      })
  }

  function openStream(runId: string) {
    esRef.current?.close()
    const token = localStorage.getItem('access_token') ?? ''
    const es = new EventSource(`/api/agents/stream/${runId}?token=${encodeURIComponent(token)}`)
    esRef.current = es

    es.onmessage = (e: MessageEvent) => {
      let ev: StreamEvent
      try { ev = JSON.parse(e.data) } catch { return }
      if (ev.type === 'synthesis') {
        setMessages(prev => [...prev, {
          id: uid(), role: 'agent', content: ev.content, runId,
          timestamp: ev.timestamp || new Date().toISOString(),
        }])
        setStreamEvents([])
        return
      }
      if (ev.type === 'done') {
        setStatus('done')
        es.close()
        loadHistory()
        loadViews(runId)
        return
      }
      if (ev.type === 'error') {
        setStatus('error')
        setError(ev.content || 'Unknown error')
        es.close()
        return
      }
      if (ev.type !== 'status' && ev.type !== 'task_done') setStreamEvents(prev => [...prev, ev])
    }
    es.onerror = () => {
      setStatus(prev => (prev === 'running' ? 'error' : prev))
      es.close()
    }
  }

  function openPast(run: RunSummary) {
    axios.get(`/api/agents/runs/${run.run_id}`, { headers }).then(res => {
      setRunViews(prev => ({ ...prev, [run.run_id]: res.data.views ?? [] }))
      setMessages([
        { id: uid(), role: 'user', content: run.question, timestamp: run.created_at },
        { id: uid(), role: 'agent', content: res.data.run?.output ?? '(no output)', timestamp: run.created_at, runId: run.run_id },
      ])
      setStreamEvents([])
      setError(res.data.run?.status === 'error' ? res.data.run?.output ?? 'Run failed' : '')
    })
  }

  // ── Render ───────────────────────────────────────────────────────────────
  if (notFound) {
    return (
      <div style={{ background: ink[0], minHeight: '100vh', display: 'grid', placeItems: 'center', color: fg[2], fontSize: 13 }}>
        <div style={{ textAlign: 'center', display: 'grid', gap: 10 }}>
          <span>No agent called "{agentId}".</span>
          <Link to="/tools/agents/fixed-income-pod" style={{ color: accent }}>Go to the pod</Link>
        </div>
      </div>
    )
  }
  if (!agent) {
    return <div style={{ background: ink[0], minHeight: '100vh', display: 'grid', placeItems: 'center', color: fg[3], fontSize: 12 }}>Loading…</div>
  }

  const byId = Object.fromEntries(roster.map(a => [a.id, a]))
  const names = Object.fromEntries(roster.map(a => [a.id, a.name]))
  const boss = agent.reports_to === 'pm' ? null : byId[agent.reports_to]
  const team = roster.filter(a => a.reports_to === agent.id)
  const baselineTools = agent.tools.filter(t => !agent.specialist_tools.includes(t))
  const templates = TEMPLATES[agent.id] ?? []
  const glyph = toolGlyph(agent.id)
  const mark = agent.is_manager ? AGENTS_MARK : fg[2]
  const planned = !agent.enabled
  const spec = agent.model_override ?? `anthropic:${agent.model_id}`
  const effectiveLabel = agent.model_override ? modelLabel(agent.model_override, catalogue) : MODEL_LABEL[agent.model]
  const missingKey = catalogue && !planned
    ? (spec.startsWith('openrouter:') && !catalogue.openrouter_configured ? 'OPENROUTER_API_KEY'
      : spec.startsWith('anthropic:') && !catalogue.anthropic_configured ? 'ANTHROPIC_API_KEY' : null)
    : null

  const sideBlock: React.CSSProperties = { marginBottom: 22 }
  const linkStyle: React.CSSProperties = { color: fg[2], fontSize: 12, textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0' }

  return (
    <div style={{ background: ink[0], height: '100vh', display: 'flex', flexDirection: 'column', color: fg[1] }}>
      <style>{KEYFRAMES}</style>

      {/* Header */}
      <div style={{ ...headerBar, padding: '12px 32px', display: 'flex', alignItems: 'center', gap: 16 }}>
        <PageTitle category={`Agents · ${agent.desk_name}`} categoryId="agents" title={agent.name} subtitle={agent.role} />
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {status === 'running' && <><Spinner /><span className="hub-eyebrow" style={{ color: accent }}>Working</span></>}
          {planned
            ? <Chip mono>PLANNED</Chip>
            : (
              <>
                <ModelPicker
                  value={agent.model_override ?? null}
                  onChange={saveModel}
                  catalogue={catalogue}
                  defaultLabel={`Default: ${MODEL_LABEL[agent.model]}`}
                  disabled={status === 'running' || modelSaving}
                  width={250}
                />
                <Chip mono>{effectiveLabel} · EFFORT {agent.effort.toUpperCase()}</Chip>
              </>
            )}
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', minHeight: 0, maxWidth: 1320, width: '100%', margin: '0 auto' }}>

        {/* Sidebar */}
        <aside style={{ width: 270, flexShrink: 0, borderRight: `1px solid ${line}`, padding: '20px 18px', overflowY: 'auto' }}>
          <div style={sideBlock}>
            <SectionLabel>Reports to</SectionLabel>
            {boss
              ? <Link to={`/tools/agents/${boss.id}`} style={linkStyle}><Glyph name={toolGlyph(boss.id)} size={13} />{boss.name}</Link>
              : <span style={{ ...linkStyle, color: fg[2] }}><Glyph name="agent" size={13} />Portfolio Manager (human)</span>}
          </div>

          {team.length > 0 && (
            <div style={sideBlock}>
              <SectionLabel>Team · {team.length}</SectionLabel>
              {team.map(a => a.enabled
                ? <Link key={a.id} to={`/tools/agents/${a.id}`} style={linkStyle}><Glyph name={toolGlyph(a.id)} size={13} />{a.name}</Link>
                : <span key={a.id} style={{ ...linkStyle, color: fg[4] }}><Glyph name={toolGlyph(a.id)} size={13} />{a.name} · planned</span>)}
            </div>
          )}

          {planned ? (
            <div style={sideBlock}>
              <SectionLabel>Blocked on</SectionLabel>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {agent.blocked_on.map(t => <Chip key={t} mono>{t}</Chip>)}
              </div>
            </div>
          ) : (
            <>
              <div style={sideBlock}>
                <SectionLabel>Tools · {agent.specialist_tools.length}</SectionLabel>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {agent.specialist_tools.map(t => <Chip key={t} mono color={accent}>{t}</Chip>)}
                </div>
                <button
                  onClick={() => setShowBaseline(s => !s)}
                  style={{ background: 'none', border: 'none', color: fg[3], fontSize: 11, padding: '8px 0 0', cursor: 'pointer', fontFamily: 'inherit' }}
                >
                  {showBaseline ? 'Hide' : 'Show'} {baselineTools.length} baseline tools
                </button>
                {showBaseline && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                    {baselineTools.map(t => <Chip key={t} mono>{t}</Chip>)}
                  </div>
                )}
              </div>

              <div style={sideBlock}>
                <SectionLabel>Skills · {agent.skills.length}</SectionLabel>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {agent.skills.map(s => <Chip key={s}>{s}</Chip>)}
                </div>
              </div>

              {templates.length > 0 && (
                <div style={sideBlock}>
                  <SectionLabel>Prompts</SectionLabel>
                  <div style={{ display: 'grid', gap: 5 }}>
                    {templates.map((t, i) => (
                      <button
                        key={i}
                        onClick={() => { setQuestion(t); textareaRef.current?.focus() }}
                        style={{
                          background: 'transparent', border: `1px solid ${line}`, borderRadius: 6, color: fg[2],
                          cursor: 'pointer', fontSize: 11.5, lineHeight: 1.45, padding: '7px 10px', textAlign: 'left', fontFamily: 'inherit',
                        }}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {history.length > 0 && (
            <div style={sideBlock}>
              <SectionLabel>History · {history.length}</SectionLabel>
              {history.slice(0, 20).map(r => (
                <button
                  key={r.run_id}
                  onClick={() => openPast(r)}
                  style={{
                    display: 'grid', gap: 2, width: '100%', textAlign: 'left', background: 'none', border: 'none',
                    borderBottom: `1px solid ${line}`, padding: '6px 0', cursor: 'pointer', fontFamily: 'inherit',
                  }}
                >
                  <span style={{ fontSize: 11.5, color: fg[2], overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.question}</span>
                  <span style={{ fontFamily: fontNum, fontSize: 10, color: r.status === 'error' ? neg : fg[4] }}>
                    {formatDate(r.created_at)}{r.status !== 'done' ? ` · ${r.status}` : ''}
                  </span>
                </button>
              ))}
            </div>
          )}

          <Link to="/tools/agents/fixed-income-pod" style={{ ...linkStyle, color: fg[3] }}>
            <Glyph name="pod" size={13} />Open the pod
          </Link>
        </aside>

        {/* Conversation */}
        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div style={{ flex: 1, overflowY: 'auto', padding: '24px 32px' }}>
            {messages.length === 0 && status !== 'running' && (
              <div style={{ maxWidth: 560, margin: '56px auto 0', textAlign: 'center', display: 'grid', gap: 10, justifyItems: 'center' }}>
                <Glyph name={glyph} size={32} style={{ color: mark }} />
                <div style={{ fontSize: 15, fontWeight: 500 }}>{agent.name}</div>
                <div style={{ fontSize: 12.5, color: fg[3], lineHeight: 1.6 }}>
                  {planned
                    ? `Planned. This agent switches on once ${agent.blocked_on.join(', ')} ${agent.blocked_on.length > 1 ? 'exist' : 'exists'}.`
                    : `${agent.role}. Its answers are advisory and it records views in the standard pod format.`}
                </div>
              </div>
            )}

            {messages.map(msg => msg.role === 'user' ? (
              <div key={msg.id} style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
                <div style={{
                  maxWidth: '70%', background: ink[2], border: `1px solid ${line2}`, borderRadius: 6,
                  padding: '9px 14px', fontSize: 13, lineHeight: 1.6, color: fg[1],
                }}>
                  {msg.content}
                </div>
              </div>
            ) : (
              <div key={msg.id} className="hub-frame" style={{ padding: '14px 18px', marginBottom: 16 }}>
                <SectionLabel right={<span style={{ fontFamily: fontNum, fontSize: 10, color: fg[4] }}>{formatDate(msg.timestamp)}</span>}>
                  {agent.name}
                </SectionLabel>
                <Markdown text={msg.content} />
                {msg.runId && (runViews[msg.runId]?.length ?? 0) > 0 && (
                  <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${line}` }}>
                    <SectionLabel>Views recorded · {runViews[msg.runId].length}</SectionLabel>
                    <ViewsTable views={runViews[msg.runId]} names={names} />
                  </div>
                )}
              </div>
            ))}

            {status === 'running' && (
              <div className="hub-frame" style={{ padding: '12px 16px', marginBottom: 16 }}>
                <SectionLabel right={<Spinner size={11} />}>Working</SectionLabel>
                {streamEvents.length === 0
                  ? <span style={{ fontSize: 12, color: fg[3] }}>Starting…</span>
                  : streamEvents.slice(-14).map((ev, i) => <EventLine key={i} event={ev} showAgent={false} />)}
              </div>
            )}

            {missingKey && (
              <div style={{ border: `1px solid ${neg}55`, borderRadius: 6, color: neg, fontSize: 12, padding: '10px 14px', marginBottom: 12 }}>
                {missingKey} is not set, so this agent can't run on {effectiveLabel}. Add it to backend/.env and restart the backend.
              </div>
            )}
            {error && (
              <div style={{ border: `1px solid ${neg}55`, borderRadius: 6, color: neg, fontSize: 12, padding: '10px 14px', marginBottom: 12 }}>
                {error}
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Input */}
          <div style={{ borderTop: `1px solid ${line}`, padding: '14px 32px', background: ink[0] }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'stretch' }}>
              <textarea
                ref={textareaRef}
                value={question}
                onChange={e => setQuestion(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send() }}
                placeholder={planned ? 'This agent is not active yet.' : `Ask the ${agent.name}…  (⌘ Enter to send)`}
                rows={2}
                disabled={status === 'running' || planned}
                style={{
                  flex: 1, background: ink[1], border: `1px solid ${line2}`, borderRadius: 6, color: fg[1],
                  fontSize: 13, lineHeight: 1.6, padding: '10px 14px', resize: 'none', outline: 'none', fontFamily: 'inherit',
                }}
              />
              <button
                onClick={send}
                aria-label="Send"
                disabled={!question.trim() || status === 'running' || planned}
                style={{
                  background: !question.trim() || status === 'running' ? ink[2] : `${accent}26`,
                  border: `1px solid ${!question.trim() || status === 'running' ? line2 : `${accent}88`}`,
                  borderRadius: 6, color: !question.trim() || status === 'running' ? fg[3] : fg[1],
                  cursor: !question.trim() || status === 'running' ? 'not-allowed' : 'pointer',
                  padding: '0 14px', display: 'grid', placeItems: 'center',
                }}
              >
                <Glyph name="send" size={16} />
              </button>
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
