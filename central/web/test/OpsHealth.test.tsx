import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import OpsHealth from '../src/pages/OpsHealth'

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
    if (String(url).includes('/ops-health')) {
      return new Response(JSON.stringify({ data: {
        tenants: [
          { tenantId: 'ri', name: 'RI', active: true, lastBillDeliveredAt: '2026-06-05T05:00:00Z', lastStatsPullAt: '2026-06-05T06:00:00Z', lastSeenAt: '2026-06-05T05:30:00Z', stale: false },
          { tenantId: 'stale', name: 'Stale', active: true, lastBillDeliveredAt: null, lastStatsPullAt: null, lastSeenAt: null, stale: true },
        ],
        states: [
          { state: 'RI', lastSyncedAt: '2026-06-05T05:00:00Z', stale: false },
          { state: 'NJ', lastSyncedAt: '2026-05-28T05:00:00Z', stale: true },
        ],
        thresholds: { billDelivery: 96, statsPull: 36, lastSeen: 48, stateSync: 48 },
      }, meta: {} }))
    }
    return new Response('{}')
  })
})

describe('OpsHealth page', () => {
  it('renders tenant and state rows and flags stale ones', async () => {
    render(<MemoryRouter><OpsHealth /></MemoryRouter>)
    await waitFor(() => expect(screen.getAllByText('RI').length).toBeGreaterThanOrEqual(1))
    expect(screen.getByText('Stale')).toBeInTheDocument()
    expect(screen.getByText('NJ')).toBeInTheDocument()
    const staleRow = screen.getByText('Stale').closest('tr')
    expect(staleRow).toHaveClass('row-stale')
    const njRow = screen.getByText('NJ').closest('tr')
    expect(njRow).toHaveClass('row-stale')
  })
})
