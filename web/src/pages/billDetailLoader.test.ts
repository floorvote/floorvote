import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as api from '../lib/api'
import { billDetailLoader } from './BillDetail'

const BILL = { id: '42', state: 'RI', session: '2025-2026', billNumber: 'HB 1', title: 'Test' }

function loaderArgs(params: Record<string, string | undefined>, url: string) {
  // Minimal LoaderFunctionArgs shape the loader actually reads.
  return { params, request: new Request(url), context: {} } as never
}

beforeEach(() => { vi.restoreAllMocks() })

describe('billDetailLoader', () => {
  it('returns the bill (no redirect) when arriving on the canonical URL', async () => {
    const spy = vi.spyOn(api, 'apiFetch').mockResolvedValue(BILL as never)
    const result = await billDetailLoader(
      loaderArgs({ state: 'RI', sessionSlug: '2025-2026', billNumber: 'HB 1' }, 'http://localhost/RI/2025-2026/HB%201'),
    )
    expect(result).toEqual(BILL)
    expect(spy.mock.calls[0][0]).toBe('/bills/resolve/RI/2025-2026/HB 1')
    // The loader fetches through apiFetchForLoader → retryFetch, which hands
    // apiFetch a signal (the 10s deadline, combined with the loader's own).
    // A bare apiFetch call would pass no init at all.
    expect(spy.mock.calls[0][1]?.signal).toBeTruthy()
  })

  it('redirects /bills/:id to the canonical URL', async () => {
    vi.spyOn(api, 'apiFetch').mockResolvedValue(BILL as never)
    const result = await billDetailLoader(loaderArgs({ billId: '42' }, 'http://localhost/bills/42'))
    expect(result).toBeInstanceOf(Response)
    const res = result as Response
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/RI/2025-2026/HB 1')
  })

  it('redirects a legacy /:session/:billNumber URL to the canonical URL', async () => {
    vi.spyOn(api, 'apiFetch').mockResolvedValue(BILL as never)
    const result = await billDetailLoader(
      loaderArgs({ sessionSlug: '2025-2026', billNumber: 'HB 1' }, 'http://localhost/2025-2026/HB%201'),
    )
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).headers.get('Location')).toBe('/RI/2025-2026/HB 1')
  })

  it('throws a 409 Response when the legacy bill number is ambiguous', async () => {
    vi.spyOn(api, 'apiFetch').mockRejectedValue(new api.ApiError(409, 'ambiguous'))
    await expect(
      billDetailLoader(loaderArgs({ sessionSlug: '2025-2026', billNumber: 'HB 1' }, 'http://localhost/2025-2026/HB%201')),
    ).rejects.toMatchObject({ status: 409 })
  })

  // Before this branch existed, a 404 fell into the generic 500 alongside a dead
  // backend, so a URL naming no bill and a bill service that is down were reported
  // identically — and both as "Failed to load bill." The SPA's not-found handling
  // makes that reachable from any mistyped path: `/api/calendar/ics` matches the
  // three-segment bill route, so a dead link anywhere in the app became a support
  // question about a missing bill.
  it('throws a 404 Response when the bill does not exist', async () => {
    vi.spyOn(api, 'apiFetch').mockRejectedValue(new api.ApiError(404, 'Not found'))
    await expect(
      billDetailLoader(loaderArgs({ state: 'RI', sessionSlug: '2025-2026', billNumber: 'HB 9999' }, 'http://localhost/RI/2025-2026/HB%209999')),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('reports a non-bill path that merely matches the route shape as a 404', async () => {
    vi.spyOn(api, 'apiFetch').mockRejectedValue(new api.ApiError(404, 'Not found'))
    await expect(
      billDetailLoader(loaderArgs({ state: 'api', sessionSlug: 'calendar', billNumber: 'ics' }, 'http://localhost/api/calendar/ics')),
    ).rejects.toMatchObject({ status: 404 })
  })

  // A 401 no longer reaches the catch as an ApiError: apiFetchForLoader has
  // already converted it into a thrown redirect('/login'), which is a Response.
  // Without the `err instanceof Response` re-throw it falls past both ApiError
  // checks into the generic 500, turning an expired session into an error card
  // that no amount of retrying can clear.
  it('re-throws the /login redirect on 401 rather than reclassifying it as a 500', async () => {
    vi.spyOn(api, 'apiFetch').mockRejectedValue(new api.ApiError(401, 'Not authenticated'))
    const thrown = await billDetailLoader(
      loaderArgs({ state: 'RI', sessionSlug: '2025-2026', billNumber: 'HB 1' }, 'http://localhost/RI/2025-2026/HB%201'),
    ).then(() => null, (err: unknown) => err)
    expect(thrown).toBeInstanceOf(Response)
    expect((thrown as Response).status).toBe(302)
    expect((thrown as Response).headers.get('Location')).toBe('/login')
  })

  // The mirror of the test above: the Response re-throw must not swallow
  // everything else into a silent pass-through.
  //
  // Was a 404 until 404 became a classified status of its own; 400 stands in for
  // "unrecognized" now. Deliberately not a 5xx — retryFetch retries those against
  // a 10s deadline, so a 503 would spend ten seconds proving nothing.
  it('still surfaces an unrecognized failure as a 500', async () => {
    vi.spyOn(api, 'apiFetch').mockRejectedValue(new api.ApiError(400, 'bad request'))
    await expect(
      billDetailLoader(loaderArgs({ billId: '42' }, 'http://localhost/bills/42')),
    ).rejects.toMatchObject({ status: 500 })
  })
})
