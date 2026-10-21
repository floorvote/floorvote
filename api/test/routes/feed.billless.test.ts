import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { clearDb, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { feedEvents } from '../../src/db/schema'

type FeedBody = {
  events: Array<Record<string, unknown>>
  total: number
  latestEventAt: string | null
}

describe('GET /feed — bill-less events', () => {
  let adminId: string
  let adminToken: string
  let memberToken: string

  beforeEach(async () => {
    await clearDb()
    adminId = await seedUser({ role: 'admin', name: 'Ada Admin', email: 'ada@example.com' })
    adminToken = await seedSession(adminId)
    memberToken = await seedSession(await seedUser({ name: 'Mia Member', email: 'mia@example.com' }))
  })

  const get = async (token: string, qs = ''): Promise<FeedBody> => {
    const res = await SELF.fetch(`http://localhost/api/feed${qs}`, { headers: { Cookie: `session=${token}` } })
    expect(res.status).toBe(200)
    return await res.json() as FeedBody
  }

  const seedBillless = async (billIds: string[], createdAt = '2026-03-01 10:00:00') => {
    const id = crypto.randomUUID()
    await getDb(env.DB).insert(feedEvents).values({
      id, type: 'priority_set', billId: null, userId: adminId,
      metadata: JSON.stringify({ priority: 'high', count: billIds.length, billIds }), createdAt,
    })
    return id
  }

  it('returns a bill-less event with a null bill and the actor, and counts it in total', async () => {
    const a = await seedBill({ billNumber: 'HB 1' })
    const id = await seedBillless([a])

    const body = await get(memberToken)
    expect(body.total).toBe(1)
    const event = body.events.find((e) => e.id === id)
    expect(event).toBeDefined()
    expect(event!.billId).toBeNull()
    expect(event!.type).toBe('priority_set')
    expect(event!.userName).toBe('Ada Admin')
    expect(event!.metadata).toMatchObject({ priority: 'high', count: 1, billIds: [a] })
  })

  it('returns it alongside per-bill events, newest first', async () => {
    const a = await seedBill({ billNumber: 'HB 1' })
    await getDb(env.DB).insert(feedEvents).values({
      id: 'comment', type: 'comment_added', billId: a, userId: adminId,
      metadata: '{"preview":"hi"}', createdAt: '2026-03-01 09:00:00',
    })
    await seedBillless([a], '2026-03-01 10:00:00')

    const body = await get(memberToken)
    expect(body.events.map((e) => e.billId)).toEqual([null, a])
  })

  it('lights the nav dot for a bill-less event someone else wrote', async () => {
    await seedBillless([await seedBill()], '2026-03-01 10:00:00')
    expect((await get(memberToken)).latestEventAt).toBe('2026-03-01 10:00:00')
    // The author's own action never lights it.
    expect((await get(adminToken)).latestEventAt).toBeNull()
  })

  it('hides it once its author is deactivated, like any other event', async () => {
    await seedBillless([await seedBill()])
    await env.DB.prepare(`UPDATE users SET deactivated_at = datetime('now') WHERE id = ?`).bind(adminId).run()
    expect((await get(memberToken)).total).toBe(0)
  })

  // The bug this ticket exists for: the event used to be pinned to the first bill
  // of the batch, so deleting that bill removed the whole bulk event. Driven
  // through the routes, with drafts since those are the bills the API deletes.
  it('survives deleting a bill the bulk edit touched', async () => {
    const ids: string[] = []
    for (let i = 1; i <= 11; i++) ids.push(await seedBill({ billNumber: `D ${i}`, isDraft: true }))

    const bulk = await SELF.fetch('http://localhost/api/bills/bulk', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, priority: 'high' }),
    })
    expect(bulk.status).toBe(200)

    // Delete the bill the old code pinned the event to (the first in the batch).
    const first = (await get(memberToken)).events[0].metadata as { billIds: string[] }
    const del = await SELF.fetch(`http://localhost/api/bills/${first.billIds[0]}`, {
      method: 'DELETE', headers: { Cookie: `session=${adminToken}` },
    })
    expect(del.status).toBe(204)

    const body = await get(memberToken)
    expect(body.total).toBe(1)
    expect(body.events[0].billId).toBeNull()
    expect(body.events[0].type).toBe('priority_set')
  })
})

