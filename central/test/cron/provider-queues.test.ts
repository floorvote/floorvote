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

import worker from '../../src/index'
import { runSnapshotSync } from '../../src/cron/sync-snapshots'
import { checkVoteDatasets } from '../../src/cron/vote-datasets'
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
    // The instance's tracked bills: the sync queued every bill (the MGA declares ingestAll, #835).
    const tracked = new Set((await db().select().from(schema.billTenants).where(eq(schema.billTenants.tenantId, 'mdteam')).all())
      .filter(l => l.matchType !== null).map(l => l.billId))
    const mgaIds = billIds(q.mga).filter(id => tracked.has(id))
    expect(mgaIds.length).toBeGreaterThan(0)
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

// Every other producer of an ingest sends a bill to the queue its provider owns
// too (#673), not to the shared queue behind LegiScan's work. Each producer runs
// through its real route (or cron, or consumer) against a central whose queues
// are all mocks, and the test reads which queue each bill landed on.
describe('where every other producer queues a bill', () => {
  type QueueName = 'shared' | 'mga' | 'lis' | 'lims'
  type Fixture = { label: string; provider: string; billId: number; sessionId: number; state: string; own: QueueName }
  const FIXTURES: Fixture[] = [
    { label: 'MGA', provider: 'mga', billId: 9101, sessionId: 101, state: 'MD', own: 'mga' },
    { label: 'LIS', provider: 'lis', billId: 9102, sessionId: 102, state: 'VA', own: 'lis' },
    { label: 'LIMS', provider: 'lims', billId: 9103, sessionId: 103, state: 'DC', own: 'lims' },
    { label: 'LegiScan', provider: 'legiscan', billId: 9104, sessionId: 104, state: 'RI', own: 'shared' },
  ]
  const ALL = { mga: true, lis: true, lims: true }
  const QUEUE_NAMES: QueueName[] = ['shared', 'mga', 'lis', 'lims']

  let seq = 0
  /** A tenant, and one bill of each provider (each in a session its provider owns). Returns the tenant. */
  async function seedWorld(): Promise<string> {
    const d = db()
    const tenantId = `pt${++seq}`
    await d.insert(schema.tenants).values({ tenantId, name: tenantId, stateCoverage: '[]', active: true })
    await d.insert(schema.keywordRegistry).values({ tenantId, keyword: 'tax' })
    if (seq === 1 || !(await d.select().from(schema.stateProviders).where(eq(schema.stateProviders.state, 'DC')).all()).length) {
      await d.insert(schema.stateProviders).values({ state: 'DC', provider: 'lims', previousProvider: 'legiscan' })
    }
    for (const f of FIXTURES) {
      if (!(await d.select().from(schema.sessions).where(eq(schema.sessions.sessionId, f.sessionId)).all()).length) {
        await d.insert(schema.sessions).values({
          sessionId: f.sessionId, state: f.state, stateId: 0, yearStart: 2026, yearEnd: 2026,
          sessionName: `${f.state} 2026`, sessionTitle: `${f.state} 2026`, provider: f.provider,
        })
      }
      if (!(await d.select().from(schema.bills).where(eq(schema.bills.billId, f.billId)).all()).length) {
        await d.insert(schema.bills).values({
          billId: f.billId, sessionId: f.sessionId, state: f.state, stateId: 0, billNumber: 'HB1',
          title: 'A sales tax act', changeHash: 'h', status: 1, provider: f.provider,
        })
      }
    }
    return tenantId
  }
  const link = (tenantId: string, billId: number, matchType: 'keyword' | 'manual' | null) =>
    db().insert(schema.billTenants).values({ billId, tenantId, matchType })
  const textRow = (docId: number, billId: number, over: Partial<typeof schema.billTexts.$inferInsert> = {}) =>
    db().insert(schema.billTexts).values({ docId, billId, date: '2026-01-01', type: 'Introduced', ...over })

  const request = (e: Record<string, any>, method: string, path: string, body?: unknown) =>
    worker.fetch(new Request(`http://central/api${path}`, {
      method,
      headers: { 'x-admin-secret': ADMIN_SECRET, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), e as any, {} as any)

  /** Which queues a bill's message reached, and how many times each. */
  function landed(q: Record<QueueName, MockQueue>, billId: number): Partial<Record<QueueName, number>> {
    const out: Partial<Record<QueueName, number>> = {}
    for (const name of QUEUE_NAMES) {
      const n = bodies(q[name]).filter(b => b.billId === billId).length
      if (n > 0) out[name] = n
    }
    return out
  }

  type Producer = {
    name: string
    /** Whether the producer sends several bills in one request. */
    batch: boolean
    /** Sets up the rows the route reads for these bills. */
    prepare: (tenantId: string, fixtures: Fixture[]) => Promise<void>
    run: (e: Record<string, any>, tenantId: string, fixtures: Fixture[]) => Promise<Response>
  }
  const PRODUCERS: Producer[] = [
    {
      name: 'a tenant seed', batch: false,
      prepare: async () => {},
      run: (e, t, [f]) => request(e, 'POST', `/tenants/seed-session/${t}?sessionId=${f.sessionId}`),
    },
    {
      name: 'a texts re-download', batch: true,
      prepare: async (t, fs) => { for (const f of fs) { await link(t, f.billId, 'keyword'); await textRow(f.billId + 1000, f.billId) } },
      run: (e, t) => request(e, 'POST', `/tenants/redownload-texts/${t}`),
    },
    {
      name: 'a single bill promotion', batch: false,
      prepare: async () => {},
      run: (e, t, [f]) => request(e, 'POST', `/tenants/promote-bill/${t}/${f.billId}`, {}),
    },
    {
      name: 'a bulk bill promotion', batch: true,
      prepare: async () => {},
      run: (e, t, fs) => request(e, 'POST', `/tenants/promote-bills/${t}`, { billIds: fs.map(f => f.billId) }),
    },
    {
      name: 'a tenant\'s fetch of bills without tracking them', batch: true,
      prepare: async (t, fs) => { for (const f of fs) await link(t, f.billId, null) },
      run: (e, t, fs) => request(e, 'POST', `/tenants/fetch-bills/${t}`, { billIds: fs.map(f => f.billId) }),
    },
    {
      name: 'a keyword re-run', batch: true,
      prepare: async (t, fs) => { for (const f of fs) await link(t, f.billId, null) },
      run: (e, t) => request(e, 'POST', `/admin/sync-keywords/${t}`),
    },
    {
      name: 'an operator\'s fetch of missing texts', batch: true,
      prepare: async (t, fs) => { for (const f of fs) await link(t, f.billId, 'keyword') },
      run: (e, t) => request(e, 'POST', `/admin/fetch-missing-texts/${t}`),
    },
    {
      name: 'an operator\'s refetch of fragment texts', batch: true,
      prepare: async (_t, fs) => { for (const f of fs) await textRow(f.billId + 2000, f.billId, { r2Key: `texts/${f.billId}`, stateLink: 'https://example.test/doc#v2' }) },
      run: (e) => request(e, 'POST', '/admin/refetch-fragment-texts'),
    },
    {
      name: 'an operator\'s single-bill re-ingest', batch: false,
      prepare: async () => {},
      run: (e, _t, [f]) => request(e, 'POST', `/admin/reingest-bill/${f.billId}`),
    },
  ]

  describe.each(PRODUCERS)('$name', (producer) => {
    it.each(FIXTURES)('sends a $label bill to its own queue when every provider queue is bound', async (f) => {
      const tenantId = await seedWorld()
      await producer.prepare(tenantId, [f])
      const { env: e, q } = makeEnv(ALL)
      const res = await producer.run(e, tenantId, [f])
      expect(res.status).toBe(200)
      expect(landed(q, f.billId)).toEqual({ [f.own]: 1 })
    })

    it.each(FIXTURES.filter(f => f.own !== 'shared'))('sends a $label bill to the shared queue when its queue is not bound', async (f) => {
      const tenantId = await seedWorld()
      await producer.prepare(tenantId, [f])
      const { env: e, q } = makeEnv({ ...ALL, [f.own]: false })
      const res = await producer.run(e, tenantId, [f])
      expect(res.status).toBe(200)
      expect(landed(q, f.billId)).toEqual({ shared: 1 })
      expect(bodies(q[f.own])).toEqual([])
    })

    it('sends a bill of a provider central does not know to the shared queue', async () => {
      const tenantId = await seedWorld()
      const ghost: Fixture = { label: 'unknown', provider: 'nosuch', billId: 9105, sessionId: 104, state: 'RI', own: 'shared' }
      await db().insert(schema.bills).values({
        billId: ghost.billId, sessionId: ghost.sessionId, state: ghost.state, stateId: 0, billNumber: 'HB1',
        title: 'A sales tax act', changeHash: 'h', status: 1, provider: ghost.provider,
      })
      await producer.prepare(tenantId, [ghost])
      const { env: e, q } = makeEnv(ALL)
      const res = await producer.run(e, tenantId, [ghost])
      expect(res.status).toBe(200)
      expect(landed(q, ghost.billId)).toEqual({ shared: 1 })
    })
  })

  // Seed and the keyword re-run read the bill's row to find it, so only the rest can be handed a bill with none.
  describe.each(PRODUCERS.filter(p => !['a tenant seed', 'a keyword re-run'].includes(p.name)))('$name, for a bill with no row', (producer) => {
    it('sends it to the shared queue and does not drop it', async () => {
      const tenantId = await seedWorld()
      const rowless: Fixture = { label: 'rowless', provider: 'legiscan', billId: 987001, sessionId: 104, state: 'RI', own: 'shared' }
      await producer.prepare(tenantId, [rowless])
      const { env: e, q } = makeEnv(ALL)
      const res = await producer.run(e, tenantId, [rowless])
      expect(res.status).toBe(200)
      expect(landed(q, rowless.billId)).toEqual({ shared: 1 })
    })
  })

  describe.each(PRODUCERS.filter(p => p.batch))('$name, with bills of every provider in one request', (producer) => {
    it('splits the batch so each bill lands once, on its own provider\'s queue', async () => {
      const tenantId = await seedWorld()
      await producer.prepare(tenantId, FIXTURES)
      const { env: e, q } = makeEnv(ALL)
      const res = await producer.run(e, tenantId, FIXTURES)
      expect(res.status).toBe(200)
      for (const f of FIXTURES) expect(landed(q, f.billId)).toEqual({ [f.own]: 1 })
    })

    it('sends the providers without a bound queue to the shared queue with LegiScan\'s, and the rest to their own', async () => {
      const tenantId = await seedWorld()
      await producer.prepare(tenantId, FIXTURES)
      const { env: e, q } = makeEnv({ mga: true })
      const res = await producer.run(e, tenantId, FIXTURES)
      expect(res.status).toBe(200)
      expect(landed(q, 9101)).toEqual({ mga: 1 })
      for (const id of [9102, 9103, 9104]) expect(landed(q, id)).toEqual({ shared: 1 })
    })
  })

  describe('a batch of more than one send\'s worth', () => {
    it('keeps every bill of a provider together on its queue, in batches of at most 100', async () => {
      const tenantId = await seedWorld()
      const ids = Array.from({ length: 150 }, (_, i) => 50000 + i)
      // One statement each, with the ids as one JSON parameter (D1 binds at most 100).
      const list = JSON.stringify(ids)
      await env.DB.prepare(`INSERT INTO bills (bill_id, session_id, state, state_id, bill_number, title, change_hash, status, provider)
        SELECT value, 101, 'MD', 0, 'HB' || value, 'A sales tax act', 'h', 1, 'mga' FROM json_each(?1)`).bind(list).run()
      await env.DB.prepare(`INSERT INTO bill_tenants (bill_id, tenant_id, match_type) SELECT value, ?2, NULL FROM json_each(?1)`).bind(list, tenantId).run()
      const { env: e, q } = makeEnv(ALL)
      const res = await request(e, 'POST', `/tenants/fetch-bills/${tenantId}`, { billIds: ids })
      expect(res.status).toBe(200)
      expect(billIds(q.mga).sort((a, b) => a - b)).toEqual(ids)
      expect(bodies(q.shared)).toEqual([])
      expect(q.mga.sendBatch.mock.calls.map(c => c[0].length)).toEqual([90, 60])
    })
  })

  describe('vote datasets', () => {
    const deferred = (q: MockQueue) => q.send.mock.calls.filter(c => c[1]?.delaySeconds !== undefined)

    it.each([['mga', 'mga'], ['lis', 'lis'], ['lims', 'lims'], ['legiscan', 'shared']] as const)(
      'defers a %s load behind another in the batch onto that provider\'s queue',
      async (providerId, own) => {
        const { env: e, q } = makeEnv(ALL)
        const load = (sessionId: number) => ({ kind: 'vote-dataset' as const, providerId, sessionId, key: 'test-key', hash: 'h' })
        // The first load runs here and fails (no fetch is stubbed for it), which still counts as the batch's one load.
        fetchMock.mockImplementation(async () => { throw new Error('no network in this test') })
        const messages = [load(1), load(2)].map(body => ({ body, ack: vi.fn(), retry: vi.fn() }))
        await worker.queue({ queue: SHARED_NAME, messages } as any, e)
        expect(messages[1].ack).toHaveBeenCalledOnce()
        expect(deferred(q[own]).map(c => c[0])).toEqual([load(2)])
        for (const other of QUEUE_NAMES.filter(n => n !== own)) expect(deferred(q[other])).toEqual([])
      })

    it('defers a load to the shared queue when its provider\'s queue is not bound', async () => {
      const { env: e, q } = makeEnv()
      fetchMock.mockImplementation(async () => { throw new Error('no network in this test') })
      const load = (sessionId: number) => ({ kind: 'vote-dataset' as const, providerId: 'mga', sessionId, key: 'test-key', hash: 'h' })
      const messages = [load(1), load(2)].map(body => ({ body, ack: vi.fn(), retry: vi.fn() }))
      await worker.queue({ queue: SHARED_NAME, messages } as any, e)
      expect(deferred(q.shared).map(c => c[0])).toEqual([load(2)])
    })

    it('queues LegiScan\'s changed dataset on the shared queue when every provider queue is bound', async () => {
      const d = db()
      await d.insert(schema.tenants).values({ tenantId: 'ri-team', name: 'RI team', stateCoverage: '["RI"]', active: true })
      await d.insert(schema.sessions).values({
        sessionId: 104, state: 'RI', stateId: 39, yearStart: 2026, yearEnd: 2026, sessionName: 'RI 2026', sessionTitle: 'RI 2026',
      })
      fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
        const url = new URL(String(input instanceof Request ? input.url : input))
        if (url.searchParams.get('op') === 'getDatasetList') {
          return new Response(JSON.stringify({ status: 'OK', datasetlist: [{ session_id: 104, state_id: 39, dataset_hash: 'new-hash', dataset_size: 10, access_key: 'test-key' }] }))
        }
        throw new Error(`no network in this test: ${url}`)
      })
      const { env: e, q } = makeEnv(ALL)
      await checkVoteDatasets({ ...e, LEGISCAN_API_KEY: 'test-api-key' } as any, db())
      expect(q.shared.send).toHaveBeenCalledWith({ kind: 'vote-dataset', providerId: 'legiscan', sessionId: 104, key: 'test-key', hash: 'new-hash' })
      for (const own of [q.mga, q.lis, q.lims]) expect(bodies(own)).toEqual([])
    })
  })
})
