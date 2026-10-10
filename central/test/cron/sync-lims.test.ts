import { env } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from '../../src/db/schema'
import { setupLsDb } from '../helpers/setupLsDb'
import bulkRaw from '../fixtures/lims/bulk-records.json?raw'
import details0400Raw from '../fixtures/lims/details-B26-0400.json?raw'
import membersRaw from '../fixtures/lims/members-26.json?raw'

vi.mock('../../src/providers/lims/client', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/lims/client')>('../../src/providers/lims/client')
  return { ...actual, getCouncilPeriods: vi.fn(), getMembers: vi.fn(), getBulkData: vi.fn(), getLegislationDetails: vi.fn() }
})
vi.mock('../../src/providers/lims/map', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/lims/map')>('../../src/providers/lims/map')
  return { ...actual, buildLimsBill: vi.fn(actual.buildLimsBill) }
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
import { lims as limsProvider } from '../../src/providers/lims'
import { providerContext } from '../../src/lib/providerContext'
import { runSync } from '../../src/cron/sync'
import { processIngestorQueue } from '../../src/queue/processor'
import * as lims from '../../src/providers/lims/client'
import * as limsMap from '../../src/providers/lims/map'
import * as legiscan from '../../src/providers/legiscan/client'
import { limsBillId, limsSessionId, LIMS_DOC_ID_BASE } from '../../src/providers/lims/ids'
import { tenantQueueBindingName } from '../../src/lib/tenantQueue'

const runLimsSync = (e: any, db: any, opts: { force?: boolean } = {}) => runSnapshotSync(limsProvider, e, db, opts)
const bulk = JSON.parse(bulkRaw) as Record<string, lims.LimsBulkRecord>
const PERIOD = { councilPeriodId: 26, councilPeriod: '26 (2025-26)', startDate: '2025-01-02T00:00:00', endDate: '2026-12-31T00:00:00' }
const B0400 = limsBillId('B26-0400')!
const PDF = '%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'

function makeEnv(extra: Record<string, unknown> = {}) {
  const limsQueue = { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn() }
  const tenantQueue = { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue(undefined) }
  return {
    limsQueue, tenantQueue,
    env: {
      ...(env as any),
      LIMS_API_KEY: 'lims-key', LIMS_STATES: 'DC', LIMS_CATEGORIES: '1,18',
      LIMS_INGESTOR_QUEUE: limsQueue,
      INGESTOR_QUEUE: { sendBatch: vi.fn(), send: vi.fn() },
      [tenantQueueBindingName('oca')]: tenantQueue,
      ...extra,
    },
  }
}

beforeEach(async () => {
  await setupLsDb()
  vi.clearAllMocks()
  vi.mocked(lims.getCouncilPeriods).mockResolvedValue([PERIOD])
  vi.mocked(lims.getMembers).mockResolvedValue(JSON.parse(membersRaw))
  vi.mocked(lims.getBulkData).mockImplementation(async (categoryId: number) =>
    categoryId === 1 ? [bulk['B26-0400'], bulk['B26-0769'], bulk['B26-0001']]
      : categoryId === 18 ? [bulk['HN26-0171']] : [])
  vi.mocked(lims.getLegislationDetails).mockResolvedValue(JSON.parse(details0400Raw))
  fetchMock.mockImplementation(async () => new Response(PDF, { status: 200, headers: { 'content-type': 'application/pdf' } }))
  const db = drizzle(env.DB, { schema })
  await db.insert(schema.tenants).values({ tenantId: 'oca', name: 'OCA', stateCoverage: '["DC"]', active: true })
  await db.insert(schema.keywordRegistry).values([{ tenantId: 'oca', keyword: 'neglect' }, { tenantId: 'oca', keyword: 'behavioral health' }])
})

describe('runLimsSync', () => {
  it('does nothing without a LIMS key', async () => {
    const db = drizzle(env.DB, { schema })
    const { env: e } = makeEnv({ LIMS_API_KEY: undefined })
    await runLimsSync(e, db)
    expect(lims.getCouncilPeriods).not.toHaveBeenCalled()
  })

  it('seeds the Council Period and members, links bills, and queues matches to the LIMS queue', async () => {
    const db = drizzle(env.DB, { schema })
    const { env: e, limsQueue } = makeEnv()

    await runLimsSync(e, db)

    const session = await db.select().from(schema.sessions).where(eq(schema.sessions.sessionId, limsSessionId(26))).get()
    expect(session?.sessionName).toBe('2025-2026 Council Period 26')
    expect(session?.state).toBe('DC')
    expect((await db.select().from(schema.people).all()).length).toBe(15)
    expect((await db.select().from(schema.providerRecords).all()).length).toBe(4)

    const links = new Map((await db.select().from(schema.billTenants).all()).map(l => [l.billId, l.matchType]))
    expect(links.get(B0400)).toBe('keyword')
    expect(links.get(limsBillId('HN26-0171')!)).toBe('keyword')
    expect(links.get(limsBillId('B26-0001')!)).toBeNull()

    const queued = limsQueue.sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body.billId)).sort()
    expect(queued).toEqual([B0400, limsBillId('HN26-0171')!].sort())
    expect(e.INGESTOR_QUEUE.sendBatch).not.toHaveBeenCalled()
    expect(lims.getBulkData).toHaveBeenCalledTimes(2)
  })

  it('queues nothing on a second pass over unchanged data', async () => {
    const db = drizzle(env.DB, { schema })
    const first = makeEnv()
    await runLimsSync(first.env, db)
    // Stand in for the ingestor having run: it writes the same change_hash back.
    const second = makeEnv()
    await runLimsSync(second.env, db)
    expect(second.limsQueue.sendBatch).not.toHaveBeenCalled()
  })

  it('stops the LegiScan sync from touching DC', async () => {
    const db = drizzle(env.DB, { schema })
    const { env: e } = makeEnv()
    await runLimsSync(e, db)
    await runSync(e, db)
    expect(legiscan.getSessionList).not.toHaveBeenCalled()
    expect(legiscan.getMasterListBySession).not.toHaveBeenCalled()
  })
})

