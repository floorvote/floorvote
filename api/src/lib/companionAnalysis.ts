import { and, eq, isNull, lte, or, sql } from 'drizzle-orm'
import { bills } from '../db/schema'
import { centralFetch } from './centralFetch'
import { inGroupOf } from './companionGroups'
import { nowDb, toDbTs } from './dbTime'
import { HEAL_MAX_ATTEMPTS, HEAL_MIN_AGE_MS } from './healStalledAi'
import { pickLead, readNewestTexts } from './groupLead'
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
 *   group member, and queues the next one then. The group's lead goes first.
 * - It doesn't: ask central to fetch the bill from its provider, which sends
 *   it back to every instance linked to it. That delivery carries the text,
 *   and so queues the analysis. Central fetches only because a tracked
 *   bill was delivered, or the waiting bill's own stub or metadata update
 *   was, never because of the fetch's own delivery, so the two can't loop.
 *
 * The group shows its lead's analysis (see **Lead bill** in CONTEXT.md). A
 * tracked lead is analyzed again when its own delivery brings a new text, but
 * a pulled one isn't tracked, so its delivery doesn't analyze it. So when the
 * lead is a pulled companion that was analyzed (or permanently skipped) on a
 * text other than its newest, it is queued the same way, as a group analysis,
 * under the same cap. Its claim also takes an attempt older than the heal's age
 * floor, which the heal (for unanalyzed bills only) never retries, so a lost
 * message or a failed analysis is tried again at most once a floor, and each
 * such retry counts toward the heal's attempt cap (`ai_heal_attempts`, which a
 * successful analysis resets). An analysis the text hash deduplicates records
 * the newest text as read (queue/processor.ts), so it isn't queued again.
 *
 * A pulled lead's new texts reach the instance only while its request to
 * central is recent, so a tracked member's delivery, or the lead's own stub or
 * metadata update, renews it, at most weekly (renewLeadRequest).
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
    billNumber: bills.billNumber,
    statusRank: bills.statusRank,
    matchType: bills.matchType,
    aiProcessedAt: bills.aiProcessedAt,
    aiSkipReason: bills.aiSkipReason,
    aiAttemptedAt: bills.aiAttemptedAt,
    textR2Key: bills.textR2Key,
    lastAiTextDocId: bills.lastAiTextDocId,
  }).from(bills).where(inGroupOf(bills.id, delivered.id)).all()
  if (!members.some(m => m.matchType !== null)) return

  // The group's lead, and its newest text, read only for the group's few bills.
  const newest = await readNewestTexts(db, members.map(m => m.id))
  const lead = pickLead(members.map(m => ({ ...m, newestTextDate: newest.get(m.id)?.date ?? null })))
  const leadText = lead ? newest.get(lead.id) : undefined
  const staleLead = lead && lead.matchType === null && isHandle(lead.externalId) && lead.textR2Key
    && (lead.aiProcessedAt !== null || lead.aiSkipReason !== null)
    && leadText !== undefined && leadText.docId !== lead.lastAiTextDocId
    ? lead : null

  const waiting = members
    .filter(m => m.matchType === null && m.aiProcessedAt === null && m.aiSkipReason === null && isHandle(m.externalId))
    .sort((a, b) => Number(b.id === lead?.id) - Number(a.id === lead?.id) || a.externalId!.localeCompare(b.externalId!))
  // An analysis claimed within the heal's age floor is queued or running. An older one is stalled, and the heal's.
  const stalledBefore = toDbTs(new Date(Date.now() - HEAL_MIN_AGE_MS))
  const inFlight = (m: { aiAttemptedAt: string | null }) => m.aiAttemptedAt !== null && m.aiAttemptedAt >= stalledBefore
  let room = MAX_COMPANION_ANALYSES_PER_DELIVERY - [...waiting, ...(staleLead ? [staleLead] : [])].filter(inFlight).length
  if (staleLead && !inFlight(staleLead) && room > 0) {
    if (await queueAnalysis(env, db, staleLead.id, staleLead.externalId!, { before: stalledBefore, staleAgainst: leadText!.docId })) room--
  }
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
  // On a tracked member's delivery, or the lead's own stub or metadata update, which comes when the lead changes.
  const renewsLead = delivered.matchType !== null || (lead?.id === delivered.id && (msg.stubOnly || msg.metadataOnly))
  if (renewsLead && lead && lead.matchType === null && isHandle(lead.externalId) && lead.textR2Key) {
    await renewLeadRequest(env, db, lead.id, lead.externalId!)
  }
}

