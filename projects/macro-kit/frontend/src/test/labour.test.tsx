/**
 * The UK Labour Market Nowcast page renders the backend payload. Fixtures come from
 * backend/scripts/make_labour_fixture.py (synthetic inputs, a DMP reading moved between two runs).
 */
import { cloneElement, type ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import LabourPage from '../features/quant-macro/LabourPage'
import { monthLabel, signed } from '../features/quant-macro/ui'
import payload from './fixtures/quant-macro-labour-uk.json'
import status from './fixtures/quant-macro-labour-uk-status.json'

vi.mock('recharts', async importOriginal => {
  const mod = await importOriginal<typeof import('recharts')>()
  return {
    ...mod,
    ResponsiveContainer: ({ children }: { children: ReactElement }) =>
      <div>{cloneElement(children, { width: 900, height: 300 } as object)}</div>,
  }
})

const running = (kind: 'update' | 'refit') => ({
  ...status, jobs: { ...status.jobs, [kind]: { kind, state: 'running', step: 'Kalman smoother', started_at: '2026-10-22T09:01:00', finished_at: null, error: null } },
})

function stubApi() {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    const out = url.endsWith('/status') ? status : url.endsWith('/refresh') ? running('update') : url.endsWith('/refit') ? running('refit') : payload
    return new Response(JSON.stringify(out), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const tab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }))
const pp = (x: number) => `${signed(x, 2)}%`

afterEach(() => vi.unstubAllGlobals())

describe('LabourPage', () => {
  it('shows underlying employment growth and the Bank staff judgement', async () => {
    stubApi()
    render(<LabourPage country="uk" />)
    const l = payload.latest
    const tile = (await screen.findByText(`Underlying employment growth, ${monthLabel(l.month)}`)).parentElement as HTMLElement
    expect(within(tile).getByText(pp(l.underlying as number))).toBeTruthy()
    const boe = screen.getByText(`Bank staff, ${l.boe_report} MPR`).parentElement as HTMLElement
    expect(within(boe).getByText(new RegExp('broadly flat'))).toBeTruthy()
    expect(screen.getByText(/Bank of England staff method · 6 indicators/)).toBeTruthy()
    expect(screen.getByText(/5 of the Bank's survey series are Bloomberg-only/)).toBeTruthy()
  })

  it('attributes the news to the indicator that moved', async () => {
    stubApi()
    render(<LabourPage country="uk" />)
    await screen.findByText(/Underlying employment growth,/)
    tab('Contributions & news')
    const n = payload.news!
    expect(screen.getByText(new RegExp(`The estimate for ${monthLabel(n.month)} moved from`))).toBeTruthy()
    const moved = Object.entries(n.by_indicator).filter(([, v]) => Math.abs(v ?? 0) >= 0.0005)
    expect(moved.map(([k]) => k)).toEqual(['dmp_expected'])
    expect(screen.getAllByText('DMP expected employment growth').length).toBeGreaterThan(1)
  })

  it('renders the next prints, the Bank of England tab and the model tab', async () => {
    stubApi()
    render(<LabourPage country="uk" />)
    await screen.findByText(/Underlying employment growth,/)
    tab('Next prints')
    expect(screen.getByText(`LFS employment, 3 months to ${monthLabel(payload.next_prints.lfs_employment.period)}`)).toBeTruthy()
    expect(screen.getByText(/projections against the Bank's/)).toBeTruthy()
    expect(screen.getAllByText('July 2026').length).toBe(2)
    tab('Bank of England')
    expect(screen.getAllByRole('link').length).toBe(payload.staff.length)
    expect(screen.getByText(/Labour demand and supply behind employment growth/)).toBeTruthy()
    expect(screen.getByText(/Employment growth implied by GDP momentum/)).toBeTruthy()
    tab('Indicators & model')
    expect(screen.getAllByText('Bloomberg series (data source is not Bloomberg)').length).toBe(5)
    expect(screen.getByText(/Loadings on the common factor/)).toBeTruthy()
  })

  it('starts a refresh and a refit in the background', async () => {
    const fetchMock = stubApi()
    render(<LabourPage country="uk" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Refit' }))
    await screen.findByText(/Refitting: Kalman smoother/)
    expect(fetchMock.mock.calls.some(c => String(c[0]).endsWith('/refit') && (c[1] as RequestInit)?.method === 'POST')).toBe(true)
  })

  it('switches the range of the main chart', async () => {
    stubApi()
    render(<LabourPage country="uk" />)
    await screen.findByText(/Underlying employment growth,/)
    fireEvent.click(screen.getByRole('radio', { name: 'Since 2022' }))
    expect(screen.getByRole('radio', { name: 'Since 2022' }).getAttribute('aria-checked')).toBe('true')
  })
})
