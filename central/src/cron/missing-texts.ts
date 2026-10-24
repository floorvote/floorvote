import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm'
import { bills, billTenants, billTexts } from '../db/schema'
import { dbTimeAgo, nowDb } from '../lib/dbTime'
import { groupByIngestQueue } from '../lib/providerRouting'
import { fetchRequestCutoff } from '../lib/fetchRequests'
import type { Db, Env, IngestorMessage } from '../types'

/**
 * Bills a run queues. Each makes no `getBill` call; a text whose state link
 * fails falls back to the provider's copy, one call per document, once.
 */
export const MISSING_TEXTS_PER_RUN = 50

/** A bill ingested more recently than this may still be downloading its texts. */
const INGEST_SETTLE_MS = 60 * 60 * 1000

/** D1 binds at most 100 parameters. */
const STAMP_CHUNK = 90

/**
 * Queue the bills instances read whose texts no download attempt ever reached:
 * tracked bills, and leads an instance has asked for (lib/fetchRequests.ts).
 *
 * An ingest writes a bill's detail and its text rows before it downloads the
 * texts, so one that dies in between leaves texts with no `r2_key` and no
 * `fetch_attempted_at`, on a bill whose detail reads as current. No later sync
 * revisits it, and the instance shows "Text not cached" until the bill changes
 * upstream. Each queued bill downloads its missing texts from their state
 * links (the `skipFetch` path). The sweep stamps the texts it picks as
 * attempted, so it picks each one once; a download that fails records its
 * error, and retrying it is POST /admin/refetch-bill-text's job.
 */
export async function queueMissingTexts(env: Env, db: Db): Promise<{ queued: number }> {
  const rows = await db.selectDistinct({ billId: billTexts.billId })
    .from(billTexts)
    .innerJoin(bills, eq(bills.billId, billTexts.billId))
    .innerJoin(billTenants, and(
      eq(billTenants.billId, billTexts.billId),
      // Tracked, or read without tracking while the instance's request is in
      // effect: a companion group's lead, whose text the tracked bill's page shows.
      or(isNotNull(billTenants.matchType), gt(billTenants.fetchRequestedAt, fetchRequestCutoff())),
    ))
    .where(and(
      isNull(billTexts.r2Key),
      isNull(billTexts.fetchAttemptedAt),
      isNotNull(billTexts.stateLink),
      // A first full ingest stamps this only once it has written everything.
      isNotNull(bills.textsFetchedAt),
      lt(bills.textsFetchedAt, dbTimeAgo(INGEST_SETTLE_MS)),
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
  // Stamped as attempted once queued, so a download that hangs or errors before
  // stamping its own attempt never brings the bill back. Only the rows picked:
  // a failed text the same message retries keeps its own record.
  const queuedAt = nowDb()
  for (let i = 0; i < billIds.length; i += STAMP_CHUNK) {
    await db.update(billTexts).set({ fetchAttemptedAt: queuedAt }).where(and(
      inArray(billTexts.billId, billIds.slice(i, i + STAMP_CHUNK)),
      isNull(billTexts.r2Key),
      isNull(billTexts.fetchAttemptedAt),
      isNotNull(billTexts.stateLink),
    ))
  }
  return { queued: billIds.length }
}
