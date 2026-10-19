import { and, eq, isNull, ne, or, sql } from 'drizzle-orm'
import type { AppDb, Env } from '../types'
import { users, sessions, magicLinks, emailChanges } from '../db/schema'
import { generateToken, hashToken } from './crypto'
import { checkMemberAddresses, normalizeMemberAddress } from './memberAddress'
import { isPreviouslyBounced } from './bouncedAddresses'
import { superadminEmailStatus } from './superadminCentral'
import { claimSend, releaseSend, adminSendChecks, type SendCheck, type SendLimit } from './adminSendLimits'
import { recordAuthEvent } from './authEvents'
import { senderFor, resolveAssocName } from './email'
import type { SendResult } from '../../../shared/emailSender'
import { renderEmailChangeConfirmEmail, renderEmailChangeNoticeEmail } from './emailChangeEmail'
import { issueNotMeToken, notMeUrl } from './emailChangeReport'

// Changing a member's sign-in email. The address is the member's identity, so
// a change takes effect only when someone confirms it from the NEW address,
// and the OLD address hears about it twice: at request and at commit.
//
// A request makes a pending change (table email_changes, one per member) and
// mails a single-use link to the new address. The link opens a page whose
// button posts the token here; loading the page changes nothing, because mail
// scanners prefetch links. The token is stored hashed, lasts 24 hours, can
// confirm only its own pending change, and never signs anyone in.
//
// The commit re-checks every rule and that the member is still active with the
// address they had at request, then in one batch writes the address, deletes
// the member's unused sign-in links, ends their other sessions, and removes the
// pending change (spending the token) along with any other member's pending
// change to the same address. Each step is recorded in auth_events.
//
// Who may request is the caller's business, except that the commit re-checks
// an admin's standing (mayChangeEmail). The self-service route asks for the
// signed-in member's own address and keeps their session at commit. An admin's
// request (the requester is not the member, #416) goes through the same
// functions: it has no session to keep, so every session ends at commit, it
// counts against the admin send limits as well, and its refusals and link pages
// say "they" and "an admin" where the member's own say "you".

/** How long a confirmation link lasts. */
export const EMAIL_CHANGE_TTL_HOURS = 24

/**
 * Requests per member in a rolling day, counted apart for the member's own and
 * for admins', so neither can use up the other's.
 */
export const EMAIL_CHANGE_LIMIT: SendLimit = { max: 3, windowMinutes: 24 * 60 }

export const EMAIL_CHANGE_ERRORS = {
  invalid: "That doesn't look like a valid email address.",
  unchanged: "That's already your email address.",
  inUse: 'That address is already used by another member.',
  bounced: 'Email to that address has bounced before. Check it for a typo, or use a different address.',
  reserved: "That address can't be used here.",
  superadmin: "Your address is managed centrally, so it can't be changed here.",
  limit: "You've asked to change your email three times in the past day. Please try again tomorrow.",
  adminPending: 'An admin has an email change pending for your account.',
  sendFailed: "We couldn't send the confirmation email. Please try again in a little while.",
  cannotReceive: "That address can't receive email. Check it for a typo, or use a different address.",
  centralUnavailable: "Can't check this address right now. Try again in a few minutes.",
  // Confirming
  invalidLink: 'This link is no longer valid. It may have been used already, or replaced by a newer request.',
  expiredLink: 'This link has expired. Request the change again from your Account page.',
  stale: "This change can't be completed because the account changed after it was requested. Request it again from your Account page.",
} as const

/**
 * The wording of the refusals and link pages that differs when an admin, not
 * the member, asked for the change. Keys not listed read the same either way.
 */
export const ADMIN_EMAIL_CHANGE_ERRORS: Partial<Record<keyof typeof EMAIL_CHANGE_ERRORS, string>> = {
  unchanged: "That's already their address. Check it for a typo.",
  superadmin: "This account's address is managed centrally, so it can't be changed here.",
  limit: "A change to this member's email was requested three times in the past day. Please try again tomorrow.",
  expiredLink: 'This link has expired. Ask the admin who requested the change to request it again.',
  stale: "This change can't be completed because the account changed after it was requested. Ask the admin who requested it to request it again.",
}

