import { and, eq, isNull, isNotNull, lt, sql } from 'drizzle-orm'
import { bills } from '../db/schema'
import type { AppDb, Env } from '../types'

/** Attempts after which a bill is left for a human rather than re-queued. */
export const HEAL_MAX_ATTEMPTS = 5
/**
 * Bills re-queued per run.
 *
 * The cost is Gemini calls through the same AI Gateway that shed these bills in
 * the first place, so the limit is really a "don't re-stampede the thing that
 * just fell over" bound: 50/hour re-analyzes a full outage's backlog over a few
 * hours instead of one spike.
 *
 * It costs NO LegiScan quota. The heal sends to the tenant's own BILL_QUEUE;
 * the consumer reads the bill and its text from central via centralFetch, which
 * are D1 and R2 reads. getBill() is spent by central's ingestor, which the heal
 * never touches.
 */
export const HEAL_DEFAULT_LIMIT = 50
/**
 * How old ai_attempted_at must be before a bill counts as stalled.
 *
 * LOAD-BEARING. recordShedAttempt writes ai_attempted_at on EVERY shed, so a bill
 * working through its backoff is indistinguishable from one that exhausted it.
 * This floor is what separates them: it must exceed the longest a live message
 * can sit between retries, or the heal double-queues messages still in flight.
 *
 * It is therefore COUPLED TO THE QUEUE'S max_retries, which lives in the
 * operator's own api/wrangler.toml and is not visible from here — the code
 * cannot check it, so treat this as a contract. shedRetryDelay doubles a 60s
 * base per attempt and caps at 3600s, so the gap between the last two retries
 * grows to a full hour once max_retries is high enough to reach the cap.
 *
 * Rule: raising max_retries above ~4 requires raising HEAL_MIN_AGE_MS to match.
 * (max_retries has been 10 in the past — see processor.ts's shed backoff notes —
 * and at that setting a live message can sit an hour past its last
 * ai_attempted_at write, colliding exactly with this floor.)
 */
export const HEAL_MIN_AGE_MS = 60 * 60 * 1000

/**
 * How old ai_attempted_at must be before a bill counts as PERMANENTLY stalled
 * for the once-daily watchdog, rather than just mid-sweep.
 *
 * A working hourly heal drains a transient shed within its own 1-hour floor
 * (HEAL_MIN_AGE_MS) — by the next run at the latest. 24 hours is therefore not
 * "more stalled than the hourly floor," it is a different claim: the sweep
 * that should have cleared this bill many times over has either stopped
 * running or cannot clear it (e.g. BILL_QUEUE itself is down, so every hourly
 * run's send throws and breaks early — see healStalledAiBills' catch). Either
 * way it is the one condition cappedOut can't see: cappedOut only increments
 * when the sweep RUNS and hits the attempt cap, so a sweep that silently
 * stopped running leaves cappedOut at 0 forever while this climbs.
 */
export const HEAL_WATCH_AGE_MS = 24 * 60 * 60 * 1000

export interface HealResult {
  /** Bills re-queued this run. */
  queued: number
  /** Bills that would qualify but have hit HEAL_MAX_ATTEMPTS. These need a human. */
  cappedOut: number
  /** Qualifying bills left over because the per-run limit was reached. */
  remaining: number
}

/** UTC, space-separated, no T/Z — the format nowDb() writes and the columns store. */
function toDbTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

/**
 * Bills that were attempted but never processed and are not permanently skipped.
 *
 * ai_skip_reason IS NULL excludes deliberate permanent skips (pdf_too_large,
 * unreadable_document) — retrying those burns quota to fail identically.
 *
 * Out of scope, by construction: a first-time bill that sheds before its row
 * exists has nothing to write ai_attempted_at to, so this predicate cannot see
 * it. Those remain log-only, as recordShedAttempt already documents.
 */
function stalledWhere(cutoff: string) {
  return and(
    isNotNull(bills.aiAttemptedAt),
    isNull(bills.aiProcessedAt),
    isNull(bills.aiSkipReason),
    lt(bills.aiAttemptedAt, cutoff),
  )
}

