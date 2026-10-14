import { and, asc, eq, inArray, ne, or, sql, type SQL } from 'drizzle-orm'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import { billIdenticalLinks, bills, memberVotes, notes, teamEvents } from '../db/schema'
import { rowidOf } from '../db/rowid'
import { nowDb } from './dbTime'
import { chunk } from './chunk'
import { isHandle, parseHandle, toHandle } from '../../../shared/billHandle'
import type { GroupBill, GroupingEventMetadata, GroupingEventType, GroupNote, ReplacedTeamValue } from '../../../shared/companionGroups'
import { loadFieldDefs, readTeamValueRows, replacedTeamValues, teamValuesUnchanged, type BillsTable } from './teamFields'
import type { AppDb } from '../types'

/**
 * Companion groups (see **Companion group** in CONTEXT.md). Bills linked by
 * `identical` relationships in either direction form a group, keyed by the
 * smallest member id in `bills.group_key` (null for a bill with no identical
 * companion in this instance).
 *
 * Engagement never moves between bills. Each read that a group shares
 * resolves across its members through `inGroupOf`, so splitting a group gives
 * every bill back its own comments, votes, and notes without touching them.
 *
 * Writes: `syncIdenticalCompanions` records a bill's identical companions on
 * each delivery from central and regroups, and `recomputeGroups` is the one
 * place that writes `group_key` and grouping events.
 */

// ── Reading a group ─────────────────────────────────────────────────────────

/**
 * The ids of every bill in `billId`'s group, `billId` included, as a SQL
 * subquery. `billId` is an id, or the outer query's `bills.id` column for a
 * correlated subquery, one group per row. Just `billId` for an ungrouped bill, since a NULL key matches
 * nothing. A subquery, not a list of ids, so no group size can reach D1's
 * parameter limit.
 */
export function groupMemberIds(billId: string | SQLiteColumn): SQL {
  return sql`(SELECT g.id FROM bills g WHERE g.id = ${billId} OR g.group_key = (SELECT k.group_key FROM bills k WHERE k.id = ${billId}))`
}

/** `column IN (every bill in billId's group)`, for any table's bill id column. */
export function inGroupOf(column: SQLiteColumn, billId: string): SQL {
  return sql`${column} IN ${groupMemberIds(billId)}`
}

/**
 * `column IN (every bill in the groups of any of these bills)`, for a bulk
 * edit. One JSON parameter, so any number of bills stays under D1's
 * parameter limit.
 */
export function inGroupsOf(column: SQLiteColumn, billIds: readonly string[]): SQL {
  const ids = JSON.stringify(billIds)
  return sql`${column} IN (SELECT g.id FROM bills g WHERE g.id IN (SELECT value FROM json_each(${ids}))
    OR g.group_key IN (SELECT k.group_key FROM bills k WHERE k.id IN (SELECT value FROM json_each(${ids})) AND k.group_key IS NOT NULL))`
}

/**
 * The bills in `billId`'s group, `billId` first and the rest by bill number.
 * Just `billId` for an ungrouped bill, and empty for a bill that doesn't exist.
 */
export async function loadGroupBills(db: AppDb, billId: string): Promise<GroupBill[]> {
  const rows = await db.select({ billId: bills.id, billNumber: bills.billNumber })
    .from(bills).where(inGroupOf(bills.id, billId)).all()
  return rows.sort((a, b) => (a.billId === billId ? -1 : b.billId === billId ? 1 : compareBillNumbers(a, b)))
}

/**
 * Each member's vote on `billId`'s group: their most recently updated vote on
 * any bill in it. A subquery of `{ userId, position, updatedAt }`, one row per
 * member who has voted. A vote updated in the same second as another resolves
 * to the one written last.
 */
export function groupVotes(db: AppDb, billId: string) {
  const ranked = db.select({
    userId: memberVotes.userId,
    position: memberVotes.position,
    updatedAt: memberVotes.updatedAt,
    rank: sql<number>`ROW_NUMBER() OVER (PARTITION BY ${memberVotes.userId} ORDER BY ${memberVotes.updatedAt} DESC, ${rowidOf(memberVotes)} DESC)`.as('vote_rank'),
  }).from(memberVotes).where(inGroupOf(memberVotes.billId, billId)).as('ranked_votes')
  return db.select({ userId: ranked.userId, position: ranked.position, updatedAt: ranked.updatedAt })
    .from(ranked).where(eq(ranked.rank, 1)).as('group_votes')
}

