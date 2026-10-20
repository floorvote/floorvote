import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { TenantApi, app } from '../../src/index-legiscan'
import { clearDb } from '../helpers/migrations'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'

// Object-level authorization for the tenant-reachable central surface.
//
// The deny-by-default allowlist (lib/tenantSurface) limits WHICH operations a
// tenant can reach over the service binding, but not WHICH tenant's objects —
// the routes take :tenantId (or body.tenantId) as a param. Cloudflare service-
// binding `props` give central the authentic, unforgeable id of the CALLING
// tenant (set at deploy time), surfaced by TenantApi as the `x-caller-tenant`
// header. A props-carrying tenant may then act ONLY on its own tenantId.
//
// Absent header ⇒ NOT a props-carrying binding call: either the public HTTP
// operator path (real x-admin-secret, legitimately cross-tenant) or a tenant not
// yet redeployed with the prop (rollout window). Both are allowed — the check
// auto-activates per tenant once its prop ships.

const TEST_ENV: any = {
  ...env,
  ADMIN_SECRET: 'test-secret',
  SUPERADMIN_EMAILS: 'admin@example.com',
}

// ExecutionContext stub. `props` is what Cloudflare populates from the service
// binding's configured props at deploy time; `undefined` simulates a tenant not
// yet redeployed with the prop.
function makeTenantApi(props?: { tenantId?: string }): TenantApi {
  const ctx: any = { waitUntil: () => {}, passThroughOnException: () => {}, props }
  return new TenantApi(ctx, TEST_ENV)
}

function bindingCall(
  props: { tenantId?: string } | undefined,
  method: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return makeTenantApi(props).fetch(new Request(`https://central${path}`, { method, ...init }))
}

const JSON_HEADERS = { 'content-type': 'application/json' }

beforeEach(async () => {
  await clearDb()
  vi.restoreAllMocks()
})

