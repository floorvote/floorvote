import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedSession, seedComment, seedRole } from '../helpers'

type NotificationRow = {
  id: string
  kind: string
  commentId: string
  billId: string
  authorName: string
  sourceType: string
  sourceLabel: string | null
  createdAt: string
  isUnread: boolean
}

// Seeds mentions the way they were stored before the notifications inbox
// (comment_mentions, with its own read_at), runs migration 0085, and checks that
// the API hands back the same notifications, read state and all.
describe('migration 0085_notifications', () => {
  let janeId: string
  let janeCookie: string
  let bobId: string
  let billId: string
  let roleId: string

  // seedUser writes every users column, including ones added after 0085, so a
  // member who predates this migration is inserted with the columns it had.
  async function seedUser({ name, email }: { name: string; email: string }) {
    const id = crypto.randomUUID()
    await env.DB.prepare(`INSERT INTO users (id, email, name) VALUES (?, ?, ?)`).bind(id, email, name).run()
    return id
  }

  // seedBill writes every bills column too, so the same goes for a bill.
  async function seedBill({ billNumber, state, session }: { billNumber: string; state: string; session: string }) {
    const id = crypto.randomUUID()
    await env.DB.prepare(`INSERT INTO bills (id, bill_number, title, state, session) VALUES (?, ?, ?, ?, ?)`)
      .bind(id, billNumber, 'Test Bill', state, session).run()
    return id
  }

  const oldMention = (id: string, commentId: string, userId: string, sourceType: string, sourceId: string, createdAt: string, readAt: string | null) =>
    env.DB.prepare(
      `INSERT INTO comment_mentions (id, comment_id, user_id, source_type, source_id, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, commentId, userId, sourceType, sourceId, createdAt, readAt).run()

  async function notifications(cookie = janeCookie) {
    const res = await SELF.fetch('http://localhost/api/notifications', { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    return await res.json() as { unreadCount: number; notifications: NotificationRow[] }
  }

  beforeEach(async () => {
    await resetDb()
    await applyMigrations({ before: '0085' })
    janeId = await seedUser({ name: 'Jane', email: 'jane@example.com' })
    janeCookie = `session=${await seedSession(janeId)}`
    bobId = await seedUser({ name: 'Bob', email: 'bob@example.com' })
    billId = await seedBill({ billNumber: 'HB 1', state: 'RI', session: '2026 Regular Session' })
    roleId = await seedRole('Elections Committee')
  })

  it('carries unread and read mentions over with their read state', async () => {
    const direct = await seedComment(billId, bobId, '<p>direct</p>')
    const viaRole = await seedComment(billId, bobId, '<p>role</p>')
    const viaEveryone = await seedComment(billId, bobId, '<p>everyone</p>')
    await oldMention('m-direct', direct, janeId, 'user', janeId, '2026-01-01 09:00:00', null)
    await oldMention('m-role', viaRole, janeId, 'role', roleId, '2026-01-02 09:00:00', '2026-01-02 10:00:00')
    await oldMention('m-everyone', viaEveryone, janeId, 'everyone', 'all', '2026-01-03 09:00:00', null)

    await applyMigrations()

    const body = await notifications()
    expect(body.unreadCount).toBe(2)
    expect(body.notifications.map(n => ({
      id: n.id, kind: n.kind, commentId: n.commentId, billId: n.billId, authorName: n.authorName,
      sourceType: n.sourceType, sourceLabel: n.sourceLabel, createdAt: n.createdAt, isUnread: n.isUnread,
    }))).toEqual([
      { id: 'm-everyone', kind: 'mention', commentId: viaEveryone, billId, authorName: 'Bob', sourceType: 'everyone', sourceLabel: null, createdAt: '2026-01-03 09:00:00', isUnread: true },
      { id: 'm-role', kind: 'mention', commentId: viaRole, billId, authorName: 'Bob', sourceType: 'role', sourceLabel: 'Elections Committee', createdAt: '2026-01-02 09:00:00', isUnread: false },
      { id: 'm-direct', kind: 'mention', commentId: direct, billId, authorName: 'Bob', sourceType: 'user', sourceLabel: null, createdAt: '2026-01-01 09:00:00', isUnread: true },
    ])
  })

  it('keeps a migrated mention on a deleted comment hidden', async () => {
    const kept = await seedComment(billId, bobId, '<p>kept</p>')
    const deleted = await seedComment(billId, bobId, '<p>deleted</p>')
    await env.DB.prepare(`UPDATE comments SET deleted_at = datetime('now') WHERE id = ?`).bind(deleted).run()
    await oldMention('m-kept', kept, janeId, 'user', janeId, '2026-01-01 09:00:00', null)
    await oldMention('m-deleted', deleted, janeId, 'user', janeId, '2026-01-02 09:00:00', null)

    await applyMigrations()

    const body = await notifications()
    expect(body.notifications.map(n => n.id)).toEqual(['m-kept'])
    expect(body.unreadCount).toBe(1)
  })

  // comments has had no foreign keys since 0025, so a comment can outlive its
  // bill or its author. The old GET inner-joined both, so these were never shown.
  it('skips mentions on comments whose bill or author no longer exists, with foreign keys enforced', async () => {
    const kept = await seedComment(billId, bobId, '<p>kept</p>')
    await env.DB.prepare(`INSERT INTO comments (id, bill_id, user_id, content) VALUES ('c-no-bill', 'missing-bill', ?, '<p>x</p>')`).bind(bobId).run()
    await env.DB.prepare(`INSERT INTO comments (id, bill_id, user_id, content) VALUES ('c-no-author', ?, 'missing-user', '<p>x</p>')`).bind(billId).run()
    await oldMention('m-kept', kept, janeId, 'user', janeId, '2026-01-01 09:00:00', null)
    await oldMention('m-no-bill', 'c-no-bill', janeId, 'user', janeId, '2026-01-02 09:00:00', null)
    await oldMention('m-no-author', 'c-no-author', janeId, 'user', janeId, '2026-01-03 09:00:00', null)
    const fk = await env.DB.prepare('PRAGMA foreign_keys').first<{ foreign_keys: number }>()
    expect(fk?.foreign_keys).toBe(1)

    await applyMigrations()

    const body = await notifications()
    expect(body.notifications.map(n => n.id)).toEqual(['m-kept'])
  })

  it('keeps each member\'s mentions their own', async () => {
    const comment = await seedComment(billId, bobId, '<p>both</p>')
    const caraId = await seedUser({ name: 'Cara', email: 'cara@example.com' })
    const caraCookie = `session=${await seedSession(caraId)}`
    await oldMention('m-jane', comment, janeId, 'user', janeId, '2026-01-01 09:00:00', '2026-01-01 10:00:00')
    await oldMention('m-cara', comment, caraId, 'user', caraId, '2026-01-01 09:00:00', null)

    await applyMigrations()

    const jane = await notifications()
    const cara = await notifications(caraCookie)
    expect(jane.notifications.map(n => [n.id, n.isUnread])).toEqual([['m-jane', false]])
    expect(cara.notifications.map(n => [n.id, n.isUnread])).toEqual([['m-cara', true]])
  })

  it('collapses duplicate mention records for one person on one comment', async () => {
    const comment = await seedComment(billId, bobId, '<p>twice</p>')
    await oldMention('m-first', comment, janeId, 'user', janeId, '2026-01-01 09:00:00', null)
    await oldMention('m-second', comment, janeId, 'user', janeId, '2026-01-01 09:00:01', null)

    await applyMigrations()

    const body = await notifications()
    expect(body.notifications.map(n => n.id)).toEqual(['m-first'])
    expect(body.unreadCount).toBe(1)
  })

  it('marks migrated mentions read when the panel opens', async () => {
    const comment = await seedComment(billId, bobId, '<p>direct</p>')
    await oldMention('m-direct', comment, janeId, 'user', janeId, '2026-01-01 09:00:00', null)
    await applyMigrations()

    const res = await SELF.fetch('http://localhost/api/notifications/mark-read', { method: 'POST', headers: { Cookie: janeCookie } })
    expect(res.status).toBe(200)

    const body = await notifications()
    expect(body.unreadCount).toBe(0)
    expect(body.notifications.map(n => n.isUnread)).toEqual([false])
  })
})
