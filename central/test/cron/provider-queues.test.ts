import { env } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from '../../src/db/schema'
import mgaSampleRaw from '../fixtures/mga/2026RS-sample.json?raw'
import lisSampleRaw from '../fixtures/lis/20261-sample.json?raw'

// Each provider's ingests go to its own queue when it is bound (#401), so one
// provider's backlog never waits behind another's. The sync and the queue
// consumer run end to end against recorded feeds, with every queue a mock.
vi.mock('../../src/lib/rateLimitedFetch', () => import('../helpers/unpacedFetch'))
vi.mock('../../src/lib/sync-schedule', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/sync-schedule')>('../../src/lib/sync-schedule')
  return { ...actual, getCurrentEtHour: vi.fn(() => 5) }
})
vi.mock('../../src/providers/legiscan/client', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/legiscan/client')>('../../src/providers/legiscan/client')
  return { ...actual, getBill: vi.fn(), getBillText: vi.fn() }
})
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import worker from '../../src/index-legiscan'
import { runSnapshotSync } from '../../src/cron/sync-snapshots'
import { mga } from '../../src/providers/mga'
import { lis } from '../../src/providers/lis'
import { LIS_FILES, LIS_FILES_BASE, type LisFile, type LisFiles } from '../../src/providers/lis/client'
import * as legiscan from '../../src/providers/legiscan/client'
import { tenantQueueBindingName } from '../../src/lib/tenantQueue'
import { resetCentral, ADMIN_SECRET } from '../helpers/mainSeam'

const MGA_FILE = 'https://mgaleg.maryland.gov/2026RS/misc/billsmasterlist/legislation.json'
const PDF = '%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'
const lisFiles = JSON.parse(lisSampleRaw) as LisFiles

const SHARED_NAME = 'central-legiscan-ingestor'
const MGA_NAME = 'central-mga-ingestor'
const LIS_NAME = 'central-lis-ingestor'
const LIMS_NAME = 'central-lims-ingestor'

const mockQueue = () => ({ sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue(undefined) })
type MockQueue = ReturnType<typeof mockQueue>
const bodies = (q: MockQueue): any[] => [
  ...q.send.mock.calls.map(c => c[0]),
  ...q.sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body)),
]
const billIds = (q: MockQueue) => bodies(q).filter(b => b.calendarRecheck === undefined).map(b => b.billId as number)

/** Central's env with the shared queue, and whichever provider queues are bound. */
function makeEnv(bound: { mga?: boolean; lis?: boolean; lims?: boolean } = {}) {
  const q = { shared: mockQueue(), mga: mockQueue(), lis: mockQueue(), lims: mockQueue(), mdTenant: mockQueue(), vaTenant: mockQueue() }
  const e: Record<string, any> = {
    ...(env as any),
    ADMIN_SECRET,
    INGESTOR_QUEUE: q.shared,
    ...(bound.mga ? { MGA_INGESTOR_QUEUE: q.mga } : {}),
    ...(bound.lis ? { LIS_INGESTOR_QUEUE: q.lis } : {}),
    ...(bound.lims ? { LIMS_INGESTOR_QUEUE: q.lims } : {}),
    [tenantQueueBindingName('mdteam')]: q.mdTenant,
    [tenantQueueBindingName('vateam')]: q.vaTenant,
  }
  return { env: e, q }
}

const db = () => drizzle(env.DB, { schema })

/** Hand messages to central's queue consumer on the named queue, as the platform would. */
async function deliver(queueName: string, messageBodies: unknown[], e: Record<string, any>, dlq?: string) {
  const messages = messageBodies.map(body => ({ body, ack: vi.fn(), retry: vi.fn() }))
  await worker.queue({ queue: queueName, messages } as any, { ...e, ...(dlq ? { DEAD_LETTER_QUEUE: dlq } : {}) })
  return messages
}

const billByNumber = (number: string, provider: string) =>
  db().select().from(schema.bills).where(eq(schema.bills.billNumber, number)).all().then(rows => rows.find(r => r.provider === provider))

