import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Profile } from './Profile'
import * as api from '../lib/api'
import { ApiError } from '../lib/api'
import { ConfigContext, type AppConfig } from '../context/ConfigContext'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'u1', email: 'a@b.c', name: 'A', role: 'member', subtitle: null,
      canVote: true, emailDigestEnabled: true, emailWeekAheadEnabled: true, lastSeenFeed: null,
      isLastOwner: false,
    },
    loading: false, authError: false,
    setSubtitle: () => {}, setName: () => {}, setEmailDigestEnabled: () => {}, setLastSeenFeed: () => {},
  }),
}))

function renderProfile(accountDeletionEnabled?: boolean) {
  const value = { config: { orgNoun: 'coalition', accountDeletionEnabled } as AppConfig, multiState: false, loading: false }
  return render(
    <ConfigContext.Provider value={value}>
      <MemoryRouter><Profile /></MemoryRouter>
    </ConfigContext.Provider>,
  )
}

function mockApi(handlers: Record<string, (init?: RequestInit) => unknown> = {}) {
  return vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/config') return {} as never
    const handler = handlers[path]
    if (handler) return handler(init) as never
    return {} as never
  })
}

describe('Profile Account section', () => {
  let confirmSpy: ReturnType<typeof vi.spyOn>
  let originalLocation: Location

  beforeEach(() => {
    vi.restoreAllMocks()
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.spyOn(window, 'alert').mockImplementation(() => {})
    originalLocation = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, href: '' },
    })
  })

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation })
  })

  it('always shows "Deactivate my account", and hides "Delete my account" when the flag is false', async () => {
    mockApi()
    renderProfile(false)
    expect(await screen.findByRole('button', { name: 'Deactivate my account' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete my account' })).not.toBeInTheDocument()
  })

  it('hides "Delete my account" when the flag is undefined', async () => {
    mockApi()
    renderProfile(undefined)
    expect(await screen.findByRole('button', { name: 'Deactivate my account' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete my account' })).not.toBeInTheDocument()
  })

  it('shows "Delete my account" when the flag is true', async () => {
    mockApi()
    renderProfile(true)
    expect(await screen.findByRole('button', { name: 'Delete my account' })).toBeInTheDocument()
  })

  it('loads and renders login activity when "Show my login activity" is clicked', async () => {
    mockApi({
      '/users/me/auth-events': () => ({
        events: [
          { id: 'e1', event: 'verify_success', reason: null, linkType: null, provider: null, ipCountry: 'US', createdAt: new Date().toISOString() },
        ],
      }),
    })
    renderProfile(true)
    fireEvent.click(await screen.findByRole('button', { name: 'Show my login activity' }))
    expect(await screen.findByText('Signed in')).toBeInTheDocument()
  })

  it('renders the "Deactivate my account" description verbatim', async () => {
    mockApi()
    renderProfile(false)
    expect(await screen.findByRole('button', { name: 'Deactivate my account' })).toBeInTheDocument()
    expect(screen.getByText(
      "You'll be logged out immediately and your activity (votes, comments, and notes) will be hidden. An admin can reactivate your account and activity later.",
    )).toBeInTheDocument()
  })

  it('renders the "Delete my account" description verbatim when enabled', async () => {
    mockApi()
    renderProfile(true)
    expect(await screen.findByRole('button', { name: 'Delete my account' })).toBeInTheDocument()
    expect(screen.getByText(
      'Permanently remove your account and all its activity (votes, comments, and notes). This cannot be undone.',
    )).toBeInTheDocument()
  })

  it('deactivates: confirms, calls the endpoint with POST, and redirects home', async () => {
    const spy = mockApi({ '/users/me/deactivate': () => ({ ok: true }) })
    renderProfile(false)
    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate my account' }))
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith('/users/me/deactivate', expect.objectContaining({ method: 'POST' }))
    })
    await waitFor(() => expect(window.location.href).toBe('/'))
  })

  it('does not deactivate when the confirm dialog is cancelled', async () => {
    confirmSpy.mockReturnValue(false)
    const spy = mockApi()
    renderProfile(false)
    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate my account' }))
    await new Promise((r) => setTimeout(r, 0))
    expect(spy).not.toHaveBeenCalledWith('/users/me/deactivate', expect.anything())
  })

  it('deletes: confirms, calls the endpoint with DELETE, and redirects home', async () => {
    const spy = mockApi({ '/users/me': () => ({ ok: true }) })
    renderProfile(true)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete my account' }))
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith('/users/me', expect.objectContaining({ method: 'DELETE' }))
    })
    await waitFor(() => expect(window.location.href).toBe('/'))
  })

  it('shows an error message when deletion is disabled server-side (403)', async () => {
    mockApi({
      '/users/me': () => {
        throw new ApiError(403, 'Account deletion is disabled')
      },
    })
    renderProfile(true)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete my account' }))
    expect(await screen.findByText(/Account deletion is disabled/)).toBeInTheDocument()
  })
})
