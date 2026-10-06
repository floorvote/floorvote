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
          tenants: {
            total: 4,
            list: [
              { id: 'alpha', name: 'Alpha Team', url: 'https://alpha.example.org', active: true },
              { id: 'beta', name: 'Beta Team', url: null, active: true },
              { id: 'gamma', name: 'Gamma Team', url: 'javascript:alert(1)', active: true },
              { id: 'delta', name: 'Delta Team', url: 'https://delta.example.org', active: false },
            ],
          },
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

  it('lists tenants with team name and a link to their home page', async () => {
    render(<MemoryRouter><Overview /></MemoryRouter>)
    const link = await screen.findByRole('link', { name: 'https://alpha.example.org' })
    expect(link).toHaveAttribute('href', 'https://alpha.example.org')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.getByText('Alpha Team')).toBeInTheDocument()
  })

  it('links the team name to the home page too', async () => {
    render(<MemoryRouter><Overview /></MemoryRouter>)
    const nameLink = await screen.findByRole('link', { name: 'Alpha Team' })
    expect(nameLink).toHaveAttribute('href', 'https://alpha.example.org')
  })

  it('shows a dash and no link when a tenant has not reported a URL', async () => {
    render(<MemoryRouter><Overview /></MemoryRouter>)
    await screen.findByText('Beta Team')
    expect(screen.queryByRole('link', { name: 'Beta Team' })).not.toBeInTheDocument()
    const row = screen.getByText('Beta Team').closest('tr')!
    expect(row).toHaveTextContent('—')
  })

  it('does not render non-http URLs as links', async () => {
    render(<MemoryRouter><Overview /></MemoryRouter>)
    await screen.findByText('Gamma Team')
    expect(screen.queryByRole('link', { name: 'Gamma Team' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /javascript:/ })).not.toBeInTheDocument()
  })

  it('marks inactive tenants', async () => {
    render(<MemoryRouter><Overview /></MemoryRouter>)
    await screen.findByText('Delta Team')
    const row = screen.getByText('Delta Team').closest('tr')!
    expect(row).toHaveTextContent(/inactive/i)
    const active = screen.getByText('Alpha Team').closest('tr')!
    expect(active).not.toHaveTextContent(/inactive/i)
  })
})
