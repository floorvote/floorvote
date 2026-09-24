import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rateLimitedFetch } from '../../src/lib/rateLimitedFetch'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// Buckets are module-level and keyed by rate (see rateLimitedFetch.ts), so each
// test uses a rate no other test uses. Otherwise a bucket drained — or a
// lastRefillMs stamped under a different fake clock — leaks across tests.
beforeEach(() => {
  mockFetch.mockReset()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

function ok(body = 'ok') {
  return new Response(body, { status: 200 })
}

function tooMany(headers: Record<string, string> = {}) {
  return new Response('rate limited', { status: 429, headers })
}

describe('rateLimitedFetch pacing', () => {
  it('paces concurrent calls at the configured rate', async () => {
    mockFetch.mockResolvedValue(ok())

    // 2/sec => one call immediately, the rest 500ms apart.
    const calls = [
      rateLimitedFetch('https://x.test/1', undefined, { ratePerSec: 2 }),
      rateLimitedFetch('https://x.test/2', undefined, { ratePerSec: 2 }),
      rateLimitedFetch('https://x.test/3', undefined, { ratePerSec: 2 }),
    ]

    await vi.advanceTimersByTimeAsync(0)
    expect(mockFetch).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(500)
    expect(mockFetch).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(500)
    expect(mockFetch).toHaveBeenCalledTimes(3)

    await Promise.all(calls)
  })

  it('does not delay a single call when the bucket is full', async () => {
    mockFetch.mockResolvedValue(ok())

    const res = await rateLimitedFetch('https://x.test/solo', undefined, { ratePerSec: 3 })

    expect(res.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})

describe('rateLimitedFetch 429 handling', () => {
  it('honors Retry-After when present', async () => {
    mockFetch
      .mockResolvedValueOnce(tooMany({ 'Retry-After': '7' }))
      .mockResolvedValueOnce(ok('after retry'))

    const promise = rateLimitedFetch('https://x.test/ra', undefined, { ratePerSec: 5 })

    await vi.advanceTimersByTimeAsync(0)
    expect(mockFetch).toHaveBeenCalledTimes(1)

    // Retry-After (7s) is used rather than the 2000ms first fallback.
    await vi.advanceTimersByTimeAsync(2000)
    expect(mockFetch).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5000)
    const res = await promise
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(await res.text()).toBe('after retry')
  })

  it('escalates through the fallback delays when Retry-After is absent', async () => {
    mockFetch
      .mockResolvedValueOnce(tooMany())
      .mockResolvedValueOnce(tooMany())
      .mockResolvedValueOnce(tooMany())
      .mockResolvedValueOnce(ok('finally'))

    const promise = rateLimitedFetch('https://x.test/fallback', undefined, { ratePerSec: 7 })

    await vi.advanceTimersByTimeAsync(0)
    expect(mockFetch).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(2000)
    expect(mockFetch).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(5000)
    expect(mockFetch).toHaveBeenCalledTimes(3)

    await vi.advanceTimersByTimeAsync(10000)
    const res = await promise
    expect(mockFetch).toHaveBeenCalledTimes(4)
    expect(await res.text()).toBe('finally')
  })

  it('throws once retries are exhausted', async () => {
    mockFetch.mockResolvedValue(tooMany())

    const promise = rateLimitedFetch('https://x.test/giveup', undefined, {
      ratePerSec: 11,
      maxRetries: 2,
    })
    const assertion = expect(promise).rejects.toThrow(/429/)

    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)
    await assertion

    // Initial attempt + 2 retries.
    expect(mockFetch).toHaveBeenCalledTimes(3)
  })

  it('passes a successful response through untouched', async () => {
    const body = JSON.stringify({ status: 'OK' })
    mockFetch.mockResolvedValue(new Response(body, { status: 200, headers: { 'X-Test': 'yes' } }))

    const res = await rateLimitedFetch('https://x.test/pass', undefined, { ratePerSec: 13 })

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Test')).toBe('yes')
    expect(await res.text()).toBe(body)
  })

  it('passes non-429 error responses through without retrying', async () => {
    mockFetch.mockResolvedValue(new Response('nope', { status: 500 }))

    const res = await rateLimitedFetch('https://x.test/500', undefined, { ratePerSec: 17 })

    expect(res.status).toBe(500)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})
