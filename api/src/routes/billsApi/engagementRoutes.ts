import { Hono } from 'hono'
import { eq, and, inArray, isNull, sql } from 'drizzle-orm'
import { requireAdmin } from '../../middleware/auth'
import { getDb } from '../../db/client'
import { rowidOf } from '../../db/rowid'
import {
  bills, memberVotes, officialPositions, comments, notes, users, commentReactions, feedEvents,
  billCustomFieldValues, customFieldDefinitions,
} from '../../db/schema'
import { extractAndNotifyMentions } from '../../lib/mentions'
import { notifyParticipantsOfReply } from '../../lib/replies'
import { muteBill, unmuteBill } from '../../lib/billMutes'
import { stripHtml } from '../../lib/stripHtml'
import { COMMENT_PREVIEW_MAX, truncateWithEllipsis } from '../../../../shared/feedUtils'
import { sanitizeCommentHtml } from '../../lib/sanitizeHtml'
import { attachmentSummaryText, attachToComment, checkAttachable, loadCommentAttachments } from '../../lib/attachments'
import type { AppEnv } from '../../types'
import { nowDb } from '../../lib/dbTime'
import { activeUser } from '../../lib/accountDeletion'
import { resolveCustomFieldValues } from '../../lib/customFieldValues'
import { displayName } from '../../lib/displayName'
import { inGroupOf, loadGroupBills, loadGroupNotes, mergeGroupNotes } from '../../lib/companionGroups'
import { loadGroupTeamValues, recordFieldChanges } from '../../lib/teamFields'

// Max live (non-deleted) comments one bill may hold on a DEMO_MODE tenant. The
// per-IP limiter in demoReadOnly bounds the *rate* an anonymous visitor can
// write; this bounds total growth, which a slow drip from many IPs would
// otherwise leave unbounded between resets. 60 is far past anything a visitor
// can see: the busiest seeded bill carries 8 comments, and the bill-detail
// payload returns only the first 20.
export const DEMO_BILL_COMMENT_CAP = 60

