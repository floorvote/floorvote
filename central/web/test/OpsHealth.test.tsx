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
          // Healthy: a large stalled-AI count, but the oldest one is recent —
          // the sweep working through a fresh outage, not a problem.
          { tenantId: 'ri', name: 'RI', active: true, lastBillDeliveredAt: '2026-06-05T05:00:00Z', lastStatsPullAt: '2026-06-05T06:00:00Z', lastSeenAt: '2026-06-05T05:30:00Z', stale: false, problems: [], expectsBills: true, aiContextPersonalized: true, stalledAi: 24, stalledAiOldestHours: 2 },
          { tenantId: 'stale', name: 'Stale', active: true, lastBillDeliveredAt: null, lastStatsPullAt: null, lastSeenAt: null, stale: true, problems: ['No bills delivered in 8 days', 'Not seen in 8 days'], expectsBills: true, aiContextPersonalized: false, stalledAi: 0, stalledAiOldestHours: 0 },
          // Otherwise fresh, but the sweep has been stuck for days.
          { tenantId: 'stuck', name: 'Stuck', active: true, lastBillDeliveredAt: '2026-06-05T05:00:00Z', lastStatsPullAt: '2026-06-05T06:00:00Z', lastSeenAt: '2026-06-05T05:30:00Z', stale: true, problems: ['3 bills stuck on AI analysis, oldest 2 days'], expectsBills: true, aiContextPersonalized: false, stalledAi: 3, stalledAiOldestHours: 50 },
          // Out of session: adjourned sine die, so the old bill timestamp is
          // expected, not a problem — the muted note is what makes that clear.
          { tenantId: 'adjourned', name: 'Adjourned', active: true, lastBillDeliveredAt: '2026-05-01T05:00:00Z', lastStatsPullAt: '2026-06-05T06:00:00Z', lastSeenAt: '2026-06-05T05:30:00Z', stale: false, problems: [], expectsBills: false, aiContextPersonalized: true, stalledAi: 5, stalledAiOldestHours: 1 },
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

  it('shows whether each tenant has personalized its AI instructions', async () => {
    render(<MemoryRouter><OpsHealth /></MemoryRouter>)
    await waitFor(() => expect(screen.getAllByText('RI').length).toBeGreaterThanOrEqual(1))
    expect(screen.getAllByText('personalized').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('generic default').length).toBeGreaterThanOrEqual(1)
  })

  it('renders OK for a healthy tenant with no problems', async () => {
    render(<MemoryRouter><OpsHealth /></MemoryRouter>)
    await waitFor(() => expect(screen.getAllByText('RI').length).toBeGreaterThanOrEqual(1))
    // The tenant table renders before the state table, so the first "RI" match
    // is the tenant row, not the per-state sync row that shares the name.
    const riRow = screen.getAllByText('RI')[0].closest('tr') as HTMLElement
    expect(riRow).not.toHaveClass('row-stale')
    expect(riRow.textContent).toContain('OK')
  })

  it('renders the stuck-bill sentence in warning color for a tenant whose sweep is actually broken', async () => {
    render(<MemoryRouter><OpsHealth /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('Stuck')).toBeInTheDocument())
    expect(screen.getByText('3 bills stuck on AI analysis, oldest 2 days')).toBeInTheDocument()
    const stuckRow = screen.getByText('Stuck').closest('tr')
    expect(stuckRow).toHaveClass('row-stale')
  })

  it('notes "(out of session)" next to the bill-delivery time only when the tenant cannot expect bills', async () => {
    render(<MemoryRouter><OpsHealth /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('Adjourned')).toBeInTheDocument())
    const adjournedRow = screen.getByText('Adjourned').closest('tr') as HTMLElement
    expect(adjournedRow.textContent).toContain('(out of session)')
    const riRow = screen.getAllByText('RI')[0].closest('tr') as HTMLElement
    expect(riRow.textContent).not.toContain('(out of session)')
  })

  // The count rides on the non-stale tenant on purpose: a large count whose
  // oldest bill is recent must be reported plainly, not flagged as a problem.
  it('shows the stalled-AI count with its oldest age, but does not flag it as a problem when the oldest is recent', async () => {
    render(<MemoryRouter><OpsHealth /></MemoryRouter>)
    await waitFor(() => expect(screen.getAllByText('RI').length).toBeGreaterThanOrEqual(1))
    expect(screen.getByText('24 (oldest 2h)')).toBeInTheDocument()
    expect(screen.getByText('0')).toBeInTheDocument()
    const riRow = screen.getAllByText('RI')[0].closest('tr') as HTMLElement
    const stalledCell = screen.getByText('24 (oldest 2h)')
    expect(riRow.contains(stalledCell)).toBe(true)
  })
})
