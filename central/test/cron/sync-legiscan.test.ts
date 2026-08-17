import { env, applyD1Migrations, reset } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from '../../src/db/schema-legiscan'
import { sessions, bills, billTenants, tenants, keywordRegistry } from '../../src/db/schema-legiscan'
import migration0001 from '../../migrations-legiscan/0001_initial.sql?raw'
import migration0002 from '../../migrations-legiscan/0002_api_call_log_v2.sql?raw'
import migration0003 from '../../migrations-legiscan/0003_session_sync_log.sql?raw'
import migration0004 from '../../migrations-legiscan/0004_match_tracking.sql?raw'
import migration0005 from '../../migrations-legiscan/0005_bill_amendments_and_change_log.sql?raw'
import migration0006 from '../../migrations-legiscan/0006_texts_fetched_at.sql?raw'
import migration0013 from '../../migrations-legiscan/0013_tenants_queue_id.sql?raw'
import migration0017 from '../../migrations-legiscan/0017_tenant_ai_personalized.sql?raw'

// Mock the legiscan module — runFullPass uses getMasterListBySession + refreshLsSessions
// (which calls getSessionList); runRawPass uses getMasterListRaw.
vi.mock('../../src/lib/legiscan', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/legiscan')>('../../src/lib/legiscan')
  return {
    ...actual,
    getMasterListBySession: vi.fn(),
    getMasterListRaw: vi.fn(),
    getSessionList: vi.fn().mockResolvedValue([]),
  }
})

vi.mock('../../src/lib/queuesRest', () => ({
  publishBatch: vi.fn().mockResolvedValue(undefined),
  publishMessage: vi.fn().mockResolvedValue(undefined),
  queuesRestEnabled: () => true,
}))

import { runLsSync } from '../../src/cron/sync-legiscan'
import * as legiscan from '../../src/lib/legiscan'
import * as queuesRest from '../../src/lib/queuesRest'

function parseMigration(sql: string, name: string) {
  const queries = sql
    .split(';')
    .map(s => s.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n').trim())
    .filter(s => s.length > 0)
    .map(s => s + ';')
  return { name, queries }
}

function getCurrentEtHour(): number {
  return parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(new Date()),
    10,
  )
}

beforeEach(async () => {
  await reset()
  await applyD1Migrations(env.DB, [
    parseMigration(migration0001, '0001_initial'),
    parseMigration(migration0002, '0002_api_call_log_v2'),
    parseMigration(migration0003, '0003_session_sync_log'),
    parseMigration(migration0004, '0004_match_tracking'),
    parseMigration(migration0005, '0005_bill_amendments_and_change_log'),
    parseMigration(migration0006, '0006_texts_fetched_at'),
    parseMigration(migration0013, '0013_tenants_queue_id'),
    parseMigration(migration0017, '0017_tenant_ai_personalized'),
  ])
  vi.clearAllMocks()
  // Re-establish the default for getSessionList after clearAllMocks wipes implementations.
  vi.mocked(legiscan.getSessionList).mockResolvedValue([])
})

