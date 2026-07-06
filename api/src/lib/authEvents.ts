import type { AppDb } from '../types'
import { authEvents } from '../db/schema'

export type AuthEventType =
  | 'link_requested' | 'link_requested_unknown' | 'email_sent' | 'email_send_failed' | 'email_bounced'
  | 'verify_success' | 'verify_failed' | 'logout' | 'rate_limited'
  | 'email_delivered' | 'email_complained'

export interface AuthEventInput {
  event: AuthEventType
  email: string
  userId?: string | null
  reason?: string | null
  linkType?: 'login' | 'invite' | null
  provider?: string | null
  messageId?: string | null
  userAgent?: string | null
  ipCountry?: string | null
}

/**
 * Append one auth event (best-effort) and emit a structured Workers Logs line.
 * Never throws — auth flows must not break because logging failed.
 */
export async function recordAuthEvent(db: AppDb, e: AuthEventInput): Promise<void> {
  // Log first so there's a trail even if the DB write fails. PII (email) is
  // intentional for diagnosis; Workers Logs are access-controlled.
  console.log(JSON.stringify({ tag: 'auth_event', ...e }))
  try {
    await db.insert(authEvents).values({
      id: crypto.randomUUID(),
      userId: e.userId ?? null,
      email: e.email,
      event: e.event,
      reason: e.reason ?? null,
      linkType: e.linkType ?? null,
      provider: e.provider ?? null,
      messageId: e.messageId ?? null,
      userAgent: e.userAgent ?? null,
      ipCountry: e.ipCountry ?? null,
    })
  } catch (err) {
    console.error('[auth_event] insert failed', err)
  }
}

/** Extract request context (user agent + Cloudflare country) for an auth event. */
export function authReqContext(
  c: { req: { header(name: string): string | undefined } },
): { userAgent: string | null; ipCountry: string | null } {
  return {
    userAgent: c.req.header('user-agent') ?? null,
    ipCountry: c.req.header('cf-ipcountry') ?? null,
  }
}