/**
 * A member's vote on the group of the bill in `billId` (the outer query's
 * `bills.id`), as a correlated scalar: their most recent vote on any bill in
 * it, or null. For lists of bills. One bill's page uses `groupVotes`.
 */
export function myGroupVote(billId: SQLiteColumn, userId: string) {
  return sql<'support' | 'oppose' | 'neutral' | null>`(SELECT mv.position FROM member_votes mv
    WHERE mv.user_id = ${userId} AND mv.bill_id IN ${groupMemberIds(billId)}
    ORDER BY mv.updated_at DESC, mv.rowid DESC LIMIT 1)`
}

/**
 * The member has voted on no bill in the group of `of` (the bills table or an
 * alias of it): the bill list's Unvoted filter, as a condition on one bill.
 * Reads the member's own votes as two sets (the bills they voted on, and every
 * bill in those bills' groups), so a bill costs no probe of its group and the
 * condition reads only the bill's id.
 */
export function unvotedInGroup(of: BillsTable, userId: string): SQL {
  return sql`(${of.id} NOT IN (SELECT bill_id FROM member_votes WHERE user_id = ${userId})
    AND ${of.id} NOT IN (SELECT g.id FROM bills g WHERE g.group_key IN
      (SELECT b.group_key FROM member_votes v JOIN bills b ON b.id = v.bill_id WHERE v.user_id = ${userId} AND b.group_key IS NOT NULL)))`
}

/**
 * A member's private notes across `billId`'s group, `billId`'s first and the
 * rest by bill number. Notes with no text are left out. Only ever the one
 * member's: notes are private.
 */
export async function loadGroupNotes(db: AppDb, billId: string, userId: string): Promise<GroupNote[]> {
  const rows = await db.select({ billId: notes.billId, billNumber: bills.billNumber, content: notes.content, updatedAt: notes.updatedAt })
    .from(notes)
    .innerJoin(bills, eq(notes.billId, bills.id))
    .where(and(eq(notes.userId, userId), inGroupOf(notes.billId, billId)))
    .all()
  return rows
    .filter(n => n.content.replace(/<[^>]*>/g, '').trim() !== '')
    .sort((a, b) => (a.billId === billId ? -1 : b.billId === billId ? 1 : compareBillNumbers(a, b)))
}

/**
 * The one note a member edits for a group. Notes from several bills become
 * one, each under its bill number in bold, in the order given. A single note
 * is its own text, and no notes is null.
 */
export function mergeGroupNotes(groupNotes: readonly GroupNote[]): string | null {
  if (groupNotes.length === 0) return null
  if (groupNotes.length === 1) return groupNotes[0].content
  return groupNotes.map(n => `<p><strong>${escapeHtml(n.billNumber)}</strong></p>${n.content}`).join('')
}

// ── Forming groups ──────────────────────────────────────────────────────────

/** A related bill as central serves it, with the kind its provider's vocabulary gives the relationship. */
export type CentralRelatedBill = { sastBillId?: number | null; kind?: string }

/**
 * Record the bill's identical companions from central's related bills and
 * regroup. Runs on every delivery of the bill, so a change to a provider's
 * relationship vocabulary takes effect on the bill's next delivery, and a
 * metadata refresh applies it to every bill.
 *
 * A companion the instance doesn't hold yet is kept by handle, and groups with
 * the bill when it arrives. A bill whose handle isn't a central bill's (a
 * draft) has no companions.
 */
