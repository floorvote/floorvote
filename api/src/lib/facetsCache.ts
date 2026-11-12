// ── A member's facets, kept for a minute ──────────────────────────────────
// GET /bills/facets counts every filter's values over the whole table: on an
// instance of about 100,000 bills one request cost about 1.2 s of D1 time, and
// a few page loads within ten seconds spent the database's per-database budget,
// so that every query in that window failed (D1 7429 "overloaded"). A reload or
// a revisit within the minute answers from here and reads nothing.
//
// The key is the member's own: the response holds counts that are theirs (my
// bills, unvoted, new matches for an admin), so one member never reads
// another's. It is the tenant, the member, and the request's parameters in one
// order. A count may be up to a minute old after someone else's edit. After the
// member's own edit the page asks with Cache-Control: no-cache, which counts
// afresh and replaces what is kept, so their own change shows at once.
//
// Backed by the Workers Cache API (`caches.default`), as lib/listCache.ts is.
// FACETS_CACHE_TTL sets the seconds kept (default 60); 0 turns it off.

export const FACETS_CACHE_TTL_SECONDS = 60

/** The seconds a member's facets are kept: FACETS_CACHE_TTL, else the default; 0 (or a negative or unreadable value read as 0) is off. */
export function facetsCacheTtl(env: { FACETS_CACHE_TTL?: string }): number {
  const raw = env.FACETS_CACHE_TTL
  if (raw === undefined || raw === '') return FACETS_CACHE_TTL_SECONDS
  const n = parseInt(raw, 10)
  return Number.isNaN(n) || n < 0 ? 0 : n
}

/** The cache key of a member's facets request: the tenant, the member, and the parameters sorted. */
export function facetsCacheKey(env: { TENANT_ID: string }, userId: string, params: URLSearchParams): Request {
  const sorted = [...params.entries()].sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
  const query = new URLSearchParams(sorted).toString()
  return new Request(`https://facets-cache.internal/${encodeURIComponent(env.TENANT_ID)}/${encodeURIComponent(userId)}/facets?${query}`)
}

/** Whether the request asks to be counted afresh. */
export const wantsFresh = (req: Request): boolean => /\bno-cache\b/i.test(req.headers.get('Cache-Control') ?? '')

/**
 * The member's kept response for `key`, unless the request asks to be counted afresh; otherwise `compute`'s, kept for
 * the TTL when it is a success. A response read from the cache is a new Response, so the caller may return it.
 */
export async function cachedFacets(ttl: number, key: Request, fresh: boolean, compute: () => Promise<Response>): Promise<Response> {
  if (ttl <= 0) return compute()
  const cache = caches.default
  if (!fresh) {
    const hit = await cache.match(key)
    if (hit) return new Response(hit.body, { status: hit.status, headers: { 'Content-Type': 'application/json' } })
  }
  const res = await compute()
  if (res.status !== 200) return res
  const body = await res.text()
  await cache.put(key, new Response(body, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}` },
  }))
  return new Response(body, { status: 200, headers: res.headers })
}
