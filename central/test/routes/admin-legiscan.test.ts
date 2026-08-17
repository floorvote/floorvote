import { env, applyD1Migrations, reset } from 'cloudflare:test'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from '../../src/db/schema-legiscan'
import { app } from '../../src/index-legiscan'

// backfill-stub-actions re-pulls getMasterListBySession; mock it. (reingest-tenant tests below
// don't touch the legiscan lib, so this mock is inert for them.)
vi.mock('../../src/lib/legiscan', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/legiscan')>('../../src/lib/legiscan')
  return { ...actual, getMasterListBySession: vi.fn() }
})
import * as legiscan from '../../src/lib/legiscan'
import migration0001 from '../../migrations-legiscan/0001_initial.sql?raw'
import migration0002 from '../../migrations-legiscan/0002_api_call_log_v2.sql?raw'
import migration0003 from '../../migrations-legiscan/0003_session_sync_log.sql?raw'
import migration0004 from '../../migrations-legiscan/0004_match_tracking.sql?raw'
import migration0005 from '../../migrations-legiscan/0005_bill_amendments_and_change_log.sql?raw'
import migration0006 from '../../migrations-legiscan/0006_texts_fetched_at.sql?raw'
import migration0013 from '../../migrations-legiscan/0013_tenants_queue_id.sql?raw'
import migration0017 from '../../migrations-legiscan/0017_tenant_ai_personalized.sql?raw'

function parseMigration(sql: string, name: string) {
  const queries = sql
    .split(';')
    .map(s => s.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n').trim())
    .filter(s => s.length > 0)
    .map(s => s + ';')
  return { name, queries }
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
})

async function seedTenantWithBills(opts: {
  tenantId: string
  keywordBillIds?: number[]
  manualBillIds?: number[]
  nullBillIds?: number[]
}) {
  const db = drizzle(env.DB, { schema })
  await db.insert(schema.tenants).values({
    tenantId: opts.tenantId,
    name: opts.tenantId,
    active: true,
    stateCoverage: '["RI"]',
  })
  await db.insert(schema.sessions).values({
    sessionId: 1, state: 'RI', stateId: 0,
    yearStart: 2026, yearEnd: 2026,
    sessionName: '2026', sessionTitle: '2026', sessionTag: '',
    prefile: 0, sineDie: 0, prior: 0, special: 0,
  })

  const all = [
    ...(opts.keywordBillIds ?? []).map(id => ({ id, mt: 'keyword' as const })),
    ...(opts.manualBillIds ?? []).map(id => ({ id, mt: 'manual' as const })),
    ...(opts.nullBillIds ?? []).map(id => ({ id, mt: null })),
  ]
  for (const { id, mt } of all) {
    await db.insert(schema.bills).values({
      billId: id, sessionId: 1, state: 'RI', stateId: 0,
      billNumber: `H${id}`, title: `Bill ${id}`,
      changeHash: 'hash', status: 1,
    })
    await db.insert(schema.billTenants).values({
      billId: id, tenantId: opts.tenantId, matchType: mt,
    })
  }
}

function envWithMockedQueue() {
  const sendBatch = vi.fn().mockResolvedValue(undefined)
  const send = vi.fn().mockResolvedValue(undefined)
  return {
    env: { ...(env as any), INGESTOR_QUEUE: { sendBatch, send } },
    sendBatch,
    send,
  }
}

