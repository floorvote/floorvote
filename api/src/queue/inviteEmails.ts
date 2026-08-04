import { generateToken, hashToken } from '../lib/crypto'
import { sendMagicLink } from '../lib/email'
import { recordAuthEvent } from '../lib/authEvents'
import { magicLinks } from '../db/schema'
import type { AppDb, Env, InviteEmailMessage } from '../types'

const INVITE_DURATION_MS = 7 * 24 * 60 * 60 * 1000
// Delay before retrying a failed invite send. Keeps a transient provider
// 429/5xx from hammering the sender and gives reputation/limits room to recover.
const INVITE_RETRY_DELAY_SECONDS = 120

/**
 * Deliver invite emails enqueued by POST /admin/members/bulk-invite.
 *
 * The job carries only userId + email (no raw token). The token is minted here,
 * at delivery time, so the 7-day expiry counts from the actual send. Retries
 * mint an additional link, which is harmless (multiple pending links are valid,
 * exactly as the per-user "Resend invite" already does).
 */
export async function processInviteEmails(
  messages: Message<InviteEmailMessage>[],
  env: Env,
  db: AppDb,
): Promise<void> {
  for (const message of messages) {
    const { tenantId, userId, email } = message.body
    if (tenantId !== env.TENANT_ID) { message.ack(); continue }
    try {
      const rawToken = await generateToken()
      const tokenHash = await hashToken(rawToken)
      const expiresAt = new Date(Date.now() + INVITE_DURATION_MS).toISOString()
      await db.insert(magicLinks).values({ id: crypto.randomUUID(), userId, tokenHash, expiresAt })

      const url = `${env.APP_URL}/auth/verify?token=${encodeURIComponent(rawToken)}`
      // Record the invite the same way the single-invite path does (adminApi.ts),
      // attributed to the member's id so it surfaces in their Login activity. The
      // bulk path used to skip this and call sendMagicLink without the id, leaving
      // the email_sent row with a null user_id — invisible in the per-member view.
      await recordAuthEvent(db, { event: 'link_requested', email, userId, linkType: 'invite' })
      await sendMagicLink(email, url, env, 'invite', db, userId)
      message.ack()
    } catch (err) {
      console.error('[invite-email] send failed for', email, err)
      message.retry({ delaySeconds: INVITE_RETRY_DELAY_SECONDS })
    }
  }
}
