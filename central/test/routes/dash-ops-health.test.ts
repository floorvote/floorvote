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
      { tenantId: 'ri', statDate: '2026-06-05', pulledAt: recent } as any,
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
    expect(ri.stale).toBe(false)
    expect(ri.aiContextPersonalized).toBe(true)

    const stale = body.data.tenants.find((t: any) => t.tenantId === 'stale')
    expect(stale.stale).toBe(true) // never delivered a bill + lastSeen old
    expect(stale.aiContextPersonalized).toBe(false)

    const nj = body.data.states.find((s: any) => s.state === 'NJ')
    expect(nj.stale).toBe(true)
    const riState = body.data.states.find((s: any) => s.state === 'RI')
    expect(riState.stale).toBe(false)
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
