// Comment attachments over HTTP (#465). See lib/attachments.ts for the flow.
//
//   POST   /api/attachments              start an upload: { name, size } -> a presigned PUT URL
//   POST   /api/attachments/:id/confirm  check what arrived, before it can be posted
//   DELETE /api/attachments/:id          remove an upload not yet posted (uploader only)
//   GET    /api/attachments/usage        storage used against the quota (admins)
//   GET    /api/attachments/:id          download a posted file
import { Hono } from 'hono'
import { and, eq, isNull } from 'drizzle-orm'
import { requireAuth, requireAdmin } from '../middleware/auth'
import { getDb } from '../db/client'
import { commentAttachments, comments, users } from '../db/schema'
import { activeUser } from '../lib/accountDeletion'
import {
  ATTACHMENT_QUOTA_BYTES, attachmentsEnabled, confirmUpload, isOwnKey, removePendingUpload, startUpload, usedBytes,
} from '../lib/attachments'
import type { AppEnv } from '../types'

export const attachmentsRouter = new Hono<AppEnv>()

attachmentsRouter.use('*', requireAuth)

attachmentsRouter.post('/', async (c) => {
  const body = await c.req.json<{ name?: unknown; size?: unknown }>().catch(() => ({}))
  const r = await startUpload(c.env, getDb(c.env.DB), c.get('user').id, body)
  if (!r.ok) return c.json({ error: r.error }, r.status)
  return c.json({ id: r.id, uploadUrl: r.uploadUrl, uploadHeaders: r.uploadHeaders, expiresAt: r.expiresAt }, 201)
})

attachmentsRouter.post('/:id/confirm', async (c) => {
  const r = await confirmUpload(c.env, getDb(c.env.DB), c.get('user').id, c.req.param('id'))
  if (!r.ok) return c.json({ error: r.error }, r.status)
  return c.json(r.attachment)
})

attachmentsRouter.delete('/:id', async (c) => {
  const removed = await removePendingUpload(c.env, getDb(c.env.DB), c.get('user').id, c.req.param('id'))
  return removed ? new Response(null, { status: 204 }) : c.json({ error: 'Not found' }, 404)
})

attachmentsRouter.get('/usage', requireAdmin, async (c) => {
  return c.json({ enabled: attachmentsEnabled(c.env), usedBytes: await usedBytes(getDb(c.env.DB)), quotaBytes: ATTACHMENT_QUOTA_BYTES })
})

// The served file must never act as a page: a download unless it is a PDF or
// an image, the browser told not to guess its type, and a sandbox CSP that
// gives it no origin, scripts, or forms should it render anyway.
export const ATTACHMENT_CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'none'"
const INLINE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'])

function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  // An ASCII fallback for old clients, then the real name (RFC 6266 / 5987).
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_')
  const encoded = encodeURIComponent(name).replace(/['()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

attachmentsRouter.get('/:id', async (c) => {
  const notFound = () => c.json({ error: 'Not found' }, 404)
  const bucket = c.env.ATTACHMENTS_BUCKET
  if (!bucket) return notFound()
  const db = getDb(c.env.DB)
  // Only a file on a comment that still shows: not deleted, and not a
  // deactivated member's (activeUser), as the thread itself hides those.
  const row = await db.select({ a: commentAttachments })
    .from(commentAttachments)
    .innerJoin(comments, eq(commentAttachments.commentId, comments.id))
    .innerJoin(users, eq(comments.userId, users.id))
    .where(and(
      eq(commentAttachments.id, c.req.param('id')),
      isNull(commentAttachments.deletedAt),
      isNull(comments.deletedAt),
      activeUser,
    ))
    .get()
  if (!row || !isOwnKey(c.env, row.a.r2Key)) return notFound()
  const object = await bucket.get(row.a.r2Key)
  if (!object) return notFound()

  const type = row.a.contentType
  c.header('Content-Type', type)
  c.header('Content-Length', String(object.size))
  c.header('Content-Disposition', contentDisposition(INLINE_TYPES.has(type) ? 'inline' : 'attachment', row.a.name))
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Content-Security-Policy', ATTACHMENT_CSP)
  c.header('Cache-Control', 'private, no-store')
  return c.body(object.body)
})
