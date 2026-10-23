import { and, eq, gte, sql } from 'drizzle-orm'
import { sessionSyncLog } from '../db/schema'
import { escHtml, sendOpsAlert } from '../lib/jobAlert'
import { PRODUCT_NAME } from '../../../shared/brand'
import type { Env, Db } from '../types'

/**
 * When the hourly cron alerts on a session that keeps failing, for the LegiScan
 * sync (sync.ts) and every snapshot provider's (sync-snapshots.ts) alike. Every
 * failed pass is logged in session_sync_log, and the States page shows each one.
 */

/**
 * A session alerts on its 4th failed pass in a row, then on every 4th after
 * (the 8th, the 12th...). A provider's server drops a connection or answers 522
 * now and then, and the next pass reads the session fine.
 */
export const FAILED_PASSES_BEFORE_ALERT = 4

/** The longest error message a failed pass's log row keeps. */
const ERROR_LOG_MAX = 500

/** What a streak is read from: the session's row as it stood before the pass. */
type StreakSession = { sessionId: number; state: string; sessionName: string; lastSyncedAt: string | null }

/** A session whose pass threw, and whether its failed row was logged. */
export type SessionFailure = { session: StreakSession; error: Error; logged: boolean }

/** A session that finished a pass after a streak long enough to have alerted. */
export type Recovery = { session: StreakSession; failed: number; since: string }

/**
 * An error's message for the log, cut to ERROR_LOG_MAX characters. A failed
 * query's own message is the SQL and every bound value (a stored record's JSON,
 * say), so the database's error under it is logged instead.
 */
export function errorMessage(err: unknown): string {
  let e: unknown = err
  while (e instanceof Error && e.message.startsWith('Failed query:') && e.cause instanceof Error) e = e.cause
  const message = e instanceof Error ? e.message : String(e)
  return message.length > ERROR_LOG_MAX ? `${message.slice(0, ERROR_LOG_MAX - 1)}…` : message
}

/**
 * The session's failed passes since its last finished one, which stamps
 * last_synced_at, and when the first of them ran. A pass that logs its counts
 * and then fails leaves an ok row, but no stamp, so it counts as failed here as
 * it does on the States page. Read before a finished pass stamps the session,
 * it is the streak that pass ended.
 */
async function failedStreak(db: Db, session: StreakSession): Promise<{ count: number; since: string | null }> {
  const [row] = await db.select({ n: sql<number>`COUNT(*)`, since: sql<string | null>`MIN(${sessionSyncLog.syncedAt})` })
    .from(sessionSyncLog).where(and(
      eq(sessionSyncLog.sessionId, session.sessionId),
      eq(sessionSyncLog.status, 'failed'),
      session.lastSyncedAt ? gte(sessionSyncLog.syncedAt, session.lastSyncedAt) : undefined,
    )).all()
  return { count: Number(row?.n ?? 0), since: row?.since ?? null }
}

/**
 * The alerts a run's failed passes raise. A failed pass that couldn't be logged
 * can't be counted, so it alerts at once; a logged one alerts when its streak
 * reaches a multiple of FAILED_PASSES_BEFORE_ALERT.
 */
export async function streakAlerts(db: Db, label: string, failures: SessionFailure[]): Promise<Error[]> {
  const alerts: Error[] = []
  for (const { session, error, logged } of failures) {
    if (!logged) { alerts.push(error); continue }
    const { count } = await failedStreak(db, session)
    if (count === 0 || count % FAILED_PASSES_BEFORE_ALERT !== 0) {
      const next = Math.max(1, Math.ceil(count / FAILED_PASSES_BEFORE_ALERT)) * FAILED_PASSES_BEFORE_ALERT
      console.warn(`[${label}] ${session.sessionName}: ${count} failed in a row; alerting at ${next}`)
      continue
    }
    const alert = new Error(`${session.state} ${session.sessionName}: ${count} passes in a row failed. Latest: ${errorMessage(error)}`, { cause: error })
    alert.stack = error.stack
    alerts.push(alert)
  }
  return alerts
}

/** Throws a run's errors together, so the job's one alert email names every session. */
export function throwAll(label: string, errors: Error[]): void {
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, `[${label}] ${errors.length} sessions failed: ${errors.map(e => e.message).join('; ')}`)
}

/**
 * The streak a finished pass ended, read before the pass stamps the session: a
 * Recovery when it was long enough to have alerted, else null. A log that can't
 * be read is noted and reads as no recovery, since the log is a record of a
 * pass, never part of it.
 */
export async function recoveryFrom(db: Db, session: StreakSession): Promise<Recovery | null> {
  try {
    const { count, since } = await failedStreak(db, session)
    return count >= FAILED_PASSES_BEFORE_ALERT && since ? { session, failed: count, since } : null
  } catch (err) {
    console.error(`[sync] couldn't read the failed passes ${session.state} ${session.sessionName} just ended:`, err)
    return null
  }
}

/**
 * One email for every session a run finished after a streak that alerted, so
 * the operators know the failure emails stopped because the source recovered.
 * `job` is the name the hourly cron runs the sync under (index.ts), which the
 * failure emails' subject carries too. Best-effort, as every ops alert is.
 */
export async function sendRecoveries(env: Env, job: string, recoveries: Recovery[]): Promise<void> {
  if (recoveries.length === 0) return
  const lines = recoveries.map(({ session, failed, since }) =>
    `${session.state} ${session.sessionName}: synced after ${failed} failed passes in a row, failing since ${since.slice(0, 16)} UTC`)
  const text = `Scheduled job "${job}" is syncing again.\n\n${lines.map(l => `• ${l}`).join('\n')}\n`
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; color: #0f172a;">
      <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.6; color: #334155;">
        Scheduled job <strong>${escHtml(job)}</strong> is syncing again.
      </p>
      <ul style="margin: 0; padding-left: 20px; font-size: 14px; line-height: 1.7; color: #0f172a;">
        ${lines.map(l => `<li>${escHtml(l)}</li>`).join('')}
      </ul>
    </div>
  `
  await sendOpsAlert(env, { subject: `[${PRODUCT_NAME}] resolved: ${job}`, text, html })
}
