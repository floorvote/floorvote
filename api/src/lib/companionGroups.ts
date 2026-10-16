import { and, asc, eq, inArray, ne, or, sql, type SQL } from 'drizzle-orm'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import { billGroupOverrides, billIdenticalLinks, bills, memberVotes, notes, teamEvents } from '../db/schema'
import { rowidOf } from '../db/rowid'
import { nowDb } from './dbTime'
import { chunk } from './chunk'
import { isHandle, parseHandle, toHandle } from '../../../shared/billHandle'
import type { GroupBill, GroupingEventMetadata, GroupingEventType, GroupNote, ReplacedTeamValue } from '../../../shared/companionGroups'
import { loadFieldDefs, readTeamValueRows, replacedTeamValues, teamValuesUnchanged } from './teamFields'
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
 * The bills a member has voted on, and every bill in their groups: the bills the
 * bill list's Unvoted filter leaves out, since a member's vote on a group is on
 * all of it. Read once for the request, so the filter is one `NOT IN` over this
 * list on a bill's id, with no probe of the bill's group.
 */
export async function loadVotedInGroups(db: AppDb, userId: string): Promise<string[]> {
  const rows = await db.all(sql`SELECT bill_id AS id FROM member_votes WHERE user_id = ${userId}
    UNION SELECT g.id FROM bills g WHERE g.group_key IN
      (SELECT b.group_key FROM member_votes v JOIN bills b ON b.id = v.bill_id WHERE v.user_id = ${userId} AND b.group_key IS NOT NULL)`) as { id: string }[]
  return rows.map(r => r.id)
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
  opts: RecomputeOptions = {},
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
  // time joins companions that already name it. The bills at the far end of a
  // dropped link regroup too: a split is a cannot-link, so a link can keep
  // bills apart that are in no group with this one (settleGroups), and once it
  // goes they may group again.
  const ids: string[] = []
  for (const part of chunk([externalId, ...gone], 90)) {
    ids.push(...(await db.select({ id: bills.id }).from(bills).where(inArray(bills.externalId, part)).all()).map(r => r.id))
  }
  if (ids.length > 0) await recomputeGroups(db, ids, opts)
}

type Node = { id: string; billNumber: string; externalId: string | null; groupKey: string | null }

/** An admin's override of companion groups, one per pair of bills (see `bill_group_overrides`). */
type Override = { billId: string; otherBillId: string; kind: 'link' | 'split' }

const nodeColumns = { id: bills.id, billNumber: bills.billNumber, externalId: bills.externalId, groupKey: bills.groupKey }

// How many times a recompute that lost a race with another one re-reads and tries again.
const RECOMPUTE_ATTEMPTS = 5

/**
 * `actorUserId`: who grouped or split the bills, when an admin did. `undoneSplits`: the splits that admin's
 * grouping undid, recorded on each `grouped` event it writes.
 */
export type RecomputeOptions = { actorUserId?: string | null; undoneSplits?: ReadonlyArray<readonly [GroupBill, GroupBill]> }

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
 * guard covers the links, group overrides, and team field values it read
 * too, so a recompute that raced with a link change, an admin's grouping or
 * split, or a value being set re-reads instead.
 */
export async function recomputeGroups(
  db: AppDb,
  billIds: readonly string[],
  opts: RecomputeOptions = {},
): Promise<void> {
  for (let attempt = 1; attempt <= RECOMPUTE_ATTEMPTS; attempt++) {
    if (await tryRecomputeGroups(db, billIds, opts)) return
  }
  throw new Error(`Companion groups of ${billIds.join(', ')} kept changing under ${RECOMPUTE_ATTEMPTS} recomputes`)
}

/** What a recompute reads: every bill its walk reached, their old groups, and the links and overrides it saw. */
type Walk = {
  nodes: Map<string, Node>
  oldGroups: Map<string, Node[]>
  /** Every identical link row the walk read, by `externalId companionExternalId`. */
  linksRead: Map<string, [string, string]>
  /** Every override row the walk read, by pair. */
  overridesRead: Map<string, Override>
}

/**
 * Walk every bill connected to the seeds now, by an identical link or an
 * admin's link, and every bill grouped with any of them before, so a group
 * that loses a link is rekeyed in full. It reaches every bill a link or an
 * admin's link connects to the seeds, so settleGroups decides their groups
 * from all of it.
 */
