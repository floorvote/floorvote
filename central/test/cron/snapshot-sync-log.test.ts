import { env } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from '../../src/db/schema'
import { resetCentral } from '../helpers/mainSeam'
import { legiscanMigrations, setupDb } from '../helpers/migrations'
import bulkRaw from '../fixtures/lims/bulk-records.json?raw'
import membersRaw from '../fixtures/lims/members-26.json?raw'
import mgaRaw from '../fixtures/mga/2026RS-sample.json?raw'
import lisRaw from '../fixtures/lis/20261-sample.json?raw'

// Every snapshot provider pass (LIMS, MGA, LIS) leaves one session_sync_log row
// per session it ran, the way a LegiScan pass does: the pass's counts when it
// finished, zeros when the provider answered with nothing, and a failed row
// with the error when it threw. The States page reads that row.
vi.mock('../../src/lib/rateLimitedFetch', () => import('../helpers/unpacedFetch'))
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
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { runSnapshotSync } from '../../src/cron/sync-snapshots'
import { lims } from '../../src/providers/lims'
import { mga } from '../../src/providers/mga'
import { lis } from '../../src/providers/lis'
import * as limsClient from '../../src/providers/lims/client'
import * as mgaClient from '../../src/providers/mga/client'
import { LIS_FILES, LIS_FILES_BASE, type LisFile, type LisFiles } from '../../src/providers/lis/client'
import { loadStateRows } from '../../src/lib/stateRows'
import { tenantQueueBindingName } from '../../src/lib/tenantQueue'
import { app } from '../../src/index-legiscan'
import { getCurrentEtHour } from '../../src/lib/sync-schedule'

const db = () => drizzle(env.DB, { schema })
const bulk = JSON.parse(bulkRaw) as Record<string, limsClient.LimsBulkRecord>
const mgaSample = JSON.parse(mgaRaw) as mgaClient.MgaRecord[]
const PERIOD = { councilPeriodId: 26, councilPeriod: '26 (2025-26)', startDate: '2025-01-02T00:00:00', endDate: '2026-12-31T00:00:00' }
const MGA_CODE = '2026RS'
const MGA_CODE_2 = '2026S1'
const mgaFile = (records = mgaSample): mgaClient.MgaSessionFile => ({ unchanged: false, records: structuredClone(records), etag: null })

function makeEnv() {
  const queue = () => ({ sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue(undefined) })
  const ingestor = queue(), limsQueue = queue(), lisQueue = queue()
  const tenants = { dc: queue(), md: queue(), va: queue() }
  return {
    ingestor, limsQueue, lisQueue,
    env: {
      ...(env as any), ADMIN_SECRET: 'sek',
      LIMS_API_KEY: 'lims-key', LIMS_CATEGORIES: '1,18',
      LIMS_INGESTOR_QUEUE: limsQueue, LIS_INGESTOR_QUEUE: lisQueue, INGESTOR_QUEUE: ingestor,
      [tenantQueueBindingName('dc')]: tenants.dc,
      [tenantQueueBindingName('md')]: tenants.md,
      [tenantQueueBindingName('va')]: tenants.va,
    } as any,
  }
}
const queuedIds = (q: { sendBatch: ReturnType<typeof vi.fn> }) => q.sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body.billId))

// The stubbed LIS: one session's files, served from the recorded fixture.
let lisServed: Partial<Record<LisFile, { text: string; etag: string; status?: number }>>
function serveLis(files: LisFiles = JSON.parse(lisRaw) as LisFiles) {
  lisServed = Object.fromEntries((Object.keys(LIS_FILES) as LisFile[]).filter(f => files[f]).map(f => [f, { text: files[f], etag: `"${f}-v1"` }]))
}

const logRows = () => db().select().from(schema.sessionSyncLog).orderBy(schema.sessionSyncLog.id).all()
const sessionRows = () => db().select().from(schema.sessions).all()