export async function syncIdenticalCompanions(
  db: AppDb,
  externalId: string,
  relatedBills: readonly CentralRelatedBill[],
  opts: { actorUserId?: string | null } = {},
): Promise<void> {
  if (!isHandle(externalId)) return
  const next = new Set(relatedBills.flatMap(r =>
    r.kind === 'identical' && r.sastBillId != null && parseHandle(toHandle(r.sastBillId)) !== null ? [toHandle(r.sastBillId)] : [],
  ))
  next.delete(externalId)
  const current = new Set((await db.select({ companion: billIdenticalLinks.companionExternalId })
    .from(billIdenticalLinks).where(eq(billIdenticalLinks.externalId, externalId)).all()).map(r => r.companion))

  const gone = [...current].filter(h => !next.has(h))
  const added = [...next].filter(h => !current.has(h))
  for (const part of chunk(gone, 90)) {
    await db.delete(billIdenticalLinks).where(and(eq(billIdenticalLinks.externalId, externalId), inArray(billIdenticalLinks.companionExternalId, part)))
  }
  for (const part of chunk(added, 40)) {
    await db.insert(billIdenticalLinks).values(part.map(companionExternalId => ({ externalId, companionExternalId }))).onConflictDoNothing()
  }

  // Regroup even when the links are unchanged: a bill delivered for the first
  // time joins companions that already name it.
  const bill = await db.select({ id: bills.id }).from(bills).where(eq(bills.externalId, externalId)).get()
  if (bill) await recomputeGroups(db, [bill.id], opts)
}

type Node = { id: string; billNumber: string; externalId: string | null; groupKey: string | null }

const nodeColumns = { id: bills.id, billNumber: bills.billNumber, externalId: bills.externalId, groupKey: bills.groupKey }

// How many times a recompute that lost a race with another one re-reads and tries again.
const RECOMPUTE_ATTEMPTS = 5

/**
 * Recompute the groups of these bills and of every bill grouped with them
 * before, write the keys that changed, and record a grouping event on each
 * bill that joined or left companions: `grouped` naming the bills it joined,
 * `split` naming the ones it left. A null actor means FloorVote did it
 * automatically, from the provider's data. A `grouped` event also lists the
 * team field values the grouping replaced (lib/teamFields.ts).
 *
 * Safe to run concurrently, as the tenant queue does: the writes are one
 * transaction that applies only if every key it read is unchanged, so of two
 * recomputes racing over one group, one writes and the other re-reads and
 * finds nothing left to do. That keeps grouping events from doubling. The
 * guard covers the links and team field values it read too, so a recompute
 * that raced with a link change or a value being set re-reads instead.
 */
export async function recomputeGroups(
  db: AppDb,
  billIds: readonly string[],
  opts: { actorUserId?: string | null } = {},
): Promise<void> {
  for (let attempt = 1; attempt <= RECOMPUTE_ATTEMPTS; attempt++) {
    if (await tryRecomputeGroups(db, billIds, opts)) return
  }
  throw new Error(`Companion groups of ${billIds.join(', ')} kept changing under ${RECOMPUTE_ATTEMPTS} recomputes`)
}

