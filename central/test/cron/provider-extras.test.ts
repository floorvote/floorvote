import { env } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from '../../src/db/schema'
import { setupLsDb } from '../helpers/setupLsDb'
import sessionRaw from '../fixtures/example/session-2026.json?raw'

// Provider extras at the main seam: a provider's recorded feed in, central's
// bill API and the queued tenant notifications out. The provider is the
// test-only example provider (test/providers/example/), added to the registry.
vi.mock('../../src/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers')>()
  const { example } = await import('../providers/example')
  const PROVIDERS = [...actual.PROVIDERS, example]
  const findProvider = (id: string | null | undefined) => PROVIDERS.find(p => p.id === id)
  return {
    ...actual,
    PROVIDERS,
    findProvider,
    getProvider: (id: string) => {
      const p = findProvider(id)
      if (!p) throw new Error(`unknown provider: ${id}`)
      return p
    },
  }
})
vi.mock('../../src/lib/sync-schedule', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/sync-schedule')>('../../src/lib/sync-schedule')
  return { ...actual, getCurrentEtHour: vi.fn(() => 5) }
})
vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network in this test') }))

import { runSnapshotSync } from '../../src/cron/sync-snapshots'
import { ingestMeasure, processIngestorQueue } from '../../src/queue/processor'
import { tenantQueueBindingName } from '../../src/lib/tenantQueue'
import { example, exampleFeed, type ExampleRecord } from '../providers/example'

const records = JSON.parse(sessionRaw) as ExampleRecord[]

function makeEnv() {
  const ingestor = { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn() }
  const tenantQueue = { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue(undefined) }
  return {
    ingestor, tenantQueue,
    env: { ...(env as any), INGESTOR_QUEUE: ingestor, [tenantQueueBindingName('team')]: tenantQueue },
  }
}

const sentToTenant = (q: ReturnType<typeof makeEnv>['tenantQueue']) => [
  ...q.send.mock.calls.map(c => c[0]),
  ...q.sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body)),
]

/** One hourly sync of the example provider, then the ingest of every bill it queued. */
async function syncAndIngest() {
  const db = drizzle(env.DB, { schema })
  const e = makeEnv()
  await runSnapshotSync(example, e.env, db)
  const messages = e.ingestor.sendBatch.mock.calls.flatMap(c => c[0])
    .map((m: any) => ({ body: m.body, ack: vi.fn(), retry: vi.fn() }))
  await processIngestorQueue({ messages } as any, e.env, db)
  for (const m of messages) expect(m.retry).not.toHaveBeenCalled()
  return { ...e, queued: messages.map((m: any) => m.body.billId as number) }
}

async function billId(number: string) {
  const db = drizzle(env.DB, { schema })
  return (await db.select().from(schema.bills).where(eq(schema.bills.billNumber, number)).get())!.billId
}

async function centralGet(path: string) {
  const { app } = await import('../../src/index-legiscan')
  const res = await app.fetch(new Request(`http://central/api${path}`, { headers: { 'x-admin-secret': 'test-secret' } }), env as any)
  expect(res.status).toBe(200)
  return res.json() as Promise<any>
}

