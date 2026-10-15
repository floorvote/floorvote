import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import type { AppDb, Env } from '../types'
import { users, sessions, emailChanges, emailChangeReports, authEvents } from '../db/schema'
import { generateToken, hashToken } from './crypto'
import { recordAuthEvent } from './authEvents'
import { sendBatch, resolveAssocName, type EmailMessage } from './email'
import { normalizeMemberAddress } from './memberAddress'
import { renderEmailChangeReportedEmail } from './emailChangeEmail'

// "This wasn't me", from the old address of an email change (#415).
//
// Each notice to the old address (at request and at commit) carries a link
// with its own token, issued here and stored hashed in email_change_reports.
// A token is scoped to one member and one change and lasts 7 days. The page
// the link opens only reads its status. Pressing the button posts the token to
// reportNotMe, which ends every one of the member's sessions and emails the
// instance's owners and admins, then records the event.
//
// It cancels the member's pending change when the member started it from the
// address the notice went to, so nobody can still confirm it from the new inbox.
// It leaves alone a change an admin started, so a member whose old mailbox
// someone else holds can still move by asking an admin, and a change the
// mailbox was never told about (a newer one from another address). It never
// reverses a change that has already taken effect: the old mailbox may now
// belong to someone else, and an admin can restore the address. It never signs
// anyone in either.
// A token works once, and so does its sibling's, because spending one deletes
// every token of the same change. The report would otherwise alert the admins
// twice.

/** How long a "This wasn't me" link lasts. */
export const NOT_ME_TTL_DAYS = 7

export const NOT_ME_ERRORS = {
  invalidLink: 'This link is no longer valid. It may have been used already.',
  expiredLink: "This link has expired. If your sign-in email was changed and you didn't ask for it, contact one of your admins.",
} as const

/** Where "This wasn't me" in an old-address notice leads: the page with the button. */
export function notMeUrl(appUrl: string, rawToken: string): string {
  return `${appUrl}/auth/not-me?token=${encodeURIComponent(rawToken)}`
}

type Change = {
  /** The email_changes row the notice is about. */
  id: string
  userId: string
  oldEmail: string
  newEmail: string
  requestedBy: string
  /** When the change was requested, as a database timestamp. Omit for now. */
  requestedAt?: string
}

/**
 * Issue the token for one old-address notice and return it raw. Also clears
 * out tokens that have expired, so the table holds only links still in date.
 */
export async function issueNotMeToken(db: AppDb, change: Change): Promise<string> {
  const rawToken = await generateToken()
  await db.batch([
    db.delete(emailChangeReports).where(sql`datetime(${emailChangeReports.expiresAt}) <= datetime('now')`),
    db.insert(emailChangeReports).values({
      id: crypto.randomUUID(),
      changeId: change.id,
      userId: change.userId,
      oldEmail: change.oldEmail,
      newEmail: change.newEmail,
      requestedBy: change.requestedBy,
      requestedAt: change.requestedAt ?? sql`datetime('now')`,
      tokenHash: await hashToken(rawToken),
      expiresAt: sql`datetime('now', ${`+${NOT_ME_TTL_DAYS} days`})`,
    }),
  ])
  return rawToken
}

type ReportRow = typeof emailChangeReports.$inferSelect

async function reportFor(db: AppDb, rawToken: string): Promise<{ row: ReportRow; live: boolean } | null> {
  const found = await db
    .select({ row: emailChangeReports, live: sql<number>`datetime(${emailChangeReports.expiresAt}) > datetime('now')` })
    .from(emailChangeReports)
    .where(eq(emailChangeReports.tokenHash, await hashToken(rawToken)))
    .get()
  return found ? { row: found.row, live: found.live === 1 } : null
}

/** What the link would do, without doing it. Writes nothing, and says nothing about the change. */
export async function notMeLinkStatus(db: AppDb, rawToken: string): Promise<{ status: 'valid' | 'expired' | 'invalid' }> {
  const found = await reportFor(db, rawToken)
  if (!found) return { status: 'invalid' }
  return { status: found.live ? 'valid' : 'expired' }
}

type Refusal = { ok: false; status: 404 | 410; error: string }

/** "2026-10-12 15:41:00" as "October 12, 2026 at 3:41 p.m. UTC". Email has no viewer timezone. */
function whenText(dbTs: string): string {
  const d = new Date(`${dbTs.replace(' ', 'T')}Z`) // ts-write-ok: parses a stored UTC timestamp, writes nothing
  const date = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })
    .replace(/[\s ]*(AM|PM)$/, (_, m: string) => ` ${m === 'AM' ? 'a.m.' : 'p.m.'}`)
  return `${date} at ${time} UTC`
}

/**
 * Press "This wasn't me". Ends every session the member has, cancels their
 * pending change if they started it from this notice's address, records the
 * event, and emails the instance's active owners and admins who changed what
 * and when. Spends the token, so a second press does nothing. `alerted` says
 * whether at least one alert went out, so the page can be honest if none did,
 * and `cancelled` whether a pending change was cancelled.
 */
