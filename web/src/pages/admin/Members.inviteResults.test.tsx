import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { Members } from './Members'
import * as api from '../../lib/api'

const OWNER = {
  id: 'owner-1', email: 'owner@example.com', name: 'Sole Owner', role: 'owner' as const, subtitle: null,
  createdAt: '2024-01-01T00:00:00Z', lastActive: '2024-01-01T00:00:00Z', deactivatedAt: null, roles: [],
  canVote: true, voteCount: 0, loginTrouble: false, emailBounce: null, hasLoggedIn: true, invitedBy: null,
}

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'owner-1', email: 'owner@example.com', name: 'Sole Owner', role: 'owner' },
    loading: false,
  }),
}))

type Summary = { invited: number; exists: number; duplicate: number; invalid: number; bounced?: number }

function mockApi(inviteResponse: { summary: Summary; results: { email: string; status: string; userId?: string }[] }) {
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/admin/members') return [OWNER] as never
    if (path === '/admin/roles') return [] as never
    if (path === '/admin/members/bulk-invite') return inviteResponse as never
    return {} as never
  })
}

async function invite(text: string) {
  render(<MemoryRouter><Members /></MemoryRouter>)
  await screen.findByText('Sole Owner')
  await userEvent.type(screen.getByLabelText('Invitees'), text)
  await userEvent.click(screen.getByRole('button', { name: 'Send invites' }))
}

describe('Members invite results', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('counts previously bounced addresses in the summary, next to the other counts', async () => {
    mockApi({
      summary: { invited: 1, exists: 1, duplicate: 1, invalid: 1, bounced: 2 },
      results: [
        { email: 'new@example.com', status: 'invited', userId: 'u-1' },
        { email: 'active@example.com', status: 'exists' },
        { email: 'new@example.com', status: 'duplicate' },
        { email: 'not-an-email', status: 'invalid' },
        { email: 'typo@example.com', status: 'bounced' },
        { email: 'listed@example.com', status: 'bounced' },
      ],
    })
    await invite('new@example.com')
    // The other counts' wording is pinned elsewhere; this pins where the new one sits.
    expect(await screen.findByText(/^1 invited · .* · 1 invalid · 2 previously bounced$/)).toBeInTheDocument()
  })

  it('labels each bounced row as previously bounced and not invited', async () => {
    mockApi({
      summary: { invited: 0, exists: 0, duplicate: 0, invalid: 0, bounced: 1 },
      results: [{ email: 'typo@example.com', status: 'bounced' }],
    })
    await invite('typo@example.com')
    expect(await screen.findByText('typo@example.com — previously bounced, not invited')).toBeInTheDocument()
    expect(screen.getByText('0 invited · 1 previously bounced')).toBeInTheDocument()
  })

  it('leaves the summary unchanged when nothing bounced, or the server sends no bounced count', async () => {
    mockApi({
      summary: { invited: 2, exists: 0, duplicate: 0, invalid: 0 },
      results: [
        { email: 'a@example.com', status: 'invited', userId: 'u-1' },
        { email: 'b@example.com', status: 'invited', userId: 'u-2' },
      ],
    })
    await invite('a@example.com, b@example.com')
    expect(await screen.findByText('2 invited')).toBeInTheDocument()
    expect(screen.queryByText(/bounced/)).not.toBeInTheDocument()
  })

  it('keeps the other rows labeled by status', async () => {
    mockApi({
      summary: { invited: 0, exists: 1, duplicate: 0, invalid: 0, bounced: 0 },
      results: [{ email: 'active@example.com', status: 'exists' }],
    })
    await invite('active@example.com')
    expect(await screen.findByText('active@example.com — exists')).toBeInTheDocument()
    expect(screen.queryByText(/bounced/)).not.toBeInTheDocument()
  })
})
