import { and, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm'
import { associationConfig, bills } from '../db/schema'
import type { AppDb } from '../types'

/**
 * Minimum relevance score for a keyword match to surface as a new match: in the
 * "New matches" worklist, the "N new" chip, and the digest's new-match section.
 * Stored in association_config as `new_match_min_relevance`. Default 0 — every
 * keyword match surfaces. Invalid or negative values are treated as 0. The feed
 * `bill_matched` event is NOT gated by this threshold (the analyzed-scope feed is
 * the comprehensive match record).
 */
export async function getNewMatchMinRelevance(db: AppDb): Promise<number> {
  const row = await db.select().from(associationConfig)
    .where(eq(associationConfig.key, 'new_match_min_relevance')).get()
  if (!row?.value) return 0
  let raw = row.value
  try {
    const parsed = JSON.parse(row.value)
    if (typeof parsed === 'number' || typeof parsed === 'string') raw = String(parsed)
  } catch { /* plain string */ }
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * The one definition of a new match: an un-triaged, fully-analyzed keyword match
 * at or above the instance's minimum relevance. Shared by the triage list
 * (GET /bills?newMatches=1), its facet count, the "N new" chip, and the digest,
 * so they can't drift. COALESCE(relevance,0) means with the default threshold 0 a
 * match with no relevance score still qualifies; a positive threshold excludes it
 * until scored. Bulk and routine matches alike: the triage list shows both.
 */
export function newMatchWhere(minRelevance: number): SQL {
  return and(
    eq(bills.matchType, 'keyword'),
    isNotNull(bills.newMatchAt),
    isNull(bills.triagedAt),
    sql`COALESCE(${bills.relevanceScore}, 0) >= ${minRelevance}`,
  )!
}

/**
 * A new match that is routine (MatchProvenance in types.ts): the ones the digest
 * lists, and the feed shows. A bulk match, or one with no provenance, is left out.
 */
export function routineNewMatchWhere(minRelevance: number): SQL {
  return and(newMatchWhere(minRelevance), eq(bills.matchProvenance, 'routine'))!
}
