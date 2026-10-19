import type { AppDb, Env } from '../types'
import type { SendResult } from '../../../shared/emailSender'
import { buildSignInMessage, resolveAssocName, resolveOrgNounFromDb, senderFor } from './email'
import { recordAuthEvent } from './authEvents'
import { logSendFailure } from './emailErrors'

type SignInEnv = Pick<Env, 'RESEND_API_KEY' | 'APP_URL' | 'EMAIL_PROVIDER' | 'EMAIL' | 'DEMO_MODE' | 'ASSOCIATION_NAME' | 'EMAIL_FROM' | 'EMAIL_REPLY_TO'>

export type SignInLinkInput = {
  to: string
  /** An invite to a new member, or a login link to an existing one. */
  link: 'login' | 'invite'
  url: string
  /** The member the link is for, so each attempt's `auth_events` row shows in their login history. */
  userId?: string
}

/**
 * Send a login or invite link through the sender's sign-in purpose: fallback to
 * the other provider on a temporary failure, an invite suppressed in demo mode
 * (a login link still sends: the operator's own way into a demo arrives by
 * one), and a malformed address refused before any provider.
 *
 * It reads the association name and, for an invite, the org noun, counts every
 * attempt toward email health, and writes one `auth_events` row per attempt.
 * The answer says whether it went out, and when it didn't, whether the address
 * can never receive mail (the invite queue acks) or the failure is temporary
 * (the queue retries). It does not throw for a send that failed.
 */
export async function sendSignInLink(env: SignInEnv, db: AppDb, input: SignInLinkInput): Promise<SendResult> {
  const { to, link, url, userId } = input
  const message = buildSignInMessage({
    to, link, magicLinkUrl: url, appUrl: env.APP_URL,
    assocName: await resolveAssocName(env, db),
    orgNoun: link === 'invite' ? await resolveOrgNounFromDb(db) : undefined,
    recordEvent: async (e) => {
      await recordAuthEvent(db, {
        event: e.event, email: to, userId: userId ?? null, reason: e.reason,
        linkType: link, provider: e.provider, messageId: e.messageId,
      })
    },
  })
  return senderFor(env, db).send(message)
}

/**
 * `sendSignInLink` for a route that sends in the background: a failed send is
 * logged, and nothing is thrown, so a `waitUntil` always sees it succeed.
 */
export async function sendSignInLinkLogged(env: SignInEnv, db: AppDb, input: SignInLinkInput): Promise<void> {
  try {
    logSendFailure(await sendSignInLink(env, db, input))
  } catch (err) {
    console.error('[sign-in-link] send threw', err)
  }
}
