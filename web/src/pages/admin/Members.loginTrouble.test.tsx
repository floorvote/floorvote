import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
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
  loginTrouble: false,
}

const TROUBLE_MEMBER = {
  id: 'trouble-1',
  email: 'trouble@example.com',
  name: 'Trouble Member',
  role: 'member' as const,
  subtitle: null,
  createdAt: '2024-01-01T00:00:00Z',
  lastActive: '2024-01-01T00:00:00Z',
  deactivatedAt: null,
  hasLoggedIn: true,
  invitedBy: null,
  roles: [],
  canVote: true,
  voteCount: 0,
  loginTrouble: true,
}

const CLEAN_MEMBER = {
  id: 'clean-1',
  email: 'clean@example.com',
  name: 'Clean Member',
  role: 'member' as const,
  subtitle: null,
  createdAt: '2024-01-01T00:00:00Z',
  lastActive: '2024-01-01T00:00:00Z',
  deactivatedAt: null,
  hasLoggedIn: true,
  invitedBy: null,
  roles: [],
  canVote: true,
  voteCount: 0,
  loginTrouble: false,
}

const MEMBERS = [OWNER, TROUBLE_MEMBER, CLEAN_MEMBER]

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'owner-1', email: 'owner@example.com', name: 'Sole Owner', role: 'owner' },
    loading: false,
  }),
}))

function mockApi() {
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/admin/members') return MEMBERS as never
    if (path === '/admin/roles') return [] as never
    if (path === '/admin/config') return {} as never
    if (path === '/admin/members/trouble-1/auth-events') {
      return { events: [], suppression: { suppressed: null }, delivery: {} } as never
    }
    return {} as never
  })
}

describe('Members login-trouble indicator', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('does not render the old text badge', async () => {
    mockApi()
    render(
      <MemoryRouter>
        <Members />
      </MemoryRouter>,
    )

    await screen.findByText('Trouble Member')
    expect(screen.queryByText(/⚠️ Login trouble/i)).not.toBeInTheDocument()
  })

  it('shows a clickable caution control on the trouble member row that opens login activity', async () => {
    mockApi()
    render(
      <MemoryRouter>
        <Members />
      </MemoryRouter>,
    )

    const row = (await screen.findByText('Trouble Member')).closest('tr')!
    const caution = within(row).getByTitle(/login trouble/i)
    expect(caution).toBeInTheDocument()

    // Clean member's row must NOT have a caution control.
    const cleanRow = (await screen.findByText('Clean Member')).closest('tr')!
    expect(within(cleanRow).queryByTitle(/login trouble/i)).not.toBeInTheDocument()

    fireEvent.click(caution)

    expect(await screen.findByText('Login activity')).toBeInTheDocument()
  })

  it('renders a count callout and filters the table when clicked, toggling off on a second click', async () => {
    mockApi()
    render(
      <MemoryRouter>
        <Members />
      </MemoryRouter>,
    )

    await screen.findByText('Trouble Member')
    await screen.findByText('Clean Member')

    const callout = await screen.findByText(/1 member with login trouble/i)
    fireEvent.click(callout)

    expect(screen.getByText('Trouble Member')).toBeInTheDocument()
    expect(screen.queryByText('Clean Member')).not.toBeInTheDocument()

    fireEvent.click(callout)
    expect(await screen.findByText('Clean Member')).toBeInTheDocument()
  })
})
