import { sql } from 'drizzle-orm'
import type { AppDb } from '../types'
import type { Attempt, ProviderName } from '../../../shared/emailProviders'
import { emailSendStats } from '../db/schema'
import { toDbTs } from './dbTime'

/** 'YYYY-MM-DD HH:00:00' (UTC) — the email_send_stats bucket for an instant. */
export function hourKey(d: Date): string {
  return toDbTs(d).slice(0, 13) + ':00:00'
}

export type SendTally = { sent: number; failed: number; suppressed: number; lastError: string | null }

/**
 * Count attempts. A failure is suppressed when its adapter classified it
 * permanent: the address can't receive mail, which is not the provider's fault.
 * Any other failure is the provider's.
 */
export function tally(attempts: Attempt[]): SendTally {
  const t: SendTally = { sent: 0, failed: 0, suppressed: 0, lastError: null }
  for (const a of attempts) {
    if (a.ok) t.sent++
    else if (a.permanent) t.suppressed++
    else { t.failed++; t.lastError = a.error }
  }
  return t
}

/**
 * Add a tally to this hour's row for `provider`. Best-effort: a failed write is
 * logged and swallowed, because a stats write must never be what fails a send.
 */
export async function recordSendStats(db: AppDb, provider: ProviderName, t: SendTally, now: Date = new Date()): Promise<void> {
  if (t.sent === 0 && t.failed === 0 && t.suppressed === 0) return
  const ts = toDbTs(now)
  try {
    await db.insert(emailSendStats).values({
      hour: hourKey(now), provider,
      sent: t.sent, failed: t.failed, suppressed: t.suppressed,
      lastError: t.lastError,
      lastSentAt: t.sent ? ts : null,
      lastFailedAt: t.failed ? ts : null,
    }).onConflictDoUpdate({
      target: [emailSendStats.hour, emailSendStats.provider],
      set: {
        sent: sql`${emailSendStats.sent} + ${t.sent}`,
        failed: sql`${emailSendStats.failed} + ${t.failed}`,
        suppressed: sql`${emailSendStats.suppressed} + ${t.suppressed}`,
        lastError: t.lastError ?? sql`${emailSendStats.lastError}`,
        lastSentAt: t.sent ? ts : sql`${emailSendStats.lastSentAt}`,
        lastFailedAt: t.failed ? ts : sql`${emailSendStats.lastFailedAt}`,
      },
    })
  } catch (err) {
    console.error('[email-stats] write failed', err)
  }
}
