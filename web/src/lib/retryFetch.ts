import { apiFetch, ApiError } from './api'

/**
 * GET-only fetch with a client-side deadline and self-healing retry.
 *
 * The deadline is the point of this module. A stalled backend does not *fail* a
 * request — it *hangs* it, so retry-on-error never fires until the server gives
 * up (30s, in the 2026-08-17 D1 incident). AbortSignal.timeout lets us decide
 * when a request has taken too long instead of inheriting that.
 *
 * GET-only by construction: it takes no RequestInit, so a caller cannot make a
 * POST retryable. Pollers deliberately do NOT use this — they fire again on
 * their own tick, and retrying them would only add load to a struggling backend.
 */

export const REQUEST_DEADLINE_MS = 10_000
const BASE_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 30_000
const JITTER = 0.25

export type RetryProgress = {
  /** 1-based index of the attempt that just failed. */
  attempt: number
  /** Epoch ms at which the next attempt fires. */
  nextRetryAt: number
}

/**
 * A mutable cell the UI reads on its own render tick. Deliberately not an
 * event emitter or context: LoadingState already ticks on its own timer to drive
 * its countdown, so polling a cell is enough and keeps both sides trivial.
 */
export type ProgressBox = { current: RetryProgress | null }

export function createProgressBox(): ProgressBox {
  return { current: null }
}

export type RetryOptions = {
  /** Budget for a single attempt, not for the call as a whole. */
  deadlineMs?: number
  progress?: ProgressBox
  /** Caller cancellation (component unmount). Aborting stops retrying for good. */
  signal?: AbortSignal
}

export function isRetryable(err: unknown): boolean {
  // 5xx only. A 401/403/404/409 is an answer, not a stall.
  if (err instanceof ApiError) return err.status >= 500
  if (typeof err !== 'object' || err === null) return false

  // Classify by name rather than `instanceof`. The reason AbortSignal.timeout
  // aborts with is a DOMException from the platform's own realm, which is not
  // always the realm holding the global DOMException — under jsdom
  // `reason instanceof DOMException` is false for a genuine TimeoutError, and
  // the same is true of anything crossing an iframe boundary. Misclassifying
  // here would rethrow the very deadline this module exists to retry, which is
  // the silent-failure mode the whole design is meant to prevent.
  switch ((err as { name?: unknown }).name) {
    // AbortSignal.timeout fires TimeoutError; some runtimes report AbortError.
    case 'TimeoutError':
    case 'AbortError':
      return true
    // fetch() rejects with TypeError on a network failure.
    case 'TypeError':
      return true
    default:
      return false
  }
}

export function backoffFor(attempt: number, rand: () => number = Math.random): number {
  const base = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS)
  const delta = base * JITTER
  return Math.round(base - delta + rand() * 2 * delta)
}

/**
 * Wait out the backoff, but: don't burn it while the tab is hidden (these are
 * dashboards left open all day — a fleet of background tabs retrying in lockstep
 * is a thundering herd), and cut it short when connectivity returns to a tab
 * that is actually visible.
 *
 * Becoming visible restarts the full delay rather than resuming the remainder.
 * Simpler, and the difference is invisible at these timescales.
 */
function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // An already-aborted signal never fires 'abort', so without this the wait
    // would run to completion and the caller would retry after being cancelled.
    // Redundant with the aborted check in retryFetch, deliberately: either one
    // alone stops the loop, so each looks individually deletable, but dropping
    // both lets a cancelled load retry forever. Keep the pair.
    if (signal?.aborted) { reject(signal.reason); return }

    let timer: ReturnType<typeof setTimeout> | null = null

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', onOnline)
      signal?.removeEventListener('abort', onAbort)
    }
    const done = () => { cleanup(); resolve() }
    // Propagate the caller's own reason — it travels straight out of retryFetch,
    // so inventing a fresh one here would discard whatever they aborted with.
    const onAbort = () => { cleanup(); reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')) }
    // 'online' lands in every background tab at the same instant and skips the
    // jitter, so honouring it while hidden would rebuild the very herd the
    // visibility pause exists to break up. Unhiding starts a fresh delay.
    const onOnline = () => { if (document.visibilityState !== 'hidden') done() }
    const start = () => { timer = setTimeout(done, delayMs) }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (timer) { clearTimeout(timer); timer = null }
      } else if (!timer) {
        start()
      }
    }

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onOnline)
    signal?.addEventListener('abort', onAbort)
    if (document.visibilityState !== 'hidden') start()
  })
}

/** Short label for the retry log — the error name, or the status for an ApiError. */
function errorLabel(err: unknown): string {
  if (err instanceof ApiError) return `ApiError ${err.status}`
  const name = (err as { name?: unknown } | null)?.name
  return typeof name === 'string' ? name : typeof err
}

/**
 * GET `path`, retrying until it succeeds or the caller aborts.
 *
 * There is deliberately no attempt cap: a stalled backend recovers on its own,
 * and giving up is what produced the dead-end error card this module exists to
 * replace. The corollary is that cancellation is the caller's job — pass
 * `signal` and abort it on unmount, or the loop outlives the component.
 *
 * `deadlineMs` bounds a single attempt, not the call as a whole; total time is
 * unbounded by design.
 */
export async function retryFetch<T>(path: string, opts: RetryOptions = {}): Promise<T> {
  const { deadlineMs = REQUEST_DEADLINE_MS, progress, signal } = opts

  try {
    for (let attempt = 1; ; attempt++) {
      try {
        const deadline = AbortSignal.timeout(deadlineMs)
        const combined = signal ? AbortSignal.any([deadline, signal]) : deadline
        return await apiFetch<T>(path, { signal: combined })
      } catch (err) {
        // Cancellation, not a stall. An abort landing mid-request surfaces as
        // an AbortError, which isRetryable deliberately treats as retryable, so
        // without this the loop would keep going behind an unmounted component.
        // Backstopped by the same check in waitForRetry — keep both.
        if (signal?.aborted) throw err
        if (!isRetryable(err)) throw err
        const delay = backoffFor(attempt)
        // The only trace a forever-retrying load leaves. Without it a stall in
        // the field is invisible, which is the failure mode this module fixes.
        console.warn(`[retryFetch] ${path} attempt ${attempt} failed (${errorLabel(err)}), retrying in ${delay}ms`)
        if (progress) progress.current = { attempt, nextRetryAt: Date.now() + delay }
        await waitForRetry(delay, signal)
      }
    }
  } finally {
    // Every exit that is not a scheduled retry — success, non-retryable throw,
    // caller abort — leaves nothing pending, and the box must not claim
    // otherwise: its contract is "a retry is coming", and a stale entry makes
    // the UI count down to a retry that will never fire.
    if (progress) progress.current = null
  }
}
