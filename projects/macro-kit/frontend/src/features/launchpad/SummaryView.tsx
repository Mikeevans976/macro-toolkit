import { useEffect, useState } from 'react'
import axios from 'axios'
import { authHeaders } from '../../api/client'
import { accent, fontNum, neg, pos } from '../../theme'

// Trade themes from backend/data/trade_themes.json (GET /api/themes): each theme's scenario
// distribution and the trades under it. Expected P&L and totals are computed by the backend.

interface Scenario {
  key: string
  name: string
  prob: number
  detail: string
  pnl_k: number
}

interface Trade {
  id: string
  name: string
  entry: string
  target: string
  stop: string
  conviction: number
  size: string
  max_loss_k: number
  scenario_pnl_k: number[]
  expected_pnl_k: number
}

interface Theme {
  id: number
  short: string
  name: string
  headline: string
  scenarios: Scenario[]
  trades: Trade[]
  max_loss_k: number
  expected_pnl_k: number
}

interface Book {
  title: string
  as_of: string
  horizon: string
  source: string
  notes: string[]
  interactions: { lead: string; text: string }[]
  themes: Theme[]
  totals: { themes: number; trades: number; max_loss_k: number; expected_pnl_k: number }
}

// £ thousands → "£1.51m" / "£502k", with an explicit sign when asked
function fmtK(k: number, signed = false): string {
  const sign = signed ? (k > 0.5 ? '+' : k < -0.5 ? '−' : '') : k < 0 ? '−' : ''
  const a = Math.abs(k)
  const body = a >= 1000 ? `£${(a / 1000).toFixed(2)}m` : `£${Math.round(a)}k`
  return sign + body
}

const pnlColor = (k: number) => (k > 0.5 ? pos : k < -0.5 ? neg : undefined)

function isBook(d: unknown): d is Book {
  return !!d && typeof d === 'object' && Array.isArray((d as Book).themes) && !!(d as Book).totals
}

// ─── Scenario distribution ─────────────────────────────────────────────────

