import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import Glyph, { GlyphName } from './Glyph'
import ToolIcon from './ToolIcon'
import Monogram from './Monogram'
import { FlatTool, clearDashboardConfig, flattenTools, loadDashboardConfig, pushRecent, readRecent } from '../hubData'
import { categoryColor } from '../theme'

// ─── Rail button ──────────────────────────────────────────────────────────────

function RailItem({
  label, glyph, icon, active, onClick, to,
}: { label: string; glyph?: GlyphName; icon?: React.ReactNode; active?: boolean; onClick?: () => void; to?: string }) {
  const cls =
    'group relative flex items-center justify-center w-[34px] h-[34px] rounded transition-colors duration-150 ' +
    (active ? 'text-fg-1 bg-ink-2' : 'text-fg-2 hover:text-fg-1 hover:bg-ink-2')
  const inner = (
    <>
      {active && <span className="absolute -left-[11px] top-[9px] bottom-[9px] w-[2px] rounded bg-accent" />}
      {icon ?? (glyph && <Glyph name={glyph} size={18} />)}
      <span
        className="pointer-events-none absolute left-[46px] top-1/2 -translate-y-1/2 whitespace-nowrap rounded border border-hairline bg-ink-2 px-2 py-1 text-[11px] text-fg-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 z-[300]"
      >
        {label}
      </span>
    </>
  )
  return to ? (
    <Link to={to} aria-label={label} className={cls}>{inner}</Link>
  ) : (
    <button type="button" aria-label={label} onClick={onClick} className={cls}>{inner}</button>
  )
}

// ─── ⌘K palette ──────────────────────────────────────────────────────────────

function Palette({ tools, onClose }: { tools: FlatTool[]; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const navigate = useNavigate()
  const listRef = useRef<HTMLDivElement>(null)

  const results = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
    if (!terms.length) return tools
    return tools.filter((t) => {
      const hay = `${t.name} ${t.categoryName} ${t.id}`.toLowerCase()
      return terms.every((term) => hay.includes(term))
    })
  }, [q, tools])

  useEffect(() => setSel(0), [q])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  function go(t: FlatTool) {
    onClose()
    navigate(t.url)
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)) }
    else if (e.key === 'Enter' && results[sel]) { e.preventDefault(); go(results[sel]) }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }

  return (
    <div
      className="fixed inset-0 z-[400] flex items-start justify-center px-4 pt-[14vh]"
      style={{ background: 'rgba(4,6,8,0.62)', backdropFilter: 'blur(3px)' }}
      onMouseDown={onClose}
    >
      <div
        className="hub-frame hub-enter w-full max-w-[560px] overflow-hidden"
        style={{ boxShadow: '0 40px 80px -30px rgba(0,0,0,0.85)' }}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Jump to tool"
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-hairline">
          <Glyph name="search" size={16} className="text-fg-3" />
          <input
            id="hub-palette-input"
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Jump to tool…"
            className="flex-1 bg-transparent outline-none text-[14px] text-fg-1 placeholder:text-fg-4"
            style={{ outline: 'none' }}
          />
          <kbd className="hub-num text-[10px] text-fg-3 border border-hairline rounded px-1.5 py-0.5">ESC</kbd>
        </div>
        <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-1.5">
          {results.length === 0 && (
            <div className="px-4 py-8 text-center text-[13px] text-fg-3">No tool matches “{q}”.</div>
          )}
          {results.map((t, i) => (
            <button
              key={t.url}
              type="button"
              data-idx={i}
              onMouseEnter={() => setSel(i)}
              onClick={() => go(t)}
              className={
                'w-full grid grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2 text-left transition-colors duration-100 ' +
                (i === sel ? 'bg-ink-2 text-fg-1' : 'text-fg-2')
              }
            >
              <ToolIcon toolId={t.id} categoryId={t.categoryId} size={14} />
              <span className="truncate text-[13px]">{t.name}</span>
              <span className="flex items-center gap-2 hub-num text-[10px] uppercase tracking-[0.12em] text-fg-3">
                <span className="w-[6px] h-[6px] rounded-[1px]" style={{ background: categoryColor[t.categoryId] ?? '#9aa5b1' }} />
                {t.categoryName}
              </span>
            </button>
          ))}
        </div>
        <div className="flex justify-between px-4 py-2 border-t border-hairline hub-num text-[10px] text-fg-4">
          <span>↑↓ navigate · ↵ open</span>
          <span>{results.length} tools</span>
        </div>
      </div>
    </div>
  )
}

// ─── Shell ────────────────────────────────────────────────────────────────────

export default function AppShell({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const navigate = useNavigate()
  const [tools, setTools] = useState<FlatTool[]>([])
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [recent, setRecent] = useState<string[]>(readRecent)

  useEffect(() => {
    loadDashboardConfig().then((c) => setTools(flattenTools(c))).catch(() => {})
  }, [])

  // Track recently opened tools
  useEffect(() => {
    if (location.pathname.startsWith('/tools/')) {
      pushRecent(location.pathname)
      setRecent(readRecent())
    }
    setPaletteOpen(false)
  }, [location.pathname])

  const togglePalette = useCallback(() => setPaletteOpen((o) => !o), [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        togglePalette()
      }
    }
    const onOpen = () => setPaletteOpen(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('hub:palette', onOpen)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('hub:palette', onOpen)
    }
  }, [togglePalette])

  function signOut() {
    localStorage.removeItem('access_token')
    clearDashboardConfig()
    navigate('/login', { replace: true })
  }

  const byUrl = useMemo(() => new Map(tools.map((t) => [t.url, t])), [tools])
  const recentTools = recent.map((u) => byUrl.get(u)).filter((t): t is FlatTool => !!t)

  return (
    <>
      <nav
        aria-label="Primary"
        className="fixed left-0 top-0 bottom-0 z-[200] flex flex-col items-center gap-1.5 py-3.5 border-r border-hairline"
        style={{ width: 'var(--rail-w)', background: 'rgba(7,9,12,0.94)', backdropFilter: 'blur(10px)' }}
      >
        <Link to="/" aria-label="Launchpad" className="mb-3.5 rounded-[7px]">
          <Monogram size={30} />
        </Link>
        <RailItem label="Summary" glyph="ledger" to="/" active={location.pathname === '/'} />
        <RailItem label="Agents" glyph="pod" to="/agents" active={location.pathname === '/agents'} />
        <RailItem label="Tools" glyph="home" to="/tools" active={location.pathname === '/tools'} />
        <RailItem label="Jump to tool  ⌘K" glyph="search" onClick={togglePalette} active={paletteOpen} />

        {recentTools.length > 0 && <div className="my-2 w-5 h-px bg-hairline" />}
        {recentTools.map((t) => (
          <RailItem
            key={t.url}
            label={t.name}
            icon={<ToolIcon toolId={t.id} categoryId={t.categoryId} size={16} tile={false} />}
            to={t.url}
            active={location.pathname === t.url}
          />
        ))}

        <div className="flex-1" />
        <RailItem label="Sign out" glyph="logout" onClick={signOut} />
      </nav>

      <div style={{ paddingLeft: 'var(--rail-w)' }}>{children}</div>

      {paletteOpen && <Palette tools={tools} onClose={() => setPaletteOpen(false)} />}
    </>
  )
}
