import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { clearDb, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { eq, inArray } from 'drizzle-orm'
import { bills, feedEvents } from '../../src/db/schema'

// What GET /feed/events/:id/bills sends for a new-matches row or a bulk edit,
// beyond the bill's name and link: what the chip's hover card shows (the AI
// summary and the priority the bill wears), as the sidebar's card does (#923).
// The bills are the web's FeedListBill, so the shared expanded list draws them.

type ListedBill = { id: string; summary?: string | null; priority?: string | null; groupKey: string | null }

describe('GET /feed/events/:id/bills: what a chip\'s hover card needs', () => {
  let memberToken: string
  let adminId: string

  beforeEach(async () => {
    await clearDb()
    adminId = await seedUser({ role: 'admin', name: 'Ada Admin', email: 'ada@example.com' })
    memberToken = await seedSession(await seedUser({ name: 'Mia Member', email: 'mia@example.com' }))
  })

  const listed = async (id: string) => {
    const res = await SELF.fetch(`http://localhost/api/feed/events/${id}/bills`, { headers: { Cookie: `session=${memberToken}` } })
    expect(res.status).toBe(200)
    return (await res.json() as { bills: ListedBill[] }).bills
  }
  const seedMatches = async (billIds: string[]) => {
    const id = crypto.randomUUID()
    await getDb(env.DB).insert(feedEvents).values({
      id, type: 'new_matches', billId: null, userId: 'system', metadata: JSON.stringify({ billIds }), createdAt: '2026-03-01 10:00:00',
    })
    return id
  }
  const seedBulkEdit = async (billIds: string[]) => {
    const id = crypto.randomUUID()
    await getDb(env.DB).insert(feedEvents).values({
      id, type: 'priority_set', billId: null, userId: adminId,
      metadata: JSON.stringify({ priority: 'high', count: billIds.length, billIds }), createdAt: '2026-03-01 10:00:00',
    })
    return id
  }
  const group = async (...ids: string[]) => {
    await getDb(env.DB).update(bills).set({ groupKey: [...ids].sort()[0] }).where(inArray(bills.id, ids))
  }

  it('sends a bill\'s AI summary', async () => {
    const a = await seedBill({ billNumber: 'HB 1', tenantSummary: 'Moves the filing deadline.' })
    const [bill] = await listed(await seedMatches([a]))
    expect(bill.summary).toBe('Moves the filing deadline.')
  })

  it('sends a null summary for a bill with none', async () => {
    const a = await seedBill({ billNumber: 'HB 1' })
    const [bill] = await listed(await seedMatches([a]))
    expect(bill.summary).toBeNull()
  })

  it('sends null priority for a new match nobody has prioritized', async () => {
    const a = await seedBill({ billNumber: 'HB 1', priority: null })
    const [bill] = await listed(await seedMatches([a]))
    expect(bill.priority).toBeNull()
  })

  it('sends a bill\'s own priority, if it was prioritized after it matched', async () => {
    const a = await seedBill({ billNumber: 'HB 1', priority: 'medium' })
    const [bill] = await listed(await seedMatches([a]))
    expect(bill.priority).toBe('medium')
  })

  it('gives every member of a companion group the group\'s priority, whichever member holds it', async () => {
    const a = await seedBill({ billNumber: 'HB 1' })
    const b = await seedBill({ billNumber: 'SB 2' })
    const c = await seedBill({ billNumber: 'HB 3' })
    await group(a, b)
    await getDb(env.DB).update(bills).set({ priority: 'high', prioritySetAt: '2026-03-01 09:00:00' }).where(eq(bills.id, b))
    const got = await listed(await seedMatches([a, b, c]))
    expect(got.map((x) => [x.id, x.priority])).toEqual([[a, 'high'], [b, 'high'], [c, null]])
  })

  it('wears the group\'s most recently set priority when two members hold one', async () => {
    const a = await seedBill({ billNumber: 'HB 1' })
    const b = await seedBill({ billNumber: 'SB 2' })
    await group(a, b)
    await getDb(env.DB).update(bills).set({ priority: 'low', prioritySetAt: '2026-03-01 08:00:00' }).where(eq(bills.id, a))
    await getDb(env.DB).update(bills).set({ priority: 'high', prioritySetAt: '2026-03-01 09:00:00' }).where(eq(bills.id, b))
    const got = await listed(await seedMatches([a, b]))
    expect(got.map((x) => x.priority)).toEqual(['high', 'high'])
  })

  it('sends a summary and a priority for a bulk edit\'s bills too, since its list is the same list', async () => {
    const a = await seedBill({ billNumber: 'HB 1', tenantSummary: 'Moves the filing deadline.', priority: 'high' })
    const [bill] = await listed(await seedBulkEdit([a]))
    expect(bill.summary).toBe('Moves the filing deadline.')
    expect(bill.priority).toBe('high')
  })

  it('still skips a deleted bill and keeps the order and group keys it always sent', async () => {
    const a = await seedBill({ billNumber: 'HB 1', tenantSummary: 'One.' })
    const b = await seedBill({ billNumber: 'SB 2' })
    await group(a, b)
    const got = await listed(await seedMatches([b, 'gone-bill-id', a]))
    const key = [a, b].sort()[0]
    expect(got.map((x) => [x.id, x.groupKey])).toEqual([[b, key], [a, key]])
  })
})
