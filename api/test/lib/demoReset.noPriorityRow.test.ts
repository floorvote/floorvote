import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { clearDb, seedBill, seedSession } from '../helpers'
import { runDemoReset } from '../../src/lib/demoReset'
import { DEMO_SEEDS } from '../../src/lib/demoSeeds'
import { parseHandle } from '../../../shared/billHandle'

// #925: the demo's bills with no priority get legislative events (the seed's
// noPriorityEvents), and the reset writes the day's no-priority updates row for
// each UTC day they land on, as the queue processor does when a legislative event
// lands on an analyzed bill (api/src/lib/noPriorityRow.ts). These run a real reset
// over a tenant that holds those bills, then read what it wrote and what GET /feed
// makes of it. The seed's own shape (cadence, no priority, real actions) is checked
// in demoSeeds.lakeMichigan.test.ts.

const seed = DEMO_SEEDS['lake-michigan']
const seeded = seed.noPriorityEvents ?? []
const seededBills = [...new Set(seeded.map(e => e.externalId))]

type StoredEvent = { id: string; bill_id: string | null; day: string; created_at: string }
type RowRow = { id: string; bill_id: string | null; user_id: string; metadata: string; suppressed: number; day: string; created_at: string }

/** The tenant's analyzed bills with no priority, as the central delivers them. */
async function deliverBills(more: Parameters<typeof seedBill>[0] = {}) {
  for (const [i, ext] of seededBills.entries()) {
    await seedBill({
      id: `bill-${parseHandle(ext)}`, externalId: ext, billNumber: `NP${i + 1}`, title: `Bill with no priority ${i + 1}`,
      state: 'MI', priority: null, matchType: 'keyword', relevanceScore: 5, ...more,
    })
  }
}

const eventsOfSeededBills = async () =>
  (await env.DB.prepare(
    `SELECT id, bill_id, date(created_at) AS day, created_at FROM feed_events WHERE type = 'bill_updated' AND bill_id LIKE 'bill-%' ORDER BY created_at, id`,
  ).all<StoredEvent>()).results
const rows = async () =>
  (await env.DB.prepare(
    `SELECT id, bill_id, user_id, metadata, suppressed, date(created_at) AS day, created_at FROM feed_events WHERE type = 'no_priority_updates' ORDER BY created_at, id`,
  ).all<RowRow>()).results

/** The distinct bills a day's stored events are on, by UTC day. */
const billsByDay = (evs: StoredEvent[]) => {
  const out = new Map<string, Set<string>>()
  for (const e of evs) out.set(e.day, (out.get(e.day) ?? new Set()).add(e.bill_id!))
  return out
}

