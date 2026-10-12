import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import Glyph, { toolGlyph } from '../components/Glyph'
import PageTitle, { headerBar } from '../components/PageTitle'
import { accent, fg, fontNum, ink, line, line2, neg, pos } from '../theme'
import {
  AGENTS_MARK, AgentInfo, Chip, EventLine, KEYFRAMES, MODEL_LABEL, Markdown, ModelCatalogue, ModelPicker,
  PodView, RunSummary, SectionLabel, Spinner, StatusChip, StreamEvent, UsageRow, UsageSummary, ViewsTable,
  authHeaders, formatDate, modelLabel,
} from '../components/agentsUi'

// Global Macro Pod — org chart, workflow runner, live activity, synthesis and recorded views.
// Backend: backend/pod/ (roster.yaml, workflows.py); design in docs/GLOBAL_MACRO_POD_PROPOSAL.md.

interface WorkflowInfo {
  id: string
  label: string
  description: string
  stages: string[][]
  final_agent: string
}

type RunStatus = 'idle' | 'running' | 'done' | 'error'

const WORKFLOW_KEY = 'pod.workflow'
const RUN_MODEL_KEY = 'pod.runModel'

// The model an agent will use: the run-wide choice if set, else its stored override, else its tier default
function effectiveSpec(a: AgentInfo, runModel: string | null): string {
  return runModel ?? a.model_override ?? `anthropic:${a.model_id}`
}
const LEGACY_POD_IDS = ['fixed-income-pod']

// ---------------------------------------------------------------------------
// Org chart
// ---------------------------------------------------------------------------

