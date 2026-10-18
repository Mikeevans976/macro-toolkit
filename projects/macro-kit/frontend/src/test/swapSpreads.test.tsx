/**
 * The Swap Spreads & Basis page renders the backend payload. Fixtures are the
 * output of GET /api/tools/swap-spreads?target=USD and .../bond?bond_id=UST-2Y
 * (dumped from backend/swap_spreads.py).
 */
import { cloneElement, type ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import SwapSpreads from '../pages/SwapSpreads'
import payload from './fixtures/swap-spreads-usd.json'
import breakdown from './fixtures/swap-spreads-bond-ust2y.json'

// jsdom has no layout, so give the chart a fixed size and let Recharts draw its marks.
vi.mock('recharts', async importOriginal => {
  const mod = await importOriginal<typeof import('recharts')>()
  return {
    ...mod,
    ResponsiveContainer: ({ children }: { children: ReactElement }) =>
      <div>{cloneElement(children, { width: 900, height: 440 } as object)}</div>,
  }
})

function stubApi() {
  const fetchMock = vi.fn(async (url: string) => new Response(
    JSON.stringify(url.includes('/bond?') ? breakdown : payload), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('SwapSpreads', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('renders the bond table and the first bond breakdown', async () => {
    const fetchMock = stubApi()
    render(<SwapSpreads />)
    expect(await screen.findByText(payload.bonds[0].name, { selector: 'td' })).toBeTruthy()
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('/api/tools/swap-spreads?target=USD')
    expect(await screen.findByText('Par asset swap into SOFR + s')).toBeTruthy()
    expect(screen.getByText('Simulated')).toBeTruthy()
    expect(screen.getAllByRole('row').length).toBeGreaterThan(payload.bonds.length)
  })

  it('draws every bond and a labelled line per issuer on the curve tab', async () => {
    stubApi()
    const { container } = render(<SwapSpreads />)
    await screen.findByText(payload.bonds[0].name, { selector: 'td' })
    fireEvent.click(screen.getByRole('tab', { name: 'Global ASW curve' }))

    const issuers = payload.issuer_curves.map(c => c.issuer)
    for (const iss of issuers) {
      // legend entry + end-of-line label (+ table row)
      expect(screen.getAllByText(iss).length).toBeGreaterThanOrEqual(3)
    }
    expect(container.querySelectorAll('.recharts-scatter-symbol').length)
      .toBeGreaterThanOrEqual(payload.bonds.length)
    expect(container.querySelectorAll('.recharts-scatter-line').length).toBe(issuers.length)
  })
})
