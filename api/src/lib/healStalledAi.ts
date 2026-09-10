import { and, eq, isNull, isNotNull, lt, sql } from 'drizzle-orm'
import { bills } from '../db/schema'
import type { AppDb, Env } from '../types'

/** Attempts after which a bill is left for a human rather than re-queued. */
export const HEAL_MAX_ATTEMPTS = 5
/** Bills re-queued per run. Each costs one getBill() against the shared LegiScan quota. */
export const HEAL_DEFAULT_LIMIT = 50
/**
 * How old ai_attempted_at must be before a bill counts as stalled.
 *
 * LOAD-BEARING. recordShedAttempt writes ai_attempted_at on EVERY shed, so a bill
 * working through its backoff is indistinguishable from one that exhausted it. At
 * max_retries=3 with a 60s base the backoff spans 60+120+240 ≈ 7 minutes, so an
 * hour proves the message is out of the queue. Without this floor the heal
 * double-queues messages that are still live.
 */
export const HEAL_MIN_AGE_MS = 60 * 60 * 1000

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
    await env.BILL_QUEUE.send({ tenantId: env.TENANT_ID, billId: row.externalId, forceAI: true })
    queued++
  }

  return { queued, cappedOut, remaining: eligible - queued }
}
