// ── Bill-text response cache ──────────────────────────────────────────────
// Caches the R2 blob fetch (and, for the JSON endpoint, the multi-MB PDF→base64
// conversion) behind GET /bills/:id/text and /bills/:id/text/:docId.
//
// Keyed on the R2 object key (`bills/legiscan-<billId>/texts/<docId>.<ext>`),
// which is immutable per document version: a bill that gains a NEW text document
// gets a NEW docId → NEW r2Key → NEW cache key, so newly-published text is never
// hidden by the cache. The only residual staleness is a same-docId in-place
// content revision, bounded by the moderate default TTL below — which is the
// exact tradeoff the 2026-06-14 resilience wave deferred this for.
//
// Backed by the Workers Cache API (`caches.default`). OFF when TTL is 0.

const DEFAULT_TTL_SECONDS = 300

/** Parse env.BILL_TEXT_CACHE_TTL. Default 300s. `0`/negative disables caching. */
export function billTextCacheTtl(env: { BILL_TEXT_CACHE_TTL?: string }): number {
  const raw = env.BILL_TEXT_CACHE_TTL
  if (raw === undefined || raw === '') return DEFAULT_TTL_SECONDS
  const n = parseInt(raw, 10)
  if (Number.isNaN(n)) return DEFAULT_TTL_SECONDS
  return n < 0 ? 0 : n
}

// The two endpoints return different shapes for the same R2 object (the docId
// endpoint streams the blob inline; the /text endpoint returns JSON, base64 for
// PDFs), so the variant must be part of the key or one would serve the other.
export function textCacheKey(variant: 'inline' | 'json', r2Key: string): Request {
  // Host is synthetic and never dialed; the Cache API only uses it as a key.
  return new Request(`https://bill-text-cache.internal/${variant}/${encodeURIComponent(r2Key)}`)
}

export async function getCachedText(
  env: { BILL_TEXT_CACHE_TTL?: string },
  key: Request,
): Promise<Response | null> {
  if (billTextCacheTtl(env) === 0) return null
  const hit = await caches.default.match(key)
  return hit ?? null
}

/**
 * Store a copy of `res` under `key`. Buffers the body (caller passes a clone or a
 * fresh response it no longer needs) and stamps Cache-Control so the Cache API
 * honours the TTL. No-op when caching is disabled.
 */
export async function putCachedText(
  env: { BILL_TEXT_CACHE_TTL?: string },
  key: Request,
  res: Response,
): Promise<void> {
  const ttl = billTextCacheTtl(env)
  if (ttl <= 0) return
  const headers = new Headers(res.headers)
  headers.set('Cache-Control', `max-age=${ttl}`)
  const body = await res.arrayBuffer()
  await caches.default.put(key, new Response(body, { status: res.status, headers }))
}
