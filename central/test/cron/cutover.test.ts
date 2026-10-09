import { env } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from '../../src/db/schema-legiscan'
import { setupLsDb } from '../helpers/setupLsDb'
import sampleRaw from '../fixtures/mga/2026RS-sample.json?raw'

vi.mock('../../src/lib/mga', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/mga')>('../../src/lib/mga')
  return { ...actual, getMgaSession: vi.fn(), mgaSessionExists: vi.fn() }
})
vi.mock('../../src/lib/sync-schedule', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/sync-schedule')>('../../src/lib/sync-schedule')
  return { ...actual, getCurrentEtHour: vi.fn(() => 5) }
})

import { runSourceSync } from '../../src/cron/sync-sources'
import { comparableNumber } from '../../src/cron/cutover'
import { mgaSource } from '../../src/sources/mga'
import * as mga from '../../src/lib/mga'
import { tenantQueueBindingName } from '../../src/lib/tenantQueue'
import { nowDb } from '../../src/lib/dbTime'

const sample = JSON.parse(sampleRaw) as mga.MgaRecord[]
const THIS_YEAR = Number(nowDb().slice(0, 4))
const CODE = `${THIS_YEAR}RS`

function makeEnv() {
  const ingestor = { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn() }
  const rpc = { rekeyBills: vi.fn(async (pairs: unknown[]) => ({ rekeyed: pairs.length, missing: [], conflicts: [] })) }
  const tenantQueue = { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue(undefined) }
  return {
    ingestor, rpc,
    env: {
      ...(env as any), MGA_STATES: 'MD', ADMIN_SECRET: 'test-secret', INGESTOR_QUEUE: ingestor,
      TENANT_TEAM: rpc, [tenantQueueBindingName('team')]: tenantQueue,
    },
  }
}

async function post(e: Record<string, unknown>, query = '') {
  const { app } = await import('../../src/index-legiscan')
  const res = await app.fetch(new Request(`http://central/api/admin/sources/mga/cutover${query}`, {
    method: 'POST', headers: { 'x-admin-secret': 'test-secret' },
  }), e)
  return { status: res.status, body: await res.json() as any }
}

const links = async () => {
  const db = drizzle(env.DB, { schema })
  return new Map((await db.select().from(schema.billTenants).all()).map(l => [l.billId, l.matchType]))
}

beforeEach(async () => {
  await setupLsDb()
  vi.clearAllMocks()
  vi.mocked(mga.mgaSessionExists).mockImplementation(async code => code === CODE)
  vi.mocked(mga.getMgaSession).mockImplementation(async code => (code === CODE ? structuredClone(sample) : null))
  const db = drizzle(env.DB, { schema })
  await db.insert(schema.tenants).values({ tenantId: 'team', name: 'Team', stateCoverage: '["MD"]', active: true })
  await db.insert(schema.keywordRegistry).values({ tenantId: 'team', keyword: 'cost recovery' })
  // LegiScan's Maryland: this year's session, and one two years back.
  const session = { state: 'MD', stateId: 20, sessionTitle: 'T', special: 0 }
  await db.insert(schema.sessions).values([
    { ...session, sessionId: 2200, yearStart: THIS_YEAR, yearEnd: THIS_YEAR, sessionName: `${THIS_YEAR} Regular Session` },
    { ...session, sessionId: 2100, yearStart: THIS_YEAR - 2, yearEnd: THIS_YEAR - 2, sessionName: 'Earlier' },
  ])
  const bill = (billId: number, billNumber: string, sessionId = 2200) =>
    ({ billId, billNumber, sessionId, state: 'MD', stateId: 20, changeHash: 'x', title: billNumber })
  await db.insert(schema.bills).values([
    bill(9001, 'HB1'), bill(9002, 'SB2'), bill(9003, 'HB9999'), bill(9004, 'HB9998'), bill(8001, 'HB5', 2100),
  ])
  await db.insert(schema.billTenants).values([
    { billId: 9001, tenantId: 'team', matchType: 'keyword' },
    { billId: 9002, tenantId: 'team', matchType: null },
    { billId: 9003, tenantId: 'team', matchType: null },
    { billId: 9004, tenantId: 'team', matchType: 'manual' },
    { billId: 8001, tenantId: 'team', matchType: 'keyword' },
  ])
})