describe('ingesting a LIMS bill', () => {
  it('builds the bill from the stored record plus LegislationDetails and notifies the tenant', async () => {
    const db = drizzle(env.DB, { schema })
    const { env: e, tenantQueue } = makeEnv()
    await runLimsSync(e, db)

    const ack = vi.fn(); const retry = vi.fn()
    await processIngestorQueue({ messages: [{ body: { billId: B0400 }, ack, retry }] } as any, e, db)

    expect(retry).not.toHaveBeenCalled()
    expect(ack).toHaveBeenCalled()
    expect(legiscan.getBill).not.toHaveBeenCalled()
    expect(lims.getLegislationDetails).toHaveBeenCalledWith('B26-0400', 'lims-key', expect.any(Function))

    const bill = await db.select().from(schema.bills).where(eq(schema.bills.billId, B0400)).get()
    expect(bill?.title).toBe('Statutory Neglect Amendment Act of 2025')
    expect(bill?.changeHash).toBe((await db.select().from(schema.providerRecords).where(eq(schema.providerRecords.billId, B0400)).get())?.rawHash)

    const texts = await db.select().from(schema.billTexts).where(eq(schema.billTexts.billId, B0400)).all()
    expect(texts.length).toBeGreaterThan(3)
    for (const t of texts) {
      expect(t.docId).toBeGreaterThan(LIMS_DOC_ID_BASE)
      expect(t.textHash).toBeTruthy()
      expect(t.r2Key).toBeTruthy()
    }
    expect(legiscan.getBillText).not.toHaveBeenCalled()

    const rc = await db.select().from(schema.rollCalls).where(eq(schema.rollCalls.billId, B0400)).all()
    expect(rc.length).toBeGreaterThan(0)
    const memberVotes = await db.select().from(schema.rollCallVotes).where(eq(schema.rollCallVotes.rollCallId, rc[0].rollCallId)).all()
    expect(memberVotes.length).toBe(rc[0].total)

    const cal = await db.select().from(schema.billCalendar).where(eq(schema.billCalendar.billId, B0400)).all()
    expect(cal.map(c => c.date).sort()).toEqual(['2025-11-13', '2026-01-27', '2026-02-23'])

    const sent = [
      ...tenantQueue.send.mock.calls.map(c => c[0]),
      ...tenantQueue.sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body)),
    ]
    expect(sent.some((m: any) => m.billId === `legiscan:${B0400}` && !m.stubOnly)).toBe(true)
  })

  it('does not requeue a bill after it has been ingested', async () => {
    const db = drizzle(env.DB, { schema })
    const first = makeEnv()
    await runLimsSync(first.env, db)
    await processIngestorQueue({ messages: [{ body: { billId: B0400 }, ack: vi.fn(), retry: vi.fn() }] } as any, first.env, db)
    const second = makeEnv()
    await runLimsSync(second.env, db)
    const queued = second.limsQueue.sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body.billId))
    expect(queued).not.toContain(B0400)
  })
})

