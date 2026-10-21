import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { and, eq } from 'drizzle-orm'
import { processCentralNotification, processQueue } from '../../src/queue/processor'
import { getDb } from '../../src/db/client'
import { bills, billIdenticalLinks, calendarEvents } from '../../src/db/schema'
import { buildVEvent } from '../../src/lib/ical'
import { hearingUid } from '../../src/lib/hearingUid'
import { clearDb, seedBill } from '../helpers'
import { processBill } from '../../src/lib/llm'

// The neutral handle rename (#305): a tenant accepts a bill handle in either
// form and applies it to the same bill. Release 2 stores the neutral form for a
// bill it doesn't hold yet, and keeps a bill it holds under the spelling it is
// stored by. Every calendar UID stays legacy.

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

/** The ids central was asked for, in the form the tenant asked for them: bill reads, and text reads. */
let fetched: string[]
let textFetched: string[]
let related: Record<number, unknown[]>
let withText = false

function stubCentral() {
  fetched = []
  textFetched = []
  related = {}
  withText = false
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    const m = /\/bills\/([^/?]+)(\/text)?/.exec(String(url))
    const asked = decodeURIComponent(m![1])
    if (m![2]) {
      textFetched.push(asked)
      return Promise.resolve(new Response(JSON.stringify({ type: 'html', content: '<p>text</p>' }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    }
    fetched.push(asked)
    const id = Number(/(\d+)$/.exec(asked)![1])
    const extra = withText ? { textHash: 'text-hash-1', textR2Key: `bills/legiscan-${id}/v1.html`, texts: [{ docId: '1', note: 'Introduced', date: '2026-06-01', links: [] }] } : {}
    return Promise.resolve(new Response(JSON.stringify(centralBillJson(id, { relatedBills: related[id] ?? [], ...extra })), { status: 200, headers: { 'Content-Type': 'application/json' } }))
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
    await clearDb()
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

  it('stores a new bill under the neutral handle, and its legacy twin then updates that row', async () => {
    await process(msg('bill:500', { matchType: 'keyword' }))
    let rows = await allBills()
    expect(rows).toHaveLength(1)
    expect(rows[0].externalId).toBe('bill:500')
    await process(msg('legiscan:500', { matchType: 'keyword' }))
    rows = await allBills()
    expect(rows).toHaveLength(1)
    expect(rows[0].externalId).toBe('bill:500')
  })

  it('stores a stub-only neutral delivery under the neutral handle, and the legacy twin finds it', async () => {
    await process(msg('bill:501', { stubOnly: true, matchType: 'keyword' }))
    await process(msg('legiscan:501', { stubOnly: true, matchType: 'keyword' }))
    const rows = await allBills()
    expect(rows.map(r => r.externalId)).toEqual(['bill:501'])
  })

  // A central that predates release 1 reads `bill:502` as NaN and answers 400, so a tenant
  // always asks central by the legacy handle, however the message named the bill.
  it('reads the bill from central by its legacy handle', async () => {
    await process(msg('bill:502', { matchType: 'keyword' }))
    expect(fetched).toEqual(['legiscan:502'])
  })

  it('reads the bill\'s text from central by its legacy handle', async () => {
    withText = true
    await process(msg('bill:503', { matchType: 'keyword', forceAI: true }))
    expect(fetched).toEqual(['legiscan:503'])
    expect(textFetched).toEqual(['legiscan:503'])
  })

  it('records an identical companion under the neutral handle', async () => {
    related[600] = [{ sastBillId: 601, kind: 'identical' }]
    await process(msg('bill:600', { matchType: 'keyword' }))
    const links = await db().select().from(billIdenticalLinks).all()
    expect(links.map(l => [l.externalId, l.companionExternalId])).toEqual([['bill:600', 'bill:601']])
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
    await clearDb()
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
    expect(rows.map(r => r.externalId).sort()).toEqual(['bill:700', 'bill:701', 'bill:702'])
  })

  it('gives the same result whichever form comes first', async () => {
    const run = async (order: string[]) => {
      await clearDb()
      await processQueue(order.map(h => queueMessage(msg(h, { matchType: 'keyword' }))) as any, testEnv as any, db())
      return (await allBills()).map(r => [r.externalId, r.title]).sort()
    }
    expect(await run(['legiscan:710', 'bill:710', 'bill:711'])).toEqual(await run(['bill:710', 'legiscan:710', 'legiscan:711']))
  })
})

describe('hearing UIDs stay legacy', () => {
  beforeEach(async () => {
    await clearDb()
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
      await clearDb()
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

// Release 2's migration rewrites stored handles to `bill:<n>` while a release-1 worker may
// still be consuming the queue (api/deploy.sh migrates, then deploys). That worker must
// find the migrated rows by either spelling, and never insert a second one (#305).
describe('a tenant whose rows are already stored under the neutral handle', () => {
  beforeEach(async () => {
    await clearDb()
    vi.clearAllMocks()
    stubCentral()
  })

  const seedMigrated = (n: number, extra: Record<string, unknown> = {}) =>
    seedBill({ billNumber: `H ${n}`, state: 'RI', session: '2026 Regular Session', externalId: `bill:${n}`, matchType: 'keyword', priority: 'high', aiProcessedAt: '2026-06-01T00:00:00Z', ...extra })

  it.each(['legiscan:800', 'bill:800'])('applies a %s delivery to the migrated row, with no second row', async (handle) => {
    const id = await seedMigrated(800)
    await process(msg(handle))
    const rows = await allBills()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id, externalId: 'bill:800', title: 'Mail ballot processing 800' })
  })

  it('applies a stub-only legacy delivery to the migrated row', async () => {
    await seedMigrated(801, { matchType: null, priority: null, aiProcessedAt: undefined })
    await process(msg('legiscan:801', { stubOnly: true, matchType: null }))
    expect((await allBills()).map(r => r.externalId)).toEqual(['bill:801'])
  })

  it('still asks central by the legacy handle', async () => {
    await seedMigrated(802)
    await process(msg('bill:802'))
    expect(fetched).toEqual(['legiscan:802'])
  })

  it('reads the text of a migrated bill by its legacy handle', async () => {
    withText = true
    await seedMigrated(804)
    await process(msg('legiscan:804', { forceAI: true }))
    expect(fetched).toEqual(['legiscan:804'])
    expect(textFetched).toEqual(['legiscan:804'])
  })

  it('keeps one calendar entry, under the legacy UID, for a legacy delivery to a migrated row', async () => {
    const id = await seedMigrated(803)
    await process(msg('legiscan:803', { calendar: calendarBlock() }))
    await process(msg('bill:803', { calendar: calendarBlock() }))
    const rows = await db().select().from(calendarEvents).all()
    expect(rows.map(r => [r.billId, r.uid])).toEqual([[id, 'hearing-legiscan-803-1-house-cmte-on-elections@ri']])
  })

  it('leaves a migrated identical link alone and groups the companions, whichever form the delivery names', async () => {
    await seedMigrated(810, { id: 'a810' })
    await seedMigrated(811, { id: 'b811' })
    await db().insert(billIdenticalLinks).values({ externalId: 'bill:810', companionExternalId: 'bill:811' })
    related[810] = [{ sastBillId: 811, kind: 'identical' }]
    await process(msg('legiscan:810', { metadataOnly: true }))
    const links = await db().select().from(billIdenticalLinks).all()
    expect(links.map(l => [l.externalId, l.companionExternalId])).toEqual([['bill:810', 'bill:811']])
    const keys = await db().select({ id: bills.id, k: bills.groupKey }).from(bills).all()
    expect(keys.map(r => r.k)).toEqual(['a810', 'a810'])
  })

  it('drops a migrated link central no longer lists, and groups no more', async () => {
    await seedMigrated(820, { id: 'a820' })
    await seedMigrated(821, { id: 'b821' })
    await db().insert(billIdenticalLinks).values({ externalId: 'bill:820', companionExternalId: 'bill:821' })
    await db().update(bills).set({ groupKey: 'a820' })
    related[820] = []
    await process(msg('legiscan:820', { metadataOnly: true }))
    expect(await db().select().from(billIdenticalLinks).all()).toEqual([])
    expect((await db().select({ k: bills.groupKey }).from(bills).all()).map(r => r.k)).toEqual([null, null])
  })

  it('does not add a second link when a migrated link meets its legacy spelling', async () => {
    await seedMigrated(830)
    await db().insert(billIdenticalLinks).values({ externalId: 'bill:830', companionExternalId: 'bill:831' })
    related[830] = [{ sastBillId: 831, kind: 'identical' }]
    await process(msg('legiscan:830', { metadataOnly: true }))
    expect(await db().select().from(billIdenticalLinks).all()).toHaveLength(1)
  })

  it('applies each message of a mixed batch to its migrated row', async () => {
    await seedMigrated(840)
    await seedMigrated(841)
    const batch = ['legiscan:840', 'bill:841', 'bill:840', 'legiscan:841', 'legiscan:842'].map(h => ({ body: msg(h, { matchType: 'keyword' }), attempts: 1, ack: vi.fn(), retry: vi.fn() }))
    await processQueue(batch as any, testEnv as any, db())
    expect(batch.every(m => m.ack.mock.calls.length === 1 && m.retry.mock.calls.length === 0)).toBe(true)
    expect((await allBills()).map(r => r.externalId).sort()).toEqual(['bill:840', 'bill:841', 'bill:842'])
  })

  it.each(['legiscan:900', 'bill:900'])('updates the neutral row, and only it, when both spellings are stored and a %s delivery arrives', async (handle) => {
    // Both rows can exist only if the bill was duplicated before release 1, and the
    // migration then leaves the legacy row as it is. The delivery must pick one
    // deterministically (the form this release stores), add no third row, and leave
    // the other as it was.
    const legacy = await seedBill({ billNumber: 'H 900', state: 'RI', session: '2026 Regular Session', externalId: 'legiscan:900', title: 'legacy row', matchType: 'keyword', priority: 'high', aiProcessedAt: '2026-06-01T00:00:00Z' })
    const neutral = await seedBill({ billNumber: 'H 900b', state: 'RI', session: '2026 Regular Session', externalId: 'bill:900', title: 'neutral row', matchType: 'keyword', priority: 'high', aiProcessedAt: '2026-06-01T00:00:00Z' })
    await process(msg(handle))
    const rows = await allBills()
    expect(rows).toHaveLength(2)
    expect(rows.find(r => r.id === neutral)).toMatchObject({ externalId: 'bill:900', title: 'Mail ballot processing 900' })
    expect(rows.find(r => r.id === legacy)).toMatchObject({ externalId: 'legiscan:900', title: 'legacy row' })
  })

  it('still updates the row when the migration renames it between the lookup and the write', async () => {
    withText = true
    const id = await seedBill({ billNumber: 'H 910', state: 'RI', session: '2026 Regular Session', externalId: 'legiscan:910', matchType: 'keyword', priority: 'high' })
    vi.mocked(processBill).mockImplementationOnce(async () => {
      await db().update(bills).set({ externalId: 'bill:910' }).where(eq(bills.id, id))
      return { summary: 'Test summary', tags: ['Elections'], relevanceScore: 7 } as any
    })
    await process(msg('legiscan:910', { forceAI: true }))
    const rows = await allBills()
    expect(rows.map(r => [r.id, r.externalId])).toEqual([[id, 'bill:910']])
  })

  it('still retries a shed message when the bill cannot be read to record the shed', async () => {
    withText = true
    await seedMigrated(920, { aiProcessedAt: undefined })
    let failReads = false
    const flaky = new Proxy(db(), {
      get(target, prop) {
        if (prop === 'select' && failReads) throw new Error('D1 unavailable')
        const v = Reflect.get(target, prop, target)
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
    vi.mocked(processBill).mockImplementationOnce(() => {
      failReads = true
      throw Object.assign(new Error('Service Unavailable'), { status: 503 })
    })
    const m = { body: msg('legiscan:920', { forceAI: true, matchType: 'keyword' }), attempts: 1, ack: vi.fn(), retry: vi.fn() }
    await expect(processQueue([m] as any, testEnv as any, flaky as any)).resolves.toBeUndefined()
    expect(m.retry).toHaveBeenCalledTimes(1)
    expect(m.ack).not.toHaveBeenCalled()
  })

  it('records the shed on a migrated row', async () => {
    withText = true
    const id = await seedMigrated(921, { aiProcessedAt: undefined })
    vi.mocked(processBill).mockImplementationOnce(() => { throw Object.assign(new Error('Service Unavailable'), { status: 503 }) })
    const m = { body: msg('legiscan:921', { forceAI: true, matchType: 'keyword' }), attempts: 2, ack: vi.fn(), retry: vi.fn() }
    await processQueue([m] as any, testEnv as any, db())
    expect(m.retry).toHaveBeenCalledTimes(1)
    const row = await db().select({ aiError: bills.aiError }).from(bills).where(eq(bills.id, id)).get()
    expect(row?.aiError).toContain('AI provider shed (attempt 2')
  })
})

// Release 2, the reverse order (#305): the instance migrates and runs release 2
// while central still sends legacy handles (central deploys after it, or an
// older central is still running). Every delivery is legacy, and every row,
// migrated or new, still resolves, with no duplicate, a neutral stored form, and
// legacy UIDs.
describe('a release-2 instance fed by a central that still sends legacy handles', () => {
  beforeEach(async () => {
    await clearDb()
    vi.clearAllMocks()
    stubCentral()
  })

  it('stores a bill it does not hold yet under the neutral handle', async () => {
    await process(msg('legiscan:1000', { matchType: 'keyword' }))
    expect((await allBills()).map(r => r.externalId)).toEqual(['bill:1000'])
  })

  it('applies legacy deliveries to migrated rows, unmigrated rows, and new bills alike, one row each', async () => {
    const migrated = await seedBill({ billNumber: 'H 1001', state: 'RI', session: '2026 Regular Session', externalId: 'bill:1001', matchType: 'keyword', priority: 'high', aiProcessedAt: '2026-06-01T00:00:00Z' })
    const unmigrated = await seedBill({ billNumber: 'H 1002', state: 'RI', session: '2026 Regular Session', externalId: 'legiscan:1002', matchType: 'keyword', priority: 'high', aiProcessedAt: '2026-06-01T00:00:00Z' })
    for (const h of ['legiscan:1001', 'legiscan:1002', 'legiscan:1003', 'legiscan:1001']) await process(msg(h, { matchType: 'keyword' }))
    const rows = (await allBills()).map(r => [r.id, r.externalId, r.title])
    expect(rows).toHaveLength(3)
    expect(rows).toContainEqual([migrated, 'bill:1001', 'Mail ballot processing 1001'])
    expect(rows).toContainEqual([unmigrated, 'legiscan:1002', 'Mail ballot processing 1002'])
    expect(rows.find(r => r[1] === 'bill:1003')).toBeDefined()
  })

  it('writes the legacy UID for a migrated row\'s hearing, whichever form delivers it', async () => {
    const id = await seedBill({ billNumber: 'H 1004', state: 'RI', session: '2026 Regular Session', externalId: 'bill:1004', matchType: 'keyword', priority: 'high', aiProcessedAt: '2026-06-01T00:00:00Z' })
    await process(msg('legiscan:1004', { calendar: calendarBlock() }))
    await process(msg('bill:1004', { calendar: calendarBlock() }))
    const rows = await db().select().from(calendarEvents).all()
    expect(rows.map(r => [r.billId, r.uid, r.sequence])).toEqual([[id, 'hearing-legiscan-1004-1-house-cmte-on-elections@ri', 0]])
  })

  it('records a companion by the neutral handle and finds a migrated link', async () => {
    related[1010] = [{ sastBillId: 1011, kind: 'identical' }]
    await process(msg('legiscan:1010', { matchType: 'keyword' }))
    await process(msg('legiscan:1010', { matchType: 'keyword' }))
    const links = await db().select().from(billIdenticalLinks).all()
    expect(links.map(l => [l.externalId, l.companionExternalId])).toEqual([['bill:1010', 'bill:1011']])
  })

  it('asks central by the legacy handle and says it reads neutral handles', async () => {
    const seen: Request[] = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      seen.push(new Request(url, init))
      return Promise.resolve(new Response(JSON.stringify(centralBillJson(1020)), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    }))
    await process(msg('bill:1020', { matchType: 'keyword' }))
    expect(new URL(seen[0].url).pathname).toBe('/api/bills/legiscan:1020')
    expect(seen[0].headers.get('x-handle-form')).toBe('neutral')
  })
})