/** How often a pulled lead's request to central is renewed, at most. */
export const LEAD_RENEWAL_DAYS = 7

/**
 * Keep central ingesting a pulled lead's new texts (#801). Central does so
 * while this instance's request for the bill is recent, and the request is
 * made through fetch-bills only while the bill has no text, so it would lapse
 * while the bill still leads. A tracked member's delivery renews it, and so
 * does the lead's own stub or metadata update (which comes when the lead
 * changes, however quiet its tracked members are), at most once every
 * LEAD_RENEWAL_DAYS: the delivery that stamps `fetch_renewed_at` asks. A lead
 * pulled before #801 has never been renewed, so the first such delivery does.
 * Renewing fetches nothing for a bill central holds current.
 */
async function renewLeadRequest(env: Env, db: AppDb, billId: string, externalId: string): Promise<void> {
  const dueBefore = toDbTs(new Date(Date.now() - LEAD_RENEWAL_DAYS * 86400_000))
  const claimed = await db.update(bills).set({ fetchRenewedAt: nowDb() })
    .where(and(eq(bills.id, billId), or(isNull(bills.fetchRenewedAt), lte(bills.fetchRenewedAt, dueBefore)))).run()
  if ((claimed.meta?.changes ?? 0) !== 1) return
  try {
    const res = await centralFetch(env, `/tenants/renew-fetch-requests/${env.TENANT_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ billIds: [parseHandle(externalId)!] }),
    })
    // An error, not a warning, so a refusal across the fleet shows in the error logs.
    if (!res.ok) console.error(`[companion-analysis] central renew-fetch-requests returned ${res.status} for ${externalId}`)
  } catch (err) {
    // The request stays live until central's window ends, and the next week's delivery renews it.
    console.error('[companion-analysis] central renew-fetch-requests failed:', err)
  }
}

/**
 * Queue the bill's analysis once: only the delivery that stamps its attempt
 * does, and it returns true. The attempt must be unclaimed, or, with
 * `reclaim`, claimed before `reclaim.before` with fewer than the heal's
 * attempts used, each such reclaim counting one, and only while the bill's
 * analysis still hasn't read `reclaim.staleAgainst` (one that finished since
 * the caller read the bill makes it current).
 */
async function queueAnalysis(
  env: Env, db: AppDb, billId: string, externalId: string,
  reclaim?: { before: string; staleAgainst: string },
): Promise<boolean> {
  if (!env.BILL_QUEUE) return false
  const claimed = reclaim === undefined
    ? await db.update(bills).set({ aiAttemptedAt: nowDb() })
      .where(and(eq(bills.id, billId), isNull(bills.aiAttemptedAt))).run()
    : await db.update(bills).set({
      aiAttemptedAt: nowDb(),
      aiHealAttempts: sql`CASE WHEN ${bills.aiAttemptedAt} IS NULL THEN ${bills.aiHealAttempts} ELSE ${bills.aiHealAttempts} + 1 END`,
    }).where(and(
      eq(bills.id, billId),
      sql`(${bills.aiAttemptedAt} IS NULL OR (${bills.aiAttemptedAt} < ${reclaim.before} AND ${bills.aiHealAttempts} < ${HEAL_MAX_ATTEMPTS}))`,
      sql`${bills.lastAiTextDocId} IS NOT ${reclaim.staleAgainst}`,
    )).run()
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
