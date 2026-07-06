export interface SuppressionStatus { suppressed: boolean | null; reason?: string; createdAt?: string }

/**
 * Check Cloudflare's account-wide Email Sending suppression list for one address.
 * { suppressed: null } means "unknown" — creds missing, API error, or the list is
 * larger than one page (no email filter exists, so a partial scan can't prove absence).
 */
export async function checkEmailSuppression(
  env: { CF_EMAIL_TOKEN?: string; CF_ACCOUNT_ID?: string },
  email: string,
): Promise<SuppressionStatus> {
  if (!env.CF_EMAIL_TOKEN || !env.CF_ACCOUNT_ID) return { suppressed: null }
  const target = email.toLowerCase().trim()
  try {
    const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/email/sending/suppression?per_page=1000&order=created_at&direction=desc`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${env.CF_EMAIL_TOKEN}` } })
    if (!res.ok) { console.error('[suppression]', res.status, await res.text().catch(() => '')); return { suppressed: null } }
    const body = await res.json() as { total?: number; result?: Array<{ email: string; reason?: string; created_at?: string }> }
    const list = body.result ?? []
    const hit = list.find(r => r.email.toLowerCase() === target)
    if (hit) return { suppressed: true, reason: hit.reason, createdAt: hit.created_at }
    if ((body.total ?? 0) > list.length) { console.warn('[suppression] list exceeds one page; unknown for', target); return { suppressed: null } }
    return { suppressed: false }
  } catch (e) { console.error('[suppression] error', e); return { suppressed: null } }
}
