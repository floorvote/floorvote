export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
  }
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  if (res.status === 401) {
    throw new ApiError(res.status, 'unauthorized', 'Session expired')
  }
  if (!res.ok) {
    let body: any
    try { body = await res.json() } catch { body = {} }
    throw new ApiError(res.status, body?.error?.code ?? 'error', body?.error?.message ?? res.statusText)
  }
  const body = await res.json() as { data: T }
  return body.data
}