beforeEach(async () => {
  await resetCentral()
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const method = init?.method ?? 'GET'
    if (url === MGA_FILE) return method === 'HEAD' ? new Response(null, { status: 200 })
      : new Response(mgaSampleRaw, { headers: { 'content-type': 'application/json', ETag: '"v1"' } })
    if (url.endsWith('/legislation.json')) return new Response('not found', { status: 404 })
    if (url.startsWith('https://mgaleg.maryland.gov/2026RS/bills/')) return new Response(PDF, { headers: { 'content-type': 'application/pdf' } })
    if (url.startsWith(`${LIS_FILES_BASE}/`)) {
      const [code, name] = url.slice(LIS_FILES_BASE.length + 1).split('/')
      const file = (Object.keys(LIS_FILES) as LisFile[]).find(f => LIS_FILES[f] === name)
      if (code !== '20261' || !file || !lisFiles[file]) return new Response('<Error><Code>BlobNotFound</Code></Error>', { status: 404 })
      return new Response(method === 'HEAD' ? null : lisFiles[file], { headers: { ETag: `"${code}-${file}-v1"` } })
    }
    throw new Error(`no network in this test: ${method} ${url}`)
  })
  const d = db()
  await d.insert(schema.tenants).values([
    { tenantId: 'mdteam', name: 'MD team', stateCoverage: '["MD"]', active: true },
    { tenantId: 'vateam', name: 'VA team', stateCoverage: '["VA"]', active: true },
  ])
  await d.insert(schema.keywordRegistry).values([
    { tenantId: 'mdteam', keyword: 'cost recovery' }, { tenantId: 'mdteam', keyword: 'tax' },
    { tenantId: 'vateam', keyword: 'minimum wage' }, { tenantId: 'vateam', keyword: 'daylight' }, { tenantId: 'vateam', keyword: 'procurement' },
  ])
  await d.insert(schema.stateProviders).values([
    { state: 'MD', provider: 'mga', previousProvider: 'legiscan' },
    { state: 'VA', provider: 'lis', previousProvider: 'legiscan' },
  ])
})

afterEach(() => {
  vi.useRealTimers()
})

describe('where each provider\'s sync queues its bills', () => {
  it('sends Maryland\'s bills to the MGA queue when it is bound, and none to the shared queue', async () => {
    const { env: e, q } = makeEnv({ mga: true })
    await runSnapshotSync(mga, e as any, db())
    expect(billIds(q.mga).length).toBeGreaterThan(0)
    expect(q.shared.sendBatch).not.toHaveBeenCalled()
    expect(q.shared.send).not.toHaveBeenCalled()
  })

  it('sends Maryland\'s bills to the shared queue when the MGA queue is not bound', async () => {
    const { env: e, q } = makeEnv()
    await runSnapshotSync(mga, e as any, db())
    expect(billIds(q.shared).length).toBeGreaterThan(0)
    expect(q.mga.sendBatch).not.toHaveBeenCalled()
  })

  it('sends Virginia\'s bills to the LIS queue when it is bound, and none to the shared queue', async () => {
    const { env: e, q } = makeEnv({ lis: true })
    await runSnapshotSync(lis, e as any, db())
    expect(billIds(q.lis).length).toBeGreaterThan(0)
    expect(q.shared.sendBatch).not.toHaveBeenCalled()
    expect(q.shared.send).not.toHaveBeenCalled()
  })

  it('sends Virginia\'s bills to the shared queue when the LIS queue is not bound', async () => {
    const { env: e, q } = makeEnv()
    await runSnapshotSync(lis, e as any, db())
    expect(billIds(q.shared).length).toBeGreaterThan(0)
    expect(q.lis.sendBatch).not.toHaveBeenCalled()
  })

  it('keeps the same bills whichever queue they go to', async () => {
    const bound = makeEnv({ mga: true })
    await runSnapshotSync(mga, bound.env as any, db())
    const boundIds = billIds(bound.q.mga).sort()
    await resetCentral()
    const d = db()
    await d.insert(schema.tenants).values({ tenantId: 'mdteam', name: 'MD team', stateCoverage: '["MD"]', active: true })
    await d.insert(schema.keywordRegistry).values([{ tenantId: 'mdteam', keyword: 'cost recovery' }, { tenantId: 'mdteam', keyword: 'tax' }])
    await d.insert(schema.stateProviders).values({ state: 'MD', provider: 'mga', previousProvider: 'legiscan' })
    const unbound = makeEnv()
    await runSnapshotSync(mga, unbound.env as any, db())
    expect(boundIds.length).toBeGreaterThan(0)
    expect(billIds(unbound.q.shared).sort()).toEqual(boundIds)
  })

  it('sends each provider\'s bills to its own queue when all are bound, so none waits behind another\'s', async () => {
    const { env: e, q } = makeEnv({ mga: true, lis: true, lims: true })
    await runSnapshotSync(mga, e as any, db())
    await runSnapshotSync(lis, e as any, db())
    expect(billIds(q.mga).length).toBeGreaterThan(0)
    expect(billIds(q.lis).length).toBeGreaterThan(0)
    // No Maryland bill on Virginia's queue or the reverse, and nothing on the shared queue, where LegiScan's work waits.
    const mdBills = new Set((await db().select().from(schema.bills).where(eq(schema.bills.provider, 'mga')).all()).map(b => b.billId))
    const vaBills = new Set((await db().select().from(schema.bills).where(eq(schema.bills.provider, 'lis')).all()).map(b => b.billId))
    expect(billIds(q.mga).every(id => mdBills.has(id))).toBe(true)
    expect(billIds(q.lis).every(id => vaBills.has(id))).toBe(true)
    expect(bodies(q.shared)).toEqual([])
    expect(bodies(q.lims)).toEqual([])
  })

  it('leaves LegiScan\'s own queueing on the shared queue when every provider queue is bound', async () => {
    const { env: e, q } = makeEnv({ mga: true, lis: true, lims: true })
    const res = await worker.fetch(new Request('http://central/api/admin/reingest-bill/4242', {
      method: 'POST', headers: { 'x-admin-secret': ADMIN_SECRET },
    }), e as any, {} as any)
    expect(res.status).toBe(200)
    expect(bodies(q.shared)).toEqual([{ billId: 4242 }])
    for (const own of [q.mga, q.lis, q.lims]) expect(bodies(own)).toEqual([])
  })

  it('queues an operator\'s re-ingest of a provider\'s bills on that provider\'s queue', async () => {
    const { env: e, q } = makeEnv({ mga: true, lis: true })
    await runSnapshotSync(mga, e as any, db())
    const mgaIds = billIds(q.mga)
    q.mga.sendBatch.mockClear()
    const res = await worker.fetch(new Request('http://central/api/admin/reingest-tenant/mdteam?provider=mga&confirm=true', {
      method: 'POST', headers: { 'x-admin-secret': ADMIN_SECRET },
    }), e as any, {} as any)
    expect(res.status).toBe(200)
    expect(billIds(q.mga).sort()).toEqual(mgaIds.sort())
    expect(bodies(q.shared)).toEqual([])
    expect(bodies(q.lis)).toEqual([])
  })
})