async function walkComponent(db: AppDb, billIds: readonly string[]): Promise<Walk> {
  const nodes = new Map<string, Node>()
  const walked = new Set<string>()
  const oldGroups = new Map<string, Node[]>()
  const linksRead = new Map<string, [string, string]>()
  const overridesRead = new Map<string, Override>()

  // Whether the instance has any group overrides at all, read with the seeds.
  // Most have none, and then the walk skips reading each bill's: a delivery of
  // a bill in no group costs no more statements than before overrides. The
  // guard below still counts overrides, so one stored mid-walk makes this
  // attempt fail and the next one read them.
  let anyOverrides = false
  for (const part of chunk([...billIds], 90)) {
    for (const { anyOverrides: any, ...n } of await db.select({ ...nodeColumns, anyOverrides: sql<number>`EXISTS (SELECT 1 FROM bill_group_overrides)` })
      .from(bills).where(inArray(bills.id, part)).all()) {
      nodes.set(n.id, n)
      if (any) anyOverrides = true
    }
  }

  const queue = [...nodes.keys()]
  while (queue.length > 0) {
    const node = nodes.get(queue.shift()!)!
    if (walked.has(node.id)) continue
    walked.add(node.id)
    const { linked, links, overrides } = await identicalNeighbors(db, node, anyOverrides)
    for (const l of links) linksRead.set(l.join(' '), l)
    for (const o of overrides) overridesRead.set(`${o.billId} ${o.otherBillId}`, o)
    let before: Node[] = []
    if (node.groupKey !== null) {
      if (!oldGroups.has(node.groupKey)) {
        oldGroups.set(node.groupKey, await db.select(nodeColumns).from(bills).where(eq(bills.groupKey, node.groupKey)).all())
      }
      before = oldGroups.get(node.groupKey)!
    }
    for (const n of [...linked, ...before]) {
      if (!nodes.has(n.id)) nodes.set(n.id, n)
      if (!walked.has(n.id)) queue.push(n.id)
    }
  }

  return { nodes, oldGroups, linksRead, overridesRead }
}