export async function reportNotMe(
  env: Env,
  db: AppDb,
  rawToken: string,
  ctx: { userAgent: string | null; ipCountry: string | null },
): Promise<{ ok: true; alerted: boolean; cancelled: boolean } | Refusal> {
  const found = await reportFor(db, rawToken)
  if (!found) return { ok: false, status: 404, error: NOT_ME_ERRORS.invalidLink }
  if (!found.live) return { ok: false, status: 410, error: NOT_ME_ERRORS.expiredLink }
  const { row } = found

  // One batch. The sessions and the pending change go only while this token
  // is still in date, and spending it deletes every token of the same change.
  // A press that loses a race finds its token already gone: it ends nothing,
  // and its own row is missing from `spent`, so it alerts nobody.
  const live = sql`EXISTS (SELECT 1 FROM email_change_reports WHERE id = ${row.id} AND datetime(expires_at) > datetime('now'))`
  const [, cancelled, spent] = await db.batch([
    db.delete(sessions).where(and(eq(sessions.userId, row.userId), live)),
    db.delete(emailChanges).where(and(
      eq(emailChanges.userId, row.userId),
      // Only a change this mailbox was told about, and only one the member asked for.
      eq(emailChanges.oldEmail, row.oldEmail),
      eq(emailChanges.requestedBy, row.userId),
      live,
    ))
      .returning({ userId: emailChanges.userId, oldEmail: emailChanges.oldEmail, newEmail: emailChanges.newEmail }),
    db.delete(emailChangeReports)
      .where(and(eq(emailChangeReports.changeId, row.changeId), eq(emailChangeReports.userId, row.userId)))
      .returning({ id: emailChangeReports.id }),
  ])
  if (!spent.some(r => r.id === row.id)) return { ok: false, status: 404, error: NOT_ME_ERRORS.invalidLink }

  await recordAuthEvent(db, {
    event: 'email_change_reported', userId: row.userId, email: row.newEmail, reason: row.oldEmail, ...ctx,
  })
  for (const c of cancelled) {
    await recordAuthEvent(db, {
      event: 'email_change_cancelled', userId: c.userId, email: c.newEmail, reason: c.oldEmail, ...ctx,
    })
  }

  return { ok: true, alerted: await alertAdmins(env, db, row, cancelled[0]?.newEmail ?? null), cancelled: cancelled.length > 0 }
}

/**
 * Email the report to every active owner and admin, one message each. Not the
 * member who reported: their own address may be the one in doubt, and they
 * know. Runs after the sessions are gone, so a failure is logged, never raised.
 */
async function alertAdmins(env: Env, db: AppDb, row: ReportRow, cancelledTo: string | null): Promise<boolean> {
  try {
    const member = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, row.userId)).get()
    if (!member) return false
    const selfRequested = row.requestedBy === row.userId
    const requester = selfRequested
      ? null
      : await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, row.requestedBy)).get()
    const recipients = await db
      .select({ email: users.email })
      .from(users)
      .where(and(inArray(users.role, ['admin', 'owner']), isNull(users.deactivatedAt), ne(users.id, row.userId)))
      .all()
    if (recipients.length === 0) {
      console.warn(`[email-change] no active owner or admin to alert about the report for member ${row.userId}`)
      return false
    }

    const requestedBy = selfRequested
      ? 'the member'
      : requester ? (requester.name?.trim() ? `${requester.name.trim()} (${requester.email})` : requester.email) : 'a member who has since been removed'
    const current = normalizeMemberAddress(member.email)
    const stillPending = await db.select({ newEmail: emailChanges.newEmail }).from(emailChanges).where(eq(emailChanges.userId, row.userId)).get()
    // The commit's own event is the record that the change took effect.
    const committed = await db.select({ id: authEvents.id }).from(authEvents).where(and(
      eq(authEvents.userId, row.userId),
      eq(authEvents.event, 'email_change_confirmed'),
      eq(authEvents.email, row.newEmail),
      eq(authEvents.reason, row.oldEmail),
    )).get()
    const { subject, html, text } = renderEmailChangeReportedEmail({
      appUrl: env.APP_URL,
      instanceName: (await resolveAssocName(env, db)) ?? '',
      memberName: member.name || member.email,
      memberEmail: member.email,
      oldEmail: row.oldEmail,
      newEmail: row.newEmail,
      requestedBy,
      requestedAt: whenText(row.requestedAt),
      current: current === normalizeMemberAddress(row.oldEmail) ? 'old' : current === normalizeMemberAddress(row.newEmail) ? 'new' : 'other',
      currentEmail: member.email,
      changeCommitted: !!committed,
      cancelledTo,
      stillPendingTo: stillPending?.newEmail ?? null,
    })
    const messages: EmailMessage[] = recipients.map(r => ({ to: [r.email], subject, html, text }))
    const { sent } = await sendBatch(env, messages, 'email-change-reported', db)
    if (sent < messages.length) console.error(`[email-change] ${messages.length - sent} of ${messages.length} report alerts did not go out`)
    return sent > 0
  } catch (e) {
    console.error('[email-change] the report alert failed', e)
    return false
  }
}
