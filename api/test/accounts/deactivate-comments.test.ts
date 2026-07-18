import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill, seedComment } from '../helpers'
import { getDb } from '../../src/db/client'
import { users } from '../../src/db/schema'
import { eq } from 'drizzle-orm'

describe('deactivated members\' comments are hidden', () => {
  let adminTok: string, billId: string
  beforeEach(async () => {
    await resetDb(); await applyMigrations()
    adminTok = await seedSession(await seedUser({ role: 'admin', email: 'a@x.com' }))
    billId = await seedBill({ matchType: 'keyword', title: 'Comment bill' })
    const active = await seedUser({ role: 'member', email: 'active@x.com' })
    const gone = await seedUser({ role: 'member', email: 'gone@x.com', deactivatedAt: new Date().toISOString() })
    await seedComment(billId, active, '<p>active comment</p>')
    await seedComment(billId, gone, '<p>hidden comment</p>')
  })

  it('bill detail returns only the active member\'s comment and count=1', async () => {
    const res = await SELF.fetch(`https://x/api/bills/${billId}`, { headers: { Cookie: `session=${adminTok}` } })
    const body = await res.json<{ comments: Array<{ content: string }>; commentsTotal: number }>()
    expect(body.comments.map(c => c.content)).toEqual(['<p>active comment</p>'])
    expect(body.commentsTotal).toBe(1)
  })

  it('bill list card comment count excludes the deactivated author\'s comment', async () => {
    const res = await SELF.fetch(`https://x/api/bills?pageSize=50`, { headers: { Cookie: `session=${adminTok}` } })
    const body = await res.json<{ bills: Array<{ id: string; commentCount: number }> }>()
    const card = body.bills.find(b => b.id === billId)
    expect(card?.commentCount).toBe(1)
  })

  it('GET /bills/:id/comments (full thread) excludes the deactivated author\'s comment', async () => {
    const res = await SELF.fetch(`https://x/api/bills/${billId}/comments`, { headers: { Cookie: `session=${adminTok}` } })
    const body = await res.json<Array<{ content: string }>>()
    expect(body.map(c => c.content)).toEqual(['<p>active comment</p>'])
  })

  it('reactivating restores the comment everywhere', async () => {
    await getDb(env.DB).update(users).set({ deactivatedAt: null }).where(eq(users.email, 'gone@x.com'))

    const detailRes = await SELF.fetch(`https://x/api/bills/${billId}`, { headers: { Cookie: `session=${adminTok}` } })
    const detailBody = await detailRes.json<{ comments: Array<{ content: string }>; commentsTotal: number }>()
    expect(detailBody.commentsTotal).toBe(2)
    expect(detailBody.comments.map(c => c.content).sort()).toEqual(['<p>active comment</p>', '<p>hidden comment</p>'])

    const listRes = await SELF.fetch(`https://x/api/bills?pageSize=50`, { headers: { Cookie: `session=${adminTok}` } })
    const listBody = await listRes.json<{ bills: Array<{ id: string; commentCount: number }> }>()
    expect(listBody.bills.find(b => b.id === billId)?.commentCount).toBe(2)
  })
})
