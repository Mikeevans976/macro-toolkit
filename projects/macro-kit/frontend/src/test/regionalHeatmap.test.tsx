/**
 * The regional heatmap page renders the backend payload (fixture generated from
 * GET /api/tools/heatmap/uk by backend/scripts/make_heatmap_fixture.py, trimmed;
 * backend/tests/test_heatmap_fixture.py
 * keeps its shape in sync with the API).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import RegionalHeatmapPage from '../features/heatmap/RegionalHeatmapPage'
import fixture from './fixtures/heatmap-uk.json'
import chinaFixture from './fixtures/heatmap-china.json'
import { HEATMAP_REGIONS, type HeatmapRegion } from '../features/heatmap/regions'
import ToolIcon from '../components/ToolIcon'

function renderPage(region: HeatmapRegion = 'uk') {
  return render(<MemoryRouter><RegionalHeatmapPage region={region} /></MemoryRouter>)
}

describe('RegionalHeatmapPage', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('fetches its region and renders every section', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    renderPage()
    expect(await screen.findByText('Macro Factors — DFM Synthesis')).toBeTruthy()
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('/api/tools/heatmap/uk')
    for (const title of [
      'Gilt Yield Curve — Principal Components', 'Rates–Macro Linkage — PC Regressions',
      '10y Gilt — Macro Fair Value', 'Gilt Curve Directionality', '10y Breakeven Dynamics',
      'Scenario Probabilities', 'Macro Fundamentals — Z-Score Heatmap',
    ]) expect(screen.getByText(title)).toBeTruthy()
    // Indicator rows and curve fair-value rows come straight from the payload
    const firstIndicator = fixture.indicators.groups[0].indicators[0].name
    expect(screen.getByText(firstIndicator)).toBeTruthy()
    expect(screen.getByText('2s10s')).toBeTruthy()
    expect(screen.getAllByText('Simulated data', { exact: false }).length).toBeGreaterThan(0)
  })

  it('renders an EM region without a breakeven market and with its own factor set', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(chinaFixture), { status: 200 })))
    renderPage('china')
    expect(await screen.findByText('Macro Factors — DFM Synthesis')).toBeTruthy()
    expect(screen.getByText('EM Macro Fundamentals')).toBeTruthy()
    expect(screen.getByTitle('China')).toBeTruthy()               // SVG flag in the page title
    expect(screen.getAllByText('Credit').length).toBeGreaterThan(0)
    expect(screen.getByText('10y CGB — Macro Fair Value')).toBeTruthy()
    expect(screen.queryByText('10y Breakeven Dynamics')).toBeNull()
    expect(screen.getByText('curve signal only', { exact: false })).toBeTruthy()
  })

  it('shows every region as an SVG flag, never an emoji', () => {
    for (const r of HEATMAP_REGIONS) {
      const { container, unmount } = render(<ToolIcon toolId={`${r.slug}-heatmap`} />)
      const svg = container.querySelector('svg')
      expect(svg, r.slug).toBeTruthy()
      expect(svg!.querySelector('title')?.textContent).toBe(r.country)
      expect(container.textContent).not.toMatch(/[\u{1F1E6}-\u{1F1FF}]/u)   // regional-indicator letters
      unmount()
    }
  })

  it('shows an error instead of a blank page when the API fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))
    renderPage()
    expect((await screen.findByRole('alert')).textContent).toContain('HTTP 503')
  })
})