describe('runLsSync → runFullPass', () => {
  it('writes matchType=keyword for matching tenants, null for non-matching, queues only newly-matched', async () => {
    const db = drizzle(env.DB, { schema })
    const etHour = getCurrentEtHour()

    await db.insert(sessions).values({
      sessionId: 9001,
      state: 'DC',
      stateId: 51,
      yearStart: 2025,
      yearEnd: 2026,
      sessionTitle: 'Test',
      sessionName: 'Test',
      fullSyncHoursEt: JSON.stringify([etHour]),
      rawSyncHoursEt: JSON.stringify([]),
    })

    await db.insert(tenants).values({
      tenantId: 'test-t',
      name: 'Test',
      stateCoverage: JSON.stringify(['DC']),
      active: true,
    })

    await db.insert(keywordRegistry).values({ tenantId: 'test-t', keyword: 'voter' })

    vi.mocked(legiscan.getMasterListBySession).mockResolvedValue([
      {
        bill_id: 1,
        number: 'B26-0001',
        change_hash: 'h1',
        title: 'Voter ID Act',
        description: 'requires identification',
        status: 1,
        status_date: '2025-01-01',
        last_action: 'introduced',
        last_action_date: '2025-01-01',
        url: 'https://example.com/1',
      },
      {
        bill_id: 2,
        number: 'B26-0002',
        change_hash: 'h2',
        title: 'Bridge Naming',
        description: 'rename a bridge',
        status: 1,
        status_date: '2025-01-01',
        last_action: 'introduced',
        last_action_date: '2025-01-01',
        url: 'https://example.com/2',
      },
    ] as any)

    const sendBatch = vi.fn().mockResolvedValue(undefined)
    const mockEnv = { ...(env as any), INGESTOR_QUEUE: { sendBatch, send: vi.fn() } }

    await runLsSync(mockEnv, db)

    const links = await db.select().from(billTenants).all()
    const linkMap = new Map(links.map(l => [l.billId, l.matchType]))
    expect(linkMap.get(1)).toBe('keyword')
    expect(linkMap.get(2)).toBe(null)

    expect(sendBatch).toHaveBeenCalledTimes(1)
    const queued = sendBatch.mock.calls[0][0].map((m: any) => m.body.billId)
    expect(queued).toEqual([1])

    const bill1 = await db.select().from(bills).where(eq(bills.billId, 1)).get()
    expect(bill1?.title).toBe('Voter ID Act')
    expect(bill1?.description).toBe('requires identification')
    expect(bill1?.lastAction).toBe('introduced')
  })

  it('preserves matchType=manual across keyword re-evaluation', async () => {
    const db = drizzle(env.DB, { schema })
    const etHour = getCurrentEtHour()

    await db.insert(sessions).values({
      sessionId: 9001,
      state: 'DC',
      stateId: 51,
      yearStart: 2025,
      yearEnd: 2026,
      sessionTitle: 'Test',
      sessionName: 'Test',
      fullSyncHoursEt: JSON.stringify([etHour]),
      rawSyncHoursEt: JSON.stringify([]),
    })

    await db.insert(tenants).values({
      tenantId: 'test-t',
      name: 'Test',
      stateCoverage: JSON.stringify(['DC']),
      active: true,
    })

    await db.insert(keywordRegistry).values({ tenantId: 'test-t', keyword: 'voter' })

    // Pre-existing: bill 3 is manually added for this tenant, even though it doesn't match keywords.
    await db.insert(bills).values({
      billId: 3,
      changeHash: 'old',
      sessionId: 9001,
      state: 'DC',
      stateId: 51,
      billNumber: 'B26-0003',
      title: 'Bridge Naming',
    })
    await db.insert(billTenants).values({
      billId: 3,
      tenantId: 'test-t',
      matchType: 'manual',
    })

    vi.mocked(legiscan.getMasterListBySession).mockResolvedValue([
      {
        bill_id: 3,
        number: 'B26-0003',
        change_hash: 'new',
        title: 'Bridge Naming',
        description: 'rename a bridge',
        status: 1,
        status_date: '2025-01-01',
        last_action: 'introduced',
        last_action_date: '2025-01-01',
        url: 'https://example.com/3',
      },
    ] as any)

    const sendBatch = vi.fn().mockResolvedValue(undefined)
    const mockEnv = { ...(env as any), INGESTOR_QUEUE: { sendBatch, send: vi.fn() } }

    await runLsSync(mockEnv, db)

    const link = await db.select().from(billTenants).where(eq(billTenants.billId, 3)).get()
    expect(link?.matchType).toBe('manual') // unchanged despite keyword non-match
  })

  it('sends stubOnly to tenant queue when bill_tenants exists with match_type=null AND bill changed', async () => {
    const db = drizzle(env.DB, { schema })
    const etHour = getCurrentEtHour()

    // Session in full mode for this hour
    await db.insert(sessions).values({
      sessionId: 9010, state: 'DC', stateId: 51,
      yearStart: 2025, yearEnd: 2026,
      sessionTitle: 'Test', sessionName: 'Test',
      fullSyncHoursEt: JSON.stringify([etHour]),
      rawSyncHoursEt: JSON.stringify([]),
    })

    await db.insert(tenants).values({
      tenantId: 'test-stub', name: 'Test',
      stateCoverage: JSON.stringify(['DC']),
      active: true,
    })

    // Tenant has NO keywords — so no bill will keyword-match
    // Pre-existing bill + bill_tenants link with match_type=null
    await db.insert(bills).values({
      billId: 30, changeHash: 'old-hash', sessionId: 9010, state: 'DC', stateId: 51,
      billNumber: 'B30', title: 'Pre-existing bill',
    })
    await db.insert(billTenants).values({
      billId: 30, tenantId: 'test-stub', matchType: null,
    })

    // Masterlist: bill 30 with a NEW change_hash
    vi.mocked(legiscan.getMasterListBySession).mockResolvedValue([
      { bill_id: 30, number: 'B30', change_hash: 'new-hash',
        title: 'Pre-existing bill — updated',
        description: 'no election keywords here',
        status: 1, status_date: '2026-05-20',
        last_action: 'Committee report', last_action_date: '2026-05-20',
        url: 'https://example.com/30' },
    ] as any)

    const tenantSendBatch = vi.fn().mockResolvedValue(undefined)
    const ingestorSendBatch = vi.fn().mockResolvedValue(undefined)
    const mockEnv = {
      ...(env as any),
      INGESTOR_QUEUE: { sendBatch: ingestorSendBatch, send: vi.fn() },
      TENANT_QUEUE_TEST_STUB: { sendBatch: tenantSendBatch, send: vi.fn() },
    }

    await runLsSync(mockEnv, db)

    // Ingestor should NOT have been called (no matched bill)
    expect(ingestorSendBatch).not.toHaveBeenCalled()

    // Tenant queue should have received exactly one stubOnly message
    expect(tenantSendBatch).toHaveBeenCalledTimes(1)
    const messages = tenantSendBatch.mock.calls[0][0]
    expect(messages).toHaveLength(1)
    expect(messages[0].body).toEqual({
      tenantId: 'test-stub',
      billId: 'legiscan:30',
      stubOnly: true,
    })
  })

  it('delivers stubOnly when a null link is newly created (new non-match bill)', async () => {
    const db = drizzle(env.DB, { schema })
    const etHour = getCurrentEtHour()

    await db.insert(sessions).values({
      sessionId: 9200, state: 'DC', stateId: 51, yearStart: 2025, yearEnd: 2026,
      sessionTitle: 'T', sessionName: 'T',
      fullSyncHoursEt: JSON.stringify([etHour]), rawSyncHoursEt: JSON.stringify([]),
    })
    // Tenant covers DC, has NO keywords → bill cannot keyword-match.
    await db.insert(tenants).values({
      tenantId: 'test-mon', name: 'T', stateCoverage: JSON.stringify(['DC']), active: true,
    })

    vi.mocked(legiscan.getMasterListBySession).mockResolvedValue([
      { bill_id: 50, number: 'B50', change_hash: 'h', title: 'Bridge Naming',
        description: 'rename a bridge', status: 1, status_date: '2025-01-01',
        last_action: 'introduced', last_action_date: '2025-01-01', url: 'https://x/50' },
    ] as any)

    const tenantSendBatch = vi.fn().mockResolvedValue(undefined)
    const mockEnv = {
      ...(env as any),
      INGESTOR_QUEUE: { sendBatch: vi.fn(), send: vi.fn() },
      TENANT_QUEUE_TEST_MON: { sendBatch: tenantSendBatch, send: vi.fn() },
    }

    await runLsSync(mockEnv, db)

    const link = await db.select().from(billTenants).where(eq(billTenants.billId, 50)).get()
    expect(link?.matchType).toBe(null)

    expect(tenantSendBatch).toHaveBeenCalledTimes(1)
    const messages = tenantSendBatch.mock.calls[0][0]
    expect(messages).toHaveLength(1)
    expect(messages[0].body).toEqual({ tenantId: 'test-mon', billId: 'legiscan:50', stubOnly: true })
  })

  it('does not deliver a stub for an existing null link that did not change', async () => {
    const db = drizzle(env.DB, { schema })
    const etHour = getCurrentEtHour()
    await db.insert(sessions).values({
      sessionId: 9201, state: 'DC', stateId: 51, yearStart: 2025, yearEnd: 2026,
      sessionTitle: 'T', sessionName: 'T',
      fullSyncHoursEt: JSON.stringify([etHour]), rawSyncHoursEt: JSON.stringify([]),
    })
    await db.insert(tenants).values({
      tenantId: 'test-mon2', name: 'T', stateCoverage: JSON.stringify(['DC']), active: true,
    })
    await db.insert(bills).values({
      billId: 51, changeHash: 'h', sessionId: 9201, state: 'DC', stateId: 51,
      billNumber: 'B51', title: 'Bridge Naming',
    })
    await db.insert(billTenants).values({ billId: 51, tenantId: 'test-mon2', matchType: null })

    vi.mocked(legiscan.getMasterListBySession).mockResolvedValue([
      { bill_id: 51, number: 'B51', change_hash: 'h', title: 'Bridge Naming',
        description: 'rename', status: 1, status_date: '2025-01-01',
        last_action: 'introduced', last_action_date: '2025-01-01', url: 'https://x/51' },
    ] as any)

    const tenantSendBatch = vi.fn().mockResolvedValue(undefined)
    const mockEnv = {
      ...(env as any),
      INGESTOR_QUEUE: { sendBatch: vi.fn(), send: vi.fn() },
      TENANT_QUEUE_TEST_MON2: { sendBatch: tenantSendBatch, send: vi.fn() },
    }
    await runLsSync(mockEnv, db)
    expect(tenantSendBatch).not.toHaveBeenCalled()
  })

  it('delivers stubs via HTTP for a tenant without a static binding (dynamic queueId)', async () => {
    const db = drizzle(env.DB, { schema })
    const etHour = getCurrentEtHour()
    await db.insert(sessions).values({
      sessionId: 9202, state: 'DC', stateId: 51, yearStart: 2025, yearEnd: 2026,
      sessionTitle: 'T', sessionName: 'T',
      fullSyncHoursEt: JSON.stringify([etHour]), rawSyncHoursEt: JSON.stringify([]),
    })
    // Tenant has a queueId but NO static TENANT_QUEUE_* binding in mockEnv.
    await db.insert(tenants).values({
      tenantId: 'test-dyn', name: 'T', stateCoverage: JSON.stringify(['DC']),
      active: true, queueId: 'q-123',
    })

    vi.mocked(legiscan.getMasterListBySession).mockResolvedValue([
      { bill_id: 52, number: 'B52', change_hash: 'h', title: 'Bridge Naming',
        description: 'rename', status: 1, status_date: '2025-01-01',
        last_action: 'introduced', last_action_date: '2025-01-01', url: 'https://x/52' },
    ] as any)

    const mockEnv = {
      ...(env as any),
      CF_QUEUES_TOKEN: 'tok', CF_ACCOUNT_ID: 'acct',
      INGESTOR_QUEUE: { sendBatch: vi.fn(), send: vi.fn() },
    }
    await runLsSync(mockEnv, db)

    expect(vi.mocked(queuesRest.publishBatch)).toHaveBeenCalledTimes(1)
    const call = vi.mocked(queuesRest.publishBatch).mock.calls[0]
    expect(call[1]).toBe('q-123') // queueId
    expect(call[2]).toEqual([{ tenantId: 'test-dyn', billId: 'legiscan:52', stubOnly: true }])
  })
})

