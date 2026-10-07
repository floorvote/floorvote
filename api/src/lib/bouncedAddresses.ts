import { and, eq, inArray, sql } from 'drizzle-orm'
import type { AppDb, Env } from '../types'
import { authEvents } from '../db/schema'
import { centralEmail } from './centralEmail'
import { normalizeMemberAddress } from './memberAddress'

// D1 caps a query at 100 bound parameters; one goes to the event name.
const LOOKUP_CHUNK = 90

/**
 * The addresses among `rawEmails` that bounced before, normalized with
 * `normalizeMemberAddress`. An address counts if this instance recorded an
 * `email_bounced` event for it (whichever member it belonged to, deactivated
 * included, compared without regard to case), or if the provider's suppression
 * list has it.
 *
 * The suppression list is asked once for the whole batch. Central deploys
 * separately, so its method can be missing, throw, or not know; then only the
 * recorded bounces count. A failed lookup never refuses an address on its own.
 */
export async function previouslyBouncedAddresses(
  env: Pick<Env, 'CENTRAL'>,
  db: AppDb,
  rawEmails: readonly string[],
): Promise<Set<string>> {
  const emails = [...new Set(rawEmails.map(normalizeMemberAddress).filter(Boolean))]
  const bounced = new Set<string>()
  if (emails.length === 0) return bounced

  // Not index-backed (lower() defeats the email index), but bounces are rare
  // and the event filter keeps the scan small.
  const storedLower = sql<string>`lower(trim(${authEvents.email}))`
  for (let i = 0; i < emails.length; i += LOOKUP_CHUNK) {
    const rows = await db
      .selectDistinct({ email: storedLower })
      .from(authEvents)
      .where(and(eq(authEvents.event, 'email_bounced'), inArray(storedLower, emails.slice(i, i + LOOKUP_CHUNK))))
      .all()
    for (const r of rows) bounced.add(r.email)
  }

  try {
    const central = centralEmail(env)
    const statuses = central.emailSuppressionMany ? await central.emailSuppressionMany(emails) : undefined
    if (statuses && typeof statuses === 'object') {
      for (const email of emails) if (statuses[email]?.suppressed === true) bounced.add(email)
    }
  } catch (e) { console.error('[bounced-addresses] suppression lookup failed', e) }

  return bounced
}
