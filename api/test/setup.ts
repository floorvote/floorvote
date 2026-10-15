// Runs before every test file (vitest `setupFiles`). Two guarantees, so a green
// run means what it appears to:
//
//   1. No test reaches the network by accident. `fetch` is replaced with a guard
//      that refuses the request and fails the test, naming the URL. A test that
//      needs a response stubs `fetch` itself, as before (`vi.stubGlobal`,
//      `vi.spyOn(globalThis, 'fetch')`, or `stubFetch` in test/helpers.ts); that
//      stub wins over the guard.
//
//   2. No unhandled rejection goes unnoticed. Vitest already fails the run for a
//      rejection raised in the test realm. The gap is background work started
//      with `ctx.waitUntil`: workerd logs a rejected waitUntil promise to stderr
//      and never raises it as an unhandled rejection. Tests that start such work
//      drain it with `appFetch` in test/helpers.ts, which rethrows the failure.
//
// This hook is the idiomatic one for @cloudflare/vitest-pool-workers 0.16: the
// pool no longer ships `fetchMock`, and miniflare's `outboundService` runs in
// the Node process, where it can neither name the failing test nor be overridden
// by a per-test stub.
import { beforeEach, afterEach, afterAll } from 'vitest'
import { networkGuard, takeBlockedRequests } from './networkGuard'

beforeEach(() => {
  // A plain assignment rather than vi.stubGlobal, so a test's own
  // vi.unstubAllGlobals() falls back to this guard instead of removing it. It
  // runs before each test, so a stub or spy a test leaves behind never leaks
  // into the next one.
  globalThis.fetch = networkGuard
})

function failIfBlocked(): void {
  const requests = takeBlockedRequests()
  if (requests.length === 0) return
  // The caller of fetch may catch and log the guard's error (production code
  // does this on purpose for email and central calls), so the throw alone
  // would not fail the test. Failing here does.
  throw new Error(
    `A test reached the network without stubbing fetch (during it, or in background work it started):\n  ${requests.join('\n  ')}`,
  )
}

afterEach(failIfBlocked)
afterAll(failIfBlocked)