beforeEach(async () => {
  await resetCentral()
  // clearAllMocks keeps an implementation a test set, so each test starts at the full-pass hour.
  vi.mocked(getCurrentEtHour).mockReturnValue(5)
  serveLis()
  vi.mocked(limsClient.getCouncilPeriods).mockResolvedValue([PERIOD])
  vi.mocked(limsClient.getMembers).mockResolvedValue(JSON.parse(membersRaw))
  vi.mocked(limsClient.getBulkData).mockImplementation(async (categoryId: number) =>
    categoryId === 1 ? [bulk['B26-0400'], bulk['B26-0769'], bulk['B26-0001']] : categoryId === 18 ? [bulk['HN26-0171']] : [])
  vi.mocked(mgaClient.mgaSessionExists).mockImplementation(async code => code === MGA_CODE)
  vi.mocked(mgaClient.getMgaSession).mockImplementation(async code => (code === MGA_CODE ? mgaFile() : null))
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const method = init?.method ?? 'GET'
    if (url.startsWith(`${LIS_FILES_BASE}/`)) {
      const [code, name] = url.slice(LIS_FILES_BASE.length + 1).split('/')
      const file = (Object.keys(LIS_FILES) as LisFile[]).find(f => LIS_FILES[f] === name)
      // Only the regular session is published.
      const served = file && code === '20261' ? lisServed[file] : undefined
      if (!served) return new Response('<Error><Code>BlobNotFound</Code></Error>', { status: 404 })
      if (served.status) return new Response('server error', { status: served.status })
      return new Response(method === 'HEAD' ? null : served.text, { headers: { ETag: served.etag } })
    }
    return new Response('%PDF-1.7\n%%EOF\n', { status: 200, headers: { 'content-type': 'application/pdf' } })
  })
  const d = db()
  await d.insert(schema.tenants).values([
    { tenantId: 'dc', name: 'DC team', stateCoverage: '["DC"]', active: true },
    { tenantId: 'md', name: 'MD team', stateCoverage: '["MD"]', active: true },
    { tenantId: 'va', name: 'VA team', stateCoverage: '["VA"]', active: true },
  ])
  await d.insert(schema.keywordRegistry).values([
    { tenantId: 'dc', keyword: 'neglect' }, { tenantId: 'dc', keyword: 'behavioral health' },
    { tenantId: 'md', keyword: 'cost recovery' },
    { tenantId: 'va', keyword: 'minimum wage' }, { tenantId: 'va', keyword: 'daylight' }, { tenantId: 'va', keyword: 'procurement' },
  ])
  await d.insert(schema.stateProviders).values([
    { state: 'DC', provider: 'lims', previousProvider: 'legiscan' },
    { state: 'MD', provider: 'mga', previousProvider: 'legiscan' },
    { state: 'VA', provider: 'lis', previousProvider: 'legiscan' },
  ])
})

afterEach(async () => {
  vi.useRealTimers()
  // clearDb() empties tables but keeps triggers; three tests below install one.
  await env.DB.exec('DROP TRIGGER IF EXISTS no_etag; DROP TRIGGER IF EXISTS no_failed_rows;')
})

