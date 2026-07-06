// The set of registrable domains this deployment serves is supplied by the
// caller (parsed from the APP_DOMAINS env var via parseAppDomains). An empty
// list means the SPA's same-origin requests are still allowed, but no
// cross-subdomain origin is.
const LOCAL_DEV_ORIGIN = 'http://localhost:5173'

export function isAllowedOrigin(
  origin: string | undefined | null,
  appUrl: string,
  appDomains: string[],
): boolean {
  if (!origin) return false
  if (origin === appUrl || origin === LOCAL_DEV_ORIGIN) return true
  try {
    const { hostname, protocol } = new URL(origin)
    if (protocol !== 'https:') return false
    return appDomains.some((apex) => hostname === apex || hostname.endsWith(`.${apex}`))
  } catch {
    return false
  }
}
