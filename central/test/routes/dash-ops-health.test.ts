import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema-legiscan'
import { app } from '../../src/index-legiscan'
import { setupLsDb } from '../helpers/setupLsDb'

const TEST_ENV: any = { ...env, ADMIN_SECRET: 'sek' }
const AUTH = { Authorization: 'Bearer sek' }

beforeEach(async () => { await setupLsDb() })

describe('GET /admin/dash/ops-health', () => {
  it('reports per-tenant pipeline staleness and per-state sync staleness', async () => {
    const db = drizzle(env.DB, { schema })
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString()      // 1h ago
    const old = new Date(Date.now() - 200 * 60 * 60 * 1000).toISOString()   // ~8d ago

    await db.insert(schema.tenants).values([
      { tenantId: 'ri', name: 'RI', stateCoverage: '["RI"]', active: true, apiUrl: 'http://ri', lastSeenAt: recent, aiContextPersonalized: true } as any,
      { tenantId: 'stale', name: 'Stale', stateCoverage: '["NJ"]', active: true, apiUrl: 'http://s', lastSeenAt: old } as any,
    ])
    await db.insert(schema.bills).values([{ billId: 1, sessionId: 1, state: 'RI', stateId: 41, billNumber: 'H1', changeHash: 'h', title: 't' } as any])
    await db.insert(schema.billTenants).values([
      { billId: 1, tenantId: 'ri', notifiedAt: recent, matchType: 'keyword' } as any,
    ])
    await db.insert(schema.tenantStats).values([
      // A large count, but the oldest one is recent — this is the sweep
      // working through a fresh outage, not a problem.
      { tenantId: 'ri', statDate: '2026-06-05', pulledAt: recent, billsAiStalled: 24, billsAiStalledOldestHours: 2 } as any,
    ])
    await db.insert(schema.sessions).values([
      { sessionId: 1, state: 'RI', stateId: 41, yearStart: 2026, yearEnd: 2026, prefile: 0, sineDie: 0, prior: 0, special: 0, sessionTag: '', sessionTitle: 'RI 2026', sessionName: 'RI 2026', syncEnabled: true, lastSyncedAt: recent } as any,
      { sessionId: 2, state: 'NJ', stateId: 30, yearStart: 2026, yearEnd: 2026, prefile: 0, sineDie: 0, prior: 0, special: 0, sessionTag: '', sessionTitle: 'NJ 2026', sessionName: 'NJ 2026', syncEnabled: true, lastSyncedAt: old } as any,
    ])

    const res = await app.fetch(new Request('http://central/admin/dash/ops-health', { headers: AUTH }), TEST_ENV)
    expect(res.status).toBe(200)
    const body = await res.json() as any

    const ri = body.data.tenants.find((t: any) => t.tenantId === 'ri')
    expect(ri.lastBillDeliveredAt).toBe(recent)
    expect(ri.lastStatsPullAt).toBe(recent)
    expect(ri.lastSeenAt).toBe(recent)
    expect(ri.stalledAi).toBe(24)
    expect(ri.stalledAiOldestHours).toBe(2)
    // A large count, but nothing OLD, must NOT be a problem — that is the
    // sweep working through a fresh outage, not something broken.
    expect(ri.stale).toBe(false)
    expect(ri.problems).toEqual([])
    expect(ri.aiContextPersonalized).toBe(true)

    const stale = body.data.tenants.find((t: any) => t.tenantId === 'stale')
    expect(stale.stale).toBe(true) // never delivered a bill + lastSeen old
    expect(stale.aiContextPersonalized).toBe(false)
    expect(stale.problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('No bills delivered in'),
        expect.stringContaining('Not seen in'),
      ]),
    )

    const nj = body.data.states.find((s: any) => s.state === 'NJ')
    expect(nj.stale).toBe(true)
    const riState = body.data.states.find((s: any) => s.state === 'RI')
    expect(riState.stale).toBe(false)
  })

  it('reports OK with no problems for a fully healthy tenant', async () => {
    const db = drizzle(env.DB, { schema })
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString()

    await db.insert(schema.tenants).values([
      { tenantId: 'healthy', name: 'Healthy', stateCoverage: '["RI"]', active: true, apiUrl: 'http://h', lastSeenAt: recent } as any,
    ])
    await db.insert(schema.bills).values([{ billId: 2, sessionId: 1, state: 'RI', stateId: 41, billNumber: 'H2', changeHash: 'h', title: 't' } as any])
    await db.insert(schema.billTenants).values([
      { billId: 2, tenantId: 'healthy', notifiedAt: recent, matchType: 'keyword' } as any,
    ])
    await db.insert(schema.tenantStats).values([
      { tenantId: 'healthy', statDate: '2026-06-05', pulledAt: recent, billsAiStalled: 0, billsAiStalledOldestHours: 0 } as any,
    ])

    const res = await app.fetch(new Request('http://central/admin/dash/ops-health', { headers: AUTH }), TEST_ENV)
    const body = await res.json() as any
    const healthy = body.data.tenants.find((t: any) => t.tenantId === 'healthy')
    expect(healthy.stale).toBe(false)
    expect(healthy.problems).toEqual([])
  })

  it('flags a tenant whose oldest stalled bill has been stuck for days', async () => {
    const db = drizzle(env.DB, { schema })
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString()

    await db.insert(schema.tenants).values([
      { tenantId: 'stuck', name: 'Stuck', stateCoverage: '["RI"]', active: true, apiUrl: 'http://st', lastSeenAt: recent } as any,
    ])
    await db.insert(schema.bills).values([{ billId: 3, sessionId: 1, state: 'RI', stateId: 41, billNumber: 'H3', changeHash: 'h', title: 't' } as any])
    await db.insert(schema.billTenants).values([
      { billId: 3, tenantId: 'stuck', notifiedAt: recent, matchType: 'keyword' } as any,
    ])
    await db.insert(schema.tenantStats).values([
      // Oldest stalled bill is 50 hours old — well past the sweep's own
      // 1-hour floor, so this is the sweep not running, not mid-recovery.
      { tenantId: 'stuck', statDate: '2026-06-05', pulledAt: recent, billsAiStalled: 3, billsAiStalledOldestHours: 50 } as any,
    ])

    const res = await app.fetch(new Request('http://central/admin/dash/ops-health', { headers: AUTH }), TEST_ENV)
    const body = await res.json() as any
    const stuck = body.data.tenants.find((t: any) => t.tenantId === 'stuck')
    expect(stuck.stale).toBe(true)
    expect(stuck.problems).toEqual(
      expect.arrayContaining([expect.stringContaining('3 bills stuck on AI analysis, oldest 2 days')]),
    )
  })

  it('excludes sine-die and sync-disabled sessions from state staleness', async () => {
    const db = drizzle(env.DB, { schema })
    const old = new Date(Date.now() - 200 * 60 * 60 * 1000).toISOString()
    await db.insert(schema.sessions).values([
      // CA: only a sine-die session → CA must NOT appear in states
      { sessionId: 3, state: 'CA', stateId: 5, yearStart: 2024, yearEnd: 2024, prefile: 0, sineDie: 1, prior: 1, special: 0, sessionTag: '', sessionTitle: 'CA 2024', sessionName: 'CA 2024', syncEnabled: true, lastSyncedAt: old } as any,
      // TX: only a sync-disabled session → TX must NOT appear in states
      { sessionId: 4, state: 'TX', stateId: 45, yearStart: 2026, yearEnd: 2026, prefile: 0, sineDie: 0, prior: 0, special: 0, sessionTag: '', sessionTitle: 'TX 2026', sessionName: 'TX 2026', syncEnabled: false, lastSyncedAt: old } as any,
    ])

    const res = await app.fetch(new Request('http://central/admin/dash/ops-health', { headers: AUTH }), TEST_ENV)
    const body = await res.json() as any
    expect(body.data.states.find((s: any) => s.state === 'CA')).toBeUndefined()
    expect(body.data.states.find((s: any) => s.state === 'TX')).toBeUndefined()
  })
})
