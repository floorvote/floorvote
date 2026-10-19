// Files attached to comments (#465): storage, limits, and lifecycle.
//
// The bytes live in a private R2 bucket (ATTACHMENTS_BUCKET) under
// `<TENANT_ID>/<random UUID>`, so instances can share one bucket, and each file
// has a row in comment_attachments (migration 0115). The flow:
//
//   1. startUpload: the browser names the file and its size. The server checks
//      the name, the size, the member's hourly limit, and the instance quota,
//      writes a row with no comment, and returns a presigned PUT URL for that
//      one key, signed for that exact size and content type, good for ten
//      minutes. The bytes go straight to R2, never through the Worker.
//   2. confirmUpload: the server reads what arrived (its size and first bytes)
//      and refuses anything that isn't what was signed for. A refused upload's
//      bytes are deleted at once.
//   3. Posting the comment attaches the confirmed files (attachToComment).
//   4. Downloads go through GET /api/attachments/:id (routes/attachmentsApi.ts),
//      only for a file on a comment that still shows.
//
// Deleting the comment marks its files deleted, and purgeAttachments, hourly,
// removes them 30 days later, along with uploads never posted, after a day.
//
// The feature is off until an operator binds the bucket and sets the R2 S3
// credentials the upload URLs are signed with, and always off on a demo.

import { and, eq, inArray, isNull, isNotNull, lt, sql, or } from 'drizzle-orm'
import { commentAttachments } from '../db/schema'
import { presignUrl } from './presign'
import { checkAttachmentBytes, checkAttachmentName, SNIFF_BYTES } from './attachmentType'
import { nowDb, toDbTs } from './dbTime'
import type { AppDb, Env } from '../types'

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
export const MAX_ATTACHMENTS_PER_COMMENT = 10
/** Bytes one instance may hold in live and in-progress uploads. */
export const ATTACHMENT_QUOTA_BYTES = 5 * 1024 ** 3
/** Uploads one member may start in an hour, refused or not. */
export const UPLOADS_PER_HOUR = 30
const UPLOAD_URL_TTL_SECONDS = 600
const UNATTACHED_TTL_MS = 24 * 60 * 60 * 1000
const DELETED_TTL_MS = 30 * 24 * 60 * 60 * 1000

export type AttachmentSummary = { id: string; name: string; contentType: string; size: number }

type Fail = { ok: false; status: 400 | 403 | 404 | 429 | 503; error: string }

export const NOT_SET_UP = 'File attachments are not set up on this instance.'

/** Whether uploads can work here: the bucket and credentials are set, and it isn't a demo. */
export function attachmentsEnabled(env: Env): boolean {
  return env.DEMO_MODE !== 'true'
    && !!env.ATTACHMENTS_BUCKET
    && !!env.ATTACHMENTS_BUCKET_NAME
    && !!env.R2_ACCESS_KEY_ID
    && !!env.R2_SECRET_ACCESS_KEY
    && !!env.CF_ACCOUNT_ID
}

function keyPrefix(env: Env): string {
  return `${env.TENANT_ID}/`
}

/** Whether a stored key is this instance's, in case the bucket is shared. */
export function isOwnKey(env: Env, key: string): boolean {
  return key.startsWith(keyPrefix(env))
}

export async function usedBytes(db: AppDb): Promise<number> {
  const row = await db.select({ n: sql<number>`coalesce(sum(${commentAttachments.size}), 0)` })
    .from(commentAttachments).where(isNull(commentAttachments.deletedAt)).get()
  return row?.n ?? 0
}

export async function startUpload(
  env: Env, db: AppDb, uploaderId: string, input: { name?: unknown; size?: unknown }, now = new Date(),
): Promise<{ ok: true; id: string; uploadUrl: string; uploadHeaders: Record<string, string>; expiresAt: string } | Fail> {
  if (env.DEMO_MODE === 'true') return { ok: false, status: 403, error: 'File attachments are off on the demo.' }
  if (!attachmentsEnabled(env)) return { ok: false, status: 503, error: NOT_SET_UP }

  const checked = checkAttachmentName(typeof input.name === 'string' ? input.name : '')
  if (!checked.ok) return { ok: false, status: 400, error: checked.error }
  const size = input.size
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) {
    return { ok: false, status: 400, error: `"${checked.name}" is empty.` }
  }
  if (size > MAX_ATTACHMENT_BYTES) return { ok: false, status: 400, error: `"${checked.name}" is larger than 25 MB.` }

  const since = toDbTs(new Date(now.getTime() - 60 * 60 * 1000))
  const recent = await db.select({ n: sql<number>`count(*)` }).from(commentAttachments)
    .where(and(eq(commentAttachments.uploaderId, uploaderId), sql`${commentAttachments.createdAt} > ${since}`)).get()
  if ((recent?.n ?? 0) >= UPLOADS_PER_HOUR) {
    return { ok: false, status: 429, error: 'Too many uploads in the last hour. Try again later.' }
  }
  if (await usedBytes(db) + size > ATTACHMENT_QUOTA_BYTES) {
    return { ok: false, status: 400, error: "This instance's file storage is full. An admin can free space by deleting comments with files." }
  }

  const id = crypto.randomUUID()
  const r2Key = `${keyPrefix(env)}${crypto.randomUUID()}`
  await db.insert(commentAttachments).values({
    id, uploaderId, r2Key, name: checked.name, contentType: checked.contentType, size, createdAt: toDbTs(now),
  })
  const uploadHeaders = { 'Content-Type': checked.contentType }
  const uploadUrl = await presignUrl({
    method: 'PUT',
    url: `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.ATTACHMENTS_BUCKET_NAME}/${r2Key}`,
    region: 'auto',
    accessKeyId: env.R2_ACCESS_KEY_ID!,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    date: now,
    expiresSeconds: UPLOAD_URL_TTL_SECONDS,
    headers: { ...uploadHeaders, 'Content-Length': String(size) },
  })
  return { ok: true, id, uploadUrl, uploadHeaders, expiresAt: new Date(now.getTime() + UPLOAD_URL_TTL_SECONDS * 1000).toISOString() }
}

