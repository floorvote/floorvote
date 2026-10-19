import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { env } from 'cloudflare:test'
import { app } from '../../src/index'
import { clearDb, seedUser, seedSession, seedBill, seedComment } from '../helpers'
import { getDb } from '../../src/db/client'
import { comments, notifications } from '../../src/db/schema'
import { writeNotifications } from '../../src/lib/notifications'

// Reacting to a comment notifies its author, in the app only. One stored row per
// (comment, reactor, emoji), and the panel gets one collapsed row per comment.
// Every case goes through the real HTTP routes.
describe('reacting to a comment notifies its author', () => {
  let send: ReturnType<typeof vi.fn>
  let billId: string
  let commentId: string
  const cookies = new Map<string, string>()
  const ids: Record<string, string> = {}

  async function request(path: string, method: string, as: string, body?: unknown) {
    return app.request(path, {
      method,
      headers: { Cookie: cookies.get(as)!, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, { ...env, EMAIL_PROVIDER: 'cloudflare', EMAIL: { send } })
  }

  const react = (as: string, emoji: string, onComment = commentId) =>
    request(`/api/comments/${onComment}/reactions`, 'POST', as, { emoji })
  const unreact = (as: string, emoji: string, onComment = commentId) =>
    request(`/api/comments/${onComment}/reactions/${encodeURIComponent(emoji)}`, 'DELETE', as)

  type Row = {
    id: string; kind: string; commentId: string; billId: string; isUnread: boolean
    reactors?: { id: string; name: string | null }[]; reactorCount?: number
  }
  async function inbox(as: string) {
    const res = await request('/api/notifications', 'GET', as)
    expect(res.status).toBe(200)
    return await res.json() as { unreadCount: number; notifications: Row[] }
  }
  const stored = (recipient: string) =>
    getDb(env.DB).select().from(notifications).where(eq(notifications.recipientId, ids[recipient])).all()

  async function member(name: string) {
    const id = await seedUser({ name, email: `${name.toLowerCase()}@example.com` })
    ids[name.toLowerCase()] = id
    cookies.set(name.toLowerCase(), `session=${await seedSession(id)}`)
    return id
  }

  beforeEach(async () => {
    await clearDb()
    send = vi.fn(async () => ({ messageId: 'm-1' }))
    cookies.clear()
    billId = await seedBill({ billNumber: 'HB 1' })
    await member('Ann'); await member('Ben'); await member('Cara')
    commentId = await seedComment(billId, ids.ann, '<p>Ann says</p>')
  })

  it('creates one reaction notification for the comment author', async () => {
    expect((await react('ben', '👍')).status).toBe(200)

    const rows = await stored('ann')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'reaction', billId, commentId, actorId: ids.ben, readAt: null })
    expect(JSON.parse(rows[0].data)).toEqual({ emoji: '👍' })
    expect(await stored('ben')).toHaveLength(0)
  })

  it('creates none when a member reacts to their own comment', async () => {
    await react('ann', '👍')
    expect(await stored('ann')).toHaveLength(0)
  })

  it('keeps the notification when the reaction is removed, and does not duplicate it when re-added', async () => {
    await react('ben', '👍')
    await unreact('ben', '👍')
    expect(await stored('ann')).toHaveLength(1)

    await react('ben', '👍')
    await react('ben', '👍')
    expect(await stored('ann')).toHaveLength(1)
  })

  it('writes a second notification for a different emoji from the same reactor', async () => {
    await react('ben', '👍')
    await react('ben', '🔥')
    expect(await stored('ann')).toHaveLength(2)
  })

  it('sends no email', async () => {
    await react('ben', '👍')
    await react('cara', '🔥')
    expect(send).not.toHaveBeenCalled()
  })

  it('collapses a comment\'s reaction notifications into one row that counts once toward the bell', async () => {
    await react('ben', '👍')
    await react('ben', '🔥')
    await react('cara', '👍')

    const { unreadCount, notifications: rows } = await inbox('ann')
    expect(rows).toHaveLength(1)
    expect(unreadCount).toBe(1)
    expect(rows[0]).toMatchObject({ kind: 'reaction', commentId, billId, isUnread: true, reactorCount: 2 })
    // Newest reactor first, each reactor once however many emoji they used.
    expect(rows[0].reactors!.map(r => r.name)).toEqual(['Cara', 'Ben'])
  })

  it('gives each reacted comment its own row', async () => {
    const other = await seedComment(billId, ids.ann, '<p>Ann again</p>')
    await react('ben', '👍')
    await react('ben', '👍', other)
    const { notifications: rows } = await inbox('ann')
    expect(rows.map(r => r.commentId).sort()).toEqual([commentId, other].sort())
  })

  it('is marked read when the panel is opened', async () => {
    await react('ben', '👍')
    await request('/api/notifications/mark-read', 'POST', 'ann')
    const { unreadCount, notifications: rows } = await inbox('ann')
    expect(unreadCount).toBe(0)
    expect(rows[0].isUnread).toBe(false)
  })

  it('is marked read when the bill is opened', async () => {
    await react('ben', '👍')
    await request(`/api/notifications/mark-read-by-bill/${billId}`, 'POST', 'ann')
    expect((await inbox('ann')).unreadCount).toBe(0)
  })

  it('shows the row unread again when someone reacts after it was read', async () => {
    await react('ben', '👍')
    await request('/api/notifications/mark-read', 'POST', 'ann')
    await react('cara', '👍')
    const { unreadCount, notifications: rows } = await inbox('ann')
    expect(unreadCount).toBe(1)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ isUnread: true, reactorCount: 2 })
  })

  it('keeps the row\'s id when another reaction arrives, so the panel can match it', async () => {
    await react('ben', '👍')
    const before = (await inbox('ann')).notifications[0].id
    await react('cara', '🔥')
    const { notifications: rows } = await inbox('ann')
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(before)
  })

  it('lists an older comment\'s unread reaction however many reactions a newer comment has', async () => {
    const older = await seedComment(billId, ids.ann, '<p>Ann earlier</p>')
    await react('ben', '👍', older)
    await getDb(env.DB).update(notifications).set({ createdAt: '2020-01-01 00:00:00' }).where(eq(notifications.commentId, older))

    // 63 reactors x 8 emoji on the newer comment: 504 stored rows.
    const emoji = ['👍', '❤️', '🔥', '🎉', '😂', '😮', '😢', '👀']
    const reactors = await Promise.all(Array.from({ length: 63 }, (_, i) => seedUser({ name: `R${i}`, email: `r${i}@example.com` })))
    await writeNotifications(getDb(env.DB), reactors.flatMap(actorId => emoji.map(e => ({
      recipientId: ids.ann, kind: 'reaction' as const, billId, commentId, actorId, data: { emoji: e },
    }))))
    expect(await stored('ann')).toHaveLength(505)

    const { unreadCount, notifications: rows } = await inbox('ann')
    expect(rows.map(r => r.commentId)).toEqual([commentId, older])
    expect(rows[0]).toMatchObject({ reactorCount: 63 })
    expect(rows[0].reactors).toHaveLength(2)
    expect(rows[1]).toMatchObject({ isUnread: true, reactorCount: 1, reactors: [{ id: ids.ben, name: 'Ben' }] })
    expect(unreadCount).toBe(2)
  })

  it('hides the row when the comment is deleted', async () => {
    await react('ben', '👍')
    await getDb(env.DB).update(comments).set({ deletedAt: new Date().toISOString() }).where(eq(comments.id, commentId))
    expect((await inbox('ann')).notifications).toHaveLength(0)
  })
})
