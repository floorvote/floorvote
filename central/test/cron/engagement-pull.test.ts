import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from '../../src/db/schema-legiscan'
import { setupLsDb } from '../helpers/setupLsDb'
import { pullEngagementStats, pullEngagementStatsForTenant, shouldRunEngagementPull } from '../../src/cron/engagement-pull'
import { sendOpsAlert } from '../../src/lib/jobAlert'

vi.mock('../../src/lib/jobAlert', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/jobAlert')>()),
  sendOpsAlert: vi.fn(async () => {}),
}))
const mockSendOpsAlert = vi.mocked(sendOpsAlert)

const TEST_ENV: any = { ...env, ADMIN_SECRET: 'sek' }

beforeEach(async () => {
  await setupLsDb()
  vi.restoreAllMocks()
  mockSendOpsAlert.mockClear()
  mockSendOpsAlert.mockImplementation(async () => {})
})
afterEach(() => vi.unstubAllGlobals())

function fakeResponse(metrics: Record<string, number>) {
  return new Response(JSON.stringify({
    data: { computedAt: '2026-05-29T06:00:00Z', metrics },
    meta: { generatedAt: '2026-05-29T06:00:00Z' },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

async function seedTwoTenants() {
  const db = drizzle(env.DB, { schema })
  await db.insert(schema.tenants).values([
    { tenantId: 'ri', name: 'Rhode Island', apiUrl: 'https://ri.example/api', stateCoverage: '["RI"]', active: true } as any,
    { tenantId: 'acme', name: 'Acme', apiUrl: 'https://acme.example/api', stateCoverage: '["RI"]', active: true } as any,
  ])
}

const FULL_METRICS = {
  total_members: 12, active_members_7d: 4, active_members_30d: 8, votes_cast: 42,
  comments_written: 18, comment_reactions: 31, positions_set: 7, notes_created: 3,
  custom_field_values: 87, bills_with_engagement: 12, roles_defined: 2,
  custom_fields_defined: 2, bills_ai_processed: 156,
}

describe('pullEngagementStats', () => {
  it('writes one row per tenant on success', async () => {
    await seedTwoTenants()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => fakeResponse(FULL_METRICS))
    const db = drizzle(env.DB, { schema })
    await pullEngagementStats(TEST_ENV, db)
    const rows = await db.select().from(schema.tenantStats).all()
    expect(rows.length).toBe(2)
    expect(rows[0].totalMembers).toBe(12)
    expect(rows[0].billsAiProcessed).toBe(156)
  })

  it('skips tenants that fail and continues with others', async () => {
    await seedTwoTenants()
    let call = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      call++
      if (call === 1) return new Response('boom', { status: 500 })
      return fakeResponse(FULL_METRICS)
    })
    const db = drizzle(env.DB, { schema })
    await expect(pullEngagementStats(TEST_ENV, db)).resolves.not.toThrow()
    const rows = await db.select().from(schema.tenantStats).all()
    // The failed tenant has no prior row today, so no row is synthesized — a
    // gap is left rather than a false zero-metrics data point. Only the
    // succeeded tenant has a row.
    expect(rows.length).toBe(1)
    expect(rows[0].totalMembers).toBe(12)
    expect(rows[0].probeOk).toBe(1)
    // The failure still fires the summary alert.
    expect(mockSendOpsAlert).toHaveBeenCalledTimes(1)
    expect(mockSendOpsAlert.mock.calls[0][1].text).toMatch(/FAILED/i)
  })

  it('upsert is idempotent — re-running same day overwrites', async () => {
    await seedTwoTenants()
    const db = drizzle(env.DB, { schema })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => fakeResponse(FULL_METRICS))
    await pullEngagementStats(TEST_ENV, db)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => fakeResponse({ ...FULL_METRICS, total_members: 99 }))
    await pullEngagementStats(TEST_ENV, db)
    const rows = await db.select().from(schema.tenantStats).all()
    expect(rows.length).toBe(2)
    expect(rows.every(r => r.totalMembers === 99)).toBe(true)
  })

  it('treats missing metric keys as 0', async () => {
    await seedTwoTenants()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => fakeResponse({ total_members: 5 } as any))
    const db = drizzle(env.DB, { schema })
    await pullEngagementStats(TEST_ENV, db)
    const row = await db.select().from(schema.tenantStats).where(eq(schema.tenantStats.tenantId, 'ri')).get()
    expect(row?.totalMembers).toBe(5)
    expect(row?.votesCast).toBe(0)
    expect(row?.billsAiProcessed).toBe(0)
  })

  it('sends x-admin-secret on the request', async () => {
    await seedTwoTenants()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => fakeResponse(FULL_METRICS))
    const db = drizzle(env.DB, { schema })
    await pullEngagementStats(TEST_ENV, db)
    const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers['x-admin-secret']).toBe('sek')
  })
})