describe('routing by the provider column', () => {
  it("builds a bill from LIMS when its row says so, whatever its id", async () => {
    // A LegiScan-sized id, as a bill keeps when a cutover moves its state to
    // LIMS. Nothing about the id says LIMS: only the rows do.
    const db = drizzle(env.DB, { schema })
    const BILL = 1_950_000
    const rec = bulk['B26-0400']
    await db.insert(schema.sessions).values({
      sessionId: limsSessionId(26), state: 'DC', stateId: 51, yearStart: 2025, yearEnd: 2026,
      sessionTag: 'CP26', sessionTitle: 'Council Period 26', sessionName: '2025-2026 Council Period 26', provider: 'lims',
    })
    await db.insert(schema.bills).values({
      billId: BILL, changeHash: '', sessionId: limsSessionId(26), state: 'DC', stateId: 51,
      billNumber: 'B26-0400', title: 'B26-0400', provider: 'lims',
    })
    await db.insert(schema.providerRecords).values({
      billId: BILL, provider: 'lims', nativeKey: 'B26-0400', sessionId: limsSessionId(26),
      rawJson: JSON.stringify(rec), rawHash: await limsMap.bulkHash(rec),
    })
    await db.insert(schema.billTenants).values({ billId: BILL, tenantId: 'oca', matchType: 'keyword' })
    const { env: e, tenantQueue } = makeEnv({ ADMIN_SECRET: 'test-secret' })

    const retry = vi.fn()
    await processIngestorQueue({ messages: [{ body: { billId: BILL }, ack: vi.fn(), retry }] } as any, e, db)

    expect(retry).not.toHaveBeenCalled()
    expect(legiscan.getBill).not.toHaveBeenCalled()
    expect(lims.getLegislationDetails).toHaveBeenCalledWith('B26-0400', 'lims-key', expect.any(Function))
    const { app } = await import('../../src/index-legiscan')
    const res = await app.fetch(new Request(`http://central/api/bills/legiscan:${BILL}`, {
      headers: { 'x-admin-secret': 'test-secret' },
    }), e)
    const body = await res.json() as { billId: string; title: string; status: string; statusStage: string; statusRank: number }
    expect(body).toMatchObject({
      billId: `legiscan:${BILL}`, title: 'Statutory Neglect Amendment Act of 2025',
      status: 'Official Law', statusStage: 'enacted', statusRank: 705,
    })
    const sent = [
      ...tenantQueue.send.mock.calls.map(c => c[0]),
      ...tenantQueue.sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body)),
    ]
    expect(sent.some((m: any) => m.billId === `legiscan:${BILL}`)).toBe(true)
  })
})

describe('the stored LIMS record', () => {
  it('keeps the LegislationDetails response beside the BulkData record, and the BulkData hash the sync compares', async () => {
    const db = drizzle(env.DB, { schema })
    const record = async () =>
      (await db.select().from(schema.providerRecords).where(eq(schema.providerRecords.billId, B0400)).get())!
    await runLimsSync(makeEnv().env, db)
    const listed = await record()
    expect(listed.detailsJson).toBeNull()

    await processIngestorQueue({ messages: [{ body: { billId: B0400 }, ack: vi.fn(), retry: vi.fn() }] } as any, makeEnv().env, db)
    const built = await record()
    expect(JSON.parse(built.detailsJson!)).toEqual(JSON.parse(details0400Raw))
    expect(built.rawJson).toBe(listed.rawJson)
    expect(built.rawHash).toBe(listed.rawHash)

    // An unchanged listing queues nothing and leaves the details alone.
    const again = makeEnv()
    await runLimsSync(again.env, db)
    expect(again.limsQueue.sendBatch).not.toHaveBeenCalled()
    expect((await record()).detailsJson).toBe(built.detailsJson)

    // A changed listing replaces the BulkData record and its hash, and the
    // details stay until the bill's next ingest fetches them again.
    const changed = { ...bulk['B26-0400'], title: 'Statutory Neglect Amendment Act of 2026' }
    vi.mocked(lims.getBulkData).mockImplementation(async (c: number) => (c === 1 ? [changed] : []))
    const relist = makeEnv()
    await runLimsSync(relist.env, db)
    const relisted = await record()
    expect(JSON.parse(relisted.rawJson).title).toBe(changed.title)
    expect(relisted.rawHash).toBe(await limsMap.bulkHash(changed))
    expect(relisted.detailsJson).toBe(built.detailsJson)
    expect(relist.limsQueue.sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body.billId))).toEqual([B0400])
  })
})

