import { env } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from '../../src/db/schema'
import { setupLsDb } from '../helpers/setupLsDb'
import sampleRaw from '../fixtures/mga/2026RS-sample.json?raw'

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
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { runSnapshotSync, refreshProviderSessions } from '../../src/cron/sync-snapshots'
import { providerContext } from '../../src/lib/providerContext'
import { runSync } from '../../src/cron/sync'
import { processIngestorQueue } from '../../src/queue/processor'
import { mga as mgaProvider } from '../../src/providers/mga'
import * as mga from '../../src/providers/mga/client'
import * as legiscan from '../../src/providers/legiscan/client'
import { tenantQueueBindingName } from '../../src/lib/tenantQueue'
import { nowDb } from '../../src/lib/dbTime'

const sample = JSON.parse(sampleRaw) as mga.MgaRecord[]
const PDF = '%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'
const THIS_YEAR = Number(nowDb().slice(0, 4))
const CODE = `${THIS_YEAR}RS`

function makeEnv(extra: Record<string, unknown> = {}) {
  const ingestor = { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn() }
  const tenantQueue = { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue(undefined) }
  return {
    ingestor, tenantQueue,
    env: {
      ...(env as any),
      MGA_STATES: 'MD',
      INGESTOR_QUEUE: ingestor,
      [tenantQueueBindingName('team')]: tenantQueue,
      ...extra,
    },
  }
}

const queuedIds = (q: { sendBatch: ReturnType<typeof vi.fn> }) =>
  q.sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body.billId))

async function billByNumber(number: string) {
  const db = drizzle(env.DB, { schema })
  return db.select().from(schema.bills).where(eq(schema.bills.billNumber, number)).get()
}

beforeEach(async () => {
  await setupLsDb()
  vi.clearAllMocks()
  vi.mocked(mga.mgaSessionExists).mockImplementation(async code => code === CODE)
  vi.mocked(mga.getMgaSession).mockImplementation(async code => (code === CODE ? structuredClone(sample) : null))
  fetchMock.mockImplementation(async () => new Response(PDF, { status: 200, headers: { 'content-type': 'application/pdf' } }))
  const db = drizzle(env.DB, { schema })
  await db.insert(schema.tenants).values({ tenantId: 'team', name: 'Team', stateCoverage: '["MD"]', active: true })
  await db.insert(schema.keywordRegistry).values([{ tenantId: 'team', keyword: 'cost recovery' }])
})

