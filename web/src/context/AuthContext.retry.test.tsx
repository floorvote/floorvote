import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { StrictMode } from 'react'

/**
 * /auth/me hung exactly like /feed in the 2026-08-17 D1 stall, and the old
 * AuthProvider treated the first non-401 as final — one blip and the whole app
 * became "Unable to connect. Please refresh the page." These pin the retry, and
 * pin the two things that must NOT be retried away: a 401 (a real answer) and a
 * StrictMode-aborted first request (not a failure at all).
 *
 * retryFetch is deliberately NOT mocked — mocking it would leave the wiring
 * (progress box, signal, error classification) completely untested.
 */

// The error class has to come from vi.hoisted too: the vi.mock factory below is
// hoisted above every top-level declaration in this file, so a plain `class`
// here would still be in its temporal dead zone when the factory runs.
const hoisted = vi.hoisted(() => ({
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
      this.name = 'ApiError'
    }
  },
  calls: [] as string[],
  impl: (async () => ({})) as (path: string, init?: { signal?: AbortSignal }) => Promise<unknown>,
}))

const MockApiError = hoisted.ApiError

vi.mock('../lib/api', () => ({
  ApiError: hoisted.ApiError,
  apiFetch: (path: string, init?: { signal?: AbortSignal }) => {
    hoisted.calls.push(path)
    return hoisted.impl(path, init)
  },
}))

import { AuthProvider, useAuth } from './AuthContext'

const USER = {
  id: 'u1', email: 'a@b.c', name: 'A', role: 'member', subtitle: null,
  canVote: true, emailDigestEnabled: false, emailWeekAheadEnabled: false,
  lastSeenFeed: null, isLastOwner: false,
}

/** Every render's auth snapshot, so "never set authError" is checkable over time. */
let history: { user: unknown; loading: boolean; authError: boolean }[] = []

function Probe() {
  const { user, loading, authError, setSubtitle } = useAuth()
  history.push({ user, loading, authError })
  return (
    <div>
      <span data-testid="state">{loading ? 'loading' : authError ? 'error' : user ? 'user' : 'anon'}</span>
      <button onClick={() => setSubtitle('nudge')}>rerender</button>
    </div>
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  hoisted.calls = []
  history = []
  // retryFetch logs one warn per retry; keep the suite output readable.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Advance fake timers and flush the promise chain inside act(). */
async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

function state() {
  return screen.getByTestId('state').textContent
}

describe('AuthProvider retries /auth/me', () => {
  it('rides out a 500 and lands the user without ever flipping authError', async () => {
    hoisted.impl = async () => {
      if (hoisted.calls.length === 1) throw new MockApiError(500, 'Internal Server Error')
      return USER
    }
    render(<AuthProvider><Probe /></AuthProvider>)

    // The 500 has already landed and been swallowed: still loading, no error,
    // and crucially no second attempt yet — this is the window in which the old
    // code had already given up.
    await advance(0)
    expect(hoisted.calls).toHaveLength(1)
    expect(state()).toBe('loading')

    // Backoff for attempt 1 is 1000ms ± 25% jitter.
    await advance(1_300)
    expect(hoisted.calls).toEqual(['/auth/me', '/auth/me'])
    expect(state()).toBe('user')
    expect(history.every((h) => h.authError === false)).toBe(true)
  })

  it('keeps retrying across repeated 5xx rather than capping out', async () => {
    hoisted.impl = async () => {
      if (hoisted.calls.length <= 3) throw new MockApiError(503, 'Service Unavailable')
      return USER
    }
    render(<AuthProvider><Probe /></AuthProvider>)

    // 1s + 2s + 4s of jittered backoff, worst case 1.25 + 2.5 + 5.
    await advance(9_000)
    expect(hoisted.calls).toHaveLength(4)
    expect(state()).toBe('user')
    expect(history.every((h) => h.authError === false)).toBe(true)
  })

  it('publishes retry progress on the shared box while a retry is pending', async () => {
    hoisted.impl = async () => {
      if (hoisted.calls.length === 1) throw new MockApiError(500, 'nope')
      return USER
    }
    let box: { current: { attempt: number; nextRetryAt: number } | null } | null = null
    function Grab() {
      box = useAuth().authProgress as typeof box
      return null
    }
    render(<AuthProvider><Grab /><Probe /></AuthProvider>)

    await advance(0)
    // This is the only channel RequireAuth's LoadingState has; an unwired
    // `progress` option would leave it null here and show a bare spinner.
    expect(box!.current).toMatchObject({ attempt: 1 })

    await advance(1_300)
    // Cleared once the call resolves, so the countdown can't outlive the stall.
    expect(box!.current).toBeNull()
  })

  it('does not retry a 401 — it is an answer, not a stall', async () => {
    hoisted.impl = async () => { throw new MockApiError(401, 'Not authenticated') }
    render(<AuthProvider><Probe /></AuthProvider>)

    await advance(5_000)
    expect(hoisted.calls).toHaveLength(1)
    expect(state()).toBe('anon')
    expect(history.every((h) => h.authError === false)).toBe(true)
  })

  it('still reports a definitive non-401 failure instead of hanging', async () => {
    // 403 is neither retryable nor a logged-out answer.
    hoisted.impl = async () => { throw new MockApiError(403, 'Forbidden') }
    render(<AuthProvider><Probe /></AuthProvider>)

    await advance(5_000)
    expect(hoisted.calls).toHaveLength(1)
    expect(state()).toBe('error')
  })

  it('fires exactly once despite re-renders (the progress box identity is stable)', async () => {
    hoisted.impl = async () => USER
    render(<AuthProvider><Probe /></AuthProvider>)
    await advance(0)
    expect(state()).toBe('user')

    // setSubtitle re-renders the provider. If authProgress were rebuilt each
    // render, the effect's dep array would refire the whole fetch.
    await act(async () => { screen.getByText('rerender').click() })
    await advance(0)
    expect(hoisted.calls).toHaveLength(1)
  })

  it('treats StrictMode\'s aborted first request as cancellation, not failure', async () => {
    hoisted.impl = (_path, init) => new Promise((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      setTimeout(() => resolve(USER), 50)
    })
    render(<StrictMode><AuthProvider><Probe /></AuthProvider></StrictMode>)

    // StrictMode mounts, unmounts, remounts: two requests, the first aborted.
    expect(hoisted.calls).toHaveLength(2)

    await advance(100)
    expect(state()).toBe('user')
    // The abort must never have surfaced as authError, even transiently.
    expect(history.every((h) => h.authError === false)).toBe(true)
  })

  it('abandons the retry loop when the provider unmounts', async () => {
    hoisted.impl = async () => { throw new MockApiError(500, 'nope') }
    const { unmount } = render(<AuthProvider><Probe /></AuthProvider>)
    await advance(0)
    expect(hoisted.calls).toHaveLength(1)

    unmount()
    await advance(30_000)
    // A loop that outlived its component would keep hammering /auth/me forever.
    expect(hoisted.calls).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
