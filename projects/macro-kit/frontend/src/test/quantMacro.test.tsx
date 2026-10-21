/**
 * The Quant Macro nowcast page renders the backend payload. Fixtures come from
 * backend/scripts/make_nowcast_fixture.py (simulated UK GDP model, as of 2026-10-19).
 */
import { cloneElement, type ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import NowcastPage from '../features/quant-macro/NowcastPage'
import { dayLabel, monthLabel, quarterLabel, signed } from '../features/quant-macro/ui'
import payload from './fixtures/quant-macro-uk-gdp.json'
import backtest from './fixtures/quant-macro-uk-gdp-backtest.json'
import status from './fixtures/quant-macro-uk-gdp-status.json'

vi.mock('recharts', async importOriginal => {
  const mod = await importOriginal<typeof import('recharts')>()
  return {
    ...mod,
    ResponsiveContainer: ({ children }: { children: ReactElement }) =>
      <div>{cloneElement(children, { width: 900, height: 300 } as object)}</div>,
  }
})

const runningJob = (kind: string) => ({
  ...status, jobs: { ...status.jobs, [kind]: { kind, state: 'running', step: 'Re-estimating on data public on 01 Jan 2024', progress: 3, total: 12, started_at: '2026-10-19T12:00:00', finished_at: null, error: null } },
})

function stubApi(body: unknown = payload, saved: unknown = backtest) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const post = init?.method === 'POST'
    const out = url.endsWith('/status') ? status
      : url.endsWith('/refit') ? runningJob('refit')
      : url.endsWith('/backtest') ? (post ? runningJob('backtest') : saved)
      : body
    return new Response(JSON.stringify(out), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const calls = (m: ReturnType<typeof stubApi>) => m.mock.calls.map(c => [String(c[0]), (c[1] as RequestInit | undefined)?.method ?? 'GET'])

describe('NowcastPage', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('shows the next print and a card per unreleased quarter', async () => {
    const fetchMock = stubApi()
    render(<NowcastPage slug="uk-gdp" />)
    expect(await screen.findByText('Next print')).toBeTruthy()
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('/api/tools/quant-macro/uk-gdp')
    expect(screen.getByText('Simulated')).toBeTruthy()
    const open = payload.quarters.filter(q => q.status !== 'released')
    for (const q of open) expect(screen.getAllByText(quarterLabel(q.quarter)).length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText(payload.next_print.label)).toBeTruthy()
    expect(screen.getAllByText(signed(payload.next_print.model)).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/Tracking the Bank of England/)).toBeTruthy()
  })

  it('lists upcoming releases in date order and past releases with their impact', async () => {
    stubApi()
    render(<NowcastPage slug="uk-gdp" />)
    await screen.findByText('Next print')
    fireEvent.click(screen.getByRole('tab', { name: 'News & catalysts' }))
    const table = (await screen.findByText(/Upcoming releases/)).parentElement!
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.length).toBe(payload.indicators.filter(i => i.next_release).length)
    const dates = [...payload.indicators].map(i => i.next_release!).sort()
    expect(within(rows[0]).getByText(dayLabel(dates[0]))).toBeTruthy()
    const nReleases = payload.evolution.slice(1).reduce((n, s) => n + s.releases.length, 0)
    const past = (await screen.findByText(/Releases and revisions since/)).parentElement!
    expect(within(past).getAllByRole('row').length).toBe(nReleases + 1)
    // the quarter picker switches the impacts
    const other = payload.quarters.filter(q => q.status !== 'released').map(q => q.quarter)[1]
    fireEvent.click(screen.getByRole('radio', { name: quarterLabel(other) }))
    expect(screen.getByText(new RegExp(`${quarterLabel(other)} nowcast through the data flow`))).toBeTruthy()
  })

  it('shows the saved backtest and runs a new one only on request', async () => {
    const fetchMock = stubApi()
    render(<NowcastPage slug="uk-gdp" />)
    await screen.findByText('Next print')
    expect(calls(fetchMock).some(([u]) => u.endsWith('/backtest'))).toBe(false)
    fireEvent.click(screen.getByRole('tab', { name: 'Track record' }))
    expect(await screen.findByText('Error statistics')).toBeTruthy()
    expect(screen.getAllByText(quarterLabel(backtest.rows[0].quarter)).length).toBe(1)
    expect(calls(fetchMock).some(([u, m]) => u.endsWith('/backtest') && m === 'POST')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Run full backtest' }))
    expect(await screen.findByRole('button', { name: 'Running…' })).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25')
    expect(calls(fetchMock)).toContainEqual(['/api/tools/quant-macro/uk-gdp/backtest', 'POST'])
  })

  it('offers to run the backtest when none is saved', async () => {
    stubApi(payload, null)
    render(<NowcastPage slug="uk-gdp" />)
    await screen.findByText('Next print')
    fireEvent.click(screen.getByRole('tab', { name: 'Track record' }))
    expect(await screen.findByText(/No backtest has been run yet/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Run full backtest' })).toBeTruthy()
    expect(screen.queryByText('Error statistics')).toBeNull()
  })

  it('refits only when asked', async () => {
    const fetchMock = stubApi()
    render(<NowcastPage slug="uk-gdp" />)
    await screen.findByText('Next print')
    expect(await screen.findByText(/Model fitted/)).toBeTruthy()
    expect(calls(fetchMock).some(([u]) => u.endsWith('/refit'))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Refit' }))
    expect(await screen.findByRole('button', { name: 'Refitting…' })).toBeTruthy()
    expect(calls(fetchMock)).toContainEqual(['/api/tools/quant-macro/uk-gdp/refit', 'POST'])
  })

  it('shows the model description and the indicator panel', async () => {
    stubApi()
    render(<NowcastPage slug="uk-gdp" />)
    await screen.findByText('Next print')
    fireEvent.click(screen.getByRole('tab', { name: 'Model & data' }))
    expect(screen.getByText(/How the nowcast is built/)).toBeTruthy()
    for (const i of payload.indicators) expect(screen.getAllByText(i.ticker).length).toBe(1)
    expect(screen.getAllByText(monthLabel(payload.indicators[0].last_period!)).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/where each indicator's first prints and revisions come from/)).toBeTruthy()
    expect(screen.getByText(payload.indicators[0].vintages)).toBeTruthy()
  })

  it('reports a stale backend instead of crashing', async () => {
    stubApi('<!doctype html><html></html>')
    render(<NowcastPage slug="uk-gdp" />)
    expect(await screen.findByText(/restart the backend/)).toBeTruthy()
  })
})
