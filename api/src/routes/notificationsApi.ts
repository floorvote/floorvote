import { Hono } from 'hono'
import { eq, desc, isNull, and, inArray } from 'drizzle-orm'
import { requireAuth } from '../middleware/auth'
import { getDb } from '../db/client'
import { commentMentions, comments, users, bills, roles } from '../db/schema'
import { sessionToSlug } from '../lib/sessionSlug'
import { stripHtml } from '../lib/mentions'
import { nowDb } from '../lib/dbTime'
import { activeUser } from '../lib/accountDeletion'
import type { AppEnv } from '../types'

export const notificationsRouter = new Hono<AppEnv>()
notificationsRouter.use('*', requireAuth)

notificationsRouter.get('/', async (c) => {
  const db = getDb(c.env.DB)
  const currentUser = c.get('user')

  const mentionRows = await db
    .select({
      id: commentMentions.id,
      commentId: commentMentions.commentId,
      sourceType: commentMentions.sourceType,
      sourceId: commentMentions.sourceId,
      readAt: commentMentions.readAt,
      createdAt: commentMentions.createdAt,
      commentContent: comments.content,
      authorId: users.id,
      authorName: users.name,
      authorSubtitle: users.subtitle,
      billId: bills.id,
      billNumber: bills.billNumber,
      billTitle: bills.title,
      billAbstract: bills.abstract,
      billState: bills.state,
      billSession: bills.session,
    })
    .from(commentMentions)
    .innerJoin(comments, eq(commentMentions.commentId, comments.id))
    .innerJoin(users, eq(comments.userId, users.id))
    .innerJoin(bills, eq(comments.billId, bills.id))
    .where(and(eq(commentMentions.userId, currentUser.id), isNull(comments.deletedAt), activeUser))
    .orderBy(desc(commentMentions.createdAt))
    .limit(50)
    .all()

  const roleIds = [...new Set(mentionRows.filter(m => m.sourceType === 'role').map(m => m.sourceId))]
  const roleNameMap = new Map<string, string>()
  if (roleIds.length > 0) {
    const roleRows = await db
      .select({ id: roles.id, name: roles.name })
      .from(roles)
      .where(inArray(roles.id, roleIds))
      .all()
    for (const r of roleRows) roleNameMap.set(r.id, r.name)
  }

  return c.json({
    unreadCount: mentionRows.filter(m => m.readAt === null).length,
    mentions: mentionRows.map(m => ({
      id: m.id,
      commentId: m.commentId,
      billId: m.billId,
      billNumber: m.billNumber,
      billTitle: m.billAbstract ?? m.billTitle,
      billState: m.billState,
      sessionSlug: m.billSession ? sessionToSlug(m.billSession) : null,
      authorId: m.authorId,
      authorName: m.authorName,
      authorSubtitle: m.authorSubtitle,
      commentPreview: stripHtml(m.commentContent).slice(0, 150),
      commentHtml: m.commentContent,
      sourceType: m.sourceType,
      sourceLabel: m.sourceType === 'role' ? (roleNameMap.get(m.sourceId) ?? null) : null,
      createdAt: m.createdAt,
      isUnread: m.readAt === null,
    })),
  })
})

notificationsRouter.post('/mark-read', async (c) => {
  const db = getDb(c.env.DB)
  const currentUser = c.get('user')
  await db
    .update(commentMentions)
    .set({ readAt: nowDb() })
    .where(and(eq(commentMentions.userId, currentUser.id), isNull(commentMentions.readAt)))
  return c.json({ ok: true })
})

notificationsRouter.post('/mark-read/:commentId', async (c) => {
  const db = getDb(c.env.DB)
  const currentUser = c.get('user')
  const commentId = c.req.param('commentId')
  await db
    .update(commentMentions)
    .set({ readAt: nowDb() })
    .where(
      and(
        eq(commentMentions.userId, currentUser.id),
        eq(commentMentions.commentId, commentId),
        isNull(commentMentions.readAt),
      ),
    )
  return c.json({ ok: true })
})

notificationsRouter.post('/mark-read-by-bill/:billId', async (c) => {
  const db = getDb(c.env.DB)
  const currentUser = c.get('user')
  const billId = c.req.param('billId')
  const billCommentIds = db
    .select({ id: comments.id })
    .from(comments)
    .where(and(eq(comments.billId, billId), isNull(comments.deletedAt)))
  await db
    .update(commentMentions)
    .set({ readAt: nowDb() })
    .where(
      and(
        eq(commentMentions.userId, currentUser.id),
        isNull(commentMentions.readAt),
        inArray(commentMentions.commentId, billCommentIds),
      ),
    )
  return c.json({ ok: true })
})