/** The message for `key`, in the admin's wording when an admin asked. */
export function emailChangeError(key: keyof typeof EMAIL_CHANGE_ERRORS, byAdmin: boolean): string {
  return (byAdmin && ADMIN_EMAIL_CHANGE_ERRORS[key]) || EMAIL_CHANGE_ERRORS[key]
}

/**
 * Who may change whose address: owners anyone, admins Standard members, no one
 * else. Superadmin accounts are out of reach of every path (see refuseSuperadmin).
 */
export function mayChangeEmail(actor: { role: string }, target: { role: string }): boolean {
  return actor.role === 'owner' || (actor.role === 'admin' && target.role === 'member')
}

/**
 * An admin's email-change requests also count against the admin send caps
 * (#418), with the same numbers as invites and sign-in links but tallied apart
 * from them: claimSend counts rows of its own event, here email_change_requested.
 * So the refusals say what was limited, not "invites and sign-in links".
 */
const ADMIN_EMAIL_CHANGE_LIMIT_MESSAGES = {
  actor_id: "You've asked to change a lot of members' email addresses in the past hour. Please wait a little while before asking again.",
  user_id: "A change to this member's email was requested several times in the past hour. Please try again in a little while.",
  email: 'That address was sent several email-change confirmations in the past hour. Ask the person to check their spam folder, or try again in a little while.',
} as const

function adminEmailChangeChecks(adminId: string, memberId: string, address: string): SendCheck[] {
  return adminSendChecks(adminId, memberId, address).map(ch => ({ ...ch, message: ADMIN_EMAIL_CHANGE_LIMIT_MESSAGES[ch.column] }))
}

export type Refusal = { ok: false; status: 400 | 403 | 404 | 409 | 410 | 429 | 502 | 503; error: string }

/** Where a confirmation link leads: the page with the Confirm new email button. */
export function confirmUrl(appUrl: string, rawToken: string): string {
  return `${appUrl}/auth/confirm-email?token=${encodeURIComponent(rawToken)}`
}

/**
 * Central's superadmin list couldn't be read (a cold isolate during a central
 * outage). The guards here refuse rather than assume "not a superadmin", and a
 * pending change refused this way at commit stays pending for a retry.
 */
const CENTRAL_UNAVAILABLE: Refusal = { ok: false, status: 503, error: EMAIL_CHANGE_ERRORS.centralUnavailable }

/**
 * The rules a new address must pass, at request and again at commit. Lowercased
 * and trimmed, then: the shared validity rule, not the member's current
 * address, not any other member's (deactivated included, ignoring case), not on
 * central's superadmin list, and not a previously bounced address.
 */
export async function checkNewAddress(
  env: Env,
  db: AppDb,
  member: { id: string; email: string },
  raw: unknown,
  byAdmin = false,
): Promise<{ ok: true; email: string } | Refusal> {
  const [check] = await checkMemberAddresses(db, [typeof raw === 'string' ? raw : ''])
  if (check.status === 'invalid') return { ok: false, status: 400, error: EMAIL_CHANGE_ERRORS.invalid }
  if (check.email === normalizeMemberAddress(member.email)) return { ok: false, status: 400, error: emailChangeError('unchanged', byAdmin) }
  if (check.status === 'taken') return { ok: false, status: 409, error: EMAIL_CHANGE_ERRORS.inUse }
  const listed = await superadminEmailStatus(env, check.email)
  if (listed === 'unknown') return CENTRAL_UNAVAILABLE
  if (listed === 'yes') return { ok: false, status: 400, error: EMAIL_CHANGE_ERRORS.reserved }
  if (await isPreviouslyBounced(env, db, check.email)) return { ok: false, status: 400, error: EMAIL_CHANGE_ERRORS.bounced }
  return { ok: true, email: check.email }
}

type RequestContext = { userAgent: string | null; ipCountry: string | null }

/**
 * Send by the account purpose: it falls back to the second provider, counts
 * toward email health, and a demo instance never sends it (the purpose's rule
 * says so, so there is no check here). A permanent failure means the address
 * can't receive mail, and anything else is an outage worth trying again.
 */