describe('TenantApi cross-tenant object-level authz (props.tenantId)', () => {
  describe('a caller whose props.tenantId = "ri" may act only on "ri"', () => {
    const RI = { tenantId: 'ri' }

    it('blocks reprocess of another tenant with 403', async () => {
      const res = await bindingCall(RI, 'POST', '/api/tenants/reprocess/nj', { headers: JSON_HEADERS, body: '{}' })
      expect(res.status).toBe(403)
    })

    it('allows reprocess of its own tenant (reaches the route, not 403)', async () => {
      const res = await bindingCall(RI, 'POST', '/api/tenants/reprocess/ri', { headers: JSON_HEADERS, body: '{}' })
      expect(res.status).not.toBe(403)
    })

    it('blocks promote-bill for another tenant with 403', async () => {
      const res = await bindingCall(RI, 'POST', '/api/tenants/promote-bill/nj/123', { headers: JSON_HEADERS, body: '{}' })
      expect(res.status).toBe(403)
    })

    it('blocks promote-bills for another tenant with 403', async () => {
      const res = await bindingCall(RI, 'POST', '/api/tenants/promote-bills/nj', { headers: JSON_HEADERS, body: '{}' })
      expect(res.status).toBe(403)
    })

    it('blocks fetch-bills for another tenant with 403', async () => {
      const res = await bindingCall(RI, 'POST', '/api/tenants/fetch-bills/nj', { headers: JSON_HEADERS, body: '{}' })
      expect(res.status).toBe(403)
    })

    it('blocks upcoming-hearings for another tenant with 403', async () => {
      const res = await bindingCall(RI, 'GET', '/api/tenants/nj/upcoming-hearings')
      expect(res.status).toBe(403)
    })

    it('blocks body-events for another tenant with 403', async () => {
      const res = await bindingCall(RI, 'GET', '/api/tenants/nj/body-events?from=2026-10-01&to=2026-10-31')
      expect(res.status).toBe(403)
    })

    it('allows body-events for its own tenant (not 403)', async () => {
      const res = await bindingCall(RI, 'GET', '/api/tenants/ri/body-events?from=2026-10-01&to=2026-10-31')
      expect(res.status).toBe(200)
    })

    it('blocks body-event-options for another tenant with 403', async () => {
      const res = await bindingCall(RI, 'GET', '/api/tenants/nj/body-event-options')
      expect(res.status).toBe(403)
    })

    it('allows body-event-options for its own tenant (not 403)', async () => {
      const res = await bindingCall(RI, 'GET', '/api/tenants/ri/body-event-options')
      expect(res.status).toBe(200)
    })

    it('blocks admin sync-keywords for another tenant with 403', async () => {
      const res = await bindingCall(RI, 'POST', '/api/admin/sync-keywords/nj')
      expect(res.status).toBe(403)
    })

    it('allows admin sync-keywords for its own tenant (not 403)', async () => {
      const res = await bindingCall(RI, 'POST', '/api/admin/sync-keywords/ri')
      expect(res.status).not.toBe(403)
    })

    it('blocks admin update-bill-match-types for another tenant with 403', async () => {
      const res = await bindingCall(RI, 'POST', '/api/admin/update-bill-match-types/nj', { headers: JSON_HEADERS, body: '{"updates":[]}' })
      expect(res.status).toBe(403)
    })

    it('blocks registering another tenant (body.tenantId mismatch) with 403', async () => {
      const res = await bindingCall(RI, 'POST', '/api/tenants/register', {
        headers: JSON_HEADERS,
        body: JSON.stringify({ tenantId: 'nj', name: 'NJ', apiUrl: 'https://nj.example.com', stateCoverage: ['NJ'] }),
      })
      expect(res.status).toBe(403)
    })

    it('allows registering itself and the body still reaches the handler (200)', async () => {
      // Asserting 200 (not merely "not 403") proves the guard's body read did not
      // consume the request body out from under the handler — Hono caches it, so
      // the handler still sees apiUrl/name/stateCoverage. A consumed body would
      // 400 (missing apiUrl), which would slip past a bare not-403 assertion.
      const res = await bindingCall(RI, 'POST', '/api/tenants/register', {
        headers: JSON_HEADERS,
        body: JSON.stringify({ tenantId: 'ri', name: 'RI', apiUrl: 'https://ri.example.com', stateCoverage: ['RI'] }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ ok: true })
    })

    it('cannot forge identity: a client-supplied x-caller-tenant is overwritten from props', async () => {
      // "ri" attaches x-caller-tenant: nj itself, trying to pass as nj. TenantApi
      // must set the header authoritatively from props, so the target still mismatches.
      const res = await bindingCall(RI, 'POST', '/api/tenants/reprocess/nj', {
        headers: { ...JSON_HEADERS, 'x-caller-tenant': 'nj' },
        body: '{}',
      })
      expect(res.status).toBe(403)
    })
  })

  describe('a caller WITHOUT props (pre-migration binding call) is lenient — no downtime', () => {
    it('still reaches a cross-tenant route (not 403)', async () => {
      const res = await bindingCall(undefined, 'POST', '/api/tenants/reprocess/nj', { headers: JSON_HEADERS, body: '{}' })
      expect(res.status).not.toBe(403)
    })

    it('does not honor a spoofed x-caller-tenant as identity (stripped; stays lenient)', async () => {
      // Without props the header must not be trusted; it is stripped so it cannot
      // manufacture a match under a future strict policy. Behaviorally lenient today.
      const res = await bindingCall(undefined, 'POST', '/api/tenants/reprocess/nj', {
        headers: { ...JSON_HEADERS, 'x-caller-tenant': 'nj' },
        body: '{}',
      })
      expect(res.status).not.toBe(403)
    })
  })

  // A demo's shared admin session reaches central only through its binding. operatorAi
  // lifts the demo's no-AI gate, so no binding call may set it, even for its own tenant.
  it('a binding call with operatorAi queues messages without the flag', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.bills).values({ billId: 101, sessionId: 1, state: 'RI', stateId: 44, billNumber: 'H1', title: 'A', changeHash: 'h1', status: 1 })
    await db.insert(schema.billTenants).values({ billId: 101, tenantId: 'ri', matchType: 'keyword' })
    const sent: any[] = []
    const queueEnv: any = {
      ...TEST_ENV,
      TENANT_QUEUE_RI: { send: async (m: any) => sent.push(m), sendBatch: async (ms: any[]) => sent.push(...ms.map((x: any) => x.body)) },
    }
    const ctx: any = { waitUntil: () => {}, passThroughOnException: () => {}, props: { tenantId: 'ri' } }
    const res = await new TenantApi(ctx, queueEnv).fetch(new Request('https://central/api/tenants/reprocess/ri', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ billIds: [101], operatorAi: true }),
    }))
    expect(res.status).toBe(200)
    expect(sent).toHaveLength(1)
    expect(sent[0].operatorAi).toBeUndefined()
    expect(sent[0].forceAI).toBeUndefined()
  })

  describe('the public HTTP operator path (x-admin-secret, no binding) bypasses the check', () => {
    it('may act cross-tenant (not 403)', async () => {
      const res = await app.fetch(
        new Request('http://central/api/tenants/reprocess/nj', {
          method: 'POST',
          headers: { ...JSON_HEADERS, 'x-admin-secret': 'test-secret' },
          body: '{}',
        }),
        TEST_ENV,
      )
      expect(res.status).not.toBe(403)
    })
  })
})