function ScenarioRows({ theme, pnlScale }: { theme: Theme; pnlScale: number }) {
  return (
    <div className="grid gap-1">
      <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.2fr)] gap-4 hub-eyebrow text-[10px] pb-1">
        <span>Scenario</span>
        <span>Probability</span>
        <span>Theme P&amp;L</span>
      </div>
      {theme.scenarios.map((s) => {
        const w = Math.min(50, (Math.abs(s.pnl_k) / pnlScale) * 50)
        return (
          <div
            key={s.key}
            title={`${s.key}. ${s.name}: ${s.detail}`}
            className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.2fr)] gap-4 items-center py-[5px] -mx-2 px-2 rounded hover:bg-ink-2 transition-colors duration-100"
          >
            <span className="truncate text-[12.5px] text-fg-1">
              <span className="hub-num text-fg-3 mr-2">{s.key}</span>
              {s.name}
            </span>
            <span className="flex items-center gap-2.5 min-w-0">
              <span className="relative flex-1 h-[8px] rounded-[2px] bg-[rgba(150,178,205,0.07)] overflow-hidden">
                <span className="absolute left-0 top-0 bottom-0 rounded-[2px]" style={{ width: `${s.prob * 100}%`, background: accent }} />
              </span>
              <span className="hub-num text-[12px] text-fg-1 w-[34px] text-right">{Math.round(s.prob * 100)}%</span>
            </span>
            <span className="flex items-center gap-2.5 min-w-0">
              <span className="relative flex-1 h-[8px]">
                <span className="absolute left-1/2 -top-[3px] -bottom-[3px] w-px bg-[rgba(150,178,205,0.22)]" />
                <span
                  className="absolute top-0 bottom-0 rounded-[2px]"
                  style={{
                    background: pnlColor(s.pnl_k) ?? '#77828f',
                    width: `${w}%`,
                    left: s.pnl_k >= 0 ? '50%' : `${50 - w}%`,
                  }}
                />
              </span>
              <span className="hub-num text-[12px] w-[62px] text-right text-fg-1">{fmtK(s.pnl_k, true)}</span>
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ─── Trades table ──────────────────────────────────────────────────────────

const th = 'px-2 py-1.5 font-medium text-fg-3 text-[10px] uppercase tracking-[0.06em] whitespace-nowrap border-b border-hairline'
const td = 'px-2 py-[6px] border-b border-[rgba(150,178,205,0.05)] whitespace-nowrap'

function TradesTable({ theme }: { theme: Theme }) {
  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr>
            <th className={`${th} text-left`}>#</th>
            <th className={`${th} text-left`}>Trade</th>
            <th className={`${th} text-right`}>Entry</th>
            <th className={`${th} text-right`}>Target</th>
            <th className={`${th} text-right`}>Stop</th>
            <th className={`${th} text-right`} title="Conviction, 2–4">Conv.</th>
            <th className={`${th} text-right`}>Max loss</th>
            <th className={`${th} text-right`}>Exp. P&amp;L</th>
            {theme.scenarios.map((s) => (
              <th key={s.key} className={`${th} text-right`} title={s.name}>
                {s.key} <span className="text-fg-4">{Math.round(s.prob * 100)}%</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {theme.trades.map((t) => (
            <tr key={t.id} className="hover:bg-ink-2 transition-colors duration-100" title={`Size ${t.size}`}>
              <td className={`${td} hub-num text-fg-3`}>{t.id}</td>
              <td className={`${td} text-fg-1 whitespace-normal min-w-[220px]`}>{t.name}</td>
              <td className={`${td} hub-num text-right text-fg-2`}>{t.entry}</td>
              <td className={`${td} hub-num text-right text-fg-2`}>{t.target}</td>
              <td className={`${td} hub-num text-right text-fg-2`}>{t.stop}</td>
              <td className={`${td} hub-num text-right text-fg-2`}>{t.conviction}</td>
              <td className={`${td} hub-num text-right text-fg-2`}>{fmtK(t.max_loss_k)}</td>
              <td className={`${td} hub-num text-right text-fg-1`}>{fmtK(t.expected_pnl_k, true)}</td>
              {t.scenario_pnl_k.map((k, i) => (
                <td key={i} className={`${td} hub-num text-right`} style={{ color: pnlColor(k) }}>{fmtK(k, true)}</td>
              ))}
            </tr>
          ))}
          <tr>
            <td className={`${td} border-b-0`} />
            <td className={`${td} border-b-0 text-fg-3`}>Theme total</td>
            <td className={`${td} border-b-0`} colSpan={4} />
            <td className={`${td} border-b-0 hub-num text-right text-fg-1`}>{fmtK(theme.max_loss_k)}</td>
            <td className={`${td} border-b-0 hub-num text-right text-fg-1`}>{fmtK(theme.expected_pnl_k, true)}</td>
            {theme.scenarios.map((s) => (
              <td key={s.key} className={`${td} border-b-0 hub-num text-right`} style={{ color: pnlColor(s.pnl_k) }}>
                {fmtK(s.pnl_k, true)}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  )
}

// ─── Theme card ────────────────────────────────────────────────────────────

function ThemeCard({ theme, pnlScale }: { theme: Theme; pnlScale: number }) {
  return (
    <section id={`theme-${theme.id}`} className="hub-frame px-5 pt-4 pb-3 scroll-mt-6">
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 pb-3 mb-3 border-b border-hairline">
        <div className="min-w-0 max-w-[820px]">
          <div className="hub-eyebrow mb-1.5">Theme {theme.id} · {theme.short}</div>
          <h3 className="text-[15px] font-normal text-fg-1 m-0 leading-snug">{theme.name}</h3>
          <p className="mt-1.5 mb-0 text-[12.5px] text-fg-3 leading-relaxed">{theme.headline}</p>
        </div>
        <dl className="flex gap-6 m-0">
          {[
            ['Exp. P&L', fmtK(theme.expected_pnl_k, true)],
            ['Max loss', fmtK(theme.max_loss_k)],
            ['Trades', String(theme.trades.length)],
          ].map(([l, v]) => (
            <div key={l} className="grid gap-0.5 text-right">
              <dd className="hub-num text-[16px] leading-none text-fg-1 m-0">{v}</dd>
              <dt className="hub-eyebrow text-[10px]">{l}</dt>
            </div>
          ))}
        </dl>
      </header>
      <div className="grid xl:grid-cols-[minmax(0,5fr)_minmax(0,8fr)] gap-x-8 gap-y-4">
        <ScenarioRows theme={theme} pnlScale={pnlScale} />
        <TradesTable theme={theme} />
      </div>
    </section>
  )
}

// ─── Book overview ─────────────────────────────────────────────────────────

function Overview({ book }: { book: Book }) {
  return (
    <section className="hub-frame px-5 pt-4 pb-3">
      <div className="hub-eyebrow mb-2">Themes</div>
      <div className="overflow-x-auto -mx-1">
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr>
              <th className={`${th} text-left`}>#</th>
              <th className={`${th} text-left`}>Theme</th>
              <th className={`${th} text-right`}>Trades</th>
              <th className={`${th} text-right`}>Max loss</th>
              <th className={`${th} text-right`}>Exp. P&amp;L</th>
              <th className={`${th} text-left`}>Most likely</th>
              <th className={`${th} text-right`}>Best</th>
              <th className={`${th} text-right`}>Worst</th>
            </tr>
          </thead>
          <tbody>
            {book.themes.map((t) => {
              const likely = t.scenarios.reduce((a, b) => (b.prob > a.prob ? b : a))
              const best = t.scenarios.reduce((a, b) => (b.pnl_k > a.pnl_k ? b : a))
              const worst = t.scenarios.reduce((a, b) => (b.pnl_k < a.pnl_k ? b : a))
              return (
                <tr
                  key={t.id}
                  onClick={() => document.getElementById(`theme-${t.id}`)?.scrollIntoView({ behavior: 'smooth' })}
                  className="cursor-pointer hover:bg-ink-2 transition-colors duration-100"
                >
                  <td className={`${td} hub-num text-fg-3`}>{t.id}</td>
                  <td className={`${td} text-fg-1 whitespace-normal min-w-[240px]`}>{t.name}</td>
                  <td className={`${td} hub-num text-right text-fg-2`}>{t.trades.length}</td>
                  <td className={`${td} hub-num text-right text-fg-2`}>{fmtK(t.max_loss_k)}</td>
                  <td className={`${td} hub-num text-right text-fg-1`}>{fmtK(t.expected_pnl_k, true)}</td>
                  <td className={`${td} text-fg-2`}>
                    {likely.name} <span className="hub-num text-fg-3">{Math.round(likely.prob * 100)}%</span>
                  </td>
                  <td className={`${td} hub-num text-right`} style={{ color: pnlColor(best.pnl_k) }} title={best.name}>
                    {fmtK(best.pnl_k, true)}
                  </td>
                  <td className={`${td} hub-num text-right`} style={{ color: pnlColor(worst.pnl_k) }} title={worst.name}>
                    {fmtK(worst.pnl_k, true)}
                  </td>
                </tr>
              )
            })}
            <tr>
              <td className={`${td} border-b-0`} />
              <td className={`${td} border-b-0 text-fg-3`}>Book</td>
              <td className={`${td} border-b-0 hub-num text-right text-fg-1`}>{book.totals.trades}</td>
              <td className={`${td} border-b-0 hub-num text-right text-fg-1`}>{fmtK(book.totals.max_loss_k)}</td>
              <td className={`${td} border-b-0 hub-num text-right text-fg-1`}>{fmtK(book.totals.expected_pnl_k, true)}</td>
              <td className={`${td} border-b-0`} colSpan={3} />
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  )
}

export default function SummaryView() {
  const [book, setBook] = useState<Book | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    axios
      .get('/api/themes', { headers: authHeaders() })
      .then((r) => (isBook(r.data) ? setBook(r.data) : setError('The themes endpoint returned an unexpected response. Restart the API server.')))
      .catch(() => setError('The trade themes could not load. Check that the API server is running, then refresh.'))
  }, [])

  if (error) {
    return <div className="rounded-md px-4 py-3 text-sm text-neg bg-neg/10 border border-neg/20">{error}</div>
  }
  if (!book) {
    return (
      <div className="flex items-center justify-center py-32">
        <span className="hub-eyebrow animate-pulse">Loading themes</span>
      </div>
    )
  }

  // One P&L scale across themes, so bar lengths compare between cards
  const pnlScale = Math.max(1, ...book.themes.flatMap((t) => t.scenarios.map((s) => Math.abs(s.pnl_k))))

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-[17px] font-normal text-fg-1 m-0">{book.title}</h2>
          <p className="mt-1 mb-0 text-[12px] text-fg-3">
            Levels as of {book.as_of} · {book.horizon} horizon · source <span style={{ fontFamily: fontNum }}>{book.source}</span>
          </p>
        </div>
        <dl className="flex gap-7 m-0">
          {[
            [fmtK(book.totals.expected_pnl_k, true), 'Expected P&L'],
            [fmtK(book.totals.max_loss_k), 'Max loss at stops'],
            [String(book.totals.trades), 'Trades'],
          ].map(([v, l]) => (
            <div key={l} className="grid gap-0.5 text-right">
              <dd className="hub-num text-[20px] leading-none text-fg-1 tracking-[-0.02em] m-0">{v}</dd>
              <dt className="hub-eyebrow text-[10px]">{l}</dt>
            </div>
          ))}
        </dl>
      </div>

      <Overview book={book} />

      <section className="hub-frame px-5 py-4">
        <div className="hub-eyebrow mb-2.5">How the themes interact</div>
        <ul className="m-0 pl-4 grid gap-1.5 text-[12.5px] text-fg-2 leading-relaxed max-w-[1040px]">
          {book.interactions.map((x) => (
            <li key={x.lead}>
              <span className="text-fg-1">{x.lead}</span> {x.text}
            </li>
          ))}
        </ul>
      </section>

      {book.themes.map((t, i) => (
        <div key={t.id} className="hub-enter" style={{ animationDelay: `${i * 30}ms` }}>
          <ThemeCard theme={t} pnlScale={pnlScale} />
        </div>
      ))}

      <ul className="m-0 pl-4 grid gap-1 text-[11.5px] text-fg-4 leading-relaxed">
        {book.notes.map((n) => <li key={n}>{n}</li>)}
      </ul>
    </div>
  )
}
