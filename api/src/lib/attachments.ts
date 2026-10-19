// Files attached to comments (#465): storage, limits, and lifecycle.
//
// The bytes live in a private R2 bucket (ATTACHMENTS_BUCKET) under
// `<TENANT_ID>/<random UUID>`, so instances can share one bucket, and each file
// has a row in comment_attachments (migration 0115). The flow:
//
//   1. uploadAttachment: the browser sends the file as the body of one request
//      to the API, which streams it into the bucket through the binding. Before
//      a byte is read, the server checks the name, the declared length (the
//      Content-Length, at most 25 MB), and, in one conditional insert, the
//      member's hourly limit and the instance quota. It then reads the first
//      4 KB and checks them against the name's type, refusing before anything
//      is stored. The rest streams through a FixedLengthStream, so a body that
//      runs longer or shorter than declared fails the write, and whatever
//      landed is deleted at once. The file is never held whole in memory.
//   2. Posting the comment attaches the uploaded files (attachToComment).
//   3. Downloads go through GET /api/attachments/:id (routes/attachmentsApi.ts),
//      only for a file on a comment that still shows.
//
// Deleting the comment marks its files deleted, and purgeAttachments, hourly,
// removes them 30 days later, along with uploads that never finished (after an
// hour, and they stop counting toward the quota then too), uploads never
// posted (after a day), and files whose comment row is gone (at once).
//
// The feature is off until an operator binds the bucket, and always off on a
// demo.

import { and, eq, inArray, isNull, isNotNull, lt, sql, or } from 'drizzle-orm'
import { commentAttachments } from '../db/schema'
import { checkAttachmentBytes, checkAttachmentName, SNIFF_BYTES } from './attachmentType'
import { nowDb, toDbTs } from './dbTime'
import type { AppDb, Env } from '../types'

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
export const MAX_ATTACHMENTS_PER_COMMENT = 10
/** Bytes one instance may hold in live and in-progress uploads. */
export const ATTACHMENT_QUOTA_BYTES = 5 * 1024 ** 3
/** Uploads one member may make in an hour, refused or not. */
export const UPLOADS_PER_HOUR = 30
const UNATTACHED_TTL_MS = 24 * 60 * 60 * 1000
const DELETED_TTL_MS = 30 * 24 * 60 * 60 * 1000

export type AttachmentSummary = { id: string; name: string; contentType: string; size: number }

type Fail = { ok: false; status: 400 | 403 | 404 | 411 | 429 | 503; error: string }

export const NOT_SET_UP = 'File attachments are not set up on this instance.'

/** Whether uploads can work here: the bucket is bound, and it isn't a demo. */
export function attachmentsEnabled(env: Env): boolean {
  return env.DEMO_MODE !== 'true' && !!env.ATTACHMENTS_BUCKET
}

function keyPrefix(env: Env): string {
  return `${env.TENANT_ID}/`
}

/** Whether a stored key is this instance's, in case the bucket is shared. */
export function isOwnKey(env: Env, key: string): boolean {
  return key.startsWith(keyPrefix(env))
}

// How long an upload that never finished counts toward the quota, and is kept.
// An upload is one request, so a row still unconfirmed after this is dead: its
// client disconnected or stalled.
const UNFINISHED_TTL_MS = 60 * 60 * 1000

// A row whose bytes count toward the quota: not deleted, finished or still
// recent (see UNFINISHED_TTL_MS), and either not yet posted or on a comment
// that still exists. A hard-deleted comment (account deletion,
// clear-interactions) leaves its rows behind, and the purge takes those.
function live(now: Date) {
  const recent = toDbTs(new Date(now.getTime() - UNFINISHED_TTL_MS))
  return sql`${commentAttachments.deletedAt} IS NULL
    AND (${commentAttachments.confirmedAt} IS NOT NULL OR ${commentAttachments.createdAt} > ${recent})
    AND (${commentAttachments.commentId} IS NULL OR EXISTS (SELECT 1 FROM comments WHERE comments.id = ${commentAttachments.commentId}))`
}
const ORPHANED = sql`${commentAttachments.commentId} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM comments WHERE comments.id = ${commentAttachments.commentId})`