describe('details refresh bookkeeping', () => {
  it('records the details fetch only once the bill is built', async () => {
    const db = drizzle(env.DB, { schema })
    const { env: e } = makeEnv()
    await runLimsSync(e, db)
    const fetchedAt = async () =>
      (await db.select().from(schema.providerRecords).where(eq(schema.providerRecords.billId, B0400)).get())?.detailsFetchedAt

    vi.mocked(limsMap.buildLimsBill).mockRejectedValueOnce(new Error('unexpected details shape'))
    const retry = vi.fn()
    await processIngestorQueue({ messages: [{ body: { billId: B0400 }, ack: vi.fn(), retry }] } as any, e, db)
    expect(lims.getLegislationDetails).toHaveBeenCalled()
    expect(retry).toHaveBeenCalled()
    expect(await fetchedAt()).toBeNull()

    await processIngestorQueue({ messages: [{ body: { billId: B0400 }, ack: vi.fn(), retry: vi.fn() }] } as any, e, db)
    expect(await fetchedAt()).toBeTruthy()
  })
})

describe('review fixes', () => {
  async function passAndIngest(db: any) {
    const run = makeEnv()
    await runLimsSync(run.env, db)
    const ids = run.limsQueue.sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body.billId))
    for (const billId of ids) {
      await processIngestorQueue({ messages: [{ body: { billId }, ack: vi.fn(), retry: vi.fn() }] } as any, run.env, db)
    }
    return ids
  }

  it('records a DC status change even though every LIMS pass is a full pass', async () => {
    const db = drizzle(env.DB, { schema })
    const mayoral = { ...bulk['B26-0400'], status: 'Under Mayoral Review' }
    vi.mocked(lims.getBulkData).mockImplementation(async (c: number) => (c === 1 ? [mayoral] : []))
    vi.mocked(lims.getLegislationDetails).mockResolvedValue({ ...JSON.parse(details0400Raw), status: 'Under Mayoral Review' })
    await passAndIngest(db)

    vi.mocked(lims.getBulkData).mockImplementation(async (c: number) => (c === 1 ? [{ ...mayoral, status: 'Official Law' }] : []))
    vi.mocked(lims.getLegislationDetails).mockResolvedValue(JSON.parse(details0400Raw))
    const queued = await passAndIngest(db)

    expect(queued).toEqual([B0400])
    const changes = await db.select().from(schema.billChangeLog).where(eq(schema.billChangeLog.billId, B0400)).all()
    const status = changes.find(c => c.changeType === 'status_change')
    expect(status).toMatchObject({ oldValue: 'Under Mayoral Review', newValue: 'Official Law' })
  })

  it('still records the latest action on a queued bill before the ingestor runs', async () => {
    const db = drizzle(env.DB, { schema })
    await passAndIngest(db)
    const rec = bulk['B26-0400']
    const newer = { ...rec, legislationHistory: [...rec.legislationHistory,
      { legislationNumber: 'B26-0400', actionDate: 'Sep 01, 2026', actionDescription: 'Codified', downloadURL: '' }] }
    vi.mocked(lims.getBulkData).mockImplementation(async (c: number) => (c === 1 ? [newer] : []))
    const { env: e } = makeEnv()
    await runLimsSync(e, db)
    const row = await db.select().from(schema.bills).where(eq(schema.bills.billId, B0400)).get()
    expect(row).toMatchObject({ lastAction: 'Codified', lastActionDate: '2026-09-01' })
  })

  it('refuses to run while LegiScan DC bills are linked to tenants', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.bills).values({ billId: 1_950_000, sessionId: 2150, state: 'DC', stateId: 51, billNumber: 'B26-0400', changeHash: 'h', title: 't' } as any)
    await db.insert(schema.billTenants).values({ billId: 1_950_000, tenantId: 'oca', matchType: 'keyword' })
    const { env: e, limsQueue } = makeEnv()

    await expect(runLimsSync(e, db)).rejects.toThrow(/cut over/)
    expect(lims.getBulkData).not.toHaveBeenCalled()
    expect(limsQueue.sendBatch).not.toHaveBeenCalled()
  })

  it('keeps syncing the previous Council Period for a year after it ends', async () => {
    const db = drizzle(env.DB, { schema })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2027-03-02T15:00:00Z'))
    try {
      vi.mocked(lims.getCouncilPeriods).mockResolvedValue([
        PERIOD,
        { councilPeriodId: 27, councilPeriod: '27 (2027-28)', startDate: '2027-01-02T00:00:00', endDate: '2028-12-31T00:00:00' },
      ])
      const { env: e } = makeEnv()
      await runLimsSync(e, db)
      const periods = vi.mocked(lims.getBulkData).mock.calls.map(c => c[1])
      expect(new Set(periods)).toEqual(new Set([26, 27]))
      const s26 = await db.select().from(schema.sessions).where(eq(schema.sessions.sessionId, limsSessionId(26))).get()
      expect(s26?.prior).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Codex review fixes', () => {
  async function passAndIngest(db: any) {
    const run = makeEnv()
    await runLimsSync(run.env, db)
    const ids = run.limsQueue.sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body.billId))
    for (const billId of ids) {
      await processIngestorQueue({ messages: [{ body: { billId }, ack: vi.fn(), retry: vi.fn() }] } as any, run.env, db)
    }
    return { ids, run }
  }

  it('re-fetches details for a tracked, unsettled bill once they are stale', async () => {
    const db = drizzle(env.DB, { schema })
    const pending = { ...bulk['B26-0400'], status: 'Under Council Review' }
    vi.mocked(lims.getBulkData).mockImplementation(async (c: number) => (c === 1 ? [pending] : []))
    vi.mocked(lims.getLegislationDetails).mockResolvedValue({ ...JSON.parse(details0400Raw), status: 'Under Council Review' })
    await passAndIngest(db)
    expect((await db.select().from(schema.providerRecords).where(eq(schema.providerRecords.billId, B0400)).get())?.detailsFetchedAt).toBeTruthy()

    // Fresh details, unchanged bulk: nothing to do.
    const fresh = makeEnv()
    await runLimsSync(fresh.env, db)
    expect(fresh.limsQueue.sendBatch).not.toHaveBeenCalled()

    // Three days later the same bill is re-fetched though bulk has not changed.
    await env.DB.prepare(`UPDATE provider_records SET details_fetched_at = datetime('now', '-3 days') WHERE bill_id = ?`).bind(B0400).run()
    const later = makeEnv()
    await runLimsSync(later.env, db)
    const queued = later.limsQueue.sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body.billId))
    expect(queued).toEqual([B0400])
  })

  it('re-fetches details for a Deemed Approved bill, which is not terminal', async () => {
    const db = drizzle(env.DB, { schema })
    const deemed = { ...bulk['B26-0400'], status: 'Deemed Approved' }
    vi.mocked(lims.getBulkData).mockImplementation(async (c: number) => (c === 1 ? [deemed] : []))
    vi.mocked(lims.getLegislationDetails).mockResolvedValue({ ...JSON.parse(details0400Raw), status: 'Deemed Approved' })
    await passAndIngest(db)
    await env.DB.prepare(`UPDATE provider_records SET details_fetched_at = datetime('now', '-3 days') WHERE bill_id = ?`).bind(B0400).run()
    const later = makeEnv()
    await runLimsSync(later.env, db)
    const queued = later.limsQueue.sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body.billId))
    expect(queued).toEqual([B0400])
  })

  it('does not re-fetch a bill in a terminal status', async () => {
    const db = drizzle(env.DB, { schema })
    vi.mocked(lims.getBulkData).mockImplementation(async (c: number) => (c === 1 ? [bulk['B26-0400']] : []))
    await passAndIngest(db)   // B26-0400 is Official Law
    await env.DB.prepare(`UPDATE provider_records SET details_fetched_at = datetime('now', '-30 days')`).run()
    const later = makeEnv()
    await runLimsSync(later.env, db)
    expect(later.limsQueue.sendBatch).not.toHaveBeenCalled()
  })

  it('advances the latest action when a future-dated hearing day arrives, with no bulk change', async () => {
    const db = drizzle(env.DB, { schema })
    const B0769 = limsBillId('B26-0769')!
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-09-28T09:00:00Z'))   // 5 ET
      await runLimsSync(makeEnv().env, db)
      const before = await db.select().from(schema.bills).where(eq(schema.bills.billId, B0769)).get()
      expect(before?.lastAction).not.toMatch(/^Public Hearing/)

      vi.setSystemTime(new Date('2026-10-23T09:00:00Z'))
      await runLimsSync(makeEnv().env, db)
      const after = await db.select().from(schema.bills).where(eq(schema.bills.billId, B0769)).get()
      expect(after?.lastAction).toBe('Public Hearing on B26-0769')
      expect(after?.lastActionDate).toBe('2026-10-23')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('cancellations', () => {
  it('keeps the cancellation in history and documents, and alerts tenants that an upcoming hearing was cancelled', async () => {
    const db = drizzle(env.DB, { schema })
    const B0769 = limsBillId('B26-0769')!
    const rec = bulk['B26-0769']   // "Public Hearing on B26-0769", Oct 23 2026
    await db.insert(schema.keywordRegistry).values({ tenantId: 'oca', keyword: rec.title.split(' ')[0].toLowerCase() })
    const d = JSON.parse(details0400Raw)
    const hearing = { hearingDate: '2026-10-23T00:00:00', hearingType: 'Public Hearing', cancellationHearingNotice: null }
    const detailsFor = (h: object) => ({ ...d, legislationNumber: 'B26-0769', status: 'Under Council Review', committeeHearing: [h], committeeMarkup: [], actions: [], otherDocuments: [] })
    vi.mocked(lims.getBulkData).mockImplementation(async (c: number) => (c === 1 ? [rec] : []))

    const ingest = async (details: object, bulkRec: any) => {
      vi.mocked(lims.getBulkData).mockImplementation(async (c: number) => (c === 1 ? [bulkRec] : []))
      vi.mocked(lims.getLegislationDetails).mockResolvedValue(details as any)
      const run = makeEnv()
      await runLimsSync(run.env, db)
      await processIngestorQueue({ messages: [{ body: { billId: B0769 }, ack: vi.fn(), retry: vi.fn() }] } as any, run.env, db)
      return run
    }

    await ingest(detailsFor(hearing), rec)
    expect((await db.select().from(schema.billCalendar).where(eq(schema.billCalendar.billId, B0769)).all()).map(c => c.date)).toContain('2026-10-23')

    // LIMS files a cancellation: new history lines in bulk, and details flag the hearing.
    const cancelled = { ...rec, legislationHistory: [...rec.legislationHistory,
      { legislationNumber: 'B26-0769', actionDate: 'Oct 01, 2026', actionDescription: 'Cancellation Notice of Public Hearing filed in the Office of Secretary', downloadURL: 'https://lims.dccouncil.gov/downloads/LIMS/1/Hearing_Cancellation_Notice/B26-0769-Hearing_Cancellation_Notice1.pdf?Id=999001' },
      { legislationNumber: 'B26-0769', actionDate: 'Oct 02, 2026', actionDescription: 'Public Hearing Canceled', downloadURL: '' }] }
    const run = await ingest(detailsFor({ ...hearing, cancellationHearingNotice: 'https://lims.dccouncil.gov/downloads/x.pdf?Id=999001' }), cancelled)

    const history = (await db.select().from(schema.billHistory).where(eq(schema.billHistory.billId, B0769)).all()).map(h => h.action)
    expect(history).toEqual(expect.arrayContaining(['Cancellation Notice of Public Hearing filed in the Office of Secretary', 'Public Hearing Canceled']))
    const supps = await db.select().from(schema.billSupplements).where(eq(schema.billSupplements.billId, B0769)).all()
    expect(supps.some(s => /Cancellation/i.test(s.type ?? ''))).toBe(true)
    expect((await db.select().from(schema.billCalendar).where(eq(schema.billCalendar.billId, B0769)).all()).map(c => c.date)).not.toContain('2026-10-23')

    const changes = await db.select().from(schema.billChangeLog).where(eq(schema.billChangeLog.billId, B0769)).all()
    expect(changes.map(c => c.changeType)).toContain('hearing_cancelled')
    const sent = [
      ...run.tenantQueue.send.mock.calls.map(c => c[0]),
      ...run.tenantQueue.sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body)),
    ]
    const msg = sent.find((m: any) => m.billId === `legiscan:${B0769}` && m.calendar)
    expect(msg?.calendar?.changes.map((c: any) => c.changeType)).toContain('hearing_cancelled')
  })
})

