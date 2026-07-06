import { Hono } from 'hono'
import { and, eq, sql, isNull } from 'drizzle-orm'
import { requireAuth } from '../middleware/auth'
import { getDb } from '../db/client'
import { comments, commentReactions, commentMentions, feedEvents } from '../db/schema'
import { extractAndNotifyMentions } from '../lib/mentions'
import { sanitizeCommentHtml } from '../lib/sanitizeHtml'
import { nowDb } from '../lib/dbTime'
import type { AppEnv } from '../types'

export const commentsApiRouter = new Hono<AppEnv>()

commentsApiRouter.use('*', requireAuth)

// PATCH /comments/:id — edit own comment
commentsApiRouter.patch('/:id', async (c) => {
  const db = getDb(c.env.DB)
  const { id } = c.req.param()
  const currentUser = c.get('user')
  const body = await c.req.json<{ content?: string }>().catch(() => ({} as { content?: string }))
  if (!body.content?.trim()) return c.json({ error: 'content is required' }, 400)
  if (new TextEncoder().encode(body.content.trim()).length > 10_240) {
    return c.json({ error: 'Comment too long (max 10 KB)' }, 400)
  }
  // Sanitize on write to the same allowlist the on-screen renderer uses — the
  // raw value is otherwise interpolated into mention emails unescaped (H5).
  const content = sanitizeCommentHtml(body.content.trim())

  const comment = await db.select().from(comments).where(
    and(eq(comments.id, id), isNull(comments.deletedAt))
  ).get()
  if (!comment) return c.json({ error: 'not found' }, 404)
  if (comment.userId !== currentUser.id) return c.json({ error: 'forbidden' }, 403)

  await db.update(comments).set({ content }).where(eq(comments.id, id))

  await db.delete(commentMentions).where(eq(commentMentions.commentId, id))
  await extractAndNotifyMentions(id, content, currentUser.id, currentUser.role, comment.billId, c.env, c.executionCtx.waitUntil.bind(c.executionCtx))

  return c.json({ ok: true })
})

// DELETE /comments/:id — soft-delete own comment or admin/owner deletes any
commentsApiRouter.delete('/:id', async (c) => {
  const db = getDb(c.env.DB)
  const { id } = c.req.param()
  const currentUser = c.get('user')

  const comment = await db.select().from(comments).where(
    and(eq(comments.id, id), isNull(comments.deletedAt))
  ).get()
  if (!comment) return c.json({ error: 'not found' }, 404)
  if (comment.userId !== currentUser.id && currentUser.role !== 'admin' && currentUser.role !== 'owner') {
    return c.json({ error: 'forbidden' }, 403)
  }
  if (c.env.DEMO_MODE === 'true' && comment.userId !== currentUser.id) {
    return c.json({ error: 'Cannot delete other users\' comments in demo mode' }, 403)
  }

  const now = nowDb()
  await db.update(comments).set({ deletedAt: now, deletedBy: currentUser.id }).where(eq(comments.id, id))
  await db.update(commentReactions).set({ deletedAt: now }).where(eq(commentReactions.commentId, id))
  await db.update(feedEvents)
    .set({ suppressed: true })
    .where(and(
      eq(feedEvents.type, 'comment_added'),
      eq(feedEvents.billId, comment.billId),
      sql`json_extract(${feedEvents.metadata}, '$.commentId') = ${id}`,
    ))
  return new Response(null, { status: 204 })
})

// POST /comments/:id/reactions
commentsApiRouter.post('/:id/reactions', async (c) => {
  const db = getDb(c.env.DB)
  const { id: commentId } = c.req.param()
  const currentUser = c.get('user')
  const body = await c.req.json<{ emoji?: string }>().catch(() => ({} as { emoji?: string }))
  if (!body.emoji) return c.json({ error: 'emoji is required' }, 400)
  if (new TextEncoder().encode(body.emoji).length > 16) {
    return c.json({ error: 'emoji too long' }, 400)
  }
  if (!/\p{Extended_Pictographic}/u.test(body.emoji)) {
    return c.json({ error: 'emoji must be an emoji character' }, 400)
  }

  const comment = await db.select({ id: comments.id }).from(comments).where(
    and(eq(comments.id, commentId), isNull(comments.deletedAt))
  ).get()
  if (!comment) return c.json({ error: 'not found' }, 404)

  await db.insert(commentReactions)
    .values({
      id: crypto.randomUUID(),
      commentId,
      userId: currentUser.id,
      emoji: body.emoji,
      createdAt: nowDb(),
    })
    .onConflictDoNothing()

  return c.json({ ok: true })
})

// DELETE /comments/:id/reactions/:emoji
commentsApiRouter.delete('/:id/reactions/:emoji', async (c) => {
  const db = getDb(c.env.DB)
  const { id: commentId, emoji } = c.req.param()
  const currentUser = c.get('user')

  let decodedEmoji: string
  try {
    decodedEmoji = decodeURIComponent(emoji)
  } catch {
    return c.json({ error: 'invalid emoji encoding' }, 400)
  }

  await db
    .delete(commentReactions)
    .where(
      and(
        eq(commentReactions.commentId, commentId),
        eq(commentReactions.userId, currentUser.id),
        eq(commentReactions.emoji, decodedEmoji),
      ),
    )

  return new Response(null, { status: 204 })
})
