import { and, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import {
  bills, memberVotes, officialPositions, comments, commentReactions, notes, feedEvents, billTexts, calendarEventBills,
} from '../db/schema'
import { removeFilesOfDeletedComments } from './attachments'
import type { AppDb } from '../types'

/**
 * How a draft bill's deletion is decided and carried out, shared by
 * `DELETE /bills/:id` (one draft) and `POST /bills/bulk-delete` (many), so the
 * two can never remove different things or guard differently.
 *
 * A draft with engagement (votes, an official position, a live comment, or a
 * non-empty note) is kept unless the request says the admin saw what deleting it
 * takes (`includeEngaged`). With it, the draft goes with all of that: its votes,
 * position, notes, comments (with their reactions and files), and feed events,
 * and, through their foreign keys, its notifications, team events, mutes, and
 * custom field values. Linking the draft to its filed bill is how to keep them.
 */

export type DraftDeleteOptions = {
  /** The admin was warned and confirmed: delete a draft even when it has engagement. */
  includeEngaged?: boolean
}

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
  /** The draft has votes, an official position, a live comment, or a non-empty note, and the request did not
      include engaged drafts. Link it to a filed bill, or delete it with `includeEngaged`. */
  | 'engaged'

/** Whether bill `b` has engagement: a vote, an official position, a live comment, or a non-empty note. */
const ENGAGED_B = sql`(EXISTS (SELECT 1 FROM member_votes v WHERE v.bill_id = b.id)
    OR EXISTS (SELECT 1 FROM official_positions p WHERE p.bill_id = b.id)
    OR EXISTS (SELECT 1 FROM comments c WHERE c.bill_id = b.id AND c.deleted_at IS NULL)
    OR EXISTS (SELECT 1 FROM notes n WHERE n.bill_id = b.id AND n.content <> ''))`

/**
 * Decides, for each of `ids` (at most DRAFT_DELETE_CHUNK), whether it can be
 * deleted. Reads only; the caller deletes the `'delete'` ones with
 * `draftDeleteStatements`.
 */
export async function draftDeleteVerdicts(
  db: AppDb, ids: readonly string[], opts: DraftDeleteOptions = {},
): Promise<Map<string, DraftDeleteVerdict>> {
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
  if (opts.includeEngaged) {
    for (const id of drafts) verdicts.set(id, 'delete')
    return verdicts
  }

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

/** Where `draftDeleteStatements`' results list the deleted bills and the deleted comments. */
const DELETED_BILLS = 0
const DELETED_COMMENTS = 2

/**
 * The statements that remove each of `ids` (at most DRAFT_DELETE_CHUNK) and
 * everything of theirs, for one `db.batch`: either all run or none do.
 *
 * The check in `draftDeleteVerdicts` is a separate round trip, so a draft can
 * gain a vote, position, comment, or note, be filed, or be deleted before the
 * batch runs. The batch therefore decides again, once, inside itself: the first
 * statement deletes the bills that are still drafts (with no engagement, unless
 * `includeEngaged`) and returns their ids, and every other statement removes the
 * rows of an id only once that bill is gone. A draft that fails the guard keeps
 * its bill and all its rows. With `includeEngaged`, engagement that arrived after
 * the check goes with the draft: the admin confirmed deleting it whatever it
 * holds. The results at DELETED_BILLS list the bills actually deleted, and those
 * at DELETED_COMMENTS their comments, whose files `deleteCleared` then removes.
 *
 * Each statement binds the ids as one JSON parameter, so none nears D1's limit.
 */
export function draftDeleteStatements(
  db: AppDb, ids: readonly string[], opts: DraftDeleteOptions = {},
): Parameters<AppDb['batch']>[0] {
  if (ids.length > DRAFT_DELETE_CHUNK) throw new Error(`draftDeleteStatements takes at most ${DRAFT_DELETE_CHUNK} ids`)
  const named = sql`(SELECT value FROM json_each(${JSON.stringify([...ids])}))`
  const deletable = opts.includeEngaged
    ? sql`(SELECT b.id FROM bills b WHERE b.id IN ${named} AND b.is_draft = 1)`
    : sql`(SELECT b.id FROM bills b WHERE b.id IN ${named} AND b.is_draft = 1 AND NOT ${ENGAGED_B})`
  // A row of a named bill that no longer exists.
  const ofDeleted = (column: SQLiteColumn) => sql`${column} IN ${named} AND NOT EXISTS (SELECT 1 FROM bills WHERE bills.id = ${column})`
  return [
    // DELETED_BILLS
    db.delete(bills).where(sql`${bills.id} IN ${deletable}`).returning({ id: bills.id }),
    // Reactions name their comment and have no foreign key, so they go before the comments do.
    db.delete(commentReactions).where(sql`${commentReactions.commentId} IN (SELECT c.id FROM comments c
      WHERE c.bill_id IN ${named} AND NOT EXISTS (SELECT 1 FROM bills WHERE bills.id = c.bill_id))`),
    // DELETED_COMMENTS. Their files' rows stay until `deleteCleared` has removed the bytes.
    db.delete(comments).where(ofDeleted(comments.billId)).returning({ id: comments.id }),
    db.delete(feedEvents).where(ofDeleted(feedEvents.billId)),
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

export type DeleteDraftsOptions = DraftDeleteOptions & {
  /** Report a failed batch as `error` for its drafts instead of throwing. */
  reportFailure?: boolean
  /** The bucket holding comment files (ATTACHMENTS_BUCKET), so a deleted comment's files go at once. */
  attachments?: R2Bucket
}

/**
 * Deletes the drafts among `ids` (at most DRAFT_DELETE_CHUNK) and says what
 * became of every one: `deleted` are gone, and `skipped` were left whole, with
 * why. A draft that passed the check but not the batch's own guard (it gained
 * engagement, was filed, or was deleted first) is skipped under the reason a
 * fresh check gives it, `engaged` for the usual one. When that fresh check
 * itself fails, the draft is reported as `error`, with or without
 * `reportFailure`.
 *
 * With `reportFailure`, a batch that fails is reported as `error` for the
 * drafts it covered, leaving them whole. Without it, the failure is thrown.
 */
export async function deleteDrafts(
  db: AppDb, ids: readonly string[], opts: DeleteDraftsOptions = {},
): Promise<{ deleted: string[]; skipped: Array<{ id: string; reason: DraftSkipReason }> }> {
  const verdicts = await draftDeleteVerdicts(db, ids, opts)
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
 * DRAFT_DELETE_CHUNK), removes the files of the comments it deleted, and
 * reports each draft as deleted or skipped. Split from `deleteDrafts` so the
 * window between the check and the batch can be tested.
 */
export async function deleteCleared(
  db: AppDb, candidates: readonly string[], opts: DeleteDraftsOptions = {},
): Promise<{ deleted: string[]; skipped: Array<{ id: string; reason: DraftSkipReason }> }> {
  let deleted: string[]
  let deletedComments: string[]
  try {
    const results = await db.batch(draftDeleteStatements(db, candidates, opts))
    deleted = (results[DELETED_BILLS] as unknown as Array<{ id: string }>).map(r => r.id)
    deletedComments = (results[DELETED_COMMENTS] as unknown as Array<{ id: string }>).map(r => r.id)
  } catch (err) {
    if (!opts.reportFailure) throw err
    console.error('draft delete failed', err)
    return { deleted: [], skipped: candidates.map(id => ({ id, reason: 'error' as const })) }
  }

  // The drafts are gone, so a failure here must not fail the request: the hourly purge takes the files left.
  await removeFilesOfDeletedComments(opts.attachments, db, deletedComments).catch((err: unknown) => {
    console.error('draft delete: removing comment files failed', err)
  })

  const gone = new Set(deleted)
  const left = candidates.filter(id => !gone.has(id))
  const skipped: Array<{ id: string; reason: DraftSkipReason }> = []
  if (left.length > 0) {
    // The batch has run, so a failed read here must not fail the request: earlier chunks and this
    // one's deleted drafts are already gone. We then cannot say why the batch kept the rest, so they
    // are reported as `error`: kept whole, and worth retrying.
    const fresh = await draftDeleteVerdicts(db, left, opts).catch((err: unknown) => {
      console.error('draft delete re-check failed', err)
      return null
    })
    for (const id of left) {
      const verdict = fresh?.get(id)
      if (!verdict) skipped.push({ id, reason: 'error' })
      // 'delete' again means the guard and the fresh check disagree: report it as kept, not as gone. Without
      // includeEngaged that is engagement the check missed. With it nothing should keep a draft, so it is an error.
      else if (verdict === 'delete') skipped.push({ id, reason: opts.includeEngaged ? 'error' : 'engaged' })
      else skipped.push({ id, reason: verdict })
    }
  }
  return { deleted, skipped }
}

/** What deleting a selection would take, for the confirm that warns about it. */
export type DraftDeletePreview = {
  /** Drafts in the selection, which a delete would remove. */
  drafts: number
  /** Filed bills in the selection, which a delete leaves alone. */
  filed: number
  /** Drafts with engagement, which only a delete with `includeEngaged` removes. */
  engagedDrafts: number
  /** The engagement on the drafts: votes, live comments, non-empty notes, and official positions. */
  engagement: { votes: number; comments: number; notes: number; positions: number }
}

/** The most bills a preview reads: one more than the 1,000 a delete takes, so a selection past the cap shows. */
export const DRAFT_DELETE_PREVIEW_LIMIT = 1001

/**
 * Counts, in one read, what deleting the bills `m` that meet `where` would take.
 * At most DRAFT_DELETE_PREVIEW_LIMIT bills are read, so `drafts + filed` over
 * 1,000 means the selection is past the cap and its counts are partial.
 */
export async function previewDraftDelete(db: AppDb, where: SQL): Promise<DraftDeletePreview> {
  const rows = await db.all(sql`WITH sel AS (SELECT m.id, m.is_draft FROM bills m WHERE ${where} LIMIT ${DRAFT_DELETE_PREVIEW_LIMIT}),
    d AS (SELECT id FROM sel WHERE is_draft = 1)
    SELECT
      (SELECT COUNT(*) FROM d) AS drafts,
      (SELECT COUNT(*) FROM sel WHERE is_draft = 0) AS filed,
      (SELECT COUNT(*) FROM d b WHERE ${ENGAGED_B}) AS engaged,
      (SELECT COUNT(*) FROM member_votes WHERE bill_id IN d) AS votes,
      (SELECT COUNT(*) FROM comments WHERE bill_id IN d AND deleted_at IS NULL) AS comments,
      (SELECT COUNT(*) FROM notes WHERE bill_id IN d AND content <> '') AS notes,
      (SELECT COUNT(*) FROM official_positions WHERE bill_id IN d) AS positions`) as Array<Record<string, number>>
  const r = rows[0]
  return {
    drafts: Number(r.drafts),
    filed: Number(r.filed),
    engagedDrafts: Number(r.engaged),
    engagement: { votes: Number(r.votes), comments: Number(r.comments), notes: Number(r.notes), positions: Number(r.positions) },
  }
}