describe('POST /api/admin/lims-sync', () => {
  it('runs a full pass immediately, outside the full-sync hours, and reports it', async () => {
    const { app } = await import('../../src/index-legiscan')
    const schedule = await import('../../src/lib/sync-schedule')
    vi.mocked(schedule.getCurrentEtHour).mockReturnValue(8)   // not a full-pass hour
    try {
      const { env: e, limsQueue } = makeEnv({ ADMIN_SECRET: 'test-secret' })
      const res = await app.fetch(new Request('http://central/api/admin/lims-sync', {
        method: 'POST', headers: { 'x-admin-secret': 'test-secret' },
      }), e)
      expect(res.status).toBe(200)
      const body = await res.json() as { ok: boolean; passes: { sessionId: number; records: number; queued: number }[] }
      expect(body.passes).toEqual([expect.objectContaining({ sessionId: limsSessionId(26), records: 4, queued: 2 })])
      expect(limsQueue.sendBatch).toHaveBeenCalled()
      expect(lims.getMembers).toHaveBeenCalled()
    } finally {
      vi.mocked(schedule.getCurrentEtHour).mockReturnValue(5)
    }
  })

  it('rejects a request without the admin secret', async () => {
    const { app } = await import('../../src/index-legiscan')
    const { env: e } = makeEnv({ ADMIN_SECRET: 'test-secret' })
    const res = await app.fetch(new Request('http://central/api/admin/lims-sync', { method: 'POST' }), e)
    expect(res.status).toBe(401)
    expect(lims.getBulkData).not.toHaveBeenCalled()
  })
})

