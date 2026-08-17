import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import TenantDetail from '../src/pages/TenantDetail'

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
    const u = String(url)
    if (u.includes('/admin/dash/engagement/tenants/ri')) {
      return new Response(JSON.stringify({
        data: {
          tenant: { id: 'ri', name: 'Rhode Island' },
          dates: ['2026-05-28'],
          metrics: {
            total_members: [12],
            active_members_7d: [4],
            active_members_30d: [8],
            votes_cast: [30],
            comments_written: [10],
            comment_reactions: [5],
            positions_set: [3],
            notes_created: [2],
            custom_field_values: [40],
            bills_with_engagement: [8],
            roles_defined: [2],
            custom_fields_defined: [2],
            bills_ai_processed: [60],
          },
          probe: { latencyMs: 1234, ok: true, statDate: '2026-05-28' },
        },
        meta: {},
      }))
    }
    if (u.includes('/admin/dash/tenants/ri')) {
      return new Response(JSON.stringify({
        data: {
          tenant: { id: 'ri', name: 'RI', states: ['RI'], aiContextPersonalized: false },
          matchTypeBreakdown: { keyword: 5, manual: 2, null: 1 },
          textStatusBreakdown: { not_checked: 1, no_texts: 0, available: 7 },
          keywordEffectiveness: [{ keyword: 'election', billCount: 3, pct: 37.5 }],
          crossTenantBills: [{ billId: 1, state: 'RI', billNumber: 'H1', alsoTrackedBy: ['acme'] }],
        }, meta: {},
      }))
    }
    return new Response('{}')
  })
})

describe('TenantDetail page', () => {
  it('renders tenant name and breakdowns', async () => {
    render(
      <MemoryRouter initialEntries={['/tenants/ri']}>
        <Routes><Route path="/tenants/:id" element={<TenantDetail />} /></Routes>
      </MemoryRouter>
    )
    await waitFor(() => expect(screen.getAllByText(/RI/).length).toBeGreaterThan(0))
    expect(screen.getByText(/election/)).toBeInTheDocument()
  })

  it('renders engagement section with Refresh button', async () => {
    render(
      <MemoryRouter initialEntries={['/tenants/ri']}>
        <Routes><Route path="/tenants/:id" element={<TenantDetail />} /></Routes>
      </MemoryRouter>
    )
    await waitFor(() => expect(screen.getByText('Engagement')).toBeInTheDocument())
    expect(screen.getByText('Refresh now')).toBeInTheDocument()
  })

  it('renders the DB-health probe readout', async () => {
    render(
      <MemoryRouter initialEntries={['/tenants/ri']}>
        <Routes><Route path="/tenants/:id" element={<TenantDetail />} /></Routes>
      </MemoryRouter>
    )
    await waitFor(() => expect(screen.getByText(/DB health/)).toBeInTheDocument())
    expect(screen.getByText('ok')).toBeInTheDocument()
    expect(screen.getByText(/1234ms/)).toBeInTheDocument()
  })

  it('flags generic default AI instructions as advisory', async () => {
    render(
      <MemoryRouter initialEntries={['/tenants/ri']}>
        <Routes><Route path="/tenants/:id" element={<TenantDetail />} /></Routes>
      </MemoryRouter>
    )
    await waitFor(() => expect(screen.getByText(/AI instructions/)).toBeInTheDocument())
    expect(screen.getByText(/AI instructions: generic default/)).toBeInTheDocument()
  })
})
