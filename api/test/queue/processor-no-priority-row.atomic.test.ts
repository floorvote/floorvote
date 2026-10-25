import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { processCentralNotification } from '../../src/queue/processor'
import { getDb } from '../../src/db/client'
import { associationConfig, feedEvents } from '../../src/db/schema'
import { processBill } from '../../src/lib/llm'
import { clearDb, seedBill } from '../helpers'

// A legislative update and the day's no-priority updates row are written
// together (#919 review): in one batch, at one time. Apart, an update at
// 23:59:59 could land on one day and its row on the next, and a failure between
// the two would keep the update and lose the row, which a retried message
// can't write again. Either way the update would show nowhere.

const clock = vi.hoisted(() => ({ now: null as string | null }))
vi.mock('../../src/lib/dbTime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/dbTime')>()
  return { ...actual, nowDb: () => clock.now ?? actual.nowDb() }
})
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
const changes = [{ changeType: 'action_added', oldValue: null, newValue: 'Referred to committee', detail: null, detectedAt: '2026-06-03T00:00:00Z' }]
const hearing = {
  events: [{ identityKey: '1|cmte', date: '2026-07-01', time: '14:00:00', location: 'Room 35', description: 'Committee', eventHash: 'h1' }],
  changes: [{ changeType: 'hearing_added' as const, identityKey: '1|cmte', date: '2026-07-01', time: '14:00:00', location: 'Room 35', description: 'Committee', eventHash: 'h1' }],
}

describe('processCentralNotification: an update and its day\'s row are written together', () => {
  const db = () => getDb(env.DB)
  const deliver = (extra: Record<string, unknown>) =>
    processCentralNotification({ tenantId: 'ri', billId: HANDLE, forceMetadata: false, forceAI: false, matchType: 'keyword', ...extra } as never, testEnv as never, db())
  const ofType = (type: string) => db().select().from(feedEvents).where(eq(feedEvents.type, type as never)).all()

  beforeEach(async () => {
    await clearDb()
    clock.now = null
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify(centralBill), { status: 200, headers: { 'Content-Type': 'application/json' } })),
    ))
    await seedBill({ externalId: HANDLE, billNumber: 'H 1', matchType: 'keyword', aiProcessedAt: '2026-06-01T00:00:00Z', providerUpdatedAt: '2026-06-01T00:00:00Z', relevanceScore: 6 })
  })
  afterEach(async () => {
    await env.DB.prepare('DROP TRIGGER IF EXISTS fail_row').run()
  })

  // The message's start is long before its writes: the AI call alone can take
  // minutes. A digest that runs in between stamps its window's end, and the next
  // digest reads only what was written after it. An update dated by the start
  // of the message would fall behind that mark and reach no digest (#919 review).
  it('dates an update and a hearing change, with their row, by when they are written, after a digest that ran mid-message', async () => {
    clock.now = '2026-03-04 10:00:00'
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => Promise.resolve(new Response(JSON.stringify(
      url.includes('/text')
        ? { type: 'html', content: '<p>Bill text</p>' }
        : { ...centralBill, textHash: 'hash-new', updatedAt: '2026-06-05T00:00:00Z', texts: [{ docId: 'd1', note: 'Introduced', date: '2026-06-01', links: [{ url: 'https://x/1.html', mediaType: 'text/html' }] }] },
    ), { status: 200, headers: { 'Content-Type': 'application/json' } }))))
    vi.mocked(processBill).mockImplementationOnce(async () => {
      // A digest runs while the model works, and its window ends here.
      await db().insert(associationConfig).values({ key: 'last_digest_at', value: '2026-03-04 10:02:00' })
      clock.now = '2026-03-04 10:05:00'
      return { summary: 's', tags: [], relevanceScore: 7 } as never
    })

    await deliver({ changes, calendar: hearing })

    expect(vi.mocked(processBill)).toHaveBeenCalled()
    const since = (await db().select().from(associationConfig).where(eq(associationConfig.key, 'last_digest_at')).get())!.value
    for (const type of ['bill_updated', 'hearing_added', 'no_priority_updates']) {
      const written = await ofType(type)
      expect(written, type).toHaveLength(1)
      expect(written[0].createdAt > since, `${type} at ${written[0].createdAt}, digest window ended ${since}`).toBe(true)
    }
    expect((await ofType('bill_updated'))[0].createdAt).toBe((await ofType('no_priority_updates'))[0].createdAt)
  })

  it('dates an update at 23:59:59 and its row by the same time, so they share a day', async () => {
    clock.now = '2026-03-04 23:59:59'
    await deliver({ changes })
    expect((await ofType('bill_updated')).map((e) => e.createdAt)).toEqual(['2026-03-04 23:59:59'])
    expect((await ofType('no_priority_updates')).map((e) => e.createdAt)).toEqual(['2026-03-04 23:59:59'])
  })

  it('dates a hearing change and its row by the same time', async () => {
    clock.now = '2026-03-04 23:59:59'
    await deliver({ calendar: hearing })
    expect((await ofType('hearing_added')).map((e) => e.createdAt)).toEqual(['2026-03-04 23:59:59'])
    expect((await ofType('no_priority_updates')).map((e) => e.createdAt)).toEqual(['2026-03-04 23:59:59'])
  })

  // A failing row insert stands in for the worker dying between the two writes.
  const failRowWrites = () => env.DB.prepare(
    `CREATE TRIGGER fail_row BEFORE INSERT ON feed_events WHEN NEW.type = 'no_priority_updates' BEGIN SELECT RAISE(ABORT, 'crash'); END`,
  ).run()

  // Neither, never one without the other. They are in the commit that stamps the
  // bill's version (#906), so a redelivery of the very same message writes both.
  it('keeps neither an update nor its row when the row can\'t be written, and writes both on redelivery', async () => {
    await failRowWrites()
    await expect(deliver({ changes })).rejects.toThrow()
    expect(await ofType('bill_updated')).toEqual([])
    expect(await ofType('no_priority_updates')).toEqual([])

    await env.DB.prepare('DROP TRIGGER fail_row').run()
    await deliver({ changes })
    expect(await ofType('bill_updated')).toHaveLength(1)
    expect(await ofType('no_priority_updates')).toHaveLength(1)
  })

  it('keeps neither a hearing change nor its row when the row can\'t be written', async () => {
    await failRowWrites()
    await expect(deliver({ calendar: hearing })).rejects.toThrow()
    expect(await ofType('hearing_added')).toEqual([])
  })
})