describe('a demo reset over bills with no priority', () => {
  beforeEach(async () => {
    await clearDb()
  })
  afterEach(() => { vi.useRealTimers() })

  it('has events to write, which is what the rest of this file stands on', () => {
    expect(seeded.length).toBeGreaterThan(0)
  })

  it('writes every seeded event on its bill', async () => {
    await deliverBills()
    await runDemoReset(env.DB, seed)
    expect(seeded.length).toBeGreaterThan(0)
    expect((await eventsOfSeededBills()).length).toBe(seeded.length)
  })

  it.each([
    ['now', null],
    ['midday', '2026-10-21T12:00:00.000Z'],
    ['just after midnight UTC', '2026-10-21T00:10:00.000Z'],
    ['just before midnight UTC', '2026-10-21T23:59:59.500Z'],
  ])('writes one no_priority_updates row for each UTC day the events land on, as the processor would (%s)', async (_, at) => {
    await deliverBills()
    if (at !== null) { vi.useFakeTimers(); vi.setSystemTime(new Date(at)) }
    await runDemoReset(env.DB, seed)
    vi.useRealTimers()

    const stored = await eventsOfSeededBills()
    const days = [...billsByDay(stored).keys()].sort()
    expect(days.length, 'days with events').toBeGreaterThan(0)
    const written = await rows()
    expect(written.map(r => r.day), 'one row per day').toEqual(days)
    for (const r of written) {
      // The processor's row: bill-less, system, empty metadata, not suppressed.
      expect(r.bill_id).toBeNull()
      expect(r.user_id).toBe('system')
      expect(r.metadata).toBe('{}')
      expect(r.suppressed).toBe(0)
      // It keeps the time of the day's first update.
      const first = stored.filter(e => e.day === r.day)[0].created_at
      expect(r.created_at, `row of ${r.day}`).toBe(first)
    }
  })

  it('writes the same rows again on a second reset', async () => {
    await deliverBills()
    await runDemoReset(env.DB, seed)
    const first = (await rows()).map(r => r.day)
    expect(first.length).toBeGreaterThan(0)
    await runDemoReset(env.DB, seed)
    expect((await rows()).map(r => r.day)).toEqual(first)
  })

  it('writes no row for a day when none of its bills is in the tenant', async () => {
    // A tenant that has not received these bills yet: the events no-op, and so must the row.
    expect(seeded.length).toBeGreaterThan(0)
    await runDemoReset(env.DB, seed)
    expect(await eventsOfSeededBills()).toEqual([])
    expect(await rows()).toEqual([])
  })

  it('writes no row for a bill with no match type in no companion group, which the processor treats as not analyzed', async () => {
    await deliverBills({ matchType: null })
    await runDemoReset(env.DB, seed)
    expect((await eventsOfSeededBills()).length).toBeGreaterThan(0)
    expect(await rows()).toEqual([])
  })

  it('writes the row for a bill with no match type in a companion group with a match, as the processor does (#945)', async () => {
    await deliverBills({ matchType: null })
    const [first] = seededBills
    await seedBill({ id: 'bill-companion', externalId: 'legiscan:999999', billNumber: 'SB 999', title: 'Companion', state: 'MI', priority: null, matchType: 'keyword', relevanceScore: 5 })
    const pulled = `bill-${parseHandle(first)}`
    const key = [pulled, 'bill-companion'].sort()[0]
    await env.DB.prepare(`UPDATE bills SET group_key = ? WHERE id IN (?, ?)`).bind(key, pulled, 'bill-companion').run()
    await runDemoReset(env.DB, seed)
    const stored = (await eventsOfSeededBills()).filter(e => e.bill_id === pulled)
    expect(stored.length).toBeGreaterThan(0)
    expect((await rows()).map(r => r.day)).toEqual([...billsByDay(stored).keys()].sort())
  })

  it("writes a row only for the days of the bills the tenant holds", async () => {
    // One bill delivered: only the days it has an event get a row.
    const [only] = seededBills
    await seedBill({ id: `bill-${parseHandle(only)}`, externalId: only, billNumber: 'NP1', title: 'Only', state: 'MI', priority: null, matchType: 'keyword', relevanceScore: 5 })
    await runDemoReset(env.DB, seed)
    const stored = await eventsOfSeededBills()
    expect(stored.length).toBeGreaterThan(0)
    expect(stored.every(e => e.bill_id === `bill-${parseHandle(only)}`)).toBe(true)
    expect((await rows()).map(r => r.day)).toEqual([...billsByDay(stored).keys()].sort())
  })

  it("shows each day's row on the demo's feed, counting that day's bills, with no card for any of them", async () => {
    await deliverBills()
    await runDemoReset(env.DB, seed)
    const token = await seedSession('demo-user')

    const feed: Array<{ id: string; type: string; billId: string | null; createdAt: string; metadata: { count?: number; firstBills?: Array<{ id: string }> } }> = []
    for (let page = 1; page < 20; page++) {
      const res = await SELF.fetch(`http://localhost/api/feed?limit=100&page=${page}`, { headers: { Cookie: `session=${token}` } })
      expect(res.status).toBe(200)
      const body = await res.json() as { events: typeof feed; total: number }
      feed.push(...body.events)
      if (feed.length >= body.total) break
    }

    const byDay = billsByDay(await eventsOfSeededBills())
    const dayOf = (createdAt: string) => createdAt.slice(0, 10) // both stored formats begin with the UTC date
    const shown = feed.filter(e => e.type === 'no_priority_updates')
    const cards = feed.filter(e => e.billId !== null && e.billId.startsWith('bill-'))
    // A day of two or more bills is one row naming them, and no card for any of them: the
    // team did nothing on these bills, so nothing makes one a card of its own.
    const multiDays = [...byDay].filter(([, b]) => b.size >= 2)
    expect(multiDays.length, 'days with two or more bills').toBeGreaterThan(byDay.size / 2)
    for (const [day, bills] of multiDays) {
      const row = shown.filter(r => dayOf(r.createdAt) === day)
      expect(row.length, `rows on ${day}`).toBe(1)
      expect(row[0].metadata.count, `bills in the row of ${day}`).toBe(bills.size)
      expect(row[0].metadata.firstBills!.length).toBe(2)
      expect(cards.filter(c => dayOf(c.createdAt) === day), `cards on ${day}`).toEqual([])
    }
    // A day of one bill shows it, as a row of one or as the bill's own full card (#921).
    const loneDays = [...byDay].filter(([, b]) => b.size === 1).map(([d]) => d)
    expect(loneDays.length, 'days with exactly one bill').toBeGreaterThanOrEqual(1)
    for (const day of loneDays) {
      const row = shown.filter(r => dayOf(r.createdAt) === day)
      const card = cards.filter(c => dayOf(c.createdAt) === day)
      expect(row.length + (card.length > 0 ? 1 : 0), `what shows on ${day}`).toBe(1)
      if (row.length > 0) expect(row[0].metadata.count).toBe(1)
    }
  })
})
