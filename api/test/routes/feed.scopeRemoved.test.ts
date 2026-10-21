import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { clearDb, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { feedEvents } from '../../src/db/schema'

// #922: the feed's "All analyzed bills" scope is gone. `scope` is a parameter
// nothing reads, so any value, `analyzed` included, reads as the one feed.

type FeedBody = { events: Array<{ id: string; type: string; billId: string | null }>; total: number; page: number; limit: number; latestEventAt: string | null }

const DAY = '2026-03-04'
const at = (time: string, day = DAY) => `${day} ${time}`

describe('GET /feed ignores scope', () => {
  let adminId: string
  let adminToken: string
  let memberToken: string

  beforeEach(async () => {
    await clearDb()
    adminId = await seedUser({ role: 'admin', name: 'Ada Admin', email: 'ada@example.com' })
    adminToken = await seedSession(adminId)
    memberToken = await seedSession(await seedUser({ name: 'Mia Member', email: 'mia@example.com' }))
  })

  const db = () => getDb(env.DB)
  const feed = async (qs = '', token = memberToken): Promise<FeedBody> => {
    const res = await SELF.fetch(`http://localhost/api/feed${qs}`, { headers: { Cookie: `session=${token}` } })
    expect(res.status).toBe(200)
    return await res.json() as FeedBody
  }
  let n = 0
  const event = async (billId: string | null, type: string, createdAt: string, metadata: unknown = {}, userId = 'system') => {
    const id = `e${++n}`
    await db().insert(feedEvents).values({ id, type: type as never, billId, userId, metadata: JSON.stringify(metadata), createdAt })
    return id
  }
  const moved = (billId: string, createdAt = at('09:00:00')) =>
    event(billId, 'bill_updated', createdAt, { changes: [{ changeType: 'action_added', oldValue: null, newValue: 'Referred to committee', detail: null }] })

  // One of everything the old analyzed scope listed differently from the default feed.
  const seedMixedFeed = async () => {
    const analyzed = (billNumber: string, extra: Parameters<typeof seedBill>[0] = {}) =>
      seedBill({ billNumber, title: `Act on ${billNumber}`, matchType: 'keyword', priority: null, relevanceScore: 6, ...extra })
    // Two bills with no priority that moved on one day: the daily row.
    await moved(await analyzed('HB 1'))
    await moved(await analyzed('HB 2'))
    await event(null, 'no_priority_updates', at('06:00:00'))
    // A bill matched on another day: the new-matches row, and the per-bill event the old scope listed instead.
    const matched = await analyzed('HB 3')
    await event(matched, 'bill_matched', at('08:00:00', '2026-03-03'))
    await event(null, 'new_matches', at('08:00:00', '2026-03-03'), { billIds: [matched] })
    // A team comment on a bill that is no keyword or manual match: the old scope hid it.
    const unmatched = await seedBill({ billNumber: 'HB 4', matchType: null, priority: null })
    await event(unmatched, 'comment_added', at('10:00:00', '2026-03-02'), { preview: 'hello' }, adminId)
    // A prioritized bill's update.
    await moved(await analyzed('HB 5', { priority: 'high' }), at('09:00:00', '2026-03-01'))
  }

  it('returns the default feed for ?scope=analyzed: the same events, in order, and the same total', async () => {
    await seedMixedFeed()
    const dflt = await feed()
    // The default feed holds the rows, the comment, and the prioritized bill's card.
    expect(dflt.events.map((e) => e.type).sort()).toEqual(['bill_updated', 'comment_added', 'new_matches', 'no_priority_updates'])
    expect(await feed('?scope=analyzed')).toEqual(dflt)
  })

  it('returns the default feed for ?scope=analyzed to an admin too', async () => {
    await seedMixedFeed()
    expect(await feed('?scope=analyzed', adminToken)).toEqual(await feed('', adminToken))
  })

  it.each(['analyzed', 'default', 'anything-else', ''])('reads ?scope=%s as no scope at all', async (scope) => {
    await seedMixedFeed()
    expect(await feed(`?scope=${scope}`)).toEqual(await feed())
  })

  it('pages the one feed the same whatever the scope', async () => {
    await seedMixedFeed()
    const whole = await feed()
    const first = await feed('?scope=analyzed&page=1&limit=2')
    const second = await feed('?scope=analyzed&page=2&limit=2')
    expect(await feed('?page=1&limit=2')).toEqual(first)
    expect(await feed('?page=2&limit=2')).toEqual(second)
    expect([...first.events, ...second.events].map((e) => e.id)).toEqual(whole.events.slice(0, 4).map((e) => e.id))
    expect(first.total).toBe(whole.total)
  })

  it('keeps the new-matches row, which the analyzed scope used to leave out', async () => {
    const a = await seedBill({ billNumber: 'HB 1', matchType: 'keyword', priority: null })
    await event(a, 'bill_matched', at('08:00:00'))
    const row = await event(null, 'new_matches', at('08:00:00'), { billIds: [a] })
    expect((await feed('?scope=analyzed')).events.map((e) => e.id)).toEqual([row])
  })

  it('shows a team comment on a bill that is no match, which the analyzed scope used to hide', async () => {
    const unmatched = await seedBill({ billNumber: 'HB 4', matchType: null, priority: null })
    const comment = await event(unmatched, 'comment_added', at('10:00:00'), { preview: 'hello' }, adminId)
    expect((await feed('?scope=analyzed')).events.map((e) => e.id)).toEqual([comment])
  })

  it('keeps the per-bill matched event out of an unprioritized bill\'s feed, as the default feed does', async () => {
    const a = await seedBill({ billNumber: 'HB 1', matchType: 'keyword', priority: null })
    await event(a, 'bill_matched', at('08:00:00'))
    expect((await feed('?scope=analyzed')).events).toEqual([])
  })

  it('still shows the matched event on a prioritized bill\'s card, the one place it renders', async () => {
    const a = await seedBill({ billNumber: 'HB 1', matchType: 'keyword', priority: 'high' })
    const matched = await event(a, 'bill_matched', at('08:00:00'))
    expect((await feed()).events.map((e) => e.id)).toEqual([matched])
  })
})
