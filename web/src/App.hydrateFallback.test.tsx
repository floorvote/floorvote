import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'

// Regression test for the root `HydrateFallback`: RouterProvider renders
// nothing at all until every matched route's initial loader has settled, so
// without a HydrateFallback wired up, a cold load into a route with a slow
// loader is a blank page (and React logs "No `HydrateFallback` element
// provided to render during initial hydration"). This pins both symptoms:
// the splash must actually appear, and the warning must not fire.

const hoisted = vi.hoisted(() => {
  let resolve: (v: unknown) => void = () => {}
  return {
    promise: new Promise<unknown>((res) => { resolve = res }),
    get resolve() { return resolve },
    reset() {
      this.promise = new Promise<unknown>((res) => { resolve = res })
    },
  }
})

vi.mock('./components/Sidebar', () => ({ Sidebar: () => <nav data-testid="sidebar" /> }))
vi.mock('./components/MobileTopBar', () => ({ MobileTopBar: () => null }))

// Every other route's page module still gets imported by App.tsx regardless
// of which route is visited, so all of them need light stubs — only
// ./pages/BillList's loader is wired to the controllable deferred promise.
vi.mock('./pages/Feed', () => ({
  Feed: () => <div>feed page</div>,
  FeedPane: () => <div>feed page</div>,
  feedLoader: () => null,
}))
vi.mock('./pages/BillList', () => ({
  BillList: () => <div>bills page</div>,
  billListLoader: () => hoisted.promise,
}))
vi.mock('./pages/BillDetail', () => ({ BillDetail: () => <div>detail page</div>, billDetailLoader: () => null }))
vi.mock('./pages/Calendar', () => ({ Calendar: () => <div>calendar page</div>, calendarLoader: () => [] }))
vi.mock('./pages/Profile', () => ({ Profile: () => <div>profile page</div> }))
vi.mock('./pages/admin/Members', () => ({ Members: () => <div>members page</div> }))
vi.mock('./pages/admin/Config', () => ({ Config: () => <div>config page</div> }))
vi.mock('./pages/admin/Notifications', () => ({ Notifications: () => <div>notifications page</div> }))

// Providers inside AppLayout fetch /config etc.; route auth needs /auth/me.
vi.mock('./lib/api', () => ({
  apiFetch: async (path: string) => {
    if (path === '/auth/me') {
      return {
        id: 'u1', email: 'a@b.c', name: 'A', role: 'owner', subtitle: null,
        canVote: true, emailDigestEnabled: false, lastSeenFeed: null,
      }
    }
    return {}
  },
  ApiError: class ApiError extends Error {},
}))

import { routes } from './App'
import { AuthProvider } from './context/AuthContext'

function advance(ms: number) {
  act(() => { vi.advanceTimersByTime(ms) })
}

beforeEach(() => {
  hoisted.reset()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('root HydrateFallback', () => {
  it('shows the splash (not a blank page, and no missing-fallback warning) while the initial loader is pending, then the routed page once it resolves', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const router = createMemoryRouter(routes, { initialEntries: ['/bills'] })
    render(<AuthProvider><RouterProvider router={router} /></AuthProvider>)

    // Past LoadingState's 500ms blank tier, well before the /bills loader
    // (still pending) resolves.
    advance(600)

    expect(screen.queryByText('bills page')).toBeNull()
    expect(screen.getByRole('img', { name: 'Loading' })).toBeInTheDocument()
    expect(
      warnSpy.mock.calls.some((args) =>
        typeof args[0] === 'string' && args[0].includes('HydrateFallback'),
      ),
    ).toBe(false)

    // Resolve the loader, then fall back to real timers for the settle —
    // nothing left in this test relies on the fake clock, and mixing it with
    // waitFor's own polling would just risk a self-inflicted hang.
    await act(async () => { hoisted.resolve(null) })
    vi.useRealTimers()

    await waitFor(() => expect(screen.getByText('bills page')).toBeInTheDocument())
    expect(screen.queryByRole('img', { name: 'Loading' })).toBeNull()

    warnSpy.mockRestore()
  })
})