export async function usedBytes(db: AppDb, now = new Date()): Promise<number> {
  const row = await db.select({ n: sql<number>`coalesce(sum(${commentAttachments.size}), 0)` })
    .from(commentAttachments).where(live(now)).get()
  return row?.n ?? 0
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Read from the body until `want` bytes have arrived or it ends. Returns what
 * was read, unjoined, so it can be written on as it came.
 */
async function readHead(reader: ReadableStreamDefaultReader<Uint8Array>, want: number) {
  const chunks: Uint8Array[] = []
  let total = 0
  let done = false
  while (total < want) {
    const next = await reader.read()
    if (next.done) { done = true; break }
    chunks.push(next.value)
    total += next.value.length
  }
  const joined = new Uint8Array(Math.min(total, want))
  let at = 0
  for (const c of chunks) {
    if (at >= joined.length) break
    const part = c.subarray(0, joined.length - at)
    joined.set(part, at)
    at += part.length
  }
  return { chunks, total, done, head: joined }
}

export async function uploadAttachment(
  env: Env, db: AppDb, uploaderId: string,
  input: { name: string | undefined; contentLength: string | undefined; body: ReadableStream<Uint8Array> | null },
  now = new Date(),
): Promise<{ ok: true; attachment: AttachmentSummary } | Fail> {
  if (env.DEMO_MODE === 'true') return { ok: false, status: 403, error: 'File attachments are off on the demo.' }
  if (!attachmentsEnabled(env)) return { ok: false, status: 503, error: NOT_SET_UP }

  // Everything that can be decided from the request line and headers is,
  // before a byte of the body is read.
  const checked = checkAttachmentName(input.name ?? '')
  if (!checked.ok) return { ok: false, status: 400, error: checked.error }
  const { name } = checked
  if (!input.contentLength || !/^\d+$/.test(input.contentLength)) {
    return { ok: false, status: 411, error: 'The upload needs a Content-Length.' }
  }
  const size = Number(input.contentLength)
  if (size === 0 || !input.body) return { ok: false, status: 400, error: `"${name}" is empty.` }
  if (size > MAX_ATTACHMENT_BYTES) return { ok: false, status: 400, error: `"${name}" is larger than 25 MB.` }

  // The hourly limit and the quota, checked and claimed in one statement so
  // uploads arriving at once can't all pass on the same count.
  const id = crypto.randomUUID()
  const r2Key = `${keyPrefix(env)}${crypto.randomUUID()}`
  const since = toDbTs(new Date(now.getTime() - 60 * 60 * 1000))
  const claimed = await db.run(sql`
    INSERT INTO comment_attachments (id, uploader_id, r2_key, name, content_type, size, created_at)
    SELECT ${id}, ${uploaderId}, ${r2Key}, ${name}, ${checked.contentType}, ${size}, ${toDbTs(now)}
    WHERE (SELECT count(*) FROM comment_attachments WHERE uploader_id = ${uploaderId} AND created_at > ${since}) < ${UPLOADS_PER_HOUR}
      AND (SELECT coalesce(sum(size), 0) FROM comment_attachments WHERE ${live(now)}) + ${size} <= ${ATTACHMENT_QUOTA_BYTES}`)
  if (claimed.meta.changes !== 1) {
    await input.body.cancel().catch(() => {})
    const recent = await db.select({ n: sql<number>`count(*)` }).from(commentAttachments)
      .where(and(eq(commentAttachments.uploaderId, uploaderId), sql`${commentAttachments.createdAt} > ${since}`)).get()
    if ((recent?.n ?? 0) >= UPLOADS_PER_HOUR) {
      return { ok: false, status: 429, error: 'Too many uploads in the last hour. Try again later.' }
    }
    return { ok: false, status: 400, error: "This instance's file storage is full. An admin can free space by deleting comments with files." }
  }

  // From here a refusal marks the row deleted: it keeps counting toward the
  // hourly limit until the purge, and stops counting toward the quota.
  const bucket = env.ATTACHMENTS_BUCKET!
  const refuse = async (error: string, stored: boolean): Promise<Fail> => {
    if (stored) await bucket.delete(r2Key)
    await db.update(commentAttachments).set({ deletedAt: nowDb() }).where(eq(commentAttachments.id, id))
    return { ok: false, status: 400, error }
  }
  const incomplete = `"${name}" didn't upload completely. Try attaching it again.`
  let contentType = checked.contentType

  // Any throw from here on (a body that errors, a dropped connection, R2
  // refusing the write) refuses the upload and deletes whatever landed.
  const body = input.body
  let put: R2Object | null
  try {
    const reader = body.getReader()
    const first = await readHead(reader, Math.min(SNIFF_BYTES, size + 1))
    if (first.total > size || (first.done && first.total !== size)) {
      await reader.cancel().catch(() => {})
      return refuse(incomplete, false)
    }
    const verdict = checkAttachmentBytes(name, first.head)
    if (!verdict.ok) {
      await reader.cancel().catch(() => {})
      return refuse(verdict.error, false)
    }
    contentType = verdict.contentType

    // R2 needs a stream of known length. A FixedLengthStream of the declared
    // size errors if the body runs long or short, which fails the put. The
    // head chunks already read go in through a writer. Then the rest of the
    // body is piped by the runtime, natively, with no JavaScript per chunk.
    const { readable, writable } = new FixedLengthStream(size)
    const stop = new AbortController()
    let writer: WritableStreamDefaultWriter<Uint8Array> | null = writable.getWriter()
    // If R2 refuses the write, stop feeding the stream, or the writes below
    // would wait forever for a reader that has gone.
    const putting = bucket.put(r2Key, readable, { httpMetadata: { contentType } }).catch((err: unknown) => {
      stop.abort(err)
      writer?.abort(err).catch(() => {})
      throw err
    })
    const feeding = (async () => {
      for (const c of first.chunks) await writer!.write(c)
      writer!.releaseLock()
      writer = null
      reader.releaseLock()
      await body.pipeTo(writable, { signal: stop.signal })
    })()
    const [stored, fed] = await Promise.allSettled([putting, feeding])
    if (stored.status === 'rejected' || fed.status === 'rejected') return refuse(incomplete, true)
    put = stored.value
  } catch {
    await body.cancel().catch(() => {})
    return refuse(incomplete, true)
  }
  if (!put || put.size !== size) return refuse(incomplete, true)

  const md5 = put.checksums?.md5
  await db.update(commentAttachments)
    .set({ confirmedAt: nowDb(), checksum: md5 ? `md5:${hex(md5)}` : `etag:${put.etag}`, contentType })
    .where(eq(commentAttachments.id, id))
  return { ok: true, attachment: { id, name, contentType, size } }
}

/** Remove an upload before it is posted: the composer's ×. */
export async function removePendingUpload(env: Env, db: AppDb, uploaderId: string, id: string): Promise<boolean> {
  const row = await db.select().from(commentAttachments).where(and(
    eq(commentAttachments.id, id),
    eq(commentAttachments.uploaderId, uploaderId),
    isNull(commentAttachments.commentId),
    isNull(commentAttachments.deletedAt),
  )).get()
  if (!row) return false
  if (env.ATTACHMENTS_BUCKET) await env.ATTACHMENTS_BUCKET.delete(row.r2Key)
  // The row stays, marked deleted, until the purge: it still counts toward the
  // hourly limit, so uploading and removing can't get around it.
  await db.update(commentAttachments).set({ deletedAt: nowDb() }).where(eq(commentAttachments.id, row.id))
  return true
}

/**
 * Check the files a new comment names, before the comment is written: each
 * must be the author's own finished upload, not yet on a comment.
 */
export async function checkAttachable(env: Env, db: AppDb, uploaderId: string, ids: unknown): Promise<{ ok: true; ids: string[] } | Fail> {
  if (ids === undefined || ids === null) return { ok: true, ids: [] }
  if (!Array.isArray(ids) || ids.some(i => typeof i !== 'string')) return { ok: false, status: 400, error: 'attachmentIds must be a list of ids' }
  const unique = [...new Set(ids as string[])]
  if (unique.length === 0) return { ok: true, ids: [] }
  if (!attachmentsEnabled(env)) return { ok: false, status: 400, error: NOT_SET_UP }
  if (unique.length > MAX_ATTACHMENTS_PER_COMMENT) {
    return { ok: false, status: 400, error: `A comment can have at most ${MAX_ATTACHMENTS_PER_COMMENT} files.` }
  }
  const rows = await db.select({ id: commentAttachments.id }).from(commentAttachments).where(and(
    inArray(commentAttachments.id, unique),
    eq(commentAttachments.uploaderId, uploaderId),
    isNull(commentAttachments.commentId),
    isNull(commentAttachments.deletedAt),
    isNotNull(commentAttachments.confirmedAt),
  )).all()
  if (rows.length !== unique.length) {
    return { ok: false, status: 400, error: "One of the files isn't ready to attach. Remove it and attach it again." }
  }
  return { ok: true, ids: unique }
}

/**
 * Put the files on the comment, and return the ones it got. Two posts naming
 * the same upload at once both pass checkAttachable, and only one claims it:
 * the other comment gets the files that are left, and says so in its 201.
 */
export async function attachToComment(db: AppDb, commentId: string, ids: string[]): Promise<AttachmentSummary[]> {
  if (ids.length === 0) return []
  const rows = await db.update(commentAttachments).set({ commentId })
    .where(and(inArray(commentAttachments.id, ids), isNull(commentAttachments.commentId), isNull(commentAttachments.deletedAt)))
    .returning({ id: commentAttachments.id, name: commentAttachments.name, contentType: commentAttachments.contentType, size: commentAttachments.size })
  const order = new Map(ids.map((id, i) => [id, i]))
  return rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!)
}

