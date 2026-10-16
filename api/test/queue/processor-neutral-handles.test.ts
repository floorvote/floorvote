import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { and, eq } from 'drizzle-orm'
import { processCentralNotification, processQueue } from '../../src/queue/processor'
import { getDb } from '../../src/db/client'
import { bills, billIdenticalLinks, calendarEvents } from '../../src/db/schema'
import { buildVEvent } from '../../src/lib/ical'
import { hearingUid } from '../../src/lib/hearingUid'
import { resetDb, applyMigrations, seedBill } from '../helpers'

// Release 1 of the neutral handle rename (#305): a tenant accepts a bill handle
// in either form, a neutral one from a future central included, and applies it
// to the same bill. What it stores, and every calendar UID, stays legacy.

vi.mock('../../src/lib/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/llm')>()
  return {
    ...actual,
    processBill: vi.fn().mockResolvedValue({ summary: 'Test summary', tags: ['Elections'], relevanceScore: 7 }),
  }
})

// What central serves for bill `id`, whichever form the request named it by.
function centralBillJson(id: number, over: Record<string, unknown> = {}) {
  return {
    billId: `legiscan:${id}`,
    sessionId: 'ri:2026', sessionName: '2026 Regular Session', yearStart: 2026, yearEnd: 2026,
    state: 'RI', number: `H ${id}`, title: `Mail ballot processing ${id}`, abstract: null,
    status: 'Introduced', statusDate: '2026-06-01', updatedAt: '2026-06-02T00:00:00Z',
    stateUrl: null, textHash: null, textR2Key: null, textStatus: 'no_texts',
    texts: [], actions: [], sponsors: [], votes: [], relatedBills: [], ...over,
  }
}

const testEnv = { ...env, TENANT_ID: 'ri', CENTRAL_API_URL: 'https://central.test', CENTRAL_ADMIN_SECRET: 'x' }
const db = () => getDb(env.DB)

/** The ids central was asked for, in the form the tenant asked for them. */
let fetched: string[]
let related: Record<number, unknown[]>

function stubCentral() {
  fetched = []
  related = {}
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    const m = /\/bills\/([^/?]+)/.exec(String(url))
    fetched.push(decodeURIComponent(m![1]))
    const id = Number(/(\d+)$/.exec(decodeURIComponent(m![1]))![1])
    return Promise.resolve(new Response(JSON.stringify(centralBillJson(id, { relatedBills: related[id] ?? [] })), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  }))
}

const msg = (billId: string, extra: Record<string, unknown> = {}) =>
  ({ tenantId: 'ri', billId, forceMetadata: true, ...extra }) as any
const process = (m: unknown) => processCentralNotification(m as any, testEnv as any, db())
const allBills = () => db().select({ id: bills.id, externalId: bills.externalId, title: bills.title }).from(bills).all()

function calendarBlock(identityKey = '1|house cmte on elections') {
  const event = { identityKey, date: '2026-06-04', time: '14:00:00', location: 'Room 35', description: 'House Cmte on Elections', eventHash: 'h1' }
  return { events: [event], changes: [{ changeType: 'hearing_added', ...event }] }
}

describe('a tenant receiving a neutral bill handle', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    vi.clearAllMocks()
    stubCentral()
  })

  it('applies it to the bill it already holds under the legacy handle, with no duplicate row', async () => {
    const id = await seedBill({ billNumber: 'H 999', state: 'RI', session: '2026 Regular Session', externalId: 'legiscan:999', matchType: 'keyword', priority: 'high', aiProcessedAt: '2026-06-01T00:00:00Z' })
    await process(msg('bill:999'))
    const rows = await allBills()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id, externalId: 'legiscan:999', title: 'Mail ballot processing 999' })
  })

  it('stores a new bill under the legacy handle, and its legacy twin then updates that row', async () => {
    await process(msg('bill:500', { matchType: 'keyword' }))
    let rows = await allBills()
    expect(rows).toHaveLength(1)
    expect(rows[0].externalId).toBe('legiscan:500')
    await process(msg('legiscan:500', { matchType: 'keyword' }))
    rows = await allBills()
    expect(rows).toHaveLength(1)
    expect(rows[0].externalId).toBe('legiscan:500')
  })

  it('stores a stub-only neutral delivery under the legacy handle, and the legacy twin finds it', async () => {
    await process(msg('bill:501', { stubOnly: true, matchType: 'keyword' }))
    await process(msg('legiscan:501', { stubOnly: true, matchType: 'keyword' }))
    const rows = await allBills()
    expect(rows.map(r => r.externalId)).toEqual(['legiscan:501'])
  })

  it('reads the bill from central, which accepts either form of the handle', async () => {
    await process(msg('bill:502', { matchType: 'keyword' }))
    expect(fetched).toHaveLength(1)
    expect(fetched[0]).toMatch(/^(legiscan|bill):502$/)
  })

  it('records an identical companion under the legacy handle, never a neutral one', async () => {
    related[600] = [{ sastBillId: 601, kind: 'identical' }]
    await process(msg('bill:600', { matchType: 'keyword' }))
    const links = await db().select().from(billIdenticalLinks).all()
    expect(links.map(l => [l.externalId, l.companionExternalId])).toEqual([['legiscan:600', 'legiscan:601']])
  })

  it('does not duplicate a companion link when the legacy twin arrives next', async () => {
    related[600] = [{ sastBillId: 601, kind: 'identical' }]
    await process(msg('bill:600', { matchType: 'keyword' }))
    await process(msg('legiscan:600', { matchType: 'keyword' }))
    expect(await db().select().from(billIdenticalLinks).all()).toHaveLength(1)
  })

  it('leaves a legacy ocd-bill handle as it is', async () => {
    stubCentral()
    const id = await seedBill({ billNumber: 'H 7', state: 'RI', session: '2026 Regular Session', externalId: 'ocd-bill/abc', matchType: 'keyword', priority: 'high', aiProcessedAt: '2026-06-01T00:00:00Z' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(centralBillJson(7, { billId: 'ocd-bill/abc' })), { status: 200 })))
    await process(msg('ocd-bill/abc'))
    expect((await allBills()).map(r => [r.id, r.externalId])).toEqual([[id, 'ocd-bill/abc']])
  })
})

