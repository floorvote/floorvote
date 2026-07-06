import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Overview from '../src/pages/Overview'

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
    const u = String(url)
    if (u.includes('/admin/dash/engagement/overview')) {
      return new Response(JSON.stringify({
        data: {
          tenantCount: 2,
          asOfDate: '2026-05-28',
          totals: {
            total_members: 17,
            active_members_7d: 6,
            active_members_30d: 11,
            votes_cast: 45,
            bills_with_engagement: 20,
            comments_written: 0, comment_reactions: 0, positions_set: 0,
            notes_created: 0, custom_field_values: 0, roles_defined: 0,
            custom_fields_defined: 0, bills_ai_processed: 0,
          },
        },
        meta: {},
      }))
    }
    if (u.includes('overview')) {
      return new Response(JSON.stringify({
        data: {
          tenants: { total: 2 },
          bills: { fullyTracked: 100, lightweight: 50 },
          apiBudget: { used: 1200, limit: 30000, pct: 4.0 },
          lastSync: { syncedAt: '2026-05-28T10:00:00Z', ageSeconds: 60, state: 'RI', billsChecked: 10, billsChanged: 2, billsQueued: 1 },
        }, meta: { generatedAt: 'now' }
      }))
    }
    if (u.includes('activity')) {
      return new Response(JSON.stringify({
        data: { entries: [{ billId: 1, state: 'RI', billNumber: 'H1', changeType: 'status', oldValue: '1', newValue: '2', detail: null, detectedAt: '2026-05-28T11:00:00Z' }] }, meta: { generatedAt: 'now' }
      }))
    }
    return new Response('{}', { status: 200 })
  })
})

describe('Overview page', () => {
  it('renders summary cards and activity entries', async () => {
    render(<MemoryRouter><Overview /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText(/100/)).toBeInTheDocument())
    expect(screen.getByText(/H1/)).toBeInTheDocument()
  })

  it('renders engagement summary cards', async () => {
    render(<MemoryRouter><Overview /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('6')).toBeInTheDocument()) // active_members_7d
    expect(screen.getByText('45')).toBeInTheDocument()                      // votes_cast
    expect(screen.getByText('20')).toBeInTheDocument()                      // bills_with_engagement
  })
})
