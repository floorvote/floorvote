import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { routes } from './App'
import { AuthProvider } from './context/AuthContext'

/**
 * The terms gate, end to end, against the REAL route tree.
 *
 * Three bugs shipped past the unit tests here, all the same shape: each
 * component was correct in isolation, and the fault lived in the handoff
 * between RequireAuth, AppLayout, the route loaders and the router's stored
 * errors. #187 (loader 403 hit RootErrorBoundary), #188 (bill routes shadow it
 * with their own errorElement, and the loader flattened the code away), #191
 * (RequireAuth cleared the flag without retiring the stale loader error, so a
 * second interstitial appeared inside the shell).
 *
 * So this mocks `fetch`, not `lib/api` — the real apiFetch, ApiError and
 * terms-not-accepted event all run, and the fake server behaves like an armed
 * tenant: everything 403s with the code except /auth/me and /auth/accept-terms.
 */

const server = { accepted: false, calls: [] as string[] }

function jsonOk(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response
}

function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = typeof input === 'string' ? input : String(input)
  const tag = (st: number) => { server.calls.push(`${url} -> ${st}`); }

  if (url.includes('/auth/me')) {
    tag(200)
    return Promise.resolve(jsonOk({
      id: 'u1', email: 'a@b.c', name: 'A', role: 'member', subtitle: null,
      canVote: true, emailDigestEnabled: false, emailWeekAheadEnabled: false,
      lastSeenFeed: null, isLastOwner: false,
      termsAcceptanceRequired: !server.accepted,
      termsAcceptanceKind: 'existing_member',
    }))
  }
  if (url.includes('/auth/accept-terms')) {
    tag(204)
    server.accepted = true
    return Promise.resolve({ ok: true, status: 204, json: async () => undefined } as Response)
  }
  if (url.includes('/auth/demo-mode')) { tag(200); return Promise.resolve(jsonOk({ demoMode: false })) }

  // The gate: every other route is refused until they accept.
  if (!server.accepted) {
    tag(403)
    return Promise.resolve({
      ok: false, status: 403,
      json: async () => ({ error: 'Terms not accepted', code: 'terms_not_accepted' }),
    } as Response)
  }
  // Accepted: plausible empty payloads, so the pages render rather than
  // crashing on a shape they did not expect -- a crash would satisfy "the
  // interstitial is gone" for the wrong reason.
  if (url.includes('/feed')) { tag(200); return Promise.resolve(jsonOk({ events: [], total: 0, page: 1, limit: 40 })) }
  if (url.includes('/calendar')) { tag(200); return Promise.resolve(jsonOk([])) }
  tag(200)
  return Promise.resolve(jsonOk({}))
}

// jsdom's location.reload is an unimplemented no-op that only logs, so a broken
// handler would look identical to a working one. Swap in a spy.
let reload: ReturnType<typeof vi.fn>
let originalLocation: PropertyDescriptor | undefined

beforeEach(() => {
  server.accepted = false
  server.calls = []
  vi.stubGlobal('fetch', vi.fn(fakeFetch))
  reload = vi.fn()
  originalLocation = Object.getOwnPropertyDescriptor(window, 'location')
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload } })
})
afterEach(() => {
  vi.unstubAllGlobals()
  if (originalLocation) Object.defineProperty(window, 'location', originalLocation)
})

function mountAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  return render(<AuthProvider><RouterProvider router={router} /></AuthProvider>)
}

const checkbox = () => screen.queryAllByRole('checkbox')

describe.each([
  ['the app root', '/', 'reload'],
  ['a bill link, the digest-email entry point', '/WI/2025-2026/SB215', 'in-place'],
])('terms gate on a fresh load at %s', (_label, path, recovery) => {
  it('shows exactly one interstitial, and clears it on acceptance', async () => {
    mountAt(path)

    // Gated: the interstitial, exactly one of it, and no error card standing
    // in for it. #187 and #188 each failed right here.
    await screen.findByText(/I have read and agree to the/i)
    expect(checkbox()).toHaveLength(1)
    expect(screen.queryByText(/something went wrong/i)).toBeNull()
    expect(screen.queryByText(/failed to load bill/i)).toBeNull()

    const before = server.calls.length
    fireEvent.click(checkbox()[0])
    fireEvent.click(screen.getByRole('button', { name: /continue/i }))

    // The refused request is retried either way -- that is what retires the
    // router's stored error instead of leaving it for a manual refresh.
    await waitFor(() => expect(server.calls.length).toBeGreaterThan(before + 1))

    if (recovery === 'reload') {
      // Caught by the parent route's errorElement, which revalidation cannot
      // clear, so recovery is a reload of the same URL. jsdom cannot navigate,
      // so the request itself is the assertion.
      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    } else {
      // Caught by the route's own errorElement, which revalidation does clear.
      // #191 left a second, freshly-unchecked interstitial here.
      await waitFor(() => expect(screen.queryAllByText(/I have read and agree to the/i)).toHaveLength(0))
      expect(checkbox()).toHaveLength(0)
      expect(reload).not.toHaveBeenCalled()
    }
    // What the pages draw after the gate opens is deliberately out of scope:
    // the fake serves empty payloads, so asserting they render would mean
    // faking every shape the shell touches, and this test would then break for
    // reasons having nothing to do with the gate.
  })
})