/** A deleted comment's files, kept 30 days and then purged. */
export async function softDeleteCommentAttachments(db: AppDb, commentId: string): Promise<void> {
  await db.update(commentAttachments).set({ deletedAt: nowDb() })
    .where(and(eq(commentAttachments.commentId, commentId), isNull(commentAttachments.deletedAt)))
}

/** Each comment's live files, in upload order, for the comment payloads. */
export async function loadCommentAttachments(db: AppDb, commentIds: string[]): Promise<Map<string, AttachmentSummary[]>> {
  const out = new Map<string, AttachmentSummary[]>()
  if (commentIds.length === 0) return out
  const rows = await db.select({
    id: commentAttachments.id, commentId: commentAttachments.commentId, name: commentAttachments.name,
    contentType: commentAttachments.contentType, size: commentAttachments.size,
  }).from(commentAttachments)
    .where(and(inArray(commentAttachments.commentId, commentIds), isNull(commentAttachments.deletedAt)))
    .orderBy(commentAttachments.createdAt, sql`rowid`)
    .all()
  for (const r of rows) {
    const list = out.get(r.commentId!) ?? []
    list.push({ id: r.id, name: r.name, contentType: r.contentType, size: r.size })
    out.set(r.commentId!, list)
  }
  return out
}

/**
 * Hourly: delete the bytes and rows of uploads that never finished (after an
 * hour), of uploads never posted (after a day), of
 * deleted comments' files (30 days after the delete), and of files whose
 * comment row is gone (at once). Without a bucket there are no bytes to reach,
 * so the rows wait.
 */
export async function purgeAttachments(env: Env, db: AppDb, now = new Date()): Promise<number> {
  const bucket = env.ATTACHMENTS_BUCKET
  if (!bucket) return 0
  const loose = toDbTs(new Date(now.getTime() - UNATTACHED_TTL_MS))
  const unfinished = toDbTs(new Date(now.getTime() - UNFINISHED_TTL_MS))
  const gone = toDbTs(new Date(now.getTime() - DELETED_TTL_MS))
  let purged = 0
  for (;;) {
    const rows = await db.select({ id: commentAttachments.id, r2Key: commentAttachments.r2Key }).from(commentAttachments)
      .where(or(
        and(isNull(commentAttachments.commentId), lt(commentAttachments.createdAt, loose)),
        and(isNull(commentAttachments.confirmedAt), lt(commentAttachments.createdAt, unfinished)),
        lt(commentAttachments.deletedAt, gone),
        ORPHANED,
      ))
      .limit(500)
      .all()
    if (rows.length === 0) return purged
    await bucket.delete(rows.map(r => r.r2Key))
    await db.delete(commentAttachments).where(inArray(commentAttachments.id, rows.map(r => r.id)))
    purged += rows.length
  }
}