describe('a pass that finishes', () => {
  it('logs one row for a LIMS pass, with the counts it reported', async () => {
    const { env: e, limsQueue } = makeEnv()
    const reports = await runSnapshotSync(lims, e, db())
    expect(reports).toHaveLength(1)
    const [session] = await sessionRows()
    const rows = await logRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      state: 'DC', sessionId: session.sessionId, sessionName: session.sessionName, status: 'ok', error: null,
      billsChecked: reports[0].records, billsChanged: expect.any(Number), billsQueued: queuedIds(limsQueue).length,
    })
    expect(rows[0].billsChecked).toBeGreaterThan(0)
    expect(rows[0].billsQueued).toBeGreaterThan(0)
    expect(rows[0].billsChanged).toBeGreaterThan(0)
  })

  it('logs one row for an MGA pass, with the counts it reported', async () => {
    const { env: e, ingestor } = makeEnv()
    const reports = await runSnapshotSync(mga, e, db())
    const [session] = await sessionRows()
    const rows = await logRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      state: 'MD', sessionId: session.sessionId, sessionName: session.sessionName, status: 'ok', error: null,
      billsChecked: reports[0].records, billsQueued: queuedIds(ingestor).length,
    })
    expect(rows[0].billsChecked).toBe(mgaSample.length)
    expect(rows[0].billsQueued).toBeGreaterThan(0)
  })

  it('logs one row for a LIS pass, with the counts it reported', async () => {
    vi.setSystemTime(new Date('2026-09-28T09:00:00Z'))
    const { env: e, lisQueue } = makeEnv()
    const reports = await runSnapshotSync(lis, e, db())
    const rows = await logRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      state: 'VA', sessionName: expect.any(String), status: 'ok', error: null,
      billsChecked: reports[0].records, billsQueued: queuedIds(lisQueue).length,
    })
    expect(rows[0].billsChecked).toBeGreaterThan(0)
    expect(rows[0].billsQueued).toBeGreaterThan(0)
  })

  it('logs a pass over unchanged data as every bill checked and none changed or queued', async () => {
    const { env: e } = makeEnv()
    await runSnapshotSync(lims, e, db())
    await runSnapshotSync(lims, e, db())
    const rows = await logRows()
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({ status: 'ok', billsChecked: rows[0].billsChecked, billsChanged: 0, billsQueued: 0 })
  })

  it('logs a zero-count ok row when the provider answers with nothing', async () => {
    vi.mocked(limsClient.getBulkData).mockResolvedValue([])
    const { env: e } = makeEnv()
    await runSnapshotSync(lims, e, db())
    const rows = await logRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ state: 'DC', status: 'ok', error: null, billsChecked: 0, billsChanged: 0, billsQueued: 0 })
  })

  it('logs a zero-count ok row for a feed that answers 304 with no stored records', async () => {
    vi.mocked(mgaClient.getMgaSession).mockImplementation(async code =>
      (code === MGA_CODE ? { unchanged: true, records: [], etag: null } : null))
    const { env: e } = makeEnv()
    await runSnapshotSync(mga, e, db())
    expect(await logRows()).toMatchObject([{ state: 'MD', status: 'ok', billsChecked: 0, billsChanged: 0, billsQueued: 0 }])
  })

  it('logs one row per session when a run covers several', async () => {
    vi.mocked(mgaClient.mgaSessionExists).mockImplementation(async code => code === MGA_CODE || code === MGA_CODE_2)
    vi.mocked(mgaClient.getMgaSession).mockImplementation(async code =>
      (code === MGA_CODE || code === MGA_CODE_2 ? mgaFile() : null))
    const { env: e } = makeEnv()
    await runSnapshotSync(mga, e, db())
    const rows = await logRows()
    const sessions = await sessionRows()
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map(r => r.sessionId))).toEqual(new Set(sessions.map(s => s.sessionId)))
    for (const r of rows) {
      expect(r).toMatchObject({ state: 'MD', status: 'ok' })
      expect(r.sessionName).toBe(sessions.find(s => s.sessionId === r.sessionId)!.sessionName)
    }
  })

  it('logs each row under the state of its own session', async () => {
    vi.mocked(mgaClient.mgaSessionExists).mockImplementation(async code => code === MGA_CODE || code === MGA_CODE_2)
    vi.mocked(mgaClient.getMgaSession).mockImplementation(async code =>
      (code === MGA_CODE || code === MGA_CODE_2 ? mgaFile() : null))
    const { env: e } = makeEnv()
    await runSnapshotSync(lims, e, db())
    await runSnapshotSync(mga, e, db())
    const sessions = new Map((await sessionRows()).map(s => [s.sessionId, s]))
    const rows = await logRows()
    expect(rows.length).toBeGreaterThanOrEqual(3)
    for (const r of rows) expect(r.state, `row ${r.id}`).toBe(sessions.get(r.sessionId)!.state)
  })

  it('logs nothing for a session whose pass is not due', async () => {
    const { env: e } = makeEnv()
    await runSnapshotSync(mga, e, db())
    expect(await logRows()).toHaveLength(1)
    // Hour 4 ET is no full-pass hour for the default schedule.
    vi.mocked(getCurrentEtHour).mockReturnValue(4)
    await runSnapshotSync(mga, e, db())
    expect(await logRows()).toHaveLength(1)
  })

  it('logs nothing when the state has no covering tenant', async () => {
    await db().update(schema.tenants).set({ active: false }).where(eq(schema.tenants.tenantId, 'md'))
    const { env: e } = makeEnv()
    await runSnapshotSync(mga, e, db())
    expect(await logRows()).toEqual([])
  })

  it('logs nothing for an empty answer when the provider lost the state to another during the pass', async () => {
    vi.mocked(mgaClient.getMgaSession).mockImplementation(async code => {
      if (code !== MGA_CODE) return null
      await db().update(schema.stateProviders).set({ provider: 'legiscan' }).where(eq(schema.stateProviders.state, 'MD'))
      return { unchanged: true, records: [], etag: null }
    })
    const { env: e } = makeEnv()
    await runSnapshotSync(mga, e, db())
    expect(await logRows()).toEqual([])
  })

  it('logs nothing when the provider lost the state to another during the pass', async () => {
    vi.mocked(mgaClient.getMgaSession).mockImplementation(async code => {
      if (code !== MGA_CODE) return null
      await db().update(schema.stateProviders).set({ provider: 'legiscan' }).where(eq(schema.stateProviders.state, 'MD'))
      return mgaFile()
    })
    const { env: e, ingestor } = makeEnv()
    expect(await runSnapshotSync(mga, e, db())).toHaveLength(1)
    expect(queuedIds(ingestor)).toEqual([])
    expect(await logRows()).toEqual([])
  })
})

