import { and, asc, eq, gte, isNull, sql } from 'drizzle-orm'
import { sessions, sessionSyncLog } from '../db/schema'
import { escHtml, sendOpsAlert } from '../lib/jobAlert'
import { dbTimeAgo, nowDb, toDb } from '../lib/dbTime'
import { PRODUCT_NAME } from '../../../shared/brand'
import type { Env, Db } from '../types'

/**
 * When the hourly cron alerts on a session that keeps failing, for the LegiScan
 * sync (sync.ts) and every snapshot provider's (sync-snapshots.ts) alike. Every
 * failed pass is logged in session_sync_log, and the States page shows each one.
 */

/**
 * A session alerts once its streak of failed passes has lasted this many hours,
 * counted from the streak's first failed pass to the current one, and then at
 * most once every this many hours while it goes on. An hourly session alerts at
 * about 4, 8, and 12 hours; a daily one on its second failed pass (about a day
 * in) and each after. A provider's server drops a connection or answers 522 now
 * and then, and the next pass reads the session fine.
 */
export const ALERT_INTERVAL_HOURS = 4

const HOUR_MS = 3_600_000
/** How early a pass may land and still count as on the hour: cron ticks drift by seconds. */
const SLACK_MS = 5 * 60_000

/** The longest error message a failed pass's log row keeps. */
const ERROR_LOG_MAX = 500

/** What a streak is read from: the session's row as it stood before the pass. */
type StreakSession = { sessionId: number; state: string; sessionName: string; lastSyncedAt: string | null }

/** A session whose pass threw, and whether its failed row was logged. */
export type SessionFailure = { session: StreakSession; error: Error; logged: boolean }

/** A session that finished a pass after a streak long enough to have alerted. */
export type Recovery = { session: StreakSession; failed: number; hours: number; since: string }

/** The hourly job a pass runs under: its id (the alert emails' subject), the provider whose sessions it syncs, and that provider's name. */
export type SyncJob = { job: string; providerId: string; name: string }

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

const dbMs = (t: string) => Date.parse(`${t.replace(' ', 'T')}Z`)

/**
 * Replays a streak's failed passes, oldest first, to find the ones that alert:
 * the first once the streak has lasted ALERT_INTERVAL_HOURS, then each pass at
 * least that long after the last alert. The log rows are all the state this
 * needs, since the same rows always replay to the same alerts.
 */
function alertingPasses(times: number[]): boolean[] {
  let due = times.length ? times[0] + ALERT_INTERVAL_HOURS * HOUR_MS : 0
  return times.map(t => {
    if (t + SLACK_MS < due) return false
    due = t + ALERT_INTERVAL_HOURS * HOUR_MS
    return true
  })
}

/**
 * When the session's failed passes since its last finished one ran, oldest
 * first. A pass that logs its counts and then fails leaves an ok row, but no
 * stamp, so it counts as failed here as it does on the States page. Read before
 * a finished pass stamps the session, it is the streak that pass ended.
 */
async function failedStreak(db: Db, session: StreakSession): Promise<number[]> {
  const rows = await db.select({ at: sessionSyncLog.syncedAt }).from(sessionSyncLog).where(and(
    eq(sessionSyncLog.sessionId, session.sessionId),
    eq(sessionSyncLog.status, 'failed'),
    session.lastSyncedAt ? gte(sessionSyncLog.syncedAt, session.lastSyncedAt) : undefined,
  )).orderBy(asc(sessionSyncLog.syncedAt)).all()
  return rows.map(r => dbMs(r.at))
}

const hoursOf = (ms: number) => Math.round(ms / HOUR_MS)

/**
 * The alerts a run's failed passes raise. A failed pass that couldn't be logged
 * can't be counted, so it alerts at once; a logged one alerts when its streak
 * is the first to land ALERT_INTERVAL_HOURS after the streak began or after its last alert.
 */
export async function streakAlerts(db: Db, label: string, failures: SessionFailure[]): Promise<Error[]> {
  const alerts: Error[] = []
  for (const { session, error, logged } of failures) {
    if (!logged) { alerts.push(error); continue }
    const times = await failedStreak(db, session)
    const first = times[0]
    const now = times[times.length - 1]
    if (!alertingPasses(times).at(-1)) {
      console.warn(`[${label}] ${session.sessionName}: ${times.length} failed in a row; alerting after ${ALERT_INTERVAL_HOURS} hours of failures`)
      continue
    }
    const alert = new Error(`${session.state} ${session.sessionName}: has failed for ${hoursOf(now - first)} hours (${times.length} passes in a row failed). Latest: ${errorMessage(error)}`, { cause: error })
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
    const times = await failedStreak(db, session)
    if (!alertingPasses(times).includes(true)) return null
    return { session, failed: times.length, hours: hoursOf(times[times.length - 1] - times[0]), since: toDb(new Date(times[0])) }
  } catch (err) {
    console.error(`[sync] couldn't read the failed passes ${session.state} ${session.sessionName} just ended:`, err)
    return null
  }
}