beforeEach(async () => {
  await setupLsDb()
  vi.clearAllMocks()
  exampleFeed.records = structuredClone(records)
  const db = drizzle(env.DB, { schema })
  await db.insert(schema.tenants).values({ tenantId: 'team', name: 'Team', stateCoverage: '["ZZ"]', active: true })
  await db.insert(schema.keywordRegistry).values([{ tenantId: 'team', keyword: 'library' }])
  const { app } = await import('../../src/index-legiscan')
  const claim = await app.fetch(new Request('http://central/api/admin/state-providers/ZZ', {
    method: 'POST', headers: { 'x-admin-secret': 'test-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'example' }),
  }), env as any)
  expect(claim.status).toBe(200)
})

describe('provider extras', () => {
  it('serve in the bill\'s rich detail with the vocabulary\'s labels, in its order, under the provider\'s name', async () => {
    const { queued, tenantQueue } = await syncAndIngest()
    const enacted = await billId('B26-0001')
    const introduced = await billId('B26-0002')
    expect(queued.sort()).toEqual([enacted, introduced].sort())

    const bill = await centralGet(`/bills/legiscan:${enacted}`)
    expect(bill).toMatchObject({ number: 'B26-0001', status: 'Enacted', statusStage: 'enacted' })
    expect(bill.extras).toEqual({
      providerName: 'Example Legislature',
      fields: [
        { key: 'lawNumber', label: 'Law number', explainer: 'The number the measure took when it became law.', display: 'identifier', value: 'L26-0042' },
        { key: 'effectiveDate', label: 'Effective date', explainer: null, display: 'date', value: '2026-06-01' },
        { key: 'packet', label: 'Introduction packet', explainer: null, display: 'link', value: 'https://legislature.example/packets/B26-0001.pdf' },
      ],
    })
    // A bill whose provider published none of its extras has no panel.
    expect((await centralGet(`/bills/legiscan:${introduced}`)).extras).toBeNull()

    // Instances hear about both bills as usual.
    expect(sentToTenant(tenantQueue).map((m: any) => m.billId).sort())
      .toEqual([`legiscan:${enacted}`, `legiscan:${introduced}`].sort())
  })

  it('are replaced on every ingest, drop values that don\'t fit their display type, and notify no one by changing', async () => {
    await syncAndIngest()
    const enacted = await billId('B26-0001')
    const changesBefore = (await centralGet(`/bills/legiscan:${enacted}/changes`)).changes.length

    exampleFeed.records[0] = {
      ...exampleFeed.records[0],
      LawNumber: 'L26-0043',
      EffectiveDate: 'upon publication',      // not a date
      Packet: 'javascript:alert(1)',          // not an http(s) link
      WithdrawnBy: 'Councilmember Example',
    }
    const { queued, tenantQueue } = await syncAndIngest()
    expect(queued).toEqual([enacted])

    expect((await centralGet(`/bills/legiscan:${enacted}`)).extras.fields).toEqual([
      { key: 'lawNumber', label: 'Law number', explainer: 'The number the measure took when it became law.', display: 'identifier', value: 'L26-0043' },
      { key: 'withdrawnBy', label: 'Withdrawn by', explainer: null, display: 'text', value: 'Councilmember Example' },
    ])
    // Extras aren't change-detected: no change-log entry, and the tenant's
    // ingest notification carries no changes.
    expect((await centralGet(`/bills/legiscan:${enacted}/changes`)).changes.length).toBe(changesBefore)
    const sent = sentToTenant(tenantQueue)
    expect(sent).toHaveLength(1)
    expect(sent[0].billId).toBe(`legiscan:${enacted}`)
    expect(sent[0].changes ?? []).toEqual([])

    // A record that stops sending them clears them.
    exampleFeed.records[0] = { ...exampleFeed.records[0], LawNumber: null, WithdrawnBy: null }
    await syncAndIngest()
    expect((await centralGet(`/bills/legiscan:${enacted}`)).extras).toBeNull()
  })

  it('keep only the keys the provider\'s vocabulary declares', async () => {
    await syncAndIngest()
    const enacted = await billId('B26-0001')
    const db = drizzle(env.DB, { schema })
    const record = (await db.select().from(schema.providerRecords).where(eq(schema.providerRecords.billId, enacted)).get())!
    const built = await example.fetchMeasure({ billId: enacted, sessionId: record.sessionId, record: { raw: JSON.parse(record.rawJson), hash: record.rawHash } }, {} as never)
    if ('measure' in built) throw new Error('unexpected details response')
    await ingestMeasure({ ...built, extras: { ...built.extras, stageDirections: 'Exit, pursued by a bear' } }, example, makeEnv().env, db,
      { forceMetadata: false, forceAI: false, interactive: false })

    const fields = (await centralGet(`/bills/legiscan:${enacted}`)).extras.fields as { key: string }[]
    expect(fields.map(f => f.key)).toEqual(['lawNumber', 'effectiveDate', 'packet'])
  })
})
