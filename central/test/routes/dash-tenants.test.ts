import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema-legiscan'
import { app } from '../../src/index-legiscan'
import { setupLsDb } from '../helpers/setupLsDb'

const TEST_ENV: any = { ...env, ADMIN_SECRET: 'sek' }
const AUTH = { Authorization: 'Bearer sek' }

beforeEach(async () => { await setupLsDb() })

async function seed() {
  const db = drizzle(env.DB, { schema })
  await db.insert(schema.tenants).values([
    { tenantId: 'ri', name: 'RI', stateCoverage: '["RI"]', active: true, aiContextPersonalized: true } as any,
  ])
  await db.insert(schema.bills).values([
    { billId: 1, sessionId: 1, state: 'RI', stateId: 41, billNumber: 'H1', changeHash: 'h', title: 'Election day registration', createdAt: '2026-05-28T00:00:00Z', updatedAt: '2026-05-28T10:00:00Z' } as any,
    { billId: 2, sessionId: 1, state: 'RI', stateId: 41, billNumber: 'H2', changeHash: 'h', title: 'Ballot drop boxes', createdAt: '2026-05-28T01:00:00Z', updatedAt: '2026-05-28T11:00:00Z' } as any,
    { billId: 3, sessionId: 1, state: 'RI', stateId: 41, billNumber: 'H3', changeHash: 'h', title: 'Unrelated', createdAt: '2026-05-28T02:00:00Z', updatedAt: '2026-05-28T12:00:00Z' } as any,
  ])
  await db.insert(schema.billTenants).values([
    { billId: 1, tenantId: 'ri', matchType: 'keyword' },
    { billId: 2, tenantId: 'ri', matchType: 'manual' },
    { billId: 3, tenantId: 'ri', matchType: null },
  ])
  await db.insert(schema.keywordRegistry).values([
    { tenantId: 'ri', keyword: 'election' } as any,
    { tenantId: 'ri', keyword: 'ballot' } as any,
  ])
}

describe('GET /admin/dash/tenants', () => {
  it('returns one row per tenant with match-type breakdown', async () => {
    await seed()
    const res = await app.fetch(new Request('http://central/admin/dash/tenants', { headers: AUTH }), TEST_ENV)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.data.tenants.length).toBe(1)
    const t = body.data.tenants[0]
    expect(t.id).toBe('ri')
    expect(t.billCounts).toEqual({ keyword: 1, manual: 1, null: 1, total: 3 })
    expect(t.keywordCount).toBe(2)
    expect(t.lastBillIngestedAt).toBe('2026-05-28T02:00:00Z')
  })
})

describe('GET /admin/dash/tenants/:id', () => {
  it('returns full drilldown for a tenant', async () => {
    await seed()
    // Add a second tenant tracking the same bill so cross-tenant interest is non-empty
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.tenants).values([
      { tenantId: 'acme', name: 'Acme', stateCoverage: '["RI"]', active: true } as any,
    ])
    await db.insert(schema.billTenants).values([
      { billId: 1, tenantId: 'acme', matchType: 'keyword' },
    ])

    const res = await app.fetch(new Request('http://central/admin/dash/tenants/ri', { headers: AUTH }), TEST_ENV)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.data.tenant.id).toBe('ri')
    expect(body.data.tenant.aiContextPersonalized).toBe(true)
    expect(body.data.matchTypeBreakdown).toEqual({ keyword: 1, manual: 1, null: 1 })
    expect(Array.isArray(body.data.keywordEffectiveness)).toBe(true)
    expect(body.data.crossTenantBills.length).toBe(1)
    expect(body.data.crossTenantBills[0].alsoTrackedBy).toEqual(['acme'])
  })

  it('computes textStatusBreakdown via aggregate (not per-bill inArray)', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.tenants).values([
      { tenantId: 'ri', name: 'RI', stateCoverage: '["RI"]', active: true } as any,
    ])
    await db.insert(schema.bills).values([
      { billId: 1, sessionId: 1, state: 'RI', stateId: 41, billNumber: 'H1', changeHash: 'h', title: 'A', createdAt: '2026-05-28T00:00:00Z', updatedAt: '2026-05-28T00:00:00Z' } as any, // not_checked (no textsFetchedAt)
      { billId: 2, sessionId: 1, state: 'RI', stateId: 41, billNumber: 'H2', changeHash: 'h', title: 'B', textsFetchedAt: '2026-05-28T01:00:00Z', createdAt: '2026-05-28T00:00:00Z', updatedAt: '2026-05-28T00:00:00Z' } as any, // available (fetched + has a text row)
      { billId: 3, sessionId: 1, state: 'RI', stateId: 41, billNumber: 'H3', changeHash: 'h', title: 'C', textsFetchedAt: '2026-05-28T02:00:00Z', createdAt: '2026-05-28T00:00:00Z', updatedAt: '2026-05-28T00:00:00Z' } as any, // no_texts (fetched, no text row)
    ])
    await db.insert(schema.billTenants).values([
      { billId: 1, tenantId: 'ri', matchType: 'keyword' },
      { billId: 2, tenantId: 'ri', matchType: 'keyword' },
      { billId: 3, tenantId: 'ri', matchType: 'manual' },
    ])
    await db.insert(schema.billTexts).values([{ docId: 1, billId: 2, date: '2026-05-28', type: 'Introduced' } as any])

    const res = await app.fetch(new Request('http://central/admin/dash/tenants/ri', { headers: AUTH }), TEST_ENV)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.data.textStatusBreakdown).toEqual({ not_checked: 1, available: 1, no_texts: 1 })
  })

  it('returns 404 for unknown tenant', async () => {
    const res = await app.fetch(new Request('http://central/admin/dash/tenants/nope', { headers: AUTH }), TEST_ENV)
    expect(res.status).toBe(404)
  })
})
