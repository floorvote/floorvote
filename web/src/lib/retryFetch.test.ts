import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'

const calls: string[] = []
let responder: (signal?: AbortSignal) => Promise<unknown> = async () => ({ ok: true })

vi.mock('./api', () => {
  class ApiError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
      this.name = 'ApiError'
    }
  }
  return {
    ApiError,
    // Hands the signal to the responder so a test can model a request that
    // hangs until the deadline aborts it, the way a stalled backend behaves.
    apiFetch: async (path: string, init?: RequestInit) => {
      calls.push(path)
      return responder(init?.signal ?? undefined)
    },
  }
})

import { retryFetch, backoffFor, createProgressBox, isRetryable } from './retryFetch'
import { ApiError } from './api'

/**
 * Some tests below drive a responder that never succeeds, so their retry loop
 * runs forever by design. Left alone it outlives the test with its
 * visibilitychange/online listeners still attached, and a later test's
 * dispatchEvent would wake it and push extra entries into `calls`. Register the
 * controller so afterEach can stop the loop and unhook its listeners.
 */
const openLoops: AbortController[] = []
function runForever(path: string): Promise<unknown> {
  const controller = new AbortController()
  openLoops.push(controller)
  return retryFetch(path, { signal: controller.signal }).catch(() => 'stopped')
}

/** Retries log a warning; keep it out of the suite output but assertable. */
let warnSpy: MockInstance<typeof console.warn>

beforeEach(() => {
  calls.length = 0
  responder = async () => ({ ok: true })
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.useFakeTimers()
})
afterEach(() => {
  openLoops.forEach((c) => c.abort())
  openLoops.length = 0
  warnSpy.mockRestore()
  vi.useRealTimers()
})

describe('isRetryable', () => {
  it('retries 5xx but not 4xx', () => {
    expect(isRetryable(new ApiError(500, 'boom'))).toBe(true)
    expect(isRetryable(new ApiError(503, 'boom'))).toBe(true)
    expect(isRetryable(new ApiError(401, 'nope'))).toBe(false)
    expect(isRetryable(new ApiError(404, 'nope'))).toBe(false)
    expect(isRetryable(new ApiError(409, 'nope'))).toBe(false)
  })

  it('retries deadline timeouts and network failures', () => {
    expect(isRetryable(new DOMException('t', 'TimeoutError'))).toBe(true)
    expect(isRetryable(new TypeError('Failed to fetch'))).toBe(true)
  })

  it('retries an AbortError, which some runtimes report instead of TimeoutError', () => {
    expect(isRetryable(new DOMException('stopped', 'AbortError'))).toBe(true)
  })

  it('does not retry a non-object rejection', () => {
    expect(isRetryable(null)).toBe(false)
    expect(isRetryable(undefined)).toBe(false)
    expect(isRetryable('boom')).toBe(false)
    expect(isRetryable(500)).toBe(false)
  })

  it('does not retry a plain Error', () => {
    expect(isRetryable(new Error('mock blew up'))).toBe(false)
  })
})

describe('backoffFor', () => {
  it('doubles per attempt and caps at 30s', () => {
    expect(backoffFor(1, () => 0.5)).toBe(1000)
    expect(backoffFor(2, () => 0.5)).toBe(2000)
    expect(backoffFor(3, () => 0.5)).toBe(4000)
    expect(backoffFor(99, () => 0.5)).toBe(30000)
  })

  it('applies +/-25% jitter', () => {
    expect(backoffFor(1, () => 0)).toBe(750)
    expect(backoffFor(1, () => 1)).toBe(1250)
  })
})