describe('a sync batch mixing legacy and neutral handles', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    vi.clearAllMocks()
    stubCentral()
  })

  const queueMessage = (body: unknown) => ({ body, attempts: 1, ack: vi.fn(), retry: vi.fn() })

  it('applies each message to its own bill, one row per bill', async () => {
    const batch = [
      queueMessage(msg('legiscan:700', { matchType: 'keyword' })),
      queueMessage(msg('bill:701', { matchType: 'keyword' })),
      queueMessage(msg('bill:700', { matchType: 'keyword' })),
      queueMessage(msg('legiscan:701', { matchType: 'keyword' })),
      queueMessage(msg('bill:702', { matchType: 'keyword' })),
    ]
    await processQueue(batch as any, testEnv as any, db())
    for (const m of batch) {
      expect(m.retry).not.toHaveBeenCalled()
      expect(m.ack).toHaveBeenCalledTimes(1)
    }
    const rows = await allBills()
    expect(rows.map(r => r.externalId).sort()).toEqual(['legiscan:700', 'legiscan:701', 'legiscan:702'])
  })

  it('gives the same result whichever form comes first', async () => {
    const run = async (order: string[]) => {
      await resetDb()
      await applyMigrations()
      await processQueue(order.map(h => queueMessage(msg(h, { matchType: 'keyword' }))) as any, testEnv as any, db())
      return (await allBills()).map(r => [r.externalId, r.title]).sort()
    }
    expect(await run(['legiscan:710', 'bill:710', 'bill:711'])).toEqual(await run(['bill:710', 'legiscan:710', 'legiscan:711']))
  })
})

describe('hearing UIDs stay legacy', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    vi.clearAllMocks()
    stubCentral()
  })

  it('builds a legacy UID from a neutral handle, byte for byte as from its legacy twin', () => {
    const legacy = hearingUid('legiscan:999', '1|house cmte on elections', 'ri')
    expect(legacy).toBe('hearing-legiscan-999-1-house-cmte-on-elections@ri')
    expect(hearingUid('bill:999', '1|house cmte on elections', 'ri')).toBe(legacy)
  })

  it('keeps a legacy ocd-bill handle\'s UID as it was', () => {
    expect(hearingUid('ocd-bill/abc', '1|x', 'ri')).toBe('hearing-ocd-bill-abc-1-x@ri')
  })

  it('writes the legacy UID when a neutral handle delivers the calendar entry', async () => {
    await seedBill({ billNumber: 'H 999', state: 'RI', session: '2026 Regular Session', externalId: 'legiscan:999', matchType: 'keyword', priority: 'high', aiProcessedAt: '2026-06-01T00:00:00Z' })
    await process(msg('bill:999', { calendar: calendarBlock() }))
    const rows = await db().select().from(calendarEvents).all()
    expect(rows.map(r => r.uid)).toEqual(['hearing-legiscan-999-1-house-cmte-on-elections@ri'])
  })

  it('leaves one entry, unchanged, when the same hearing arrives by both forms', async () => {
    const id = await seedBill({ billNumber: 'H 999', state: 'RI', session: '2026 Regular Session', externalId: 'legiscan:999', matchType: 'keyword', priority: 'high', aiProcessedAt: '2026-06-01T00:00:00Z' })
    await process(msg('legiscan:999', { calendar: calendarBlock() }))
    const first = await db().select().from(calendarEvents).all()
    await process(msg('bill:999', { calendar: calendarBlock() }))
    const second = await db().select().from(calendarEvents).all()
    expect(await allBills()).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(second[0].billId).toBe(id)
    expect(second[0].uid).toBe(first[0].uid)
    expect(second[0].sequence).toBe(first[0].sequence)
  })

  it('builds a byte-identical calendar entry whether the first delivery was legacy or neutral', async () => {
    const build = async (handle: string) => {
      await resetDb()
      await applyMigrations()
      const id = await seedBill({ billNumber: 'H 999', state: 'RI', session: '2026 Regular Session', externalId: 'legiscan:999', matchType: 'keyword', priority: 'high', aiProcessedAt: '2026-06-01T00:00:00Z' })
      await process(msg(handle, { calendar: calendarBlock() }))
      const [row] = await db().select().from(calendarEvents).where(and(eq(calendarEvents.billId, id))).all()
      const entry = { uid: row.uid, sequence: row.sequence, status: 'confirmed' as const, date: row.date, time: row.time, location: row.location, summary: 'H 999', description: null }
      return buildVEvent(entry, '2026-06-02T12:00:00Z')
    }
    const viaLegacy = await build('legiscan:999')
    expect(await build('bill:999')).toBe(viaLegacy)
    expect(await build('legiscan:999')).toBe(viaLegacy)
    expect(viaLegacy).toContain('UID:hearing-legiscan-999-1-house-cmte-on-elections@ri')
  })
})
