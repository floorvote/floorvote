import { centralFetch } from './centralFetch'
import type { Env } from '../types'

// Tenants no longer mint the cross-tenant superadmin token. Central is the SOLE
// issuer and sets the `superadmin_jwt` cookie itself on dashboard login (closes
// H2). The only tenant→central superadmin call that remains is checking whether
// an email is a superadmin, used at magic-link request to auto-provision a
// superadmin as a local admin.
//
// Finding D3: that check previously hit central once PER request. A flood of
// random unknown emails (each missing the local-user check) amplified into one
// central RPC each. We instead cache the allowlist (as SHA-256 hashes) in-isolate
// on a short TTL and test membership LOCALLY — one central call per TTL window,
// not per email. Hashes (not plaintext) keep central's posture: a compromised
// tenant gains no more than the pre-existing per-email `check` oracle.

const ALLOWLIST_TTL_MS = 5 * 60 * 1000

let cachedHashes: Set<string> | null = null
let lastAttemptAt = 0

/** Test-only: clear the in-isolate allowlist cache. */
export function _resetSuperadminAllowlistCache(): void {
  cachedHashes = null
  lastAttemptAt = 0
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Whether `email` is a central superadmin. Uses an in-isolate, TTL-cached set of
 * allowlist hashes (refreshed from central at most once per TTL window) so a
 * flood of unknown emails can't amplify into one central RPC each. Fails closed
 * (returns false) if the allowlist can't be fetched and nothing is cached.
 */
export async function isSuperadminEmailViaCentral(env: Env, email: string): Promise<boolean> {
  const now = Date.now()
  // Throttle refresh ATTEMPTS to once per TTL window — on success AND failure —
  // so a central outage with a stale/empty cache can't cause a per-request
  // refetch storm (the very amplification this cache exists to prevent).
  if (now - lastAttemptAt > ALLOWLIST_TTL_MS) {
    lastAttemptAt = now
    try {
      const res = await centralFetch(env, '/admin/superadmin/emails')
      if (res.ok) {
        const data = await res.json<{ hashes: string[] }>()
        cachedHashes = new Set(data.hashes ?? [])
      }
    } catch {
      // Keep any stale cache; if none, fail closed below.
    }
  }
  if (!cachedHashes) return false
  return cachedHashes.has(await sha256Hex(email.toLowerCase().trim()))
}