async function send(env: Env, db: AppDb, message: { to: string[]; subject: string; html: string; text?: string }, tag: string): Promise<SendResult> {
  const r = await senderFor(env, db).send({ purpose: 'account', ...message })
  if (!r.ok) console.error(`[${tag}] not sent (${r.permanent ? 'permanent' : 'temporary'}): ${r.error}`)
  return r
}

/**
 * Tell the old address, with a "This wasn't me" link of its own (see
 * emailChangeReport.ts). Runs after the request or the commit has already
 * happened, so a failure here is logged and never turned into an error for a
 * change that took effect.
 */
async function noticeToOldAddress(
  env: Env,
  db: AppDb,
  stage: 'requested' | 'changed',
  change: { id: string; userId: string; oldEmail: string; newEmail: string; requestedBy: string; requestedAt?: string },
) {
  const byAdmin = change.requestedBy !== change.userId
  try {
    const rawToken = await issueNotMeToken(db, change)
    const { subject, html, text } = renderEmailChangeNoticeEmail({
      stage, byAdmin, appUrl: env.APP_URL, instanceName: (await resolveAssocName(env, db)) ?? '', newEmail: change.newEmail,
      notMeUrl: notMeUrl(env.APP_URL, rawToken),
    })
    if (!(await send(env, db, { to: [change.oldEmail], subject, html, text }, `email-change-notice-${stage}`)).ok) {
      console.error(`[email-change] the ${stage} notice to the old address did not go out`)
    }
  } catch (e) {
    console.error(`[email-change] the ${stage} notice to the old address failed`, e)
  }
}

/**
 * A superadmin's identity is central's (#370), so their address never changes
 * here. Checked by the address the member holds, at request and again at
 * commit, so no path in (the member's own, an admin's later) can skip it and a
 * change pending while the address joined central's list cannot commit.
 */
export async function refuseSuperadmin(env: Env, currentEmail: string, byAdmin: boolean): Promise<Refusal | null> {
  const listed = await superadminEmailStatus(env, currentEmail)
  if (listed === 'unknown') return CENTRAL_UNAVAILABLE
  return listed === 'yes' ? { ok: false, status: 403, error: emailChangeError('superadmin', byAdmin) } : null
}

async function recordCancelled(
  db: AppDb,
  rows: { userId: string; oldEmail: string; newEmail: string }[],
  actorId: string | null,
  ctx?: RequestContext,
) {
  for (const r of rows) {
    await recordAuthEvent(db, {
      event: 'email_change_cancelled', userId: r.userId, email: r.newEmail, reason: r.oldEmail, actorId, ...ctx,
    })
  }
}

/**
 * Start a change of `member`'s address to `rawNewEmail`, asked for by
 * `requesterId`. Validates, counts against the daily limit, replaces any
 * pending change (recording it cancelled), and sends the confirmation and the
 * notice to the current address. The member's own request is refused while a
 * change an admin started is live.
 */
