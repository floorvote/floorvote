/**
 * GroupedBillCard navigation
 *
 * A plain left-click on the card navigates to the bill route (the route loader
 * then fetches the bill); a ⌘/Shift-click opens a new tab (window.open) without
 * navigating away.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import type { Location } from 'react-router-dom'
import { ConfigContext, type AppConfig } from '../context/ConfigContext'
import { GroupedBillCard } from './GroupedBillCard'
import type { GroupedBillEvents } from '../lib/feedUtils'

// apiFetch should NOT be called on navigation any more — the route loader owns
// the fetch. Mock it so any accidental call is observable (and fails the assert).
const apiFetchMock = vi.fn()
vi.mock('../lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }))

function makeGroup(): GroupedBillEvents {
  return {
    key: 'bill-1::2026-01-01',
    billId: 'bill-1',
    billNumber: 'HB 1',
    billState: 'RI',
    billSessionSlug: '2026rs',
    billTitle: 'Test Bill',
    billSummary: null,
    billPriority: null,
    billMatchType: 'keyword',
    date: '2026-01-01',
    events: [],
  }
}

/** Spy helper: captures the router location after navigation */
function LocationCapture({ onLocation }: { onLocation: (loc: Location) => void }) {
  const loc = useLocation()
  onLocation(loc)
  return null
}

function wrap(ui: React.ReactNode, onLocation: (loc: Location) => void) {
  const value = { config: { states: ['RI'] } as AppConfig, multiState: false, loading: false }
  return render(
    <MemoryRouter initialEntries={['/feed']}>
      <ConfigContext.Provider value={value}>
        {ui}
        <LocationCapture onLocation={onLocation} />
      </ConfigContext.Provider>
    </MemoryRouter>
  )
}

describe('GroupedBillCard navigation', () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
    vi.spyOn(window, 'open').mockImplementation(() => null)
  })
  // window.open is a persistent spy across tests; clear its call history so one
  // test's calls can't satisfy another's toHaveBeenCalledWith assertion.
  afterEach(() => {
    vi.mocked(window.open).mockClear()
  })

  it('plain left-click navigates to the bill route without prefetching', async () => {
    const locations: Location[] = []
    wrap(<GroupedBillCard group={makeGroup()} />, loc => { locations.push(loc) })

    // The card header is a clickable div — find the outer card container
    const card = screen.getByText('HB 1').closest('[style]')!.closest('[style]')!
    fireEvent.click(card)

    await waitFor(() => {
      const last = locations[locations.length - 1]
      expect(last?.pathname).not.toBe('/feed')
    })

    const last = locations[locations.length - 1]
    expect(last?.pathname).toContain('/RI/')
    // The loader fetches the bill, not the component — no prefetch on click.
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('⌘-click opens a new tab and does NOT navigate away', async () => {
    const locations: Location[] = []
    wrap(<GroupedBillCard group={makeGroup()} />, loc => { locations.push(loc) })

    const card = screen.getByText('HB 1').closest('[style]')!.closest('[style]')!
    fireEvent.click(card, { metaKey: true })

    // window.open should be called for modifier-click
    expect(window.open).toHaveBeenCalledWith(expect.stringContaining('/RI/'), '_blank')
    // Location should NOT have changed
    const last = locations[locations.length - 1]
    expect(last?.pathname).toBe('/feed')
  })

  it('Shift-click opens a new tab and does NOT navigate away', async () => {
    const locations: Location[] = []
    wrap(<GroupedBillCard group={makeGroup()} />, loc => { locations.push(loc) })

    const card = screen.getByText('HB 1').closest('[style]')!.closest('[style]')!
    fireEvent.click(card, { shiftKey: true })

    expect(window.open).toHaveBeenCalledWith(expect.stringContaining('/RI/'), '_blank')
    const last = locations[locations.length - 1]
    expect(last?.pathname).toBe('/feed')
  })
})
