// Cloudflare Turnstile server-side verification (siteverify).
//
// STUB STATUS: this gate is wired but inert until
// the operator creates a Turnstile widget and sets `TURNSTILE_SECRET_KEY`.
//   - secret UNSET  → fail-OPEN (returns true): local dev and the period before
//                     the operator wires it up. Login is unaffected.
//   - secret SET    → fail-CLOSED: a missing/invalid token, or a siteverify
//                     error/outage, denies the request.
// FRONTEND GAP (operator to close): when the secret is set, the login form must
// render the Turnstile widget (with the matching SITE KEY) and POST its token as
// `turnstileToken`, or login will fail closed. See docs/turnstile-setup.md.

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