describe('pullEngagementStatsForTenant', () => {
  it('returns the upserted row for a single tenant', async () => {
    await seedTwoTenants()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => fakeResponse(FULL_METRICS))
    const db = drizzle(env.DB, { schema })
    const row = await pullEngagementStatsForTenant(TEST_ENV, db, 'ri')
    expect(row.tenantId).toBe('ri')
    expect(row.totalMembers).toBe(12)
  })

  it('throws on tenant fetch failure (so caller can return 502)', async () => {
    await seedTwoTenants()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }))
    const db = drizzle(env.DB, { schema })
    await expect(pullEngagementStatsForTenant(TEST_ENV, db, 'ri')).rejects.toThrow()
  })

  it('throws if tenant id unknown', async () => {
    const db = drizzle(env.DB, { schema })
    await expect(pullEngagementStatsForTenant(TEST_ENV, db, 'nope')).rejects.toThrow(/not found/i)
  })

  it('returns today\'s row even when an older row exists for the same tenant', async () => {
    await seedTwoTenants()
    const db = drizzle(env.DB, { schema })
    // Seed an old row with a stale totalMembers value
    await db.insert(schema.tenantStats).values({
      tenantId: 'ri',
      statDate: '2026-01-01',
      totalMembers: 999,
      activeMembers7d: 0, activeMembers30d: 0, votesCast: 0,
      commentsWritten: 0, commentReactions: 0, positionsSet: 0,
      notesCreated: 0, customFieldValues: 0, billsWithEngagement: 0,
      rolesDefined: 0, customFieldsDefined: 0, billsAiProcessed: 0,
      pulledAt: '2026-01-01T06:00:00Z',
    } as any)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => fakeResponse({ ...FULL_METRICS, total_members: 42 }))
    const row = await pullEngagementStatsForTenant(TEST_ENV, db, 'ri')
    expect(row.totalMembers).toBe(42)
  })
})

describe('lastSeenAt update on successful pull', () => {
  it('updates lastSeenAt on every successful pullEngagementStats call', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.tenants).values([
      { tenantId: 'ri', name: 'RI', stateCoverage: '["RI"]', active: true, apiUrl: 'http://ri', lastSeenAt: null } as any,
    ])
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => fakeResponse(FULL_METRICS))
    const before = new Date(Date.now() - 1000).toISOString().slice(0, 19).replace('T', ' ')
    await pullEngagementStats(TEST_ENV, db)
    const tenant = await db.select().from(schema.tenants).where(eq(schema.tenants.tenantId, 'ri')).get()
    expect(tenant?.lastSeenAt).toBeTruthy()
    expect(tenant!.lastSeenAt! >= before).toBe(true)
  })

  it('does not update lastSeenAt when pullEngagementStats fetch fails', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.tenants).values([
      { tenantId: 'ri', name: 'RI', stateCoverage: '["RI"]', active: true, apiUrl: 'http://ri', lastSeenAt: null } as any,
    ])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }))
    await pullEngagementStats(TEST_ENV, db)
    const tenant = await db.select().from(schema.tenants).where(eq(schema.tenants.tenantId, 'ri')).get()
    expect(tenant?.lastSeenAt).toBeNull()
  })

  it('updates lastSeenAt on successful pullEngagementStatsForTenant call', async () => {
    await seedTwoTenants()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => fakeResponse(FULL_METRICS))
    const db = drizzle(env.DB, { schema })
    const before = new Date(Date.now() - 1000).toISOString().slice(0, 19).replace('T', ' ')
    await pullEngagementStatsForTenant(TEST_ENV, db, 'ri')
    const tenant = await db.select().from(schema.tenants).where(eq(schema.tenants.tenantId, 'ri')).get()
    expect(tenant?.lastSeenAt).toBeTruthy()
    expect(tenant!.lastSeenAt! >= before).toBe(true)
    // Other tenant should not be touched
    const other = await db.select().from(schema.tenants).where(eq(schema.tenants.tenantId, 'acme')).get()
    expect(other?.lastSeenAt).toBeNull()
  })
})

