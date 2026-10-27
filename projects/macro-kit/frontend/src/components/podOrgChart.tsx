import Glyph, { toolGlyph } from './Glyph'
import { accent, fg, fontNum, ink, line, line2, pos, warn } from '../theme'
import { AGENTS_MARK, AgentInfo, Chip } from './agentsUi'

// The pod's org chart (backend/pod/roster.yaml): PM, Deputy PM and Red Team, the CRO's independent
// line, then one column per desk. Used by the pod page and the launchpad's Agents tab.

// ---------------------------------------------------------------------------
// Org chart
// ---------------------------------------------------------------------------

export function AgentNode({
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
  const limited = (agent.missing_tools?.length ?? 0) > 0
  const border = state === 'active' ? accent : state === 'done' ? `${pos}88` : line2
  return (
    <button
      onClick={() => !planned && onOpen(agent)}
      title={planned
        ? `Planned · needs ${agent.blocked_on.join(', ')}`
        : `${agent.name} · ${modelText}\n${agent.role}${limited ? `\nLimited: missing ${agent.missing_tools.join(', ')}` : ''}`}
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
          {limited && !planned && (
            <span style={{ width: 5, height: 5, borderRadius: 1, background: warn, flexShrink: 0 }} />
          )}
          {planned
            ? <Chip mono>PLANNED</Chip>
            : (compact && !modelText.startsWith('OR ')) ? null : <span style={{ fontFamily: fontNum, fontSize: 10, color: modelText.startsWith('OR ') ? AGENTS_MARK : fg[3], maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{modelText}</span>}
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

export function OrgChart({
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
  const riskHeads = reportsTo('pm').filter(a => a.id !== 'deputy-pm')          // CRO: independent line
  const units = reportsTo('deputy-pm').filter(a => a.is_manager)               // desks + coordinator
  const singles = reportsTo('deputy-pm').filter(a => !a.is_manager && a.id !== 'red-team')
  const node = (a: AgentInfo, compact?: boolean) => (
    <AgentNode key={a.id} agent={a} compact={compact} inWorkflow={participants.has(a.id)} state={stateOf(a)} onOpen={onOpen} modelText={modelTextOf(a)} />
  )
  const column = (head: AgentInfo, label: string) => (
    <div key={head.id} style={{ display: 'grid', gap: 6, alignContent: 'start', minWidth: 0 }}>
      <span className="hub-eyebrow" style={{ fontSize: 9.5 }}>{label}</span>
      {node(head)}
      <div style={{ display: 'grid', gap: 5, paddingLeft: 10, borderLeft: `1px solid ${line}` }}>
        {reportsTo(head.id).map(a => node(a, true))}
      </div>
    </div>
  )
  const connector = <div style={{ width: 1, height: 14, background: line2, margin: '0 auto' }} />

  return (
    <div style={{ display: 'grid', gap: 0 }}>
      {/* PM */}
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <div style={{
          border: `1px solid ${line2}`, borderRadius: 6, padding: '6px 14px', fontSize: 12, color: fg[1],
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <Glyph name="agent" size={14} style={{ color: fg[2] }} />
          Portfolio Manager
          <span style={{ fontFamily: fontNum, fontSize: 10, color: fg[3] }}>HUMAN · FINAL SAY</span>
        </div>
      </div>
      {connector}

      {/* Deputy PM + Red Team | independent risk line */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(260px, 300px) minmax(0, 1fr)', gap: 14, alignItems: 'start' }}>
        <div />
        <div style={{ display: 'grid', gap: 6 }}>
          {deputy && node(deputy)}
          {redTeam && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 14, borderTop: `1px solid ${line2}` }} />
              <div style={{ flex: 1, minWidth: 0 }}>{node(redTeam, true)}</div>
            </div>
          )}
        </div>
        <div style={{ display: 'grid', gap: 6, alignContent: 'start', borderLeft: `1px dashed ${line2}`, paddingLeft: 14 }}>
          <span className="hub-eyebrow" style={{ fontSize: 9.5 }}>Risk · reports to the PM</span>
          {riskHeads.map(h => (
            <div key={h.id} style={{ display: 'grid', gap: 5 }}>
              {node(h)}
              <div style={{ display: 'grid', gap: 5, paddingLeft: 10, borderLeft: `1px solid ${line}` }}>
                {reportsTo(h.id).map(a => node(a, true))}
              </div>
            </div>
          ))}
        </div>
      </div>
      {connector}

      {/* Desks */}
      <div style={{
        borderTop: `1px solid ${line2}`, paddingTop: 14, display: 'grid', gap: 14,
        gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
      }}>
        {units.map(h => column(h, h.id === 'pod-coordinator' ? 'Shared Services' : h.desk_name))}
        {singles.length > 0 && (
          <div style={{ display: 'grid', gap: 6, alignContent: 'start' }}>
            <span className="hub-eyebrow" style={{ fontSize: 9.5 }}>Reporting directly</span>
            {singles.map(a => node(a, true))}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 12, fontSize: 10.5, color: fg[4] }}>
        <span style={{ width: 5, height: 5, borderRadius: 1, background: warn }} />
        Limited: some planned tools or data sources are not built yet (hover an agent for details).
      </div>
    </div>
  )
}
