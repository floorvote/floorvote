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
    expect(spy).toHaveBeenCalledWith('/bills/resolve/RI/2025-2026/HB 1')
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
})
