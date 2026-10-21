import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { eq, inArray } from 'drizzle-orm'
import { clearDb, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills, feedEvents } from '../../src/db/schema'

// Whether a feed event's bill is an untriaged new match (see **New match** in
// CONTEXT.md), so a bill's card can show the amber "New · Set priority" state
// the Bills list shows (#911). A companion group is triaged as one, so every
// event of a group carries the group's answer.

type Ev = { id: string; billId: string | null; billNumber: string; billNewMatch: boolean }
type FeedBody = { events: Ev[] }

describe('GET /feed: billNewMatch', () => {
  let cookie: string
  const db = () => getDb(env.DB)
  const NEW = '2026-03-01 09:00:00'

  async function feed(): Promise<FeedBody> {
    const res = await SELF.fetch('http://localhost/api/feed', { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    return await res.json() as FeedBody
  }
  const flagOf = (body: FeedBody, billNumber: string) => body.events.find(e => e.billNumber === billNumber)!.billNewMatch
  async function event(billId: string | null, createdAt = '2026-03-02 10:00:00', type = 'comment_added') {
    await db().insert(feedEvents).values({ id: crypto.randomUUID(), type: type as never, billId, userId: 'system', metadata: '{}', createdAt })
  }
  async function group(...ids: string[]) {
    await db().update(bills).set({ groupKey: [...ids].sort()[0] }).where(inArray(bills.id, ids))
  }

  beforeEach(async () => {
    await clearDb()
    cookie = `session=${await seedSession(await seedUser({ role: 'admin', name: 'Ada Admin', email: 'ada@example.com' }))}`
  })

  it('is true for a keyword match with no priority that has not been triaged', async () => {
    const id = await seedBill({ id: 'a', billNumber: 'H 1', matchType: 'keyword', newMatchAt: NEW })
    await event(id)
    expect(flagOf(await feed(), 'H 1')).toBe(true)
  })

  it.each([
    ['it has a priority', { priority: 'low' as const }],
    ['it was triaged', { triagedAt: '2026-03-01 12:00:00' }],
    ['it never was a new match', { newMatchAt: null }],
    ['it was added manually', { matchType: 'manual' as const }],
    ['it has no match type', { matchType: null }],
  ])('is false when %s', async (_why, over) => {
    const id = await seedBill({ id: 'a', billNumber: 'H 1', matchType: 'keyword', newMatchAt: NEW, ...over })
    await event(id)
    expect(flagOf(await feed(), 'H 1')).toBe(false)
  })

  it('is false for a bill-less event', async () => {
    await event(null, '2026-03-02 10:00:00', 'priority_set')
    const body = await (await SELF.fetch('http://localhost/api/feed', { headers: { Cookie: cookie } })).json() as FeedBody
    expect(body.events).toHaveLength(1)
    expect(body.events[0].billNewMatch).toBe(false)
  })

  it('is true on every event of a group that is untriaged and has no priority, even on a member that never matched', async () => {
    await seedBill({ id: 'a', billNumber: 'H 1', matchType: 'keyword', newMatchAt: NEW })
    await seedBill({ id: 'b', billNumber: 'S 2', matchType: null })
    await group('a', 'b')
    await event('a')
    await event('b')
    const body = await feed()
    expect(flagOf(body, 'H 1')).toBe(true)
    expect(flagOf(body, 'S 2')).toBe(true)
  })

  it('is false on a group once any member is triaged', async () => {
    await seedBill({ id: 'a', billNumber: 'H 1', matchType: 'keyword', newMatchAt: NEW })
    await seedBill({ id: 'b', billNumber: 'S 2', matchType: 'keyword', newMatchAt: NEW, triagedAt: '2026-03-01 12:00:00' })
    await group('a', 'b')
    await event('a')
    await event('b')
    const body = await feed()
    expect(flagOf(body, 'H 1')).toBe(false)
    expect(flagOf(body, 'S 2')).toBe(false)
  })

  it('is false on a group once any member has a priority', async () => {
    await seedBill({ id: 'a', billNumber: 'H 1', matchType: 'keyword', newMatchAt: NEW })
    await seedBill({ id: 'b', billNumber: 'S 2', matchType: 'keyword', newMatchAt: NEW, priority: 'high' })
    await group('a', 'b')
    await event('a')
    await event('b')
    const body = await feed()
    expect(flagOf(body, 'H 1')).toBe(false)
    expect(flagOf(body, 'S 2')).toBe(false)
  })

  it('is false on a group none of whose members is a keyword match', async () => {
    await seedBill({ id: 'a', billNumber: 'H 1', matchType: 'manual', newMatchAt: NEW })
    await seedBill({ id: 'b', billNumber: 'S 2', matchType: null })
    await group('a', 'b')
    await event('a')
    await event('b')
    const body = await feed()
    expect(flagOf(body, 'H 1')).toBe(false)
    expect(flagOf(body, 'S 2')).toBe(false)
  })

  it('does not let one group\'s state leak onto another group or an ungrouped bill', async () => {
    await seedBill({ id: 'a', billNumber: 'H 1', matchType: 'keyword', newMatchAt: NEW })
    await seedBill({ id: 'b', billNumber: 'S 2', matchType: 'keyword', newMatchAt: NEW })
    await seedBill({ id: 'c', billNumber: 'H 3', matchType: 'keyword', newMatchAt: NEW, triagedAt: '2026-03-01 12:00:00' })
    await seedBill({ id: 'd', billNumber: 'S 4', matchType: 'keyword', newMatchAt: NEW })
    await group('a', 'b')
    await group('c', 'd')
    await event('a')
    await event('d')
    const solo = await seedBill({ id: 'e', billNumber: 'H 5', matchType: 'keyword', newMatchAt: NEW })
    await event(solo)
    const body = await feed()
    expect(flagOf(body, 'H 1')).toBe(true)
    expect(flagOf(body, 'S 4')).toBe(false)
    expect(flagOf(body, 'H 5')).toBe(true)
  })

  it('goes false after the bill is triaged', async () => {
    const id = await seedBill({ id: 'a', billNumber: 'H 1', matchType: 'keyword', newMatchAt: NEW })
    await event(id)
    expect(flagOf(await feed(), 'H 1')).toBe(true)
    await db().update(bills).set({ triagedAt: '2026-03-03 08:00:00' }).where(eq(bills.id, id))
    expect(flagOf(await feed(), 'H 1')).toBe(false)
  })
})
