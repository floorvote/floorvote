import { inArray } from 'drizzle-orm'
import { bills } from '../db/schema'
import { refreshStaleStub } from './stubRefresh'
import { dbTimeAgo } from './dbTime'
import type { Db } from '../types'

/**
 * An instance's request for a bill it doesn't track (#801).
 *
 * An instance asks central for a bill through POST /tenants/fetch-bills when
 * it analyzes the bill through a companion group without tracking it (a pulled
 * companion, api/src/lib/companionAnalysis.ts). The ask is stamped on the
 * instance's link to the bill (`bill_tenants.fetch_requested_at`). The sync
 * sends a bill no instance tracks only stubs, so central would keep the texts
 * it fetched when it was asked. While the request is recent, the sync instead
 * ingests the bill whenever its change hash moves, so the instance gets its new
 * texts. Central can't see the instance's groups, so the request ends after
 * FETCH_REQUEST_DAYS without another ask, or when the link goes.
 *
 * A LegiScan ingest costs a getBill against the monthly budget, so these spend
 * the share untracked bills' fetches get (lib/stubRefresh.ts) and claim one
 * fetch per change. Other providers' ingests are unmetered.
 */
export const FETCH_REQUEST_DAYS = 90

/** The oldest `fetch_requested_at` still in effect at `now`, in the stored format. */
export function fetchRequestCutoff(now: Date = new Date()): string {
  return dbTimeAgo(FETCH_REQUEST_DAYS * 86400_000, now)
}

/**
 * Queue a fetch of each listed bill whose detail is behind its change hash,
 * within the untracked-bill budget, and return the ids queued. A bill that is
 * current, has a fetch queued for its change already, isn't LegiScan's, or is
 * past the budget is left out.
 */
export async function refreshRequestedBills(db: Db, queue: Queue, billIds: number[]): Promise<Set<number>> {
  const queued = new Set<number>()
  for (let i = 0; i < billIds.length; i += 90) {
    const rows = await db.select({
      billId: bills.billId, provider: bills.provider, changeHash: bills.changeHash, detailHash: bills.detailHash,
      detailRequestedHash: bills.detailRequestedHash, detailRequestedAt: bills.detailRequestedAt,
    }).from(bills).where(inArray(bills.billId, billIds.slice(i, i + 90))).all()
    rows.sort((a, b) => a.billId - b.billId)
    for (const row of rows) if (await refreshStaleStub(db, queue, row)) queued.add(row.billId)
  }
  return queued
}