describe('POST /api/admin/providers/:id/sync', () => {
  const post = async (id: string) => {
    const { app } = await import('../../src/index-legiscan')
    const { env: e } = makeEnv({ ADMIN_SECRET: 'test-secret' })
    return app.fetch(new Request(`http://central/api/admin/providers/${id}/sync`, {
      method: 'POST', headers: { 'x-admin-secret': 'test-secret' },
    }), e)
  }

  it('runs the named provider', async () => {
    const res = await post('lims')
    expect(res.status).toBe(200)
    const body = await res.json() as { passes: { sessionId: number }[] }
    expect(body.passes.map(p => p.sessionId)).toEqual([limsSessionId(26)])
  })

  it('answers 404 for a provider central does not know', async () => {
    expect((await post('nope')).status).toBe(404)
  })
})

describe('monitor stubs', () => {
  it('link every LIMS bill to its Council page, matched or not', async () => {
    const db = drizzle(env.DB, { schema })
    await runLimsSync(makeEnv().env, db)
    const stub = await db.select().from(schema.bills).where(eq(schema.bills.billId, limsBillId('B26-0001')!)).get()
    expect(stub?.stateLink).toBe('https://lims.dccouncil.gov/Legislation/B26-0001')
  })
})

describe('POST /api/admin/lims-import', () => {
  const CP25 = { councilPeriodId: 25, councilPeriod: '25 (2023-24)', startDate: '2023-01-02T00:00:00', endDate: '2024-12-31T00:00:00' }
  const secureDc = {
    ...bulk['B26-0400'],
    legislationNumber: 'B25-0345',
    title: 'Accountability and Victim Protection Amendment Act of 2023 (now known as "Secure DC Omnibus Amendment Act of 2024")',
    status: 'Official Law',
    legislationHistory: bulk['B26-0400'].legislationHistory.map(h => ({ ...h, legislationNumber: 'B25-0345' })),
  }

  async function post(e: any, body: unknown) {
    const { app } = await import('../../src/index-legiscan')
    return app.fetch(new Request('http://central/api/admin/lims-import', {
      method: 'POST', headers: { 'x-admin-secret': 'test-secret', 'content-type': 'application/json' }, body: JSON.stringify(body),
    }), e)
  }

  it('imports a prior-period measure as a manual pick, ingests it, and leaves that period out of the daily sync', async () => {
    const db = drizzle(env.DB, { schema })
    vi.mocked(lims.getCouncilPeriods).mockResolvedValue([PERIOD, CP25])
    vi.mocked(lims.getBulkData).mockImplementation(async (c: number, cp: number) =>
      cp === 25 && c === 1 ? [secureDc] : c === 1 ? [bulk['B26-0400']] : [])
    const { env: e, limsQueue } = makeEnv({ ADMIN_SECRET: 'test-secret' })

    const res = await post(e, { tenantId: 'oca', numbers: ['B25-345', 'B25-9999', 'NOPE'] })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, imported: ['B25-0345'], notFound: ['B25-9999'], invalid: ['NOPE'] })

    const billId = limsBillId('B25-0345')!
    const link = await db.select().from(schema.billTenants).where(eq(schema.billTenants.billId, billId)).get()
    expect(link?.matchType).toBe('manual')
    const session = await db.select().from(schema.sessions).where(eq(schema.sessions.sessionId, limsSessionId(25))).get()
    expect(session).toMatchObject({ sessionName: '2023-2024 Council Period 25', prior: 1, sineDie: 1 })
    const queued = limsQueue.sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body.billId))
    expect(queued).toContain(billId)

    // The ingestor builds it like any LIMS bill.
    vi.mocked(lims.getLegislationDetails).mockResolvedValue({ ...JSON.parse(details0400Raw), legislationNumber: 'B25-0345' })
    const retry = vi.fn()
    await processIngestorQueue({ messages: [{ body: { billId }, ack: vi.fn(), retry }] } as any, e, db)
    expect(retry).not.toHaveBeenCalled()
    const bill = await db.select().from(schema.bills).where(eq(schema.bills.billId, billId)).get()
    expect(bill?.stateLink).toBe('https://lims.dccouncil.gov/Legislation/B25-0345')

    // The scheduled sync never pulls Council Period 25.
    vi.mocked(lims.getBulkData).mockClear()
    await runLimsSync(makeEnv().env, db)
    expect(vi.mocked(lims.getBulkData).mock.calls.map(c => c[1])).not.toContain(25)
  })

  it('validates its input and the tenant', async () => {
    const { env: e } = makeEnv({ ADMIN_SECRET: 'test-secret' })
    expect((await post(e, { tenantId: 'oca' })).status).toBe(400)
    expect((await post(e, { tenantId: 'nobody', numbers: ['B25-0345'] })).status).toBe(404)
  })
})

