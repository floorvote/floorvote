import { env } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from '../../src/db/schema'
import { clearDb } from '../helpers/migrations'

// Partial snapshots (ProviderSnapshot.partial): a provider answers the ETag
// core handed it with only the records that changed since. Driven through
// runSnapshotSync with the test-only example provider against a migrated D1,
// with the ingest run for real, and checked through central's bill API, the
// stored records and ETag, and what the instances are sent.
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
import { processIngestorQueue } from '../../src/queue/processor'
import { tenantQueueBindingName } from '../../src/lib/tenantQueue'
import { example, exampleFeed, type ExampleRecord } from '../providers/example'

const rec = (Number: string, Title: string, Status: ExampleRecord['Status'] = 'Introduced'): ExampleRecord => ({
  Number, Title, Status, Introduced: '2026-01-13', Page: `https://legislature.example/bills/${Number}`,
  LawNumber: null, EffectiveDate: null, Packet: null, WithdrawnBy: null, InternalId: 0, Attachments: [],
})
// A and B match the instance's keyword ("library"), C matches none.
const A = rec('B26-0001', 'Library Hours Extension Act of 2026')
const B = rec('B26-0002', 'Branch Library Staffing Amendment Act of 2026')
const C = rec('B26-0003', 'Parks Maintenance Act of 2026')
const B2 = { ...B, Title: 'Branch Library Staffing and Hours Amendment Act of 2026', Status: 'Enacted' as const }

const TENANTS = ['team', 'newcomer'] as const

function makeEnv(opts: { ingestorFails?: boolean }) {
  const ingestor = {
    sendBatch: opts.ingestorFails ? vi.fn().mockRejectedValue(new Error('queue unavailable')) : vi.fn().mockResolvedValue(undefined),
    send: vi.fn(),
  }
  const queues = Object.fromEntries(TENANTS.map(t =>
    [t, { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue(undefined) }]))
  return {
    ingestor, queues,
    env: {
      ...(env as any), INGESTOR_QUEUE: ingestor, ADMIN_SECRET: 'test-secret',
      ...Object.fromEntries(TENANTS.map(t => [tenantQueueBindingName(t), queues[t]])),
    },
  }
}

const sentTo = (q: { send: any; sendBatch: any }) => [
  ...q.send.mock.calls.map((c: any) => c[0]),
  ...q.sendBatch.mock.calls.flatMap((c: any) => c[0].map((m: any) => m.body)),
]

/**
 * One hourly sync of the example provider, then the ingest of every bill it
 * queued (unless `ingest` is false, as when the ingests fail). Returns the
 * pass reports, the bills queued, and what each instance was sent.
 */
async function pass(opts: { force?: boolean; ingestorFails?: boolean; ingest?: boolean; db?: ReturnType<typeof drizzle<typeof schema>> } = {}) {
  const db = drizzle(env.DB, { schema })
  const e = makeEnv(opts)
  const reports = await runSnapshotSync(example, e.env, opts.db ?? db, { force: opts.force })
  const messages = e.ingestor.sendBatch.mock.calls.flatMap((c: any) => c[0])
    .map((m: any) => ({ body: m.body, ack: vi.fn(), retry: vi.fn() }))
  if (opts.ingest !== false) {
    await processIngestorQueue({ messages } as any, e.env, db)
    for (const m of messages) expect(m.retry).not.toHaveBeenCalled()
  }
  return {
    reports,
    queued: messages.map((m: any) => m.body.billId as number).sort(),
    sent: (t: typeof TENANTS[number]) => sentTo(e.queues[t]),
  }
}

/** Set what the example feed answers next. */
function feed(f: { records: ExampleRecord[]; etag?: string | null; partial?: boolean; unchanged?: boolean; hold?: () => Promise<void> }) {
  exampleFeed.records = structuredClone(f.records)
  exampleFeed.etag = f.etag
  exampleFeed.partial = f.partial
  exampleFeed.unchanged = f.unchanged
  exampleFeed.hold = f.hold
}

