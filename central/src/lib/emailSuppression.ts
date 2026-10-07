export interface SuppressionStatus { suppressed: boolean | null; reason?: string; createdAt?: string }

type SuppressionEnv = { CF_EMAIL_TOKEN?: string; CF_ACCOUNT_ID?: string }
type SuppressionEntry = { email: string; reason?: string; created_at?: string }

/**
 * The list's entries, or null when the body isn't the documented shape (no
 * `result` array, or an entry without a string `email`). A malformed answer
 * means "unknown", never a throw.
 */
function parseEntries(body: unknown): SuppressionEntry[] | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const result = (body as { result?: unknown }).result
  if (!Array.isArray(result)) return null
  for (const e of result) {
    if (!e || typeof e !== 'object' || typeof (e as { email?: unknown }).email !== 'string') return null
  }
  return result as SuppressionEntry[]
}

/**
 * One fetch of Cloudflare's account-wide Email Sending suppression list, newest
 * first. `complete` is false when the list is larger than one page: no email
 * filter exists, so a partial scan can prove an address is on the list but not
 * that it's absent. Returns null when the list can't be read (creds missing, API
 * error, network error, or a malformed response).
 */
async function fetchSuppressionList(env: SuppressionEnv): Promise<{ entries: SuppressionEntry[]; complete: boolean } | null> {
  if (!env.CF_EMAIL_TOKEN || !env.CF_ACCOUNT_ID) return null
  try {
    const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/email/sending/suppression?per_page=1000&order=created_at&direction=desc`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${env.CF_EMAIL_TOKEN}` } })
    if (!res.ok) { console.error('[suppression]', res.status, await res.text().catch(() => '')); return null }
    const body = await res.json() as unknown
    const entries = parseEntries(body)
    if (!entries) { console.error('[suppression] unexpected response shape'); return null }
    const total = (body as { total?: unknown }).total
    const complete = (typeof total === 'number' ? total : 0) <= entries.length
    if (!complete) console.warn('[suppression] list exceeds one page; absences are unknown')
    return { entries, complete }
  } catch (e) { console.error('[suppression] error', e); return null }
}

const normalize = (email: string) => email.toLowerCase().trim()

/**
 * Check many addresses against the suppression list with one fetch. Returns an
 * entry for every requested address, keyed by its lowercased, trimmed form:
 * `suppressed: true` (with reason) when listed, `false` when the whole list was
 * read and it's absent, and `null` ("unknown") when the list couldn't be read or
 * didn't fit one page.
 */
export async function checkEmailSuppressions(
  env: SuppressionEnv,
  emails: readonly string[],
): Promise<Record<string, SuppressionStatus>> {
  const targets = [...new Set(emails.map(normalize))]
  const out: Record<string, SuppressionStatus> = {}
  if (targets.length === 0) return out
  const list = await fetchSuppressionList(env)
  const byEmail = new Map<string, SuppressionEntry>()
  for (const e of list?.entries ?? []) {
    const key = normalize(e.email)
    if (!byEmail.has(key)) byEmail.set(key, e)
  }
  for (const t of targets) {
    const hit = byEmail.get(t)
    if (hit) out[t] = { suppressed: true, reason: hit.reason, createdAt: hit.created_at }
    else out[t] = { suppressed: list?.complete ? false : null }
  }
  return out
}

/**
 * Check Cloudflare's account-wide Email Sending suppression list for one address.
 * { suppressed: null } means "unknown" — creds missing, API error, or the list is
 * larger than one page (no email filter exists, so a partial scan can't prove absence).
 */
export async function checkEmailSuppression(env: SuppressionEnv, email: string): Promise<SuppressionStatus> {
  const target = normalize(email)
  return (await checkEmailSuppressions(env, [target]))[target]
}