describe('Maryland session refresh', () => {
  it('ends a session the MGA stops listing (prior and sine die), and leaves sessions alone when it lists none', async () => {
    const db = drizzle(env.DB, { schema })
    const ctx = providerContext(mgaProvider, makeEnv().env, db)
    const S1 = `${THIS_YEAR}S1`
    // A LegiScan Maryland session, which the MGA refresh must never touch.
    await db.insert(schema.sessions).values({ sessionId: 2100, state: 'MD', stateId: 20, yearStart: THIS_YEAR, yearEnd: THIS_YEAR, sessionTitle: 'LS', sessionName: 'LS' })
    const state = async () => Object.fromEntries((await db.select().from(schema.sessions).all())
      .map(s => [s.provider === 'mga' ? s.sessionTag : `${s.provider}:${s.sessionId}`, [s.prior, s.sineDie]]))

    vi.mocked(mga.mgaSessionExists).mockImplementation(async code => code === CODE || code === S1)
    await refreshProviderSessions(mgaProvider, 'MD', ctx, db)
    expect(await state()).toEqual({ [CODE]: [0, 0], [S1]: [0, 0], 'legiscan:2100': [0, 0] })

    vi.mocked(mga.mgaSessionExists).mockImplementation(async code => code === CODE)
    await refreshProviderSessions(mgaProvider, 'MD', ctx, db)
    expect(await state()).toEqual({ [CODE]: [0, 0], [S1]: [1, 1], 'legiscan:2100': [0, 0] })

    vi.mocked(mga.mgaSessionExists).mockResolvedValue(false)
    await refreshProviderSessions(mgaProvider, 'MD', ctx, db)
    expect(await state()).toEqual({ [CODE]: [0, 0], [S1]: [1, 1], 'legiscan:2100': [0, 0] })

    // Listed again, it is current again.
    vi.mocked(mga.mgaSessionExists).mockImplementation(async code => code === CODE || code === S1)
    await refreshProviderSessions(mgaProvider, 'MD', ctx, db)
    expect(await state()).toEqual({ [CODE]: [0, 0], [S1]: [0, 0], 'legiscan:2100': [0, 0] })
  })

  it('stops syncing a session once the MGA stops listing it', async () => {
    const db = drizzle(env.DB, { schema })
    const { env: e } = makeEnv()
    const S1 = `${THIS_YEAR}S1`
    vi.mocked(mga.mgaSessionExists).mockImplementation(async code => code === CODE || code === S1)
    vi.mocked(mga.getMgaSession).mockImplementation(async code => (code === CODE || code === S1 ? structuredClone(sample) : null))
    await runSnapshotSync(mgaProvider, e, db)
    expect(vi.mocked(mga.getMgaSession).mock.calls.map(c => c[0]).sort()).toEqual([CODE, S1])

    vi.mocked(mga.getMgaSession).mockClear()
    vi.mocked(mga.mgaSessionExists).mockImplementation(async code => code === CODE)
    await runSnapshotSync(mgaProvider, e, db)
    expect(vi.mocked(mga.getMgaSession).mock.calls.map(c => c[0])).toEqual([CODE])
  })

  it('gives each session a slug of its own, the older LegiScan session keeping the plain one', async () => {
    const db = drizzle(env.DB, { schema })
    const ctx = providerContext(mgaProvider, makeEnv().env, db)
    await db.insert(schema.sessions).values({ sessionId: 2100, state: 'MD', stateId: 20, yearStart: THIS_YEAR, yearEnd: THIS_YEAR,
      sessionTitle: `${THIS_YEAR} Regular Session`, sessionName: `${THIS_YEAR} Regular Session`, slug: `${THIS_YEAR}` })
    vi.mocked(mga.mgaSessionExists).mockImplementation(async code => code === CODE || code === `${THIS_YEAR}S1`)
    await refreshProviderSessions(mgaProvider, 'MD', ctx, db)

    const slugs = Object.fromEntries((await db.select().from(schema.sessions).all())
      .map(s => [s.provider === 'mga' ? s.sessionTag : `${s.provider}:${s.sessionId}`, s.slug]))
    expect(slugs).toEqual({ 'legiscan:2100': `${THIS_YEAR}`, [CODE]: `${THIS_YEAR}-2`, [`${THIS_YEAR}S1`]: `${THIS_YEAR}-s1` })
  })
})