function AgentNode({
  agent, state, inWorkflow, compact, onOpen, modelText,
}: {
  agent: AgentInfo
  state: 'idle' | 'active' | 'done'
  inWorkflow: boolean
  compact?: boolean
  onOpen: (a: AgentInfo) => void
  modelText: string
}) {
  const planned = !agent.enabled
  const border = state === 'active' ? accent : state === 'done' ? `${pos}88` : line2
  return (
    <button
      onClick={() => !planned && onOpen(agent)}
      title={planned ? `Planned · needs ${agent.blocked_on.join(', ')}` : `${agent.role}\nOpen ${agent.name}`}
      style={{
        display: 'grid', gap: compact ? 2 : 4, textAlign: 'left', width: '100%',
        background: planned ? 'transparent' : ink[2],
        border: `1px ${planned ? 'dashed' : 'solid'} ${border}`,
        borderRadius: 6,
        padding: compact ? '7px 10px' : '10px 12px',
        cursor: planned ? 'default' : 'pointer',
        opacity: planned ? 0.5 : inWorkflow ? 1 : 0.45,
        transition: 'border-color 0.2s, opacity 0.2s',
        color: fg[1],
        fontFamily: 'inherit',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <Glyph name={toolGlyph(agent.id)} size={compact ? 14 : 16} style={{ color: agent.is_manager ? AGENTS_MARK : fg[2] }} />
        <span style={{
          fontSize: compact ? 12 : 12.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {agent.name}
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {state === 'active' && (
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: accent, animation: 'agents-pulse 1.2s ease-in-out infinite' }} />
          )}
          {state === 'done' && <span style={{ fontFamily: fontNum, fontSize: 9.5, color: pos, letterSpacing: '0.08em' }}>DONE</span>}
          {planned
            ? <Chip mono>PLANNED</Chip>
            : <span style={{ fontFamily: fontNum, fontSize: 10, color: modelText.startsWith('OR ') ? AGENTS_MARK : fg[3], maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{modelText}</span>}
        </span>
      </div>
      {!compact && (
        <span style={{ fontSize: 11, color: fg[3], lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {agent.role}
        </span>
      )}
    </button>
  )
}

function OrgChart({
  roster, participants, stateOf, onOpen, modelTextOf,
}: {
  roster: AgentInfo[]
  participants: Set<string>
  stateOf: (a: AgentInfo) => 'idle' | 'active' | 'done'
  onOpen: (a: AgentInfo) => void
  modelTextOf: (a: AgentInfo) => string
}) {
  const byId = Object.fromEntries(roster.map(a => [a.id, a]))
  const reportsTo = (id: string) => roster.filter(a => a.reports_to === id)
  const deputy = byId['deputy-pm']
  const redTeam = byId['red-team']
  const pmDirect = reportsTo('pm').filter(a => a.id !== 'deputy-pm')       // CRO line
  const deputyDirect = reportsTo('deputy-pm').filter(a => a.id !== 'red-team')
  const units = deputyDirect.filter(a => a.is_manager)
  const singles = deputyDirect.filter(a => !a.is_manager && a.desk !== 'leadership')
  const staff = deputyDirect.filter(a => !a.is_manager && a.desk === 'leadership')
  const node = (a: AgentInfo, compact?: boolean) => (
    <AgentNode key={a.id} agent={a} compact={compact} inWorkflow={participants.has(a.id)} state={stateOf(a)} onOpen={onOpen} modelText={modelTextOf(a)} />
  )
  const columnStyle: React.CSSProperties = { display: 'grid', gap: 6, alignContent: 'start', minWidth: 0 }
  const connector = <div style={{ width: 1, height: 14, background: line2, margin: '0 auto' }} />

  return (
    <div style={{ display: 'grid', gap: 0 }}>
      {/* PM + independent risk line */}
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12 }}>
        <div style={{
          border: `1px solid ${line2}`, borderRadius: 6, padding: '6px 14px', fontSize: 12, color: fg[1],
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <Glyph name="agent" size={14} style={{ color: fg[2] }} />
          Portfolio Manager
          <span style={{ fontFamily: fontNum, fontSize: 10, color: fg[3] }}>HUMAN · FINAL SAY</span>
        </div>
        {pmDirect.map(a => (
          <div key={a.id} style={{ width: 270, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ flex: 1, borderTop: `1px dashed ${line2}` }} />
            <div style={{ width: 240 }}>{node(a, true)}</div>
          </div>
        ))}
      </div>
      {connector}

      {/* Deputy PM with Red Team and staff alongside */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr minmax(240px, 300px) 1fr', gap: 12, alignItems: 'center' }}>
        <div style={{ display: 'grid', gap: 6, justifyItems: 'end' }}>
          {staff.map(a => <div key={a.id} style={{ width: 200 }}>{node(a, true)}</div>)}
        </div>
        {deputy && node(deputy)}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {redTeam && (
            <>
              <span style={{ width: 18, borderTop: `1px solid ${line2}` }} />
              <div style={{ width: 220 }}>{node(redTeam)}</div>
            </>
          )}
        </div>
      </div>
      {connector}

      {/* Desks */}
      <div style={{ borderTop: `1px solid ${line2}`, paddingTop: 14, display: 'grid', gap: 14,
        gridTemplateColumns: `repeat(${Math.max(units.length + (singles.length ? 1 : 0), 1)}, minmax(0, 1fr))` }}>
        {units.map(head => (
          <div key={head.id} style={columnStyle}>
            <span className="hub-eyebrow" style={{ fontSize: 9.5 }}>{head.desk_name}</span>
            {node(head)}
            <div style={{ display: 'grid', gap: 5, paddingLeft: 12, borderLeft: `1px solid ${line}` }}>
              {reportsTo(head.id).map(a => node(a, true))}
            </div>
          </div>
        ))}
        {singles.length > 0 && (
          <div style={columnStyle}>
            <span className="hub-eyebrow" style={{ fontSize: 9.5 }}>Reporting directly</span>
            {singles.map(a => node(a, !a.enabled))}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AgentsPod() {
  const navigate = useNavigate()
  const headers = authHeaders()

  const [roster, setRoster] = useState<AgentInfo[]>([])
  const [workflows, setWorkflows] = useState<WorkflowInfo[]>([])
  const [workflowId, setWorkflowId] = useState<string>(() => {
    try { return localStorage.getItem(WORKFLOW_KEY) ?? 'rates-desk' } catch { return 'rates-desk' }
  })
  const [question, setQuestion] = useState('')
  const [runStatus, setRunStatus] = useState<RunStatus>('idle')
  const [events, setEvents] = useState<StreamEvent[]>([])
  const [showReasoning, setShowReasoning] = useState(false)
  const [synthesis, setSynthesis] = useState<{ agent: string; text: string } | null>(null)
  const [views, setViews] = useState<PodView[]>([])
  const [usage, setUsage] = useState<UsageRow[]>([])
  const [history, setHistory] = useState<RunSummary[]>([])
  const [pastRun, setPastRun] = useState<RunSummary | null>(null)
  const [activeNames, setActiveNames] = useState<Set<string>>(new Set())
  const [doneNames, setDoneNames] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const [catalogue, setCatalogue] = useState<ModelCatalogue | null>(null)
  const [runModel, setRunModel] = useState<string | null>(() => {
    try { return localStorage.getItem(RUN_MODEL_KEY) || null } catch { return null }
  })

  const feedRef = useRef<HTMLDivElement>(null)
  const esRef = useRef<EventSource | null>(null)

  const workflow = workflows.find(w => w.id === workflowId) ?? workflows[0]
  const participants = useMemo(() => new Set(workflow?.stages.flat() ?? []), [workflow])
  const names = useMemo(() => Object.fromEntries(roster.map(a => [a.id, a.name])), [roster])
  const workflowIds = useMemo(() => new Set([...workflows.map(w => w.id), ...LEGACY_POD_IDS]), [workflows])

  // ── Load ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    Promise.all([
      axios.get('/api/agents/roster?include_planned=true', { headers }),
      axios.get('/api/agents/workflows', { headers }),
    ])
      .then(([r, w]) => {
        setRoster(r.data.roster ?? [])
        setWorkflows(w.data.workflows ?? [])
      })
      .catch(err => {
        if (axios.isAxiosError(err) && err.response?.status === 401) {
          localStorage.removeItem('access_token')
          navigate('/login', { replace: true })
        }
      })
    axios.get('/api/agents/models', { headers }).then(r => setCatalogue(r.data)).catch(() => {})
    loadHistory()
    return () => esRef.current?.close()
  }, [])

  useEffect(() => {
    try { localStorage.setItem(WORKFLOW_KEY, workflowId) } catch { /* private mode */ }
  }, [workflowId])

  useEffect(() => {
    try {
      if (runModel) localStorage.setItem(RUN_MODEL_KEY, runModel)
      else localStorage.removeItem(RUN_MODEL_KEY)
    } catch { /* private mode */ }
  }, [runModel])

  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight
  }, [events, showReasoning])

  function loadHistory() {
    axios.get('/api/agents/runs', { headers })
      .then(r => setHistory(r.data.runs ?? []))
      .catch(() => {})
  }

  function loadRunExtras(runId: string, alsoOutput?: RunSummary) {
    axios.get(`/api/agents/runs/${runId}`, { headers }).then(res => {
      setViews(res.data.views ?? [])
      setUsage(res.data.usage ?? [])
      if (alsoOutput) {
        const final = (res.data.events ?? []).filter((e: { event_type: string }) => e.event_type === 'synthesis').pop()
        setSynthesis({ agent: final?.agent_name ?? '', text: res.data.run?.output ?? '' })
      }
    })
  }

  // ── Run ──────────────────────────────────────────────────────────────────
  function run() {
    if (!question.trim() || runStatus === 'running' || !workflow) return
    setRunStatus('running')
    setEvents([])
    setSynthesis(null)
    setViews([])
    setUsage([])
    setPastRun(null)
    setError('')
    setActiveNames(new Set())
    setDoneNames(new Set())

    axios.post('/api/agents/run', { question: question.trim(), workflow: workflow.id, model: runModel }, { headers })
      .then(res => openStream(res.data.run_id))
      .catch(err => {
        setRunStatus('error')
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

      if (ev.type === 'synthesis') { setSynthesis({ agent: ev.agent, text: ev.content }); return }
      if (ev.type === 'done') {
        setRunStatus('done')
        setActiveNames(new Set())
        es.close()
        loadHistory()
        loadRunExtras(runId)
        return
      }
      if (ev.type === 'error') {
        setRunStatus('error')
        setError(ev.content || 'Unknown error')
        setActiveNames(new Set())
        es.close()
        return
      }
      setEvents(prev => [...prev, ev])
      if (ev.agent && ev.agent !== 'system') {
        if (ev.type === 'task_done') {
          setActiveNames(prev => { const n = new Set(prev); n.delete(ev.agent); return n })
          setDoneNames(prev => new Set(prev).add(ev.agent))
        } else {
          setActiveNames(prev => prev.has(ev.agent) ? prev : new Set(prev).add(ev.agent))
        }
      }
    }
    es.onerror = () => {
      setRunStatus(prev => (prev === 'running' ? 'error' : prev))
      setError(prev => prev || 'Lost connection to the run stream.')
      es.close()
    }
  }

  function openPast(r: RunSummary) {
    setPastRun(r)
    setEvents([])
    setRunStatus('idle')
    setError('')
    setActiveNames(new Set())
    setDoneNames(new Set())
    loadRunExtras(r.run_id, r)
  }

  const stateOf = (a: AgentInfo): 'idle' | 'active' | 'done' =>
    activeNames.has(a.name) ? 'active' : doneNames.has(a.name) ? 'done' : 'idle'

  const modelTextOf = (a: AgentInfo) => {
    const spec = participants.has(a.id) ? effectiveSpec(a, runModel) : effectiveSpec(a, null)
    const label = spec === `anthropic:${a.model_id}` ? MODEL_LABEL[a.model] : modelLabel(spec, catalogue)
    return spec.startsWith('openrouter:') ? `OR ${label}` : label
  }
  const participantSpecs = roster.filter(a => a.enabled && participants.has(a.id)).map(a => effectiveSpec(a, runModel))
  const missingKeys = catalogue ? [
    participantSpecs.some(s => s.startsWith('anthropic:')) && !catalogue.anthropic_configured ? 'ANTHROPIC_API_KEY' : null,
    participantSpecs.some(s => s.startsWith('openrouter:')) && !catalogue.openrouter_configured ? 'OPENROUTER_API_KEY' : null,
  ].filter(Boolean) as string[] : []

  const enabledCount = roster.filter(a => a.enabled).length
  const plannedCount = roster.length - enabledCount
  const podHistory = history.filter(r => workflowIds.has(r.agent_id))
  const visibleEvents = showReasoning ? events : events.filter(e => e.type !== 'thinking')
  const workflowLabel = (id: string) => workflows.find(w => w.id === id)?.label ?? (id === 'fixed-income-pod' ? 'Fixed Income Pod (legacy)' : id)

  const panel: React.CSSProperties = { padding: '18px 20px', marginBottom: 16 }

  return (
    <div style={{ background: ink[0], minHeight: '100vh', color: fg[1], paddingBottom: 80 }}>
      <style>{KEYFRAMES}</style>

      {/* Header */}
      <div style={{ ...headerBar, padding: '12px 32px', display: 'flex', alignItems: 'center', gap: 16 }}>
        <PageTitle
          category="Agents"
          categoryId="agents"
          title="Global Macro Pod"
          subtitle={`${enabledCount} agents active · ${plannedCount} planned · advisory only, the PM decides`}
        />
        {runStatus === 'running' && (
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Spinner />
            <span className="hub-eyebrow" style={{ color: accent }}>
              {workflow?.label} · {activeNames.size} working · {doneNames.size} done
            </span>
          </div>
        )}
      </div>

      <div style={{ maxWidth: 1240, margin: '0 auto', padding: '24px 32px' }}>

        {/* Organisation */}
        <div className="hub-frame" style={panel}>
          <SectionLabel right={workflow && <span style={{ fontSize: 11, color: fg[3] }}>Highlighted: agents in {workflow.label}</span>}>
            Organisation
          </SectionLabel>
          {roster.length > 0
            ? <OrgChart roster={roster} participants={participants} stateOf={stateOf} modelTextOf={modelTextOf} onOpen={a => navigate(`/tools/agents/${a.id}`)} />
            : <p style={{ color: fg[3], fontSize: 12, margin: 0 }}>Loading roster…</p>}
        </div>

        {/* Briefing */}
        <div className="hub-frame" style={panel}>
          <SectionLabel>Briefing</SectionLabel>
          <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
            {workflows.map(w => {
              const on = w.id === workflow?.id
              return (
                <button
                  key={w.id}
                  onClick={() => setWorkflowId(w.id)}
                  disabled={runStatus === 'running'}
                  style={{
                    background: on ? ink[3] : 'transparent',
                    border: `1px solid ${on ? `${accent}66` : line2}`,
                    borderRadius: 6, color: on ? fg[1] : fg[2], cursor: runStatus === 'running' ? 'default' : 'pointer',
                    fontSize: 12, padding: '6px 12px', fontFamily: 'inherit',
                  }}
                >
                  {w.label}
                </button>
              )
            })}
          </div>
          {workflow && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12, fontSize: 11.5, color: fg[3] }}>
              <span>{workflow.description}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: fontNum, fontSize: 10.5 }}>
                {workflow.stages.map((s, i) => (
                  <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {i > 0 && <Glyph name="arrow" size={12} style={{ color: fg[4] }} />}
                    <Chip mono>{s.length === 1 ? names[s[0]] ?? s[0] : `${s.length} agents`}</Chip>
                  </span>
                ))}
              </span>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
            <span className="hub-eyebrow">Models</span>
            <ModelPicker
              value={runModel}
              onChange={setRunModel}
              catalogue={catalogue}
              defaultLabel="Each agent's own model (roster default or saved choice)"
              disabled={runStatus === 'running'}
              width={340}
            />
            {missingKeys.length > 0 && (
              <span style={{ fontSize: 11.5, color: neg }}>
                Not configured: {missingKeys.join(', ')}. Add to backend/.env and restart the backend.
              </span>
            )}
            {catalogue?.openrouter_error && <span style={{ fontSize: 11.5, color: fg[3] }}>{catalogue.openrouter_error}</span>}
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'stretch' }}>
            <textarea
              value={question}
              onChange={e => setQuestion(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run() }}
              placeholder="Ask the pod, e.g. 'Where is the best risk/reward in EUR rates over the next month?'"
              rows={3}
              disabled={runStatus === 'running'}
              style={{
                flex: 1, background: ink[1], border: `1px solid ${line2}`, borderRadius: 6, color: fg[1],
                fontSize: 13, lineHeight: 1.6, padding: '10px 14px', resize: 'vertical', outline: 'none', fontFamily: 'inherit',
              }}
            />
            <button
              onClick={run}
              disabled={!question.trim() || runStatus === 'running'}
              style={{
                background: !question.trim() || runStatus === 'running' ? ink[2] : `${accent}26`,
                border: `1px solid ${!question.trim() || runStatus === 'running' ? line2 : `${accent}88`}`,
                borderRadius: 6, color: !question.trim() || runStatus === 'running' ? fg[3] : fg[1],
                cursor: !question.trim() || runStatus === 'running' ? 'not-allowed' : 'pointer',
                fontSize: 12.5, padding: '0 20px', display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'inherit',
              }}
            >
              {runStatus === 'running' ? <><Spinner size={11} /> Running</> : <>Run <Glyph name="arrow" size={13} /></>}
            </button>
          </div>
          <p style={{ color: fg[4], fontSize: 10.5, margin: '6px 0 0', fontFamily: fontNum }}>⌘ ENTER TO RUN</p>
        </div>

        {error && (
          <div style={{
            border: `1px solid ${neg}55`, borderRadius: 6, color: neg, fontSize: 12, padding: '10px 14px', marginBottom: 16,
          }}>
            {error}
          </div>
        )}

        {/* Activity */}
        {events.length > 0 && (
          <div className="hub-frame" style={panel}>
            <SectionLabel right={
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: fg[3], cursor: 'pointer' }}>
                <input type="checkbox" checked={showReasoning} onChange={e => setShowReasoning(e.target.checked)} />
                Show reasoning
              </label>
            }>
              Activity · {events.length} events
            </SectionLabel>
            <div ref={feedRef} style={{ maxHeight: runStatus === 'running' ? 380 : 220, overflowY: 'auto', paddingRight: 6 }}>
              {visibleEvents.map((ev, i) => <EventLine key={i} event={ev} />)}
            </div>
          </div>
        )}

        {/* Synthesis */}
        {synthesis && synthesis.text && (
          <div className="hub-frame" style={{ ...panel, borderColor: `${AGENTS_MARK}44` }}>
            <SectionLabel right={pastRun ? <span style={{ fontSize: 11, color: fg[3] }}>Past run · {formatDate(pastRun.created_at)}</span> : <StatusChip status="done" />}>
              {(synthesis.agent || 'Synthesis')} · {pastRun ? workflowLabel(pastRun.agent_id) : workflow?.label}
            </SectionLabel>
            {pastRun && <p style={{ color: fg[2], fontSize: 12.5, margin: '0 0 10px' }}>{pastRun.question}</p>}
            <Markdown text={synthesis.text} />
          </div>
        )}

        {/* Views + usage */}
        {(views.length > 0 || usage.length > 0) && (
          <div className="hub-frame" style={panel}>
            <SectionLabel right={<UsageSummary usage={usage} />}>Views recorded · {views.length}</SectionLabel>
            <ViewsTable views={views} names={names} />
            <p style={{ color: fg[4], fontSize: 10.5, margin: '10px 0 0' }}>
              Hover a row for the rationale. SIM marks views resting on simulated data (Bloomberg not connected).
            </p>
          </div>
        )}

        {/* History */}
        <div className="hub-frame" style={panel}>
          <SectionLabel>Past briefings · {podHistory.length}</SectionLabel>
          {podHistory.length === 0
            ? <p style={{ color: fg[3], fontSize: 12, margin: 0 }}>No briefings yet.</p>
            : (
              <div style={{ display: 'grid' }}>
                {podHistory.slice(0, 25).map(r => (
                  <button
                    key={r.run_id}
                    onClick={() => openPast(r)}
                    style={{
                      display: 'grid', gridTemplateColumns: '120px 170px 1fr auto', gap: 12, alignItems: 'center',
                      background: pastRun?.run_id === r.run_id ? ink[2] : 'transparent',
                      border: 'none', borderBottom: `1px solid ${line}`, padding: '8px 6px',
                      cursor: 'pointer', textAlign: 'left', color: fg[2], fontFamily: 'inherit',
                    }}
                  >
                    <span style={{ fontFamily: fontNum, fontSize: 11, color: fg[3] }}>{formatDate(r.created_at)}</span>
                    <span style={{ fontSize: 11.5, color: fg[3] }}>{workflowLabel(r.agent_id)}</span>
                    <span style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.question}</span>
                    <StatusChip status={r.status} />
                  </button>
                ))}
              </div>
            )}
        </div>
      </div>
    </div>
  )
}
