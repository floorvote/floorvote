import { env } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { clearDb } from '../helpers/migrations'
import sessionRaw from '../fixtures/example/session-2026.json?raw'

// Legislators matched by Bioguide id in a cutover, and stored from a snapshot
// provider's people (#614). The state is the test-only example provider's ZZ
// (test/providers/example/), added to the registry, which lists people when a
// test sets `exampleFeed.people`. The people are invented. The checks are on
// central's admin API and the people rows a tenant's bills resolve through.
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
import { tenantQueueBindingName } from '../../src/lib/tenantQueue'
import { example, exampleFeed, type ExampleRecord } from '../providers/example'

const records = JSON.parse(sessionRaw) as ExampleRecord[]

// LegiScan's ZZ, as an instance has tracked it.
const LS_SESSION = 3150
const STATE_ID = 99
const B0001 = 2900001
const B0002 = 2900002
const SMITH = 41001      // the same Bioguide id as the new provider's, under another spelling of the name
const HART = 41002       // no Bioguide id, as LegiScan leaves it blank for many legislators
const PARK = 41003       // the same name as the new provider's, under a different Bioguide id
const ROSS_A = 41004     // two rows sharing one Bioguide id
const ROSS_B = 41005

function makeEnv() {
  const ingestor = { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn() }
  const tenantQueue = { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue(undefined) }
  return { ingestor, tenantQueue, env: { ...(env as any), INGESTOR_QUEUE: ingestor, [tenantQueueBindingName('team')]: tenantQueue } }
}

