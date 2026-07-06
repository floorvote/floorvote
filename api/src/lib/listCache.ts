import type { Env } from '../types'

// ── Default-list query cache ──────────────────────────────────────────────
// Caches ONLY the shared, expensive count+ordered-page query for GET /bills
// (the full table scan + filesort). The cached payload is the `{ total, billRows }`
// pair and NOTHING per-user: enrichment (myVote/myNote/myComment, vote counts,
// positions, comment counts, custom-field values) is always recomputed fresh
// per request from the page's bill IDs, so a shared cache never leaks one user's
// state to another.
//
// Backed by the Workers Cache API (`caches.default`), scoped per tenant via the
// synthetic cache-key URL. Requests with per-user filters (myBills / unvoted)
// MUST bypass this cache entirely — those make the bill SET depend on the
// current user, so they're not cacheable per-tenant. The caller is responsible
// for that bypass (see normalizeListCacheParams + listRoutes wiring).

export type CachedListPage = {
  total: number
  // billRows are the raw `bills` table rows (db.select().from(bills)); typed loosely
  // here because the row shape is owned by the route/schema, not this cache module.
  billRows: Record<string, unknown>[]
}

// The query inputs that determine the shared bill set + ordering. Multi-value
// filters are arrays; everything that affects the page must be present here.
export type ListCacheParams = {
  statuses: string[]
  priorities: string[]
  positionValues: string[]
  sessions: string[]
  years: string[]
  states: string[]
  tagFilters: string[]
  q: string | undefined
  minRelevance: string | undefined
  cfParamMap: Record<string, string[]>
  sort: string
  dir: 'asc' | 'desc'
  page: number
  pageSize: number
}

// Caching is OFF by default. Authenticated tenants edit bills (incl. priority,
// single and bulk) directly from the list view, so a stale list there is wrong
// for normal use. Enable per-tenant by setting LIST_CACHE_TTL to a positive
// number of seconds — but only where the list is read-mostly (e.g. a public,
// crawler-exposed instance). Making it safe-on for interactive tenants needs
// write-invalidation (bust the tenant's list cache on any bill write), not just a TTL.
const DEFAULT_TTL_SECONDS = 0

// Parse env.LIST_CACHE_TTL. Default 0 (off). `0`/negative/invalid disables caching.
export function listCacheTtl(env: { LIST_CACHE_TTL?: string }): number {
  const raw = env.LIST_CACHE_TTL
  if (raw === undefined || raw === '') return DEFAULT_TTL_SECONDS
  const n = parseInt(raw, 10)
  if (Number.isNaN(n)) return DEFAULT_TTL_SECONDS
  return n < 0 ? 0 : n
}

// Deterministic, order-independent serialization of the params. Multi-value
// arrays are sorted so filter order doesn't change the key; cf_* params are
// sorted by field id with their values sorted too.
function serializeParams(p: ListCacheParams): string {
  const sortedArr = (a: string[]) => [...a].sort()
  const cf = Object.keys(p.cfParamMap)
    .sort()
    .map((k) => [k, sortedArr(p.cfParamMap[k])] as const)
  const canonical = {
    statuses: sortedArr(p.statuses),
    priorities: sortedArr(p.priorities),
    positionValues: sortedArr(p.positionValues),
    sessions: sortedArr(p.sessions),
    years: sortedArr(p.years),
    states: sortedArr(p.states),
    tagFilters: sortedArr(p.tagFilters),
    q: p.q ?? null,
    minRelevance: p.minRelevance ?? null,
    cf,
    sort: p.sort,
    dir: p.dir,
    page: p.page,
    pageSize: p.pageSize,
  }
  return JSON.stringify(canonical)
}

// Build a synthetic Request usable as a Cache API key. Scoped per tenant via
// the URL path so two tenants never collide in the shared `caches.default`.
export function cacheKeyFor(env: { TENANT_ID: string }, params: ListCacheParams): Request {
  const tenant = encodeURIComponent(env.TENANT_ID)
  const payload = encodeURIComponent(serializeParams(params))
  // Host is synthetic and never dialed; the Cache API only uses it as a key.
  return new Request(`https://list-cache.internal/${tenant}/bills?p=${payload}`)
}

export async function getCachedPage(
  env: { LIST_CACHE_TTL?: string },
  key: Request,
): Promise<CachedListPage | null> {
  if (listCacheTtl(env) === 0) return null
  const cache = caches.default
  const hit = await cache.match(key)
  if (!hit) return null
  try {
    return (await hit.json()) as CachedListPage
  } catch {
    return null
  }
}

export async function putCachedPage(
  env: { LIST_CACHE_TTL?: string },
  key: Request,
  value: CachedListPage,
  ttlSeconds: number,
): Promise<void> {
  if (ttlSeconds <= 0) return
  const cache = caches.default
  const res = new Response(JSON.stringify(value), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `max-age=${ttlSeconds}`,
    },
  })
  await cache.put(key, res)
}

// Helper used by the route: should this request bypass the cache entirely?
// myBills / unvoted make the bill SET per-user, so they're not cacheable.
export function isPerUserListRequest(opts: {
  myBills?: string
  unvoted?: string
}): boolean {
  const myBills = opts.myBills === '1' || opts.myBills === 'true'
  const unvoted = opts.unvoted === '1'
  return myBills || unvoted
}
