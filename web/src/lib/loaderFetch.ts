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