async function central(method: string, path: string, body?: unknown) {
  const { app } = await import('../../src/index-legiscan')
  return app.fetch(new Request(`http://central/api${path}`, {
    method,
    headers: { 'x-admin-secret': 'test-secret', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), makeEnv().env)
}

const cutover = (query = '') => central('POST', `/admin/state-providers/ZZ/cutover${query}`, { provider: 'example' })

async function dryRun() {
  const res = await cutover()
  const body = await res.json() as any
  expect(res.status, JSON.stringify(body)).toBe(200)
  return body
}

async function snapshotTables() {
  const tables = ['bills', 'sessions', 'people', 'provider_ids', 'provider_records', 'state_providers', 'cutovers', 'cutover_bills', 'cutover_people']
  const out: Record<string, unknown[]> = {}
  for (const t of tables) out[t] = (await env.DB.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()).results
  return out
}

const person = (id: number) => env.DB.prepare(`SELECT people_id, name, provider, bioguide_id FROM people WHERE people_id = ?`).bind(id).first<any>()

/** The new provider's people, as its feed lists them. */
const feedPeople = (): NonNullable<typeof exampleFeed.people> => [
  { key: 'M-1', name: 'Robert J. Smith Jr.', first_name: 'Robert', middle_name: 'J.', last_name: 'Smith', role: 'Rep', role_id: 1, bioguide_id: 'X000001' },
  { key: 'M-2', name: 'Eve Hart', first_name: 'Eve', last_name: 'Hart', role: 'Rep', role_id: 1, bioguide_id: 'X000002' },
  { key: 'M-3', name: 'Dee Park', first_name: 'Dee', last_name: 'Park', role: 'Rep', role_id: 1, bioguide_id: 'X000004' },
  { key: 'M-4', name: 'Gil Ross', first_name: 'Gil', last_name: 'Ross', role: 'Rep', role_id: 1, bioguide_id: 'X000005' },
]

beforeEach(async () => {
  await clearDb()
  vi.clearAllMocks()
  exampleFeed.records = structuredClone(records)
  exampleFeed.people = feedPeople()
  const db = drizzle(env.DB, { schema })
  await db.insert(schema.tenants).values({ tenantId: 'team', name: 'Team', stateCoverage: '["ZZ"]', active: true })
  await db.insert(schema.keywordRegistry).values([{ tenantId: 'team', keyword: 'library' }])
})

describe('a cutover of legislators with Bioguide ids', () => {
  beforeEach(async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.sessions).values({
      sessionId: LS_SESSION, state: 'ZZ', stateId: STATE_ID, yearStart: 2026, yearEnd: 2026, special: 0,
      sessionTitle: '2026 Regular Session', sessionName: '2026 Regular Session', slug: '2026',
    })
    const bill = (billId: number, billNumber: string, title: string) =>
      ({ billId, billNumber, title, sessionId: LS_SESSION, state: 'ZZ', stateId: STATE_ID, changeHash: 'ls-v1', status: 1 })
    await db.insert(schema.bills).values([
      bill(B0001, 'B26-0001', 'Library Hours Extension Act of 2026'),
      bill(B0002, 'B26-0002', 'Branch Library Staffing Amendment Act of 2026'),
    ])
    await db.insert(schema.billTenants).values({ billId: B0001, tenantId: 'team', matchType: 'keyword' })
    const legislator = (peopleId: number, first: string, last: string, district: string, bioguideId: string) =>
      ({ peopleId, name: `${first} ${last}`, firstName: first, lastName: last, party: 'I', role: 'Rep', roleId: 1, district, stateId: STATE_ID, bioguideId })
    await db.insert(schema.people).values([
      legislator(SMITH, 'Bob', 'Smith', 'HD-005', 'X000001'),
      legislator(HART, 'Eve', 'Hart', 'HD-004', ''),
      legislator(PARK, 'Dee', 'Park', 'HD-002', 'X000003'),
      legislator(ROSS_A, 'Gil', 'Ross', 'HD-001', 'X000005'),
      legislator(ROSS_B, 'Gil', 'Ross', 'HD-009', 'X000005'),
    ])
  })

  it('sends no ops alert from a dry run, whatever the provider raises while it is read', async () => {
    const original = example.snapshot!.bind(example)
    const spy = vi.spyOn(example, 'snapshot').mockImplementation(async (session, ctx) => {
      await ctx.alert({ subject: 'a type vanished', text: 'detail' })
      return original(session, ctx)
    })
    const sent = vi.spyOn(await import('../../src/lib/jobAlert'), 'sendOpsAlert')
    try {
      await dryRun()
      expect(spy).toHaveBeenCalled()
      expect(sent).not.toHaveBeenCalled()
    } finally { spy.mockRestore(); sent.mockRestore() }
  })

  it('reports in the dry run which legislators match by Bioguide id, and writes nothing', async () => {
    const before = await snapshotTables()
    const body = await dryRun()
    expect(await snapshotTables()).toEqual(before)

    expect(body.people).toMatchObject({ matched: 2, weak: 1, bioguide: 1 })
    expect(body.people.list).toEqual([
      // The names alone wouldn't match: Bob and Robert.
      { personId: String(SMITH), name: 'Bob Smith', as: 'Robert J. Smith Jr.', nameMatch: null, on: ['bioguide'], weak: false },
      // LegiScan has no id for her, so the names and chamber match her, as before. The feed lists no districts, so it's weak.
      { personId: String(HART), name: 'Eve Hart', as: 'Eve Hart', nameMatch: 'full', on: ['name', 'chamber'], weak: true },
    ])
    // Dee Park's ids differ, so the matching names don't match her.
    expect(body.people.unmatched.new).toEqual([{ name: 'Dee Park' }])
    expect(body.people.unmatched.old).toEqual(expect.arrayContaining([
      { personId: String(PARK), name: 'Dee Park' },
      { personId: String(ROSS_A), name: 'Gil Ross' },
      { personId: String(ROSS_B), name: 'Gil Ross' },
    ]))
    expect(body.people.unmatched.old).toHaveLength(3)
    // Two LegiScan rows share Gil Ross's id, so neither is chosen, and the dry run says why.
    expect(body.people.ambiguous).toEqual([
      { name: 'Gil Ross', candidates: [{ personId: String(ROSS_A), name: 'Gil Ross' }, { personId: String(ROSS_B), name: 'Gil Ross' }] },
    ])
    expect(body.people.sharedBioguide).toEqual([
      { side: 'old', bioguideId: 'X000005', people: [{ personId: String(ROSS_A), name: 'Gil Ross' }, { personId: String(ROSS_B), name: 'Gil Ross' }] },
    ])
  })

  it('does what the dry run reported, and carries the matched legislators\' ids over', async () => {
    const reported = await dryRun()
    const res = await cutover('?confirm=true')
    const body = await res.json() as any
    expect(res.status, JSON.stringify(body)).toBe(200)
    expect(body.people).toEqual({ matched: 2, weak: 1, bioguide: 1 })

    const rows = (await env.DB.prepare(`SELECT people_id, matched_on, weak FROM cutover_people ORDER BY people_id`).all<any>()).results
    expect(rows.map(r => [String(r.people_id), r.matched_on.split(','), !!r.weak]))
      .toEqual(reported.people.list.map((m: any) => [m.personId, m.on, m.weak]))
    expect(rows.map(r => [r.people_id, r.matched_on, r.weak])).toEqual([[SMITH, 'bioguide', 0], [HART, 'name,chamber', 1]])

    // The cutover's first pass ran: the feed's people are stored under the kept ids, with their Bioguide ids.
    expect(await person(SMITH)).toEqual({ people_id: SMITH, name: 'Robert J. Smith Jr.', provider: 'example', bioguide_id: 'X000001' })
    expect(await person(HART)).toEqual({ people_id: HART, name: 'Eve Hart', provider: 'example', bioguide_id: 'X000002' })
    const byBioguide = async (id: string) => (await env.DB.prepare(`SELECT people_id, provider FROM people WHERE bioguide_id = ? ORDER BY people_id`).bind(id).all<any>()).results
    expect(await byBioguide('X000001')).toEqual([{ people_id: SMITH, provider: 'example' }])
    // Those it didn't match stay LegiScan's, and the new provider's get new ids.
    expect(await person(PARK)).toMatchObject({ provider: 'legiscan', bioguide_id: 'X000003' })
    const parks = await byBioguide('X000004')
    expect(parks).toEqual([{ people_id: expect.any(Number), provider: 'example' }])
    expect(parks[0].people_id).not.toBe(PARK)
    expect(await byBioguide('X000005')).toEqual([
      { people_id: ROSS_A, provider: 'legiscan' },
      { people_id: ROSS_B, provider: 'legiscan' },
      { people_id: expect.any(Number), provider: 'example' },
    ])
  })

  it('reports the same thing on a second dry run, and keeps the ids on later passes', async () => {
    const first = await dryRun()
    expect(first.people.bioguide).toBe(1)
    expect(await dryRun()).toEqual(first)

    expect((await cutover('?confirm=true')).status).toBe(200)
    // A second cutover to the same provider is refused, and writes nothing.
    const before = await snapshotTables()
    expect((await cutover('?confirm=true')).status).toBe(409)
    expect(await snapshotTables()).toEqual(before)

    // The hourly passes after it give the matched legislators the same kept ids.
    const db = drizzle(env.DB, { schema })
    await runSnapshotSync(example, makeEnv().env, db, { force: true })
    await runSnapshotSync(example, makeEnv().env, db)
    expect((await env.DB.prepare(`SELECT * FROM people ORDER BY rowid`).all()).results).toEqual(before.people)
    expect(await person(SMITH)).toEqual({ people_id: SMITH, name: 'Robert J. Smith Jr.', provider: 'example', bioguide_id: 'X000001' })
  })
})