describe('retryFetch', () => {
  it('returns the first successful response without retrying', async () => {
    await expect(retryFetch('/feed')).resolves.toEqual({ ok: true })
    expect(calls).toEqual(['/feed'])
  })

  it('rethrows a non-retryable error immediately', async () => {
    responder = async () => { throw new ApiError(401, 'Not authenticated') }
    await expect(retryFetch('/auth/me')).rejects.toMatchObject({ status: 401 })
    expect(calls).toHaveLength(1)
  })

  it('retries a 5xx and records progress, then succeeds', async () => {
    let n = 0
    responder = async () => {
      n += 1
      if (n === 1) throw new ApiError(500, 'internal_error')
      return { ok: true }
    }
    const progress = createProgressBox()
    const t0 = Date.now()
    const p = retryFetch('/feed', { progress })
    await vi.advanceTimersByTimeAsync(0)
    expect(progress.current?.attempt).toBe(1)
    // Task 2's countdown renders this value, so pin it: 1s base, +/-25% jitter.
    expect(progress.current?.nextRetryAt).toBeGreaterThanOrEqual(t0 + 750)
    expect(progress.current?.nextRetryAt).toBeLessThanOrEqual(t0 + 1250)
    // Still counting down partway through the wait.
    await vi.advanceTimersByTimeAsync(500)
    expect(progress.current).not.toBeNull()
    await vi.advanceTimersByTimeAsync(800)
    await expect(p).resolves.toEqual({ ok: true })
    expect(calls).toHaveLength(2)
    // No retry is pending once it succeeds.
    expect(progress.current).toBeNull()
  })

  /**
   * The box must stay populated for the whole retry cycle, including while the
   * next attempt is actually in flight. Clearing it per-iteration instead of on
   * exit would make Task 2's countdown appear during backoff waits and vanish
   * for the duration of every attempt — up to the full deadline.
   */
  it('keeps progress set while the retry attempt is in flight', async () => {
    let release: (v: { ok: boolean }) => void = () => {}
    let n = 0
    responder = () => {
      n += 1
      if (n === 1) return Promise.reject(new ApiError(500, 'internal_error'))
      // Attempt 2 stays pending until the test releases it.
      return new Promise<{ ok: boolean }>((resolve) => { release = resolve })
    }
    const progress = createProgressBox()
    const p = retryFetch('/feed', { progress })
    await vi.advanceTimersByTimeAsync(0)
    expect(progress.current?.attempt).toBe(1)
    // Past the longest possible backoff: attempt 2 is now in flight, unanswered.
    await vi.advanceTimersByTimeAsync(1300)
    expect(calls).toHaveLength(2)
    expect(progress.current).not.toBeNull()
    release({ ok: true })
    await expect(p).resolves.toEqual({ ok: true })
    expect(progress.current).toBeNull()
  })

  /**
   * The AuthContext case: one box lives for the provider's lifetime, so a
   * populated box left behind by a retryable failure would have the UI counting
   * down to a retry that will never happen.
   */
  it('clears progress when a retry sequence ends in a non-retryable error', async () => {
    let n = 0
    responder = async () => {
      n += 1
      if (n === 1) throw new ApiError(500, 'internal_error')
      throw new ApiError(401, 'Not authenticated')
    }
    const progress = createProgressBox()
    // Capture the rejection up front: it lands mid-advanceTimers, and a handler
    // attached afterwards would be too late to stop an unhandled rejection.
    let caught: unknown
    const p = retryFetch('/auth/me', { progress }).catch((e: unknown) => { caught = e })
    await vi.advanceTimersByTimeAsync(0)
    expect(progress.current?.attempt).toBe(1)
    await vi.advanceTimersByTimeAsync(1300)
    await p
    expect(caught).toMatchObject({ status: 401 })
    expect(progress.current).toBeNull()
  })

  it('logs each retry with the path, attempt, and error label', async () => {
    let n = 0
    responder = async () => {
      n += 1
      if (n === 1) throw new ApiError(503, 'unavailable')
      return { ok: true }
    }
    const p = retryFetch('/feed')
    await vi.advanceTimersByTimeAsync(1300)
    await expect(p).resolves.toEqual({ ok: true })
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const msg = String(warnSpy.mock.calls[0]?.[0])
    expect(msg).toContain('/feed')
    expect(msg).toContain('attempt 1')
    expect(msg).toContain('ApiError 503')
  })

  it('does not schedule a retry while the tab is hidden', async () => {
    responder = async () => { throw new ApiError(500, 'internal_error') }
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const p = runForever('/feed')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toHaveLength(1)
    spy.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(1300)
    expect(calls).toHaveLength(2)
    spy.mockRestore()
    void p
  })

  /**
   * 'online' reaches every background tab at the same instant, so obeying it
   * while hidden would bypass the jitter and rebuild the herd the visibility
   * pause exists to break up.
   */
  it('ignores an online event while the tab is hidden', async () => {
    responder = async () => { throw new TypeError('Failed to fetch') }
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const p = runForever('/feed')
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)
    spy.mockRestore()
    void p
  })

  it('retries immediately when the browser comes back online', async () => {
    responder = async () => { throw new TypeError('Failed to fetch') }
    const p = runForever('/feed')
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(2)
    void p
  })

  /**
   * The reason this module exists: a stalled backend does not fail a request,
   * it hangs it, so retry-on-error alone would never fire. Real timers here —
   * AbortSignal.timeout runs off a platform timer that fake timers do not
   * patch — with a 20ms deadline to keep the wait short.
   */
  it('abandons a hung request at the deadline and retries', async () => {
    vi.useRealTimers()
    let n = 0
    responder = (signal?: AbortSignal) => {
      n += 1
      if (n === 1) {
        // Never settles on its own; only the deadline can end it.
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason))
        })
      }
      return Promise.resolve({ ok: true })
    }
    await expect(retryFetch('/feed', { deadlineMs: 20 })).resolves.toEqual({ ok: true })
    expect(calls).toHaveLength(2)
  })

  it('stops when the caller aborts', async () => {
    responder = async () => { throw new ApiError(500, 'internal_error') }
    const controller = new AbortController()
    const progress = createProgressBox()
    const p = retryFetch('/feed', { signal: controller.signal, progress })
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await expect(p).rejects.toThrow()
    const seen = calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toHaveLength(seen)
    // Cancelled means no retry is coming, so the box must not still claim one.
    expect(progress.current).toBeNull()
  })

  /**
   * The unmount case, and the module's worst failure mode: an abort landing
   * while apiFetch is pending surfaces as an AbortError, which isRetryable
   * classifies as retryable. Without the aborted-signal guards the loop would
   * treat cancellation as a stall and retry forever behind a dead component.
   * Real timers, because the abort has to interrupt a genuinely pending request.
   */
  it('stops when the caller aborts an in-flight request', async () => {
    vi.useRealTimers()
    responder = (signal?: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason))
      })
    const controller = new AbortController()
    const p = retryFetch('/feed', { signal: controller.signal })
    await new Promise((r) => setTimeout(r, 10))
    controller.abort()
    await expect(p).rejects.toThrow()
    const seen = calls.length
    await new Promise((r) => setTimeout(r, 1500))
    expect(calls).toHaveLength(seen)
  }, 4000)

  it('rejects with the reason the caller aborted with', async () => {
    responder = async () => { throw new ApiError(500, 'internal_error') }
    const controller = new AbortController()
    const reason = new Error('unmounted')
    const p = retryFetch('/feed', { signal: controller.signal })
    await vi.advanceTimersByTimeAsync(0)
    controller.abort(reason)
    await expect(p).rejects.toBe(reason)
  })
})
