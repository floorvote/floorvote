/**
 * Parse the `APP_DOMAINS` env var — a comma-separated list of registrable
 * domains this deployment serves (e.g. "example.com,example.org"). Normally
 * one entry; two during a domain migration. Returns [] when unset or blank, in
 * which case CORS falls back to same-origin-only and the superadmin cookie is
 * host-only. There is deliberately no hardcoded default.
 */
export function parseAppDomains(raw: string | undefined): string[] {
  if (!raw) return []
  return raw.split(',').map((d) => d.trim()).filter((d) => d.length > 0)
}
