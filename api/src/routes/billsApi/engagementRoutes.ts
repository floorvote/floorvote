import { Hono } from 'hono'
import { eq, and, inArray, isNull } from 'drizzle-orm'
import { requireAdmin } from '../../middleware/auth'
import { getDb } from '../../db/client'
import {
  bills, memberVotes, officialPositions, comments, notes, users, commentReactions, feedEvents,
  customFieldDefinitions, billCustomFieldValues,
} from '../../db/schema'
import { extractAndNotifyMentions, stripHtml } from '../../lib/mentions'
import { sanitizeCommentHtml } from '../../lib/sanitizeHtml'
import type { AppEnv } from '../../types'
import { nowDb } from '../../lib/dbTime'
import { activeUser } from '../../lib/accountDeletion'

export function registerEngagementRoutes(router: Hono<AppEnv>) {
  // POST /bills/:id/votes
  router.post('/:id/votes', async (c) => {
    const db = getDb(c.env.DB)
    const { id } = c.req.param()
    const currentUser = c.get('user')
    if (!currentUser.canVote) {
      return c.json({ error: 'You are not eligible to vote' }, 403)
    }
    const bill = await db.select({ id: bills.id }).from(bills).where(eq(bills.id, id)).get()
    if (!bill) return c.json({ error: 'Not found' }, 404)
    const body = await c.req.json<{ position?: string }>().catch(() => ({} as { position?: string }))
    const VALID = ['support', 'oppose', 'neutral'] as const
    if (!body.position || !VALID.includes(body.position as (typeof VALID)[number])) {
      return c.json({ error: 'position must be support, oppose, or neutral' }, 400)
    }
    const position = body.position as 'support' | 'oppose' | 'neutral'

    const existing = await db
      .select()
      .from(memberVotes)
      .where(and(eq(memberVotes.billId, id), eq(memberVotes.userId, currentUser.id)))
      .get()

    const now = nowDb()
    if (existing) {
      await db
        .update(memberVotes)
        .set({ position, updatedAt: now })
        .where(eq(memberVotes.id, existing.id))
    } else {
      await db.insert(memberVotes).values({
        id: crypto.randomUUID(),
        userId: currentUser.id,
        billId: id,
        position,
        createdAt: now,
        updatedAt: now,
      })
    }

    return c.json({ position })
  })

  // DELETE /bills/:id/votes
  router.delete('/:id/votes', async (c) => {
    const db = getDb(c.env.DB)
    const { id } = c.req.param()
    const currentUser = c.get('user')
    if (!currentUser.canVote) {
      return c.json({ error: 'You are not eligible to vote' }, 403)
    }
    await db
      .delete(memberVotes)
      .where(and(eq(memberVotes.billId, id), eq(memberVotes.userId, currentUser.id)))
    return new Response(null, { status: 204 })
  })

  // POST /bills/:id/position — admin only
  router.post('/:id/position', requireAdmin, async (c) => {
    const db = getDb(c.env.DB)
    const { id } = c.req.param()
    const currentUser = c.get('user')
    const bill = await db.select({ id: bills.id }).from(bills).where(eq(bills.id, id)).get()
    if (!bill) return c.json({ error: 'Not found' }, 404)
    const body = await c.req.json<{ position?: string }>().catch(() => ({} as { position?: string }))
    if (!body.position) return c.json({ error: 'position is required' }, 400)
    const VALID_POSITIONS = ['Support', 'Oppose', 'Amend', 'Monitor', 'No Position']
    if (!VALID_POSITIONS.includes(body.position)) {
      return c.json({ error: 'Invalid position' }, 400)
    }

    const now = nowDb()
    const existing = await db.select().from(officialPositions).where(eq(officialPositions.billId, id)).get()
    if (existing) {
      await db.update(officialPositions)
        .set({ position: body.position, setBy: currentUser.id, updatedAt: now })
        .where(eq(officialPositions.id, existing.id))
    } else {
      await db.insert(officialPositions).values({
        id: crypto.randomUUID(),
        billId: id,
        position: body.position,
        setBy: currentUser.id,
        createdAt: now,
        updatedAt: now,
      })
    }

    await db.insert(feedEvents).values({
      id: crypto.randomUUID(),
      type: 'position_set',
      billId: id,
      userId: currentUser.id,
      metadata: JSON.stringify({ position: body.position }),
    })

    return c.json({ position: body.position })
  })

  // DELETE /bills/:id/position — admin only
  router.delete('/:id/position', requireAdmin, async (c) => {
    const db = getDb(c.env.DB)
    const { id } = c.req.param()
    const bill = await db.select({ id: bills.id }).from(bills).where(eq(bills.id, id)).get()
    if (!bill) return c.json({ error: 'Not found' }, 404)
    await db.delete(officialPositions).where(eq(officialPositions.billId, id))
    await db.update(feedEvents)
      .set({ suppressed: true })
      .where(and(eq(feedEvents.billId, id), eq(feedEvents.type, 'position_set')))
    return new Response(null, { status: 204 })
  })

  // GET /bills/:id/comments
  router.get('/:id/comments', async (c) => {
    const db = getDb(c.env.DB)
    const { id } = c.req.param()
    const currentUser = c.get('user')

    const commentRows = await db
      .select({
        c: comments,
        userName: users.name,
        userEmail: users.email,
        userSubtitle: users.subtitle,
      })
      .from(comments)
      .innerJoin(users, eq(comments.userId, users.id))
      .where(and(eq(comments.billId, id), isNull(comments.deletedAt), activeUser))
      .orderBy(comments.createdAt)
      .all()

    const commentIds = commentRows.map((r) => r.c.id)
    const reactionRows = commentIds.length > 0
      ? await db.select({ reaction: commentReactions, user: users })
          .from(commentReactions)
          .innerJoin(users, eq(commentReactions.userId, users.id))
          .where(and(inArray(commentReactions.commentId, commentIds), isNull(commentReactions.deletedAt), activeUser))
          .all()
      : []

    const reactionsByComment = new Map<string, Map<string, { count: number; userReacted: boolean; reactors: { name: string; subtitle: string | null }[] }>>()
    for (const { reaction: r, user: reactor } of reactionRows) {
      if (!reactionsByComment.has(r.commentId)) reactionsByComment.set(r.commentId, new Map())
      const emojiMap = reactionsByComment.get(r.commentId)!
      if (!emojiMap.has(r.emoji)) emojiMap.set(r.emoji, { count: 0, userReacted: false, reactors: [] })
      const entry = emojiMap.get(r.emoji)!
      entry.count++
      entry.reactors.push({ name: reactor.name, subtitle: reactor.subtitle })
      if (r.userId === currentUser.id) entry.userReacted = true
    }

    return c.json(
      commentRows.map(({ c: comment, userName, userEmail, userSubtitle }) => ({
        id: comment.id,
        userId: comment.userId,
        userName: userName || userEmail,
        userSubtitle: userSubtitle,
        content: comment.content,
        createdAt: comment.createdAt,
        reactions: Array.from(reactionsByComment.get(comment.id)?.entries() ?? []).map(
          ([emoji, data]) => ({ emoji, count: data.count, userReacted: data.userReacted, reactors: data.reactors }),
        ),
      })),
    )
  })

  // POST /bills/:id/comments
  router.post('/:id/comments', async (c) => {
    const db = getDb(c.env.DB)
    const { id } = c.req.param()
    const currentUser = c.get('user')
    const bill = await db.select({ id: bills.id }).from(bills).where(eq(bills.id, id)).get()
    if (!bill) return c.json({ error: 'Not found' }, 404)
    const body = await c.req.json<{ content?: string }>().catch(() => ({} as { content?: string }))
    if (!body.content?.trim()) return c.json({ error: 'content is required' }, 400)
    if (new TextEncoder().encode(body.content.trim()).length > 10_240) {
      return c.json({ error: 'Comment too long (max 10 KB)' }, 400)
    }
    // Sanitize on write to the same allowlist the on-screen renderer uses — the
    // raw value is otherwise interpolated into mention emails unescaped (H5).
    const content = sanitizeCommentHtml(body.content.trim())

    const commentId = crypto.randomUUID()
    const now = nowDb()
    await db.insert(comments).values({
      id: commentId,
      billId: id,
      userId: currentUser.id,
      content,
      createdAt: now,
    })

    const mentionedUserIds = await extractAndNotifyMentions(commentId, content, currentUser.id, currentUser.role, id, c.env, c.executionCtx.waitUntil.bind(c.executionCtx))

    await db.insert(feedEvents).values({
      id: crypto.randomUUID(),
      type: 'comment_added',
      billId: id,
      userId: currentUser.id,
      metadata: JSON.stringify({
        preview: stripHtml(content).slice(0, 120),
        commentId,
        ...(mentionedUserIds.length > 0 ? { mentionedUserIds } : {}),
      }),
      createdAt: now,
    })

    return c.json({ id: commentId, content, createdAt: now }, 201)
  })

  // GET /bills/:id/note
  router.get('/:id/note', async (c) => {
    const db = getDb(c.env.DB)
    const { id } = c.req.param()
    const currentUser = c.get('user')
    const note = await db
      .select()
      .from(notes)
      .where(and(eq(notes.billId, id), eq(notes.userId, currentUser.id)))
      .get()
    return c.json({ content: note?.content ?? null })
  })

  // PUT /bills/:id/note
  router.put('/:id/note', async (c) => {
    const db = getDb(c.env.DB)
    const { id } = c.req.param()
    const currentUser = c.get('user')
    const bill = await db.select({ id: bills.id }).from(bills).where(eq(bills.id, id)).get()
    if (!bill) return c.json({ error: 'Not found' }, 404)
    const body = await c.req.json<{ content?: string }>().catch(() => ({} as { content?: string }))
    const content = body.content ?? ''
    if (new TextEncoder().encode(content).length > 51_200) {
      return c.json({ error: 'Note too long (max 50 KB)' }, 400)
    }
    const now = nowDb()

    await db.insert(notes)
      .values({
        id: crypto.randomUUID(),
        billId: id,
        userId: currentUser.id,
        content,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [notes.billId, notes.userId],
        set: { content, updatedAt: now },
      })

    return c.json({ content })
  })

  // PUT /bills/:id/custom-fields — set custom field values (admin/owner only)
  router.put('/:id/custom-fields', async (c) => {
    const currentUser = c.get('user')
    if (currentUser.role !== 'admin' && currentUser.role !== 'owner') {
      return c.json({ error: 'Forbidden' }, 403)
    }

    const billId = c.req.param('id')
    const body = await c.req.json<Record<string, string | string[] | null>>().catch(() => ({} as Record<string, string | string[] | null>))
    const db = getDb(c.env.DB)

    const bill = await db.select({ id: bills.id }).from(bills).where(eq(bills.id, billId)).get()
    if (!bill) return c.json({ error: 'Bill not found' }, 404)

    const fieldIds = Object.keys(body)
    if (fieldIds.length === 0) return c.json({ ok: true })

    const fieldDefs = await db
      .select()
      .from(customFieldDefinitions)
      .where(inArray(customFieldDefinitions.id, fieldIds))
      .all()
    const defsById = new Map(fieldDefs.map(f => [f.id, f]))

    const now = nowDb()

    for (const [fieldId, raw] of Object.entries(body)) {
      const def = defsById.get(fieldId)
      if (!def) return c.json({ error: `unknown field: ${fieldId}` }, 400)

      // Resolve to either a deletion or a string to store
      let storeValue: string | null
      if (raw === null) {
        storeValue = null
      } else if (def.multiple) {
        if (!Array.isArray(raw)) {
          return c.json({ error: `field ${fieldId} requires an array value` }, 400)
        }
        const opts = def.options ? (JSON.parse(def.options) as string[]) : []
        const invalid = raw.filter(v => !opts.includes(v))
        if (invalid.length > 0) {
          return c.json({ error: 'invalid_options', fieldId, invalid }, 400)
        }
        storeValue = raw.length === 0 ? null : JSON.stringify(raw)
      } else {
        if (Array.isArray(raw)) {
          return c.json({ error: `field ${fieldId} requires a string value` }, 400)
        }
        storeValue = raw
      }

      if (storeValue === null) {
        await db.delete(billCustomFieldValues)
          .where(and(
            eq(billCustomFieldValues.billId, billId),
            eq(billCustomFieldValues.fieldId, fieldId),
          ))
      } else {
        await db.insert(billCustomFieldValues)
          .values({ billId, fieldId, value: storeValue, setBy: currentUser.id, updatedAt: now })
          .onConflictDoUpdate({
            target: [billCustomFieldValues.billId, billCustomFieldValues.fieldId],
            set: { value: storeValue, setBy: currentUser.id, updatedAt: now },
          })
      }
    }

    return c.json({ ok: true })
  })
}
