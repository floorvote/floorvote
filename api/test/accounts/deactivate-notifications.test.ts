import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill, seedComment, seedCommentMention } from '../helpers'
import { getDb } from '../../src/db/client'
import { users } from '../../src/db/schema'
import { eq } from 'drizzle-orm'

describe('deactivated member mentions drop out of notifications', () => {
  let userId: string, token: string, authorId: string, billId: string, commentId: string

  beforeEach(async () => {
    await resetDb(); await applyMigrations()
    userId = await seedUser({ name: 'Jane', email: 'jane@example.com' })
    token = await seedSession(userId)
    authorId = await seedUser({ name: 'Bob', email: 'bob@example.com' })
    billId = await seedBill({ billNumber: 'HB 1', state: 'RI', session: '2026 Regular Session' })
    commentId = await seedComment(billId, authorId, '<p>Hey <span data-type="mention" data-id="user:jane">@Jane</span></p>')
    await seedCommentMention(commentId, userId, { sourceType: 'user', sourceId: userId })
  })

  it('mention is present and counted while the author is active', async () => {
    const res = await SELF.fetch('http://localhost/api/notifications', {
      headers: { Cookie: `session=${token}` },
    })
    const body = await res.json() as { unreadCount: number; mentions: unknown[] }
    expect(body.unreadCount).toBe(1)
    expect(body.mentions).toHaveLength(1)
  })

  it('mention drops out and unread count decrements once the author is deactivated', async () => {
    await getDb(env.DB).update(users).set({ deactivatedAt: new Date().toISOString() }).where(eq(users.id, authorId))

    const res = await SELF.fetch('http://localhost/api/notifications', {
      headers: { Cookie: `session=${token}` },
    })
    const body = await res.json() as { unreadCount: number; mentions: unknown[] }
    expect(body.unreadCount).toBe(0)
    expect(body.mentions).toHaveLength(0)
  })

  it('mention returns once the author is reactivated', async () => {
    const db = getDb(env.DB)
    await db.update(users).set({ deactivatedAt: new Date().toISOString() }).where(eq(users.id, authorId))
    await db.update(users).set({ deactivatedAt: null }).where(eq(users.id, authorId))

    const res = await SELF.fetch('http://localhost/api/notifications', {
      headers: { Cookie: `session=${token}` },
    })
    const body = await res.json() as { unreadCount: number; mentions: unknown[] }
    expect(body.unreadCount).toBe(1)
    expect(body.mentions).toHaveLength(1)
  })
})
