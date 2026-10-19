import type { AppDb } from '../types'
import type { HealthRecorder, Attempt, ProviderName } from '../../../shared/emailSender'
import { recordSendStats, tally } from './emailStats'
import { recordResendReading, recordResendThrottled } from './resendUsage'

/**
 * The API's email-health recorder, handed to the shared sender for purposes
 * that count. It adds the attempts to this hour's `email_send_stats` rows, one
 * write per provider (the email-health job reads them), and stores what Resend
 * said about its quota. A permanent failure counts as suppressed, not failed:
 * a dead address is not the provider's fault.
 *
 * Every attempt is counted, including the failed first half of a send that
 * fallback rescued. That is deliberate: fallback hides an outage from members,
 * so the detector has to see the primary failing even when nobody else can.
 *
 * Never throws: a failed write is logged and swallowed.
 */
export function emailHealthRecorder(db: AppDb): HealthRecorder {
  return {
    async record(attempts: Attempt[]) {
      const byProvider = new Map<ProviderName, Attempt[]>()
      for (const a of attempts) byProvider.set(a.provider, [...(byProvider.get(a.provider) ?? []), a])
      for (const [provider, group] of byProvider) await recordSendStats(db, provider, tally(group))

      const usage = attempts.filter(a => a.provider === 'resend' && a.usage).map(a => a.usage!)
      if (usage.length === 0) return
      try {
        const latest = usage.findLast(u => u.monthlyUsed !== null || u.dailyUsed !== null)
        if (latest) await recordResendReading(db, latest)
        if (usage.some(u => u.throttled)) await recordResendThrottled(db)
      } catch (err) {
        console.error('[resend-record]', err)
      }
    },
  }
}
