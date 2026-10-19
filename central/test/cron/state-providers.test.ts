// Main seam for state ownership (#292): recorded LIMS and MGA fixtures with
// every feed stubbed, claims through the admin API, and the hourly syncs run
// into a migrated central D1. Checked only through what an operator or an
// instance sees: the admin API's answers, which feeds each sync calls, and
// the bills queued for ingest.
import { env } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { clearDb } from '../helpers/migrations'
import bulkRaw from '../fixtures/lims/bulk-records.json?raw'
import details0400Raw from '../fixtures/lims/details-B26-0400.json?raw'
import membersRaw from '../fixtures/lims/members-26.json?raw'
import mgaSampleRaw from '../fixtures/mga/2026RS-sample.json?raw'

vi.mock('../../src/providers/lims/client', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/lims/client')>('../../src/providers/lims/client')
  return { ...actual, getCouncilPeriods: vi.fn(), getMembers: vi.fn(), getBulkData: vi.fn(), getLegislationDetails: vi.fn() }
})
vi.mock('../../src/providers/mga/client', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/mga/client')>('../../src/providers/mga/client')
  return { ...actual, getMgaSession: vi.fn(), mgaSessionExists: vi.fn() }
})
vi.mock('../../src/providers/legiscan/client', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/legiscan/client')>('../../src/providers/legiscan/client')
  return { ...actual, getBill: vi.fn(), getBillText: vi.fn(), getSessionList: vi.fn().mockResolvedValue([]),
    getMasterListBySession: vi.fn().mockResolvedValue([]), getMasterListRaw: vi.fn().mockResolvedValue([]) }
})
vi.mock('../../src/lib/sync-schedule', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/sync-schedule')>('../../src/lib/sync-schedule')
  return { ...actual, getCurrentEtHour: vi.fn(() => 5) }
})
vi.stubGlobal('fetch', vi.fn())

import { app } from '../../src/index-legiscan'
import { runSnapshotSync } from '../../src/cron/sync-snapshots'
import { runSync } from '../../src/cron/sync'
import { lims as limsProvider } from '../../src/providers/lims'
import { mga as mgaProvider } from '../../src/providers/mga'
import * as lims from '../../src/providers/lims/client'
import * as mga from '../../src/providers/mga/client'
import * as legiscan from '../../src/providers/legiscan/client'
import { limsBillId, limsSessionId } from '../../src/providers/lims/ids'
import { nowDb } from '../../src/lib/dbTime'
import { tenantQueueBindingName } from '../../src/lib/tenantQueue'

const db = drizzle(env.DB, { schema })
const bulk = JSON.parse(bulkRaw) as Record<string, lims.LimsBulkRecord>
const PERIOD = { councilPeriodId: 26, councilPeriod: '26 (2025-26)', startDate: '2025-01-02T00:00:00', endDate: '2026-12-31T00:00:00' }
const MGA_CODE = `${nowDb().slice(0, 4)}RS`
/** A LegiScan DC session, which the LegiScan sync pulls while DC is LegiScan's. */
const LS_DC_SESSION = 2150

function makeEnv(extra: Record<string, unknown> = {}) {
  const limsQueue = { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn() }
  const ingestor = { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn() }
  const tenantQueue = { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue(undefined) }
  return {
    limsQueue, ingestor, tenantQueue,
    env: {
      ...(env as any),
      ADMIN_SECRET: 'test-secret',
      LIMS_API_KEY: 'lims-key', LIMS_CATEGORIES: '1,18',
      LIMS_INGESTOR_QUEUE: limsQueue,
      INGESTOR_QUEUE: ingestor,
      [tenantQueueBindingName('oca')]: tenantQueue,
      [tenantQueueBindingName('team')]: tenantQueue,
      ...extra,
    },
  }
}

const queuedIds = (q: { sendBatch: ReturnType<typeof vi.fn> }) =>
  q.sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body.billId)).sort()