describe('runLsSync → runRawPass', () => {
  it('advances change_hash + queues only matched bills; leaves unmatched stub hash stale', async () => {
    const db = drizzle(env.DB, { schema })
    const etHour = getCurrentEtHour()

    await db.insert(sessions).values({
      sessionId: 9002,
      state: 'DC',
      stateId: 51,
      yearStart: 2025,
      yearEnd: 2026,
      sessionTitle: 'Test',
      sessionName: 'Test',
      fullSyncHoursEt: JSON.stringify([]),
      rawSyncHoursEt: JSON.stringify([etHour]),
    })

    await db.insert(tenants).values({
      tenantId: 'test-t2',
      name: 'Test',
      stateCoverage: JSON.stringify(['DC']),
      active: true,
    })

    // Seed two bills: 10 is matched (keyword), 11 is not (null matchType).
    await db.insert(bills).values([
      {
        billId: 10,
        changeHash: 'old-10',
        sessionId: 9002,
        state: 'DC',
        stateId: 51,
        billNumber: 'B10',
        title: 'Matched bill',
      },
      {
        billId: 11,
        changeHash: 'old-11',
        sessionId: 9002,
        state: 'DC',
        stateId: 51,
        billNumber: 'B11',
        title: 'Unmatched bill',
      },
    ])

    await db.insert(billTenants).values([
      { billId: 10, tenantId: 'test-t2', matchType: 'keyword' },
      { billId: 11, tenantId: 'test-t2', matchType: null },
    ])

    vi.mocked(legiscan.getMasterListRaw).mockResolvedValue([
      { bill_id: 10, number: 'B10', change_hash: 'new-10' },
      { bill_id: 11, number: 'B11', change_hash: 'new-11' },
    ] as any)

    const sendBatch = vi.fn().mockResolvedValue(undefined)
    const mockEnv = { ...(env as any), INGESTOR_QUEUE: { sendBatch, send: vi.fn() } }

    await runLsSync(mockEnv, db)

    expect(sendBatch).toHaveBeenCalledTimes(1)
    const queued = sendBatch.mock.calls[0][0].map((m: any) => m.body.billId)
    expect(queued).toEqual([10])

    const updatedBills = await db.select().from(bills).all()
    const billMap = new Map(updatedBills.map(b => [b.billId, b.changeHash]))
    expect(billMap.get(10)).toBe('new-10') // matched: hash advanced + queued to ingestor
    // Unmatched stub: hash deliberately NOT advanced. The raw masterlist carries no
    // last_action/status, and the raw pass never notifies stub tenants — so if it bumped
    // the hash here, the next full pass (the only pass that refreshes last_action and sends
    // stubOnly) would see no delta and silently swallow the change. Leaving it stale lets
    // the full pass detect and propagate it.
    expect(billMap.get(11)).toBe('old-11')
  })

  it('does not queue new bills (no title to match), but writes a stub row', async () => {
    const db = drizzle(env.DB, { schema })
    const etHour = getCurrentEtHour()

    await db.insert(sessions).values({
      sessionId: 9003,
      state: 'DC',
      stateId: 51,
      yearStart: 2025,
      yearEnd: 2026,
      sessionTitle: 'Test',
      sessionName: 'Test',
      fullSyncHoursEt: JSON.stringify([]),
      rawSyncHoursEt: JSON.stringify([etHour]),
    })

    await db.insert(tenants).values({
      tenantId: 'test-t3',
      name: 'Test',
      stateCoverage: JSON.stringify(['DC']),
      active: true,
    })

    vi.mocked(legiscan.getMasterListRaw).mockResolvedValue([
      { bill_id: 20, number: 'B20', change_hash: 'fresh' },
    ] as any)

    const sendBatch = vi.fn().mockResolvedValue(undefined)
    const mockEnv = { ...(env as any), INGESTOR_QUEUE: { sendBatch, send: vi.fn() } }

    await runLsSync(mockEnv, db)

    // No queue messages — new bill on raw doesn't get queued.
    expect(sendBatch).not.toHaveBeenCalled()

    // But the stub row exists.
    const stub = await db.select().from(bills).where(eq(bills.billId, 20)).get()
    expect(stub).toBeDefined()
    expect(stub?.billNumber).toBe('B20')
    expect(stub?.title).toBe('B20') // title defaults to billNumber for raw stubs
  })
})

