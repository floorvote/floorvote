import { and, inArray, isNull, ne, sql } from 'drizzle-orm'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import {
  bills, memberVotes, officialPositions, comments, notes, feedEvents, billTexts, calendarEventBills,
} from '../db/schema'
import type { AppDb } from '../types'

/**
 * How a draft bill's deletion is decided and carried out, shared by
 * `DELETE /bills/:id` (one draft) and `POST /bills/bulk-delete` (many), so the
 * two can never remove different things or guard differently.
 */

/**
 * Most drafts one decision or one D1 batch takes. D1 rejects a statement with
 * more than 100 bound parameters, and the reads in `draftDeleteVerdicts` bind
 * one parameter per draft (the notes read binds one more). The batch itself binds
 * its ids as one JSON parameter, so it is bounded by this only for symmetry.
 */
export const DRAFT_DELETE_CHUNK = 90

export type DraftDeleteVerdict =
  /** Nothing in the way: the draft can be deleted. */
  | 'delete'
  /** No such bill, for example one an admin deleted a moment ago. */
  | 'not_found'
  /** A filed bill: only drafts are ever deleted. */
  | 'not_draft'
  /** The draft has votes, an official position, a live comment, or a non-empty note. Link it to a filed bill instead. */
  | 'engaged'

/**
 * Decides, for each of `ids` (at most DRAFT_DELETE_CHUNK), whether it can be
 * deleted. Reads only; the caller deletes the `'delete'` ones with
 * `draftDeleteStatements`.
 */
export async function draftDeleteVerdicts(db: AppDb, ids: readonly string[]): Promise<Map<string, DraftDeleteVerdict>> {
  const verdicts = new Map<string, DraftDeleteVerdict>()
  if (ids.length === 0) return verdicts
  if (ids.length > DRAFT_DELETE_CHUNK) throw new Error(`draftDeleteVerdicts takes at most ${DRAFT_DELETE_CHUNK} ids`)
  const list = [...ids]

  const found = await db.select({ id: bills.id, isDraft: bills.isDraft }).from(bills).where(inArray(bills.id, list)).all()
  const drafts: string[] = []
  const present = new Map(found.map(b => [b.id, b.isDraft]))
  for (const id of list) {
    if (!present.has(id)) verdicts.set(id, 'not_found')
    else if (!present.get(id)) verdicts.set(id, 'not_draft')
    else drafts.push(id)
  }
  if (drafts.length === 0) return verdicts

  const [votes, positions, liveComments, liveNotes] = await Promise.all([
    db.select({ id: memberVotes.billId }).from(memberVotes).where(inArray(memberVotes.billId, drafts)).all(),
    db.select({ id: officialPositions.billId }).from(officialPositions).where(inArray(officialPositions.billId, drafts)).all(),
    db.select({ id: comments.billId }).from(comments).where(and(inArray(comments.billId, drafts), isNull(comments.deletedAt))).all(),
    db.select({ id: notes.billId }).from(notes).where(and(inArray(notes.billId, drafts), ne(notes.content, ''))).all(),
  ])
  const engaged = new Set([...votes, ...positions, ...liveComments, ...liveNotes].map(r => r.id))
  for (const id of drafts) verdicts.set(id, engaged.has(id) ? 'engaged' : 'delete')
  return verdicts
}

/**
 * The statements that remove each of `ids` (at most DRAFT_DELETE_CHUNK) and
 * everything of theirs, for one `db.batch`: either all run or none do.
 *
 * The check in `draftDeleteVerdicts` is a separate round trip, so a draft can
 * gain a vote, position, comment, or note, be filed, or be deleted before the
 * batch runs. The batch therefore decides again, once, inside itself: the first
 * statement deletes the bills that are still drafts with no engagement and
 * returns their ids, and every other statement removes the rows of an id only
 * once that bill is gone. A draft that fails the guard keeps its bill and all
 * its rows. The batch's first result lists the bills actually deleted, which
 * `deleteDrafts` reads.
 *
 * Each statement binds the ids as one JSON parameter, so none nears D1's limit.
 */