describe('stored timestamps are space-format', () => {
  const SPACE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
  it('writes space-format pulled_at and last_seen_at', async () => {
    await seedTwoTenants()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => fakeResponse(FULL_METRICS))
    const db = drizzle(env.DB, { schema })
    await pullEngagementStats(TEST_ENV, db)
    const stat = await db.select().from(schema.tenantStats).where(eq(schema.tenantStats.tenantId, 'ri')).get()
    expect(stat!.pulledAt).toMatch(SPACE)
    const tenant = await db.select().from(schema.tenants).where(eq(schema.tenants.tenantId, 'ri')).get()
    expect(tenant!.lastSeenAt!).toMatch(SPACE)
  })
})

describe('RPC path vs HTTP fallback', () => {
  it('uses the RPC binding when available and does NOT call fetch', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.tenants).values([
      { tenantId: 'rpc-tenant', name: 'X', apiUrl: 'https://x.example', stateCoverage: '["RI"]', active: true } as any,
    ])
    const rpcEnv: any = {
      ...env,
      ADMIN_SECRET: 'sek',
      TENANT_RPC_TENANT: {
        engagementStats: async () => ({
          computedAt: '2026-06-13T00:00:00Z',
          metrics: { total_members: 7 },
          resend: null,
        }),
      },
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const row = await pullEngagementStatsForTenant(rpcEnv, db, 'rpc-tenant')
    expect(row.totalMembers).toBe(7)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('falls back to HTTP when no binding is present', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.tenants).values([
      { tenantId: 'http-tenant', name: 'Y', apiUrl: 'https://y.example', stateCoverage: '["RI"]', active: true } as any,
    ])
    const httpEnv: any = { ...env, ADMIN_SECRET: 'sek' }
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({
        data: { computedAt: '2026-06-13T00:00:00Z', metrics: { total_members: 3 }, resend: null },
        meta: {},
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ))
    const row = await pullEngagementStatsForTenant(httpEnv, db, 'http-tenant')
    expect(row.totalMembers).toBe(3)
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0)
  })
})