describe('runLsSync → raw-then-full handoff for stub bills (swallow regression)', () => {
  // Regression for the "raw pass swallows stub changes" bug: a match_type=null bill
  // changes; a raw pass runs first and (pre-fix) advanced the stored change_hash, which
  // hid the change from the subsequent full pass — the only pass that refreshes last_action
  // and notifies stub tenants. After the fix, the raw pass leaves the stub hash stale so the
  // full pass still detects the change, refreshes central, and sends stubOnly.
  it('raw pass leaves stub hash stale → next full pass refreshes last_action and sends stubOnly', async () => {
    const db = drizzle(env.DB, { schema })
    const etHour = getCurrentEtHour()

    await db.insert(sessions).values({
      sessionId: 9100, state: 'NJ', stateId: 30,
      yearStart: 2026, yearEnd: 2027,
      sessionTitle: 'NJ Test', sessionName: 'NJ Test',
      // Phase 1: raw mode this hour.
      fullSyncHoursEt: JSON.stringify([]),
      rawSyncHoursEt: JSON.stringify([etHour]),
    })

    // Tenant has NO keywords, so bill 40 never keyword-matches — it stays a stub.
    await db.insert(tenants).values({
      tenantId: 'test-swallow', name: 'Test',
      stateCoverage: JSON.stringify(['NJ']),
      active: true,
    })

    // Pre-existing stub bill + null link, with an old action.
    await db.insert(bills).values({
      billId: 40, changeHash: 'old-40', sessionId: 9100, state: 'NJ', stateId: 30,
      billNumber: 'A5048', title: 'Prohibits sale of certain products',
      status: 1, statusDate: '2026-05-11',
      lastAction: 'Introduced, Referred to Assembly Consumer Affairs Committee',
      lastActionDate: '2026-05-11',
    })
    await db.insert(billTenants).values({ billId: 40, tenantId: 'test-swallow', matchType: null })

    const tenantSendBatch = vi.fn().mockResolvedValue(undefined)
    const ingestorSendBatch = vi.fn().mockResolvedValue(undefined)
    const mockEnv = {
      ...(env as any),
      INGESTOR_QUEUE: { sendBatch: ingestorSendBatch, send: vi.fn() },
      TENANT_QUEUE_TEST_SWALLOW: { sendBatch: tenantSendBatch, send: vi.fn() },
    }

    // --- Phase 1: RAW pass sees the new hash ---
    vi.mocked(legiscan.getMasterListRaw).mockResolvedValue([
      { bill_id: 40, number: 'A5048', change_hash: 'new-40' },
    ] as any)

    await runLsSync(mockEnv, db)

    // The fix: stub hash is left stale, nothing queued, no tenant notification.
    const afterRaw = await db.select().from(bills).where(eq(bills.billId, 40)).get()
    expect(afterRaw?.changeHash).toBe('old-40')
    expect(ingestorSendBatch).not.toHaveBeenCalled()
    expect(tenantSendBatch).not.toHaveBeenCalled()

    // --- Phase 2: FULL pass later in the day, carrying the real last_action ---
    await db.update(sessions)
      .set({ fullSyncHoursEt: JSON.stringify([etHour]), rawSyncHoursEt: JSON.stringify([]) })
      .where(eq(sessions.sessionId, 9100))

    vi.mocked(legiscan.getMasterListBySession).mockResolvedValue([
      { bill_id: 40, number: 'A5048', change_hash: 'new-40',
        title: 'Prohibits sale of certain products',
        description: 'no election keywords here',
        status: 7, status_date: '2026-06-04',
        last_action: 'Reported out of Assembly Comm. with Amendments, 2nd Reading',
        last_action_date: '2026-06-04',
        url: 'https://legiscan.com/NJ/bill/A5048/2026' },
    ] as any)

    await runLsSync(mockEnv, db)

    // Central bills row is now refreshed with the latest action and hash.
    const afterFull = await db.select().from(bills).where(eq(bills.billId, 40)).get()
    expect(afterFull?.changeHash).toBe('new-40')
    expect(afterFull?.lastAction).toBe('Reported out of Assembly Comm. with Amendments, 2nd Reading')
    expect(afterFull?.lastActionDate).toBe('2026-06-04')

    // And the stub tenant got a stubOnly notification so it can re-fetch the fresh metadata.
    expect(ingestorSendBatch).not.toHaveBeenCalled()
    expect(tenantSendBatch).toHaveBeenCalledTimes(1)
    const messages = tenantSendBatch.mock.calls[0][0]
    expect(messages).toHaveLength(1)
    expect(messages[0].body).toEqual({
      tenantId: 'test-swallow',
      billId: 'legiscan:40',
      stubOnly: true,
    })
  })
})