/** One recompute: false when another write changed a key it read, so nothing was written. */
async function tryRecomputeGroups(
  db: AppDb,
  billIds: readonly string[],
  opts: { actorUserId?: string | null },
): Promise<boolean> {
  const nodes = new Map<string, Node>()
  const neighbors = new Map<string, Set<string>>()
  const oldGroups = new Map<string, Node[]>()
  // Every link row the walk read, by `externalId companionExternalId`.
  const linksRead = new Map<string, [string, string]>()

  for (const part of chunk([...billIds], 90)) {
    for (const n of await db.select(nodeColumns).from(bills).where(inArray(bills.id, part)).all()) nodes.set(n.id, n)
  }

  // Walk every bill connected to the seeds now, and every bill grouped with
  // any of them before, so a group that loses a link is rekeyed in full.
  const queue = [...nodes.keys()]
  while (queue.length > 0) {
    const node = nodes.get(queue.shift()!)!
    if (neighbors.has(node.id)) continue
    const { linked, links } = await identicalNeighbors(db, node)
    for (const l of links) linksRead.set(l.join(' '), l)
    neighbors.set(node.id, new Set(linked.map(n => n.id)))
    let before: Node[] = []
    if (node.groupKey !== null) {
      if (!oldGroups.has(node.groupKey)) {
        oldGroups.set(node.groupKey, await db.select(nodeColumns).from(bills).where(eq(bills.groupKey, node.groupKey)).all())
      }
      before = oldGroups.get(node.groupKey)!
    }
    for (const n of [...linked, ...before]) {
      if (!nodes.has(n.id)) nodes.set(n.id, n)
      if (!neighbors.has(n.id)) queue.push(n.id)
    }
  }

  // A link named by either bill is one edge. Each bill's links were read at a
  // different moment, so make the neighbor sets symmetric before walking them.
  for (const [id, set] of neighbors) for (const other of set) neighbors.get(other)?.add(id)

  // Connected components.
  const componentOf = new Map<string, string[]>()
  for (const id of nodes.keys()) {
    if (componentOf.has(id)) continue
    const members: string[] = []
    const stack = [id]
    componentOf.set(id, members)
    while (stack.length > 0) {
      const at = stack.pop()!
      members.push(at)
      for (const next of neighbors.get(at) ?? []) {
        if (!componentOf.has(next)) { componentOf.set(next, members); stack.push(next) }
      }
    }
  }

  const now = nowDb()
  const byNumber = (ids: Iterable<string>): GroupBill[] =>
    [...ids].map(id => ({ billId: id, billNumber: nodes.get(id)!.billNumber })).sort(compareBillNumbers)
  const events: Array<typeof teamEvents.$inferInsert> = []
  const rekey = new Map<string | null, string[]>()

  // What each bill joined and left.
  const moves = [...nodes.values()].map(node => {
    const members = componentOf.get(node.id)!
    const nowWith = new Set(members.filter(id => id !== node.id))
    const before = new Set(node.groupKey === null ? [] : oldGroups.get(node.groupKey)!.map(n => n.id).filter(id => id !== node.id))
    return { node, members, joined: [...nowWith].filter(id => !before.has(id)), left: [...before].filter(id => !nowWith.has(id)) }
  })

  // The team field values each group that gained bills replaced (see
  // lib/teamFields.ts). Read here, inside the attempt, so the guard below
  // also covers them: a value set while this runs makes it read again rather
  // than record a replacement that no longer holds.
  const growing = [...new Set(moves.filter(m => m.joined.length > 0).map(m => m.members))]
  const valueBillIds = growing.flat()
  const valueRows = valueBillIds.length > 0 ? await readTeamValueRows(db, valueBillIds) : null
  const replacedIn = new Map<string[], ReplacedTeamValue[]>()
  if (valueRows) {
    const defs = await loadFieldDefs(db)
    for (const members of growing) {
      // The old groups, and the bills that were in none, the new group formed from.
      const parts = new Map<string, string[]>()
      for (const id of members) {
        const key = nodes.get(id)!.groupKey
        const part = key === null ? `bill ${id}` : `group ${key}`
        parts.set(part, [...(parts.get(part) ?? []), id])
      }
      replacedIn.set(members, replacedTeamValues(valueRows, [...parts.values()], defs, id => nodes.get(id)!.billNumber))
    }
  }

  for (const { node, members, joined, left } of moves) {
    const newKey = members.length > 1 ? members.reduce((min, id) => (id < min ? id : min)) : null
    if (newKey !== node.groupKey) rekey.set(newKey, [...(rekey.get(newKey) ?? []), node.id])

    const groupBillIds = [...members].sort()
    const event = (type: GroupingEventType, withIds: string[], replaced: ReplacedTeamValue[]) => {
      const metadata: GroupingEventMetadata = { with: byNumber(withIds), groupBillIds, replaced }
      events.push({ id: crypto.randomUUID(), billId: node.id, type, actorUserId: opts.actorUserId ?? null, metadata: JSON.stringify(metadata), createdAt: now })
    }
    if (left.length > 0) event('split', left, [])
    if (joined.length > 0) event('grouped', joined, replacedIn.get(members) ?? [])
  }

  const rekeyed = [...rekey].flatMap(([key, ids]) => ids.map(id => [id, key]))
  if (rekeyed.length === 0 && events.length === 0) return true

  // Everything this recompute read: each bill's key, every link touching the
  // bills it walked, and which of the linked handles are bills here. Each
  // statement below applies only while all of it still holds, and the batch
  // is one transaction, so the events and keys land together or not at all,
  // and a recompute that raced with a change to keys, links, or bills retries
  // instead of writing a grouping computed from a mix of before and after.
  // JSON parameters keep any group size under D1's parameter limit.
  const read = [...nodes.values()].map(n => [n.id, n.groupKey])
  const handles = [...nodes.values()].flatMap(n => (n.externalId ? [n.externalId] : []))
  const links = [...linksRead.values()]
  const linkedHandles = [...new Set(links.flat())]
  const linkedBills = [...nodes.values()].filter(n => n.externalId !== null && linkedHandles.includes(n.externalId)).length
  const unchanged = sql`(SELECT COUNT(*) FROM bills b, json_each(${JSON.stringify(read)}) r
      WHERE b.id = json_extract(r.value, '$[0]') AND b.group_key IS json_extract(r.value, '$[1]')) = ${read.length}
    AND (SELECT COUNT(*) FROM bill_identical_links l
      WHERE l.external_id IN (SELECT value FROM json_each(${JSON.stringify(handles)}))
        OR l.companion_external_id IN (SELECT value FROM json_each(${JSON.stringify(handles)}))) = ${links.length}
    AND (SELECT COUNT(*) FROM bill_identical_links l, json_each(${JSON.stringify(links)}) r
      WHERE l.external_id = json_extract(r.value, '$[0]') AND l.companion_external_id = json_extract(r.value, '$[1]')) = ${links.length}
    AND (SELECT COUNT(*) FROM bills b WHERE b.external_id IN (SELECT value FROM json_each(${JSON.stringify(linkedHandles)}))) = ${linkedBills}
    AND ${valueRows ? teamValuesUnchanged(valueBillIds, valueRows) : sql`1`}`
  const [inserted, updated] = await db.batch([
    // Events first: the key update below changes what the guard reads.
    // Columns in team_events' order: id, bill_id, type, actor_user_id, metadata, created_at.
    db.insert(teamEvents).select(sql`SELECT json_extract(e.value, '$.id'), json_extract(e.value, '$.billId'), json_extract(e.value, '$.type'),
        json_extract(e.value, '$.actorUserId'), json_extract(e.value, '$.metadata'), json_extract(e.value, '$.createdAt')
      FROM json_each(${JSON.stringify(events)}) e WHERE ${unchanged}`),
    // bills.id spelled out: json_each has an id column of its own, which an
    // unqualified id inside the subquery would name.
    db.update(bills)
      .set({ groupKey: sql`(SELECT json_extract(k.value, '$[1]') FROM json_each(${JSON.stringify(rekeyed)}) k WHERE json_extract(k.value, '$[0]') = bills.id)` })
      .where(and(sql`${bills.id} IN (SELECT json_extract(k.value, '$[0]') FROM json_each(${JSON.stringify(rekeyed)}) k)`, unchanged)),
  ])
  // A membership change always moves at least one key, so an update that
  // changed nothing means the guard failed.
  return rekeyed.length > 0 ? changesOf(updated) === rekeyed.length : changesOf(inserted) === events.length
}