async function claim(e: any, state: string, body: unknown) {
  return app.fetch(new Request(`http://central/api/admin/state-providers/${state}`, {
    method: 'POST',
    headers: { 'x-admin-secret': 'test-secret', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), e)
}

async function ownership(e: any) {
  const res = await app.fetch(new Request('http://central/api/admin/state-providers', {
    headers: { 'x-admin-secret': 'test-secret' },
  }), e)
  expect(res.status).toBe(200)
  return res.json() as Promise<{ defaultProvider: string; states: { state: string; provider: string; status: string; previousProvider: string | null; claimedAt: string }[] }>
}

/** A LegiScan DC bill linked to an instance, as an instance tracking DC on LegiScan has hundreds of. */
async function trackLegiscanDcBill(billId: number, tenantId: string, matchType: string | null) {
  await db.insert(schema.bills).values({ billId, changeHash: 'h', sessionId: LS_DC_SESSION, state: 'DC', stateId: 51, billNumber: `B26-${billId}`, title: 't' })
    .onConflictDoNothing()
  await db.insert(schema.billTenants).values({ billId, tenantId, matchType })
}

/** A LIMS DC bill linked to an instance, as on a central that already reads DC from LIMS. */
async function trackLimsDcBill(number: string, tenantId: string) {
  const billId = limsBillId(number)!
  await db.insert(schema.sessions).values({ sessionId: limsSessionId(26), state: 'DC', stateId: 51, yearStart: 2025, yearEnd: 2026, sessionTag: 'CP26', sessionTitle: 'CP26', sessionName: 'CP26', provider: 'lims' })
    .onConflictDoNothing()
  await db.insert(schema.bills).values({ billId, changeHash: 'h', sessionId: limsSessionId(26), state: 'DC', stateId: 51, billNumber: number, title: 't', provider: 'lims' })
    .onConflictDoNothing()
  await db.insert(schema.billTenants).values({ billId, tenantId, matchType: 'keyword' })
}

/** The states the LegiScan sync asked LegiScan about (its 5 ET session refresh). */
const legiscanStates = () => vi.mocked(legiscan.getSessionList).mock.calls.map(c => c[0]).sort()

/** Logged lines that match, from a console spy. */
const logged = (spy: { mock: { calls: unknown[][] } }, pattern: RegExp) =>
  spy.mock.calls.map(c => c.map(String).join(' ')).filter(line => pattern.test(line))

beforeEach(async () => {
  await clearDb()
  vi.clearAllMocks()
  vi.mocked(lims.getCouncilPeriods).mockResolvedValue([PERIOD])
  vi.mocked(lims.getMembers).mockResolvedValue(JSON.parse(membersRaw))
  vi.mocked(lims.getBulkData).mockImplementation(async (categoryId: number) =>
    categoryId === 1 ? [bulk['B26-0400'], bulk['B26-0769'], bulk['B26-0001']]
      : categoryId === 18 ? [bulk['HN26-0171']] : [])
  vi.mocked(lims.getLegislationDetails).mockResolvedValue(JSON.parse(details0400Raw))
  vi.mocked(mga.mgaSessionExists).mockImplementation(async code => code === MGA_CODE)
  vi.mocked(mga.getMgaSession).mockImplementation(async code =>
    (code === MGA_CODE ? { unchanged: false, records: JSON.parse(mgaSampleRaw), etag: null } : null))
  await db.insert(schema.tenants).values([
    { tenantId: 'oca', name: 'OCA', stateCoverage: '["DC"]', active: true },
    { tenantId: 'team', name: 'Team', stateCoverage: '["DC","MD"]', active: true },
  ])
  await db.insert(schema.keywordRegistry).values([
    { tenantId: 'oca', keyword: 'neglect' }, { tenantId: 'oca', keyword: 'behavioral health' },
    { tenantId: 'team', keyword: 'cost recovery' },
  ])
  await db.insert(schema.sessions).values({ sessionId: LS_DC_SESSION, state: 'DC', stateId: 51, yearStart: 2025, yearEnd: 2026, sessionTitle: 'Council Period 26', sessionName: 'Council Period 26' })
})

afterEach(() => vi.restoreAllMocks())

describe('claiming a state for a provider', () => {
  it('gives a state with no tracked bills to the provider, which syncs it from then on, and LegiScan lets it go', async () => {
    const { env: e, limsQueue } = makeEnv()

    // No row: DC is LegiScan's, and LIMS syncs nothing though its key is set.
    expect(await ownership(e)).toEqual({ defaultProvider: 'legiscan', states: [] })
    expect(await runSnapshotSync(limsProvider, e, db)).toEqual([])
    expect(lims.getCouncilPeriods).not.toHaveBeenCalled()

    const res = await claim(e, 'dc', { provider: 'lims' })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body).toMatchObject({ ok: true, changed: true,
      ownership: { state: 'DC', provider: 'lims', status: 'active', previousProvider: 'legiscan' } })
    expect(body.ownership.claimedAt).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/)
    expect((await ownership(e)).states).toEqual([body.ownership])

    const passes = await runSnapshotSync(limsProvider, e, db)
    expect(passes).toEqual([expect.objectContaining({ sessionId: limsSessionId(26), records: 4 })])
    expect(queuedIds(limsQueue)).toEqual([limsBillId('B26-0400')!, limsBillId('HN26-0171')!].sort())

    await runSync(e, db)
    expect(legiscan.getMasterListBySession).not.toHaveBeenCalled()
    // MD is still LegiScan's: only DC was claimed.
    expect(legiscanStates()).toEqual(['MD'])
  })

  it('changes nothing when the state already has that provider', async () => {
    const { env: e } = makeEnv()
    const res = await claim(e, 'DC', { provider: 'legiscan' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, changed: false,
      ownership: { state: 'DC', provider: 'legiscan', status: 'active', previousProvider: null, claimedAt: null } })
    expect((await ownership(e)).states).toEqual([])
  })

  it('is refused while the owner has tracked bills, naming the owner, the count, and the instances, and the row stays as it was', async () => {
    const { env: e } = makeEnv()
    await trackLegiscanDcBill(9001, 'oca', 'keyword')
    await trackLegiscanDcBill(9001, 'team', 'manual')
    await trackLegiscanDcBill(9002, 'team', null)   // a monitor link counts: the instance holds the bill too

    const res = await claim(e, 'DC', { provider: 'lims' })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ owner: 'legiscan', trackedBills: 2, instances: ['oca', 'team'], error: expect.stringMatching(/cutover/) })
    expect((await ownership(e)).states).toEqual([])
  })

  it('is refused for a state another provider owns while that provider has tracked bills', async () => {
    const { env: e, limsQueue } = makeEnv()
    expect((await claim(e, 'DC', { provider: 'lims' })).status).toBe(200)
    await runSnapshotSync(limsProvider, e, db)
    expect(queuedIds(limsQueue).length).toBe(2)
    const before = await ownership(e)

    const res = await claim(e, 'DC', { provider: 'legiscan' })
    expect(res.status).toBe(409)
    // Every LIMS bill in DC got a link, monitor or matched, for each instance covering DC.
    expect(await res.json()).toMatchObject({ owner: 'lims', trackedBills: 4, instances: ['oca', 'team'] })
    expect(await ownership(e)).toEqual(before)
  })

  it('keeps a refused state syncing from its owner, and the refused provider syncs nothing', async () => {
    const { env: e, limsQueue } = makeEnv()
    await trackLegiscanDcBill(9001, 'oca', 'keyword')
    expect((await claim(e, 'DC', { provider: 'lims' })).status).toBe(409)

    // The contributor's guard threw here and paused DC in both syncs. Now LIMS
    // simply owns nothing, and LegiScan carries on with DC.
    expect(await runSnapshotSync(limsProvider, e, db)).toEqual([])
    expect(lims.getBulkData).not.toHaveBeenCalled()
    expect(limsQueue.sendBatch).not.toHaveBeenCalled()

    await runSync(e, db)
    expect(legiscanStates()).toEqual(['DC', 'MD'])
    expect(vi.mocked(legiscan.getMasterListBySession).mock.calls.map(c => c[0])).toEqual([LS_DC_SESSION])
  })

  it('checks its input and the provider', async () => {
    const { env: e } = makeEnv()
    expect((await claim(e, 'DC', {})).status).toBe(400)
    expect((await claim(e, 'DC', null)).status).toBe(400)
    expect((await claim(e, 'DC', { provider: 'nope' })).status).toBe(400)
    expect((await claim(e, 'DCX', { provider: 'lims' })).status).toBe(400)
    // LIMS serves DC only.
    expect((await claim(e, 'MD', { provider: 'lims' })).status).toBe(400)
    // Without its API key LIMS can't run, and DC would go dark.
    expect((await claim(makeEnv({ LIMS_API_KEY: undefined }).env, 'DC', { provider: 'lims' })).status).toBe(400)
    expect((await ownership(e)).states).toEqual([])
  })

  it('must come first for a LIMS import, which links bills only in states LIMS owns', async () => {
    const { env: e } = makeEnv()
    const res = await app.fetch(new Request('http://central/api/admin/lims-import', {
      method: 'POST',
      headers: { 'x-admin-secret': 'test-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'oca', numbers: ['B26-0400'] }),
    }), e)
    expect(res.status).toBe(409)
    expect(lims.getBulkData).not.toHaveBeenCalled()
  })

  it('needs the admin secret', async () => {
    const { env: e } = makeEnv()
    const post = await app.fetch(new Request('http://central/api/admin/state-providers/DC', {
      method: 'POST', body: JSON.stringify({ provider: 'lims' }),
    }), e)
    const get = await app.fetch(new Request('http://central/api/admin/state-providers'), e)
    expect([post.status, get.status]).toEqual([401, 401])
  })
})

