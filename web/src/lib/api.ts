import { TERMS_NOT_ACCEPTED_EVENT } from './appEvents'
import { isFacetsPath, isOwnWritePath, needsFreshFacets, noteFreshFacets, noteOwnWrite } from './facetsFreshness'

const BASE = '/api'

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** The server's machine-readable `code`, when it sent one. */
    public code?: string,
    /** The whole error body, for the few callers that read more than `error`. */
    public body?: Record<string, unknown>,
    /** How long the server asked the client to wait before asking again (Retry-After, in seconds), as milliseconds. */
    public retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** The response's Retry-After as milliseconds, when it is a number of seconds (the form the API sends); otherwise undefined. */
function retryAfterMsOf(res: Response): number | undefined {
  const raw = res.headers?.get('Retry-After')
  if (raw == null || !/^\d+$/.test(raw.trim())) return undefined
  return parseInt(raw, 10) * 1000
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase()
  const startedAt = Date.now()
  // After the member's own edit, a facets request the server may have kept from before it asks afresh (./facetsFreshness.ts).
  const fresh = method === 'GET' && isFacetsPath(path) && needsFreshFacets(path, startedAt)
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...init.headers,
      ...(fresh ? { 'Cache-Control': 'no-cache' } : {}),
    },
  })
  if (res.ok) {
    if (fresh) noteFreshFacets(path, startedAt)
    else if (method !== 'GET' && isOwnWritePath(path)) noteOwnWrite()
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string; code?: string }
    if (body.code === 'terms_not_accepted') {
      window.dispatchEvent(new CustomEvent(TERMS_NOT_ACCEPTED_EVENT))
    }
    throw new ApiError(res.status, body.error ?? res.statusText, body.code, body, retryAfterMsOf(res))
  }

  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}
