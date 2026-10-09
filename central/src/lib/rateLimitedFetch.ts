/**
 * Provider-agnostic client-side rate limiting + 429 retry for outbound API calls.
 *
 * Motivation: LegiScan introduces a ~2 requests/second sliding-window limit on
 * October 1, 2026. We pace below it (1.5 req/sec) for headroom rather than
 * discovering the limit through 429s.
 *
 * Deliberately dumb about response shapes. It returns the raw `Response` and
 * lets the caller parse and decide what counts as an error, because providers
 * disagree: LegiScan answers HTTP 200 with an error body, while other APIs
 * signal errors through the status code. Baking either convention in here
 * would force the other to work around it.
 *
 * Scope note: the token bucket is per-isolate and in-memory, keyed by
 * `bucketKey` (by default, the rate). A cron invocation and a queue-consumer
 * invocation run in different isolates and
 * therefore hold independent buckets, so the aggregate outbound rate can exceed
 * `ratePerSec` across invocations. The bucket smooths the common case (a burst
 * inside one invocation, e.g. the cron's `Promise.allSettled` fan-out); the 429
 * retry below is what covers the aggregate case.
 */

/** Escalating fallback waits, used when a 429 carries no usable `Retry-After`. */
const RETRY_DELAYS_MS = [2000, 5000, 10000]

export interface RateLimitedFetchOptions {
  /** Sustained outbound request rate, in requests per second. */
  ratePerSec: number
  /**
   * Which bucket to pace against. Defaults to the rate, so every caller at the
   * same rate shares one bucket. A provider passes its id, so two providers
   * that happen to share a rate are paced separately.
   */
  bucketKey?: string
  /** Max 429 retries. Defaults to the number of fallback delays (3). */
  maxRetries?: number
  /**
   * Called once per outbound HTTP attempt, immediately after `fetch` resolves
   * — including attempts that come back 429 and get retried, and regardless of
   * status. This is the hook quota logging hangs off of: it fires at egress
   * time, not at intent time, so a caller that never reaches the wire is never
   * counted. Throws are swallowed; a broken callback must not break a request.
   */
  onRequest?: () => void
}

interface TokenBucket {
  /** Available tokens, fractional; refilled at `ratePerSec` per second. */
  tokens: number
  /** Timestamp of the last refill. */
  lastRefillMs: number
}

/** Per-isolate, in-memory buckets by key. See the scope note above. */
const buckets = new Map<string, TokenBucket>()

/**
 * Serializes bucket acquisition per bucket. Without this, concurrent callers all
 * read the same `tokens` value before any of them decrements it, and the burst
 * goes out unpaced — which is exactly the cron fan-out case.
 */
const acquireChains = new Map<string, Promise<void>>()

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** Burst capacity. One token: strict pacing, no saved-up burst. */
const BUCKET_CAPACITY = 1

async function takeToken(key: string, ratePerSec: number): Promise<void> {
  let bucket = buckets.get(key)
  if (!bucket) {
    bucket = { tokens: BUCKET_CAPACITY, lastRefillMs: Date.now() }
    buckets.set(key, bucket)
  }

  const now = Date.now()
  const elapsedMs = Math.max(0, now - bucket.lastRefillMs)
  bucket.tokens = Math.min(BUCKET_CAPACITY, bucket.tokens + (elapsedMs / 1000) * ratePerSec)
  bucket.lastRefillMs = now

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1
    return
  }

  const waitMs = Math.ceil(((1 - bucket.tokens) / ratePerSec) * 1000)
  await sleep(waitMs)
  bucket.tokens = 0
  bucket.lastRefillMs = Date.now()
}

/** Queues token acquisition so concurrent callers are paced, not batched. */
function acquire(key: string, ratePerSec: number): Promise<void> {
  const prior = acquireChains.get(key) ?? Promise.resolve()
  const next = prior.then(() => takeToken(key, ratePerSec), () => takeToken(key, ratePerSec))
  acquireChains.set(key, next.catch(() => {}))
  return next
}

/**
 * `fetch`, paced at `ratePerSec` and retried on HTTP 429.
 *
 * Honors `Retry-After` (seconds) when present, otherwise escalates through
 * RETRY_DELAYS_MS. Throws once retries are exhausted; every other response,
 * success or failure, is returned untouched for the caller to interpret.
 */
export async function rateLimitedFetch(
  url: string,
  init: RequestInit | undefined,
  opts: RateLimitedFetchOptions,
): Promise<Response> {
  const { ratePerSec, onRequest } = opts
  const bucketKey = opts.bucketKey ?? `rate:${ratePerSec}`
  const maxRetries = opts.maxRetries ?? RETRY_DELAYS_MS.length

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await acquire(bucketKey, ratePerSec)
    const res = await fetch(url, init)
    if (onRequest) {
      try {
        onRequest()
      } catch (err) {
        console.error('[rateLimitedFetch] onRequest callback threw:', err)
      }
    }

    if (res.status !== 429) return res

    if (attempt >= maxRetries) {
      throw new Error(`Rate limited (429): giving up after ${attempt} retries`)
    }

    const fallback = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]
    const retryAfter = res.headers.get('Retry-After')
    const parsed = retryAfter ? parseInt(retryAfter, 10) : NaN
    const waitMs = Number.isFinite(parsed) ? parsed * 1000 : fallback
    console.warn(`[rateLimitedFetch] 429, waiting ${waitMs}ms (attempt ${attempt + 1})`)
    await sleep(waitMs)
  }

  // Unreachable: the loop either returns or throws.
  throw new Error('Rate limited (429): retries exhausted')
}