/**
 * Stamp a finished pass and return the recovery it alone closed. An hourly
 * pass and "run now" can read the same streak: only the one that replaces the
 * old last_synced_at sends its recovery email. A log read that fails still
 * lets the pass stamp its success, as before.
 */
export async function finishPass(db: Db, session: StreakSession): Promise<Recovery | null> {
  const recovered = await recoveryFrom(db, session)
  const stamped = await db.update(sessions).set({ lastSyncedAt: nowDb() }).where(and(
    eq(sessions.sessionId, session.sessionId),
    recovered ? (session.lastSyncedAt === null ? isNull(sessions.lastSyncedAt) : eq(sessions.lastSyncedAt, session.lastSyncedAt)) : undefined,
  )).returning({ sessionId: sessions.sessionId })
  return stamped.length > 0 ? recovered : null
}

/**
 * The sessions of a job whose latest pass failed and that haven't synced since,
 * for a recovery email to name. Only failures from the last two days count, so
 * a session that stopped syncing long ago isn't listed forever. Best-effort.
 */
async function stillFailing(db: Db, providerId: string, recovered: Recovery[]): Promise<{ state: string; sessionName: string }[]> {
  try {
    const rows = await db.selectDistinct({ sessionId: sessions.sessionId, state: sessions.state, sessionName: sessions.sessionName })
      .from(sessionSyncLog)
      .innerJoin(sessions, eq(sessions.sessionId, sessionSyncLog.sessionId))
      .where(and(
        eq(sessions.provider, providerId),
        eq(sessionSyncLog.status, 'failed'),
        gte(sessionSyncLog.syncedAt, dbTimeAgo(2 * 24 * HOUR_MS)),
        sql`${sessionSyncLog.syncedAt} >= COALESCE(${sessions.lastSyncedAt}, '')`,
      )).orderBy(asc(sessions.state), asc(sessions.sessionName)).all()
    const done = new Set(recovered.map(r => r.session.sessionId))
    return rows.filter(r => !done.has(r.sessionId))
  } catch (err) {
    console.error(`[sync] couldn't read which sessions are still failing:`, err)
    return []
  }
}

/**
 * One email for every session a run finished after a streak that alerted, so
 * the operators know those failure emails stopped because the sessions
 * recovered. It names the sessions that recovered and, when others in the same
 * job are still failing, lists those too: the job as a whole isn't "syncing
 * again" until none are. The subject carries the job's id, as the failure
 * emails' does. Best-effort, as every ops alert is.
 */
export async function sendRecoveries(env: Env, db: Db, { job, providerId, name }: SyncJob, recoveries: Recovery[]): Promise<void> {
  if (recoveries.length === 0) return
  const failing = await stillFailing(db, providerId, recoveries)
  const lines = recoveries.map(({ session, failed, hours, since }) =>
    `${session.state} ${session.sessionName}: synced after ${failed} failed passes over ${hours} hours, failing since ${since.slice(0, 16)} UTC`)
  const stillLines = failing.map(s => `${s.state} ${s.sessionName}`)
  const intro = `${name} sync (${job}): ${recoveries.length} ${recoveries.length === 1 ? 'session' : 'sessions'} synced again.`
  const text = `${intro}\n\n${lines.map(l => `• ${l}`).join('\n')}\n` +
    (stillLines.length ? `\nStill failing: ${stillLines.length} in the same job\n\n${stillLines.map(l => `• ${l}`).join('\n')}\n` : '')
  const list = (items: string[]) => `<ul style="margin: 0 0 16px; padding-left: 20px; font-size: 14px; line-height: 1.7; color: #0f172a;">${items.map(l => `<li>${escHtml(l)}</li>`).join('')}</ul>`
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; color: #0f172a;">
      <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.6; color: #334155;">${escHtml(intro)}</p>
      ${list(lines)}
      ${stillLines.length ? `<p style="margin: 0 0 8px; font-size: 15px; line-height: 1.6; color: #334155;"><strong>Still failing</strong> in the same job:</p>${list(stillLines)}` : ''}
    </div>
  `
  await sendOpsAlert(env, { subject: `[${PRODUCT_NAME}] resolved: ${job}`, text, html })
}
