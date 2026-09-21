import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { Members } from './Members'
import * as api from '../../lib/api'

// The admin table pins the signed-in user to the top of the unfiltered list
// (matching MembersPopup), but must fall back to plain role-then-name order the
// moment a search or the login-trouble filter is active — otherwise searching
// for someone else staples your own row to the results.

const base = {
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

const OWNER = { ...base, id: 'owner-1', email: 'owner@example.com', name: 'Sole Owner', role: 'owner' as const }
const SELF = { ...base, id: 'admin-1', email: 'zed@example.com', name: 'Zed Admin', role: 'admin' as const }
const OTHER = { ...base, id: 'admin-2', email: 'alice@example.com', name: 'Alice Admin', role: 'admin' as const }

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'admin-1', email: 'zed@example.com', name: 'Zed Admin', role: 'admin' },
    loading: false,
  }),
}))

vi.mock('../../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: false }),
}))

function renderMembers() {
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/admin/members') return [OWNER, SELF, OTHER] as never
    if (path === '/admin/roles') return [] as never
    if (path === '/admin/config') return {} as never
    return {} as never
  })
  return render(
    <MemoryRouter>
      <Members />
    </MemoryRouter>,
  )
}

function nameOrder(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.members-name-cell')]
    .map(td => td.querySelector('span')?.textContent ?? '')
}

afterEach(() => { vi.restoreAllMocks() })

describe('Members table self-pinning', () => {
  it('pins the signed-in user to the top when no filter is active', async () => {
    const { container } = renderMembers()
    await screen.findByText('Sole Owner')
    // Without pinning, role priority would put the owner first.
    expect(nameOrder(container)).toEqual(['Zed Admin', 'Sole Owner', 'Alice Admin'])
  })

  it('does not pin the signed-in user when a search is active', async () => {
    const { container } = renderMembers()
    await screen.findByText('Sole Owner')
    const user = userEvent.setup()
    await user.type(screen.getByPlaceholderText(/search members by name or email/i), 'admin')
    // Plain role-then-name order: Alice sorts before Zed, self is not hoisted.
    expect(nameOrder(container)).toEqual(['Alice Admin', 'Zed Admin'])
  })
})
