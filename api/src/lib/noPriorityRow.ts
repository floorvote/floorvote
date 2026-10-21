import { sql, type SQL } from 'drizzle-orm'
import { feedEvents } from '../db/schema'
import { LEGISLATIVE_EVENT_TYPES, NO_PRIORITY_UPDATES, PASSIVE_EVENT_TYPES } from '../../../shared/feedUtils'
import { dbTsToEpoch } from '../../../shared/time'
import { filedSlug } from './sessionSlug'
import { loadUntriagedNewMatchGroups, untriagedNewMatch, type NewMatchFacts } from './newMatch'
import type { AppDb } from '../types'

// The no-priority updates row (see **No-priority updates row** in CONTEXT.md):
// the feed's one bill-less row a day for legislative activity on analyzed bills
// with no priority. The row stores nothing about its bills. They are resolved
// here, on every read, from the day's events, by the rule `standsFor` below,
// which is the exact complement of the default feed's rule for showing a bill's
// passive events (routes/feed.ts): a bill's legislative event of the day is the
// row's when the default feed would hide it, and its card's when it would show
// it. So a bill that gains a priority, or the team's attention that day, moves
// from the row to its own card on the next read, and is never in both.
//
// Every query here starts from the day's events, through the created_at index,
// and only then looks at each one's bill. Started from bills, a query visits
// every analyzed bill and its whole history, and SQLite's planner starts there
// once 0121's rebuild has left feed_events with no statistics. So the events
// and bills are joined with CROSS JOIN, which SQLite never reorders.
// test/routes/feed.noPriorityRow.cost.test.ts holds the plans to that.

// Constant type lists, written into the SQL rather than bound: they repeat in
// every subquery, and D1 allows only 100 bound parameters a statement.
const typeList = (types: Iterable<string>) => sql.raw([...types].map((t) => `'${t}'`).join(', '))
const LEGISLATIVE = typeList(LEGISLATIVE_EVENT_TYPES)
const PASSIVE = typeList(PASSIVE_EVENT_TYPES)

/** The team engaged, on the UTC day of event `m`, with a bill `sibBills` picks out of `feed_events sib`. */
const engagedThatDay = (sibBills: SQL) => sql`EXISTS (
    SELECT 1 FROM feed_events sib
     WHERE ${sibBills}
       AND sib.suppressed != 1
       AND date(sib.created_at) = date(m.created_at)
       AND sib.type NOT IN (${PASSIVE})
  )`

/** The events and bills the rules below read, outer loop first. */
const EVENTS_THEN_BILLS = sql`feed_events m CROSS JOIN bills mb ON mb.id = m.bill_id`

/**
 * An event `m` (feed_events) on bill `mb` (bills), stored in [from, to) (UTC
 * dates, YYYY-MM-DD), is the row's for its day: a legislative event on an
 * analyzed bill at or above the minimum relevance for new matches, whose
 * companion group has no priority and was not engaged with that day.
 *
 * Both stored timestamp formats (`2026-03-04 09:00:00` and
 * `2026-03-04T09:00:00Z`) begin with the UTC date, so comparing the raw column
 * with the dates picks exactly the days in the range, through the index.
 */
function standsFor(from: SQL, to: SQL, minRelevance: number): SQL {
  return sql`m.created_at >= ${from} AND m.created_at < ${to}
    AND m.suppressed != 1
    AND m.type IN (${LEGISLATIVE})
    AND mb.match_type IS NOT NULL
    AND COALESCE(mb.relevance_score, 0) >= ${minRelevance}
    AND mb.priority IS NULL
    AND (mb.group_key IS NULL OR NOT EXISTS (SELECT 1 FROM bills g WHERE g.group_key = mb.group_key AND g.priority IS NOT NULL))
    AND NOT ${engagedThatDay(sql`sib.bill_id = mb.id`)}
    AND (mb.group_key IS NULL OR NOT ${engagedThatDay(sql`sib.bill_id IN (SELECT g.id FROM bills g WHERE g.group_key = mb.group_key)`)})`
}

/**
 * For GET /feed's WHERE: the row on `feed_events` stands for at least one
 * bill. A row that resolves to none is left out of the page and the total, so
 * pagination stays honest.
 */
export function rowStandsForABill(minRelevance: number): SQL {
  return sql`(${feedEvents.type} = ${NO_PRIORITY_UPDATES} AND EXISTS (
    SELECT 1 FROM ${EVENTS_THEN_BILLS}
     WHERE ${standsFor(sql`date(${feedEvents.createdAt})`, sql`date(${feedEvents.createdAt}, '+1 day')`, minRelevance)}
  ))`
}

