import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Members } from './Members'
import * as api from '../../lib/api'
import { ApiError } from '../../lib/api'

// What the server says when an admin hits a send limit (a 429 with this
// message). The admin has to see it, not a generic "failed" line.
const TOO_MANY = 'This member was sent several invites or sign-in links in the past hour. Ask them to check their spam folder, or try again in a little while.'

function member(overrides: Record<string, unknown>) {
  return {
    email: 'x@example.com',
    name: 'Someone',
    role: 'member' as const,
    title: null,
    createdAt: '2024-01-01T00:00:00Z',
    lastActive: '2024-01-01T00:00:00Z',
    deactivatedAt: null,
    hasLoggedIn: true,
    invitedBy: { id: 'owner-1', name: 'Sole Owner', email: 'owner@example.com' },
    roles: [],
    canVote: true,
    voteCount: 0,
    ...overrides,
  }
}

const OWNER = member({ id: 'owner-1', email: 'owner@example.com', name: 'Sole Owner', role: 'owner', invitedBy: null })
const PENDING = member({ id: 'pending-1', email: 'jane@example.com', name: 'Jane Pending', hasLoggedIn: false })
const SIGNED_IN = member({ id: 'in-1', email: 'in@example.com', name: 'Signed In' })

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'owner-1', email: 'owner@example.com', name: 'Sole Owner', role: 'owner' },
    loading: false,
  }),
}))

function mockApiRefusing(path: string) {
  return vi.spyOn(api, 'apiFetch').mockImplementation(async (p: string) => {
    if (p === '/admin/members') return [OWNER, PENDING, SIGNED_IN] as never
    if (p === '/admin/roles') return [] as never
    if (p === '/admin/config') return {} as never
    if (p === path) throw new ApiError(429, TOO_MANY)
    return {} as never
  })
}

async function chooseAction(memberName: string, item: string) {
  const row = (await screen.findByText(memberName)).closest('tr')!
  fireEvent.click(within(row).getByRole('button', { name: '···' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: item }))
}

describe('Members: an admin who hits a send limit is told so', () => {
  let alertSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.restoreAllMocks()
    alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('shows the limit message when Resend invite is refused', async () => {
    mockApiRefusing('/admin/members/pending-1/resend-invite')
    render(<MemoryRouter><Members /></MemoryRouter>)
    await chooseAction('Jane Pending', 'Resend invite')
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(TOO_MANY))
  })

  it('shows the limit message when Resend login link is refused', async () => {
    mockApiRefusing('/admin/members/in-1/resend-login')
    render(<MemoryRouter><Members /></MemoryRouter>)
    await chooseAction('Signed In', 'Resend login link')
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(TOO_MANY))
  })
})
