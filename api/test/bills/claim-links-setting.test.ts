import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { eq, inArray } from 'drizzle-orm'
import { clearDb, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, bills } from '../../src/db/schema'
import { centralFetch } from '../../src/lib/centralFetch'

vi.mock('../../src/lib/centralFetch', () => ({ centralFetch: vi.fn() }))

// The bill detail response carries the claim links setting (#570), so the bill
// page knows whether to render stored claim links (#571, #572). Rendering is
// theirs. Here: the flag, and that flipping it never touches what is stored.

describe('GET /api/bills/:id: claimLinksEnabled', () => {
  let cookie: string
  const db = () => getDb(env.DB)

  beforeEach(async () => {
    await clearDb()
    cookie = `session=${await seedSession(await seedUser({ email: 'member@example.com', role: 'member' }))}`
    vi.mocked(centralFetch).mockReset()
    vi.mocked(centralFetch).mockResolvedValue(new Response('{}', { status: 200 }))
  })

  async function detail(billId: string) {
    const res = await SELF.fetch(`https://x/api/bills/${billId}`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    return await res.json() as { claimLinksEnabled: boolean; tenantSummary: string | null }
  }
  const setting = (value: unknown) => db().insert(associationConfig)
    .values({ key: 'claim_links_enabled', value: JSON.stringify(value) })
    .onConflictDoUpdate({ target: associationConfig.key, set: { value: JSON.stringify(value) } })

  it('is true on an instance with no setting stored', async () => {
    await seedBill({ id: 'b1', billNumber: 'HB 1', externalId: 'legiscan:1', tenantSummary: 'A summary.' })
    expect((await detail('b1')).claimLinksEnabled).toBe(true)
  })

  it('is false once an admin has turned claim links off, and true again after they turn them on', async () => {
    await seedBill({ id: 'b1', billNumber: 'HB 1', externalId: 'legiscan:1', tenantSummary: 'A summary.' })
    await setting(false)
    expect((await detail('b1')).claimLinksEnabled).toBe(false)
    await setting(true)
    expect((await detail('b1')).claimLinksEnabled).toBe(true)
  })

  it('is the same for every bill, including a draft and a bill with no analysis', async () => {
    await seedBill({ id: 'plain', billNumber: 'HB 2', externalId: 'legiscan:2' })
    await seedBill({ id: 'draft', billNumber: 'DRAFT-1', isDraft: true, draftText: '<p>Draft.</p>' })
    await setting(false)
    expect((await detail('plain')).claimLinksEnabled).toBe(false)
    expect((await detail('draft')).claimLinksEnabled).toBe(false)
  })

  it('is the same on a companion\'s page, whose shown analysis is another bill\'s', async () => {
    await seedBill({ id: 'a', billNumber: 'HB 3', externalId: 'legiscan:3', tenantSummary: 'Own.', matchType: 'keyword' })
    await seedBill({ id: 'b', billNumber: 'SB 3', externalId: 'legiscan:4', tenantSummary: 'Borrowed.', aiProcessedAt: '2026-09-01 00:00:00', matchType: 'keyword' })
    await db().update(bills).set({ groupKey: 'a' }).where(inArray(bills.id, ['a', 'b']))
    await setting(false)
    expect((await detail('a')).claimLinksEnabled).toBe(false)
    expect((await detail('b')).claimLinksEnabled).toBe(false)
  })

  it('leaves a bill\'s stored claim sources and its summary as they were across off and on', async () => {
    await seedBill({ id: 'b1', billNumber: 'HB 1', externalId: 'legiscan:1', tenantSummary: 'A summary.' })
    const stored = JSON.stringify([{ claim: 'A summary.', quote: 'Section 1.', status: 'exact', claimAt: { start: 0, end: 10 }, quoteAt: { start: 0, end: 10 }, matched: 'Section 1.' }])
    await db().update(bills).set({ claimSources: stored, claimSourcesDocId: '7001', claimSourcesTextHash: 'h7001' }).where(eq(bills.id, 'b1'))
    for (const value of [false, true]) {
      await setting(value)
      expect((await detail('b1')).tenantSummary).toBe('A summary.')
      const r = await db().select().from(bills).where(eq(bills.id, 'b1')).get()
      expect(r).toMatchObject({ claimSources: stored, claimSourcesDocId: '7001', claimSourcesTextHash: 'h7001' })
    }
  })
})
