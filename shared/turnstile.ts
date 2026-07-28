// Cloudflare Turnstile server-side verification (siteverify).
//
// Behavior is governed by whether Turnstile is configured:
//   - secret UNSET  → fail-OPEN (returns true): local dev and self-hosters who
//                     have not configured Turnstile. Login is unaffected.
//   - secret SET    → fail-CLOSED: a missing/invalid token, or a siteverify
//                     error/outage, denies the request.
//
// The frontend is wired: when `TURNSTILE_SITE_KEY` is set, the login form
// renders the widget and POSTs its token as `turnstileToken` (see the web
// Turnstile component + Login page; the central dashboard mirrors this).
// See docs/internal/turnstile.md.

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/**
 * Returns true if the request may proceed: either Turnstile is not configured
 * (stub fail-open) or the token verifies. Returns false only when a secret IS
 * configured and the token is missing/invalid or siteverify fails (fail-closed).
 */
export async function verifyTurnstile(
  secret: string | undefined,
  token: string | undefined,
  remoteip?: string,
): Promise<boolean> {
  if (!secret) return true // not configured → stub fail-open
  if (!token) return false // configured but no token → fail-closed
  const form = new FormData()
  form.append('secret', secret)
  form.append('response', token)
  if (remoteip) form.append('remoteip', remoteip)
  try {
    const res = await fetch(SITEVERIFY_URL, { method: 'POST', body: form })
    if (!res.ok) return false
    const data = (await res.json()) as { success?: boolean }
    return data.success === true
  } catch {
    return false // configured → fail-closed on transport/parse error
  }
}