describe('the old ownership env vars (#319)', () => {
  // LIMS_STATES, MGA_STATES, and LIS_STATES once named a provider's states, and
  // for one release seeded a row for each. Only the state_providers table owns
  // a state now, and a state with no row is LegiScan's.
  const OLD_VARS = { LIMS_STATES: 'DC', MGA_STATES: 'MD', LIS_STATES: 'VA' }
  const rowCount = async () => Number((await env.DB.prepare('SELECT COUNT(*) AS n FROM state_providers').first<{ n: number }>())!.n)

  it('leaves a state with no row to LegiScan and writes no row, with every old env var set', async () => {
    const log = vi.spyOn(console, 'log')
    const { env: e, limsQueue } = makeEnv(OLD_VARS)

    await runSync(e, db)
    expect(await runSnapshotSync(limsProvider, e, db)).toEqual([])
    expect(await runSnapshotSync(mgaProvider, e, db)).toEqual([])

    expect(legiscanStates()).toEqual(['DC', 'MD'])
    expect(vi.mocked(legiscan.getMasterListBySession).mock.calls.map(c => c[0])).toEqual([LS_DC_SESSION])
    expect(lims.getCouncilPeriods).not.toHaveBeenCalled()
    expect(mga.getMgaSession).not.toHaveBeenCalled()
    expect(limsQueue.sendBatch).not.toHaveBeenCalled()
    expect(await rowCount()).toBe(0)
    expect((await ownership(e)).states).toEqual([])
    expect(logged(log, /seed/i)).toEqual([])
  })

  it('writes no row however many jobs run at once in the first hour', async () => {
    const { env: e } = makeEnv(OLD_VARS)
    await Promise.all([runSync(e, db), runSnapshotSync(limsProvider, e, db), runSnapshotSync(limsProvider, e, db)])
    expect(await rowCount()).toBe(0)
    expect(legiscanStates()).toEqual(['DC', 'MD'])
  })

  it('logs no refusal for LegiScan bills tracked in a state an old env var names, and the state keeps syncing from LegiScan', async () => {
    const warn = vi.spyOn(console, 'warn')
    const error = vi.spyOn(console, 'error')
    const { env: e } = makeEnv(OLD_VARS)
    await trackLegiscanDcBill(9001, 'oca', 'keyword')
    await trackLimsDcBill('B26-0400', 'team')

    await runSync(e, db)
    await runSnapshotSync(limsProvider, e, db)

    expect(legiscanStates()).toEqual(['DC', 'MD'])
    expect(lims.getBulkData).not.toHaveBeenCalled()
    expect(logged(warn, /state-providers/)).toEqual([])
    expect(logged(error, /state-providers/)).toEqual([])
    expect(await rowCount()).toBe(0)
  })

  it('lets a row for another provider win over an env var that names the state', async () => {
    await db.insert(schema.stateProviders).values({ state: 'DC', provider: 'legiscan', previousProvider: 'lims' })
    const { env: e, limsQueue } = makeEnv(OLD_VARS)

    expect(await runSnapshotSync(limsProvider, e, db)).toEqual([])
    expect(lims.getCouncilPeriods).not.toHaveBeenCalled()
    expect(limsQueue.sendBatch).not.toHaveBeenCalled()
    await runSync(e, db)
    expect(legiscanStates()).toEqual(['DC', 'MD'])
    expect((await ownership(e)).states).toEqual([expect.objectContaining({ state: 'DC', provider: 'legiscan', previousProvider: 'lims' })])
  })

  it('lets a Maryland row for MGA win over an env var that names Maryland for LIMS', async () => {
    await db.insert(schema.stateProviders).values({ state: 'MD', provider: 'mga', previousProvider: 'legiscan' })
    const { env: e } = makeEnv({ LIMS_STATES: 'MD' })

    expect(await runSnapshotSync(mgaProvider, e, db)).toEqual([expect.objectContaining({ records: JSON.parse(mgaSampleRaw).length })])
    expect(await runSnapshotSync(limsProvider, e, db)).toEqual([])
    expect((await ownership(e)).states).toEqual([expect.objectContaining({ state: 'MD', provider: 'mga' })])
  })

  it('lets a row decide with no env var set', async () => {
    await db.insert(schema.stateProviders).values({ state: 'DC', provider: 'lims', previousProvider: 'legiscan' })
    const { env: e, limsQueue } = makeEnv()

    await runSync(e, db)
    expect(legiscanStates()).toEqual(['MD'])
    await runSnapshotSync(limsProvider, e, db)
    expect(queuedIds(limsQueue)).toEqual([limsBillId('B26-0400')!, limsBillId('HN26-0171')!].sort())
  })

  it('lets a row decide when its old env var names a different state, and when it holds a different value', async () => {
    await db.insert(schema.stateProviders).values({ state: 'DC', provider: 'lims', previousProvider: 'legiscan' })
    const { env: e } = makeEnv({ LIMS_STATES: 'MD', MGA_STATES: '', LIS_STATES: 'not a state' })

    await runSync(e, db)
    expect(legiscanStates()).toEqual(['MD'])
    expect((await ownership(e)).states).toEqual([expect.objectContaining({ state: 'DC', provider: 'lims' })])
  })

  it('reports ownership from the table alone through the admin read, with the old env vars set', async () => {
    const { env: e } = makeEnv(OLD_VARS)
    expect(await ownership(e)).toEqual({ defaultProvider: 'legiscan', states: [] })

    await db.insert(schema.stateProviders).values({ state: 'MD', provider: 'mga', previousProvider: 'legiscan' })
    expect((await claim(e, 'DC', { provider: 'lims' })).status).toBe(200)
    expect(await ownership(e)).toEqual({
      defaultProvider: 'legiscan',
      states: [
        expect.objectContaining({ state: 'DC', provider: 'lims', status: 'active', previousProvider: 'legiscan' }),
        expect.objectContaining({ state: 'MD', provider: 'mga', status: 'active', previousProvider: 'legiscan' }),
      ],
    })
  })

  it('still lets a claim move a state an old env var names, refusing it while LegiScan has tracked bills there', async () => {
    const { env: e } = makeEnv(OLD_VARS)
    await trackLegiscanDcBill(9001, 'oca', 'keyword')
    const refused = await claim(e, 'DC', { provider: 'lims' })
    expect(refused.status).toBe(409)
    expect(await rowCount()).toBe(0)
  })
})