describe('POST /admin/reingest-tenant/:tenantId', () => {
  it('returns 401 without admin secret', async () => {
    const res = await app.request(
      '/api/admin/reingest-tenant/test-tenant',
      { method: 'POST' },
      env,
    )
    expect(res.status).toBe(401)
  })

  it('returns 404 for unknown tenant', async () => {
    const res = await app.request(
      '/api/admin/reingest-tenant/does-not-exist',
      { method: 'POST', headers: { 'x-admin-secret': 'test-secret' } },
      env,
    )
    expect(res.status).toBe(404)
  })

  it('defaults to dry run: returns count, does NOT queue', async () => {
    await seedTenantWithBills({
      tenantId: 'test-tenant',
      keywordBillIds: [1, 2, 3],
      manualBillIds: [4],
      nullBillIds: [5, 6],
    })
    const { env: mockEnv, sendBatch } = envWithMockedQueue()

    const res = await app.request(
      '/api/admin/reingest-tenant/test-tenant',
      { method: 'POST', headers: { 'x-admin-secret': 'test-secret' } },
      mockEnv,
    )

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body).toMatchObject({
      tenantId: 'test-tenant',
      matched: 4,           // 3 keyword + 1 manual, NOT the 2 null
      wouldQueue: 4,
      dryRun: true,
    })
    expect(body.note).toContain('confirm=true')
    expect(sendBatch).not.toHaveBeenCalled()
  })

  it('with confirm=true: actually queues matched bills', async () => {
    await seedTenantWithBills({
      tenantId: 'test-tenant',
      keywordBillIds: [10, 20],
      manualBillIds: [30],
      nullBillIds: [40],  // should be excluded
    })
    const { env: mockEnv, sendBatch } = envWithMockedQueue()

    const res = await app.request(
      '/api/admin/reingest-tenant/test-tenant?confirm=true',
      { method: 'POST', headers: { 'x-admin-secret': 'test-secret' } },
      mockEnv,
    )

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body).toMatchObject({
      tenantId: 'test-tenant',
      matched: 3,
      queued: 3,
      dryRun: false,
    })

    expect(sendBatch).toHaveBeenCalledTimes(1)
    const messages = sendBatch.mock.calls[0][0]
    expect(messages).toHaveLength(3)
    for (const m of messages) {
      expect(m.body.forceAI).toBeUndefined()  // never re-run AI
    }
    const queuedIds = messages.map((m: any) => m.body.billId).sort((a: number, b: number) => a - b)
    expect(queuedIds).toEqual([10, 20, 30])
  })

  it('with confirm=true on a tenant with no matched bills: queues nothing, returns 0', async () => {
    await seedTenantWithBills({
      tenantId: 'test-tenant',
      nullBillIds: [1, 2, 3],
    })
    const { env: mockEnv, sendBatch } = envWithMockedQueue()

    const res = await app.request(
      '/api/admin/reingest-tenant/test-tenant?confirm=true',
      { method: 'POST', headers: { 'x-admin-secret': 'test-secret' } },
      mockEnv,
    )

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body).toMatchObject({ matched: 0, queued: 0, dryRun: false })
    expect(sendBatch).not.toHaveBeenCalled()
  })

  it('batches sends in chunks of 100', async () => {
    // Cloudflare queue sendBatch max is 100; the endpoint must chunk.
    const ids = Array.from({ length: 250 }, (_, i) => i + 1)
    await seedTenantWithBills({ tenantId: 'big-tenant', keywordBillIds: ids })
    const { env: mockEnv, sendBatch } = envWithMockedQueue()

    const res = await app.request(
      '/api/admin/reingest-tenant/big-tenant?confirm=true',
      { method: 'POST', headers: { 'x-admin-secret': 'test-secret' } },
      mockEnv,
    )

    expect(res.status).toBe(200)
    expect(sendBatch).toHaveBeenCalledTimes(3) // 100 + 100 + 50
    const batchSizes = sendBatch.mock.calls.map(c => c[0].length).sort((a, b) => b - a)
    expect(batchSizes).toEqual([100, 100, 50])
  })

  it('only includes bills for the requested tenant, not bills from other tenants', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.tenants).values([
      { tenantId: 't1', name: 't1', active: true, stateCoverage: '["RI"]' },
      { tenantId: 't2', name: 't2', active: true, stateCoverage: '["RI"]' },
    ])
    await db.insert(schema.sessions).values({
      sessionId: 1, state: 'RI', stateId: 0,
      yearStart: 2026, yearEnd: 2026,
      sessionName: '2026', sessionTitle: '2026', sessionTag: '',
      prefile: 0, sineDie: 0, prior: 0, special: 0,
    })
    for (const id of [100, 200, 300]) {
      await db.insert(schema.bills).values({
        billId: id, sessionId: 1, state: 'RI', stateId: 0,
        billNumber: `H${id}`, title: `Bill ${id}`, changeHash: 'h', status: 1,
      })
    }
    // t1 tracks 100 and 200; t2 tracks 300
    await db.insert(schema.billTenants).values([
      { billId: 100, tenantId: 't1', matchType: 'keyword' },
      { billId: 200, tenantId: 't1', matchType: 'manual' },
      { billId: 300, tenantId: 't2', matchType: 'keyword' },
    ])
    const { env: mockEnv, sendBatch } = envWithMockedQueue()

    const res = await app.request(
      '/api/admin/reingest-tenant/t1?confirm=true',
      { method: 'POST', headers: { 'x-admin-secret': 'test-secret' } },
      mockEnv,
    )

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.matched).toBe(2)
    const queuedIds = sendBatch.mock.calls[0][0].map((m: any) => m.body.billId).sort()
    expect(queuedIds).toEqual([100, 200])
  })
})

