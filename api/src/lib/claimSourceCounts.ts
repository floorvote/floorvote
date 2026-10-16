import { sql } from 'drizzle-orm'
import type { AppDb } from '../types'
import type { ClaimSourceStatus } from './claimSources'

// How well an instance's claim links resolve (#573, design in #560), for the
// operators who run central. Everything here is a count: no claim, quote, or
// bill id leaves the instance, so what central shows can't be traced to a bill.
//
// Read from the stored claim sources with json_each, so there is no table of
// its own to keep in step. The one thing the bills can't say is how often a
// response was cut off inside the claim sources and retried without them: that
// leaves only a null list, which looks like "never asked". A single counter in
// association_config records it (below).

/** The statuses a resolved item carries, in the order a reader should see them. */
export const CLAIM_SOURCE_STATUSES: readonly ClaimSourceStatus[] = ['exact', 'normalized', 'fuzzy', 'anchored', 'ungrounded', 'unverified']

export type ClaimSourceCounts = {
  /**
   * Bills by what their analysis stored for claim sources.
   * - `withClaimSources`: a list with at least one item.
   * - `emptyList`: asked for claim sources, and nothing usable came back (`[]`).
   * - `noList`: an AI-processed bill with none stored (null): analyzed before
   *   claim links, or with the setting off, or on its title and abstract alone,
   *   or retried without them after a cut-off response.
   */
  analyses: { withClaimSources: number; emptyList: number; noList: number }
  /** Stored items by how their quote resolved. `total` is their sum. */
  items: Record<ClaimSourceStatus, number> & { total: number }
  /** Analyses whose response was cut off inside the claim sources and retried without them, since this count began. */
  cutOffRetries: number
}

/** The `association_config` key holding the cut-off retry count. Not in the admin config's allowlist, so not served. */
const CUTOFF_KEY = 'claim_sources_cutoff_retries'

const asCount = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

export async function computeClaimSourceCounts(db: AppDb): Promise<ClaimSourceCounts> {
  // The stored list read as JSON, or an empty list when it is null, not JSON, or
  // not a list. Nested CASEs, because AND does not promise to skip its right side:
  // a json_* call on text that isn't JSON throws, and one damaged row would then
  // blank the whole operator view.
  const list = sql.raw(`CASE WHEN json_valid(claim_sources) THEN CASE WHEN json_type(claim_sources) = 'array' THEN claim_sources ELSE '[]' END ELSE '[]' END`)
  const [byStatus, bills, cutOff] = await Promise.all([
    // j.type guards the status read the same way: an item that isn't an object has no status.
    db.all<{ item_status: string | null; n: number }>(sql`
      SELECT CASE WHEN j.type = 'object' THEN json_extract(j.value, '$.status') END AS item_status, COUNT(*) AS n
      FROM (SELECT ${list} AS claim_sources FROM bills WHERE claim_sources IS NOT NULL) b, json_each(b.claim_sources) j
      GROUP BY item_status`),
    // A searched CASE stops at the first WHEN that holds, so each json_* call
    // runs only on a value the one before it passed.
    db.get<{ withClaimSources: number | null; emptyList: number | null; noList: number | null }>(sql`
      SELECT
        SUM(CASE WHEN claim_sources IS NULL THEN 0 WHEN NOT json_valid(claim_sources) THEN 0 WHEN json_type(claim_sources) <> 'array' THEN 0
                 WHEN json_array_length(claim_sources) > 0 THEN 1 ELSE 0 END) AS withClaimSources,
        SUM(CASE WHEN claim_sources IS NULL THEN 0 WHEN NOT json_valid(claim_sources) THEN 0 WHEN json_type(claim_sources) <> 'array' THEN 0
                 WHEN json_array_length(claim_sources) = 0 THEN 1 ELSE 0 END) AS emptyList,
        SUM(CASE WHEN claim_sources IS NULL AND ai_processed_at IS NOT NULL THEN 1 ELSE 0 END) AS noList
      FROM bills`),
    db.get<{ value: string }>(sql`SELECT value FROM association_config WHERE key = ${CUTOFF_KEY}`),
  ])

  const items = Object.fromEntries(CLAIM_SOURCE_STATUSES.map(s => [s, 0])) as Record<ClaimSourceStatus, number>
  for (const row of byStatus) {
    if (row.item_status !== null && (CLAIM_SOURCE_STATUSES as readonly string[]).includes(row.item_status)) {
      items[row.item_status as ClaimSourceStatus] += asCount(row.n)
    }
  }

  return {
    analyses: {
      withClaimSources: asCount(bills?.withClaimSources),
      emptyList: asCount(bills?.emptyList),
      noList: asCount(bills?.noList),
    },
    items: { ...items, total: CLAIM_SOURCE_STATUSES.reduce((sum, s) => sum + items[s], 0) },
    cutOffRetries: asCount(cutOff?.value),
  }
}

/**
 * Count one analysis whose response was cut off inside the claim sources and
 * retried without them (lib/llm.ts), whose summary was then stored with no
 * claim sources. One atomic statement, so concurrent analyses lose no counts.
 * A stored value that isn't a number reads as zero and counts on from one.
 */
export async function recordClaimSourcesCutOff(db: AppDb): Promise<void> {
  await db.run(sql`
    INSERT INTO association_config (key, value) VALUES (${CUTOFF_KEY}, '1')
    ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`)
}

/** The counts plus when they were counted, as the operator view shows them. */
export type ClaimSourceCountsSnapshot = ClaimSourceCounts & { computedAt: string }

// Stub for the red run: no cache.
export async function cachedClaimSourceCounts(db: AppDb, now: number = Date.now()): Promise<ClaimSourceCountsSnapshot> {
  return { ...(await computeClaimSourceCounts(db)), computedAt: new Date(now).toISOString() } // ts-write-ok: response payload, never a DB column
}