/** The session's first read: A, B, and C in full, at watermark w1. */
async function readInFull() {
  feed({ records: [A, B, C], etag: 'w1' })
  const first = await pass()
  expect(first.reports).toMatchObject([{ records: 3 }])
  expect(await storedEtag()).toBe('w1')
  return first
}

async function storedEtag() {
  const row = await env.DB.prepare(`SELECT snapshot_etag FROM sessions WHERE provider = 'example'`).first<{ snapshot_etag: string | null }>()
  return row!.snapshot_etag
}

async function billId(number: string) {
  const db = drizzle(env.DB, { schema })
  return (await db.select().from(schema.bills).where(eq(schema.bills.billNumber, number)).get())!.billId
}

/** Each stored record's title, by bill number. */
async function storedTitles() {
  const db = drizzle(env.DB, { schema })
  const rows = await db.select().from(schema.providerRecords).all()
  return Object.fromEntries(rows.map(r => [r.nativeKey, (JSON.parse(r.rawJson) as ExampleRecord).Title]))
}

async function centralGet(path: string) {
  const { app } = await import('../../src/index-legiscan')
  const res = await app.fetch(new Request(`http://central/api${path}`, { headers: { 'x-admin-secret': 'test-secret' } }), env as any)
  expect(res.status).toBe(200)
  return res.json() as Promise<any>
}

/** Each bill's title and status as central's bill API serves it, by number. */
async function served(...numbers: string[]) {
  const out: Record<string, [string, string]> = {}
  for (const n of numbers) {
    const bill = await centralGet(`/bills/legiscan:${await billId(n)}`)
    out[n] = [bill.title, bill.status]
  }
  return out
}

async function links(tenantId: string) {
  const rows = await env.DB.prepare(`SELECT b.bill_number AS n, bt.match_type AS m FROM bill_tenants bt
    JOIN bills b ON b.bill_id = bt.bill_id WHERE bt.tenant_id = ? ORDER BY b.bill_number`).bind(tenantId).all<{ n: string; m: string | null }>()
  return Object.fromEntries(rows.results.map(r => [r.n, r.m]))
}

