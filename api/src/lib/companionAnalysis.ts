import { and, eq, isNull } from 'drizzle-orm'
import { bills } from '../db/schema'
import { centralFetch } from './centralFetch'
import { inGroupOf } from './companionGroups'
import { nowDb, toDbTs } from './dbTime'
import { HEAL_MIN_AGE_MS } from './healStalledAi'
import { isHandle, parseHandle } from '../../../shared/billHandle'
import type { AppDb, Env, TenantQueueMessage } from '../types'

/**
 * Companion analyses a group can have queued or running at once, one model call each.
 *
 * Real groups are a handful of bills, so this never binds on them. It bounds a pathological one (a
 * long chain of identical bills, a vocabulary edit that joins many at once), which would otherwise
 * queue a model call for every unmatched member from a single delivery. The members it leaves
 * stay waiting, and the next delivery of the group queues more as the others finish (see
 * pullCompanions), so a large group is analyzed in full at this many at a time and nothing is dropped.
 */
export const MAX_COMPANION_ANALYSES_PER_DELIVERY = 10

/**
 * Companions that didn't match (see **Pulled companion** in CONTEXT.md).
 *
 * A bill in a companion group with a tracked bill is analyzed even if it
 * didn't match the instance's keywords, so every bill in a group has its own
 * summary and text. It is pulled in by group membership and nothing else: its
 * `match_type` stays null, so it is never tracked, never a new match, and
 * after a split it is an analyzed bill that doesn't match, as a bill the
 * keywords later dropped is.
 *
 * Nothing here stores anything. A bill is waiting when it is unanalyzed, has
 * no match type and no permanent skip, and its group has a tracked bill, so
 * a split ends the wait by itself. Each delivery of any bill in the group
 * looks again, and acts in one of two ways:
 *
 * - The instance already holds where central stored the bill's text
 *   (`text_r2_key`): queue the analysis on the instance's own queue, as a
 *   `groupAnalysis` message. It is claimed first, by stamping `ai_attempted_at`
 *   on a bill where it's null, so deliveries racing each other queue it once
 *   and a failed attempt isn't repeated here. The AI heal retries it from there.
 *   No more than MAX_COMPANION_ANALYSES_PER_DELIVERY are queued or running in the
 *   group at once: those claimed within the last hour and not yet done count, so
 *   the rest wait unclaimed. Each finished analysis is itself a delivery of a
 *   group member, and queues the next one then.
 * - It doesn't: ask central to fetch the bill from its provider, which sends
 *   it back to every instance linked to it. That delivery carries the text,
 *   and so queues the analysis. Central fetches only because a tracked
 *   bill was delivered, or the waiting bill's own stub or metadata update
 *   was, never because of the fetch's own delivery, so the two can't loop.
 */
export async function pullCompanions(env: Env, db: AppDb, msg: TenantQueueMessage): Promise<void> {
  // A demo never calls the model, and has no central to fetch from.
  if (env.DEMO_MODE === 'true' || !isHandle(msg.billId)) return
  const delivered = await db.select({ id: bills.id, matchType: bills.matchType, groupKey: bills.groupKey }).from(bills).where(eq(bills.externalId, msg.billId)).get()
  // Most bills are in no group, and cost this one read.
  if (!delivered || delivered.groupKey === null) return

  const members = await db.select({
    id: bills.id,
    externalId: bills.externalId,
    matchType: bills.matchType,
    aiProcessedAt: bills.aiProcessedAt,
    aiSkipReason: bills.aiSkipReason,
    aiAttemptedAt: bills.aiAttemptedAt,
    textR2Key: bills.textR2Key,
  }).from(bills).where(inGroupOf(bills.id, delivered.id)).all()
  if (!members.some(m => m.matchType !== null)) return

  const waiting = members
    .filter(m => m.matchType === null && m.aiProcessedAt === null && m.aiSkipReason === null && isHandle(m.externalId))
    .sort((a, b) => a.externalId!.localeCompare(b.externalId!))
  // An analysis claimed within the heal's age floor is queued or running. An older one is stalled, and the heal's.
  const stalledBefore = toDbTs(new Date(Date.now() - HEAL_MIN_AGE_MS))
  let room = MAX_COMPANION_ANALYSES_PER_DELIVERY - waiting.filter(m => m.aiAttemptedAt !== null && m.aiAttemptedAt >= stalledBefore).length
  const toFetch: number[] = []
  for (const bill of waiting) {
    if (bill.textR2Key) {
      if (bill.aiAttemptedAt !== null || room <= 0) continue
      if (await queueAnalysis(env, db, bill.id, bill.externalId!)) room--
    } else if (delivered.matchType !== null || (bill.id === delivered.id && (msg.stubOnly || msg.metadataOnly))) {
      toFetch.push(parseHandle(bill.externalId)!)
    }
  }
  if (toFetch.length > 0) await requestFetch(env, toFetch)
}

/** Queue the bill's analysis once: only the delivery that stamps its first attempt does, and it returns true. */
async function queueAnalysis(env: Env, db: AppDb, billId: string, externalId: string): Promise<boolean> {
  if (!env.BILL_QUEUE) return false
  const claimed = await db.update(bills).set({ aiAttemptedAt: nowDb() })
    .where(and(eq(bills.id, billId), isNull(bills.aiAttemptedAt))).run()
  if ((claimed.meta?.changes ?? 0) !== 1) return false
  try {
    await env.BILL_QUEUE.send({ tenantId: env.TENANT_ID, billId: externalId, groupAnalysis: true } satisfies TenantQueueMessage)
  } catch (err) {
    // The attempt is stamped, so the hourly AI heal picks the bill up.
    console.error(`[companion-analysis] could not queue the analysis of ${externalId}:`, err)
  }
  return true
}

async function requestFetch(env: Env, centralBillIds: number[]): Promise<void> {
  try {
    const res = await centralFetch(env, `/tenants/fetch-bills/${env.TENANT_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ billIds: centralBillIds }),
    })
    if (!res.ok) console.warn(`[companion-analysis] central fetch-bills returned ${res.status}`)
  } catch (err) {
    // The next delivery in the group asks again.
    console.error('[companion-analysis] central fetch-bills failed:', err)
  }
}

/**
 * Whether the bill didn't match and its companion group has a tracked bill,
 * which is what pulls it in. A retry or regeneration of its analysis must say
 * so with `groupAnalysis`, since without it the local keywords decide the
 * bill's match type, and central, which said it didn't match, is the source
 * of truth.
 */
export async function isPulledByGroup(db: AppDb, billId: string): Promise<boolean> {
  const members = await db.select({ id: bills.id, matchType: bills.matchType }).from(bills).where(inGroupOf(bills.id, billId)).all()
  return members.some(m => m.id === billId && m.matchType === null) && members.some(m => m.matchType !== null)
}