/** The uploader's own row, still unposted and not deleted. */
async function ownPending(db: AppDb, id: string, uploaderId: string) {
  return db.select().from(commentAttachments).where(and(
    eq(commentAttachments.id, id),
    eq(commentAttachments.uploaderId, uploaderId),
    isNull(commentAttachments.commentId),
    isNull(commentAttachments.deletedAt),
  )).get()
}

export async function confirmUpload(env: Env, db: AppDb, uploaderId: string, id: string): Promise<{ ok: true; attachment: AttachmentSummary } | Fail> {
  if (!attachmentsEnabled(env)) return { ok: false, status: 503, error: NOT_SET_UP }
  const row = await ownPending(db, id, uploaderId)
  if (!row) return { ok: false, status: 404, error: 'Not found' }
  const summary = { id: row.id, name: row.name, contentType: row.contentType, size: row.size }
  if (row.confirmedAt) return { ok: true, attachment: summary }

  const bucket = env.ATTACHMENTS_BUCKET!
  const head = await bucket.head(row.r2Key)
  if (!head) return { ok: false, status: 400, error: `"${row.name}" hasn't finished uploading.` }

  const refuse = async (error: string): Promise<Fail> => {
    await bucket.delete(row.r2Key)
    await db.update(commentAttachments).set({ deletedAt: nowDb() }).where(eq(commentAttachments.id, row.id))
    return { ok: false, status: 400, error }
  }
  if (head.size !== row.size || head.size > MAX_ATTACHMENT_BYTES) {
    return refuse(`"${row.name}" didn't upload completely. Try attaching it again.`)
  }
  const sample = await bucket.get(row.r2Key, { range: { offset: 0, length: SNIFF_BYTES } })
  const bytes = sample ? new Uint8Array(await sample.arrayBuffer()) : new Uint8Array()
  const verdict = checkAttachmentBytes(row.name, bytes)
  if (!verdict.ok) return refuse(verdict.error)

  const md5 = head.checksums?.md5
  const checksum = md5 ? `md5:${[...new Uint8Array(md5)].map(b => b.toString(16).padStart(2, '0')).join('')}` : `etag:${head.etag}`
  await db.update(commentAttachments)
    .set({ confirmedAt: nowDb(), checksum, contentType: verdict.contentType })
    .where(eq(commentAttachments.id, row.id))
  return { ok: true, attachment: { ...summary, contentType: verdict.contentType } }
}

/** Remove an upload before it is posted: the composer's ×. */
export async function removePendingUpload(env: Env, db: AppDb, uploaderId: string, id: string): Promise<boolean> {
  const row = await ownPending(db, id, uploaderId)
  if (!row) return false
  if (env.ATTACHMENTS_BUCKET) await env.ATTACHMENTS_BUCKET.delete(row.r2Key)
  // The row stays, marked deleted, until the purge: it still counts toward the
  // hourly limit, so starting and removing uploads can't get around it.
  await db.update(commentAttachments).set({ deletedAt: nowDb() }).where(eq(commentAttachments.id, row.id))
  return true
}

/**
 * Check the files a new comment names, before the comment is written: each
 * must be the author's own confirmed upload, not yet on a comment.
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

export async function attachToComment(db: AppDb, commentId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await db.update(commentAttachments).set({ commentId })
    .where(and(inArray(commentAttachments.id, ids), isNull(commentAttachments.commentId)))
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
 * Hourly: delete the bytes and rows of uploads never posted (after a day) and
 * of deleted comments' files (30 days after the delete). Without a bucket
 * there are no bytes to reach, so the rows wait.
 */
export async function purgeAttachments(env: Env, db: AppDb, now = new Date()): Promise<number> {
  const bucket = env.ATTACHMENTS_BUCKET
  if (!bucket) return 0
  const loose = toDbTs(new Date(now.getTime() - UNATTACHED_TTL_MS))
  const gone = toDbTs(new Date(now.getTime() - DELETED_TTL_MS))
  let purged = 0
  for (;;) {
    const rows = await db.select({ id: commentAttachments.id, r2Key: commentAttachments.r2Key }).from(commentAttachments)
      .where(or(
        and(isNull(commentAttachments.commentId), lt(commentAttachments.createdAt, loose)),
        lt(commentAttachments.deletedAt, gone),
      ))
      .limit(500)
      .all()
    if (rows.length === 0) return purged
    await bucket.delete(rows.map(r => r.r2Key))
    await db.delete(commentAttachments).where(inArray(commentAttachments.id, rows.map(r => r.id)))
    purged += rows.length
  }
}