describe('a snapshot provider\'s people', () => {
  beforeEach(async () => {
    const claim = await central('POST', '/admin/state-providers/ZZ', { provider: 'example' })
    expect(claim.status).toBe(200)
  })

  async function sync() {
    await runSnapshotSync(example, makeEnv().env, drizzle(env.DB, { schema }), { force: true })
  }
  const storedBioguide = async (name: string) =>
    (await env.DB.prepare(`SELECT bioguide_id FROM people WHERE name = ? AND provider = 'example'`).bind(name).first<any>())?.bioguide_id

  it('store their Bioguide ids', async () => {
    await sync()
    expect(await storedBioguide('Robert J. Smith Jr.')).toBe('X000001')
    expect(await storedBioguide('Gil Ross')).toBe('X000005')
  })

  it('keep a stored Bioguide id when the feed leaves it out, and clear it when the feed says null', async () => {
    await sync()
    exampleFeed.people = feedPeople().map(p => {
      if (p.key === 'M-1') { const { bioguide_id: _gone, ...rest } = p; return rest }
      if (p.key === 'M-2') return { ...p, bioguide_id: null }
      if (p.key === 'M-3') return { ...p, bioguide_id: 'X000009' }
      return p
    })
    await sync()
    expect(await storedBioguide('Robert J. Smith Jr.')).toBe('X000001')
    expect(await storedBioguide('Eve Hart')).toBeNull()
    expect(await storedBioguide('Dee Park')).toBe('X000009')
  })
})