describe('the queue consumer', () => {
  /** Syncs Maryland and Virginia with the shared queue only, and returns each state's bill ids. */
  async function syncBoth() {
    const { env: e, q } = makeEnv({ mga: true, lis: true })
    await runSnapshotSync(mga, e as any, db())
    await runSnapshotSync(lis, e as any, db())
    return { e, q, mgaIds: billIds(q.mga), lisIds: billIds(q.lis) }
  }

  it.each([
    ['MGA', MGA_NAME, 'mga', 'HB1'],
    ['LIS', LIS_NAME, 'lis', 'HB1'],
  ] as const)('ingests a bill delivered on the %s queue as one on the shared queue would be', async (_label, queueName, provider, number) => {
    const { e } = await syncBoth()
    const bill = (await billByNumber(number, provider))!
    const other = (await billByNumber('HB9', provider)) ?? (await billByNumber('SB2', provider))!

    const [onOwn] = await deliver(queueName, [{ billId: bill.billId }], e)
    const [onShared] = await deliver(SHARED_NAME, [{ billId: other.billId }], e)
    for (const m of [onOwn, onShared]) {
      expect(m.retry).not.toHaveBeenCalled()
      expect(m.ack).toHaveBeenCalledOnce()
    }
    expect(legiscan.getBill).not.toHaveBeenCalled()

    // Both leave the same kinds of rows: the provider's handler wrote each bill's history and sponsors.
    const rowsFor = async (billId: number) => ({
      history: (await db().select().from(schema.billHistory).where(eq(schema.billHistory.billId, billId)).all()).length > 0,
      sponsors: (await db().select().from(schema.billSponsors).where(eq(schema.billSponsors.billId, billId)).all()).length > 0,
    })
    expect(await rowsFor(bill.billId)).toEqual(await rowsFor(other.billId))
    expect((await rowsFor(bill.billId)).sponsors).toBe(true)
  })

  it('routes each queue\'s messages to its own provider\'s handler', async () => {
    const { e } = await syncBoth()
    const md = (await billByNumber('HB1', 'mga'))!
    const va = (await billByNumber('HB1', 'lis'))!
    const [a] = await deliver(MGA_NAME, [{ billId: md.billId }], e)
    const [b] = await deliver(LIS_NAME, [{ billId: va.billId }], e)
    expect(a.ack).toHaveBeenCalledOnce()
    expect(b.ack).toHaveBeenCalledOnce()
    const people = async (billId: number) => (await db().select({ provider: schema.people.provider }).from(schema.people)
      .innerJoin(schema.billSponsors, eq(schema.billSponsors.peopleId, schema.people.peopleId))
      .where(eq(schema.billSponsors.billId, billId)).all()).map(r => r.provider)
    expect(new Set(await people(md.billId))).toEqual(new Set(['mga']))
    expect(new Set(await people(va.billId))).toEqual(new Set(['lis']))
  })

  it('does not take a provider\'s queue for the dead-letter queue', async () => {
    const { e } = await syncBoth()
    const md = (await billByNumber('HB1', 'mga'))!
    const [m] = await deliver(MGA_NAME, [{ billId: md.billId }], e, 'floorvote-tenants-dlq')
    expect(m.ack).toHaveBeenCalledOnce()
    expect((await db().select().from(schema.billSponsors).where(eq(schema.billSponsors.billId, md.billId)).all()).length).toBeGreaterThan(0)
  })

  it('still reads the dead-letter queue as dead letters when provider queues are bound', async () => {
    const { e } = await syncBoth()
    const messages = await deliver('floorvote-tenants-dlq', [{ billId: 1, tenantId: 'mdteam' }], e, 'floorvote-tenants-dlq')
    expect(messages[0].ack).toHaveBeenCalledOnce()
    expect(legiscan.getBill).not.toHaveBeenCalled()
  })

  // Which handler runs is set by the bill's row (`bills.provider`), never by the
  // queue the message arrived on. A message on the wrong queue is therefore
  // ingested correctly by its own provider's handler: it is neither retried nor
  // dropped, and costs only the throughput budget of the queue it landed on.
  it.each([
    ['another provider\'s queue', LIS_NAME],
    ['the shared queue', SHARED_NAME],
    ['LIMS\'s queue', LIMS_NAME],
  ])('ingests a Maryland bill delivered on %s with Maryland\'s handler', async (_label, queueName) => {
    const { e } = await syncBoth()
    const md = (await billByNumber('HB1', 'mga'))!
    const [m] = await deliver(queueName, [{ billId: md.billId }], e)
    expect(m.retry).not.toHaveBeenCalled()
    expect(m.ack).toHaveBeenCalledOnce()
    expect(legiscan.getBill).not.toHaveBeenCalled()
    const texts = await db().select().from(schema.billTexts).where(eq(schema.billTexts.billId, md.billId)).all()
    expect(texts.map(t => t.stateLink).sort()).toEqual([
      'https://mgaleg.maryland.gov/2026RS/bills/hb/hb0001F.pdf',
      'https://mgaleg.maryland.gov/2026RS/bills/hb/hb0001T.pdf',
    ])
    const sponsors = await db().select({ provider: schema.people.provider }).from(schema.people)
      .innerJoin(schema.billSponsors, eq(schema.billSponsors.peopleId, schema.people.peopleId))
      .where(eq(schema.billSponsors.billId, md.billId)).all()
    expect(sponsors.length).toBeGreaterThan(0)
    expect(sponsors.every(s => s.provider === 'mga')).toBe(true)
  })

  it('ingests a mixed batch, each bill by its own provider', async () => {
    const { e } = await syncBoth()
    const md = (await billByNumber('HB1', 'mga'))!
    const va = (await billByNumber('HB1', 'lis'))!
    const messages = await deliver(MGA_NAME, [{ billId: md.billId }, { billId: va.billId }], e)
    for (const m of messages) {
      expect(m.retry).not.toHaveBeenCalled()
      expect(m.ack).toHaveBeenCalledOnce()
    }
    expect(legiscan.getBill).not.toHaveBeenCalled()
  })

  it('retries a failing message and leaves the others in its batch acknowledged', async () => {
    const { e } = await syncBoth()
    const md = (await billByNumber('HB1', 'mga'))!
    fetchMock.mockImplementation(async () => { throw new Error('boom') })
    // A bill no row exists for falls to the default provider, whose fetch is mocked to fail.
    vi.mocked(legiscan.getBill).mockRejectedValue(new Error('legiscan down'))
    const messages = await deliver(MGA_NAME, [{ billId: 987654321 }, { billId: md.billId }], e)
    expect(messages[0].retry).toHaveBeenCalledOnce()
    expect(messages[0].ack).not.toHaveBeenCalled()
  })
})

describe('LegiScan ingest', () => {
  it('is unchanged on the shared queue, with or without provider queues bound', async () => {
    for (const bound of [{}, { mga: true, lis: true, lims: true }]) {
      vi.mocked(legiscan.getBill).mockReset()
      vi.mocked(legiscan.getBill).mockRejectedValue(new Error('no such bill in this test'))
      const { env: e } = makeEnv(bound)
      const [m] = await deliver(SHARED_NAME, [{ billId: 5150 }], e)
      // The bill isn't known, so the default provider fetches it, exactly as before.
      expect(legiscan.getBill).toHaveBeenCalledOnce()
      expect(m.retry).toHaveBeenCalledOnce()
    }
  })
})