describe('runLsSync → wildcard stateCoverage', () => {
  it('syncs all session states when a tenant has stateCoverage ["*"]', async () => {
    const db = drizzle(env.DB, { schema })
    const etHour = getCurrentEtHour()

    // Two sessions in different states, both already in central DB
    await db.insert(sessions).values([
      {
        sessionId: 7001,
        state: 'DC',
        stateId: 51,
        yearStart: 2025,
        yearEnd: 2026,
        sessionTitle: 'DC Test',
        sessionName: 'DC Test',
        fullSyncHoursEt: JSON.stringify([etHour]),
        rawSyncHoursEt: JSON.stringify([]),
      },
      {
        sessionId: 7002,
        state: 'PA',
        stateId: 39,
        yearStart: 2025,
        yearEnd: 2026,
        sessionTitle: 'PA Test',
        sessionName: 'PA Test',
        fullSyncHoursEt: JSON.stringify([etHour]),
        rawSyncHoursEt: JSON.stringify([]),
      },
    ])

    // A single tenant with wildcard coverage — no explicit states listed
    await db.insert(tenants).values({
      tenantId: 'wildcard-t',
      name: 'Wildcard Tenant',
      stateCoverage: JSON.stringify(['*']),
      active: true,
    })

    // getMasterListBySession returns empty list for both sessions
    vi.mocked(legiscan.getMasterListBySession).mockResolvedValue([])

    await runLsSync(env as any, db)

    // Both sessions must have been synced — verified via session_sync_log rows
    const logRows = await db.select().from(schema.sessionSyncLog).all()
    const syncedSessionIds = logRows.map(r => r.sessionId)
    expect(syncedSessionIds).toContain(7001)
    expect(syncedSessionIds).toContain(7002)
  })

  it('does not sync sessions when no sessions exist in DB even with wildcard tenant', async () => {
    const db = drizzle(env.DB, { schema })

    // No sessions in DB at all
    await db.insert(tenants).values({
      tenantId: 'wildcard-t2',
      name: 'Wildcard Tenant 2',
      stateCoverage: JSON.stringify(['*']),
      active: true,
    })

    vi.mocked(legiscan.getMasterListBySession).mockResolvedValue([])
    vi.mocked(legiscan.getMasterListRaw).mockResolvedValue([])

    await runLsSync(env as any, db)

    // No sync log entries — nothing to sync
    const logRows = await db.select().from(schema.sessionSyncLog).all()
    expect(logRows).toHaveLength(0)
  })
})
