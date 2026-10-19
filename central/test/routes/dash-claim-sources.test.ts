import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { app } from '../../src/index-legiscan'
import { clearDb } from '../helpers/migrations'

// Operators see how well one instance's claim links resolve (#573): central asks
// the instance over its service binding, so nothing is stored here and nothing
// is readable by the instance's own members or by another tenant.

const ADMIN = { Authorization: 'Bearer sek' }
const BASE: any = { ...env, ADMIN_SECRET: 'sek' }

beforeEach(async () => { await clearDb() })

const COUNTS = {
  analyses: { withClaimSources: 7, emptyList: 2, noList: 5 },
  items: { exact: 40, normalized: 6, fuzzy: 9, anchored: 3, ungrounded: 4, unverified: 12, total: 74 },
  cutOffRetries: 3,
  computedAt: '2026-03-01T12:00:00.000Z',
}

async function seedTenants() {
  const db = drizzle(env.DB, { schema })
  await db.insert(schema.tenants).values([
    { tenantId: 'ri', name: 'Instance One', stateCoverage: '["RI"]', active: true } as any,
    { tenantId: 'nj', name: 'Instance Two', stateCoverage: '["NJ"]', active: true } as any,
  ])
}

const get = (path: string, headers: Record<string, string>, e: any = BASE) =>
  app.fetch(new Request(`http://central${path}`, { headers }), e)

describe('GET /admin/dash/tenants/:id/claim-sources', () => {
  it('asks the instance for its counts and returns them', async () => {
    await seedTenants()
    const e = { ...BASE, TENANT_RI: { claimSourceCounts: async () => COUNTS } }
    const res = await get('/admin/dash/tenants/ri/claim-sources', ADMIN, e)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.data).toEqual(COUNTS)
    expect(typeof body.meta.generatedAt).toBe('string')
  })

  it('reads each instance through its own binding', async () => {
    await seedTenants()
    const e = {
      ...BASE,
      TENANT_RI: { claimSourceCounts: async () => COUNTS },
      TENANT_NJ: { claimSourceCounts: async () => ({ ...COUNTS, cutOffRetries: 99 }) },
    }
    const one = await (await get('/admin/dash/tenants/ri/claim-sources', ADMIN, e)).json() as any
    const two = await (await get('/admin/dash/tenants/nj/claim-sources', ADMIN, e)).json() as any
    expect(one.data.cutOffRetries).toBe(3)
    expect(two.data.cutOffRetries).toBe(99)
  })

  it('returns an instance with no claim sources as zeros, which the page shows as such', async () => {
    await seedTenants()
    const zeros = {
      analyses: { withClaimSources: 0, emptyList: 0, noList: 0 },
      items: { exact: 0, normalized: 0, fuzzy: 0, anchored: 0, ungrounded: 0, unverified: 0, total: 0 },
      cutOffRetries: 0,
    }
    const e = { ...BASE, TENANT_RI: { claimSourceCounts: async () => zeros } }
    const body = await (await get('/admin/dash/tenants/ri/claim-sources', ADMIN, e)).json() as any
    expect(body.data).toEqual(zeros)
  })

  it('404s for a tenant central has never registered, without calling any instance', async () => {
    let called = false
    const e = { ...BASE, TENANT_RI: { claimSourceCounts: async () => { called = true; return COUNTS } } }
    const res = await get('/admin/dash/tenants/ri/claim-sources', ADMIN, e)
    expect(res.status).toBe(404)
    expect(((await res.json()) as any).error).toMatchObject({ code: 'not_found', message: 'Tenant not found' })
    expect(called).toBe(false)
  })

  it('501s, saying so, when central has no binding for the instance', async () => {
    await seedTenants()
    const res = await get('/admin/dash/tenants/ri/claim-sources', ADMIN)
    expect(res.status).toBe(501)
    expect(((await res.json()) as any).error).toMatchObject({ code: 'not_bound' })
  })

  it('502s with the instance own words when the call fails, such as an instance from before this feature', async () => {
    await seedTenants()
    const e = { ...BASE, TENANT_RI: { claimSourceCounts: async () => { throw new Error('RPC method "claimSourceCounts" does not exist') } } }
    const res = await get('/admin/dash/tenants/ri/claim-sources', ADMIN, e)
    expect(res.status).toBe(502)
    expect(((await res.json()) as any).error).toMatchObject({ code: 'tenant_call_failed', message: expect.stringContaining('does not exist') })
  })
})

describe('who can read it', () => {
  it('refuses a request with no credentials, and never calls the instance', async () => {
    await seedTenants()
    let called = false
    const e = { ...BASE, TENANT_RI: { claimSourceCounts: async () => { called = true; return COUNTS } } }
    const res = await get('/admin/dash/tenants/ri/claim-sources', {}, e)
    expect(res.status).toBe(401)
    expect(called).toBe(false)
  })

  it('refuses a wrong admin secret', async () => {
    await seedTenants()
    const e = { ...BASE, TENANT_RI: { claimSourceCounts: async () => COUNTS } }
    const res = await get('/admin/dash/tenants/ri/claim-sources', { Authorization: 'Bearer nope' }, e)
    expect(res.status).toBe(401)
  })

  it('refuses a session cookie that is not an admin session', async () => {
    await seedTenants()
    const e = { ...BASE, TENANT_RI: { claimSourceCounts: async () => COUNTS } }
    const res = await get('/admin/dash/tenants/ri/claim-sources', { Cookie: 'admin_session=not-a-real-token' }, e)
    expect(res.status).toBe(401)
  })
})
