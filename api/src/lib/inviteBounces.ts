import { and, eq, gte, inArray, isNotNull, isNull, not, sql } from 'drizzle-orm'
import type { Env, AppDb } from '../types'
import { authEvents, users } from '../db/schema'
import { hasLoggedInWhere } from './loginHistory'
import { recordAuthEvent } from './authEvents'
import { toDbTs } from './dbTime'

/** Lifetime of an invite link; older sends to a pending invite aren't checked. */
export const BOUNCE_CHECK_WINDOW_DAYS = 7

/** A bounce this run recorded, for anything that reports it (e.g. the inviter email). */
export type RecordedBounce = {
  memberId: string
  /** The address the bounced email was sent to. */
  email: string
  /** The provider's error cause, or its status when it gave none. */
  reason: string
  /** Who invited the member, or null (for example the first admin of an instance). */
  inviterId: string | null
  messageId: string
}

type DeliveryStatus = { status: string; isSpam?: boolean; errorCause?: string; datetime?: string }
type DeliveryLookup = (messageIds: string[], since: string) => Promise<Record<string, DeliveryStatus>>

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
 * delivery record.
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
    })
    .from(authEvents)
    .innerJoin(users, eq(users.id, authEvents.userId))
    .where(and(
      eq(authEvents.event, 'email_sent'),
      eq(authEvents.provider, 'cloudflare'),
      inArray(authEvents.linkType, ['invite', 'login']),
      isNotNull(authEvents.messageId),
      gte(authEvents.createdAt, toDbTs(since)),
      isNull(users.deactivatedAt),
      not(hasLoggedInWhere(db)),
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

  const lookup = (env.CENTRAL as { emailDeliveryStatus?: DeliveryLookup } | undefined)?.emailDeliveryStatus
  if (!lookup) return []
  let delivery: unknown
  try {
    delivery = await lookup([...byMessage.keys()], since.toISOString())
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
      bounces.push({ memberId: row.memberId!, email: row.email, reason: reason!, inviterId: row.inviterId, messageId })
    }
  }
  return bounces
}

/**
 * Bounce state per pending invite (never signed in, not deactivated): set when
 * their latest invite or sign-in email, by send time, bounced. A send is an
 * `email_sent` row, or an `email_bounced` row with no message id (the provider
 * refused a suppressed address at send time). A sent email counts as bounced
 * once the hourly check records `email_bounced` for its message id; a newer
 * send with no outcome yet clears the state.
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
      inArray(authEvents.event, ['email_sent', 'email_bounced']),
      inArray(authEvents.linkType, ['invite', 'login']),
      isNull(users.deactivatedAt),
      not(hasLoggedInWhere(db)),
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
