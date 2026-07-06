import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema-legiscan'
import { app } from '../../src/index-legiscan'
import { setupLsDb } from '../helpers/setupLsDb'

const TEST_ENV: any = { ...env, ADMIN_SECRET: 'sek' }
const AUTH = { Authorization: 'Bearer sek' }

beforeEach(async () => { await setupLsDb() })

describe('GET /admin/dash/overview', () => {
  it('returns expected shape and counts', async () => {
    const db = drizzle(env.DB, { schema })
    // Seed: 2 tenants, mixed match types, some api calls, one cron tick
    await db.insert(schema.tenants).values([
      { tenantId: 'ri', name: 'RI', stateCoverage: '["RI"]', active: true } as any,
      { tenantId: 'acme', name: 'Acme', stateCoverage: '["RI","NJ"]', active: true } as any,
    ])
    await db.insert(schema.bills).values([
      { billId: 1, sessionId: 1, state: 'RI', stateId: 41, billNumber: 'H1', changeHash: 'h', title: 't1' } as any,
      { billId: 2, sessionId: 1, state: 'RI', stateId: 41, billNumber: 'H2', changeHash: 'h', title: 't2' } as any,
      { billId: 3, sessionId: 1, state: 'RI', stateId: 41, billNumber: 'H3', changeHash: 'h', title: 't3' } as any,
    ])
    await db.insert(schema.billTenants).values([
      { billId: 1, tenantId: 'ri', matchType: 'keyword' },
      { billId: 2, tenantId: 'ri', matchType: 'manual' },
      { billId: 3, tenantId: 'ri', matchType: null },
    ])
    await db.insert(schema.apiCallLog).values([
      { callType: 'getBill', params: '{}', loggedAt: new Date().toISOString() } as any,
      { callType: 'getMasterList', params: '{}', loggedAt: new Date().toISOString() } as any,
    ])
    await db.insert(schema.sessionSyncLog).values([
      { sessionId: 1, sessionName: 'RI 2026', state: 'RI', syncedAt: new Date(Date.now() - 60_000).toISOString(), billsChecked: 10, billsChanged: 2, billsQueued: 2 } as any,
    ])

    const res = await app.fetch(new Request('http://central/admin/dash/overview', { headers: AUTH }), TEST_ENV)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.data.tenants.total).toBe(2)
    expect(body.data.bills.fullyTracked).toBe(2)
    expect(body.data.bills.lightweight).toBe(1)
    expect(body.data.apiBudget.used).toBe(2)
    expect(body.data.apiBudget.limit).toBe(30000)
    expect(body.data.lastSync.ageSeconds).toBeGreaterThanOrEqual(0)
    expect(body.data.lastSync.billsChanged).toBe(2)
    expect(body.meta.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})
