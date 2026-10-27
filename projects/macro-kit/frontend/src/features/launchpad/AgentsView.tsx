import { Fragment, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import axios from 'axios'
import { authHeaders } from '../../api/client'
import { AgentInfo, MODEL_LABEL } from '../../components/agentsUi'
import Glyph from '../../components/Glyph'
import { OrgChart } from '../../components/podOrgChart'

// Agents tab: which workflow to call when, how each one runs (stage by stage), and the whole
// pod's hierarchy with the selected workflow's agents highlighted.
// Data: GET /api/agents/roster (backend/pod/roster.yaml) and /api/agents/workflows (pod/workflows.py).

interface WorkflowInfo {
  id: string
  label: string
  description: string
  stages: string[][]
  final_agent: string
  placeholder?: string
  use_when?: string
  human_step?: string | null
}

const POD_URL = '/tools/agents/fixed-income-pod'
const WORKFLOW_KEY = 'pod.workflow'   // the pod page's selected workflow (AgentsPod.tsx)
const DESK_HEAD = '(desk head)'
const MAX_NAMES = 6

// Agents a workflow can involve. "(desk head)" is picked at run time by the Coordinator from
// the research desk heads, so all of them are candidates.
function participantsOf(w: WorkflowInfo, roster: AgentInfo[]): Set<string> {
  const ids = new Set(w.stages.flat())
  if (ids.delete(DESK_HEAD)) {
    roster
      .filter((a) => a.is_manager && a.reports_to === 'deputy-pm' && !['pod-coordinator', 'head-of-trading'].includes(a.id))
      .forEach((a) => ids.add(a.id))
  }
  return ids
}

function StageBox({ index, stage, names, final }: { index: number; stage: string[]; names: Record<string, string>; final: string }) {
  const label = (id: string) => (id === DESK_HEAD ? 'Desk head (picked by the Coordinator)' : names[id] ?? id)
  const shown = stage.slice(0, MAX_NAMES)
  const rest = stage.length - shown.length
  return (
    <div className="hub-frame px-3 py-2.5 min-w-[150px] max-w-[260px] grid gap-1.5 content-start">
      <div className="flex items-center gap-2 hub-num text-[10px] text-fg-3 uppercase tracking-[0.1em]">
        <span>Step {index + 1}</span>
        {stage.length > 1 && <span className="text-fg-4">· {stage.length} in parallel</span>}
      </div>
      <div className="grid gap-1">
        {shown.map((id) => (
          <span key={id} className="flex items-center gap-1.5 text-[12px] text-fg-1 leading-snug">
            <span className="truncate">{label(id)}</span>
            {id === final && <span className="hub-num text-[9.5px] text-accent tracking-[0.08em] flex-shrink-0">FINAL</span>}
          </span>
        ))}
        {rest > 0 && (
          <span className="text-[11.5px] text-fg-3" title={stage.slice(MAX_NAMES).map(label).join('\n')}>
            +{rest} more
          </span>
        )}
      </div>
    </div>
  )
}

function Pipeline({ workflow, names, onOpenPod }: { workflow: WorkflowInfo; names: Record<string, string>; onOpenPod: () => void }) {
  const arrow = <Glyph name="arrow" size={14} className="text-fg-4 self-center flex-shrink-0" />
  return (
    <section className="hub-frame px-5 pt-4 pb-4">
      <header className="flex flex-wrap items-start justify-between gap-4 mb-3">
        <div className="min-w-0 max-w-[860px]">
          <div className="hub-eyebrow mb-1.5">How it runs</div>
          <h3 className="text-[15px] font-normal text-fg-1 m-0">{workflow.label}</h3>
          <p className="mt-1 mb-0 text-[12.5px] text-fg-3 leading-relaxed">{workflow.description}</p>
        </div>
        <button
          type="button"
          onClick={onOpenPod}
          className="flex items-center gap-1.5 rounded border border-[rgba(134,192,222,0.45)] bg-[rgba(134,192,222,0.10)] px-3 py-1.5 text-[12px] text-accent transition-colors duration-150 hover:bg-[rgba(134,192,222,0.18)]"
        >
          Run in the pod <Glyph name="arrow" size={14} />
        </button>
      </header>
      <div className="flex flex-wrap items-stretch gap-2">
        {workflow.stages.map((stage, i) => (
          <Fragment key={i}>
            {i > 0 && arrow}
            <StageBox index={i} stage={stage} names={names} final={workflow.final_agent} />
          </Fragment>
        ))}
        {workflow.human_step && (
          <>
            {arrow}
            <div className="rounded-md border border-dashed border-[rgba(150,178,205,0.28)] px-3 py-2.5 min-w-[150px] max-w-[240px] grid gap-1.5 content-start">
              <div className="hub-num text-[10px] text-fg-3 uppercase tracking-[0.1em]">Portfolio Manager</div>
              <span className="text-[12px] text-fg-1 leading-snug">{workflow.human_step}</span>
            </div>
          </>
        )}
      </div>
      {workflow.placeholder && <p className="mt-3 mb-0 text-[12px] text-fg-4">{workflow.placeholder}</p>}
    </section>
  )
}

export default function AgentsView() {
  const navigate = useNavigate()
  const [roster, setRoster] = useState<AgentInfo[]>([])
  const [workflows, setWorkflows] = useState<WorkflowInfo[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const headers = authHeaders()
    Promise.all([
      axios.get('/api/agents/roster?include_planned=true', { headers }),
      axios.get('/api/agents/workflows', { headers }),
    ])
      .then(([r, w]) => {
        const agents = Array.isArray(r.data?.roster) ? (r.data.roster as AgentInfo[]) : []
        const wfs = Array.isArray(w.data?.workflows) ? (w.data.workflows as WorkflowInfo[]) : []
        if (!agents.length) throw new Error('empty roster')
        setRoster(agents)
        setWorkflows(wfs)
      })
      .catch(() => setError('The pod roster could not load. Check that the API server is running, then refresh.'))
  }, [])

  const names = useMemo(() => Object.fromEntries(roster.map((a) => [a.id, a.name])), [roster])
  const workflow = workflows.find((w) => w.id === selected) ?? null
  const participants = useMemo(
    () => (workflow ? participantsOf(workflow, roster) : new Set(roster.map((a) => a.id))),
    [workflow, roster],
  )

  function openInPod(id: string) {
    try { localStorage.setItem(WORKFLOW_KEY, id) } catch { /* private mode */ }
    navigate(POD_URL)
  }

  if (error) return <div className="rounded-md px-4 py-3 text-sm text-neg bg-neg/10 border border-neg/20">{error}</div>
  if (!roster.length) {
    return (
      <div className="flex items-center justify-center py-32">
        <span className="hub-eyebrow animate-pulse">Loading the pod</span>
      </div>
    )
  }

  const enabled = roster.filter((a) => a.enabled).length
  const desks = new Set(roster.map((a) => a.desk)).size

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-[820px]">
          <h2 className="text-[17px] font-normal text-fg-1 m-0">Global Macro Pod</h2>
          <p className="mt-1 mb-0 text-[12.5px] text-fg-3 leading-relaxed">
            Pick a workflow by what you need. Each one runs its agents in stages, specialists in parallel and then
            the agent that writes the answer. For a question one specialist owns, open that agent from the chart.
          </p>
        </div>
        <dl className="flex gap-7 m-0">
          {[[enabled, 'Agents'], [desks, 'Desks'], [workflows.length, 'Workflows']].map(([v, l]) => (
            <div key={l} className="grid gap-0.5 text-right">
              <dd className="hub-num text-[20px] leading-none text-fg-1 tracking-[-0.02em] m-0">{String(v).padStart(2, '0')}</dd>
              <dt className="hub-eyebrow text-[10px]">{l}</dt>
            </div>
          ))}
        </dl>
      </div>

      {/* Which workflow, when */}
      <section className="hub-frame px-5 pt-4 pb-3">
        <div className="hub-eyebrow mb-2">Which workflow to call</div>
        <div className="grid">
          {workflows.map((w) => {
            const on = w.id === selected
            const n = participantsOf(w, roster).size
            return (
              <button
                key={w.id}
                type="button"
                aria-pressed={on}
                onClick={() => setSelected(on ? null : w.id)}
                className={
                  'grid grid-cols-[minmax(150px,220px)_minmax(0,1fr)_auto] items-baseline gap-4 -mx-2 px-2 py-[7px] rounded text-left transition-colors duration-100 border-l-2 ' +
                  (on ? 'bg-ink-2 border-accent' : 'border-transparent hover:bg-ink-2')
                }
              >
                <span className="text-[13px] text-fg-1">{w.label}</span>
                <span className="text-[12.5px] text-fg-3 leading-snug">{w.use_when ?? w.description}</span>
                <span className="hub-num text-[11px] text-fg-3 whitespace-nowrap">
                  {w.stages.length} {w.stages.length === 1 ? 'step' : 'steps'} · {n} {n === 1 ? 'agent' : 'agents'}
                </span>
              </button>
            )
          })}
          <div className="grid grid-cols-[minmax(150px,220px)_minmax(0,1fr)_auto] items-baseline gap-4 -mx-2 px-2 py-[7px]">
            <span className="text-[13px] text-fg-1">One agent</span>
            <span className="text-[12.5px] text-fg-3 leading-snug">
              You know which specialist owns the question: click them in the chart below to talk to them directly.
            </span>
            <span className="hub-num text-[11px] text-fg-3">1 agent</span>
          </div>
        </div>
      </section>

      {workflow && <Pipeline workflow={workflow} names={names} onOpenPod={() => openInPod(workflow.id)} />}

      {/* Hierarchy */}
      <section className="hub-frame px-5 pt-4 pb-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3 mb-3">
          <div className="hub-eyebrow">Hierarchy</div>
          <span className="text-[11.5px] text-fg-4">
            {workflow ? `Highlighted: the agents ${workflow.label} can involve` : 'Select a workflow above to highlight its agents'}
          </span>
        </div>
        <OrgChart
          roster={roster}
          participants={participants}
          stateOf={() => 'idle'}
          modelTextOf={(a) => a.model_label ?? MODEL_LABEL[a.model] ?? a.model}
          onOpen={(a) => navigate(`/tools/agents/${a.id}`)}
        />
      </section>

      <Link to={POD_URL} className="justify-self-start flex items-center gap-1.5 text-[12px] text-accent no-underline">
        Open the pod: run history, trade ledger and alerts <Glyph name="arrow" size={14} />
      </Link>
    </div>
  )
}