describe('a provider that owns a state but has lost its key', () => {
  it('leaves the state unsynced, with a warning, rather than handing it back to LegiScan', async () => {
    const warn = vi.spyOn(console, 'warn')
    await db.insert(schema.stateProviders).values({ state: 'DC', provider: 'lims', previousProvider: 'legiscan' })
    const { env: e } = makeEnv({ LIMS_API_KEY: undefined })

    expect(await runSnapshotSync(limsProvider, e, db)).toEqual([])
    expect(lims.getCouncilPeriods).not.toHaveBeenCalled()
    expect(logged(warn, /\[sync-lims\] owns DC but isn't configured/)).toHaveLength(1)

    await runSync(e, db)
    expect(legiscanStates()).toEqual(['MD'])
    expect(legiscan.getMasterListBySession).not.toHaveBeenCalled()
  })
})

describe('a claim that lands while a sync is running', () => {
  const NEW_BILL = { bill_id: 9100, number: 'B26-9100', change_hash: 'c1', title: 'Child Neglect Prevention Act', description: '' }
  const links = async () => (await db.select().from(schema.billTenants).all()).map(l => `${l.billId}:${l.tenantId}:${l.matchType}`).sort()

  it('without a claim, the LegiScan pass links and queues a new DC bill', async () => {
    const { env: e, ingestor } = makeEnv()
    vi.mocked(legiscan.getMasterListBySession).mockResolvedValue([NEW_BILL])
    await runSync(e, db)
    expect(await links()).toEqual(['9100:oca:keyword', '9100:team:null'])
    expect(queuedIds(ingestor)).toEqual([9100])
  })

  it('stops the LegiScan pass from linking, queueing, or notifying in the state it just lost', async () => {
    const { env: e, ingestor, tenantQueue } = makeEnv()
    let claimStatus = 0
    vi.mocked(legiscan.getMasterListBySession).mockImplementation(async () => {
      claimStatus = (await claim(e, 'DC', { provider: 'lims' })).status
      return [NEW_BILL]
    })

    await runSync(e, db)

    expect(claimStatus).toBe(200)
    expect(await links()).toEqual([])
    expect(ingestor.sendBatch).not.toHaveBeenCalled()
    expect(tenantQueue.sendBatch).not.toHaveBeenCalled()
    expect((await ownership(e)).states).toEqual([expect.objectContaining({ state: 'DC', provider: 'lims' })])
  })

  it('stops a snapshot pass the same way', async () => {
    await db.insert(schema.stateProviders).values({ state: 'MD', provider: 'mga', previousProvider: 'legiscan' })
    const { env: e, ingestor, tenantQueue } = makeEnv()
    let claimStatus = 0
    vi.mocked(mga.getMgaSession).mockImplementation(async code => {
      claimStatus = (await claim(e, 'MD', { provider: 'legiscan' })).status
      return code === MGA_CODE ? { unchanged: false, records: JSON.parse(mgaSampleRaw), etag: null } : null
    })

    await runSnapshotSync(mgaProvider, e, db)

    expect(claimStatus).toBe(200)
    expect(await links()).toEqual([])
    expect(ingestor.sendBatch).not.toHaveBeenCalled()
    expect(tenantQueue.sendBatch).not.toHaveBeenCalled()
  })
})