export function draftDeleteStatements(db: AppDb, ids: readonly string[]): Parameters<AppDb['batch']>[0] {
  if (ids.length > DRAFT_DELETE_CHUNK) throw new Error(`draftDeleteStatements takes at most ${DRAFT_DELETE_CHUNK} ids`)
  const named = sql`(SELECT value FROM json_each(${JSON.stringify([...ids])}))`
  const deletable = sql`(SELECT b.id FROM bills b WHERE b.id IN ${named} AND b.is_draft = 1
    AND NOT EXISTS (SELECT 1 FROM member_votes v WHERE v.bill_id = b.id)
    AND NOT EXISTS (SELECT 1 FROM official_positions p WHERE p.bill_id = b.id)
    AND NOT EXISTS (SELECT 1 FROM comments c WHERE c.bill_id = b.id AND c.deleted_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.bill_id = b.id AND n.content <> ''))`
  // A row of a named bill that no longer exists.
  const ofDeleted = (column: SQLiteColumn) => sql`${column} IN ${named} AND ${column} NOT IN (SELECT id FROM bills)`
  return [
    db.delete(bills).where(sql`${bills.id} IN ${deletable}`).returning({ id: bills.id }),
    db.delete(feedEvents).where(ofDeleted(feedEvents.billId)),
    db.delete(comments).where(ofDeleted(comments.billId)),
    db.delete(officialPositions).where(ofDeleted(officialPositions.billId)),
    db.delete(memberVotes).where(ofDeleted(memberVotes.billId)),
    db.delete(notes).where(ofDeleted(notes.billId)),
    db.delete(billTexts).where(ofDeleted(billTexts.billId)),
    // calendar_event_bills has no FK, so these rows would orphan on the dead draft id.
    // The calendar events themselves stay, as does their link to any other bill.
    db.delete(calendarEventBills).where(ofDeleted(calendarEventBills.billId)),
  ] as unknown as Parameters<AppDb['batch']>[0]
}

export type DraftSkipReason = Exclude<DraftDeleteVerdict, 'delete'> | 'error'

/**
 * Deletes the drafts among `ids` (at most DRAFT_DELETE_CHUNK) and says what
 * became of every one: `deleted` are gone, and `skipped` were left whole, with
 * why. A draft that passed the check but not the batch's own guard (it gained
 * engagement, was filed, or was deleted first) is skipped under the reason a
 * fresh check gives it, `engaged` for the usual one.
 *
 * With `reportFailure`, a batch that fails is reported as `error` for the
 * drafts it covered, leaving them whole. Without it, the failure is thrown.
 */
export async function deleteDrafts(
  db: AppDb, ids: readonly string[], opts: { reportFailure?: boolean } = {},
): Promise<{ deleted: string[]; skipped: Array<{ id: string; reason: DraftSkipReason }> }> {
  const verdicts = await draftDeleteVerdicts(db, ids)
  const skipped: Array<{ id: string; reason: DraftSkipReason }> = []
  const candidates: string[] = []
  for (const id of ids) {
    const verdict = verdicts.get(id)!
    if (verdict === 'delete') candidates.push(id)
    else skipped.push({ id, reason: verdict })
  }
  if (candidates.length === 0) return { deleted: [], skipped }
  const result = await deleteCleared(db, candidates, opts)
  return { deleted: result.deleted, skipped: [...skipped, ...result.skipped] }
}

/**
 * Runs the guarded batch for drafts `draftDeleteVerdicts` cleared (at most
 * DRAFT_DELETE_CHUNK), and reports each as deleted or skipped. Split from
 * `deleteDrafts` so the window between the check and the batch can be tested.
 */
export async function deleteCleared(
  db: AppDb, candidates: readonly string[], opts: { reportFailure?: boolean } = {},
): Promise<{ deleted: string[]; skipped: Array<{ id: string; reason: DraftSkipReason }> }> {
  let deleted: string[]
  try {
    const results = await db.batch(draftDeleteStatements(db, candidates))
    deleted = (results[0] as unknown as Array<{ id: string }>).map(r => r.id)
  } catch (err) {
    if (!opts.reportFailure) throw err
    console.error('draft delete failed', err)
    return { deleted: [], skipped: candidates.map(id => ({ id, reason: 'error' as const })) }
  }

  const gone = new Set(deleted)
  const left = candidates.filter(id => !gone.has(id))
  const skipped: Array<{ id: string; reason: DraftSkipReason }> = []
  if (left.length > 0) {
    const fresh = await draftDeleteVerdicts(db, left)
    for (const id of left) {
      const verdict = fresh.get(id)!
      // 'delete' again means the guard and the fresh check disagree: report it as kept, not as gone.
      skipped.push({ id, reason: verdict === 'delete' ? 'engaged' : verdict })
    }
  }
  return { deleted, skipped }
}
