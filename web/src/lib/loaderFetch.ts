import { redirect } from 'react-router-dom'
import { apiFetch, ApiError } from './api'

// RR7 data-router loaders run on every navigation regardless of whether a
// parent route element (e.g. RequireAuth) will end up rendering its Outlet —
// so an unauthenticated visit hits the API directly from the loader, well
// before RequireAuth's render-time redirect ever gets a chance to fire. Route
// loaders must call this instead of apiFetch so a 401 becomes a redirect to
// /login rather than an uncaught error bubbling to the router's default
// error boundary.
export async function apiFetchForLoader<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    return await apiFetch<T>(path, init)
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) throw redirect('/login')
    throw err
  }
}
