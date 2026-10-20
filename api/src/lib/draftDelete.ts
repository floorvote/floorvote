import { and, inArray, isNull, ne } from 'drizzle-orm'
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
 * more than 100 bound parameters, and each statement here binds one parameter
 * per draft (the notes query binds one more).
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
 */
export function draftDeleteStatements(db: AppDb, ids: readonly string[]): Parameters<AppDb['batch']>[0] {
  if (ids.length > DRAFT_DELETE_CHUNK) throw new Error(`draftDeleteStatements takes at most ${DRAFT_DELETE_CHUNK} ids`)
  const list = [...ids]
  return [
    db.delete(feedEvents).where(inArray(feedEvents.billId, list)),
    db.delete(comments).where(inArray(comments.billId, list)),
    db.delete(officialPositions).where(inArray(officialPositions.billId, list)),
    db.delete(memberVotes).where(inArray(memberVotes.billId, list)),
    db.delete(notes).where(inArray(notes.billId, list)),
    db.delete(billTexts).where(inArray(billTexts.billId, list)),
    // calendar_event_bills has no FK, so these rows would orphan on the dead draft id.
    // The calendar events themselves stay, as does their link to any other bill.
    db.delete(calendarEventBills).where(inArray(calendarEventBills.billId, list)),
    db.delete(bills).where(inArray(bills.id, list)),
  ] as unknown as Parameters<AppDb['batch']>[0]
}