export async function requestEmailChange(
  env: Env,
  db: AppDb,
  input: {
    member: { id: string; email: string }
    requesterId: string
    /** The session to keep signed in at commit; null ends them all (an admin's request has none). */
    sessionId: string | null
    rawNewEmail: unknown
    ctx: RequestContext
  },
): Promise<{ ok: true; email: string } | Refusal> {
  const { member } = input
  const byAdmin = input.requesterId !== member.id
  const superadmin = await refuseSuperadmin(env, member.email, byAdmin)
  if (superadmin) return superadmin
  const check = await checkNewAddress(env, db, member, input.rawNewEmail, byAdmin)
  if (!check.ok) return check
  const newEmail = check.email

  // Last, so a request refused above uses none of the allowance. The claim is
  // the request's own email_change_requested event (see adminSendLimits.ts).
  const claim = await claimSend(
    env.DB,
    {
      event: 'email_change_requested', userId: member.id, email: newEmail, reason: member.email,
      linkType: null, actorId: input.requesterId, ...input.ctx,
    },
    [
      {
        column: 'user_id', value: member.id, limit: EMAIL_CHANGE_LIMIT, message: emailChangeError('limit', byAdmin),
        requester: byAdmin ? 'others' : 'member',
      },
      // An admin's request also counts against the admin send limits (#418).
      ...(byAdmin ? adminEmailChangeChecks(input.requesterId, member.id, newEmail) : []),
    ],
  )
  if (!claim.ok) return { ok: false, status: 429, error: claim.message }

  const rawToken = await generateToken()
  const id = crypto.randomUUID()
  // One batch: the previous pending change goes as this one arrives, so there
  // is never more than one and the latest request wins. Except that the
  // member's own request never replaces a live change an admin started: that
  // change is how an admin moves a taken-over account back to its owner ("This
  // wasn't me" leaves it pending for the same reason), and whoever holds the
  // account must not cancel it by asking for their own. Such a change survives
  // the delete, so the insert hits the one-per-member index and does nothing.
  const [replaced, inserted] = await db.batch([
    db.delete(emailChanges).where(and(
      eq(emailChanges.userId, member.id),
      byAdmin ? undefined : or(
        eq(emailChanges.requestedBy, member.id),
        sql`datetime(${emailChanges.expiresAt}) <= datetime('now')`,
      ),
    )).returning({ userId: emailChanges.userId, oldEmail: emailChanges.oldEmail, newEmail: emailChanges.newEmail }),
    db.insert(emailChanges).values({
      id,
      userId: member.id,
      oldEmail: member.email,
      newEmail,
      requestedBy: input.requesterId,
      requestingSessionId: input.sessionId,
      tokenHash: await hashToken(rawToken),
      expiresAt: sql`datetime('now', ${`+${EMAIL_CHANGE_TTL_HOURS} hours`})`,
    }).onConflictDoNothing({ target: emailChanges.userId }).returning({ id: emailChanges.id }),
  ])
  if (inserted.length === 0) {
    // Nothing was sent, so the request uses none of the allowance.
    await releaseSend(env.DB, claim.id)
    return { ok: false, status: 409, error: EMAIL_CHANGE_ERRORS.adminPending }
  }
  await recordCancelled(db, replaced, input.requesterId, input.ctx)

  const instanceName = (await resolveAssocName(env, db)) ?? ''
  const confirmation = renderEmailChangeConfirmEmail({ appUrl: env.APP_URL, instanceName, confirmUrl: confirmUrl(env.APP_URL, rawToken) })
  const sentConfirmation = await send(env, db, { to: [newEmail], ...confirmation }, 'email-change-confirm')
  if (!sentConfirmation.ok) {
    // Nobody can confirm a change whose link never went out, so it goes. The
    // claim stays and still counts: a failed send may have reached the inbox.
    await db.delete(emailChanges).where(eq(emailChanges.id, id))
    // A permanent failure is about the address, which retrying can't fix: say
    // so. Anything else is an outage on both providers: say to try again.
    return sentConfirmation.permanent
      ? { ok: false, status: 400, error: EMAIL_CHANGE_ERRORS.cannotReceive }
      : { ok: false, status: 502, error: EMAIL_CHANGE_ERRORS.sendFailed }
  }

  await noticeToOldAddress(env, db, 'requested', {
    id, userId: member.id, oldEmail: member.email, newEmail, requestedBy: input.requesterId,
  })
  return { ok: true, email: newEmail }
}

type PendingRow = typeof emailChanges.$inferSelect

/** The pending change a raw token names, and whether it is still in date. */
async function pendingFor(db: AppDb, rawToken: string): Promise<{ row: PendingRow; live: boolean } | null> {
  const row = await db
    .select({ row: emailChanges, live: sql<number>`datetime(${emailChanges.expiresAt}) > datetime('now')` })
    .from(emailChanges)
    .where(eq(emailChanges.tokenHash, await hashToken(rawToken)))
    .get()
  return row ? { row: row.row, live: row.live === 1 } : null
}

/**
 * What a confirmation link would do, without doing it. Writes nothing. The
 * new address rides along only while the link is live: whoever holds it reads
 * the inbox it was sent to.
 */