/** Count stalled bills without queueing anything. Feeds the operator dashboard. */
export async function countStalledAiBills(db: AppDb, now: Date = new Date()): Promise<number> {
  const cutoff = toDbTime(new Date(now.getTime() - HEAL_MIN_AGE_MS))
  const row = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(bills)
    .where(stalledWhere(cutoff))
    .get()
  return Number(row?.n ?? 0)
}

/**
 * Count bills stalled long enough that the hourly sweep — which should have
 * cleared them within an hour of them going stalled — evidently isn't
 * clearing them. Feeds the once-daily "is the sweep actually working" check.
 */
export async function countLongStalledAiBills(db: AppDb, now: Date = new Date()): Promise<number> {
  const cutoff = toDbTime(new Date(now.getTime() - HEAL_WATCH_AGE_MS))
  const row = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(bills)
    .where(stalledWhere(cutoff))
    .get()
  return Number(row?.n ?? 0)
}

/**
 * Re-queue bills whose AI analysis was shed and never retried.
 *
 * Sends the same message reprocess-bill sends, minus `interactive`: the heal is a
 * background sweep, not a user waiting on a response. match_type is deliberately
 * absent — the processor derives 'keyword' for bills with no prior classification,
 * which is correct for these; stamping 'manual' would be a lie.
 */
export async function healStalledAiBills(
  env: Env,
  db: AppDb,
  opts: { limit?: number; now?: Date } = {},
): Promise<HealResult> {
  const limit = opts.limit ?? HEAL_DEFAULT_LIMIT
  const now = opts.now ?? new Date()
  const cutoff = toDbTime(new Date(now.getTime() - HEAL_MIN_AGE_MS))

  const cappedRow = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(bills)
    .where(and(stalledWhere(cutoff), sql`${bills.aiHealAttempts} >= ${HEAL_MAX_ATTEMPTS}`))
    .get()
  const cappedOut = Number(cappedRow?.n ?? 0)

  const eligibleWhere = and(stalledWhere(cutoff), lt(bills.aiHealAttempts, HEAL_MAX_ATTEMPTS))

  const eligibleRow = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(bills)
    .where(eligibleWhere)
    .get()
  const eligible = Number(eligibleRow?.n ?? 0)

  if (!env.BILL_QUEUE || eligible === 0) {
    return { queued: 0, cappedOut, remaining: eligible }
  }

  const rows = await db
    .select({ id: bills.id, externalId: bills.externalId })
    .from(bills)
    .where(eligibleWhere)
    .orderBy(bills.aiAttemptedAt)
    .limit(limit)
    .all()

  let queued = 0
  for (const row of rows) {
    if (!row.externalId) continue
    // Increment before sending. A double-queue is cheap; an un-incremented
    // failure loop is not, and a send that throws must not cost a free retry.
    await db.update(bills)
      .set({ aiHealAttempts: sql`${bills.aiHealAttempts} + 1` })
      .where(eq(bills.id, row.id))
      .run()
    try {
      await env.BILL_QUEUE.send({ tenantId: env.TENANT_ID, billId: row.externalId, forceAI: true })
    } catch (err) {
      // Stop the run, don't skip the row. Retrying the rest of this batch
      // against a queue that is down would spend up to 49 more attempts on zero
      // deliveries, so breaking bounds the loss to the one row we already
      // incremented.
      //
      // What this does NOT fix: the increment above precedes the send, and the
      // select is ordered by ai_attempted_at, so the same oldest bill leads
      // every run. A sustained outage still costs that one row an increment per
      // run and can still cap it out without five real deliveries. That is
      // accepted — one poisoned row per tenant per outage, visible in
      // stalledAi, is a better trade than either losing the whole batch's
      // budget or decrementing on a send whose delivery we cannot confirm.
      //
      // Returning the partial counts is the point: the next hourly run resumes
      // from the same head of the queue, and the operator sees how far it got.
      console.error(`[heal-ai] queue send failed for ${row.externalId}, ending run early:`, err)
      break
    }
    queued++
  }

  return { queued, cappedOut, remaining: eligible - queued }
}
