/**
 * Deny-by-default allowlist for the tenant-reachable surface of central.
 *
 * The `TenantApi` WorkerEntrypoint injects central's `ADMIN_SECRET` and forwards
 * into the full Hono app. Because Cloudflare service bindings carry no caller
 * identity, ANY route reachable through that entrypoint is effectively reachable
 * by ANY tenant with central's privileges. To contain blast radius we forward
 * ONLY the explicit `(method, path)` operations tenants legitimately use and
 * return 403 for everything else — operator-only routes (reingest-tenant,
 * anomaly-watch, the cross-tenant operator fan-out, superadmin mint, …) are
 * NOT in this list and remain reachable only over central's public HTTP `/api/*`
 * path gated by `x-admin-secret`.
 *
 * Matching is robust against trailing-slash / case / percent-encoding /
 * duplicate-slash / dot-segment tricks: we normalize first, then match against
 * fixed patterns where `:param` is a single non-empty path segment.
 */

interface SurfacePattern {
  method: string
  /** Path segments; `:param` matches exactly one non-empty segment. */
  segments: string[]
}

// Patterns are written WITHOUT the leading slash; all paths include the `/api`
// prefix that `centralFetch` prepends on the tenant side.
//
// This MUST be a superset of every (method, path) the tenant sends via
// `centralFetch` (api/src/lib/centralFetch.ts). A missing entry is 403'd silently
// on every tenant — that is how `GET /bills/:id/text/:docId` broke. The canonical
// caller list in tenantSurface.test.ts cross-checks this; keep them in sync.
const ALLOW: SurfacePattern[] = [
  { method: 'GET', segments: ['api', 'bills', ':id'] },
  { method: 'GET', segments: ['api', 'bills', ':id', 'text'] },
  { method: 'GET', segments: ['api', 'bills', ':id', 'text', ':docId'] },
  { method: 'GET', segments: ['api', 'bills', ':id', 'changes'] },
  { method: 'GET', segments: ['api', 'bills', 'sessions'] },
  { method: 'POST', segments: ['api', 'bills', 'rich-batch'] },
  { method: 'POST', segments: ['api', 'tenants', 'register'] },
  { method: 'POST', segments: ['api', 'tenants', 'reprocess', ':id'] },
  { method: 'POST', segments: ['api', 'tenants', 'promote-bill', ':id', ':billId'] },
  { method: 'POST', segments: ['api', 'tenants', 'promote-bills', ':id'] },
  { method: 'GET', segments: ['api', 'tenants', ':id', 'upcoming-hearings'] },
  { method: 'POST', segments: ['api', 'admin', 'sync-keywords', ':id'] },
  { method: 'POST', segments: ['api', 'admin', 'update-bill-match-types', ':id'] },
  { method: 'POST', segments: ['api', 'admin', 'reprocess-tenant', ':id'] },
  { method: 'GET', segments: ['api', 'admin', 'superadmin', 'check'] },
  { method: 'GET', segments: ['api', 'admin', 'superadmin', 'emails'] },
]

// Note: `GET /api/bills/sessions` matches BOTH the `:id` and the `sessions`
// patterns above (both GET). That is harmless — the matcher returns true if ANY
// pattern matches, and both are legitimately allowed.

/**
 * Normalize a request path into lowercased, decoded, non-empty segments.
 * Returns null if the path is structurally unsafe (encoded slash inside a
 * segment, control chars, malformed encoding, or `.`/`..` dot-segments) — the
 * caller treats null as a denial.
 */
function normalizeSegments(rawPath: string): string[] | null {
  // Strip query/fragment.
  const path = rawPath.split('?')[0].split('#')[0]
  // Split on `/` BEFORE decoding so an encoded `%2f` cannot manufacture a new
  // path segment.
  const rawSegments = path.split('/')
  const out: string[] = []
  for (const raw of rawSegments) {
    if (raw === '') continue // collapse leading/duplicate/trailing slashes
    let seg: string
    try {
      seg = decodeURIComponent(raw)
    } catch {
      return null // malformed percent-encoding
    }
    // After decoding, a slash or backslash inside a single segment means someone
    // tried to smuggle an extra path segment (e.g. `%2f`).
    if (seg.includes('/') || seg.includes('\\')) return null
    // Reject control characters (incl. NUL) smuggled via percent-encoding.
    for (let j = 0; j < seg.length; j++) {
      if (seg.charCodeAt(j) < 0x20) return null
    }
    const lower = seg.toLowerCase()
    // Reject dot-segments outright — they only appear in traversal attempts.
    if (lower === '.' || lower === '..') return null
    out.push(lower)
  }
  return out
}

function matchPattern(pattern: SurfacePattern, method: string, segments: string[]): boolean {
  if (pattern.method !== method) return false
  if (pattern.segments.length !== segments.length) return false
  for (let i = 0; i < pattern.segments.length; i++) {
    const p = pattern.segments[i]
    if (p.startsWith(':')) continue // wildcard: any single non-empty segment
    if (p !== segments[i]) return false
  }
  return true
}

/**
 * Returns true iff `(method, path)` is an explicitly-allowed tenant→central
 * operation. Deny-by-default: anything not matched is false.
 */
export function isTenantSurfaceAllowed(method: string, path: string): boolean {
  const m = (method ?? '').toUpperCase()
  const segments = normalizeSegments(path ?? '')
  if (segments === null) return false
  for (const pattern of ALLOW) {
    if (matchPattern(pattern, m, segments)) return true
  }
  return false
}
