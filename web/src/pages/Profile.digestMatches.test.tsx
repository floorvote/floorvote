import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { Profile } from './Profile'
import * as api from '../lib/api'

// #366: "Include newly matched bills" sits under the digest switch, for
// non-admins only, on by default.

const auth = vi.hoisted(() => ({
  user: {} as Record<string, unknown>,
}))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: auth.user,
    loading: false, authError: false,
    setSubtitle: () => {}, setName: () => {}, setEmailDigestEnabled: () => {}, setEmailRepliesEnabled: () => {},
    setEmailDigestMatchesEnabled: () => {}, setLastSeenFeed: () => {},
  }),
}))

vi.mock('../context/ConfigContext', () => ({
  useConfig: () => ({ config: { orgNoun: 'coalition' }, multiState: false, loading: false }),
}))

function signIn(role: 'member' | 'admin' | 'owner', over: Record<string, unknown> = {}) {
  auth.user = {
    id: 'u1', email: 'a@b.c', name: 'A', role, subtitle: null,
    canVote: true, emailDigestEnabled: true, emailDigestMatchesEnabled: true, emailWeekAheadEnabled: true, emailRepliesEnabled: true,
    lastSeenFeed: null, isLastOwner: false, ...over,
  }
}

const matchesName = /include newly matched bills/i

describe('Profile: the digest new-match option', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => (path === '/config' ? { modules: { 'email-digest': { enabled: true } } } : {}) as never)
  })

  it('shows a member the option, on, nested inside the digest row', () => {
    signIn('member')
    render(<MemoryRouter><Profile /></MemoryRouter>)
    const option = screen.getByRole('switch', { name: matchesName })
    expect(option).toBeChecked()
    expect(document.getElementById('setting-email-digest')).toContainElement(option)
  })

  it.each(['admin', 'owner'] as const)('shows no option to an %s, who always gets the section', (role) => {
    signIn(role)
    render(<MemoryRouter><Profile /></MemoryRouter>)
    expect(screen.queryByRole('switch', { name: matchesName })).not.toBeInTheDocument()
  })

  it("reflects a member's saved choice", () => {
    signIn('member', { emailDigestMatchesEnabled: false })
    render(<MemoryRouter><Profile /></MemoryRouter>)
    expect(screen.getByRole('switch', { name: matchesName })).not.toBeChecked()
  })

  it("saves the member's choice", async () => {
    signIn('member')
    render(<MemoryRouter><Profile /></MemoryRouter>)
    const option = screen.getByRole('switch', { name: matchesName })

    await userEvent.click(option)

    expect(api.apiFetch).toHaveBeenCalledWith('/users/me', { method: 'PATCH', body: JSON.stringify({ emailDigestMatchesEnabled: false }) })
    expect(option).not.toBeChecked()
  })

  it('is unavailable while the digest switch is off', () => {
    signIn('member', { emailDigestEnabled: false })
    render(<MemoryRouter><Profile /></MemoryRouter>)
    const option = screen.getByRole('switch', { name: matchesName })
    expect(option).toBeDisabled()
    expect(within(document.getElementById('setting-email-digest') as HTMLElement).getByRole('switch', { name: /recent bill activity/i })).not.toBeChecked()
  })
})