/** The UTC date (YYYY-MM-DD) of a stored timestamp, in either format. */
export const utcDay = (ts: string) => new Date(dbTsToEpoch(ts)).toISOString().slice(0, 10)
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10)
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/**
 * One entry of a day's row: a bill, or the members of one companion group that
 * moved that day (a group is one policy), its most relevant member first.
 */
export type DayEntry = { key: string; relevance: number; memberIds: string[] }

/** A day of the row: its entries, most relevant first, and when its newest update landed (space format). */
export type RowDay = { entries: DayEntry[]; lastAt: string }

/**
 * The row's entries for each of these UTC days, in one query: entries most
 * relevant first, a companion group ranked by its most relevant member that
 * moved, and ties by key, so pages of the list never overlap or skip. A day
 * with no bill is absent from the map.
 */
export async function rowDays(db: AppDb, days: readonly string[], minRelevance: number): Promise<Map<string, RowDay>> {
  const out = new Map<string, RowDay>()
  if (days.length === 0) return out
  const sorted = [...new Set(days)].sort()
  const rows = await db.all(sql`
    SELECT date(m.created_at) AS day, mb.id AS id, mb.group_key AS group_key,
           COALESCE(mb.relevance_score, 0) AS relevance, MAX(datetime(m.created_at)) AS last_at
      FROM ${EVENTS_THEN_BILLS}
     WHERE ${standsFor(sql`${sorted[0]}`, sql`${nextDay(sorted[sorted.length - 1])}`, minRelevance)}
       AND date(m.created_at) IN (SELECT value FROM json_each(${JSON.stringify(sorted)}))
     GROUP BY day, mb.id
  `) as Array<{ day: string; id: string; group_key: string | null; relevance: number; last_at: string }>

  const members = new Map<string, Map<string, Array<{ id: string; relevance: number }>>>()
  for (const r of rows) {
    const key = r.group_key !== null ? `group:${r.group_key}` : r.id
    const ofDay = members.get(r.day) ?? new Map<string, Array<{ id: string; relevance: number }>>()
    ofDay.set(key, [...(ofDay.get(key) ?? []), { id: r.id, relevance: r.relevance }])
    members.set(r.day, ofDay)
    const day = out.get(r.day)
    if (!day || r.last_at > day.lastAt) out.set(r.day, { entries: [], lastAt: r.last_at })
  }
  for (const [day, ofDay] of members) {
    const entries = [...ofDay].map(([key, ms]) => {
      ms.sort((a, b) => b.relevance - a.relevance || byId(a, b))
      return { key, relevance: ms[0].relevance, memberIds: ms.map((m) => m.id) }
    })
    entries.sort((a, b) => b.relevance - a.relevance || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    out.get(day)!.entries = entries
  }
  return out
}

/** A bill of the row, as a chip, its hover card, and its title need it. */
export type RowBill = {
  id: string; billNumber: string; title: string; state: string | null; sessionSlug: string | null
  isDraft: boolean; groupKey: string | null; summary: string | null
}

/** These bills as the row shows them, in one query, by id, each with the columns that say whether it reads as a new match. */
async function loadRowBills(db: AppDb, ids: readonly string[]): Promise<Map<string, { bill: RowBill; facts: NewMatchFacts }>> {
  const out = new Map<string, { bill: RowBill; facts: NewMatchFacts }>()
  if (ids.length === 0) return out
  const rows = await db.all(sql`
    SELECT b.id, b.bill_number, b.title, b.abstract, b.state, b.session, b.session_slug, b.is_draft, b.group_key, b.tenant_summary,
           b.match_type, b.new_match_at, b.priority, b.triaged_at
      FROM bills b WHERE b.id IN (SELECT value FROM json_each(${JSON.stringify([...new Set(ids)])}))
  `) as Array<{
    id: string; bill_number: string; title: string | null; abstract: string | null; state: string | null
    session: string | null; session_slug: string | null; is_draft: number | null; group_key: string | null; tenant_summary: string | null
    match_type: string | null; new_match_at: string | null; priority: string | null; triaged_at: string | null
  }>
  for (const b of rows) {
    out.set(b.id, {
      bill: {
        id: b.id, billNumber: b.bill_number, title: b.title || b.abstract || '', state: b.state ?? null,
        sessionSlug: filedSlug({ session: b.session, sessionSlug: b.session_slug }), isDraft: !!b.is_draft,
        groupKey: b.group_key, summary: b.tenant_summary ?? null,
      },
      facts: { groupKey: b.group_key, matchType: b.match_type, newMatchAt: b.new_match_at, priority: b.priority, triagedAt: b.triaged_at },
    })
  }
  return out
}

/** These bills as the row shows them, in one query, by id. */
export async function rowBills(db: AppDb, ids: readonly string[]): Promise<Map<string, RowBill>> {
  return new Map([...await loadRowBills(db, ids)].map(([id, { bill }]) => [id, bill]))
}

/** A bill-less view of one of the row's events, which the web builds a card row from. */
export type RowEvent = { id: string; type: string; billId: string; metadata: unknown; createdAt: string }

/**
 * One entry of a page of the row's list. `newMatch`: the entry reads as an
 * untriaged new match, as the feed's cards decide it (untriagedNewMatch), so an
 * admin's dropdown for it is the amber "New · Set priority" with Dismiss. A
 * group reads as its group does.
 */
export type RowEntry = { key: string; newMatch: boolean; bills: RowBill[]; events: RowEvent[] }

/**
 * A page of the row's list for UTC day `day`: each entry's moved bills and
 * their events that day, newest first, and whether it is a new match. Three
 * queries whatever the page's size (a fourth when an entry is a companion group,
 * which reads its members once for the whole page).
 * The events are read through the day's range, like every query here: the
 * unary + keeps SQLite from looking each bill up by bill_id instead, which
 * would read each one's whole history, a cost that grows through a session.
 */
export async function rowPage(db: AppDb, day: string, minRelevance: number, entries: readonly DayEntry[]): Promise<RowEntry[]> {
  const ids = entries.flatMap((e) => e.memberIds)
  if (ids.length === 0) return []
  const loaded = await loadRowBills(db, ids)
  const newMatchGroups = await loadUntriagedNewMatchGroups(db, [...loaded.values()].map((l) => l.facts.groupKey))
  const events = await db.all(sql`
    SELECT m.id, m.type, m.bill_id, m.metadata, m.created_at
      FROM ${EVENTS_THEN_BILLS}
     WHERE ${standsFor(sql`${day}`, sql`${nextDay(day)}`, minRelevance)}
       AND +m.bill_id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
  `) as Array<{ id: string; type: string; bill_id: string; metadata: string; created_at: string }>
  const byBill = new Map<string, RowEvent[]>()
  for (const e of events) {
    byBill.set(e.bill_id, [...(byBill.get(e.bill_id) ?? []), { id: e.id, type: e.type, billId: e.bill_id, metadata: JSON.parse(e.metadata) as unknown, createdAt: e.created_at }])
  }
  return entries.map((entry) => {
    // The entry's lead is its first bill that still exists: the bill its title names and a priority is set through.
    const lead = entry.memberIds.map((id) => loaded.get(id)).find((l) => l !== undefined)
    return {
      key: entry.key,
      newMatch: lead !== undefined && untriagedNewMatch(lead.facts, newMatchGroups),
      bills: entry.memberIds.flatMap((id) => loaded.get(id)?.bill ?? []),
      events: entry.memberIds.flatMap((id) => byBill.get(id) ?? [])
        .sort((a, b) => dbTsToEpoch(b.createdAt) - dbTsToEpoch(a.createdAt) || (a.id < b.id ? 1 : -1)),
    }
  })
}

/**
 * The write that makes sure the day has its row, for a legislative event just
 * written on `billId` at `at` (space format). Run it in one batch with the
 * event's own insert, at the event's time, so the two share a day and land or
 * fail together: apart, an update at 23:59:59 could get its row on the next
 * day, and a failure between them would leave an update no read shows.
 *
 * Written for any analyzed bill, priority or not: the row is resolved on every
 * read, and one that stands for no bill never shows, so a priority cleared
 * later that day (a bulk edit leaves no event on the bill) still finds the
 * day's row. A bill with no match type is never the row's, so writes none.
 *
 * One insert that does nothing on a conflict, and the only uniqueness it can
 * meet is the day's unique index (migration 0121), so updates processed at the
 * same moment share the row. An insert of a select, so it can join a batch.
 * The row keeps the time of the day's first update, which orders it on the
 * server. GET /feed sends its newest update's time too, which places it for the viewer.
 */
export function noteLegislativeEvent(db: AppDb, billId: string, at: string) {
  // Columns in feed_events' order: id, type, bill_id, user_id, metadata, suppressed, created_at.
  return db.insert(feedEvents).select(sql`
    SELECT ${crypto.randomUUID()}, ${NO_PRIORITY_UPDATES}, NULL, 'system', '{}', 0, ${at}
     WHERE EXISTS (SELECT 1 FROM bills WHERE id = ${billId} AND match_type IS NOT NULL)
  `).onConflictDoNothing()
}
