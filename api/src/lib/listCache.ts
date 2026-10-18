import type { Env } from '../types'
import { BILL_FILTER_DEFS, encodeSubjectFilter, serializeBillFilter, type BillFilter, type SubjectValue } from '../../../shared/billFilter'

// ── Default-list query cache ──────────────────────────────────────────────
// Caches ONLY the shared, expensive count+ordered-page query for GET /bills
// (the full table scan + filesort). The cached payload is the `{ total, billRows }`
// pair, where billRows names the companion groups on the page by group key, and
// NOTHING per-user: what a row shows (the bills of each group, myVote/myNote/
// myComment, vote counts, positions, comment counts, custom-field values) is
// always read fresh per request from the page's group keys, so a shared cache
// never leaks one user's state to another.
//
// Backed by the Workers Cache API (`caches.default`), scoped per tenant via the
// synthetic cache-key URL. Requests with per-user filters (myBills / unvoted)
// MUST bypass this cache entirely — those make the bill SET depend on the
// current user, so they're not cacheable per-tenant. The caller is responsible
// for that bypass (see normalizeListCacheParams + listRoutes wiring).

export type CachedListPage = {
  total: number
  // billRows are the groups on the page, in order, each `{ id }` with the group's
  // key (a bill with no companions is its own group); typed loosely here because
  // the row shape is owned by the route, not this cache module.
  billRows: Record<string, unknown>[]
}

// The query inputs that determine the shared bill set + ordering: the whole bill filter, and how the page is cut.
// The key is the filter as the shared module serializes it (shared/billFilter.ts), so every filter the module
// names is in it, and a filter added there is in it with no edit here.
export type ListCacheParams = {
  filter: BillFilter
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

// The filter with the values of every multi-select filter and of each custom field in one order, so two orders of
// the same picks (which the list reads the same) share a key. The serializer writes keys in one order and sorts
// the custom fields, and this does the same for the values.
function inValueOrder(filter: BillFilter): BillFilter {
  const text = (v: string | SubjectValue) => typeof v === 'string' ? v : encodeSubjectFilter(v.state, v.name)
  const byText = (a: string | SubjectValue, b: string | SubjectValue) => (text(a) < text(b) ? -1 : text(a) > text(b) ? 1 : 0)
  const out: Record<string, unknown> = { ...filter }
  for (const def of BILL_FILTER_DEFS) {
    if (def.kind === 'multi-select') out[def.name] = [...(filter[def.name] as readonly (string | SubjectValue)[])].sort(byText)
    if (def.kind === 'custom-field') {
      out[def.name] = Object.fromEntries(Object.entries(filter.field).map(([key, values]) => [key, [...values].sort()]))
    }
  }
  return out as BillFilter
}

// Deterministic, order-independent serialization of the params.
function serializeParams(p: ListCacheParams): string {
  return JSON.stringify({
    filter: serializeBillFilter(inValueOrder(p.filter)),
    sort: p.sort,
    dir: p.dir,
    page: p.page,
    pageSize: p.pageSize,
  })
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
export function isPerUserListRequest(filter: Pick<BillFilter, 'myBills' | 'unvoted'>): boolean {
  return filter.myBills || filter.unvoted
}
