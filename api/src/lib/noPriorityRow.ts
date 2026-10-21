import { sql, type SQL } from 'drizzle-orm'
import { feedEvents } from '../db/schema'
import { LEGISLATIVE_EVENT_TYPES, NO_PRIORITY_UPDATES, PASSIVE_EVENT_TYPES } from '../../../shared/feedUtils'
import { filedSlug } from './sessionSlug'
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

// Constant type lists, written into the SQL rather than bound: they repeat in
// every subquery, and D1 allows only 100 bound parameters a statement.
const typeList = (types: Iterable<string>) => sql.raw([...types].map((t) => `'${t}'`).join(', '))
const LEGISLATIVE = typeList(LEGISLATIVE_EVENT_TYPES)
const PASSIVE = typeList(PASSIVE_EVENT_TYPES)

/** The team engaged that day (any event the default feed counts as engagement) with a bill `sibBills` picks out of `feed_events sib`. */
const engagedOn = (sibBills: SQL, day: SQL) => sql`EXISTS (
    SELECT 1 FROM feed_events sib
     WHERE ${sibBills}
       AND sib.suppressed != 1
       AND date(sib.created_at) = ${day}
       AND sib.type NOT IN (${PASSIVE})
  )`

/**
 * An event `m` (feed_events) on bill `mb` (bills) is the row's for UTC day
 * `day` (an SQL date, YYYY-MM-DD): a legislative event that day, on an analyzed
 * bill at or above the minimum relevance for new matches, whose companion group
 * has no priority and was not engaged with that day.
 *
 * The range on m.created_at lets the created_at index find the day's events.
 * It is a day wider on each side than the day, so the two stored timestamp
 * formats both fall inside it, and date() then picks the day exactly.
 */
function standsFor(day: SQL, minRelevance: number): SQL {
  return sql`m.suppressed != 1
    AND m.type IN (${LEGISLATIVE})
    AND m.created_at >= date(${day}, '-1 day') AND m.created_at < date(${day}, '+2 days')
    AND date(m.created_at) = ${day}
    AND mb.match_type IS NOT NULL
    AND COALESCE(mb.relevance_score, 0) >= ${minRelevance}
    AND mb.priority IS NULL
    AND (mb.group_key IS NULL OR NOT EXISTS (SELECT 1 FROM bills g WHERE g.group_key = mb.group_key AND g.priority IS NOT NULL))
    AND NOT ${engagedOn(sql`sib.bill_id = mb.id`, day)}
    AND (mb.group_key IS NULL OR NOT ${engagedOn(sql`sib.bill_id IN (SELECT g.id FROM bills g WHERE g.group_key = mb.group_key)`, day)})`
}

/**
 * For GET /feed's WHERE: the row on `feed_events` stands for at least one
 * bill. A row that resolves to none is left out of the page and the total, so
 * pagination stays honest.
 */
export function rowStandsForABill(minRelevance: number): SQL {
  return sql`(${feedEvents.type} = ${NO_PRIORITY_UPDATES} AND EXISTS (
    SELECT 1 FROM feed_events m JOIN bills mb ON mb.id = m.bill_id
     WHERE ${standsFor(sql`date(${feedEvents.createdAt})`, minRelevance)}
  ))`
}

/** One entry of the row: a bill, or the members of one companion group that moved that day. */
export type RowEntryKey = { key: string; relevance: number }

/**
 * The row's entries for the day of `createdAt` (the row's own timestamp), most
 * relevant first. A companion group is one entry, ranked by its most relevant
 * member that moved. Ties go by key, so pages of the list never overlap or skip.
 */
export async function rowEntries(db: AppDb, createdAt: string, minRelevance: number): Promise<RowEntryKey[]> {
  return await db.all(sql`
    SELECT CASE WHEN mb.group_key IS NOT NULL THEN 'group:' || mb.group_key ELSE mb.id END AS key,
           MAX(COALESCE(mb.relevance_score, 0)) AS relevance
      FROM feed_events m JOIN bills mb ON mb.id = m.bill_id
     WHERE ${standsFor(sql`date(${createdAt})`, minRelevance)}
     GROUP BY key
     ORDER BY relevance DESC, key ASC
  `) as RowEntryKey[]
}

/** A bill of the row, as a chip, its hover card, and its title need it. */
export type RowBill = {
  id: string; billNumber: string; title: string; state: string | null; sessionSlug: string | null
  isDraft: boolean; groupKey: string | null; summary: string | null
}

/** A bill-less view of one of the row's events, which the web builds a card row from. */
export type RowEvent = { id: string; type: string; billId: string; metadata: unknown; createdAt: string }

export type RowEntry = { key: string; bills: RowBill[]; events: RowEvent[] }

type BillRow = {
  id: string; bill_number: string; title: string | null; abstract: string | null; state: string | null
  session: string | null; session_slug: string | null; is_draft: number | null; group_key: string | null
  tenant_summary: string | null; relevance_score: number | null
}