describe('a pass that fails', () => {
  it('logs a failed LIMS pass as failed, with its error and no counts, and still throws', async () => {
    vi.mocked(limsClient.getBulkData).mockRejectedValue(new Error('LIMS is down'))
    const { env: e } = makeEnv()
    await expect(runSnapshotSync(lims, e, db())).rejects.toThrow('LIMS is down')
    const [session] = await sessionRows()
    expect(await logRows()).toMatchObject([{
      state: 'DC', sessionId: session.sessionId, sessionName: session.sessionName,
      status: 'failed', error: expect.stringContaining('LIMS is down'), billsChecked: 0, billsChanged: 0, billsQueued: 0,
    }])
  })

  it('logs a failed MGA pass as failed', async () => {
    vi.mocked(mgaClient.getMgaSession).mockRejectedValue(new Error('MGA file unreadable'))
    const { env: e } = makeEnv()
    await expect(runSnapshotSync(mga, e, db())).rejects.toThrow('MGA file unreadable')
    expect(await logRows()).toMatchObject([{ state: 'MD', status: 'failed', error: expect.stringContaining('MGA file unreadable') }])
  })

  it('logs a LIS pass that fails closed on a bad file as failed', async () => {
    vi.setSystemTime(new Date('2026-09-28T09:00:00Z'))
    lisServed.history = { text: '', etag: '"x"', status: 500 }
    const { env: e, lisQueue } = makeEnv()
    await expect(runSnapshotSync(lis, e, db())).rejects.toThrow()
    expect(queuedIds(lisQueue)).toEqual([])
    const rows = await logRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ state: 'VA', status: 'failed', billsChecked: 0 })
    expect(rows[0].error).toBeTruthy()
  })

  it('logs a pass that throws partway through, after it stored records, as failed and not ok', async () => {
    const { env: e, ingestor } = makeEnv()
    ingestor.sendBatch.mockRejectedValue(new Error('queue unavailable'))
    await expect(runSnapshotSync(mga, e, db())).rejects.toThrow('queue unavailable')
    // The records were stored before the queue failed, and the pass still reads as failed.
    expect((await db().select().from(schema.providerRecords).all()).length).toBeGreaterThan(0)
    expect(await logRows()).toMatchObject([{ state: 'MD', status: 'failed', error: expect.stringContaining('queue unavailable') }])
  })

  it('logs a pass that throws after its counts were logged as failed, the newest row, beside the ok one', async () => {
    // The ETag is stored once everything is queued, after applyMasterList has logged the counts.
    await env.DB.exec(`CREATE TRIGGER no_etag BEFORE UPDATE OF snapshot_etag ON sessions BEGIN SELECT RAISE(ABORT, 'etag write refused'); END`)
    const { env: e } = makeEnv()
    await expect(runSnapshotSync(mga, e, db())).rejects.toThrow()
    expect((await logRows()).map(r => r.status)).toEqual(['ok', 'failed'])
    const row = (await loadStateRows(db(), e)).find(r => r.state === 'MD')!
    expect(row.schedule.lastPass).toMatchObject({ status: 'failed', error: expect.stringContaining('etag write refused'), billsChecked: 0 })
  })

  it('logs the database\'s error for a failed query, not the SQL and the values bound to it', async () => {
    await env.DB.exec(`CREATE TRIGGER no_etag BEFORE UPDATE OF snapshot_etag ON sessions BEGIN SELECT RAISE(ABORT, 'etag write refused'); END`)
    const { env: e } = makeEnv()
    await expect(runSnapshotSync(mga, e, db())).rejects.toThrow()
    const failed = (await logRows()).find(r => r.status === 'failed')!
    expect(failed.error).toContain('etag write refused')
    expect(failed.error).not.toMatch(/Failed query|params:|update "sessions"/)
  })

  it('truncates a long error', async () => {
    vi.mocked(limsClient.getBulkData).mockRejectedValue(new Error(`bad ${'x'.repeat(5000)}`))
    const { env: e } = makeEnv()
    await expect(runSnapshotSync(lims, e, db())).rejects.toThrow()
    const [row] = await logRows()
    expect(row.error!.length).toBeLessThanOrEqual(500)
    expect(row.error!.startsWith('Error: bad xxx') || row.error!.startsWith('bad xxx')).toBe(true)
  })

  it('logs a thrown value that is not an Error', async () => {
    vi.mocked(limsClient.getBulkData).mockImplementation(async () => { throw 'plain string failure' })
    const { env: e } = makeEnv()
    await expect(runSnapshotSync(lims, e, db())).rejects.toThrow('plain string failure')
    expect(await logRows()).toMatchObject([{ status: 'failed', error: 'plain string failure' }])
  })

  it('logs the failing session as failed and the others as ok, and throws once at the end', async () => {
    vi.mocked(mgaClient.mgaSessionExists).mockImplementation(async code => code === MGA_CODE || code === MGA_CODE_2)
    vi.mocked(mgaClient.getMgaSession).mockImplementation(async code => {
      if (code === MGA_CODE_2) throw new Error('special session unreadable')
      return code === MGA_CODE ? mgaFile() : null
    })
    const { env: e } = makeEnv()
    await expect(runSnapshotSync(mga, e, db())).rejects.toThrow('special session unreadable')
    const sessions = new Map((await sessionRows()).map(s => [s.sessionTag, s.sessionId]))
    const byStatus = Object.fromEntries((await logRows()).map(r => [r.sessionId, r.status]))
    expect(byStatus).toEqual({ [sessions.get(MGA_CODE)!]: 'ok', [sessions.get(MGA_CODE_2)!]: 'failed' })
  })

  it('logs one failed row per failing session when several fail', async () => {
    vi.mocked(mgaClient.mgaSessionExists).mockImplementation(async code => code === MGA_CODE || code === MGA_CODE_2)
    vi.mocked(mgaClient.getMgaSession).mockRejectedValue(new Error('every file unreadable'))
    const { env: e } = makeEnv()
    await expect(runSnapshotSync(mga, e, db())).rejects.toBeInstanceOf(AggregateError)
    const rows = await logRows()
    expect(rows.map(r => r.status)).toEqual(['failed', 'failed'])
    expect(new Set(rows.map(r => r.sessionId)).size).toBe(2)
  })

  it('does not stamp the session synced, so the States page does not read a failed pass as a read', async () => {
    vi.mocked(mgaClient.getMgaSession).mockRejectedValue(new Error('down'))
    const { env: e } = makeEnv()
    await expect(runSnapshotSync(mga, e, db())).rejects.toThrow()
    expect((await sessionRows())[0].lastSyncedAt).toBeNull()
  })

  it('logs a failed pass after an ok one, so the newest row is the failure', async () => {
    const { env: e } = makeEnv()
    await runSnapshotSync(mga, e, db())
    vi.mocked(mgaClient.getMgaSession).mockRejectedValue(new Error('down again'))
    await expect(runSnapshotSync(mga, e, db())).rejects.toThrow('down again')
    expect((await logRows()).map(r => r.status)).toEqual(['ok', 'failed'])
  })
})

