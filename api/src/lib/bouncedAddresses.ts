import { and, inArray, sql } from 'drizzle-orm'
import type { AppDb, Env } from '../types'
import { authEvents } from '../db/schema'
import { centralEmail } from './centralEmail'
import { ADDRESS_LOOKUP_CHUNK, normalizeMemberAddress } from './memberAddress'

// The delivery outcomes that decide whether an address's recorded history
// counts as bounced. The latest one wins: a later delivery clears a bounce.
const OUTCOME_EVENTS = ['email_bounced', 'email_delivered'] as const

/**
 * The addresses among `emails` (already normalized) whose latest recorded
 * delivery outcome is a bounce. Outcomes count whichever member's row they sit
 * on, deactivated included, compared without regard to case.
 */
async function recordedBounces(db: AppDb, emails: readonly string[]): Promise<Set<string>> {
  const bounced = new Set<string>()
  // Not index-backed: lower() defeats the email index, and no index covers
  // `event`, so each chunk scans auth_events in full. Acceptable because only
  // occasional admin actions (bulk invite, change-email) run it.
  const storedLower = sql<string>`lower(trim(${authEvents.email}))`
  for (let i = 0; i < emails.length; i += ADDRESS_LOOKUP_CHUNK) {
    const rows = await db
      .select({ email: storedLower, event: authEvents.event })
      .from(authEvents)
      .where(and(
        inArray(authEvents.event, [...OUTCOME_EVENTS]),
        inArray(storedLower, emails.slice(i, i + ADDRESS_LOOKUP_CHUNK)),
      ))
      // created_at has one-second precision; rowid (insertion order) breaks a
      // same-second tie, so "latest" is always defined.
      .orderBy(authEvents.createdAt, sql`auth_events.rowid`)
      .all()
    const latest = new Map<string, string>()
    for (const r of rows) latest.set(r.email, r.event)
    for (const [email, event] of latest) if (event === 'email_bounced') bounced.add(email)
  }
  return bounced
}

/**
 * The provider's batch suppression answer, or undefined when central can't
 * give one. A deployed binding throws when the remote worker lacks a method,
 * and a test binding leaves it undefined; both read as "missing".
 */
async function suppressionMany(env: Pick<Env, 'CENTRAL'>, emails: string[]): Promise<{ suppressed: Set<string> } | undefined> {
  const central = centralEmail(env)
  if (!central.emailSuppressionMany) return undefined
  try {
    const statuses = await central.emailSuppressionMany(emails)
    const suppressed = new Set<string>()
    if (statuses && typeof statuses === 'object') {
      for (const email of emails) if (statuses[email]?.suppressed === true) suppressed.add(email)
    }
    return { suppressed }
  } catch (e) {
    console.error('[bounced-addresses] batch suppression lookup failed', e)
    return undefined
  }
}

/**
 * The addresses among `rawEmails` that bounced before, normalized with
 * `normalizeMemberAddress`. An address counts if its latest recorded delivery
 * outcome on this instance is a bounce (see `recordedBounces`), or if the
 * provider's suppression list has it.
 *
 * The suppression list is asked once for the whole batch. Central deploys
 * separately, so its batch method can be missing, throw, or not know; then
 * only the recorded bounces count. A failed lookup never refuses an address
 * on its own.
 */
export async function previouslyBouncedAddresses(
  env: Pick<Env, 'CENTRAL'>,
  db: AppDb,
  rawEmails: readonly string[],
): Promise<Set<string>> {
  const emails = [...new Set(rawEmails.map(normalizeMemberAddress).filter(Boolean))]
  if (emails.length === 0) return new Set()
  const bounced = await recordedBounces(db, emails)
  const listed = await suppressionMany(env, emails)
  for (const email of listed?.suppressed ?? []) bounced.add(email)
  return bounced
}

/**
 * Whether one address bounced before, by the same rule as
 * `previouslyBouncedAddresses`. With only one address to ask about, a central
 * that lacks the batch method is asked with its single-address method instead.
 * If that fails too, only the recorded bounces count.
 */
export async function isPreviouslyBounced(
  env: Pick<Env, 'CENTRAL'>,
  db: AppDb,
  rawEmail: string,
): Promise<boolean> {
  const email = normalizeMemberAddress(rawEmail)
  if (!email) return false
  if ((await recordedBounces(db, [email])).has(email)) return true
  const listed = await suppressionMany(env, [email])
  if (listed) return listed.suppressed.has(email)
  const central = centralEmail(env)
  if (!central.emailSuppression) return false
  try {
    return (await central.emailSuppression(email))?.suppressed === true
  } catch (e) {
    console.error('[bounced-addresses] single suppression lookup failed', e)
    return false
  }
}
