import { TERMS_NOT_ACCEPTED_EVENT } from './appEvents'

const BASE = '/api'

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** The server's machine-readable `code`, when it sent one. */
    public code?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...init.headers,
    },
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string; code?: string }
    if (body.code === 'terms_not_accepted') {
      window.dispatchEvent(new CustomEvent(TERMS_NOT_ACCEPTED_EVENT))
    }
    throw new ApiError(res.status, body.error ?? res.statusText, body.code)
  }

  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}
