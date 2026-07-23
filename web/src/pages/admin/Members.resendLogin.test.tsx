import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Members } from './Members'
import * as api from '../../lib/api'

const OWNER = {
  id: 'owner-1',
  email: 'owner@example.com',
  name: 'Sole Owner',
  role: 'owner' as const,
  subtitle: null,
  createdAt: '2024-01-01T00:00:00Z',
  lastActive: '2024-01-01T00:00:00Z',
  deactivatedAt: null,
  hasLoggedIn: true,
  invitedBy: null,
  roles: [],
  canVote: true,
  voteCount: 0,
}

const MEMBER = {
  id: 'member-1',
  email: 'member@example.com',
  name: 'Regular Member',
  role: 'member' as const,
  subtitle: null,
  createdAt: '2024-01-01T00:00:00Z',
  lastActive: '2024-01-01T00:00:00Z',
  deactivatedAt: null,
  hasLoggedIn: true,
  invitedBy: 'owner-1',
  roles: [],
  canVote: true,
  voteCount: 0,
}

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'owner-1', email: 'owner@example.com', name: 'Sole Owner', role: 'owner' },
    loading: false,
  }),
}))

function mockApi() {
  return vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/admin/members') return [OWNER, MEMBER] as never
    if (path === '/admin/roles') return [] as never
    if (path === '/admin/config') return {} as never
    return {} as never
  })
}

describe('Members "Resend login link" action', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('POSTs to the authenticated admin endpoint, never the public Turnstile-gated /auth/magic-link', async () => {
    const apiFetch = mockApi()

    render(
      <MemoryRouter>
        <Members />
      </MemoryRouter>,
    )

    // Open the non-self member's "···" actions menu (the owner's own row has none).
    const actionsButton = await screen.findByRole('button', { name: '···' })
    fireEvent.click(actionsButton)

    fireEvent.click(await screen.findByText('Resend login link'))

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(
        '/admin/members/member-1/resend-login',
        expect.objectContaining({ method: 'POST' }),
      )
    })

    // The public login endpoint (which requires a Turnstile token an admin
    // can't supply) must never be hit from this admin action.
    const paths = apiFetch.mock.calls.map((c) => c[0])
    expect(paths).not.toContain('/auth/magic-link')
  })
})
