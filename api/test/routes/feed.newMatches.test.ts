import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { feedEvents } from '../../src/db/schema'

type FeedBody = {
  events: Array<Record<string, unknown>>
  total: number
  latestEventAt: string | null
}

// The new-matches summary row (#367): written by the queue processor, read here
// by everyone. The row is a bill-less event, so these cover what the feed does
// with it, not how it is written (api/test/queue/processor.test.ts).
describe('GET /feed — the new-matches row', () => {
  let adminToken: string
  let memberToken: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    adminToken = await seedSession(await seedUser({ role: 'admin', name: 'Ada Admin', email: 'ada@example.com' }))
    memberToken = await seedSession(await seedUser({ name: 'Mia Member', email: 'mia@example.com' }))
  })

  const get = async (path: string, token = memberToken) => {
    const res = await SELF.fetch(`http://localhost/api${path}`, { headers: { Cookie: `session=${token}` } })
    expect(res.status).toBe(200)
    return await res.json() as never
  }
  const feed = (token = memberToken, qs = '') => get(`/feed${qs}`, token) as Promise<FeedBody>

  const seedRow = async (billIds: string[], createdAt = '2026-03-01 10:00:00') => {
    const id = crypto.randomUUID()
    await getDb(env.DB).insert(feedEvents).values({
      id, type: 'new_matches', billId: null, userId: 'system', metadata: JSON.stringify({ billIds }), createdAt,
    })
    return id
  }

  it('shows a member the row in the default feed, naming its bills', async () => {
    const a = await seedBill({ billNumber: 'HB 1' })
    const b = await seedBill({ billNumber: 'HB 2' })
    const id = await seedRow([a, b])

    const body = await feed()
    expect(body.total).toBe(1)
    const event = body.events.find((e) => e.id === id)
    expect(event).toMatchObject({ type: 'new_matches', billId: null, metadata: { billIds: [a, b] } })
  })

  it('shows a new match on an unprioritized bill only through the row, not a card of its own', async () => {
    const a = await seedBill({ billNumber: 'HB 1', priority: null })
    await getDb(env.DB).insert(feedEvents).values({ id: 'passive', type: 'bill_matched', billId: a, userId: 'system' })
    const id = await seedRow([a])

    const body = await feed()
    expect(body.events.map((e) => e.id)).toEqual([id])
  })

  it('lights the nav dot for a member', async () => {
    await seedRow([await seedBill()], '2026-03-01 10:00:00')
    expect((await feed()).latestEventAt).toBe('2026-03-01 10:00:00')
  })

  it('keeps the row out of the analyzed scope, which already lists every match', async () => {
    const a = await seedBill({ billNumber: 'HB 1' })
    await getDb(env.DB).insert(feedEvents).values({ id: 'matched', type: 'bill_matched', billId: a, userId: 'system' })
    await seedRow([a])

    const body = await feed(adminToken, '?scope=analyzed')
    expect(body.events.map((e) => e.id)).toEqual(['matched'])
  })

  it('lists the row\'s bills for a member who expands it', async () => {
    const a = await seedBill({ billNumber: 'HB 1', title: 'First' })
    const b = await seedBill({ billNumber: 'HB 2', title: 'Second' })
    const id = await seedRow([a, b])

    const body = await get(`/feed/events/${id}/bills`) as { bills: Array<{ id: string; billNumber: string }> }
    expect(body.bills.map((x) => x.billNumber)).toEqual(['HB 1', 'HB 2'])
  })
})
