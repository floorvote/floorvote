import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Profile } from './Profile'
import * as api from '../lib/api'

// Mutable mock user so each test can vary `role` (owner/admin/member) while
// reusing a single vi.mock factory — vi.mock factories are hoisted above
// imports, so the mutable state must come from vi.hoisted.
const { mockUser } = vi.hoisted(() => ({
  mockUser: {
    id: 'u1', email: 'a@b.c', name: 'A', role: 'member' as 'member' | 'admin' | 'owner', subtitle: null,
    canVote: true, emailDigestEnabled: true, emailWeekAheadEnabled: true, lastSeenFeed: null,
    isLastOwner: false,
  },
}))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: mockUser,
    loading: false, authError: false,
    setSubtitle: () => {}, setName: () => {}, setEmailDigestEnabled: () => {}, setLastSeenFeed: () => {},
  }),
}))

vi.mock('../context/ConfigContext', () => ({
  useConfig: () => ({ config: { orgNoun: 'coalition' }, multiState: false, loading: false }),
}))

function mockApi(handlers: Record<string, (init?: RequestInit) => unknown> = {}) {
  return vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/config') return {} as never
    const handler = handlers[path]
    if (handler) return handler(init) as never
    return {} as never
  })
}

describe('Profile self role-change (demote)', () => {
  let originalLocation: Location

  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.spyOn(window, 'alert').mockImplementation(() => {})
    originalLocation = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, href: '' },
    })
    mockUser.role = 'member'
  })

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation })
  })

  it('shows the owner→admin demote button and description for an owner', async () => {
    mockUser.role = 'owner'
    mockApi()
    render(<MemoryRouter><Profile /></MemoryRouter>)
    expect(await screen.findByRole('button', { name: 'Demote my account from Owner to Admin' })).toBeInTheDocument()
    expect(screen.getByText('Immediately lose your Owner permissions. An Owner can restore your role later.')).toBeInTheDocument()
  })

  it('shows the admin→member demote button and description for an admin', async () => {
    mockUser.role = 'admin'
    mockApi()
    render(<MemoryRouter><Profile /></MemoryRouter>)
    expect(await screen.findByRole('button', { name: 'Demote my account from Admin to Member' })).toBeInTheDocument()
    expect(screen.getByText('Immediately lose your Admin permissions. An Owner or Admin can restore your role later.')).toBeInTheDocument()
  })

  it('shows no demote button for a member', async () => {
    mockUser.role = 'member'
    mockApi()
    render(<MemoryRouter><Profile /></MemoryRouter>)
    await screen.findByRole('button', { name: 'Deactivate my account' })
    expect(screen.queryByRole('button', { name: /Demote my account/ })).not.toBeInTheDocument()
  })

  it('demotes an owner to admin: confirms, PATCHes the shared role endpoint, and redirects to /profile', async () => {
    mockUser.role = 'owner'
    const spy = mockApi({ '/admin/members/u1': () => ({ ok: true }) })
    render(<MemoryRouter><Profile /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: 'Demote my account from Owner to Admin' }))
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith('/admin/members/u1', expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ role: 'admin' }),
      }))
    })
    await waitFor(() => expect(window.location.href).toBe('/profile'))
  })

  it('demotes an admin to member: confirms, PATCHes the shared role endpoint, and redirects home', async () => {
    mockUser.role = 'admin'
    const spy = mockApi({ '/admin/members/u1': () => ({ ok: true }) })
    render(<MemoryRouter><Profile /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: 'Demote my account from Admin to Member' }))
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith('/admin/members/u1', expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ role: 'member' }),
      }))
    })
    await waitFor(() => expect(window.location.href).toBe('/'))
  })

  it('does not demote when the confirm dialog is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    mockUser.role = 'owner'
    const spy = mockApi()
    render(<MemoryRouter><Profile /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: 'Demote my account from Owner to Admin' }))
    await new Promise((r) => setTimeout(r, 0))
    expect(spy).not.toHaveBeenCalledWith('/admin/members/u1', expect.anything())
  })
})