describe('cutover from LegiScan to a direct source', () => {
  it('is needed: the source refuses to sync while this session\'s LegiScan links remain', async () => {
    const db = drizzle(env.DB, { schema })
    await expect(runSourceSync(mgaSource, makeEnv().env, db)).rejects.toThrow(/4 LegiScan bill links.*sources\/mga\/cutover/)
  })

  it('reports every link and its match on a dry run, and changes nothing', async () => {
    const { env: e, rpc } = makeEnv()
    const before = await links()
    const { status, body } = await post(e)
    expect(status).toBe(200)
    expect(body).toMatchObject({ dryRun: true, matched: 2, unmatched: { monitorOnly: 1 } })
    expect(body.unmatched.tracked.map((l: any) => l.number)).toEqual(['HB9998'])
    expect(rpc.rekeyBills).not.toHaveBeenCalled()
    expect(await links()).toEqual(before)
  })

  it('moves matched links, has the tenant re-point its bills, and leaves a tracked link with no match', async () => {
    const db = drizzle(env.DB, { schema })
    const { env: e, rpc } = makeEnv()
    const { body } = await post(e, '?confirm=true')

    const ids = new Map((await db.select().from(schema.sourceRecords).all()).map(r => [r.nativeKey, r.billId]))
    const hb1 = ids.get(`${CODE}/HB0001`)!, sb2 = ids.get(`${CODE}/SB0002`)!
    expect(rpc.rekeyBills).toHaveBeenCalledWith(expect.arrayContaining([
      { from: 'legiscan:9001', to: `legiscan:${hb1}` }, { from: 'legiscan:9002', to: `legiscan:${sb2}` },
    ]))
    const now = await links()
    expect(now.get(hb1)).toBe('keyword')
    expect(now.get(sb2)).toBeNull()
    expect([9001, 9002, 9003].some(id => now.has(id))).toBe(false)
    expect(now.get(9004)).toBe('manual')
    expect(now.get(8001)).toBe('keyword')   // an earlier session: not the source's to replace
    expect(body.ok).toBe(false)
    expect(body.blocked).toMatch(/1 tracked links have no match.*dropUnmatched/)
    expect(body.tenants.team).toMatchObject({ moved: 2, rekeyed: 2, dropped: 1 })
  })

  it('with dropUnmatched, clears the way and runs the sync, which ingests the moved tracked bills', async () => {
    const db = drizzle(env.DB, { schema })
    const { env: e, ingestor } = makeEnv()
    const { body } = await post(e, '?confirm=true&dropUnmatched=true')
    expect(body.ok).toBe(true)
    expect(body.synced).toEqual([expect.objectContaining({ records: sample.length })])

    const hb1 = (await db.select().from(schema.sourceRecords).where(eq(schema.sourceRecords.nativeKey, `${CODE}/HB0001`)).get())!.billId
    expect(await db.select().from(schema.bills).where(eq(schema.bills.billId, hb1)).get()).toMatchObject({ source: 'mga', billNumber: 'HB1' })
    const queued = ingestor.sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body.billId))
    expect(queued).toContain(hb1)
    expect((await links()).has(9004)).toBe(false)

    // And the source now syncs on its own.
    await expect(runSourceSync(mgaSource, e, db)).resolves.toBeDefined()
  })

  it('leaves a bound-less active tenant\'s links in place and says so', async () => {
    const { env: e } = makeEnv()
    delete (e as any).TENANT_TEAM
    const { body } = await post(e, '?confirm=true&dropUnmatched=true')
    expect(body.ok).toBe(false)
    expect(body.tenants.team.error).toMatch(/no service binding/)
    expect((await links()).get(9001)).toBe('keyword')
  })
})

describe('comparableNumber', () => {
  it('compares numbers without padding or spaces', () => {
    expect(comparableNumber('HB0001')).toBe('HB1')
    expect(comparableNumber('hb 1')).toBe('HB1')
    expect(comparableNumber('B26-0400')).toBe('B26-400')
  })
})
