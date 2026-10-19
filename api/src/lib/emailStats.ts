import { sql } from 'drizzle-orm'
import type { AppDb } from '../types'
import type { EmailSendResult, ProviderName } from './email'
import { emailSendStats } from '../db/schema'
import { toDbTs } from './dbTime'

/** 'YYYY-MM-DD HH:00:00' (UTC) — the email_send_stats bucket for an instant. */
export function hourKey(d: Date): string {
  return toDbTs(d).slice(0, 13) + ':00:00'
}

/**
 * A failure about one recipient rather than about the provider. The address
 * previously hard-bounced or reported spam, so retrying it through another
 * provider would only damage that provider's reputation too, and counting it
 * as a provider failure would let a few dead addresses in a digest page the
 * operator. Deliberately narrow: anything not listed here is treated as the
 * provider failing, which errs toward falling back and toward alerting.
 */
export function isRecipientError(r: Pick<EmailSendResult, 'error'>): boolean {
  return !!r.error?.includes('E_RECIPIENT_SUPPRESSED')
}

export type SendTally = { sent: number; failed: number; suppressed: number; lastError: string | null }

/**
 * Count sends or attempts. A failure is suppressed when its adapter classified
 * it permanent (the shared sender's attempts), or, for a result from the old
 * sendEmail path, when isRecipientError says so.
 */
export function tally(results: Array<Pick<EmailSendResult, 'ok' | 'error'> & { permanent?: boolean }>): SendTally {
  const t: SendTally = { sent: 0, failed: 0, suppressed: 0, lastError: null }
  for (const r of results) {
    if (r.ok) t.sent++
    else if (r.permanent ?? isRecipientError(r)) t.suppressed++
    else { t.failed++; t.lastError = r.error ?? 'unknown error' }
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