describe('a logging failure', () => {
  const dropLog = () => env.DB.exec('DROP TABLE session_sync_log')
  // The schema is built once per file (test/setup.ts); put the table back.
  afterEach(() => setupDb(legiscanMigrations))

  it('does not break a pass that finishes with nothing, or its session stamp', async () => {
    vi.mocked(limsClient.getBulkData).mockResolvedValue([])
    await dropLog()
    const { env: e } = makeEnv()
    await expect(runSnapshotSync(lims, e, db())).resolves.toMatchObject([{ records: 0, queued: 0 }])
    expect((await sessionRows())[0].lastSyncedAt).not.toBeNull()
  })

  it('does not break a pass that has records: they are queued, stored, and the ETag moves', async () => {
    await dropLog()
    const { env: e, ingestor } = makeEnv()
    const reports = await runSnapshotSync(mga, e, db())
    expect(reports).toHaveLength(1)
    expect(reports[0].queued).toBeGreaterThan(0)
    expect(queuedIds(ingestor).length).toBe(reports[0].queued)
    expect((await db().select().from(schema.providerRecords).all()).length).toBe(mgaSample.length)
    expect((await sessionRows())[0].lastSyncedAt).not.toBeNull()
  })

  it('does not hide the pass error when the failed row cannot be logged', async () => {
    vi.mocked(limsClient.getBulkData).mockRejectedValue(new Error('LIMS is down'))
    await dropLog()
    const { env: e } = makeEnv()
    await expect(runSnapshotSync(lims, e, db())).rejects.toThrow('LIMS is down')
  })

  it('does not stop the next session from running or logging', async () => {
    vi.mocked(mgaClient.mgaSessionExists).mockImplementation(async code => code === MGA_CODE || code === MGA_CODE_2)
    vi.mocked(mgaClient.getMgaSession).mockImplementation(async code => {
      if (code === MGA_CODE) throw new Error('first unreadable')
      return code === MGA_CODE_2 ? mgaFile() : null
    })
    // Only a failed row is refused, as a log that rejects one kind of write would.
    await env.DB.exec(`CREATE TRIGGER no_failed_rows BEFORE INSERT ON session_sync_log WHEN NEW.status = 'failed' BEGIN SELECT RAISE(ABORT, 'log refuses failed rows'); END`)
    const { env: e } = makeEnv()
    await expect(runSnapshotSync(mga, e, db())).rejects.toThrow('first unreadable')
    expect(await logRows()).toMatchObject([{ status: 'ok', sessionName: expect.any(String) }])
  })
})

