import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { eq, inArray } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills, feedEvents } from '../../src/db/schema'
import { splitFromGroup } from '../../src/lib/companionGroups'

// A companion group is one policy in the feed (#381): every event on any member
// carries the group's key, so the feed rolls them into one card per group per
// day, and the team's priority is the group's, whichever member it was set on.
// What the cards look like is covered in web (GroupedBillCard.group.test.tsx);
// this is what the route serves.

type Ev = { id: string; billId: string | null; billNumber: string; billGroupKey: string | null; billPriority: string | null; type: string; createdAt: string }
type FeedBody = { events: Ev[]; total: number }

describe('GET /feed: companion groups', () => {
  let cookie: string
  let adminId: string
  const db = () => getDb(env.DB)

  async function feed(qs = ''): Promise<FeedBody> {
    const res = await SELF.fetch(`http://localhost/api/feed${qs}`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    return await res.json() as FeedBody
  }
  async function group(...ids: string[]) {
    await db().update(bills).set({ groupKey: [...ids].sort()[0] }).where(inArray(bills.id, ids))
  }
  async function event(billId: string, type: string, createdAt: string, metadata: unknown = {}) {
    const id = crypto.randomUUID()
    await db().insert(feedEvents).values({ id, type: type as never, billId, userId: 'system', metadata: JSON.stringify(metadata), createdAt })
    return id
  }
  const numbers = (body: FeedBody) => body.events.map(e => e.billNumber).sort()

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    adminId = await seedUser({ role: 'admin', name: 'Ada Admin', email: 'ada@example.com' })
    cookie = `session=${await seedSession(adminId)}`
    // Ids sort a < b < c, so a group's key is its first bill's id.
    await seedBill({ id: 'a-house', billNumber: 'H 101', state: 'RI', session: '2026', matchType: 'keyword' })
    await seedBill({ id: 'b-senate', billNumber: 'S 202', state: 'RI', session: '2026', matchType: 'keyword' })
    await seedBill({ id: 'c-alone', billNumber: 'H 303', state: 'RI', session: '2026', matchType: 'keyword' })
  })

  it('tags each event on a group member with the group key, and leaves an ungrouped bill null', async () => {
    await group('a-house', 'b-senate')
    await event('a-house', 'comment_added', '2026-03-02 10:00:00', { preview: 'one' })
    await event('b-senate', 'comment_added', '2026-03-02 11:00:00', { preview: 'two' })
    await event('c-alone', 'comment_added', '2026-03-02 12:00:00', { preview: 'three' })

    const body = await feed()
    const keyOf = (n: string) => body.events.find(e => e.billNumber === n)!.billGroupKey
    expect(keyOf('H 101')).toBe('a-house')
    expect(keyOf('S 202')).toBe('a-house')
    expect(keyOf('H 303')).toBeNull()
  })

  it('shows every event on a prioritized group under the group\'s priority, whichever member holds it', async () => {
    await group('a-house', 'b-senate')
    await db().update(bills).set({ priority: 'high', prioritySetAt: '2026-03-01 09:00:00' }).where(eq(bills.id, 'a-house'))
    // Passive provider events on the member with no priority of its own. An ungrouped bill with no priority hides them.
    await event('b-senate', 'bill_updated', '2026-03-02 10:00:00', { changes: [{ changeType: 'status_change', oldValue: 'a', newValue: 'b' }] })
    await event('c-alone', 'bill_updated', '2026-03-02 10:30:00', { changes: [{ changeType: 'status_change', oldValue: 'a', newValue: 'b' }] })

    const body = await feed()
    expect(numbers(body)).toEqual(['S 202'])
    expect(body.events[0].billPriority).toBe('high')
  })

  it('reads the group\'s priority from the member it was set on most recently', async () => {
    await group('a-house', 'b-senate')
    await db().update(bills).set({ priority: 'low', prioritySetAt: '2026-03-01 09:00:00' }).where(eq(bills.id, 'a-house'))
    await db().update(bills).set({ priority: 'high', prioritySetAt: '2026-03-01 10:00:00' }).where(eq(bills.id, 'b-senate'))
    await event('a-house', 'comment_added', '2026-03-02 10:00:00')
    await event('b-senate', 'comment_added', '2026-03-02 11:00:00')

    const body = await feed()
    expect(body.events.map(e => [e.billNumber, e.billPriority]).sort()).toEqual([['H 101', 'high'], ['S 202', 'high']])
  })

  it('keeps a passive event when a companion has an engagement event the same day, and drops it on another day', async () => {
    await group('a-house', 'b-senate')
    const passive = { changes: [{ changeType: 'action_added', newValue: 'Referred' }] }
    const sameDay = await event('a-house', 'bill_updated', '2026-03-02 08:00:00', passive)
    await event('b-senate', 'comment_added', '2026-03-02 15:00:00', { preview: 'on the companion' })
    const otherDay = await event('a-house', 'bill_updated', '2026-03-05 08:00:00', passive)

    const ids = (await feed()).events.map(e => e.id)
    expect(ids).toContain(sameDay)
    expect(ids).not.toContain(otherDay)
  })

  it('leaves an ungrouped bill as it was: its own priority, no key, passive events hidden without one', async () => {
    await db().update(bills).set({ priority: 'medium', prioritySetAt: '2026-03-01 09:00:00' }).where(eq(bills.id, 'c-alone'))
    await event('c-alone', 'bill_updated', '2026-03-02 10:00:00', { changes: [] })
    await event('a-house', 'bill_updated', '2026-03-02 10:00:00', { changes: [] })

    const body = await feed()
    expect(body.events).toHaveLength(1)
    expect(body.events[0]).toMatchObject({ billNumber: 'H 303', billGroupKey: null, billPriority: 'medium' })
  })

  it('serves a draft member\'s events with its own number and the group\'s key', async () => {
    await db().update(bills).set({ isDraft: true, title: '', matchType: 'manual' }).where(eq(bills.id, 'b-senate'))
    await group('a-house', 'b-senate')
    await event('b-senate', 'comment_added', '2026-03-02 10:00:00', { preview: 'on the draft' })

    const body = await feed()
    expect(body.events[0]).toMatchObject({ billNumber: 'S 202', billGroupKey: 'a-house', billIsDraft: true })
  })

  it('stops rolling events up once the group is split, and again once it is grouped by hand', async () => {
    await group('a-house', 'b-senate')
    await event('a-house', 'comment_added', '2026-03-02 10:00:00')
    await event('b-senate', 'comment_added', '2026-03-02 11:00:00')
    expect(new Set((await feed()).events.map(e => e.billGroupKey))).toEqual(new Set(['a-house']))

    expect(await splitFromGroup(db(), 'b-senate', adminId)).toBe(true)
    const afterSplit = await feed()
    expect(afterSplit.events.map(e => e.billGroupKey)).toEqual([null, null])
  })

  it('counts an event once whatever the group size', async () => {
    await group('a-house', 'b-senate', 'c-alone')
    await event('a-house', 'comment_added', '2026-03-02 10:00:00')
    await event('b-senate', 'comment_added', '2026-03-02 11:00:00')
    await event('c-alone', 'comment_added', '2026-03-02 12:00:00')
    expect((await feed()).total).toBe(3)
  })
})