// The most companion notes one note save may merge away.
const MAX_NOTE_MERGES = 50

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
      // Rewritten rather than updated in place, so its rowid follows this
      // write. A companion group resolves a member's vote to the latest on any
      // of its bills, and times are stored to the second, so rowid breaks the
      // tie between votes cast in the same second.
      await db.batch([
        db.delete(memberVotes).where(eq(memberVotes.id, existing.id)),
        db.insert(memberVotes).values({ ...existing, position, updatedAt: now }),
      ])
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
    // A member has one vote on a companion group, resolved from their votes on
    // any of its bills, so retracting it removes them all. Leaving an older one
    // on a companion would bring that vote back.
    await db
      .delete(memberVotes)
      .where(and(inGroupOf(memberVotes.billId, id), eq(memberVotes.userId, currentUser.id)))
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

    // Stored on this bill, and the most recent in its companion group, so the
    // whole group reads it.
    const old = (await loadGroupTeamValues(db, id)).position?.position ?? null
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
    await recordFieldChanges(db, [{ billId: id, field: 'position', label: 'position', old, new: body.position }], currentUser.id)

    return c.json({ position: body.position })
  })

  // DELETE /bills/:id/position — admin only
  router.delete('/:id/position', requireAdmin, async (c) => {
    const db = getDb(c.env.DB)
    const { id } = c.req.param()
    const bill = await db.select({ id: bills.id }).from(bills).where(eq(bills.id, id)).get()
    if (!bill) return c.json({ error: 'Not found' }, 404)
    // Cleared on every bill in the companion group: an older position left on
    // a companion would otherwise become the group's.
    const old = (await loadGroupTeamValues(db, id)).position?.position ?? null
    await db.delete(officialPositions).where(inGroupOf(officialPositions.billId, id))
    await db.update(feedEvents)
      .set({ suppressed: true })
      .where(and(inGroupOf(feedEvents.billId, id), eq(feedEvents.type, 'position_set')))
    await recordFieldChanges(db, [{ billId: id, field: 'position', label: 'position', old, new: null }], c.get('user').id)
    return new Response(null, { status: 204 })
  })

  // GET /bills/:id/comments
  router.get('/:id/comments', async (c) => {
    const db = getDb(c.env.DB)
    const { id } = c.req.param()
    const currentUser = c.get('user')

    // The whole companion group's conversation, as on the bill page.
    const billNumberOf = new Map((await loadGroupBills(db, id)).map(b => [b.billId, b.billNumber]))
    const commentRows = await db
      .select({
        c: comments,
        userName: users.name,
        userEmail: users.email,
        userTitle: users.title,
      })
      .from(comments)
      .innerJoin(users, eq(comments.userId, users.id))
      .where(and(inGroupOf(comments.billId, id), isNull(comments.deletedAt), activeUser))
      // Same tiebreaker as the bill-detail comment block (billsApi/detail.ts):
      // created_at is truncated to seconds, so seeded comments sharing a daysAgo
      // — and a visitor's comment landing the same second — collide, and rowid
      // (insert order) is the intended reading order. This endpoint has no web
      // caller today, but the two must not disagree about comment order.
      .orderBy(comments.createdAt, rowidOf(comments))
      .all()

    const commentIds = commentRows.map((r) => r.c.id)
    const reactionRows = commentIds.length > 0
      ? await db.select({ reaction: commentReactions, user: users })
          .from(commentReactions)
          .innerJoin(users, eq(commentReactions.userId, users.id))
          .where(and(inArray(commentReactions.commentId, commentIds), isNull(commentReactions.deletedAt), activeUser))
          .all()
      : []
    const attachmentsByComment = await loadCommentAttachments(db, commentIds)

    const reactionsByComment = new Map<string, Map<string, { count: number; userReacted: boolean; reactors: { name: string; title: string | null }[] }>>()
    for (const { reaction: r, user: reactor } of reactionRows) {
      if (!reactionsByComment.has(r.commentId)) reactionsByComment.set(r.commentId, new Map())
      const emojiMap = reactionsByComment.get(r.commentId)!
      if (!emojiMap.has(r.emoji)) emojiMap.set(r.emoji, { count: 0, userReacted: false, reactors: [] })
      const entry = emojiMap.get(r.emoji)!
      entry.count++
      entry.reactors.push({ name: displayName(reactor), title: reactor.title })
      if (r.userId === currentUser.id) entry.userReacted = true
    }

    return c.json(
      commentRows.map(({ c: comment, userName, userEmail, userTitle }) => ({
        id: comment.id,
        billId: comment.billId,
        billNumber: billNumberOf.get(comment.billId) ?? null,
        userId: comment.userId,
        userName: userName || userEmail,
        userTitle,
        content: comment.content,
        createdAt: comment.createdAt,
        reactions: Array.from(reactionsByComment.get(comment.id)?.entries() ?? []).map(
          ([emoji, data]) => ({ emoji, count: data.count, userReacted: data.userReacted, reactors: data.reactors }),
        ),
        attachments: attachmentsByComment.get(comment.id) ?? [],
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
    const body = await c.req.json<{ content?: string; attachmentIds?: unknown }>().catch(() => ({} as { content?: string; attachmentIds?: unknown }))
    const text = typeof body.content === 'string' ? body.content.trim() : ''
    if (new TextEncoder().encode(text).length > 10_240) {
      return c.json({ error: 'Comment too long (max 10 KB)' }, 400)
    }
    // Files the composer uploaded and confirmed (#465), checked before the
    // comment is written so a refused file posts nothing.
    const attachable = await checkAttachable(c.env, db, currentUser.id, body.attachmentIds)
    if (!attachable.ok) return c.json({ error: attachable.error }, attachable.status)
    // A comment is text, files, or both: blank text needs at least one file.
    if (!text && attachable.ids.length === 0) return c.json({ error: 'content is required' }, 400)
    if (c.env.DEMO_MODE === 'true') {
      const live = await db
        .select({ n: sql<number>`count(*)` })
        .from(comments)
        .where(and(eq(comments.billId, id), isNull(comments.deletedAt)))
        .get()
      if ((live?.n ?? 0) >= DEMO_BILL_COMMENT_CAP) {
        // 403, not 429: waiting doesn't clear this. The bill stays full until
        // the next reset, so "try again shortly" would be a false promise. The
        // per-IP limiter in demoReadOnly is the genuinely temporary one.
        return c.json({ error: 'This bill has reached the demo comment limit — try another bill' }, 403)
      }
    }
    // Sanitize on write to the same allowlist the on-screen renderer uses — the
    // raw value is otherwise interpolated into mention emails unescaped (H5).
    const content = sanitizeCommentHtml(text)

    const commentId = crypto.randomUUID()
    const now = nowDb()
    await db.insert(comments).values({
      id: commentId,
      billId: id,
      userId: currentUser.id,
      content,
      createdAt: now,
    })
    const attachments = await attachToComment(db, commentId, attachable.ids)
    if (!text && attachments.length === 0) {
      // Another post claimed the files first (two tabs, or a retry after a lost
      // response). Nothing references this row yet, so remove it.
      await db.delete(comments).where(eq(comments.id, commentId))
      return c.json({ error: 'Those files were already attached' }, 409)
    }

    // A file-only comment has no body to preview, so notifications and the feed
    // say what was attached instead. This is not stored as the comment's content.
    const typed = stripHtml(content)
    const preview = typed || attachmentSummaryText(attachments)
    const notifyHtml = typed || !preview ? content : sanitizeCommentHtml(`<p>${preview}</p>`)

    const mentionedUserIds = await extractAndNotifyMentions(commentId, content, currentUser.id, currentUser.role, id, c.env, c.executionCtx.waitUntil.bind(c.executionCtx))
    // Everyone else who has commented here hears about it too, except the people
    // this comment mentions (they got the mention).
    await notifyParticipantsOfReply({ id: commentId, html: notifyHtml, createdAt: now }, currentUser.id, id, mentionedUserIds, c.env, c.executionCtx.waitUntil.bind(c.executionCtx))

    await db.insert(feedEvents).values({
      id: crypto.randomUUID(),
      type: 'comment_added',
      billId: id,
      userId: currentUser.id,
      metadata: JSON.stringify({
        preview: truncateWithEllipsis(preview, COMMENT_PREVIEW_MAX),
        commentId,
        ...(mentionedUserIds.length > 0 ? { mentionedUserIds } : {}),
      }),
      createdAt: now,
    })

    return c.json({ id: commentId, content, createdAt: now, attachments }, 201)
  })

  // PUT /bills/:id/mute: mute this bill's comments for the member (#355). No
  // reply notifications for it, in the app or by email. Mentions still arrive.
  // Works whether or not the member has commented on the bill.
  router.put('/:id/mute', async (c) => {
    const db = getDb(c.env.DB)
    const { id } = c.req.param()
    const bill = await db.select({ id: bills.id }).from(bills).where(eq(bills.id, id)).get()
    if (!bill) return c.json({ error: 'Not found' }, 404)
    await muteBill(db, c.get('user').id, id)
    return c.json({ muted: true })
  })

  // DELETE /bills/:id/mute: unmute it.
  router.delete('/:id/mute', async (c) => {
    const db = getDb(c.env.DB)
    await unmuteBill(db, c.get('user').id, c.req.param('id'))
    return c.json({ muted: false })
  })

  // GET /bills/:id/note
  router.get('/:id/note', async (c) => {
    const db = getDb(c.env.DB)
    const { id } = c.req.param()
    const currentUser = c.get('user')
    // The member's notes across the companion group: each one, and the one
    // note to edit that holds them all.
    const groupNotes = await loadGroupNotes(db, id, currentUser.id)
    return c.json({ content: mergeGroupNotes(groupNotes), notes: groupNotes })
  })

  // PUT /bills/:id/note
  router.put('/:id/note', async (c) => {
    const db = getDb(c.env.DB)
    const { id } = c.req.param()
    const currentUser = c.get('user')
    const bill = await db.select({ id: bills.id }).from(bills).where(eq(bills.id, id)).get()
    if (!bill) return c.json({ error: 'Not found' }, 404)
    const body = await c.req.json<{ content?: string; merges?: unknown }>().catch(() => ({} as { content?: string; merges?: unknown }))
    const content = body.content ?? ''
    // The companion bills whose notes the page showed with this one, and
    // which this save therefore replaces. A group is a handful of bills, so
    // more than MAX_NOTE_MERGES is not a page's request.
    const merges = [...new Set(Array.isArray(body.merges) ? body.merges.filter((m): m is string => typeof m === 'string' && m !== id) : [])]
    if (merges.length > MAX_NOTE_MERGES) return c.json({ error: `merges may name at most ${MAX_NOTE_MERGES} bills` }, 400)
    if (new TextEncoder().encode(content).length > 51_200) {
      return c.json({ error: 'Note too long (max 50 KB)' }, 400)
    }
    const now = nowDb()

    const upsert = db.insert(notes)
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
    // One note per member per companion group: the page showed the member's
    // notes from other bills with this one, and the edit replaces them. Only
    // the ones it showed, so a page loaded before the bills were grouped never
    // deletes a note its member didn't see. Only notes in this bill's group,
    // and only this member's. One batch, so two pages saving at once leave
    // the later save's note rather than neither.
    if (merges.length === 0) {
      await upsert
    } else {
      await db.batch([upsert, db.delete(notes).where(and(
        eq(notes.userId, currentUser.id),
        inGroupOf(notes.billId, id),
        inArray(notes.billId, merges),
      ))])
    }

    return c.json({ content })
  })

  // PUT /bills/:id/custom-fields — set custom field values (admin/owner only)
  router.put('/:id/custom-fields', async (c) => {
    const currentUser = c.get('user')
    if (currentUser.role !== 'admin' && currentUser.role !== 'owner') {
      return c.json({ error: 'Forbidden' }, 403)
    }

    const billId = c.req.param('id')
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
    const db = getDb(c.env.DB)

    const bill = await db.select({ id: bills.id }).from(bills).where(eq(bills.id, billId)).get()
    if (!bill) return c.json({ error: 'Bill not found' }, 404)

    const resolved = await resolveCustomFieldValues(db, body)
    if (!resolved.ok) return c.json(resolved.error, 400)

    // A value is stored on this bill and is the most recent in its companion
    // group, so the group reads it. Clearing clears it on every member.
    const before = (await loadGroupTeamValues(db, billId)).customFields
    const fieldIds = resolved.values.map(v => v.fieldId)
    const labelOf = new Map(fieldIds.length === 0 ? [] : (await db.select({ id: customFieldDefinitions.id, name: customFieldDefinitions.name })
      .from(customFieldDefinitions).where(inArray(customFieldDefinitions.id, fieldIds)).all()).map(d => [d.id, d.name]))
    const now = nowDb()
    for (const { fieldId, value: storeValue } of resolved.values) {
      if (storeValue === null) {
        await db.delete(billCustomFieldValues)
          .where(and(
            inGroupOf(billCustomFieldValues.billId, billId),
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
    await recordFieldChanges(db, resolved.values.map(({ fieldId, value }) => ({
      billId, field: 'customField' as const, fieldId, label: labelOf.get(fieldId) ?? fieldId, old: before.get(fieldId)?.value ?? null, new: value,
    })), currentUser.id)

    return c.json({ ok: true })
  })
}
