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
