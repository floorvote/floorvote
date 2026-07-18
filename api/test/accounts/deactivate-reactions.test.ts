import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill, seedComment } from '../helpers'
import { getDb } from '../../src/db/client'
import { users, commentReactions } from '../../src/db/schema'
import { eq } from 'drizzle-orm'

describe('deactivated members\' comment reactions are hidden', () => {
  let adminTok: string, billId: string, commentId: string, active: string, gone: string

  beforeEach(async () => {
    await resetDb(); await applyMigrations()
    adminTok = await seedSession(await seedUser({ role: 'admin', email: 'a@x.com' }))
    billId = await seedBill({ matchType: 'keyword', title: 'Reaction bill' })
    active = await seedUser({ role: 'member', email: 'active@x.com' })
    gone = await seedUser({ role: 'member', email: 'gone@x.com', deactivatedAt: new Date().toISOString() })
    commentId = await seedComment(billId, active, '<p>active comment</p>')

    await getDb(env.DB).insert(commentReactions).values([
      { id: crypto.randomUUID(), commentId, userId: active, emoji: '👍' },
      { id: crypto.randomUUID(), commentId, userId: gone, emoji: '👍' },
    ])
  })

  it('bill detail reaction count reflects only the active reactor', async () => {
    const res = await SELF.fetch(`https://x/api/bills/${billId}`, { headers: { Cookie: `session=${adminTok}` } })
    const body = await res.json<{ comments: Array<{ id: string; reactions: Array<{ emoji: string; count: number; reactors: { name: string; subtitle: string | null }[] }> }> }>()
    const comment = body.comments.find(c => c.id === commentId)
    expect(comment?.reactions).toEqual([{ emoji: '👍', count: 1, userReacted: false, reactors: [{ name: 'Test User', subtitle: null }] }])
  })

  it('GET /bills/:id/comments reaction count reflects only the active reactor', async () => {
    const res = await SELF.fetch(`https://x/api/bills/${billId}/comments`, { headers: { Cookie: `session=${adminTok}` } })
    const body = await res.json<Array<{ id: string; reactions: Array<{ emoji: string; count: number; reactors: { name: string; subtitle: string | null }[] }> }>>()
    const comment = body.find(c => c.id === commentId)
    expect(comment?.reactions).toEqual([{ emoji: '👍', count: 1, userReacted: false, reactors: [{ name: 'Test User', subtitle: null }] }])
  })

  it('reactivating restores the reaction everywhere', async () => {
    await getDb(env.DB).update(users).set({ deactivatedAt: null }).where(eq(users.email, 'gone@x.com'))

    const detailRes = await SELF.fetch(`https://x/api/bills/${billId}`, { headers: { Cookie: `session=${adminTok}` } })
    const detailBody = await detailRes.json<{ comments: Array<{ id: string; reactions: Array<{ emoji: string; count: number }> }> }>()
    const detailComment = detailBody.comments.find(c => c.id === commentId)
    expect(detailComment?.reactions.map(r => ({ emoji: r.emoji, count: r.count }))).toEqual([{ emoji: '👍', count: 2 }])

    const listRes = await SELF.fetch(`https://x/api/bills/${billId}/comments`, { headers: { Cookie: `session=${adminTok}` } })
    const listBody = await listRes.json<Array<{ id: string; reactions: Array<{ emoji: string; count: number }> }>>()
    const listComment = listBody.find(c => c.id === commentId)
    expect(listComment?.reactions.map(r => ({ emoji: r.emoji, count: r.count }))).toEqual([{ emoji: '👍', count: 2 }])
  })
})