describe('latency probe + DB-health alert', () => {
  function delayedFetch(ms: number, ok = true) {
    return vi.fn(async () => {
      await new Promise((r) => setTimeout(r, ms))
      if (!ok) return new Response('boom', { status: 500 })
      return fakeResponse(FULL_METRICS)
    })
  }

  it('records probe_latency_ms and probe_ok=1 on a fast call, no alert', async () => {
    await seedTwoTenants()
    vi.stubGlobal('fetch', delayedFetch(0, true))
    const db = drizzle(env.DB, { schema })
    // High threshold: nothing should be flagged slow.
    await pullEngagementStats({ ...TEST_ENV, D_LATENCY_THRESHOLD_MS: '5000' }, db)
    const row = await db.select().from(schema.tenantStats).where(eq(schema.tenantStats.tenantId, 'ri')).get()
    expect(row?.probeOk).toBe(1)
    expect(row?.probeLatencyMs).not.toBeNull()
    expect(row!.probeLatencyMs!).toBeGreaterThanOrEqual(0)
    expect(mockSendOpsAlert).not.toHaveBeenCalled()
  })

  it('flags a slow tenant (latency > threshold) and sends ONE alert', async () => {
    await seedTwoTenants()
    vi.stubGlobal('fetch', delayedFetch(40, true))
    const db = drizzle(env.DB, { schema })
    // Tiny threshold so the ~40ms call counts as slow.
    await pullEngagementStats({ ...TEST_ENV, D_LATENCY_THRESHOLD_MS: '1' }, db)
    const row = await db.select().from(schema.tenantStats).where(eq(schema.tenantStats.tenantId, 'ri')).get()
    expect(row?.probeOk).toBe(1)
    expect(row!.probeLatencyMs!).toBeGreaterThan(1)
    // Both tenants are slow but only one summary alert is sent.
    expect(mockSendOpsAlert).toHaveBeenCalledTimes(1)
    const arg = mockSendOpsAlert.mock.calls[0][1]
    expect(arg.subject).toMatch(/slow or failing/i)
    expect(arg.text).toContain('ri')
  })

  it('failed pull with no prior row today writes nothing but still alerts', async () => {
    await seedTwoTenants()
    vi.stubGlobal('fetch', delayedFetch(0, false))
    const db = drizzle(env.DB, { schema })
    await pullEngagementStats({ ...TEST_ENV, D_LATENCY_THRESHOLD_MS: '5000' }, db)
    // No row exists for today → none is synthesized (no false zero-metrics point).
    const row = await db.select().from(schema.tenantStats).where(eq(schema.tenantStats.tenantId, 'ri')).get()
    expect(row).toBeUndefined()
    // The failure still surfaces via the summary alert.
    expect(mockSendOpsAlert).toHaveBeenCalledTimes(1)
    const arg = mockSendOpsAlert.mock.calls[0][1]
    expect(arg.subject).toMatch(/slow or failing/i)
    expect(arg.text).toMatch(/FAILED/i)
  })

  it('failed pull with a same-day row updates the probe but preserves metrics', async () => {
    await seedTwoTenants()
    const db = drizzle(env.DB, { schema })
    const date = new Date().toISOString().slice(0, 10)
    // A successful pull earlier today wrote a full-metrics row.
    vi.stubGlobal('fetch', delayedFetch(0, true))
    await pullEngagementStats({ ...TEST_ENV, D_LATENCY_THRESHOLD_MS: '5000' }, db)
    const before = await db.select().from(schema.tenantStats)
      .where(eq(schema.tenantStats.tenantId, 'ri')).get()
    expect(before?.totalMembers).toBe(12)
    expect(before?.probeOk).toBe(1)
    expect(before?.statDate).toBe(date)
    mockSendOpsAlert.mockClear()

    // A later pull the same day fails. The existing row's probe flips to ok=0
    // and latency updates, but the engagement metrics are preserved (not zeroed).
    vi.stubGlobal('fetch', delayedFetch(0, false))
    await pullEngagementStats({ ...TEST_ENV, D_LATENCY_THRESHOLD_MS: '5000' }, db)
    const after = await db.select().from(schema.tenantStats)
      .where(eq(schema.tenantStats.tenantId, 'ri')).get()
    expect(after?.probeOk).toBe(0)
    expect(after?.totalMembers).toBe(12)
    expect(after?.billsAiProcessed).toBe(156)
    expect(mockSendOpsAlert).toHaveBeenCalledTimes(1)
    expect(mockSendOpsAlert.mock.calls[0][1].text).toMatch(/FAILED/i)
  })

  it('does not alert when all tenants are fast and ok', async () => {
    await seedTwoTenants()
    vi.stubGlobal('fetch', delayedFetch(0, true))
    const db = drizzle(env.DB, { schema })
    await pullEngagementStats({ ...TEST_ENV, D_LATENCY_THRESHOLD_MS: '5000' }, db)
    expect(mockSendOpsAlert).not.toHaveBeenCalled()
  })
})

describe('shouldRunEngagementPull', () => {
  it('returns true at UTC hour 6', () => {
    const d = new Date('2026-05-29T06:00:00Z')
    expect(shouldRunEngagementPull(d)).toBe(true)
  })
  it('returns false at other hours', () => {
    expect(shouldRunEngagementPull(new Date('2026-05-29T05:59:00Z'))).toBe(false)
    expect(shouldRunEngagementPull(new Date('2026-05-29T07:00:00Z'))).toBe(false)
    expect(shouldRunEngagementPull(new Date('2026-05-29T00:00:00Z'))).toBe(false)
  })
})