export async function emailChangeLinkStatus(db: AppDb, rawToken: string): Promise<
  { status: 'valid'; email: string; byAdmin?: true } | { status: 'expired'; byAdmin?: true } | { status: 'invalid' }
> {
  const found = await pendingFor(db, rawToken)
  if (!found) return { status: 'invalid' }
  // `byAdmin` (only ever true) lets the page say an admin asked, and not to
  // go to an Account page the member may not be able to sign in to.
  const byAdmin = found.row.requestedBy !== found.row.userId ? { byAdmin: true as const } : {}
  if (!found.live) return { status: 'expired', ...byAdmin }
  return { status: 'valid', email: found.row.newEmail, ...byAdmin }
}

/** Drop a pending change that can no longer go through, recording why it went. */
async function cancelPending(db: AppDb, row: PendingRow, why: string) {
  const gone = await db.delete(emailChanges).where(eq(emailChanges.id, row.id)).returning({ id: emailChanges.id })
  if (gone.length === 0) return
  console.log(JSON.stringify({ tag: 'email_change_cancelled', userId: row.userId, why }))
  await recordCancelled(db, [row], null)
}

const isUniqueViolation = (e: unknown) =>
  /UNIQUE constraint failed/i.test(`${e} ${(e as { cause?: unknown })?.cause ?? ''}`)

/**
 * Commit the pending change a confirmation token names. One step: every rule
 * re-checked, then the address, the sign-in links, the sessions, and the
 * pending changes in one batch. Never signs anyone in.
 */
