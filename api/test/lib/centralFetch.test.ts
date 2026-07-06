import { describe, it, expect, vi, afterEach } from 'vitest'
import { centralFetch } from '../../src/lib/centralFetch'
import type { Env } from '../../src/types'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('centralFetch', () => {
  it('does NOT attach x-admin-secret on the service-binding path', async () => {
    let captured: Request | undefined
    const env = {
      CENTRAL: {
        fetch: (req: Request) => {
          captured = req
          return Promise.resolve(new Response('ok'))
        },
      },
      CENTRAL_ADMIN_SECRET: 'should-not-be-sent',
      CENTRAL_API_URL: 'http://unused',
    } as unknown as Env

    await centralFetch(env, '/tenants/seed-session/ri', { method: 'POST' })

    expect(captured).toBeDefined()
    expect(captured!.headers.get('x-admin-secret')).toBeNull()
    // Machine API now lives under /api/* on central (callers still pass the bare path).
    expect(new URL(captured!.url).pathname).toBe('/api/tenants/seed-session/ri')
  })

  it('attaches x-admin-secret on the HTTP fallback path (local dev, no binding)', async () => {
    let capturedInit: RequestInit | undefined
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      capturedInit = init
      return Promise.resolve(new Response('ok'))
    })
    vi.stubGlobal('fetch', fetchMock)

    const env = {
      CENTRAL: undefined,
      CENTRAL_ADMIN_SECRET: 'local-secret',
      CENTRAL_API_URL: 'http://localhost:8788',
    } as unknown as Env

    await centralFetch(env, '/bills/abc', { method: 'GET' })

    const headers = capturedInit?.headers as Record<string, string>
    expect(headers['x-admin-secret']).toBe('local-secret')
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:8788/api/bills/abc', expect.anything())
  })
})
