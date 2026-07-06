// The superadmin SSO cookie is scoped to whichever configured registrable
// domain the request host belongs to (e.g. `.example.com`), so it carries across
// that domain's subdomains. The domain set is supplied by the caller (parsed
// from APP_DOMAINS). An empty list — or a host matching none of the configured
// domains (e.g. a bare *.workers.dev URL) — yields a host-only cookie.
export function getSuperAdminCookieDomain(appUrl: string, appDomains: string[]): string | undefined {
  try {
    const { hostname } = new URL(appUrl)
    for (const apex of appDomains) {
      if (hostname === apex || hostname.endsWith(`.${apex}`)) return `.${apex}`
    }
  } catch {
    // ignore malformed URL
  }
  return undefined
}
