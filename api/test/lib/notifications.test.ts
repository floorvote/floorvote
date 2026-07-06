import { describe, it, expect, beforeEach } from 'vitest'
import { SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill, seedComment, seedCommentMention } from '../helpers'
import { getDb } from '../../src/db/client'
import { commentMentions, roles } from '../../src/db/schema'
import { eq } from 'drizzle-orm'
import { env } from 'cloudflare:test'

describe('GET /notifications', () => {
  let userId: string
  let token: string
  let authorId: string
  let billId: string
  let commentId: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    userId = await seedUser({ name: 'Jane', email: 'jane@example.com' })
    token = await seedSession(userId)
    authorId = await seedUser({ name: 'Bob', email: 'bob@example.com' })
    billId = await seedBill({ billNumber: 'HB 1', state: 'RI', session: '2026 Regular Session' })
    commentId = await seedComment(billId, authorId, '<p>Hey <span data-type="mention" data-id="user:jane">@Jane</span></p>')
  })

  it('returns empty mentions and zero unread count when no mentions', async () => {
    const res = await SELF.fetch('http://localhost/api/notifications', {
      headers: { Cookie: `session=${token}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { unreadCount: number; mentions: unknown[] }
    expect(body.unreadCount).toBe(0)
    expect(body.mentions).toHaveLength(0)
  })

  it('returns unread mentions with correct shape', async () => {
    await seedCommentMention(commentId, userId, { sourceType: 'user', sourceId: userId })

    const res = await SELF.fetch('http://localhost/api/notifications', {
      headers: { Cookie: `session=${token}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as {
      unreadCount: number
      mentions: Array<{
        id: string
        commentId: string
        billId: string
        billNumber: string
        billTitle: string
        billState: string
        sessionSlug: string
        authorName: string
        commentPreview: string
        sourceType: string
        sourceLabel: string | null
        isUnread: boolean
      }>
    }
    expect(body.unreadCount).toBe(1)
    expect(body.mentions).toHaveLength(1)
    const m = body.mentions[0]
    expect(m.commentId).toBe(commentId)
    expect(m.billId).toBe(billId)
    expect(m.billNumber).toBe('HB 1')
    expect(m.billState).toBe('RI')
    expect(m.sessionSlug).toBe('2026')
    expect(m.authorName).toBe('Bob')
    expect(m.commentPreview).toBe('Hey @Jane')
    expect(m.sourceType).toBe('user')
    expect(m.sourceLabel).toBeNull()
    expect(m.isUnread).toBe(true)
  })

  it('counts only unread mentions in unreadCount', async () => {
    const readCommentId = await seedComment(billId, authorId)
    await seedCommentMention(commentId, userId)
    await seedCommentMention(readCommentId, userId, { readAt: new Date().toISOString() })

    const res = await SELF.fetch('http://localhost/api/notifications', {
      headers: { Cookie: `session=${token}` },
    })
    const body = await res.json() as { unreadCount: number; mentions: unknown[] }
    expect(body.unreadCount).toBe(1)
    expect(body.mentions).toHaveLength(2)
    const mentions = (body as any).mentions as Array<{ isUnread: boolean }>
    expect(mentions.filter(m => m.isUnread)).toHaveLength(1)
  })

  it('returns sourceLabel for role mentions', async () => {
    const db = getDb(env.DB)
    const roleId = crypto.randomUUID()
    await db.insert(roles).values({ id: roleId, name: 'Elections Committee' })
    await seedCommentMention(commentId, userId, { sourceType: 'role', sourceId: roleId })

    const res = await SELF.fetch('http://localhost/api/notifications', {
      headers: { Cookie: `session=${token}` },
    })
    const body = await res.json() as { mentions: Array<{ sourceType: string; sourceLabel: string | null }> }
    expect(body.mentions[0].sourceType).toBe('role')
    expect(body.mentions[0].sourceLabel).toBe('Elections Committee')
  })

  it('returns 401 without authentication', async () => {
    const res = await SELF.fetch('http://localhost/api/notifications')
    expect(res.status).toBe(401)
  })
})

describe('POST /notifications/mark-read (bulk)', () => {
  let userId: string
  let token: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    userId = await seedUser({ email: 'jane@example.com' })
    token = await seedSession(userId)
    const authorId = await seedUser({ email: 'bob@example.com' })
    const billId = await seedBill()
    const c1 = await seedComment(billId, authorId)
    const c2 = await seedComment(billId, authorId)
    await seedCommentMention(c1, userId)
    await seedCommentMention(c2, userId)
  })

  it('marks all unread mentions as read', async () => {
    const res = await SELF.fetch('http://localhost/api/notifications/mark-read', {
      method: 'POST',
      headers: { Cookie: `session=${token}` },
    })
    expect(res.status).toBe(200)

    const db = getDb(env.DB)
    const all = await db.select().from(commentMentions).where(eq(commentMentions.userId, userId)).all()
    expect(all.every(m => m.readAt !== null)).toBe(true)
  })

  it('does not mark other users mentions as read', async () => {
    const otherId = await seedUser({ email: 'other@example.com' })
    const otherToken = await seedSession(otherId)
    const authorId = await seedUser({ email: 'author2@example.com' })
    const billId = await seedBill()
    const c = await seedComment(billId, authorId)
    await seedCommentMention(c, otherId)

    await SELF.fetch('http://localhost/api/notifications/mark-read', {
      method: 'POST',
      headers: { Cookie: `session=${otherToken}` },
    })

    const db = getDb(env.DB)
    const janeUnread = await db.select().from(commentMentions).where(eq(commentMentions.userId, userId)).all()
    expect(janeUnread.every(m => m.readAt === null)).toBe(true)
  })
})

describe('POST /notifications/mark-read/:commentId (single)', () => {
  let userId: string
  let token: string
  let commentId1: string
  let commentId2: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    userId = await seedUser({ email: 'jane@example.com' })
    token = await seedSession(userId)
    const authorId = await seedUser({ email: 'bob@example.com' })
    const billId = await seedBill()
    commentId1 = await seedComment(billId, authorId)
    commentId2 = await seedComment(billId, authorId)
    await seedCommentMention(commentId1, userId)
    await seedCommentMention(commentId2, userId)
  })

  it('marks only the specified comment mention as read', async () => {
    const res = await SELF.fetch(`http://localhost/api/notifications/mark-read/${commentId1}`, {
      method: 'POST',
      headers: { Cookie: `session=${token}` },
    })
    expect(res.status).toBe(200)

    const db = getDb(env.DB)
    const all = await db.select().from(commentMentions).where(eq(commentMentions.userId, userId)).all()
    const c1 = all.find(m => m.commentId === commentId1)!
    const c2 = all.find(m => m.commentId === commentId2)!
    expect(c1.readAt).not.toBeNull()
    expect(c2.readAt).toBeNull()
  })
})