describe('the Maryland sync', () => {
  it('does nothing unless MGA_STATES names MD', async () => {
    const db = drizzle(env.DB, { schema })
    expect(await runSnapshotSync(mgaProvider, makeEnv({ MGA_STATES: '' }).env, db)).toEqual([])
    expect(mga.getMgaSession).not.toHaveBeenCalled()
  })

  it('finds the session, stores every record, and queues the matched bills', async () => {
    const db = drizzle(env.DB, { schema })
    const { env: e, ingestor } = makeEnv()
    const reports = await runSnapshotSync(mgaProvider, e, db)

    const session = await db.select().from(schema.sessions).where(eq(schema.sessions.sessionTag, CODE)).get()
    expect(session).toMatchObject({ state: 'MD', provider: 'mga', sessionName: `${THIS_YEAR} Regular Session`, special: 0 })
    expect(session!.sessionId).toBeGreaterThan(3_000_000_000)
    expect(reports).toEqual([expect.objectContaining({ sessionId: session!.sessionId, records: sample.length })])

    expect((await db.select().from(schema.providerRecords).all()).length).toBe(sample.length)
    const hb1 = await billByNumber('HB1')
    expect(hb1).toMatchObject({ provider: 'mga', state: 'MD', status: 204 })
    // HB 1 and its cross-file SB 2 share a title, so both match "cost recovery".
    expect(queuedIds(ingestor).sort()).toEqual([hb1!.billId, (await billByNumber('SB2'))!.billId].sort())
  })

  it('queues nothing when only the file timestamp moved', async () => {
    const db = drizzle(env.DB, { schema })
    const first = makeEnv()
    await runSnapshotSync(mgaProvider, first.env, db)
    for (const n of ['HB1', 'SB2']) {
      const b = await billByNumber(n)
      await db.update(schema.bills).set({ changeHash: (await db.select().from(schema.providerRecords)
        .where(eq(schema.providerRecords.billId, b!.billId)).get())!.rawHash }).where(eq(schema.bills.billId, b!.billId))
    }
    vi.mocked(mga.getMgaSession).mockImplementation(async () =>
      structuredClone(sample).map(r => ({ ...r, StatusCurrentAsOf: '2099-01-01T00:00:00' })))
    const second = makeEnv()
    await runSnapshotSync(mgaProvider, second.env, db)
    expect(queuedIds(second.ingestor)).toEqual([])
  })

  it('stops the LegiScan sync from touching Maryland', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.sessions).values({ sessionId: 2200, state: 'MD', stateId: 20, yearStart: THIS_YEAR, yearEnd: THIS_YEAR, sessionTitle: 'T', sessionName: 'T' })
    await runSync(makeEnv().env, db)
    expect(legiscan.getMasterListBySession).not.toHaveBeenCalled()
    expect(legiscan.getMasterListRaw).not.toHaveBeenCalled()
  })

  it('leaves Maryland on LegiScan while LegiScan Maryland bills are linked to tenants', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.bills).values({ billId: 77, changeHash: 'x', sessionId: 2200, state: 'MD', stateId: 20, billNumber: 'HB9', title: 'T' })
    await db.insert(schema.billTenants).values({ billId: 77, tenantId: 'team', matchType: 'keyword' })
    expect(await runSnapshotSync(mgaProvider, makeEnv().env, db)).toEqual([])
    expect(mga.getMgaSession).not.toHaveBeenCalled()
    expect(await db.select().from(schema.stateProviders).all()).toEqual([])
  })
})

describe('ingesting a Maryland bill', () => {
  it('builds it from the stored record with no further calls, and serves MGA labels and links', async () => {
    const db = drizzle(env.DB, { schema })
    const { env: e } = makeEnv()
    await runSnapshotSync(mgaProvider, e, db)
    const hb1 = (await billByNumber('HB1'))!
    vi.mocked(mga.getMgaSession).mockClear()

    const ack = vi.fn(); const retry = vi.fn()
    await processIngestorQueue({ messages: [{ body: { billId: hb1.billId }, ack, retry }] } as any, e, db)
    expect(retry).not.toHaveBeenCalled()
    expect(ack).toHaveBeenCalled()
    expect(legiscan.getBill).not.toHaveBeenCalled()
    expect(legiscan.getBillText).not.toHaveBeenCalled()
    expect(mga.getMgaSession).not.toHaveBeenCalled()

    const texts = await db.select().from(schema.billTexts).where(eq(schema.billTexts.billId, hb1.billId)).all()
    expect(texts.map(t => t.stateLink).sort()).toEqual([
      `https://mgaleg.maryland.gov/${CODE}/bills/hb/hb0001F.pdf`,
      `https://mgaleg.maryland.gov/${CODE}/bills/hb/hb0001T.pdf`,
    ])
    expect(texts.every(t => t.r2Key)).toBe(true)
    const sponsors = await db.select().from(schema.people)
      .innerJoin(schema.billSponsors, eq(schema.billSponsors.peopleId, schema.people.peopleId))
      .where(eq(schema.billSponsors.billId, hb1.billId)).all()
    expect(sponsors.length).toBeGreaterThan(20)
    expect(sponsors.every(s => s.people.provider === 'mga')).toBe(true)

    const { app } = await import('../../src/index-legiscan')
    const res = await app.fetch(new Request(`http://central/api/bills/legiscan:${hb1.billId}`, {
      headers: { 'x-admin-secret': 'test-secret' },
    }), { ...e, ADMIN_SECRET: 'test-secret' })
    expect(res.status).toBe(200)
    const body = await res.json() as { status: string; sponsors: { name: string; url: string | null }[]; stateUrl?: string }
    expect(body.status).toBe('Passed the House')
    expect(body.sponsors[0]).toMatchObject({ name: 'Crosby', url: null })
  })
})
