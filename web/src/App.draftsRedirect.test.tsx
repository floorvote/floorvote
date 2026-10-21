import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'

// The Settings → Draft bills page is retired (drafts are created and found on
// the Bills page), so its old URL has to keep working for bookmarks and old
// links. This renders the app's real route config — loaders, RequireAuth,
// RequireAdmin, AppLayout and the real Bills page — in a memory router, since a
// mocked useLocation/Navigate would hide a redirect that the data router
// handles differently (a loader-backed destination, a stripped query string).
vi.mock('./components/Sidebar', () => ({
  Sidebar: ({ containerRef }: { containerRef: { current: HTMLElement | null } }) => <aside data-testid="sidebar" ref={containerRef} />,
}))
vi.mock('./components/MobileTopBar', () => ({ MobileTopBar: () => null }))

const hoisted = vi.hoisted(() => ({ role: 'owner' as string | null, calls: [] as string[] }))

function draftBill() {
  return {
    id: 'b1', billNumber: 'HB 1', title: 'Draft bill one', state: 'RI', status: 'Introduced',
    session: '2026', sessionSlug: '2026', sessionId: null, yearStart: 2026, yearEnd: 2026,
    abstract: null, url: null, stateUrl: null, lastAction: null, lastActionDate: null, tenantSummary: null,
    tags: [], priority: null, matchType: null, position: null, relevanceScore: null, aiProcessedAt: null,
    newMatchAt: null, triagedAt: null, voteCounts: { support: 0, oppose: 0, neutral: 0 }, myVote: null,
    commentCount: 0, hasNote: false, hasComment: false, updatedAt: '2026-01-01 00:00:00', isDraft: true,
  }
}

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
      hoisted.calls.push(path)
      if (hoisted.role === null) throw new ApiError(401, 'Not authenticated')
      if (path === '/auth/me') {
        return { id: 'u1', email: 'a@b.c', name: 'A', role: hoisted.role, canVote: true, emailDigestEnabled: false, lastSeenFeed: null }
      }
      if (path === '/config') return { positionVocabulary: ['Support', 'Oppose'], orgNoun: 'association', states: ['RI'] }
      if (path === '/users/me/bills' || path === '/config/custom-fields') return []
      if (path === '/views') return { views: [] }
      if (path.startsWith('/bills/facets')) {
        return {
          status: {}, priority: {}, sessionName: {}, year: {}, state: { RI: 1 }, position: {}, tag: {}, subject: {}, field: {},
          myBillsCount: 0, newMatchesCount: 0, hasDrafts: true, draftCount: 1,
        }
      }
      if (path.startsWith('/bills?')) {
        return { bills: [draftBill()], pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 } }
      }
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
  hoisted.role = 'owner'
  hoisted.calls = []
  sessionStorage.clear()
  localStorage.clear()
})

describe('the retired /admin/drafts URL', () => {
  it('lands an admin on the Bills page with the Drafts filter on', async () => {
    const router = renderAt('/admin/drafts')

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/bills')
      expect(router.state.location.search).toBe('?drafts=1')
    })
    // The destination really rendered, filter active and in the bills request.
    expect(await screen.findByRole('button', { name: /^drafts/i, pressed: true })).toBeInTheDocument()
    await waitFor(() => {
      expect(hoisted.calls.some(c => c.startsWith('/bills?') && c.includes('drafts=1'))).toBe(true)
    })
  })

  it('replaces the old entry, so Back does not return to the retired URL and loop', async () => {
    const router = renderAt('/admin/drafts')
    await waitFor(() => expect(router.state.location.pathname).toBe('/bills'))
    // Settle the Bills page first (it may tidy its own URL), then go Back and
    // record every location the router passes through. A pushed redirect would
    // step back onto /admin/drafts (and be redirected again — a Back trap).
    expect(await screen.findByRole('button', { name: /^drafts/i, pressed: true })).toBeInTheDocument()
    const visited: string[] = []
    const unsubscribe = router.subscribe(state => { visited.push(state.location.pathname) })
    await router.navigate(-1)
    await new Promise(resolve => setTimeout(resolve, 50))
    unsubscribe()
    expect(visited).not.toContain('/admin/drafts')
  })

  it('lands a non-admin member on the draft list too, rather than bouncing them to the feed', async () => {
    hoisted.role = 'member'
    const router = renderAt('/admin/drafts')
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/bills')
      expect(router.state.location.search).toBe('?drafts=1')
    })
  })

  it('sends a signed-out visitor to login, not to the Bills page', async () => {
    hoisted.role = null
    const router = renderAt('/admin/drafts')
    expect(await screen.findByText(/sign in/i)).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/login')
  })

  it('still redirects when the old URL has a trailing slash', async () => {
    const router = renderAt('/admin/drafts/')
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/bills')
      expect(router.state.location.search).toBe('?drafts=1')
    })
  })
})
