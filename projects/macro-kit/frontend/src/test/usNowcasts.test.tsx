/**
 * The US Quant Macro pages: the GDP nowcast with a quarterly target (FOMC SEP and GDPNow panels)
 * and the US labour market nowcast. Fixtures come from backend/scripts/make_us_fixtures.py.
 */
import { cloneElement, type ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import NowcastPage from '../features/quant-macro/NowcastPage'
import LabourPage from '../features/quant-macro/LabourPage'
import { monthLabel, signed } from '../features/quant-macro/ui'
import gdp from './fixtures/quant-macro-us-gdp.json'
import labour from './fixtures/quant-macro-labour-us.json'
import nowcastStatus from './fixtures/quant-macro-uk-gdp-status.json'
import labourStatus from './fixtures/quant-macro-labour-uk-status.json'

vi.mock('recharts', async importOriginal => {
  const mod = await importOriginal<typeof import('recharts')>()
  return {
    ...mod,
    ResponsiveContainer: ({ children }: { children: ReactElement }) =>
      <div>{cloneElement(children, { width: 900, height: 300 } as object)}</div>,
  }
})

function stub(body: unknown, status: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    new Response(JSON.stringify(url.endsWith('/status') ? status : body), { status: 200 })))
}

afterEach(() => vi.unstubAllGlobals())

describe('US GDP nowcast', () => {
  it('shows quarterly nowcasts in % saar with the FOMC SEP and GDPNow', async () => {
    stub(gdp, { ...nowcastStatus, slug: 'us-gdp' })
    render(<NowcastPage slug="us-gdp" />)
    expect(await screen.findByText(/GDP 3Q 2026 \(% q\/q saar\)/)).toBeTruthy()
    expect(screen.getAllByText('% saar').length).toBeGreaterThan(3)
    expect(screen.queryByText(/% m\/m: outturns and model path/)).toBeNull()
    expect(screen.getByText(/GDP growth against the FOMC SEP median, % Q4\/Q4/)).toBeTruthy()
    const y2026 = gdp.policy!.model_years.find(y => y.year === 2026)!
    expect(screen.getByText(y2026.model!.toFixed(1))).toBeTruthy()
    expect(screen.getByText(/Every GDPNow update, read from the Atlanta Fed's own workbook/)).toBeTruthy()
    expect(screen.getAllByText(/Months of data in/).length).toBeGreaterThan(0)
  })

  it('explains the quarterly target', async () => {
    stub(gdp, { ...nowcastStatus, slug: 'us-gdp' })
    render(<NowcastPage slug="us-gdp" />)
    await screen.findByText(/GDP 3Q 2026/)
    fireEvent.click(screen.getByRole('tab', { name: 'Model & data' }))
    expect(screen.getByText(/The target is quarterly GDP/)).toBeTruthy()
    expect(screen.getByText(/New York Fed Staff Nowcast and the Atlanta Fed's GDPNow/)).toBeTruthy()
  })
})

describe('US labour market nowcast', () => {
  it('shows payroll changes in thousands and the FOMC comparison', async () => {
    stub(labour, labourStatus)
    render(<LabourPage country="us" />)
    const nxt = labour.next_prints.lfs_employment
    expect(await screen.findByText(`Nonfarm payrolls, ${monthLabel(nxt.latest_period)}`)).toBeTruthy()
    expect(screen.getByText(`${signed(nxt.latest, 0)}k`)).toBeTruthy()
    expect(screen.getByText(/SEP unemployment, Q4/)).toBeTruthy()
    expect(screen.getByText(/Simulated data: the live pipeline/)).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Federal Reserve' })).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Next prints' }))
    expect(screen.getByText(`${signed(nxt.forecast, 0)}k`)).toBeTruthy()
    expect(screen.getByText(/Unemployment rate: projections against the FOMC SEP/)).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Federal Reserve' }))
    expect(screen.getByText(/The FOMC's labour-market assessment at each meeting/)).toBeTruthy()
    expect(screen.getAllByRole('link').length).toBe(labour.staff.length)
  })
})
