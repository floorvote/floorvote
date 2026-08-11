import { Hono } from 'hono'
import { and, eq, sql, isNull } from 'drizzle-orm'
import { requireAuth } from '../middleware/auth'
import { getDb } from '../db/client'
import { comments, commentReactions, commentMentions, feedEvents } from '../db/schema'
import { extractAndNotifyMentions } from '../lib/mentions'
import { sanitizeCommentHtml } from '../lib/sanitizeHtml'
import { nowDb } from '../lib/dbTime'
import { DEMO_COMMENT_REACTION_CAP } from './billsApi/engagementRoutes'
import type { AppEnv } from '../types'

export const commentsApiRouter = new Hono<AppEnv>()

// `emoji` is attacker-controlled and the unique index is (comment, user, emoji),
// so anything the checker admits that onConflictDoNothing won't collapse becomes
// another chip rendered beside the comment. The old rule only asked whether the
// string CONTAINED a pictograph, so "😀BUY-CRYPTO" (15 bytes) passed — roughly a
// dozen characters of arbitrary text, repeatable thousands of chips deep, next
// to a comment on a public site. React escapes it, so this was never XSS; it was
// defacement. Accepting text smuggled inside an "emoji" field is a bug on a real
// tenant too, so this applies everywhere, not just under DEMO_MODE.
//
// Allow only: pictographs, ZWJ (U+200D), variation selectors, skin-tone
// modifiers, and regional indicators (flags) — so multi-codepoint sequences
// (👨‍👩‍👧‍👦, 👍🏽, 🇺🇸, ❤️) still work.
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|[︎️])+$/u
// ...and require a real base character, so a lone ZWJ or bare skin-tone modifier
// can't stand in as a "reaction". Regional indicators are NOT Extended_Pictographic,
// hence both alternatives here — checking only the former rejected 🇺🇸.
const EMOJI_HAS_BASE = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u
// 64, not the previous 16: a family ZWJ sequence (👨‍👩‍👧‍👦) is 25 bytes and the old
// cap rejected it outright. With EMOJI_ONLY above, extra bytes can only buy more
// emoji — never smuggled text — so length is no longer the load-bearing check.
const EMOJI_MAX_BYTES = 64

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
  if (new TextEncoder().encode(body.emoji).length > EMOJI_MAX_BYTES) {
    return c.json({ error: 'emoji too long' }, 400)
  }
  if (!EMOJI_ONLY.test(body.emoji) || !EMOJI_HAS_BASE.test(body.emoji)) {
    return c.json({ error: 'emoji must be an emoji character' }, 400)
  }

  const comment = await db.select({ id: comments.id }).from(comments).where(
    and(eq(comments.id, commentId), isNull(comments.deletedAt))
  ).get()
  if (!comment) return c.json({ error: 'not found' }, 404)

  // Demo tenants: bound the distinct emojis one comment can carry. Reactions
  // hang off the SEEDED comments, which always exist, so the per-bill comment
  // cap is no backstop here. Only a NEW emoji is refused — an emoji already on
  // the comment must stay togglable at the cap, or reacting normally breaks the
  // moment a comment gets popular. 403, not 429: the next reset clears it, not
  // waiting.
  if (c.env.DEMO_MODE === 'true') {
    const existing = await db
      .selectDistinct({ emoji: commentReactions.emoji })
      .from(commentReactions)
      .where(and(eq(commentReactions.commentId, commentId), isNull(commentReactions.deletedAt)))
      .all()
    const alreadyPresent = existing.some(r => r.emoji === body.emoji)
    if (!alreadyPresent && existing.length >= DEMO_COMMENT_REACTION_CAP) {
      return c.json({ error: 'This comment has reached the demo reaction limit' }, 403)
    }
  }

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