describe('GET /feed/events/:id/bills', () => {
  let adminId: string
  let memberToken: string

  beforeEach(async () => {
    await clearDb()
    adminId = await seedUser({ role: 'admin', name: 'Ada Admin' })
    memberToken = await seedSession(await seedUser({ name: 'Mia Member', email: 'mia@example.com' }))
  })

  const seedEvent = async (metadata: unknown, billId: string | null = null) => {
    const id = crypto.randomUUID()
    await getDb(env.DB).insert(feedEvents).values({
      id, type: 'priority_set', billId, userId: adminId, metadata: JSON.stringify(metadata),
    })
    return id
  }
  const lookup = (id: string, token = memberToken) =>
    SELF.fetch(`http://localhost/api/feed/events/${id}/bills`, { headers: { Cookie: `session=${token}` } })

  it('lists the affected bills in stored order, skipping ids whose bill no longer exists', async () => {
    const a = await seedBill({ billNumber: 'HB 1', title: 'First Act', state: 'RI', session: '2026 Regular Session' })
    const b = await seedBill({ billNumber: 'SB 2', title: 'Second Act', isDraft: true })
    const id = await seedEvent({ priority: 'high', count: 3, billIds: [b, 'deleted-bill', a] })

    const res = await lookup(id)
    expect(res.status).toBe(200)
    const body = await res.json() as { bills: Array<Record<string, unknown>> }
    expect(body.bills.map((x) => x.id)).toEqual([b, a])
    expect(body.bills[1]).toMatchObject({
      id: a, billNumber: 'HB 1', title: 'First Act', state: 'RI', sessionSlug: '2026', isDraft: false,
    })
    expect(body.bills[0].isDraft).toBe(true)
  })

  it('handles more ids than one query can bind', async () => {
    const ids: string[] = []
    for (let i = 0; i < 120; i++) ids.push(await seedBill({ billNumber: `HB ${i}` }))
    const id = await seedEvent({ count: ids.length, billIds: ids })
    const body = await (await lookup(id)).json() as { bills: unknown[] }
    expect(body.bills).toHaveLength(120)
  })

  it('returns an empty list for an event that names no bills', async () => {
    const id = await seedEvent({ priority: 'high' })
    expect(await (await lookup(id)).json()).toEqual({ bills: [] })
  })

  it('returns 404 for an unknown event and 401 without a session', async () => {
    expect((await lookup('nope')).status).toBe(404)
    const anon = await SELF.fetch('http://localhost/api/feed/events/x/bills')
    expect(anon.status).toBe(401)
  })
})

// A bulk priority edit is a bill-less event, but the bill detail page's "set by"
// line must still credit it to the bills it named.
describe('GET /bills/:id priorityMeta with a bulk priority edit', () => {
  it('credits the bulk edit to every bill it named, and only those', async () => {
    await clearDb()
    const adminId = await seedUser({ role: 'admin', name: 'Ada Admin', email: 'ada@example.com' })
    const adminToken = await seedSession(adminId)
    const otherId = await seedUser({ name: 'Old Setter', email: 'old@example.com' })

    const ids: string[] = []
    for (let i = 1; i <= 11; i++) ids.push(await seedBill({ billNumber: `HB ${i}` }))
    const outside = await seedBill({ billNumber: 'HB 99' })
    // An older per-bill edit on the last bill: the bulk edit is newer and must win.
    await getDb(env.DB).insert(feedEvents).values({
      id: crypto.randomUUID(), type: 'priority_set', billId: ids[10], userId: otherId,
      metadata: '{"priority":"low"}', createdAt: '2020-01-01 00:00:00',
    })
    await getDb(env.DB).insert(feedEvents).values({
      id: crypto.randomUUID(), type: 'priority_set', billId: outside, userId: otherId,
      metadata: '{"priority":"low"}', createdAt: '2020-01-01 00:00:00',
    })

    const bulk = await SELF.fetch('http://localhost/api/bills/bulk', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, priority: 'high' }),
    })
    expect(bulk.status).toBe(200)

    const meta = async (id: string) => {
      const res = await SELF.fetch(`http://localhost/api/bills/${id}`, { headers: { Cookie: `session=${adminToken}` } })
      expect(res.status).toBe(200)
      return (await res.json() as { priorityMeta: { setByName: string } | null }).priorityMeta
    }
    expect((await meta(ids[0]))?.setByName).toBe('Ada Admin')
    expect((await meta(ids[10]))?.setByName).toBe('Ada Admin')
    // A bill the bulk edit did not name keeps its own history.
    expect((await meta(outside))?.setByName).toBe('Old Setter')
  })
})
