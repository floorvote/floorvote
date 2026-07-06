/**
 * Derive the cross-tenant `superadmin_jwt` cookie Domain from central's
 * `ADMIN_APP_URL`.
 *
 * The cross-tenant SSO cookie must be scoped to the parent registrable domain so
 * the browser sends it to every tenant subdomain (e.g. set at `admin.example.com`,
 * sent to `ri.example.com`). We derive that by dropping the first label of the
 * admin host: `admin.example.com` → `.example.com`.
 *
 * Mirrors the tenant-side `getSuperAdminCookieDomain` (`api/src/lib/superadmin.ts`)
 * in intent; implemented separately (no cross-package import) and derived purely
 * from `ADMIN_APP_URL` (no new env var).
 *
 * Fails SAFE — returns `undefined` (host-only cookie, no Domain attribute) when a
 * parent scope can't be derived: unset/malformed URL, IP host, `localhost`, or a
 * bare two-label host (`example.com` → dropping its first label gives `.com`).
 *
 * NOTE — not public-suffix-list (PSL) aware. The `labels.length < 3` guard only
 * catches single-label TLDs. A multi-label public suffix (e.g. `foo.co.uk`) would
 * still produce `.co.uk` here. We accept this because (a) the deployment is
 * `admin.example.com` → `.example.com`, well clear of any multi-label suffix, and
 * (b) browsers reject a `Domain` that resolves to a public suffix per the PSL
 * rather than honoring it — so the browser, not this code, is the backstop for
 * exotic hosts. If central is ever hosted under a multi-label public suffix,
 * make this PSL-aware.
 */
export function getSuperadminCookieDomain(adminAppUrl: string | undefined): string | undefined {
  if (!adminAppUrl) return undefined
  let hostname: string
  try {
    hostname = new URL(adminAppUrl).hostname
  } catch {
    return undefined
  }
  if (!hostname) return undefined
  // localhost / IP literals have no usable parent domain.
  if (hostname === 'localhost') return undefined
  if (isIpHost(hostname)) return undefined

  const labels = hostname.split('.').filter(Boolean)
  // Need at least 3 labels to safely drop one and still leave a registrable
  // parent (e.g. admin.example.com → example.com). A 2-label host (example.com)
  // would drop to `.vote` (a TLD), so we refuse and use a host-only cookie.
  if (labels.length < 3) return undefined

  const parent = labels.slice(1).join('.')
  return `.${parent}`
}

function isIpHost(hostname: string): boolean {
  // IPv6 literals arrive bracketed from URL.hostname for `[::1]` → `[::1]`.
  if (hostname.includes(':') || hostname.startsWith('[')) return true
  // IPv4 dotted-quad.
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)
}
