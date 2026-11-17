import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'

// The Account page lives at /account, matching its name in Settings, and the
// Notifications page at /notifications. Every digest, week-ahead, and reply
// email already sent (and each List-Unsubscribe header) links to
// /profile#<setting> or /account#<setting>, so those URLs must keep landing on
// the same setting, now on the Notifications page. Renders the app's real route config in a memory router, as the
// drafts redirect test does.
vi.mock('./components/Sidebar', () => ({
  Sidebar: ({ containerRef }: { containerRef: { current: HTMLElement | null } }) => <aside data-testid="sidebar" ref={containerRef} />,
}))
vi.mock('./components/MobileTopBar', () => ({ MobileTopBar: () => null }))

const hoisted = vi.hoisted(() => ({ signedIn: true }))

vi.mock('./lib/api', () => {
  class ApiError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
      this.name = 'ApiError'
    }
  }
  return {
    ApiError,
    apiFetch: async (path: string) => {
      if (!hoisted.signedIn) throw new ApiError(401, 'Not authenticated')
      if (path === '/auth/me') {
        return {
          id: 'u1', email: 'a@b.c', name: 'A', role: 'member', title: null, canVote: true,
          emailDigestEnabled: true, emailDigestMatchesEnabled: true, emailWeekAheadEnabled: true, emailRepliesEnabled: true,
          lastSeenFeed: null, isLastOwner: false, termsAcceptanceRequired: false, termsAcceptanceKind: 'first_login',
        }
      }
      if (path === '/config') return { positionVocabulary: ['Support', 'Oppose'], orgNoun: 'team', states: ['RI'], modules: {} }
      if (path === '/roles' || path === '/views' || path === '/users/me/bills') return []
      return {}
    },
  }
})

import { routes } from './App'
import { AuthProvider } from './context/AuthContext'

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(<AuthProvider><RouterProvider router={router} /></AuthProvider>)
  return router
}

beforeEach(() => {
  hoisted.signedIn = true
  sessionStorage.clear()
  localStorage.clear()
  Element.prototype.scrollIntoView = vi.fn()
})

describe('the Account and Notifications page URLs', () => {
  it('renders the Account page at /account', async () => {
    const router = renderAt('/account')
    expect(await screen.findByRole('heading', { level: 2, name: 'Appearance' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/account')
  })

  it('renders the Notifications page at /notifications', async () => {
    const router = renderAt('/notifications')
    expect(await screen.findByRole('heading', { level: 2, name: 'Email digest' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/notifications')
  })

  it('sends the old /profile URL to /account', async () => {
    const router = renderAt('/profile')
    await waitFor(() => expect(router.state.location.pathname).toBe('/account'))
    expect(await screen.findByRole('heading', { level: 2, name: 'Appearance' })).toBeInTheDocument()
  })

  it("sends an old /profile email link's setting anchor to the Notifications page", async () => {
    const router = renderAt('/profile#setting-email-digest')
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/notifications')
      expect(router.state.location.hash).toBe('#setting-email-digest')
    })
  })

  it('keeps a query string through the redirect', async () => {
    const router = renderAt('/profile?from=email#setting-email-replies')
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/notifications')
      expect(router.state.location.search).toBe('?from=email')
      expect(router.state.location.hash).toBe('#setting-email-replies')
    })
  })

  it.each(['setting-email-digest', 'setting-week-ahead', 'setting-email-replies'])('sends /account#%s to the same anchor on /notifications', async (id) => {
    const router = renderAt(`/account#${id}`)
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/notifications')
      expect(router.state.location.hash).toBe(`#${id}`)
    })
  })

  it('lands /account#setting-week-ahead on the week ahead setting, flashed', async () => {
    renderAt('/account#setting-week-ahead')
    const row = await waitFor(() => {
      const el = document.getElementById('setting-week-ahead')
      expect(el).not.toBeNull()
      return el as HTMLElement
    })
    await waitFor(() => expect(row.style.boxShadow).not.toBe(''))
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it('keeps other /account anchors on the Account page', async () => {
    const router = renderAt('/account#setting-color-mode')
    expect(await screen.findByRole('heading', { level: 2, name: 'Appearance' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/account')
  })

  it('sends /admin/notifications to /notifications', async () => {
    const router = renderAt('/admin/notifications')
    await waitFor(() => expect(router.state.location.pathname).toBe('/notifications'))
    expect(await screen.findByRole('heading', { level: 2, name: 'Email digest' })).toBeInTheDocument()
  })

  it('still redirects with a trailing slash', async () => {
    const router = renderAt('/profile/')
    await waitFor(() => expect(router.state.location.pathname).toBe('/account'))
  })

  it('replaces the old /account#setting entry, so Back does not return to it and loop', async () => {
    const router = renderAt('/account#setting-email-digest')
    await waitFor(() => expect(router.state.location.pathname).toBe('/notifications'))
    const visited: string[] = []
    const unsubscribe = router.subscribe(state => { visited.push(state.location.pathname) })
    await router.navigate(-1)
    await new Promise(resolve => setTimeout(resolve, 50))
    unsubscribe()
    expect(visited).not.toContain('/account')
  })

  it('replaces the old entry, so Back does not return to /profile and loop', async () => {
    const router = renderAt('/profile')
    await waitFor(() => expect(router.state.location.pathname).toBe('/account'))
    const visited: string[] = []
    const unsubscribe = router.subscribe(state => { visited.push(state.location.pathname) })
    await router.navigate(-1)
    await new Promise(resolve => setTimeout(resolve, 50))
    unsubscribe()
    expect(visited).not.toContain('/profile')
  })

  it('sends a signed-out visitor from an old email link to sign in', async () => {
    hoisted.signedIn = false
    const router = renderAt('/profile#setting-email-digest')
    expect(await screen.findByText(/sign in/i)).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/login')
  })
})
