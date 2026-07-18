import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill, seedComment } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills, memberVotes, officialPositions, notes } from '../../src/db/schema'
import { eq } from 'drizzle-orm'

describe('DELETE /api/bills/:id guard', () => {
  let adminTok: string
  beforeEach(async () => {
    await resetDb(); await applyMigrations()
    adminTok = await seedSession(await seedUser({ role: 'admin', email: 'a@x.com' }))
  })

  it('403 on a non-draft (filed) bill', async () => {
    const filed = await seedBill({ isDraft: false, matchType: 'keyword', title: 'Filed' })
    const res = await SELF.fetch(`https://x/api/bills/${filed}`, { method: 'DELETE', headers: { Cookie: `session=${adminTok}` } })
    expect(res.status).toBe(403)
    expect(await getDb(env.DB).select().from(bills).where(eq(bills.id, filed)).get()).toBeDefined()
  })

  it('409 on a draft that has engagement (votes)', async () => {
    const draft = await seedBill({ isDraft: true, matchType: 'manual', title: 'Engaged draft (votes)' })
    const voter = await seedUser({ role: 'member', email: 'v@x.com' })
    await getDb(env.DB).insert(memberVotes).values({ id: crypto.randomUUID(), userId: voter, billId: draft, position: 'support' })
    const res = await SELF.fetch(`https://x/api/bills/${draft}`, { method: 'DELETE', headers: { Cookie: `session=${adminTok}` } })
    expect(res.status).toBe(409)
    expect(await getDb(env.DB).select().from(bills).where(eq(bills.id, draft)).get()).toBeDefined()
  })

  it('409 on a draft that has engagement (official position)', async () => {
    const draft = await seedBill({ isDraft: true, matchType: 'manual', title: 'Engaged draft (position)' })
    const setter = await seedUser({ role: 'admin', email: 'setter@x.com' })
    await getDb(env.DB).insert(officialPositions).values({ id: crypto.randomUUID(), billId: draft, position: 'support', setBy: setter })
    const res = await SELF.fetch(`https://x/api/bills/${draft}`, { method: 'DELETE', headers: { Cookie: `session=${adminTok}` } })
    expect(res.status).toBe(409)
    expect(await getDb(env.DB).select().from(bills).where(eq(bills.id, draft)).get()).toBeDefined()
  })

  it('409 on a draft that has engagement (non-deleted comment)', async () => {
    const draft = await seedBill({ isDraft: true, matchType: 'manual', title: 'Engaged draft (comment)' })
    const commenter = await seedUser({ role: 'member', email: 'c@x.com' })
    await seedComment(draft, commenter, '<p>hi</p>')
    const res = await SELF.fetch(`https://x/api/bills/${draft}`, { method: 'DELETE', headers: { Cookie: `session=${adminTok}` } })
    expect(res.status).toBe(409)
    expect(await getDb(env.DB).select().from(bills).where(eq(bills.id, draft)).get()).toBeDefined()
  })

  it('409 on a draft that has engagement (non-empty note)', async () => {
    const draft = await seedBill({ isDraft: true, matchType: 'manual', title: 'Engaged draft (note)' })
    const noter = await seedUser({ role: 'member', email: 'n@x.com' })
    await getDb(env.DB).insert(notes).values({ id: crypto.randomUUID(), billId: draft, userId: noter, content: 'keep an eye on this' })
    const res = await SELF.fetch(`https://x/api/bills/${draft}`, { method: 'DELETE', headers: { Cookie: `session=${adminTok}` } })
    expect(res.status).toBe(409)
    expect(await getDb(env.DB).select().from(bills).where(eq(bills.id, draft)).get()).toBeDefined()
  })

  it('204 on a clean draft', async () => {
    const draft = await seedBill({ isDraft: true, matchType: 'manual', title: 'Clean draft' })
    const res = await SELF.fetch(`https://x/api/bills/${draft}`, { method: 'DELETE', headers: { Cookie: `session=${adminTok}` } })
    expect(res.status).toBe(204)
    expect(await getDb(env.DB).select().from(bills).where(eq(bills.id, draft)).get()).toBeUndefined()
  })
})