describe('POST /admin/backfill-stub-actions/:tenantId', () => {
  it('returns 401 without admin secret', async () => {
    const res = await app.request('/api/admin/backfill-stub-actions/bf', { method: 'POST' }, env)
    expect(res.status).toBe(401)
  })

  it('refreshes central + notifies only stale stubs; leaves matched bills and current stubs alone', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.tenants).values({
      tenantId: 'bf', name: 'bf', active: true, stateCoverage: '["RI"]',
    })
    await db.insert(schema.sessions).values({
      sessionId: 1, state: 'RI', stateId: 0,
      yearStart: 2026, yearEnd: 2026,
      sessionName: '2026', sessionTitle: '2026', sessionTag: '',
      prefile: 0, sineDie: 0, prior: 0, special: 0,
    })

    // 500: stale stub — masterlist hash already matches (the swallow), but last_action is newer.
    // 501: matched (keyword) — must be ignored by the backfill.
    // 502: stub whose action already matches the masterlist — must be ignored (not stale).
    await db.insert(schema.bills).values([
      { billId: 500, sessionId: 1, state: 'RI', stateId: 0, billNumber: 'H500', title: 'Bill 500',
        changeHash: 'same-hash', status: 1, statusDate: '2026-01-01',
        lastAction: 'Introduced', lastActionDate: '2026-01-01' },
      { billId: 501, sessionId: 1, state: 'RI', stateId: 0, billNumber: 'H501', title: 'Bill 501',
        changeHash: 'h501', status: 1, statusDate: '2026-01-01',
        lastAction: 'Introduced', lastActionDate: '2026-01-01' },
      { billId: 502, sessionId: 1, state: 'RI', stateId: 0, billNumber: 'H502', title: 'Bill 502',
        changeHash: 'h502', status: 1, statusDate: '2026-02-02',
        lastAction: 'Already current', lastActionDate: '2026-02-02' },
    ])
    await db.insert(schema.billTenants).values([
      { billId: 500, tenantId: 'bf', matchType: null },
      { billId: 501, tenantId: 'bf', matchType: 'keyword' },
      { billId: 502, tenantId: 'bf', matchType: null },
    ])

    vi.mocked(legiscan.getMasterListBySession).mockResolvedValue([
      { bill_id: 500, number: 'H500', change_hash: 'same-hash', title: 'Bill 500',
        description: null, status: 7, status_date: '2026-06-04',
        last_action: 'Reported out of committee', last_action_date: '2026-06-04',
        url: 'https://legiscan.com/RI/bill/H500' },
      { bill_id: 501, number: 'H501', change_hash: 'h501-new', title: 'Bill 501',
        description: null, status: 7, status_date: '2026-06-04',
        last_action: 'Matched bill moved', last_action_date: '2026-06-04', url: null },
      { bill_id: 502, number: 'H502', change_hash: 'h502', title: 'Bill 502',
        description: null, status: 1, status_date: '2026-02-02',
        last_action: 'Already current', last_action_date: '2026-02-02', url: null },
    ] as any)

    const tenantSendBatch = vi.fn().mockResolvedValue(undefined)
    const mockEnv = {
      ...(env as any),
      TENANT_QUEUE_BF: { sendBatch: tenantSendBatch, send: vi.fn() },
    }

    const res = await app.request(
      '/api/admin/backfill-stub-actions/bf',
      { method: 'POST', headers: { 'x-admin-secret': 'test-secret' } },
      mockEnv,
    )

    expect(res.status).toBe(200)
    const body = await res.json() as any
    // refreshed=1 (only 500 was stale); notified=2 (both stubs 500 and 502 notified,
    // regardless of staleness — decoupled refresh/notify fixes the second-tenant problem).
    expect(body).toMatchObject({ tenantId: 'bf', sessionsChecked: 1, refreshed: 1, notified: 2 })

    // Stale stub 500 was refreshed in central.
    const b500 = await db.select().from(schema.bills).where(eq(schema.bills.billId, 500)).get()
    expect(b500?.lastAction).toBe('Reported out of committee')
    expect(b500?.lastActionDate).toBe('2026-06-04')
    expect(b500?.status).toBe(7)

    // Matched bill 501 and current stub 502 were left untouched in central.
    const b501 = await db.select().from(schema.bills).where(eq(schema.bills.billId, 501)).get()
    expect(b501?.lastAction).toBe('Introduced')
    const b502 = await db.select().from(schema.bills).where(eq(schema.bills.billId, 502)).get()
    expect(b502?.lastAction).toBe('Already current')

    // Both stubs (500 and 502) receive stubOnly notifications; matched bill 501 does not.
    expect(tenantSendBatch).toHaveBeenCalledTimes(1)
    const messages = tenantSendBatch.mock.calls[0][0]
    expect(messages).toHaveLength(2)
    const sentIds = messages.map((m: any) => m.body.billId).sort()
    expect(sentIds).toEqual(['legiscan:500', 'legiscan:502'])
    for (const m of messages) {
      expect(m.body.stubOnly).toBe(true)
      expect(m.body.tenantId).toBe('bf')
    }
  })

  it('rejects wildcard tenants without an explicit sessionId', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.tenants).values({
      tenantId: 'wild', name: 'wild', active: true, stateCoverage: '["*"]',
    })
    const mockEnv = { ...(env as any), TENANT_QUEUE_WILD: { sendBatch: vi.fn(), send: vi.fn() } }

    const res = await app.request(
      '/api/admin/backfill-stub-actions/wild',
      { method: 'POST', headers: { 'x-admin-secret': 'test-secret' } },
      mockEnv,
    )
    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.error).toContain('sessionId')
  })

  it('returns typed 500 when getMasterListBySession throws', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.tenants).values({
      tenantId: 'bf-err', name: 'bf-err', active: true, stateCoverage: '["RI"]',
    })
    await db.insert(schema.sessions).values({
      sessionId: 10, state: 'RI', stateId: 0,
      yearStart: 2026, yearEnd: 2026,
      sessionName: '2026', sessionTitle: '2026', sessionTag: '',
      prefile: 0, sineDie: 0, prior: 0, special: 0,
    })
    vi.mocked(legiscan.getMasterListBySession).mockRejectedValue(new Error('LegiScan timeout'))
    const mockEnv = { ...(env as any), TENANT_QUEUE_BF_ERR: { sendBatch: vi.fn(), send: vi.fn() } }

    const res = await app.request(
      '/api/admin/backfill-stub-actions/bf-err?sessionId=10',
      { method: 'POST', headers: { 'x-admin-secret': 'test-secret' } },
      mockEnv,
    )

    expect(res.status).toBe(500)
    const body = await res.json() as any
    expect(body).toMatchObject({ ok: false, error: 'masterlist_fetch_failed', sessionId: 10 })
  })

  it('returns typed 429 with Retry-After header when queue.sendBatch throws', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.tenants).values({
      tenantId: 'bf-q', name: 'bf-q', active: true, stateCoverage: '["RI"]',
    })
    await db.insert(schema.sessions).values({
      sessionId: 20, state: 'RI', stateId: 0,
      yearStart: 2026, yearEnd: 2026,
      sessionName: '2026', sessionTitle: '2026', sessionTag: '',
      prefile: 0, sineDie: 0, prior: 0, special: 0,
    })
    await db.insert(schema.bills).values({
      billId: 600, sessionId: 20, state: 'RI', stateId: 0,
      billNumber: 'H600', title: 'Bill 600', changeHash: 'h600', status: 1,
      lastAction: 'Introduced', lastActionDate: '2026-01-01',
    })
    await db.insert(schema.billTenants).values({
      billId: 600, tenantId: 'bf-q', matchType: null,
    })

    vi.mocked(legiscan.getMasterListBySession).mockResolvedValue([
      { bill_id: 600, number: 'H600', change_hash: 'h600-new', title: 'Bill 600',
        description: null, status: 2, status_date: '2026-06-01',
        last_action: 'Passed committee', last_action_date: '2026-06-01', url: null },
    ] as any)

    // Queue throws on sendBatch — simulates backpressure / throttling.
    const tenantSendBatch = vi.fn().mockRejectedValue(new Error('Queue capacity exceeded'))
    const mockEnv = { ...(env as any), TENANT_QUEUE_BF_Q: { sendBatch: tenantSendBatch, send: vi.fn() } }

    const res = await app.request(
      '/api/admin/backfill-stub-actions/bf-q?sessionId=20',
      { method: 'POST', headers: { 'x-admin-secret': 'test-secret' } },
      mockEnv,
    )

    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('30')
    const body = await res.json() as any
    expect(body).toMatchObject({ ok: false, error: 'queue_backpressure', refreshed: 1 })
  })

  it('notifies tenant for all in-scope stubs even when central is already fresh (second-tenant scenario)', async () => {
    // Simulates: first tenant ran backfill-stub-actions and freshened central.
    // Now second tenant runs the same route. central is already up-to-date, so
    // refreshed=0 — but the tenant must still receive stubOnly notifications for
    // its own stubs so its local bill rows get updated from central.
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.tenants).values({
      tenantId: 'tenant2', name: 'tenant2', active: true, stateCoverage: '["RI"]',
    })
    await db.insert(schema.sessions).values({
      sessionId: 30, state: 'RI', stateId: 0,
      yearStart: 2026, yearEnd: 2026,
      sessionName: '2026', sessionTitle: '2026', sessionTag: '',
      prefile: 0, sineDie: 0, prior: 0, special: 0,
    })
    // Bills are ALREADY fresh in central (first tenant already updated them).
    await db.insert(schema.bills).values([
      { billId: 700, sessionId: 30, state: 'RI', stateId: 0, billNumber: 'H700', title: 'Bill 700',
        changeHash: 'new-hash', status: 3, lastAction: 'Passed committee', lastActionDate: '2026-06-01' },
      { billId: 701, sessionId: 30, state: 'RI', stateId: 0, billNumber: 'H701', title: 'Bill 701',
        changeHash: 'new-hash-2', status: 4, lastAction: 'Senate referred', lastActionDate: '2026-06-05' },
    ])
    await db.insert(schema.billTenants).values([
      { billId: 700, tenantId: 'tenant2', matchType: null },
      { billId: 701, tenantId: 'tenant2', matchType: null },
    ])

    // Masterlist exactly matches central — no stale bills at all.
    vi.mocked(legiscan.getMasterListBySession).mockResolvedValue([
      { bill_id: 700, number: 'H700', change_hash: 'new-hash', title: 'Bill 700',
        description: null, status: 3, status_date: '2026-06-01',
        last_action: 'Passed committee', last_action_date: '2026-06-01', url: null },
      { bill_id: 701, number: 'H701', change_hash: 'new-hash-2', title: 'Bill 701',
        description: null, status: 4, status_date: '2026-06-05',
        last_action: 'Senate referred', last_action_date: '2026-06-05', url: null },
    ] as any)

    const tenantSendBatch = vi.fn().mockResolvedValue(undefined)
    const mockEnv = { ...(env as any), TENANT_QUEUE_TENANT2: { sendBatch: tenantSendBatch, send: vi.fn() } }

    const res = await app.request(
      '/api/admin/backfill-stub-actions/tenant2?sessionId=30',
      { method: 'POST', headers: { 'x-admin-secret': 'test-secret' } },
      mockEnv,
    )

    expect(res.status).toBe(200)
    const body = await res.json() as any
    // Nothing was stale in central — refreshed stays 0.
    expect(body).toMatchObject({ ok: true, tenantId: 'tenant2', refreshed: 0, notified: 2 })

    // But the tenant still received stubOnly notifications for both its stubs.
    expect(tenantSendBatch).toHaveBeenCalledTimes(1)
    const messages = tenantSendBatch.mock.calls[0][0]
    expect(messages).toHaveLength(2)
    const sentIds = messages.map((m: any) => m.body.billId).sort()
    expect(sentIds).toEqual(['legiscan:700', 'legiscan:701'])
    for (const m of messages) {
      expect(m.body.stubOnly).toBe(true)
      expect(m.body.tenantId).toBe('tenant2')
    }
  })
})