// D1 rejects more than 100 bound parameters a statement, and standsFor binds a few of its own.
const CHUNK = 60
const chunks = <T>(xs: readonly T[]) => Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK))
const keyOf = (b: { id: string; group_key: string | null }) => (b.group_key !== null ? `group:${b.group_key}` : b.id)

/**
 * The bills of these entries that moved that day, each entry's most relevant
 * first (ties by id). A companion group's members that didn't move are left out.
 * With `withEvents`, each entry also carries its bills' events of the day, newest first.
 */
export async function rowEntryDetails(
  db: AppDb, createdAt: string, minRelevance: number, keys: readonly string[], withEvents: boolean,
): Promise<RowEntry[]> {
  const ids = keys.filter((k) => !k.startsWith('group:'))
  const groups = keys.filter((k) => k.startsWith('group:')).map((k) => k.slice('group:'.length))
  const day = sql`date(${createdAt})`
  const found = new Map<string, BillRow>()
  const select = (pick: SQL) => db.all(sql`
    SELECT DISTINCT mb.id, mb.bill_number, mb.title, mb.abstract, mb.state, mb.session, mb.session_slug, mb.is_draft,
           mb.group_key, mb.tenant_summary, mb.relevance_score
      FROM feed_events m JOIN bills mb ON mb.id = m.bill_id
     WHERE ${standsFor(day, minRelevance)} AND ${pick}
  `) as Promise<BillRow[]>
  const list = (xs: readonly string[]) => sql.join(xs.map((x) => sql`${x}`), sql`, `)
  for (const part of chunks(ids)) for (const b of await select(sql`mb.group_key IS NULL AND mb.id IN (${list(part)})`)) found.set(b.id, b)
  for (const part of chunks(groups)) for (const b of await select(sql`mb.group_key IN (${list(part)})`)) found.set(b.id, b)

  const events = new Map<string, RowEvent[]>()
  if (withEvents) {
    for (const part of chunks([...found.keys()])) {
      const rows = await db.all(sql`
        SELECT m.id, m.type, m.bill_id, m.metadata, m.created_at
          FROM feed_events m JOIN bills mb ON mb.id = m.bill_id
         WHERE ${standsFor(day, minRelevance)} AND mb.id IN (${list(part)})
      `) as Array<{ id: string; type: string; bill_id: string; metadata: string; created_at: string }>
      for (const e of rows) {
        const key = keyOf(found.get(e.bill_id)!)
        const of = events.get(key) ?? []
        of.push({ id: e.id, type: e.type, billId: e.bill_id, metadata: JSON.parse(e.metadata) as unknown, createdAt: e.created_at })
        events.set(key, of)
      }
    }
  }

  const byKey = new Map<string, BillRow[]>()
  for (const b of found.values()) byKey.set(keyOf(b), [...(byKey.get(keyOf(b)) ?? []), b])
  const epoch = (ts: string) => Date.parse(ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`)
  return keys.flatMap((key) => {
    const members = byKey.get(key)
    if (!members) return []
    members.sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    return [{
      key,
      bills: members.map((b) => ({
        id: b.id, billNumber: b.bill_number, title: b.title || b.abstract || '', state: b.state ?? null,
        sessionSlug: filedSlug({ session: b.session, sessionSlug: b.session_slug }), isDraft: !!b.is_draft,
        groupKey: b.group_key, summary: b.tenant_summary ?? null,
      })),
      events: (events.get(key) ?? []).sort((a, b) => epoch(b.createdAt) - epoch(a.createdAt) || (a.id < b.id ? 1 : -1)),
    }]
  })
}

/**
 * Makes sure the day has its row, when a legislative event has just landed on
 * `billId`. Written for any analyzed bill, priority or not: the row is resolved
 * on every read, and one that stands for no bill never shows, so a priority
 * cleared later that day (a bulk edit leaves no event on the bill) still finds
 * the day's row. A bill with no match type is never the row's, so writes none.
 *
 * One insert that does nothing on the day's unique index (migration 0121, whose
 * WHERE the conflict target spells out as written, so SQLite matches the two), so
 * updates processed at the same moment share the row. The row keeps the time
 * of the day's first update: it never moves up past the team's own activity.
 */
export async function noteLegislativeEvent(db: AppDb, billId: string): Promise<void> {
  await db.run(sql`
    INSERT INTO feed_events (id, type, bill_id, user_id, metadata)
    SELECT ${crypto.randomUUID()}, ${NO_PRIORITY_UPDATES}, NULL, 'system', '{}'
     WHERE EXISTS (SELECT 1 FROM bills WHERE id = ${billId} AND match_type IS NOT NULL)
    ON CONFLICT (date(created_at)) WHERE type = 'no_priority_updates' DO NOTHING
  `)
}
