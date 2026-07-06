/**
 * safeUrl.ts — URL safety helpers for tenant apiUrl validation.
 *
 * Guards against:
 *   H3 – secret exfiltration: central's engagement-pull cron sends
 *         ADMIN_SECRET to `${apiUrl}/api/internal/engagement-stats`,
 *         so a rogue tenant registering e.g. "https://attacker.example"
 *         causes the secret to be forwarded there.
 *   SSRF – e.g. http://127.0.0.1, http://169.254.169.254.
 *
 * Rules enforced (host is read from WHATWG `URL.hostname`, lowercased, with a
 * single trailing dot stripped so the FQDN form `localhost.` / `127.0.0.1.`
 * can't slip past the literal checks):
 *   1. Scheme must be exactly "https:".
 *   2. Host must not be "localhost".
 *   3. Host must not end with ".local" (mDNS / split-horizon internal names).
 *   4. Host must contain at least one dot (no bare hostnames like "internal").
 *   5. Host must not be a raw IP literal — ALL IPv4 and ALL bracketed IPv6
 *      literals are rejected outright (real tenant apiUrls are DNS hostnames
 *      like ri.example.com, never bare IPs). This deliberately blocks public IPs
 *      too: we never need to register one, and a blanket rule sidesteps the bug
 *      surface of enumerating private ranges. WHATWG URL canonicalizes the
 *      sneaky IPv4 encodings (decimal `2130706433`, hex `0x7f000001`,
 *      short-form `127.1`) and IPv4-mapped IPv6 into dotted/bracketed literals
 *      in `hostname`, so this rule catches them all.
 *
 * No DNS resolution is performed — host-literal checks only, as DNS is not
 * reliably available in a Cloudflare Worker context. A hostname that resolves
 * to a private address at request time is out of scope (and unstoppable without
 * resolution); the literal checks are the bar here.
 */

/**
 * Parse a dotted-decimal IPv4 string into its four octets, or null if the
 * string is not a strict dotted-quad. WHATWG URL canonicalizes decimal/hex/
 * short-form IPv4 encodings into this dotted form in `hostname`, so checking
 * the canonical form is sufficient.
 */
function parseIpv4(host: string): number[] | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const octets = parts.map(Number)
  if (octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null
  // Ensure each part is a strict decimal integer (no hex/octal/leading-zero forms)
  if (parts.some((p, i) => String(octets[i]) !== p)) return null
  return octets
}

/**
 * Host-safety check (scheme-independent): rejects localhost, `.local`, bare
 * hostnames (no dot), and ALL raw IP literals (IPv4 and bracketed IPv6). The
 * scheme is checked by the public wrappers below.
 */
function hasUnsafeHost(parsed: URL): boolean {
  // Normalize: lowercase and strip a single trailing dot (FQDN form). Without
  // this, `localhost.` / `127.0.0.1.` / `foo.local.` would slip past the
  // literal checks since `URL.hostname` preserves the trailing dot.
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  if (host === 'localhost') return true
  if (host.endsWith('.local')) return true
  if (!host.includes('.')) return true // bare hostnames like "internal"
  if (parseIpv4(host) !== null) return true // all raw IPv4 literals
  // All raw IPv6 literals — URL.hostname keeps the brackets for IPv6.
  if (parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')) return true
  return false
}

/**
 * Returns true if `url` is safe to use as a tenant apiUrl:
 * - https: scheme
 * - not localhost / .local / bare hostname / raw IP literal
 */
export function isSafeTenantApiUrl(url: string): boolean {
  if (!url) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  return !hasUnsafeHost(parsed)
}

/**
 * Returns true if `url` is safe to FETCH server-side (finding M1 SSRF guard):
 * - http: or https: scheme (some state legislature text links are plain http,
 *   so we can't require https here without breaking real downloads)
 * - not localhost / .local / bare hostname / raw IP literal
 * Used by `safeFetch` on provider-supplied document URLs and every redirect hop.
 */
export function isSafeFetchUrl(url: string): boolean {
  if (!url) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  return !hasUnsafeHost(parsed)
}
