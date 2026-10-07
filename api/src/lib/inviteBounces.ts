import { and, eq, gte, inArray, isNotNull, or, sql } from 'drizzle-orm'
import type { Env, AppDb } from '../types'
import { authEvents, users } from '../db/schema'
import { pendingInviteWhere } from './pendingInvite'
import { recordAuthEvent } from './authEvents'
import { toDbTs } from './dbTime'
import { centralEmail, type DeliveryStatus } from './centralEmail'

/** Lifetime of an invite link; older sends to a pending invite aren't checked. */
export const BOUNCE_CHECK_WINDOW_DAYS = 7

/** How far before the oldest send the delivery lookup's window opens. */
const LOOKUP_MARGIN_MS = 15 * 60_000

/** A bounce this run recorded, for anything that reports it (e.g. the inviter email). */
export type RecordedBounce = {
  memberId: string
  /** The address the bounced email was sent to. */
  email: string
  /** The provider's error cause, or its status when it gave none. */
  reason: string
  /** Who invited the member. Every pending invite has an inviter. */
  inviterId: string
  messageId: string
}

/**
 * Cloudflare Email Sending's final statuses (emailSendingAdaptive `status`).
 * `deliveryFailed` covers a hard bounce and a soft bounce whose retries ran out;
 * `rejected` means the recipient is on the suppression list. Anything else
 * (`sent`, a deferral, a status Cloudflare adds later) is still in progress or
 * unknown, so it writes nothing and the email is checked again next hour.
 */
export function classifyDeliveryStatus(status: string): 'bounced' | 'delivered' | null {
  if (status === 'delivered') return 'delivered'
  if (status === 'deliveryFailed' || status === 'rejected') return 'bounced'
  return null
}

/**
 * Hourly: ask central for the delivery outcome of invite and sign-in emails sent
 * to pending invites in the last 7 days that have no recorded outcome yet, and
 * record `email_bounced` / `email_delivered`. The recorded row is the marker
 * that the email is settled, so each outcome is recorded (and returned) once.
 *
 * Only Cloudflare sends are checked: a Resend fallback send has no Cloudflare
 * delivery record. Only sends to the member's current address are checked: a
 * bounce of an address they no longer have is nothing to act on. That is
 * matched on the address rather than on the time of the latest
 * `email_changed`, so it holds however the address changed and doesn't hang
 * on a same-second tie between a change and the send that follows it.
 *
 * Never throws on a failed or unavailable lookup — it writes nothing and the
 * next run retries. Returns the bounces recorded by this run.
 */
