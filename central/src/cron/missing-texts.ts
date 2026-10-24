import { and, asc, eq, isNotNull, isNull, or, lt } from 'drizzle-orm'
import { bills, billTenants, billTexts } from '../db/schema'
import { dbTimeAgo } from '../lib/dbTime'
import { groupByIngestQueue } from '../lib/providerRouting'
import type { Db, Env, IngestorMessage } from '../types'

/**
 * Bills a run queues. Each makes no `getBill` call; a text whose state link
 * fails falls back to the provider's copy, one call per document, once.
 */
export const MISSING_TEXTS_PER_RUN = 50

/** A bill ingested more recently than this may still be downloading its texts. */
const INGEST_SETTLE_MS = 60 * 60 * 1000

/**
 * Queue the tracked bills whose texts no download attempt ever reached.
 *
 * An ingest writes a bill's detail and its text rows before it downloads the
 * texts, so one that dies in between leaves texts with no `r2_key` and no
 * `fetch_attempted_at`, on a bill whose detail reads as current. No later sync
 * revisits it, and the instance shows "Text not cached" until the bill changes
 * upstream. Each queued bill downloads its missing texts from their state
 * links (the `skipFetch` path), which stamps every attempt, so a text is picked
 * up once. A failed attempt is left to POST /admin/refetch-bill-text, since its
 * fallback may spend a provider call.
 */
export async function queueMissingTexts(env: Env, db: Db): Promise<{ queued: number }> {
  const rows = await db.selectDistinct({ billId: billTexts.billId })
    .from(billTexts)
    .innerJoin(bills, eq(bills.billId, billTexts.billId))
    .innerJoin(billTenants, and(eq(billTenants.billId, billTexts.billId), isNotNull(billTenants.matchType)))
    .where(and(
      isNull(billTexts.r2Key),
      isNull(billTexts.fetchAttemptedAt),
      isNotNull(billTexts.stateLink),
      or(isNull(bills.textsFetchedAt), lt(bills.textsFetchedAt, dbTimeAgo(INGEST_SETTLE_MS))),
    ))
    .orderBy(asc(billTexts.billId))
    .limit(MISSING_TEXTS_PER_RUN)
    .all()

  const billIds = rows.map(r => r.billId)
  for (const { queue, billIds: ids } of await groupByIngestQueue(billIds, env, db)) {
    for (let i = 0; i < ids.length; i += 100) {
      await queue.sendBatch(ids.slice(i, i + 100).map(billId => ({
        body: { billId, forceMetadata: true, skipFetch: true } as IngestorMessage,
      })))
    }
  }
  return { queued: billIds.length }
}
