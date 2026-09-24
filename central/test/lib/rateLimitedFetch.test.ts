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

// Regression cover for the api_call_log egress bug: call sites used to log
// LegiScan usage *before* awaiting the request, so `logged_at` recorded intent
// rather than egress — the cron's Promise.allSettled fan-out stamped every row
// in the same instant while the real requests went out ~667ms apart, and a call
// that threw before reaching the wire was counted anyway. The callback below is
// what those call sites now log from, so it has to fire at the wire, once per
// attempt.
describe('rateLimitedFetch onRequest', () => {
  it('fires after the request goes out, not before', async () => {
    const order: string[] = []
    mockFetch.mockImplementation(() => {
      order.push('fetch')
      return Promise.resolve(ok())
    })

    await rateLimitedFetch('https://x.test/order', undefined, {
      ratePerSec: 19,
      onRequest: () => order.push('onRequest'),
    })

    expect(order).toEqual(['fetch', 'onRequest'])
  })

  it('does not fire when pacing delays a request that has not gone out yet', async () => {
    mockFetch.mockResolvedValue(ok())
    const onRequest = vi.fn()

    // 2/sec at this rate: the second call waits ~500ms for a token. Until its
    // fetch actually happens, nothing may be logged for it.
    const calls = [
      rateLimitedFetch('https://x.test/p1', undefined, { ratePerSec: 2.5, onRequest }),
      rateLimitedFetch('https://x.test/p2', undefined, { ratePerSec: 2.5, onRequest }),
    ]

    await vi.advanceTimersByTimeAsync(0)
    expect(onRequest).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(400)
    expect(onRequest).toHaveBeenCalledTimes(2)

    await Promise.all(calls)
  })

  it('fires once per attempt, including 429s that get retried', async () => {
    mockFetch
      .mockResolvedValueOnce(tooMany())
      .mockResolvedValueOnce(tooMany())
      .mockResolvedValueOnce(ok('finally'))
    const onRequest = vi.fn()

    const promise = rateLimitedFetch('https://x.test/retries', undefined, {
      ratePerSec: 23,
      onRequest,
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(onRequest).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(2000)
    expect(onRequest).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(5000)
    await promise
    expect(onRequest).toHaveBeenCalledTimes(3)
  })

  it('fires on every attempt when retries are exhausted and the call throws', async () => {
    mockFetch.mockResolvedValue(tooMany())
    const onRequest = vi.fn()

    const promise = rateLimitedFetch('https://x.test/exhausted', undefined, {
      ratePerSec: 29,
      maxRetries: 2,
      onRequest,
    })
    const assertion = expect(promise).rejects.toThrow(/429/)

    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)
    await assertion

    // Initial attempt + 2 retries, all of them real outbound requests.
    expect(onRequest).toHaveBeenCalledTimes(3)
  })

  it('fires on a non-429 error response', async () => {
    mockFetch.mockResolvedValue(new Response('nope', { status: 500 }))
    const onRequest = vi.fn()

    const res = await rateLimitedFetch('https://x.test/err', undefined, {
      ratePerSec: 31,
      onRequest,
    })

    expect(res.status).toBe(500)
    expect(onRequest).toHaveBeenCalledTimes(1)
  })

  it('does not fire when the request itself throws before reaching the wire', async () => {
    mockFetch.mockRejectedValue(new Error('network down'))
    const onRequest = vi.fn()

    await expect(
      rateLimitedFetch('https://x.test/down', undefined, { ratePerSec: 37, onRequest }),
    ).rejects.toThrow(/network down/)

    expect(onRequest).not.toHaveBeenCalled()
  })

  it('swallows a throwing callback rather than failing the request', async () => {
    mockFetch.mockResolvedValue(ok('still fine'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await rateLimitedFetch('https://x.test/throws', undefined, {
      ratePerSec: 41,
      onRequest: () => { throw new Error('logging blew up') },
    })

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('still fine')
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})