async function addNewcomer() {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO tenants (tenant_id, name, state_coverage, active) VALUES ('newcomer', 'Newcomer', '["ZZ"]', 1)`),
    env.DB.prepare(`INSERT INTO keyword_registry (tenant_id, keyword) VALUES ('newcomer', 'library')`),
  ])
}

const ORIGINAL = {
  'B26-0001': ['Library Hours Extension Act of 2026', 'Introduced'],
  'B26-0002': ['Branch Library Staffing Amendment Act of 2026', 'Introduced'],
  'B26-0003': ['Parks Maintenance Act of 2026', 'Introduced'],
}

beforeEach(async () => {
  await clearDb()
  vi.clearAllMocks()
  feed({ records: [] })
  exampleFeed.asked = []
  const db = drizzle(env.DB, { schema })
  await db.insert(schema.tenants).values({ tenantId: 'team', name: 'Team', stateCoverage: '["ZZ"]', active: true })
  await db.insert(schema.keywordRegistry).values([{ tenantId: 'team', keyword: 'library' }])
  const { app } = await import('../../src/index-legiscan')
  const claim = await app.fetch(new Request('http://central/api/admin/state-providers/ZZ', {
    method: 'POST', headers: { 'x-admin-secret': 'test-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'example' }),
  }), { ...(env as any), ADMIN_SECRET: 'test-secret' })
  expect(claim.status).toBe(200)
})

describe('a partial snapshot', () => {
  it('replaces the records it names, leaves the rest as stored, and the pass covers all of them', async () => {
    await readInFull()
    feed({ records: [B2], etag: 'w2', partial: true })
    const { reports } = await pass()

    expect(exampleFeed.asked).toEqual([null, 'w1'])
    expect(reports).toMatchObject([{ records: 3 }])
    expect(await storedTitles()).toEqual({
      'B26-0001': A.Title, 'B26-0002': B2.Title, 'B26-0003': C.Title,
    })
    expect(await served('B26-0001', 'B26-0002', 'B26-0003')).toEqual({
      ...ORIGINAL, 'B26-0002': [B2.Title, 'Enacted'],
    })
    expect(await storedEtag()).toBe('w2')
  })

  it('stores a record new to the session, gives it a bill row, and queues it like any new bill', async () => {
    await readInFull()
    const D = rec('B26-0004', 'Library Card Fee Waiver Act of 2026')
    feed({ records: [D], etag: 'w2', partial: true })
    const { reports, queued, sent } = await pass()

    expect(reports).toMatchObject([{ records: 4 }])
    const d = await billId('B26-0004')
    expect(queued).toEqual([d])
    expect(sent('team').map((m: any) => m.billId)).toContain(`legiscan:${d}`)
    expect(await storedTitles()).toMatchObject({ 'B26-0004': D.Title })
    expect(await served('B26-0001', 'B26-0004')).toEqual({
      'B26-0001': ORIGINAL['B26-0001'], 'B26-0004': [D.Title, 'Introduced'],
    })
  })

  it('with no records runs the pass on the stored records, linking a newly covering instance, and stores the new ETag', async () => {
    await readInFull()
    await addNewcomer()
    feed({ records: [], etag: 'w2', partial: true })
    const { reports, sent } = await pass()

    expect(reports).toMatchObject([{ records: 3, queued: 2 }])
    expect(await links('newcomer')).toEqual({ 'B26-0001': 'keyword', 'B26-0002': 'keyword', 'B26-0003': null })
    // The unmatched bill reaches the newcomer as a monitor stub.
    expect(sent('newcomer').map((m: any) => m.billId)).toContain(`legiscan:${await billId('B26-0003')}`)
    expect(await storedEtag()).toBe('w2')
  })

  it('queues a tracked bill it changes, whose change reaches the instance, and doesn\'t re-queue an unchanged one', async () => {
    await readInFull()
    feed({ records: [B2], etag: 'w2', partial: true })
    const { reports, queued, sent } = await pass()

    const b = await billId('B26-0002')
    expect(reports).toMatchObject([{ records: 3, queued: 1 }])
    expect(queued).toEqual([b])
    const toTeam = sent('team')
    expect(toTeam.map((m: any) => m.billId)).toEqual([`legiscan:${b}`])
    expect(toTeam[0].changes.map((c: any) => [c.changeType, c.newValue])).toEqual(expect.arrayContaining([
      ['status_change', 'Enacted'], ['title_changed', B2.Title],
    ]))
  })

  it('re-queues a tracked bill whose ingest failed, though the partial snapshot doesn\'t name it', async () => {
    await readInFull()
    const A2 = { ...A, Title: 'Library Hours and Access Extension Act of 2026' }
    feed({ records: [A2], etag: 'w2', partial: true })
    const failed = await pass({ ingest: false })
    const a = await billId('B26-0001')
    expect(failed.queued).toEqual([a])

    feed({ records: [], etag: 'w3', partial: true })
    const { reports, queued } = await pass()
    expect(reports).toMatchObject([{ records: 3 }])
    expect(queued).toEqual([a])
    expect(await served('B26-0001')).toEqual({ 'B26-0001': [A2.Title, 'Introduced'] })
    expect(await storedEtag()).toBe('w3')
  })
})

describe('a partial snapshot that answers a read in full', () => {
  it('on a forced run throws, writes no records, and leaves the stored ETag', async () => {
    await readInFull()
    feed({ records: [B2], etag: 'w2', partial: true })
    await expect(pass({ force: true })).rejects.toThrow(/partial/)

    expect(exampleFeed.asked).toEqual([null, null])
    expect(await storedTitles()).toEqual({ 'B26-0001': A.Title, 'B26-0002': B.Title, 'B26-0003': C.Title })
    expect(await served('B26-0001', 'B26-0002', 'B26-0003')).toEqual(ORIGINAL)
    expect(await storedEtag()).toBe('w1')
  })

  it('on a session\'s first read (no stored ETag) throws and writes nothing', async () => {
    feed({ records: [A, B, C], etag: 'w1', partial: true })
    await expect(pass()).rejects.toThrow(/partial/)

    expect(exampleFeed.asked).toEqual([null])
    expect(await storedTitles()).toEqual({})
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM bills').first<{ n: number }>())!.n).toBe(0)
    expect(await storedEtag()).toBeNull()
  })
})

describe('a pass that fails after a partial snapshot', () => {
  it('keeps the stored ETag, drops no bill, and the retry asks again from the old watermark', async () => {
    await readInFull()
    feed({ records: [B2], etag: 'w2', partial: true })
    await expect(pass({ ingestorFails: true })).rejects.toThrow(/queue unavailable/)

    expect(await storedEtag()).toBe('w1')
    const afterFailure = await served('B26-0001', 'B26-0002', 'B26-0003')
    expect(afterFailure['B26-0001']).toEqual(ORIGINAL['B26-0001'])
    expect(afterFailure['B26-0003']).toEqual(ORIGINAL['B26-0003'])

    // The provider answers the old watermark with the same change again.
    const { reports, queued } = await pass()
    expect(exampleFeed.asked).toEqual([null, 'w1', 'w1'])
    expect(reports).toMatchObject([{ records: 3 }])
    expect(queued).toEqual([await billId('B26-0002')])
    expect(await served('B26-0001', 'B26-0002', 'B26-0003')).toEqual({
      ...ORIGINAL, 'B26-0002': [B2.Title, 'Enacted'],
    })
    expect(await storedEtag()).toBe('w2')
  })
})

describe('partial snapshots fail closed', () => {
  it('a snapshot both partial and unchanged throws, writes nothing, and keeps the ETag', async () => {
    await readInFull()
    feed({ records: [B2], etag: 'w2', partial: true, unchanged: true })
    await expect(pass()).rejects.toThrow(/partial/)

    expect(await storedTitles()).toEqual({ 'B26-0001': A.Title, 'B26-0002': B.Title, 'B26-0003': C.Title })
    expect(await storedEtag()).toBe('w1')
  })

  it('a partial snapshot with no ETag of its own leaves none, so the next pass reads in full', async () => {
    await readInFull()
    feed({ records: [B2], partial: true })
    const { reports } = await pass()
    expect(reports).toMatchObject([{ records: 3 }])
    expect(await storedEtag()).toBeNull()

    feed({ records: [A, B2, C], etag: 'w3' })
    await pass()
    expect(exampleFeed.asked).toEqual([null, 'w1', null])
    expect(await storedEtag()).toBe('w3')
  })

  // Pinned: core can't tell a provider that leaves out records it didn't
  // declare partial from a full snapshot, so it treats the answer as full.
  // That is safe because core never removes a record a full snapshot leaves
  // out either: the omitted bills stay stored and served, and only miss this
  // pass's matching.
  it('a provider returning only changes without declaring it is treated as a full snapshot, and removes nothing', async () => {
    await readInFull()
    feed({ records: [B2], etag: 'w2' })
    const { reports } = await pass()

    expect(reports).toMatchObject([{ records: 1 }])
    expect(await storedTitles()).toEqual({ 'B26-0001': A.Title, 'B26-0002': B2.Title, 'B26-0003': C.Title })
    expect(await served('B26-0001', 'B26-0002', 'B26-0003')).toEqual({ ...ORIGINAL, 'B26-0002': [B2.Title, 'Enacted'] })
    expect(await storedEtag()).toBe('w2')
  })
})

describe('a full snapshot after partial ones', () => {
  it('replaces the partial watermark, applies changes the partials missed, and keeps a bill the feed dropped', async () => {
    await readInFull()
    feed({ records: [B2], etag: 'w2', partial: true })
    await pass()
    feed({ records: [], etag: 'w3', partial: true })
    await pass()
    expect(await storedEtag()).toBe('w3')

    // A changed without the partials naming it, and the feed no longer lists C.
    const A3 = { ...A, Title: 'Library Hours Extension and Repeal Act of 2026' }
    feed({ records: [A3, B2], etag: 'w4' })
    const { reports, queued } = await pass({ force: true })
    expect(exampleFeed.asked).toEqual([null, 'w1', 'w2', null])
    expect(reports).toMatchObject([{ records: 2 }])
    expect(queued).toEqual([await billId('B26-0001')])
    // Core never removes a snapshot record: C stays stored and served.
    expect(await storedTitles()).toEqual({ 'B26-0001': A3.Title, 'B26-0002': B2.Title, 'B26-0003': C.Title })
    expect(await served('B26-0001', 'B26-0002', 'B26-0003')).toEqual({
      'B26-0001': [A3.Title, 'Introduced'], 'B26-0002': [B2.Title, 'Enacted'], 'B26-0003': ORIGINAL['B26-0003'],
    })
    expect(await storedEtag()).toBe('w4')

    feed({ records: [], etag: 'w5', partial: true })
    await pass()
    expect(exampleFeed.asked.at(-1)).toBe('w4')
  })
})

describe('concurrent partial and full passes', () => {
  /** A hold the feed waits on, and the release for it. */
  function gate() {
    let release!: () => void
    const held = new Promise<void>(r => { release = r })
    return { hold: () => held, release }
  }

  it('a full pass that finishes while a partial one is held leaves no watermark, so the next pass reads in full', async () => {
    await readInFull()
    const g = gate()
    feed({ records: [B2], etag: 'w2', partial: true, hold: g.hold })
    const partialPass = pass()
    await vi.waitFor(() => expect(exampleFeed.asked).toEqual([null, 'w1']))

    feed({ records: [A, B2, C], etag: 'w3' })
    await pass({ force: true })
    expect(await storedEtag()).toBe('w3')

    g.release()
    await partialPass
    expect(await storedEtag()).toBeNull()
    expect(await served('B26-0001', 'B26-0002', 'B26-0003')).toEqual({ ...ORIGINAL, 'B26-0002': [B2.Title, 'Enacted'] })

    feed({ records: [A, B2, C], etag: 'w4' })
    await pass()
    expect(exampleFeed.asked).toEqual([null, 'w1', null, null])
    expect(await storedEtag()).toBe('w4')
  })

  it('a partial pass that finishes while a full one is held leaves no watermark, so the next pass reads in full', async () => {
    await readInFull()
    const g = gate()
    feed({ records: [A, B, C], etag: 'w2', hold: g.hold })
    const fullPass = pass({ force: true })
    await vi.waitFor(() => expect(exampleFeed.asked).toEqual([null, null]))

    feed({ records: [B2], etag: 'w3', partial: true })
    await pass()
    expect(await storedEtag()).toBe('w3')

    // The held full read is older than the partial's change, and lands last.
    g.release()
    await fullPass
    expect(await storedEtag()).toBeNull()
    expect(await served('B26-0001', 'B26-0003')).toEqual({ 'B26-0001': ORIGINAL['B26-0001'], 'B26-0003': ORIGINAL['B26-0003'] })

    feed({ records: [A, B2, C], etag: 'w4' })
    await pass()
    expect(exampleFeed.asked.at(-1)).toBeNull()
    expect(await served('B26-0002')).toEqual({ 'B26-0002': [B2.Title, 'Enacted'] })
    expect(await storedEtag()).toBe('w4')
  })
})

/**
 * A db over the test D1 that, the first time a statement whose SQL matches
 * `pattern` runs, signals `reached` and waits for `release` first: a way to
 * stop a pass between two of its queries while another pass runs.
 */
function heldDb(pattern: RegExp) {
  let armed = true
  let signal!: () => void
  let release!: () => void
  const reached = new Promise<void>(r => { signal = r })
  const released = new Promise<void>(r => { release = r })
  const wait = async () => { signal(); await released }
  const wrap = (stmt: any): any => ({
    bind: (...params: unknown[]) => wrap(stmt.bind(...params)),
    all: async (...a: unknown[]) => { await wait(); return stmt.all(...a) },
    raw: async (...a: unknown[]) => { await wait(); return stmt.raw(...a) },
    first: async (...a: unknown[]) => { await wait(); return stmt.first(...a) },
    run: async (...a: unknown[]) => { await wait(); return stmt.run(...a) },
  })
  const d1 = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (query: string) => {
          const stmt = target.prepare(query)
          if (!armed || !pattern.test(query)) return stmt
          armed = false
          return wrap(stmt)
        }
      }
      const value = (target as any)[prop]
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { db: drizzle(d1 as D1Database, { schema }), reached, release }
}

/** Each stored record's updated_at, by bill number. */
async function storedUpdatedAt() {
  const rows = await env.DB.prepare('SELECT native_key, updated_at FROM provider_records').all<{ native_key: string; updated_at: string }>()
  return Object.fromEntries(rows.results.map(r => [r.native_key, r.updated_at]))
}

describe('a pass that matches on stored records', () => {
  // The hash read in storeRecords, and the ETag compare-and-swap.
  const HASH_READ = /"raw_hash" from "provider_records" where "provider_records"."bill_id" in/
  const ETAG_SWAP = /^update "sessions" set "snapshot_etag"/

  // An unchanged pass, and a partial one whose watermark didn't move, rewrite
  // the ETag they read, so the compare-and-swap can't see a forced run that
  // committed a change between their read of the stored records and their
  // own write. Neither may write back a record it read from storage.
  it.each([
    ['an unchanged pass', { records: [], unchanged: true }],
    ['a partial pass whose watermark didn\'t move', { records: [], etag: 'w1', partial: true }],
  ])('%s never writes a stored record back over a forced run\'s change', async (_name, answer) => {
    await readInFull()
    const held = heldDb(HASH_READ)
    feed(answer)
    const cron = pass({ db: held.db })
    await held.reached

    // A forced run stores B2, and stops before its ETag swap.
    const forcedDb = heldDb(ETAG_SWAP)
    feed({ records: [A, B2, C], etag: 'w3' })
    const forced = pass({ force: true, db: forcedDb.db })
    await forcedDb.reached
    expect(await storedTitles()).toMatchObject({ 'B26-0002': B2.Title })

    // The cron pass finishes first, then the forced run.
    held.release()
    await cron
    forcedDb.release()
    await forced

    expect(await storedTitles()).toEqual({ 'B26-0001': A.Title, 'B26-0002': B2.Title, 'B26-0003': C.Title })
    expect(await served('B26-0002')).toEqual({ 'B26-0002': [B2.Title, 'Enacted'] })
  })

  it('an unchanged pass writes no stored record, and a partial one writes only those it names', async () => {
    await readInFull()
    await env.DB.prepare(`UPDATE provider_records SET updated_at = '2000-01-01 00:00:00'`).run()
    const sentinel = { 'B26-0001': '2000-01-01 00:00:00', 'B26-0002': '2000-01-01 00:00:00', 'B26-0003': '2000-01-01 00:00:00' }

    feed({ records: [], unchanged: true })
    await pass()
    expect(await storedUpdatedAt()).toEqual(sentinel)

    feed({ records: [B2], etag: 'w2', partial: true })
    await pass()
    const after = await storedUpdatedAt()
    expect(after['B26-0002']).not.toBe('2000-01-01 00:00:00')
    expect(after).toMatchObject({ 'B26-0001': sentinel['B26-0001'], 'B26-0003': sentinel['B26-0003'] })
  })
})
