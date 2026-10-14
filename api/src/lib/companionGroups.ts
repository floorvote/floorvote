import { and, asc, eq, inArray, ne, or, sql, type SQL } from 'drizzle-orm'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import { billIdenticalLinks, bills, memberVotes, notes, teamEvents } from '../db/schema'
import { rowidOf } from '../db/rowid'
import { nowDb } from './dbTime'
import { chunk } from './chunk'
import { isHandle, parseHandle, toHandle } from '../../../shared/billHandle'
import type { GroupBill, GroupingEventMetadata, GroupingEventType, GroupNote } from '../../../shared/companionGroups'
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
 * subquery. Just `billId` for an ungrouped bill, since a NULL key matches
 * nothing. A subquery, not a list of ids, so no group size can reach D1's
 * parameter limit.
 */
export function groupMemberIds(billId: string): SQL {
  return sql`(SELECT g.id FROM bills g WHERE g.id = ${billId} OR g.group_key = (SELECT k.group_key FROM bills k WHERE k.id = ${billId}))`
}

/** `column IN (every bill in billId's group)`, for any table's bill id column. */
export function inGroupOf(column: SQLiteColumn, billId: string): SQL {
  return sql`${column} IN ${groupMemberIds(billId)}`
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

/**
 * Recompute the groups of these bills and of every bill grouped with them
 * before, write the keys that changed, and record a grouping event on each
 * bill that joined or left companions: `grouped` naming the bills it joined,
 * `split` naming the ones it left. A null actor means FloorVote did it
 * automatically, from the provider's data.
 */
export async function recomputeGroups(
  db: AppDb,
  billIds: readonly string[],
  opts: { actorUserId?: string | null } = {},
): Promise<void> {
  const nodes = new Map<string, Node>()
  const neighbors = new Map<string, Set<string>>()
  const oldGroups = new Map<string, Node[]>()

  for (const part of chunk([...billIds], 90)) {
    for (const n of await db.select(nodeColumns).from(bills).where(inArray(bills.id, part)).all()) nodes.set(n.id, n)
  }

  // Walk every bill connected to the seeds now, and every bill grouped with
  // any of them before, so a group that loses a link is rekeyed in full.
  const queue = [...nodes.keys()]
  while (queue.length > 0) {
    const node = nodes.get(queue.shift()!)!
    if (neighbors.has(node.id)) continue
    const linked = await identicalNeighbors(db, node)
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

  // Connected components. The links are read in both directions, so the
  // neighbor sets are already symmetric.
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

  for (const node of nodes.values()) {
    const members = componentOf.get(node.id)!
    const newKey = members.length > 1 ? members.reduce((min, id) => (id < min ? id : min)) : null
    const nowWith = new Set(members.filter(id => id !== node.id))
    const before = new Set(node.groupKey === null ? [] : oldGroups.get(node.groupKey)!.map(n => n.id).filter(id => id !== node.id))
    if (newKey !== node.groupKey) rekey.set(newKey, [...(rekey.get(newKey) ?? []), node.id])

    const groupBillIds = [...members].sort()
    const event = (type: GroupingEventType, withIds: string[]) => {
      const metadata: GroupingEventMetadata = { with: byNumber(withIds), groupBillIds, replaced: [] }
      events.push({ id: crypto.randomUUID(), billId: node.id, type, actorUserId: opts.actorUserId ?? null, metadata: JSON.stringify(metadata), createdAt: now })
    }
    const joined = [...nowWith].filter(id => !before.has(id))
    const left = [...before].filter(id => !nowWith.has(id))
    if (left.length > 0) event('split', left)
    if (joined.length > 0) event('grouped', joined)
  }

  for (const [key, ids] of rekey) {
    for (const part of chunk(ids, 90)) await db.update(bills).set({ groupKey: key }).where(inArray(bills.id, part))
  }
  for (const part of chunk(events, 10)) await db.insert(teamEvents).values(part)
}

/** The bills in this instance linked to `node` by an identical relationship, named by either bill. */
async function identicalNeighbors(db: AppDb, node: Node): Promise<Node[]> {
  if (!node.externalId) return []
  return db.select(nodeColumns).from(bills).where(and(
    ne(bills.id, node.id),
    or(
      inArray(bills.externalId, db.select({ h: billIdenticalLinks.companionExternalId }).from(billIdenticalLinks).where(eq(billIdenticalLinks.externalId, node.externalId))),
      inArray(bills.externalId, db.select({ h: billIdenticalLinks.externalId }).from(billIdenticalLinks).where(eq(billIdenticalLinks.companionExternalId, node.externalId))),
    ),
  )).orderBy(asc(bills.id)).all()
}

function compareBillNumbers(a: { billNumber: string }, b: { billNumber: string }): number {
  return a.billNumber.localeCompare(b.billNumber, 'en', { numeric: true })
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
