import { and, eq } from 'drizzle-orm'
import { settings } from '../db/schema'
import { nowDb } from './dbTime'
import type { Db } from '../types'
import { nextJobThread, type JobThread } from '../../../shared/alertThread'

export { ALERT_THREAD_QUIET_MS, type JobThread } from '../../../shared/alertThread'

/*
 * Which conversation a job's alert emails join (shared/alertThread.ts makes
 * the headers). A job's failure alerts, and the resolved email that ends them,
 * are one conversation per outage. It stays open until a resolved email finds
 * nothing in the job still failing (cron/passAlerts.ts closes it then), or
 * until the job has sent no alert for ALERT_THREAD_QUIET_MS. Each job's open
 * conversation is a `settings` row holding a JobThread.
 */

const threadKey = (job: string) => `alert-thread:${job}`

function parseThread(raw: string | null | undefined): JobThread | null {
  if (!raw) return null
  try {
    const t = JSON.parse(raw) as JobThread
    return Number.isFinite(t.startedAt) && Number.isFinite(t.lastAt) ? t : null
  } catch {
    return null
  }
}

async function readThread(db: Db, key: string): Promise<string | null> {
  return (await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get())?.value ?? null
}

/**
 * Join the job's open conversation, or start one when none is open or it has
 * gone quiet, and record this alert as its latest. Returns the row as this
 * alert left it; its `startedAt` names the conversation. Each write is
 * conditional on the row as read, so two runs alerting at once land in one
 * conversation: the run whose write loses reads the winner's row and joins it.
 */
export async function joinAlertThread(db: Db, job: string, now: number = Date.now()): Promise<JobThread> {
  const key = threadKey(job)
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await readThread(db, key)
    const open = parseThread(raw)
    const thread = nextJobThread(open, now)
    const value = JSON.stringify(thread)
    const written = raw === null
      ? await db.insert(settings).values({ key, value, updatedAt: nowDb() }).onConflictDoNothing().returning({ key: settings.key })
      : await db.update(settings).set({ value, updatedAt: nowDb() }).where(and(eq(settings.key, key), eq(settings.value, raw))).returning({ key: settings.key })
    if (written.length > 0) return thread
  }
  // Every write lost a race: join whatever is open now, without recording this alert.
  return parseThread(await readThread(db, key)) ?? { startedAt: now, lastAt: now }
}

/**
 * End the job's conversation as `thread` (what joinAlertThread returned) left
 * it, so the job's next alert starts a new one. Only a row that still holds
 * exactly that goes: a newer conversation stays open, and so does this one
 * when another run's alert has joined it since, say while the resolved email
 * was sending.
 */
export async function closeAlertThread(db: Db, job: string, thread: JobThread): Promise<void> {
  await db.delete(settings).where(and(eq(settings.key, threadKey(job)), eq(settings.value, JSON.stringify(thread))))
}
