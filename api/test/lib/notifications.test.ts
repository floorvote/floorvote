import { describe, it, expect, beforeEach } from 'vitest'
import { SELF } from 'cloudflare:test'
import { clearDb, seedUser, seedSession, seedBill, seedComment, seedCommentMention } from '../helpers'
import { getDb } from '../../src/db/client'
import { comments, roles } from '../../src/db/schema'
import { eq } from 'drizzle-orm'
import { env } from 'cloudflare:test'

type Body = {
  unreadCount: number
  notifications: Array<{
    id: string
    kind: string
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

async function getNotifications(token: string): Promise<Body> {
  const res = await SELF.fetch('http://localhost/api/notifications', {
    headers: { Cookie: `session=${token}` },
  })
  expect(res.status).toBe(200)
  return await res.json() as Body
}

async function post(path: string, token: string) {
  const res = await SELF.fetch(`http://localhost/api/notifications${path}`, {
    method: 'POST',
    headers: { Cookie: `session=${token}` },
  })
  expect(res.status).toBe(200)
}

const unreadCommentIds = (body: Body) => body.notifications.filter(n => n.isUnread).map(n => n.commentId).sort()

describe('GET /notifications', () => {
  let userId: string
  let token: string
  let authorId: string
  let billId: string
  let commentId: string

  beforeEach(async () => {
    await clearDb()
    userId = await seedUser({ name: 'Jane', email: 'jane@example.com' })
    token = await seedSession(userId)
    authorId = await seedUser({ name: 'Bob', email: 'bob@example.com' })
    billId = await seedBill({ billNumber: 'HB 1', state: 'RI', session: '2026 Regular Session' })
    commentId = await seedComment(billId, authorId, '<p>Hey <span data-type="mention" data-id="user:jane">@Jane</span></p>')
  })

  it('returns no notifications and zero unread count when there are none', async () => {
    const body = await getNotifications(token)
    expect(body.unreadCount).toBe(0)
    expect(body.notifications).toHaveLength(0)
  })

  it("uses the session slug central stored, not the one the session name implies", async () => {
    const stored = await seedBill({ billNumber: 'HB 2', state: 'RI', session: '2026 Regular Session', sessionSlug: '2026-2' })
    const storedComment = await seedComment(stored, authorId, '<p>Hi</p>')
    await seedCommentMention(storedComment, userId, { sourceType: 'user', sourceId: userId })

    const body = await getNotifications(token)
    expect(body.notifications.find(n => n.commentId === storedComment)?.sessionSlug).toBe('2026-2')
  })

  it('returns an unread mention with kind mention and the correct shape', async () => {
    await seedCommentMention(commentId, userId, { sourceType: 'user', sourceId: userId })

    const body = await getNotifications(token)
    expect(body.unreadCount).toBe(1)
    expect(body.notifications).toHaveLength(1)
    const m = body.notifications[0]
    expect(m.kind).toBe('mention')
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

  it('counts only unread notifications in unreadCount', async () => {
    const readCommentId = await seedComment(billId, authorId)
    await seedCommentMention(commentId, userId)
    await seedCommentMention(readCommentId, userId, { readAt: new Date().toISOString() })

    const body = await getNotifications(token)
    expect(body.unreadCount).toBe(1)
    expect(body.notifications).toHaveLength(2)
    expect(body.notifications.filter(m => m.isUnread)).toHaveLength(1)
  })

  it('returns sourceLabel for role mentions', async () => {
    const db = getDb(env.DB)
    const roleId = crypto.randomUUID()
    await db.insert(roles).values({ id: roleId, name: 'Elections Committee' })
    await seedCommentMention(commentId, userId, { sourceType: 'role', sourceId: roleId })

    const body = await getNotifications(token)
    expect(body.notifications[0].sourceType).toBe('role')
    expect(body.notifications[0].sourceLabel).toBe('Elections Committee')
  })

  it('returns an @admins mention as one, with no source label', async () => {
    await seedCommentMention(commentId, userId, { sourceType: 'admins', sourceId: 'all' })

    const body = await getNotifications(token)
    expect(body.notifications).toHaveLength(1)
    expect(body.notifications[0].sourceType).toBe('admins')
    expect(body.notifications[0].sourceLabel).toBeNull()
  })

  it('hides notifications for deleted comments, from the list and the count', async () => {
    const deletedCommentId = await seedComment(billId, authorId)
    await seedCommentMention(commentId, userId)
    await seedCommentMention(deletedCommentId, userId)
    await getDb(env.DB).update(comments).set({ deletedAt: '2026-01-01 09:00:00' }).where(eq(comments.id, deletedCommentId))

    const body = await getNotifications(token)
    expect(body.notifications.map(n => n.commentId)).toEqual([commentId])
    expect(body.unreadCount).toBe(1)
  })

  it('skips a notification whose stored data is unreadable instead of failing the panel', async () => {
    const otherCommentId = await seedComment(billId, authorId)
    await seedCommentMention(commentId, userId)
    const corrupt = await seedCommentMention(otherCommentId, userId)
    await env.DB.prepare(`UPDATE notifications SET data = 'not json' WHERE id = ?`).bind(corrupt).run()

    const body = await getNotifications(token)
    expect(body.notifications.map(n => n.commentId)).toEqual([commentId])
  })

  it('also returns the mentions as `mentions` for web bundles from before the rename', async () => {
    await seedCommentMention(commentId, userId)
    // Another kind, which an old bundle would draw as a mention with no name.
    const other = await seedComment(billId, authorId, '<p>Another comment</p>')
    await env.DB.prepare(`INSERT INTO notifications (id, recipient_id, kind, bill_id, comment_id, actor_id) VALUES ('n-reply', ?, 'reply', ?, ?, ?)`)
      .bind(userId, billId, other, authorId).run()

    const body = await getNotifications(token) as Body & { mentions: Body['notifications'] }
    expect(body.mentions.map(n => n.commentId)).toEqual([commentId])
    expect(body.mentions).toEqual(body.notifications.filter(n => n.kind === 'mention'))
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
    await clearDb()
    userId = await seedUser({ email: 'jane@example.com' })
    token = await seedSession(userId)
    const authorId = await seedUser({ email: 'bob@example.com' })
    const billId = await seedBill()
    const c1 = await seedComment(billId, authorId)
    const c2 = await seedComment(billId, authorId)
    await seedCommentMention(c1, userId)
    await seedCommentMention(c2, userId)
  })

  it('marks all unread notifications as read', async () => {
    await post('/mark-read', token)

    const body = await getNotifications(token)
    expect(body.unreadCount).toBe(0)
    expect(body.notifications.every(m => !m.isUnread)).toBe(true)
  })

  it('does not mark other users\' notifications as read', async () => {
    const otherId = await seedUser({ email: 'other@example.com' })
    const otherToken = await seedSession(otherId)
    const authorId = await seedUser({ email: 'author2@example.com' })
    const billId = await seedBill()
    const c = await seedComment(billId, authorId)
    await seedCommentMention(c, otherId)

    await post('/mark-read', otherToken)

    const body = await getNotifications(token)
    expect(body.unreadCount).toBe(2)
  })
})

describe('POST /notifications/mark-read/:commentId (single)', () => {
  let userId: string
  let token: string
  let commentId1: string
  let commentId2: string

  beforeEach(async () => {
    await clearDb()
    userId = await seedUser({ email: 'jane@example.com' })
    token = await seedSession(userId)
    const authorId = await seedUser({ email: 'bob@example.com' })
    const billId = await seedBill()
    commentId1 = await seedComment(billId, authorId)
    commentId2 = await seedComment(billId, authorId)
    await seedCommentMention(commentId1, userId)
    await seedCommentMention(commentId2, userId)
  })

  it('marks only the specified comment\'s notification as read', async () => {
    await post(`/mark-read/${commentId1}`, token)

    expect(unreadCommentIds(await getNotifications(token))).toEqual([commentId2])
  })
})

describe('POST /notifications/mark-read-by-bill/:billId (bill page opened)', () => {
  let userId: string
  let token: string
  let authorId: string
  let billA: string
  let billB: string

  beforeEach(async () => {
    await clearDb()
    userId = await seedUser({ email: 'jane@example.com' })
    token = await seedSession(userId)
    authorId = await seedUser({ email: 'bob@example.com' })
    billA = await seedBill({ billNumber: 'HB 1' })
    billB = await seedBill({ billNumber: 'HB 2' })
  })

  it('marks the member\'s notifications on that bill read and leaves other bills unread', async () => {
    const onA1 = await seedComment(billA, authorId)
    const onA2 = await seedComment(billA, authorId)
    const onB = await seedComment(billB, authorId)
    for (const c of [onA1, onA2, onB]) await seedCommentMention(c, userId)

    await post(`/mark-read-by-bill/${billA}`, token)

    const body = await getNotifications(token)
    expect(unreadCommentIds(body)).toEqual([onB])
    expect(body.unreadCount).toBe(1)
  })

  it('leaves another member\'s notifications on the same bill unread', async () => {
    const otherId = await seedUser({ email: 'other@example.com' })
    const otherToken = await seedSession(otherId)
    const comment = await seedComment(billA, authorId)
    await seedCommentMention(comment, userId)
    await seedCommentMention(comment, otherId)

    await post(`/mark-read-by-bill/${billA}`, token)

    expect((await getNotifications(token)).unreadCount).toBe(0)
    expect((await getNotifications(otherToken)).unreadCount).toBe(1)
  })
})