describe('bill types', () => {
  it('stores the LIMS type (Emergency, Permanent, ...) on stubs and keeps it through ingest', async () => {
    const db = drizzle(env.DB, { schema })
    await runLimsSync(makeEnv().env, db)
    const stub = await db.select().from(schema.bills).where(eq(schema.bills.billId, limsBillId('B26-0001')!)).get()
    expect(stub?.billType).toBe(bulk['B26-0001'].legislationSubCategory)
    await processIngestorQueue({ messages: [{ body: { billId: B0400 }, ack: vi.fn(), retry: vi.fn() }] } as any, makeEnv().env, db)
    const ingested = await db.select().from(schema.bills).where(eq(schema.bills.billId, B0400)).get()
    expect(ingested?.billType).toBe('Permanent Bill')
  })
})

describe('sponsors of earlier Council Periods', () => {
  it('keeps a sponsor who left the Council before the current period, on an imported bill', async () => {
    const db = drizzle(env.DB, { schema })
    const CP25 = { councilPeriodId: 25, councilPeriod: '25 (2023-24)', startDate: '2023-01-02T00:00:00', endDate: '2024-12-31T00:00:00' }
    const gone = { id: 150, name: 'Vincent C. Gray', firstName: 'Vincent', lastName: 'Gray', middleName: 'C.', title: 'Councilmember', startDate: '2023-01-02T00:00:00', endDate: '2025-01-02T00:00:00' }
    vi.mocked(lims.getCouncilPeriods).mockResolvedValue([PERIOD, CP25])
    vi.mocked(lims.getMembers).mockImplementation(async (cp: number) => cp === 25 ? [gone] as any : JSON.parse(membersRaw))
    const secureDc = { ...bulk['B26-0400'], legislationNumber: 'B25-0345', legislationHistory: bulk['B26-0400'].legislationHistory.map(h => ({ ...h, legislationNumber: 'B25-0345' })) }
    vi.mocked(lims.getBulkData).mockImplementation(async (c: number, cp: number) => cp === 25 && c === 1 ? [secureDc] : c === 1 ? [bulk['B26-0400']] : [])
    const { env: e } = makeEnv({ ADMIN_SECRET: 'test-secret' })
    const { app } = await import('../../src/index-legiscan')
    await app.fetch(new Request('http://central/api/admin/lims-import', {
      method: 'POST', headers: { 'x-admin-secret': 'test-secret', 'content-type': 'application/json' }, body: JSON.stringify({ tenantId: 'oca', numbers: ['B25-0345'] }),
    }), e)

    await refreshProviderSessions(limsProvider, 'DC', providerContext(limsProvider, e, db), db)
    expect(vi.mocked(lims.getMembers).mock.calls.map(c => c[0])).toEqual(expect.arrayContaining([25, 26]))

    const billId = limsBillId('B25-0345')!
    vi.mocked(lims.getLegislationDetails).mockResolvedValue({ ...JSON.parse(details0400Raw), legislationNumber: 'B25-0345', introducers: [{ memberName: 'Gray, Vincent C.', memberTitle: 'Councilmember' }] })
    await processIngestorQueue({ messages: [{ body: { billId }, ack: vi.fn(), retry: vi.fn() }] } as any, e, db)
    const sponsors = await db.select().from(schema.billSponsors).where(eq(schema.billSponsors.billId, billId)).all()
    expect(sponsors.map(s => s.peopleId)).toContain(1_000_000_150)
    vi.mocked(lims.getMembers).mockResolvedValue(JSON.parse(membersRaw))
  })
})