/** One recompute: false when another write changed a key it read, so nothing was written. */
async function tryRecomputeGroups(
  db: AppDb,
  billIds: readonly string[],
  opts: RecomputeOptions,
): Promise<boolean> {
  const { nodes, oldGroups, linksRead, overridesRead } = await walkComponent(db, billIds)

  // The groups, from everything the walk read rather than from each bill's
  // own reads: each bill's rows were read at a different moment, and a row
  // either bill's read saw is one edge, or one split. The guard below makes
  // the batch apply only while those rows are exactly what's stored.
  const componentOf = settleGroups([...nodes.values()], [...linksRead.values()], [...overridesRead.values()])

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
    const event = (type: GroupingEventType, withIds: string[], replaced: ReplacedTeamValue[], undoneSplits: ReadonlyArray<readonly [GroupBill, GroupBill]> = []) => {
      const metadata: GroupingEventMetadata = { with: byNumber(withIds), groupBillIds, replaced, ...(undoneSplits.length > 0 ? { undoneSplits: undoneSplits.map(([a, b]) => [a, b] as [GroupBill, GroupBill]) } : {}) }
      events.push({ id: crypto.randomUUID(), billId: node.id, type, actorUserId: opts.actorUserId ?? null, metadata: JSON.stringify(metadata), createdAt: now })
    }
    if (left.length > 0) event('split', left, [])
    if (joined.length > 0) event('grouped', joined, replacedIn.get(members) ?? [], opts.undoneSplits)
  }

  const rekeyed = [...rekey].flatMap(([key, ids]) => ids.map(id => [id, key]))
  if (rekeyed.length === 0 && events.length === 0) return true

  // Everything this recompute read: each bill's key, every link and override
  // touching the bills it walked, and which of the linked handles are bills here. Each
  // statement below applies only while all of it still holds, and the batch
  // is one transaction, so the events and keys land together or not at all,
  // and a recompute that raced with a change to keys, links, overrides, or bills retries
  // instead of writing a grouping computed from a mix of before and after.
  // JSON parameters keep any group size under D1's parameter limit.
  const read = [...nodes.values()].map(n => [n.id, n.groupKey])
  const handles = [...nodes.values()].flatMap(n => (n.externalId ? [n.externalId] : []))
  const links = [...linksRead.values()]
  const linkedHandles = [...new Set(links.flat())]
  const linkedBills = [...nodes.values()].filter(n => n.externalId !== null && linkedHandles.includes(n.externalId)).length
  const ids = [...nodes.keys()]
  const overrides = [...overridesRead.values()].map(o => [o.billId, o.otherBillId, o.kind])
  const unchanged = sql`(SELECT COUNT(*) FROM bills b, json_each(${JSON.stringify(read)}) r
      WHERE b.id = json_extract(r.value, '$[0]') AND b.group_key IS json_extract(r.value, '$[1]')) = ${read.length}
    AND (SELECT COUNT(*) FROM bill_identical_links l
      WHERE l.external_id IN (SELECT value FROM json_each(${JSON.stringify(handles)}))
        OR l.companion_external_id IN (SELECT value FROM json_each(${JSON.stringify(handles)}))) = ${links.length}
    AND (SELECT COUNT(*) FROM bill_identical_links l, json_each(${JSON.stringify(links)}) r
      WHERE l.external_id = json_extract(r.value, '$[0]') AND l.companion_external_id = json_extract(r.value, '$[1]')) = ${links.length}
    AND (SELECT COUNT(*) FROM bills b WHERE b.external_id IN (SELECT value FROM json_each(${JSON.stringify(linkedHandles)}))) = ${linkedBills}
    AND (SELECT COUNT(*) FROM bill_group_overrides o
      WHERE o.bill_id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
        OR o.other_bill_id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))) = ${overrides.length}
    AND (SELECT COUNT(*) FROM bill_group_overrides o, json_each(${JSON.stringify(overrides)}) r
      WHERE o.bill_id = json_extract(r.value, '$[0]') AND o.other_bill_id = json_extract(r.value, '$[1]')
        AND o.kind = json_extract(r.value, '$[2]')) = ${overrides.length}
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
      .where(and(sql`${bills.id} IN (SELECT json_extract(k.value, '$[0]') FROM json_each(${JSON.stringify(rekeyed)}) k)`, unchanged))
      .returning({ id: bills.id }),
  ])
  // A membership change always moves at least one key, so an update that set
  // none means the guard failed. The keys are counted from the rows the update
  // returns, not from `meta.changes`, which 0103's triggers inflate with the
  // other bills whose group tags they rewrite in the same statement. Every key
  // or none: a partial write would count short and retry.
  return rekeyed.length > 0 ? updated.length === rekeyed.length : changesOf(inserted) === events.length
}

function changesOf(result: unknown): number {
  return (result as { meta?: { changes?: number } }).meta?.changes ?? 0
}

/**
 * The identical links naming `node` or named by it, the admin's overrides
 * pairing it with another bill, and the bills in this instance at the other
 * ends of the links and of the `link` overrides. A split pair's other bill is
 * no neighbor: it is only an edge to leave out.
 */
async function identicalNeighbors(db: AppDb, node: Node, readingOverrides: boolean): Promise<{ linked: Node[]; links: Array<[string, string]>; overrides: Override[] }> {
  const rows = node.externalId ? await readLinks(db, [node.externalId]) : []
  const overrides = readingOverrides ? await readOverrides(db, [node.id]) : []
  const others = [...new Set(rows.map(([a, b]) => (a === node.externalId ? b : a)))]
  const linkedIds = overrides.filter(o => o.kind === 'link').map(o => (o.billId === node.id ? o.otherBillId : o.billId))
  const linked = new Map<string, Node>()
  for (const part of chunk(others, 90)) {
    for (const n of await db.select(nodeColumns).from(bills).where(and(ne(bills.id, node.id), inArray(bills.externalId, part))).all()) linked.set(n.id, n)
  }
  for (const part of chunk(linkedIds, 90)) {
    for (const n of await db.select(nodeColumns).from(bills).where(inArray(bills.id, part)).all()) linked.set(n.id, n)
  }
  return { linked: [...linked.values()].sort((x, y) => (x.id < y.id ? -1 : 1)), links: rows, overrides }
}

/** Every identical link naming any of these handles, or named by one, as `[externalId, companionExternalId]`. */
async function readLinks(db: AppDb, handles: readonly string[]): Promise<Array<[string, string]>> {
  const out: Array<[string, string]> = []
  for (const part of chunk([...handles], 45)) {
    out.push(...(await db.select({ a: billIdenticalLinks.externalId, b: billIdenticalLinks.companionExternalId })
      .from(billIdenticalLinks)
      .where(or(inArray(billIdenticalLinks.externalId, part), inArray(billIdenticalLinks.companionExternalId, part)))
      .all()).map(r => [r.a, r.b] as [string, string]))
  }
  return out
}

/** Every override pairing any of these bills with another. */
async function readOverrides(db: AppDb, billIds: readonly string[]): Promise<Override[]> {
  const out: Override[] = []
  for (const part of chunk([...billIds], 45)) {
    out.push(...await db.select({ billId: billGroupOverrides.billId, otherBillId: billGroupOverrides.otherBillId, kind: billGroupOverrides.kind })
      .from(billGroupOverrides)
      .where(or(inArray(billGroupOverrides.billId, part), inArray(billGroupOverrides.otherBillId, part)))
      .all())
  }
  return out
}

/**
 * The companion groups of these bills, each bill's group shared by its
 * members: the bills an identical link joins, by handle in either direction,
 * and the bills an admin linked, less any pair an admin split. An override
 * takes precedence over the provider's links this way on every recompute, so
 * on every sync.
 *
 * A split pair is a cannot-link (see **Group override** in CONTEXT.md): its
 * two bills never share a group, even where other bills' links connect them.
 * While some split pair is still connected, the bills on its shortest
 * connections (other than the pair) lose their provider links, and keep only
 * an admin's: a bill identical to both of two split bills groups with
 * neither. Every split pair at the shortest distance is handled at once, and
 * the bills are walked in id order, so the result depends only on the links
 * and overrides, never on which bill was delivered first. Admin links that
 * alone still connect a split pair (only a race lets one be stored) drop
 * last, the same way.
 */
function settleGroups(nodes: readonly Node[], links: ReadonlyArray<readonly [string, string]>, overrides: readonly Override[]): Map<string, string[]> {
  const ids = nodes.map(n => n.id).sort()
  const idOf = new Map(nodes.flatMap(n => (n.externalId ? [[n.externalId, n.id] as const] : [])))
  const known = new Set(ids)
  const splits = overrides.filter(o => o.kind === 'split' && known.has(o.billId) && known.has(o.otherBillId))
    .map(o => pair(o.billId, o.otherBillId)).sort((x, y) => pairKey(...x).localeCompare(pairKey(...y)))
  const split = new Set(splits.map(([a, b]) => pairKey(a, b)))
  const provider = new Map(ids.map(id => [id, new Set<string>()]))
  const manual = new Map(ids.map(id => [id, new Set<string>()]))
  const join = (edges: Map<string, Set<string>>, a: string | undefined, b: string | undefined) => {
    if (!a || !b || a === b || !known.has(a) || !known.has(b) || split.has(pairKey(a, b))) return
    edges.get(a)!.add(b)
    edges.get(b)!.add(a)
  }
  for (const [a, b] of links) join(provider, idOf.get(a), idOf.get(b))
  for (const o of overrides) if (o.kind === 'link') join(manual, o.billId, o.otherBillId)

  // Bills that have lost their provider links, and bills that have lost every link.
  const noProvider = new Set<string>()
  const alone = new Set<string>()
  for (;;) {
    const neighbors = new Map(ids.map(id => [id, new Set<string>(alone.has(id) ? [] : [
      ...[...manual.get(id)!].filter(o => !alone.has(o)),
      ...(noProvider.has(id) ? [] : [...provider.get(id)!].filter(o => !alone.has(o) && !noProvider.has(o))),
    ])]))
    // The bills on the shortest connections of the closest split pairs.
    let shortest = Infinity
    const between = new Set<string>()
    for (const [u, v] of splits) {
      const fromU = distances(u, neighbors)
      const d = fromU.get(v)
      if (d === undefined || d > shortest) continue
      if (d < shortest) { shortest = d; between.clear() }
      const fromV = distances(v, neighbors)
      for (const id of ids) {
        if (id !== u && id !== v && (fromU.get(id) ?? Infinity) + (fromV.get(id) ?? Infinity) === d) between.add(id)
      }
    }
    // No bill between means a split pair joined directly, which the edges
    // above leave out, so it can't happen. Stop rather than loop.
    if (shortest === Infinity || between.size === 0) return connectedComponents(ids, neighbors)
    const withProvider = [...between].filter(id => !noProvider.has(id) && provider.get(id)!.size > 0)
    for (const id of withProvider.length > 0 ? withProvider : between) (withProvider.length > 0 ? noProvider : alone).add(id)
  }
}

/** Each bill's distance in links from `from`, over `neighbors`, for the bills it reaches. */
function distances(from: string, neighbors: ReadonlyMap<string, ReadonlySet<string>>): Map<string, number> {
  const out = new Map([[from, 0]])
  const queue = [from]
  while (queue.length > 0) {
    const at = queue.shift()!
    for (const next of neighbors.get(at) ?? []) {
      if (!out.has(next)) { out.set(next, out.get(at)! + 1); queue.push(next) }
    }
  }
  return out
}

/** The two bills of a pair in the order an override stores them, smaller id first. */
function pair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a]
}

function pairKey(a: string, b: string): string {
  return pair(a, b).join(' ')
}

/** Bills in the order a group lists them: by bill number, numbers compared as numbers. */
export function compareBillNumbers(a: { billNumber: string }, b: { billNumber: string }): number {
  return a.billNumber.localeCompare(b.billNumber, 'en', { numeric: true })
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ── Grouping by hand ────────────────────────────────────────────────────────

/** Two bills an admin split apart that a grouping by hand would put back in one group. */
export type SplitConflict = { split: [GroupBill, GroupBill] }

/** A split pair by bill number, the lower number first. */
export type SplitPair = [GroupBill, GroupBill]

/**
 * What grouping two bills by hand would do, read and not written: refused with
 * the split pair that stops it, or allowed with the splits it would undo.
 */
export type GroupingPlan = { conflict: SplitConflict } | { undoneSplits: SplitPair[]; stored: Array<{ billId: string; otherBillId: string }> }

/**
 * Read what `groupByHand` would do for the pair. Their groups may not hold two
 * bills an admin split apart, since a split is a cannot-link: that's a
 * conflict. Except when the two bills are such a pair: grouping a bill again
 * with one it was split from undoes the split, so the pair's split becomes the
 * link, and any other split between the two groups (left by the same split,
 * from the rest of that group) is removed. `undoneSplits` is every split pair
 * between the two groups, the pair's own included, each by bill number and in
 * bill-number order. Empty for two bills nothing was split between.
 */
export async function planGroupByHand(db: AppDb, billId: string, withBillId: string): Promise<GroupingPlan> {
  const [mine, theirs] = await Promise.all([loadGroupBills(db, billId), loadGroupBills(db, withBillId)])
  const numberOf = new Map([...mine, ...theirs].map(b => [b.billId, b.billNumber]))
  const mineIds = JSON.stringify(mine.map(b => b.billId))
  const theirIds = JSON.stringify(theirs.map(b => b.billId))
  const between = await db.select({ billId: billGroupOverrides.billId, otherBillId: billGroupOverrides.otherBillId })
    .from(billGroupOverrides)
    .where(and(eq(billGroupOverrides.kind, 'split'), sql`(
      (${billGroupOverrides.billId} IN (SELECT value FROM json_each(${mineIds})) AND ${billGroupOverrides.otherBillId} IN (SELECT value FROM json_each(${theirIds})))
      OR (${billGroupOverrides.billId} IN (SELECT value FROM json_each(${theirIds})) AND ${billGroupOverrides.otherBillId} IN (SELECT value FROM json_each(${mineIds}))))`))
    .all()
  const pairs = between
    .map(o => [o.billId, o.otherBillId].map(id => ({ billId: id, billNumber: numberOf.get(id)! })).sort(compareBillNumbers) as SplitPair)
    .sort((a, b) => compareBillNumbers(a[0], b[0]) || compareBillNumbers(a[1], b[1]))
  const undoing = between.some(o => pairKey(o.billId, o.otherBillId) === pairKey(billId, withBillId))
  if (between.length > 0 && !undoing) return { conflict: { split: [pairs[0][0], pairs[0][1]] } }
  return { undoneSplits: pairs, stored: between }
}

/**
 * An admin groups two bills by hand (see **Group override** in CONTEXT.md):
 * a `link` override joins them as an identical link would, so their groups
 * become one, and it holds on every later sync whatever the provider says.
 * The grouping events name the admin.
 *
 * The conflict, or the splits undone (see `planGroupByHand`), is returned.
 * When a split is undone, the pair's split becomes the link in the same batch
 * that removes the others, and the `grouped` events record the splits undone.
 */
export async function groupByHand(db: AppDb, billId: string, withBillId: string, actorUserId: string): Promise<{ conflict: SplitConflict } | { undoneSplits: SplitPair[] }> {
  const plan = await planGroupByHand(db, billId, withBillId)
  if ('conflict' in plan) return plan
  const others = plan.stored.filter(o => pairKey(o.billId, o.otherBillId) !== pairKey(billId, withBillId))
  await db.batch([
    upsertOverride(db, billId, withBillId, 'link', actorUserId),
    ...others.map(o => db.delete(billGroupOverrides).where(and(
      eq(billGroupOverrides.billId, o.billId), eq(billGroupOverrides.otherBillId, o.otherBillId), eq(billGroupOverrides.kind, 'split')))),
  ])
  await recomputeGroups(db, [billId, withBillId], { actorUserId, undoneSplits: plan.undoneSplits })
  return { undoneSplits: plan.undoneSplits }
}

/**
 * An admin splits a bill from its companion group: a `split` override with
 * each other bill in it removes any identical link or admin's link between
 * them, on every later sync too. The rest of the group then follows its own
 * links: bills that this one alone joined (A190 and S1714 each identical to
 * S1713, and not to each other) come apart, and an admin can group them by
 * hand. False, writing nothing, for a bill in no group.
 *
 * The pairs are written by one statement that reads the group as it writes,
 * so a bill that joins the group at the same moment is split from too, or
 * joins after the pairs are stored and is handled by its own recompute. The
 * guarded recompute then reads the overrides. A sync or another admin changing
 * the group at the same moment can't leave a key that disagrees with the
 * links: whichever recompute writes last read every link and override as they
 * stand.
 */
export async function splitFromGroup(db: AppDb, billId: string, actorUserId: string): Promise<boolean> {
  const now = nowDb()
  // The smaller id first, as the table stores a pair. `min` and `max` of two values compare as bills.id does.
  const stored = await db.insert(billGroupOverrides)
    .select(sql`SELECT min(m.id, ${billId}), max(m.id, ${billId}), 'split', ${actorUserId}, ${now}
      FROM bills m WHERE m.id IN ${groupMemberIds(billId)} AND m.id <> ${billId}`)
    .onConflictDoUpdate({ target: [billGroupOverrides.billId, billGroupOverrides.otherBillId], set: { kind: 'split', actorUserId, createdAt: now } })
    .returning({ billId: billGroupOverrides.billId, otherBillId: billGroupOverrides.otherBillId })
  if (stored.length === 0) return false
  await recomputeGroups(db, [...new Set([billId, ...stored.flatMap(p => [p.billId, p.otherBillId])])], { actorUserId })
  return true
}

/**
 * What splitting the bill from its group would leave, without writing it: the
 * groups the rest of its group would fall into, each by bill number, from
 * their own links and overrides as they stand. One part when they stay
 * together. Null for a bill in no group. The confirmation names these, so an
 * admin sees bills that would come apart before splitting.
 */
export async function previewSplit(db: AppDb, billId: string): Promise<GroupBill[][] | null> {
  const members = await db.select(nodeColumns).from(bills).where(inGroupOf(bills.id, billId)).all()
  const rest = members.filter(m => m.id !== billId)
  if (rest.length === 0) return null
  // The recompute's own walk and rule, with the split pairs the split would write.
  const { nodes, linksRead, overridesRead } = await walkComponent(db, [billId])
  for (const n of rest) {
    const [a, b] = pair(billId, n.id)
    overridesRead.set(`${a} ${b}`, { billId: a, otherBillId: b, kind: 'split' })
  }
  const componentOf = settleGroups([...nodes.values()], [...linksRead.values()], [...overridesRead.values()])
  const restIds = new Set(rest.map(n => n.id))
  return [...new Set([...restIds].map(id => componentOf.get(id)!))]
    .map(part => part.map(id => ({ billId: id, billNumber: nodes.get(id)!.billNumber })).sort(compareBillNumbers))
    .sort((a, b) => compareBillNumbers(a[0], b[0]))
}

/**
 * Store an admin's override of the pair, replacing any the pair had: the
 * statement, to await or to batch.
 */
function upsertOverride(db: AppDb, billId: string, otherBillId: string, kind: Override['kind'], actorUserId: string) {
  const [a, b] = pair(billId, otherBillId)
  const now = nowDb()
  return db.insert(billGroupOverrides).values({ billId: a, otherBillId: b, kind, actorUserId, createdAt: now })
    .onConflictDoUpdate({ target: [billGroupOverrides.billId, billGroupOverrides.otherBillId], set: { kind, actorUserId, createdAt: now } })
}

/** The connected components of these bills over `neighbors`: each bill's component, shared by its members. */
function connectedComponents(ids: Iterable<string>, neighbors: ReadonlyMap<string, ReadonlySet<string>>): Map<string, string[]> {
  const componentOf = new Map<string, string[]>()
  for (const id of ids) {
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
  return componentOf
}
