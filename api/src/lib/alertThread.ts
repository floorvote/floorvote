import { eq } from 'drizzle-orm'
import { jobAlertThreads } from '../db/schema'
import { toDbTs } from './dbTime'
import type { AppDb } from '../types'
import { dbTsToEpoch } from '../../../shared/time'
import { nextJobThread, type JobThread } from '../../../shared/alertThread'

/** An instance's conversation never goes quiet: only an event ends it. */
const NO_QUIET_LIMIT = Infinity

/**
 * Join the conversation of the job's failure alerts on this instance, or start
 * one when none is open, and record this alert as its latest: one
 * job_alert_threads row a job. No amount of time ends a conversation, only an
 * event does: a run that does its work (with a resolved email) or one that
 * finds the job switched off (lib/jobAlert.ts, via takeJobAlertThread). So a
 * weekly job's failed weeks stay one conversation. Returns the conversation as
 * stored, to the second, so every alert of it names the same root. A job runs at most once per cron
 * invocation, so two of its alerts never race, a plain upsert is enough, and
 * no two of its conversations start in the same second.
 */
export async function joinJobAlertThread(db: AppDb, job: string, now: number = Date.now()): Promise<JobThread> {
  const row = await db.select().from(jobAlertThreads).where(eq(jobAlertThreads.job, job)).get()
  const open = row ? { startedAt: dbTsToEpoch(row.startedAt), lastAt: dbTsToEpoch(row.lastAlertedAt) } : null
  const next = nextJobThread(open && Number.isFinite(open.startedAt) && Number.isFinite(open.lastAt) ? open : null, now, NO_QUIET_LIMIT)
  const startedAt = toDbTs(new Date(next.startedAt))
  const lastAlertedAt = toDbTs(new Date(next.lastAt))
  await db.insert(jobAlertThreads).values({ job, startedAt, lastAlertedAt })
    .onConflictDoUpdate({ target: jobAlertThreads.job, set: { startedAt, lastAlertedAt } })
  return { startedAt: dbTsToEpoch(startedAt), lastAt: dbTsToEpoch(lastAlertedAt) }
}

/**
 * End the job's conversation on this instance and return it, or null when
 * none is open. A run that did its work calls this, and a conversation it gets
 * back is owed one resolved email, however long ago it began. A run that found
 * the job switched off calls it too, and sends nothing.
 */
export async function takeJobAlertThread(db: AppDb, job: string): Promise<JobThread | null> {
  const [row] = await db.delete(jobAlertThreads).where(eq(jobAlertThreads.job, job)).returning()
  if (!row) return null
  const thread = { startedAt: dbTsToEpoch(row.startedAt), lastAt: dbTsToEpoch(row.lastAlertedAt) }
  return Number.isFinite(thread.startedAt) && Number.isFinite(thread.lastAt) ? thread : null
}