export async function confirmEmailChange(
  env: Env,
  db: AppDb,
  rawToken: string,
  ctx: RequestContext,
): Promise<{ ok: true; email: string; byAdmin?: true } | Refusal> {
  const found = await pendingFor(db, rawToken)
  if (!found) return { ok: false, status: 404, error: EMAIL_CHANGE_ERRORS.invalidLink }
  const { row } = found
  const byAdmin = row.requestedBy !== row.userId
  if (!found.live) return { ok: false, status: 410, error: emailChangeError('expiredLink', byAdmin) }
  const stale: Refusal = { ok: false, status: 409, error: emailChangeError('stale', byAdmin) }

  // The member must still be active, at the address the change started from.
  const memberRow = await db
    .select({ id: users.id, email: users.email, role: users.role, deactivatedAt: users.deactivatedAt })
    .from(users).where(eq(users.id, row.userId)).get()
  if (!memberRow || memberRow.deactivatedAt || memberRow.email !== row.oldEmail) {
    await cancelPending(db, row, 'stale')
    return stale
  }

  // An admin's change needs the admin to still hold the standing to ask for
  // it: they may have been demoted, removed, or the member promoted since, and
  // whoever holds the new inbox must not be moved on authority that is gone.
  if (byAdmin) {
    const requester = await db
      .select({ role: users.role, deactivatedAt: users.deactivatedAt })
      .from(users).where(eq(users.id, row.requestedBy)).get()
    if (!requester || requester.deactivatedAt || !mayChangeEmail(requester, memberRow)) {
      await cancelPending(db, row, 'requester no longer allowed')
      return stale
    }
  }

  // A superadmin's address is central's to manage. It may have joined the list since.
  const superadmin = await refuseSuperadmin(env, memberRow.email, byAdmin)
  if (superadmin) {
    if (superadmin !== CENTRAL_UNAVAILABLE) await cancelPending(db, row, superadmin.error)
    return superadmin
  }

  // Every rule again: the address may have been taken, bounced, or listed since.
  const check = await checkNewAddress(env, db, memberRow, row.newEmail, byAdmin)
  if (!check.ok) {
    if (check !== CENTRAL_UNAVAILABLE) await cancelPending(db, row, check.error)
    return check
  }
  const newEmail = check.email

  // The update repeats the checks that a concurrent request could break: the
  // pending change still exists and is in date (spending a token twice fails
  // here), the member is still active at the old address, and no other member
  // holds the address in any case. The unique index on users.email backs the
  // last one up.
  //
  // `moved` gates the session and sign-in-link deletes: they run only for the
  // press that moved the address. "The address is now the new one" is not
  // enough, because a second press that raced the first is still true of it
  // after the first commits, and would end the sign-ins made since. So they
  // also require the pending change to still exist. They run before the batch
  // deletes it, so for the winner it does, and for the loser it no longer does.
  const changed = sql`(SELECT email FROM users WHERE id = ${row.userId}) = ${newEmail}`
  const moved = sql`${changed} AND EXISTS (SELECT 1 FROM email_changes WHERE id = ${row.id})`
  const keep = row.requestingSessionId
  // An admin's change also needs the admin to still hold the standing to ask
  // for it at the moment of the write, not only when it was checked above: a
  // role change landing in between must not slip through.
  const requesterStanding = row.requestedBy === row.userId
    ? sql`1`
    : sql`EXISTS (SELECT 1 FROM users r WHERE r.id = ${row.requestedBy} AND r.deactivated_at IS NULL
        AND (r.role = 'owner' OR (r.role = 'admin' AND (SELECT role FROM users WHERE id = ${row.userId}) = 'member')))`
  let updated: { id: string }[]
  let others: { userId: string; oldEmail: string; newEmail: string }[]
  try {
    ;[updated, , , others] = await db.batch([
      db.update(users).set({ email: newEmail }).where(and(
        eq(users.id, row.userId),
        eq(users.email, row.oldEmail),
        isNull(users.deactivatedAt),
        requesterStanding,
        sql`NOT EXISTS (SELECT 1 FROM users other WHERE lower(other.email) = ${newEmail} AND other.id != ${row.userId})`,
        sql`EXISTS (SELECT 1 FROM email_changes WHERE id = ${row.id} AND datetime(expires_at) > datetime('now'))`,
      )).returning({ id: users.id }),
      db.delete(magicLinks).where(and(eq(magicLinks.userId, row.userId), isNull(magicLinks.usedAt), moved)),
      db.delete(sessions).where(and(eq(sessions.userId, row.userId), keep ? ne(sessions.id, keep) : undefined, moved)),
      // This change (spending its token) and any other member's change to the
      // same address, which could never go through now. Gated on `changed`
      // alone: it deletes only pending changes, which a loser may harmlessly
      // find already gone.
      db.delete(emailChanges).where(and(
        or(eq(emailChanges.id, row.id), eq(emailChanges.newEmail, newEmail)),
        changed,
      )).returning({ userId: emailChanges.userId, oldEmail: emailChanges.oldEmail, newEmail: emailChanges.newEmail }),
    ])
  } catch (e) {
    if (!isUniqueViolation(e)) throw e
    await cancelPending(db, row, 'taken at commit')
    return { ok: false, status: 409, error: EMAIL_CHANGE_ERRORS.inUse }
  }

  if (updated.length === 0) {
    // Lost a race. Spent by a parallel confirm, or the account or the address
    // changed between the checks above and the batch.
    const still = await pendingFor(db, rawToken)
    if (!still) return { ok: false, status: 404, error: EMAIL_CHANGE_ERRORS.invalidLink }
    if (!still.live) return { ok: false, status: 410, error: emailChangeError('expiredLink', byAdmin) }
    const recheck = await checkNewAddress(env, db, { id: row.userId, email: row.oldEmail }, row.newEmail, byAdmin)
    await cancelPending(db, row, recheck.ok ? 'stale' : recheck.error)
    return recheck.ok ? stale : recheck
  }

  await recordAuthEvent(db, {
    event: 'email_change_confirmed', userId: row.userId, email: newEmail, reason: row.oldEmail, actorId: row.requestedBy, ...ctx,
  })
  await recordCancelled(db, others.filter(o => o.userId !== row.userId), null)
  await noticeToOldAddress(env, db, 'changed', {
    id: row.id, userId: row.userId, oldEmail: row.oldEmail, newEmail, requestedBy: row.requestedBy, requestedAt: row.createdAt,
  })
  return { ok: true, email: newEmail, ...(byAdmin ? { byAdmin: true as const } : {}) }
}

