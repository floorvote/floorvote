import { redirect } from 'react-router-dom'
import { ApiError } from './api'
import { retryFetch, type RetryOptions } from './retryFetch'

// RR7 data-router loaders run on every navigation regardless of whether a
// parent route element (e.g. RequireAuth) will end up rendering its Outlet —
// so an unauthenticated visit hits the API directly from the loader, well
// before RequireAuth's render-time redirect ever gets a chance to fire. Route
// loaders must call this instead of apiFetch so a 401 becomes a redirect to
// /login rather than an uncaught error bubbling to the router's default
// error boundary.
//
// The actual fetch goes through retryFetch: a 10s-deadline, self-healing
// retry on 5xx/stall (see retryFetch.ts). A 401 is never retried — it is an
// answer, not a stall — so it always surfaces after exactly one attempt.
export async function apiFetchForLoader<T>(path: string, opts?: RetryOptions): Promise<T> {
  try {
    return await retryFetch<T>(path, opts)
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) throw redirect('/login')
    throw err
  }
}

/**
 * How long a route loader may block the router waiting on its own prefetch.
 *
 * Every loader here fetches through retryFetch, which has no attempt cap by
 * design — so awaiting one outright means a stalled backend leaves the loader
 * neither resolving nor rejecting, and the router has nothing to commit. Racing
 * against this deadline turns that into a shell that paints and explains itself.
 *
 * Lives here rather than in either page because both loaders need the same
 * number and neither page should be importing from the other. Comfortably above
 * a healthy load (40-70ms server-side) and below the threshold of noticing.
 */
export const UNBLOCK_AT_MS = 400