describe('the States page after a snapshot pass', () => {
  async function stateRow(state: string, e: any) {
    const res = await app.fetch(new Request('http://central/admin/dash/states', { headers: { Authorization: 'Bearer sek' } }), e)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    return body.data.states.find((r: any) => r.state === state)
  }

  it('shows a LIMS pass\'s time and counts', async () => {
    const { env: e } = makeEnv()
    await runSnapshotSync(lims, e, db())
    const [log] = await logRows()
    const row = await stateRow('DC', e)
    expect(row.schedule.lastPass).toEqual({
      at: new Date(`${log.syncedAt.replace(' ', 'T')}Z`).toISOString(), status: 'ok', error: null,
      billsChecked: log.billsChecked, billsChanged: log.billsChanged, billsQueued: log.billsQueued,
    })
    expect(row.schedule.lastPass.billsChecked).toBeGreaterThan(0)
  })

  it('shows an MGA pass\'s counts', async () => {
    const { env: e } = makeEnv()
    await runSnapshotSync(mga, e, db())
    const row = await stateRow('MD', e)
    expect(row.schedule.lastPass).toMatchObject({ status: 'ok', billsChecked: mgaSample.length })
  })

  it('shows a LIS pass\'s counts', async () => {
    vi.setSystemTime(new Date('2026-09-28T09:00:00Z'))
    const { env: e } = makeEnv()
    await runSnapshotSync(lis, e, db())
    const [log] = await logRows()
    const row = await stateRow('VA', e)
    expect(row.schedule.lastPass).toMatchObject({ status: 'ok', billsChecked: log.billsChecked, billsQueued: log.billsQueued })
    expect(log.billsChecked).toBeGreaterThan(0)
  })

  it('shows a failed pass as failed with its error, not as zero bills checked', async () => {
    vi.mocked(limsClient.getBulkData).mockRejectedValue(new Error('LIMS is down'))
    const { env: e } = makeEnv()
    await expect(runSnapshotSync(lims, e, db())).rejects.toThrow()
    const row = await stateRow('DC', e)
    expect(row.schedule.lastPass).toMatchObject({ status: 'failed', error: expect.stringContaining('LIMS is down') })
  })

  it('shows a state whose provider never ran as having no pass logged', async () => {
    const { env: e } = makeEnv()
    await runSnapshotSync(lims, e, db())
    expect((await stateRow('MD', e))?.schedule.lastPass ?? null).toBeNull()
  })

  it('reads the pass the same through loadStateRows', async () => {
    const { env: e } = makeEnv()
    await runSnapshotSync(mga, e, db())
    const rows = await loadStateRows(db(), e)
    expect(rows.find(r => r.state === 'MD')!.schedule.lastPass).toMatchObject({ status: 'ok', billsChecked: mgaSample.length })
  })
})
