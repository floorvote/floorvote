import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { processCentralNotification } from '../../src/queue/processor'
import { getDb } from '../../src/db/client'
import { calendarEvents, feedEvents } from '../../src/db/schema'
import { clearDb, seedBill } from '../helpers'

// A hearing's calendar row and its feed event (with the day's no-priority row)
// are written in one batch. Apart, a feed write that failed after the row
// landed would lose the event for good: the queue redelivers the message, but
// the redelivery finds the row already current, and only a change of state is
// news. Together, the row lands only with its event, so the redelivery still
// sees the change and writes both, once.

vi.mock('../../src/lib/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/llm')>()
  return { ...actual, processBill: vi.fn().mockResolvedValue({ summary: 's', tags: [], relevanceScore: 7 }) }
})

const testEnv = { ...env, TENANT_ID: 'ri', CENTRAL_API_URL: 'https://central.test', CENTRAL_ADMIN_SECRET: 'x' }
const HANDLE = 'legiscan:1'
const centralBill = {
  billId: HANDLE, sessionId: 'ri:2026', sessionName: '2026 Regular Session', yearStart: 2026, yearEnd: 2026,
  state: 'RI', number: 'H 1', title: 'Ballot processing', abstract: null, status: 'Introduced', statusDate: '2026-06-01',
  updatedAt: '2026-06-02T00:00:00Z', stateUrl: null, textHash: null, textR2Key: null, textStatus: 'no_texts', texts: [], actions: [],
  sponsors: [], votes: [], relatedBills: [],
}
const committee = { identityKey: '1|cmte', date: '2026-07-01', time: '14:00:00', location: 'Room 35', description: 'Committee', eventHash: 'h1' }
const floor = { identityKey: '1|floor', date: '2026-07-08', time: '16:00:00', location: 'Chamber', description: 'Floor', eventHash: 'h2' }
const added = (...events: (typeof committee)[]) => ({
  events,
  changes: events.map(e => ({ changeType: 'hearing_added' as const, ...e })),
})

describe('processCentralNotification: a hearing\'s calendar row and its feed event are written together', () => {
  const db = () => getDb(env.DB)
  // The same message each time, as the queue redelivers it.
  const deliver = (calendar: unknown) =>
    processCentralNotification({ tenantId: 'ri', billId: HANDLE, forceMetadata: false, forceAI: false, matchType: 'keyword', calendar } as never, testEnv as never, db())
  const ofType = (type: string) => db().select().from(feedEvents).where(eq(feedEvents.type, type as never)).all()
  const rows = () => db().select().from(calendarEvents).all()

  // A failing feed write stands in for a transient D1 error, here or in any
  // write the batch holds.
  const failFeedWrites = (when: string) => env.DB.prepare(
    `CREATE TRIGGER fail_feed BEFORE INSERT ON feed_events WHEN ${when} BEGIN SELECT RAISE(ABORT, 'transient'); END`,
  ).run()
  const recover = () => env.DB.prepare('DROP TRIGGER IF EXISTS fail_feed').run()

  beforeEach(async () => {
    await clearDb()
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify(centralBill), { status: 200, headers: { 'Content-Type': 'application/json' } })),
    ))
    // Tracked and analyzed, so not new, and the redelivery takes the skip path:
    // the first try stores central's version before it reaches the calendar.
    await seedBill({ externalId: HANDLE, billNumber: 'H 1', matchType: 'keyword', aiProcessedAt: '2026-06-01T00:00:00Z', providerUpdatedAt: '2026-06-01T00:00:00Z', relevanceScore: 6 })
  })
  afterEach(recover)

  it('keeps no row when the hearing\'s event can\'t be written, and the redelivery writes the event exactly once', async () => {
    await failFeedWrites(`NEW.type = 'hearing_added'`)
    await expect(deliver(added(committee))).rejects.toThrow()
    expect(await rows()).toEqual([])
    expect(await ofType('hearing_added')).toEqual([])
    expect(await ofType('no_priority_updates')).toEqual([])

    await recover()
    await deliver(added(committee))
    expect((await rows()).map(r => [r.date, r.status, r.sequence])).toEqual([['2026-07-01', 'confirmed', 0]])
    expect(await ofType('hearing_added')).toHaveLength(1)
    expect(await ofType('no_priority_updates')).toHaveLength(1)

    // Once it has landed, another redelivery is no news.
    await deliver(added(committee))
    expect(await ofType('hearing_added')).toHaveLength(1)
    expect(await rows()).toHaveLength(1)
  })

  it('keeps a hearing that landed, and the redelivery announces only the one that didn\'t', async () => {
    await failFeedWrites(`NEW.type = 'hearing_added' AND NEW.metadata LIKE '%Floor%'`)
    await expect(deliver(added(committee, floor))).rejects.toThrow()
    expect((await rows()).map(r => r.description)).toEqual(['Committee'])
    expect((await ofType('hearing_added')).map(e => JSON.parse(e.metadata!).description)).toEqual(['Committee'])

    await recover()
    await deliver(added(committee, floor))
    expect((await rows()).map(r => r.description).sort()).toEqual(['Committee', 'Floor'])
    expect((await ofType('hearing_added')).map(e => JSON.parse(e.metadata!).description).sort()).toEqual(['Committee', 'Floor'])
  })

  it('keeps a hearing confirmed when its cancellation can\'t be announced, and the redelivery cancels and announces it once', async () => {
    await deliver(added(committee))
    const cancelled = { events: [], changes: [{ changeType: 'hearing_cancelled' as const, ...committee }] }
    // A newer version, so the cancellation's first try runs the full path.
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ ...centralBill, updatedAt: '2026-06-03T00:00:00Z' }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
    ))

    await failFeedWrites(`NEW.type = 'hearing_cancelled'`)
    await expect(deliver(cancelled)).rejects.toThrow()
    expect((await rows()).map(r => [r.status, r.sequence])).toEqual([['confirmed', 0]])

    await recover()
    await deliver(cancelled)
    await deliver(cancelled)
    expect((await rows()).map(r => [r.status, r.sequence])).toEqual([['cancelled', 1]])
    expect(await ofType('hearing_cancelled')).toHaveLength(1)
  })
})