export async function runInviteBounceCheck(env: Pick<Env, 'CENTRAL'>, db: AppDb, now: Date = new Date()): Promise<RecordedBounce[]> {
  const since = new Date(now.getTime() - BOUNCE_CHECK_WINDOW_DAYS * 86400_000)
  const pending = await db
    .select({
      memberId: authEvents.userId,
      email: authEvents.email,
      linkType: authEvents.linkType,
      messageId: authEvents.messageId,
      inviterId: users.invitedBy,
      sentAt: authEvents.createdAt,
    })
    .from(authEvents)
    .innerJoin(users, eq(users.id, authEvents.userId))
    .where(and(
      eq(authEvents.event, 'email_sent'),
      eq(authEvents.provider, 'cloudflare'),
      inArray(authEvents.linkType, ['invite', 'login']),
      isNotNull(authEvents.messageId),
      gte(authEvents.createdAt, toDbTs(since)),
      pendingInviteWhere(db),
      sql`lower(${authEvents.email}) = lower(${users.email})`,
      sql`NOT EXISTS (
        SELECT 1 FROM auth_events o
        WHERE o.user_id = ${authEvents.userId} AND o.message_id = ${authEvents.messageId}
          AND o.event IN ('email_bounced', 'email_delivered')
      )`,
    ))
    .all()

  const byMessage = new Map<string, (typeof pending)[number]>()
  for (const row of pending) if (row.messageId && !byMessage.has(row.messageId)) byMessage.set(row.messageId, row)
  if (byMessage.size === 0) return []

  // Central's lookup returns at most 10,000 messages, newest first, so the
  // window starts near the oldest send asked about rather than a fixed 7 days
  // back: a longer window could crowd that send out of the results. It opens a
  // margin early because the provider can log an outcome before the send's row
  // is written (a recipient server that rejects at once), and that row's time
  // is cut to the whole second.
  const oldestSentAt = pending.reduce((min, r) => (r.sentAt < min ? r.sentAt : min), pending[0].sentAt)
  const lookupSince = new Date(new Date(`${oldestSentAt.replace(' ', 'T')}Z`).getTime() - LOOKUP_MARGIN_MS)

  const central = centralEmail(env)
  if (!central.emailDeliveryStatus) return []
  let delivery: unknown
  try {
    delivery = await central.emailDeliveryStatus([...byMessage.keys()], lookupSince.toISOString())
  } catch (err) {
    console.error('[invite-bounces] delivery lookup failed; retrying next run', err)
    return []
  }
  if (!delivery || typeof delivery !== 'object') return []

  const bounces: RecordedBounce[] = []
  for (const [messageId, row] of byMessage) {
    const entry = (delivery as Record<string, DeliveryStatus | undefined>)[messageId]
    if (!entry || typeof entry.status !== 'string') continue
    const outcome = classifyDeliveryStatus(entry.status)
    if (!outcome) continue
    const reason = outcome === 'bounced' ? (entry.errorCause || entry.status) : null
    const recorded = await recordAuthEvent(db, {
      event: outcome === 'bounced' ? 'email_bounced' : 'email_delivered',
      email: row.email, userId: row.memberId, reason,
      linkType: row.linkType as 'invite' | 'login', provider: 'cloudflare', messageId,
    })
    if (outcome === 'bounced' && recorded) {
      bounces.push({ memberId: row.memberId!, email: row.email, reason: reason!, inviterId: row.inviterId!, messageId })
    }
  }
  return bounces
}

/**
 * Bounce state per pending invite: set when their latest invite or sign-in
 * email, by send time, bounced. A send is an `email_sent` row, or an
 * `email_bounced` row with no message id (the provider refused a suppressed
 * address at send time). A sent email counts as bounced once the hourly check
 * records `email_bounced` for its message id; a newer send with no outcome
 * yet clears the state. So does an `email_changed` row: whatever bounced went
 * to the old address, so the state stays clear until the new address's own
 * send bounces, even while that send is queued or if it fails to go out.
 */
export async function pendingInviteBounces(db: AppDb): Promise<Map<string, { reason: string | null }>> {
  const rows = await db
    .select({
      userId: authEvents.userId,
      event: authEvents.event,
      reason: authEvents.reason,
      messageId: authEvents.messageId,
    })
    .from(authEvents)
    .innerJoin(users, eq(users.id, authEvents.userId))
    .where(and(
      or(
        and(inArray(authEvents.event, ['email_sent', 'email_bounced']), inArray(authEvents.linkType, ['invite', 'login'])),
        eq(authEvents.event, 'email_changed'),
      ),
      pendingInviteWhere(db),
    ))
    // created_at has one-second precision; rowid (insertion order) breaks a
    // same-second tie, such as a quick resend, so "latest" is always defined.
    .orderBy(authEvents.createdAt, sql`auth_events.rowid`)
    .all()

  type Latest = { messageId: string | null; reason: string | null; bounced: boolean }
  const latestByUser = new Map<string, Latest>()
  const bounceByMessage = new Map<string, string | null>()
  for (const r of rows) {
    if (!r.userId) continue
    if (r.event === 'email_bounced' && r.messageId) {
      bounceByMessage.set(r.messageId, r.reason)
    } else if (r.event === 'email_bounced') {
      latestByUser.set(r.userId, { messageId: null, reason: r.reason, bounced: true })
    } else if (r.event === 'email_changed') {
      latestByUser.set(r.userId, { messageId: null, reason: null, bounced: false })
    } else {
      latestByUser.set(r.userId, { messageId: r.messageId, reason: null, bounced: false })
    }
  }

  const out = new Map<string, { reason: string | null }>()
  for (const [userId, latest] of latestByUser) {
    if (latest.bounced) out.set(userId, { reason: latest.reason })
    else if (latest.messageId && bounceByMessage.has(latest.messageId)) out.set(userId, { reason: bounceByMessage.get(latest.messageId) ?? null })
  }
  return out
}
