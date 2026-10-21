/**
 * The UK debt sustainability page renders the backend payload. Fixtures come from
 * backend/scripts/make_dsa_fixture.py (synthetic inputs, curves 0.8pp higher after the OBR window).
 */
import { cloneElement, type ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import DsaPage from '../features/quant-macro/DsaPage'
import payload from './fixtures/quant-macro-dsa-uk.json'
import status from './fixtures/quant-macro-dsa-uk-status.json'

vi.mock('recharts', async importOriginal => {
  const mod = await importOriginal<typeof import('recharts')>()
  return {
    ...mod,
    ResponsiveContainer: ({ children }: { children: ReactElement }) =>
      <div>{cloneElement(children, { width: 900, height: 300 } as object)}</div>,
  }
})

const running = { ...status, job: { ...status.job, state: 'running', step: 'Pricing the debt', started_at: '2026-10-21T09:01:00' } }

function stubApi(body: unknown = payload) {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    const out = url.endsWith('/status') ? status
      : url.endsWith('/refresh') ? running
      : url.endsWith('/upload') ? { kind: 'dmo', detail: 'DMO gilts in issue: 3 gilts (1 index-linked)', status: running }
      : body
    return new Response(JSON.stringify(out), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const tab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }))
const money = (x: number) => `£${x.toFixed(1)}bn`

afterEach(() => vi.unstubAllGlobals())

describe('DsaPage', () => {
  it('shows headroom at today\'s prices against the OBR', async () => {
    stubApi()
    render(<DsaPage country="uk" />)
    const [stab, inv] = payload.rules
    const tile = (await screen.findByText(`Stability rule headroom, ${payload.target_year}`)).parentElement as HTMLElement
    expect(within(tile).getByText(money(stab.market_bn as number))).toBeTruthy()
    expect(within(tile).getByText(new RegExp(`OBR ${money(stab.obr_bn as number).replace('$', '\\$')}`))).toBeTruthy()
    const tile2 = screen.getByText(`Investment rule headroom, ${payload.target_year}`).parentElement as HTMLElement
    expect(within(tile2).getByText(money(inv.market_bn as number))).toBeTruthy()
    expect(screen.getByText(`${Math.round(100 * (payload.probabilities.both as number))}%`)).toBeTruthy()
    expect(screen.getByRole('img', { name: /Change in headroom since the OBR forecast/ })).toBeTruthy()
    expect(screen.getByText(/at market prices of/)).toBeTruthy()
  })

  it('renders every tab', async () => {
    stubApi()
    render(<DsaPage country="uk" />)
    await screen.findByText(`Stability rule headroom, ${payload.target_year}`)
    tab('Fiscal rules')
    expect(screen.getAllByText('Stability rule').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/From the OBR's headroom to today's/).length).toBe(2)
    tab('Debt dynamics')
    expect(screen.getByText(/Stabilising PB: the primary surplus/)).toBeTruthy()
    expect(screen.getAllByRole('row').length).toBe(payload.dynamics.market.length + 1)
    tab('Debt interest')
    expect(screen.getByText(/ready reckoners/)).toBeTruthy()
    tab('Financing')
    expect(screen.getByText('Gilts in issue')).toBeTruthy()
    expect(screen.getByText(/Upload the DMO gilts-in-issue/)).toBeTruthy()
    tab('Scenarios')
    const rows = screen.getAllByRole('row')
    expect(rows.length).toBe(payload.scenarios.length + 2)
    fireEvent.click(screen.getByRole('radio', { name: payload.scenarios[4].name }))
    expect(screen.getByText(payload.scenarios[4].description)).toBeTruthy()
    tab('Monthly borrowing')
    expect(screen.getByText(payload.tracker.next_release as string)).toBeTruthy()
    tab('Market pricing')
    expect(screen.getByText('10y gilt − OIS')).toBeTruthy()
    tab('Method & data')
    expect(screen.getByText(/Fiscal reaction\./)).toBeTruthy()
    expect(screen.getByText(new RegExp(`Economic and fiscal outlook, ${payload.sources.obr_edition}`))).toBeTruthy()
  })

  it('switches the debt measure', async () => {
    stubApi()
    render(<DsaPage country="uk" />)
    await screen.findByText(/Net debt ex Bank of England, % of GDP/)
    fireEvent.click(screen.getByRole('radio', { name: 'PSNFL' }))
    expect(screen.getByText(/Net financial liabilities \(PSNFL\), % of GDP/)).toBeTruthy()
  })

  it('refreshes and uploads in the background', async () => {
    const fetchMock = stubApi()
    render(<DsaPage country="uk" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh' }))
    await screen.findByText(/Updating: Pricing the debt/)
    expect(fetchMock.mock.calls.some(c => String(c[0]).endsWith('/refresh') && (c[1] as RequestInit)?.method === 'POST')).toBe(true)
  })

  it('posts an uploaded file', async () => {
    const fetchMock = stubApi()
    render(<DsaPage country="uk" />)
    await screen.findByRole('button', { name: 'Refresh' })
    const input = screen.getByLabelText('Upload file') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['a,b'], 'D1A.csv', { type: 'text/csv' })] } })
    await waitFor(() => expect(fetchMock.mock.calls.some(c => String(c[0]).endsWith('/upload'))).toBe(true))
    const call = fetchMock.mock.calls.find(c => String(c[0]).endsWith('/upload'))!
    expect((call[1] as RequestInit).body).toBeInstanceOf(FormData)
  })

  it('reports a failed load', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html></html>', { status: 200 })))
    render(<DsaPage country="uk" />)
    expect(await screen.findByText(/unexpected response/)).toBeTruthy()
  })
})
