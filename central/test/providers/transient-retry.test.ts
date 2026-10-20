import { describe, it, expect, vi, beforeEach } from 'vitest'

// The snapshot reads of the providers whose hourly sync alerts on a failed
// pass ask rateLimitedFetch to retry a transient failure once
// (RateLimitedFetchOptions.retryTransient), so one dropped connection or 5xx
// doesn't fail the hour. rateLimitedFetch's own tests cover the retry.
const seen: { url: string; retryTransient?: boolean }[] = []
vi.mock('../../src/lib/rateLimitedFetch', () => ({
  rateLimitedFetch: async (url: string, _init: RequestInit | undefined, opts: { retryTransient?: boolean }) => {
    seen.push({ url, retryTransient: opts.retryTransient })
    return new Response('[]', { status: 200, headers: { 'Content-Length': '3' } })
  },
}))

import { getMgaSession } from '../../src/providers/mga/client'
import { getBulkData } from '../../src/providers/lims/client'
import { getLisFile } from '../../src/providers/lis/client'

beforeEach(() => { seen.length = 0 })

describe('a provider snapshot read', () => {
  it.each([
    ['MGA', () => getMgaSession('2026RS')],
    ['LIMS', () => getBulkData(1, 26, 'key')],
    ['LIS', () => getLisFile('20261', 'bills').catch(() => null)],
  ])('%s retries a transient failure once', async (_name, read) => {
    await read()
    expect(seen.length).toBeGreaterThan(0)
    for (const call of seen) expect(call.retryTransient, call.url).toBe(true)
  })
})