function changesOf(result: unknown): number {
  return (result as { meta?: { changes?: number } }).meta?.changes ?? 0
}

/**
 * The identical links naming `node` or named by it, and the bills in this
 * instance at their other ends.
 */
async function identicalNeighbors(db: AppDb, node: Node): Promise<{ linked: Node[]; links: Array<[string, string]> }> {
  if (!node.externalId) return { linked: [], links: [] }
  const rows = await db.select({ a: billIdenticalLinks.externalId, b: billIdenticalLinks.companionExternalId })
    .from(billIdenticalLinks)
    .where(or(eq(billIdenticalLinks.externalId, node.externalId), eq(billIdenticalLinks.companionExternalId, node.externalId)))
    .all()
  const others = [...new Set(rows.map(r => (r.a === node.externalId ? r.b : r.a)))]
  const linked: Node[] = []
  for (const part of chunk(others, 90)) {
    linked.push(...await db.select(nodeColumns).from(bills).where(and(ne(bills.id, node.id), inArray(bills.externalId, part))).all())
  }
  return { linked: linked.sort((x, y) => (x.id < y.id ? -1 : 1)), links: rows.map(r => [r.a, r.b]) }
}

function compareBillNumbers(a: { billNumber: string }, b: { billNumber: string }): number {
  return a.billNumber.localeCompare(b.billNumber, 'en', { numeric: true })
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
