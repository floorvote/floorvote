import { and, eq, inArray, isNotNull, sql, type SQL } from 'drizzle-orm'
import { associationConfig, bills, feedEvents } from '../db/schema'
import { groupUntriaged, type BillsTable } from './teamFields'
import { chunk } from './chunk'
import type { AppDb } from '../types'

/**
 * Minimum relevance score for a keyword match to surface as a new match: in the
 * "New matches" worklist, the "N new" chip, the digest's new-match section, and
 * the feed's new-matches row. Stored in association_config as
 * `new_match_min_relevance`. Default 0 — every keyword match surfaces. Invalid or
 * negative values are treated as 0. The per-bill feed `bill_matched` event is NOT
 * gated by this threshold: it is the record that a bill matched, and it shows as
 * a row on the bill's card once the bill has a priority.
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
 * The one definition of a new match: an un-triaged, analyzed keyword match
 * at or above the instance's minimum relevance. Shared by the triage list
 * (GET /bills?newMatches=1), its facet count, the "N new" chip, and the digest,
 * so they can't drift. COALESCE(relevance,0) means with the default threshold 0 a
 * match with no relevance score still qualifies; a positive threshold excludes it
 * until scored. Triaging any bill in a companion group triages the group, so a
 * bill whose companion was triaged is no longer new. Bulk and routine matches
 * alike: the triage list shows both. `t` is the bills table or an alias of it.
 */
export function newMatchWhere(minRelevance: number, t: BillsTable = bills): SQL {
  return and(
    eq(t.matchType, 'keyword'),
    isNotNull(t.newMatchAt),
    groupUntriaged(t),
    sql`COALESCE(${t.relevanceScore}, 0) >= ${minRelevance}`,
  )!
}

/**
 * Of these companion groups, the keys of those that read as an untriaged new
 * match: some member is a keyword match that came in as a new match, and no
 * member has a priority or is triaged (triaging or prioritizing any bill
 * triages the group). The group-row aggregate of the Bills list, which draws a
 * new match's amber priority dropdown from the same four fields, so a feed card
 * and a bills row agree (`isUntriagedNewMatch` in web/src/lib/newMatch.ts).
 * Minimum relevance gates the triage worklist only, never that amber state.
 */
export async function loadUntriagedNewMatchGroups(db: AppDb, groupKeys: ReadonlyArray<string | null | undefined>): Promise<Set<string>> {
  const facts = new Map<string, { keyword: boolean; arrived: boolean; resolved: boolean }>()
  for (const part of chunk([...new Set(groupKeys.filter((k): k is string => !!k))], 90)) {
    for (const r of await db.select({
      groupKey: bills.groupKey, matchType: bills.matchType, newMatchAt: bills.newMatchAt, priority: bills.priority, triagedAt: bills.triagedAt,
    }).from(bills).where(inArray(bills.groupKey, part)).all()) {
      const f = facts.get(r.groupKey!) ?? { keyword: false, arrived: false, resolved: false }
      f.keyword ||= r.matchType === 'keyword'
      f.arrived ||= r.newMatchAt !== null
      f.resolved ||= r.priority !== null || r.triagedAt !== null
      facts.set(r.groupKey!, f)
    }
  }
  return new Set([...facts].filter(([, f]) => f.keyword && f.arrived && !f.resolved).map(([key]) => key))
}

/** The columns that say whether a bill reads as an untriaged new match (see untriagedNewMatch). */
export type NewMatchFacts = {
  groupKey: string | null | undefined
  matchType: string | null | undefined
  newMatchAt: string | null | undefined
  priority: string | null | undefined
  triagedAt: string | null | undefined
}

/**
 * Whether a bill reads as an untriaged new match: the amber state of its priority
 * dropdown, on a feed card and on the no-priority row's list alike. A bill in a
 * companion group reads as its group does, `groups` being the keys
 * loadUntriagedNewMatchGroups found; a bill in no group reads its own columns.
 */
export function untriagedNewMatch(b: NewMatchFacts, groups: ReadonlySet<string>): boolean {
  return b.groupKey
    ? groups.has(b.groupKey)
    : b.matchType === 'keyword' && b.newMatchAt != null && b.priority == null && b.triagedAt == null
}

/**
 * A new match that is routine (MatchProvenance in types.ts): the ones the digest
 * lists, and the feed shows. A bulk match, or one with no provenance, is left out.
 */
export function routineNewMatchWhere(minRelevance: number, t: BillsTable = bills): SQL {
  return and(newMatchWhere(minRelevance, t), eq(t.matchProvenance, 'routine'))!
}

/**
 * Adds a new match to the feed's summary row for the day: one bill-less
 * `new_matches` event, whose metadata.billIds names the bills it counts. Called
 * once, when a bill's match is recorded. Opt-in: only a routine match above the
 * instance's minimum, judged by routineNewMatchWhere, ever joins the row, so a
 * bulk match, one with no provenance, and one already triaged or prioritized
 * never do. The row is brought forward to now, so it lights the feed dot again.
 *
 * The write is one upsert on the day's unique index (migration 0099), so
 * matches processed at the same moment share the row instead of racing to
 * create two or overwriting each other's bill ids. A bill already on the row
 * changes nothing.
 */
export async function addToNewMatchesRow(db: AppDb, billId: string): Promise<void> {
  await newMatchesRowStatement(db, billId, await getNewMatchMinRelevance(db))
}

/**
 * addToNewMatchesRow as one statement, for a batch: the bill qualifies when the
 * statement runs, so in the processor's batch (#906) it is judged on the bill
 * row written earlier in the same batch. `minRelevance` is read beforehand
 * (getNewMatchMinRelevance).
 */
export function newMatchesRowStatement(db: AppDb, billId: string, minRelevance: number, condition?: SQL) {
  const named = sql`EXISTS (SELECT 1 FROM json_each(feed_events.metadata, '$.billIds') WHERE value = ${billId})`
  // Columns in feed_events' order: id, type, bill_id, user_id, metadata, suppressed, created_at. The SELECT
  // needs its WHERE for SQLite to read the ON CONFLICT as an upsert, which it has.
  return db.insert(feedEvents).select(sql`
    SELECT ${crypto.randomUUID()}, 'new_matches', NULL, 'system', json_object('billIds', json_array(${billId})), 0, datetime('now')
      FROM bills
     WHERE ${bills.id} = ${billId} AND ${routineNewMatchWhere(minRelevance)} AND ${condition ?? sql`1`}
  `).onConflictDoUpdate({
    target: sql`date(created_at)`,
    targetWhere: sql`type = 'new_matches'`,
    set: {
      metadata: sql`CASE WHEN ${named} THEN feed_events.metadata ELSE json_set(feed_events.metadata, '$.billIds[#]', ${billId}) END`,
      createdAt: sql`CASE WHEN ${named} THEN feed_events.created_at ELSE datetime('now') END`,
    },
  })
}
