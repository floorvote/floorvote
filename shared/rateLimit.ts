// Thin wrapper over the Cloudflare Workers Rate Limiting binding (`[[ratelimits]]`
// in wrangler.toml → `env.<NAME>.limit({ key })`). Kept provider-agnostic via a
// minimal interface so it's trivial to unit-test and so an env without the
// binding (local dev, tests) simply fails open.

export interface RateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>
}

/**
 * Returns true if the request may proceed. Fails OPEN when no limiter is bound
 * (dev/unconfigured) or when the limiter itself errors — a rate limiter is an
 * availability control paired with other defenses (per-user link cap, Turnstile),
 * so a limiter blip must never lock users out of authentication. Returns false
 * only when the limiter explicitly reports the limit was exceeded. A throw is
 * logged (route prefix only, never the IP).
 */
export async function checkRateLimit(limiter: RateLimiter | undefined, key: string): Promise<boolean> {
  if (!limiter) return true
  try {
    const { success } = await limiter.limit({ key })
    return success
  } catch (err) {
    // Say so: a binding that always throws would otherwise leave every route
    // unlimited with no sign of it. The key's prefix names the route; the rest
    // is the client IP, which stays out of the logs.
    console.warn(`rate limiter failed open for ${key.split(':')[0]}: ${err instanceof Error ? err.message : String(err)}`)
    return true
  }
}
