import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Profile } from './Profile'
import * as api from '../lib/api'

// The Notifications card's always-sent line names only the mentions that can
// reach this member: @admins only for an Admin or Owner, and "your role" only
// for someone in at least one role. Everyone gets direct and @everyone mentions.
const hoisted = vi.hoisted(() => ({ role: 'member' as 'member' | 'admin' | 'owner' }))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'u1', email: 'a@b.c', name: 'A', role: hoisted.role, title: null,
      canVote: true, emailDigestEnabled: true, emailWeekAheadEnabled: true, emailRepliesEnabled: true, lastSeenFeed: null,
      isLastOwner: false,
    },
    loading: false, authError: false,
    setTitle: () => {}, setName: () => {}, setEmailDigestEnabled: () => {}, setEmailDigestMatchesEnabled: () => {}, setEmailRepliesEnabled: () => {}, setLastSeenFeed: () => {},
  }),
}))

vi.mock('../context/ConfigContext', () => ({
  useConfig: () => ({ config: { orgNoun: 'team' }, multiState: false, loading: false }),
}))

type Role = { id: string; name: string; members: Array<{ id: string; name: string; title: string | null }> }

function mockRoles(roles: Role[] | Error) {
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/roles') {
      if (roles instanceof Error) throw roles
      return roles as never
    }
    if (path === '/config') return { modules: {} } as never
    return {} as never
  })
}

const me = { id: 'u1', name: 'A', title: null }
const other = { id: 'u2', name: 'B', title: null }

function notificationsSection() {
  return screen.getByRole('heading', { level: 2, name: 'Notifications' }).parentElement as HTMLElement
}

async function expectLine(text: string) {
  expect(await within(notificationsSection()).findByText(text)).toBeInTheDocument()
}

describe('Profile always-sent mention line', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    hoisted.role = 'member'
  })

  it('names only you and @everyone for a member in no role', async () => {
    mockRoles([])
    render(<MemoryRouter><Profile /></MemoryRouter>)
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith('/roles'))
    await expectLine("You'll always get an email when someone mentions you or @everyone.")
    expect(within(notificationsSection()).queryByText(/@admins/)).not.toBeInTheDocument()
    expect(within(notificationsSection()).queryByText(/your role/)).not.toBeInTheDocument()
  })

  it("ignores roles the member isn't in", async () => {
    mockRoles([{ id: 'r1', name: 'Policy', members: [other] }])
    render(<MemoryRouter><Profile /></MemoryRouter>)
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith('/roles'))
    await expectLine("You'll always get an email when someone mentions you or @everyone.")
  })

  it('adds "your role" for a member in one role', async () => {
    mockRoles([{ id: 'r1', name: 'Policy', members: [other, me] }, { id: 'r2', name: 'Comms', members: [other] }])
    render(<MemoryRouter><Profile /></MemoryRouter>)
    await expectLine("You'll always get an email when someone mentions you, your role, or @everyone.")
  })

  it('says "one of your roles" for a member in more than one role', async () => {
    mockRoles([{ id: 'r1', name: 'Policy', members: [me] }, { id: 'r2', name: 'Comms', members: [me] }])
    render(<MemoryRouter><Profile /></MemoryRouter>)
    await expectLine("You'll always get an email when someone mentions you, one of your roles, or @everyone.")
  })

  it('adds @admins for an admin in no role', async () => {
    hoisted.role = 'admin'
    mockRoles([])
    render(<MemoryRouter><Profile /></MemoryRouter>)
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith('/roles'))
    await expectLine("You'll always get an email when someone mentions you, @admins, or @everyone.")
  })

  it('names all four for an owner in a role', async () => {
    hoisted.role = 'owner'
    mockRoles([{ id: 'r1', name: 'Policy', members: [me] }])
    render(<MemoryRouter><Profile /></MemoryRouter>)
    await expectLine("You'll always get an email when someone mentions you, your role, @admins, or @everyone.")
  })

  it('falls back to the role-free line when roles fail to load', async () => {
    mockRoles(new Error('network'))
    render(<MemoryRouter><Profile /></MemoryRouter>)
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith('/roles'))
    await expectLine("You'll always get an email when someone mentions you or @everyone.")
  })
})
