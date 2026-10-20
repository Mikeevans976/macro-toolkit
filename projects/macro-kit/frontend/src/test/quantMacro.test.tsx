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

vi.mock('recharts', async importOriginal => {
  const mod = await importOriginal<typeof import('recharts')>()
  return {
    ...mod,
    ResponsiveContainer: ({ children }: { children: ReactElement }) =>
      <div>{cloneElement(children, { width: 900, height: 300 } as object)}</div>,
  }
})

function stubApi(body: unknown = payload) {
  const fetchMock = vi.fn(async (url: string) =>
    new Response(JSON.stringify(url.endsWith('/backtest') ? backtest : body), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

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
    const past = (await screen.findByText(/Releases since/)).parentElement!
    expect(within(past).getAllByRole('row').length).toBe(nReleases + 1)
    // the quarter picker switches the impacts
    const other = payload.quarters.filter(q => q.status !== 'released').map(q => q.quarter)[1]
    fireEvent.click(screen.getByRole('radio', { name: quarterLabel(other) }))
    expect(screen.getByText(new RegExp(`${quarterLabel(other)} nowcast through the data flow`))).toBeTruthy()
  })

  it('loads the backtest on demand', async () => {
    const fetchMock = stubApi()
    render(<NowcastPage slug="uk-gdp" />)
    await screen.findByText('Next print')
    fireEvent.click(screen.getByRole('tab', { name: 'Track record' }))
    expect(await screen.findByText('Error statistics')).toBeTruthy()
    expect(fetchMock.mock.calls.some(c => String(c[0]).endsWith('/uk-gdp/backtest'))).toBe(true)
    expect(screen.getAllByText(quarterLabel(backtest.rows[0].quarter)).length).toBe(1)
  })

  it('shows the model description and the indicator panel', async () => {
    stubApi()
    render(<NowcastPage slug="uk-gdp" />)
    await screen.findByText('Next print')
    fireEvent.click(screen.getByRole('tab', { name: 'Model & data' }))
    expect(screen.getByText(/How the nowcast is built/)).toBeTruthy()
    for (const i of payload.indicators) expect(screen.getAllByText(i.ticker).length).toBe(1)
    expect(screen.getAllByText(monthLabel(payload.indicators[0].last_period!)).length).toBeGreaterThanOrEqual(1)
  })

  it('reports a stale backend instead of crashing', async () => {
    stubApi('<!doctype html><html></html>')
    render(<NowcastPage slug="uk-gdp" />)
    expect(await screen.findByText(/restart the backend/)).toBeTruthy()
  })
})
