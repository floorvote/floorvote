import type { AuthEventType } from './authEvents'

// Limits on the admin routes that email a member: resend invite, resend
// sign-in link, and change a pending invite's address. The limits live here
// and nowhere else. claimSend is also how email-change requests are counted
// (lib/emailChange.ts, with its own event and limit).
//
// Counted from auth_events, not a Workers Rate Limiting binding. That binding
// can only count over 10 or 60 seconds, which cannot say "a few resends an
// hour", and without the binding declared (an upgrade step for every
// self-hoster) it fails open, which would leave these routes unprotected.
// Every send already records a link_requested row, so the count needs no new
// table. Admin sends record the admin as the row's actor_id, which is also how
// they are told apart from a member's own sign-in requests.
//
// The check and the record are ONE statement (claimSend). A count followed by
// a separate write lets parallel requests all read the same count and all go
// through. The row it writes is the send's own link_requested event, so a
// send is allowed exactly when its row landed. D1 runs one statement at a
// time per database, which is what makes that atomic.
//
// If the email then fails to go out, the row stays and still counts. Failing
// closed is deliberate: a send that errors may still have reached the inbox,
// and a limit that forgave failures would let a flood retry freely. If the
// write itself errors, claimSend throws and nothing is sent.

export interface SendLimit {
  /** The most sends allowed in the window. The one after it is refused. */
  max: number
  windowMinutes: number
}

export const ADMIN_SEND_LIMITS = {
  // One member, from every admin together. Sized to the sign-in form's cap of
  // five active links: enough to resend a couple of times and fix a typo, not
  // enough to pile mail onto one account.
  perMember: { max: 5, windowMinutes: 60 } satisfies SendLimit,
  // One inbox, whichever member it is attached to. Without this an admin can
  // rotate an address through several pending invites and stay under the
  // per-member limit every time. Like the per-member limit, it counts only
  // admin sends: the public sign-in form has its own cap, and its requests
  // must not stop an admin resending to someone whose mail isn't arriving.
  perAddress: { max: 5, windowMinutes: 60 } satisfies SendLimit,
  // One admin, across all members. Leaves room for working through a long list
  // of pending invites in one sitting, while a stolen or runaway session stops
  // at a few dozen messages rather than thousands.
  perAdmin: { max: 50, windowMinutes: 60 } satisfies SendLimit,
}

export const ADMIN_SEND_LIMIT_MESSAGES = {
  perMember: 'This member was sent several invites or sign-in links in the past hour. Ask them to check their spam folder, or try again in a little while.',
  perAddress: 'That address was sent several invites or sign-in links in the past hour. Ask the person to check their spam folder, or try again in a little while.',
  perAdmin: "You've sent a lot of invites and sign-in links in the past hour. Please wait a little while before sending more.",
} as const

/**
 * One limit: at most `limit.max` rows of the claim's event with `column` equal
 * to `value` inside the window. `column` is a fixed set, never user input.
 * `byAdminsOnly` leaves out rows with no actor_id, so a member's own sign-in
 * requests don't count against an admin helping them. `requester` counts only
 * the rows whose actor is the member (`member`) or someone else (`others`).
 */
export interface SendCheck {
  column: 'actor_id' | 'user_id' | 'email'
  value: string
  limit: SendLimit
  message: string
  byAdminsOnly?: boolean
  requester?: 'member' | 'others'
}

/** The auth_events row a send writes. `email` is the address the send goes to. */
export interface SendClaim {
  event: AuthEventType
  userId: string
  email: string
  /** Null for a send that isn't a sign-in link, such as an email-change confirmation. */
  linkType: 'login' | 'invite' | null
  reason?: string | null
  actorId?: string | null
  userAgent?: string | null
  ipCountry?: string | null
}

export type ClaimResult = { ok: true; id: string } | { ok: false; message: string }

/**
 * The checks for an admin's email to one member's address. The address is
 * compared lowercased (and `claimSend` writes it lowercased) so the index on
 * (email, created_at) serves it.
 */
export function adminSendChecks(adminId: string, memberId: string, address: string): SendCheck[] {
  return [
    { column: 'actor_id', value: adminId, limit: ADMIN_SEND_LIMITS.perAdmin, message: ADMIN_SEND_LIMIT_MESSAGES.perAdmin },
    { column: 'user_id', value: memberId, limit: ADMIN_SEND_LIMITS.perMember, message: ADMIN_SEND_LIMIT_MESSAGES.perMember, byAdminsOnly: true },
    { column: 'email', value: address.toLowerCase(), limit: ADMIN_SEND_LIMITS.perAddress, message: ADMIN_SEND_LIMIT_MESSAGES.perAddress, byAdminsOnly: true },
  ]
}

const REQUESTER_SQL = { member: ' AND actor_id = user_id', others: ' AND actor_id != user_id' } as const
const countSql = (check: SendCheck) =>
  `(SELECT count(*) FROM auth_events WHERE event = ? AND ${check.column} = ?${check.byAdminsOnly ? ' AND actor_id IS NOT NULL' : ''}`
  + `${check.requester ? REQUESTER_SQL[check.requester] : ''} AND created_at > datetime('now', ?))`
const countBinds = (event: string, check: SendCheck) =>
  [event, check.value, `-${check.limit.windowMinutes} minutes`]

/**
 * Record the send's event only if every check still has room, in one
 * statement. Returns the new row's id when it is allowed. When it is refused,
 * the message of the first limit that was full.
 */
export async function claimSend(d1: D1Database, claim: SendClaim, checks: SendCheck[]): Promise<ClaimResult> {
  const id = crypto.randomUUID()
  const address = claim.email.toLowerCase()
  const room = checks.map(ch => `${countSql(ch)} < ?`).join(' AND ')
  const res = await d1
    .prepare(
      `INSERT INTO auth_events (id, user_id, email, event, link_type, reason, user_agent, ip_country, actor_id)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${room}`,
    )
    .bind(
      id, claim.userId, address, claim.event, claim.linkType, claim.reason ?? null, claim.userAgent ?? null, claim.ipCountry ?? null, claim.actorId ?? null,
      ...checks.flatMap(ch => [...countBinds(claim.event, ch), ch.limit.max]),
    )
    .run()

  if (res.meta.changes === 1) {
    // Same trail recordAuthEvent leaves, for the row this wrote instead.
    console.log(JSON.stringify({ tag: 'auth_event', event: claim.event, email: address, userId: claim.userId, linkType: claim.linkType, actorId: claim.actorId ?? null }))
    return { ok: true, id }
  }

  // Refused. Name the limit that was full (the first, in the checks' order).
  for (const ch of checks) {
    const row = await d1.prepare(`SELECT ${countSql(ch)} AS n`).bind(...countBinds(claim.event, ch)).first<{ n: number }>()
    if ((row?.n ?? 0) >= ch.limit.max) return { ok: false, message: ch.message }
  }
  // Room opened up between the two statements (a window rolled over). The
  // request was refused all the same, so name the first limit.
  return { ok: false, message: checks[0].message }
}

/**
 * Give back a claim whose send never started (e.g. the change it belonged to
 * lost a race), so the history doesn't show an email that was not sent. Not
 * for sends that failed in flight: those stay counted (see the top of this file).
 */
export async function releaseSend(d1: D1Database, id: string): Promise<void> {
  await d1.prepare('DELETE FROM auth_events WHERE id = ?').bind(id).run()
}
