import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { TenantApi, app } from '../../src/index-legiscan'
import { setupLsDb } from '../helpers/setupLsDb'

// The TenantApi WorkerEntrypoint is the ONLY surface tenants can reach over the
// service binding. It must be deny-by-default: only the explicit allowlist of
// (method, path) operations is forwarded into the Hono app; everything else
// returns 403 BEFORE central's ADMIN_SECRET is injected.

const TEST_ENV: any = {
  ...env,
  ADMIN_SECRET: 'test-secret',
  SUPERADMIN_EMAILS: 'admin@example.com',
}

// Minimal ExecutionContext stub for constructing the entrypoint in tests.
const ctx: any = { waitUntil: () => {}, passThroughOnException: () => {} }

function makeTenantApi(): TenantApi {
  return new TenantApi(ctx, TEST_ENV)
}

async function callTenantApi(method: string, path: string, init: RequestInit = {}): Promise<Response> {
  const api = makeTenantApi()
  return api.fetch(new Request(`https://central${path}`, { method, ...init }))
}

beforeEach(async () => {
  await setupLsDb()
  vi.restoreAllMocks()
})

describe('TenantApi deny-by-default forwarder', () => {
  describe('blocked paths return 403 and do NOT reach the app', () => {
    const blocked: [string, string][] = [
      ['POST', '/api/admin/superadmin/mint'],
      ['POST', '/api/admin/reingest-tenant/ri'],
      ['POST', '/api/admin/anomaly-watch'],
      ['POST', '/api/admin/trigger-sync'],
      ['POST', '/api/admin/backfill-match-types'],
      ['POST', '/api/tenants/ri/demo-reset'],
      ['POST', '/api/tenants/ri/run-digest'],
      ['POST', '/api/tenants/ri/refresh-metadata'],
      ['POST', '/api/tenants/ri/send-sample-email'],
      ['GET', '/api/admin/dash/auth/me'],
      ['GET', '/api/totally-unknown'],
    ]
    it.each(blocked)('blocks %s %s with 403', async (method, path) => {
      const res = await callTenantApi(method, path)
      expect(res.status).toBe(403)
    })

    it('blocks the encoded-mint evasion', async () => {
      const res = await callTenantApi('POST', '/api/admin/superadmin/%6dint')
      expect(res.status).toBe(403)
    })

    it('blocks a %2e%2e traversal aimed at mint (URL parser resolves it; matcher denies)', async () => {
      const res = await callTenantApi('POST', '/api/admin/superadmin/check/%2e%2e/mint')
      expect(res.status).toBe(403)
    })

    it('blocks an encoded-slash attempt to smuggle a segment into a wildcard', async () => {
      const res = await callTenantApi('POST', '/api/tenants/reprocess/ri%2fextra')
      expect(res.status).toBe(403)
    })

    it('blocks duplicate-slash variants of a blocked path', async () => {
      const res = await callTenantApi('POST', '/api//admin//superadmin//mint')
      expect(res.status).toBe(403)
    })
  })

  describe('bill read/text ops are forwarded (not 403) through the entrypoint', () => {
    // These are the read paths the tenant hits constantly: bill detail, the AI
    // text fetch, the per-version text fetch the web text panel uses, change log,
    // and session discovery. They must reach the app — a 403 here means the
    // deny-by-default forwarder is blocking a legitimate tenant op (the exact bug
    // that broke `text/:docId` on every tenant). The route may then 404 (no such
    // bill in the test DB); we only assert it is NOT the forwarder's 403.
    const reads: [string, string][] = [
      ['GET', '/api/bills/legiscan:123'],
      ['GET', '/api/bills/legiscan:123/text'],
      ['GET', '/api/bills/legiscan:123/text/9'],
      ['GET', '/api/bills/legiscan:123/changes'],
      ['GET', '/api/bills/sessions?state=RI'],
    ]
    it.each(reads)('forwards %s %s (not 403)', async (method, path) => {
      const res = await callTenantApi(method, path)
      expect(res.status).not.toBe(403)
    })
  })

  describe('allowlisted ops are forwarded into the app', () => {
    it('forwards GET /api/admin/superadmin/check (and injects the admin secret)', async () => {
      const res = await callTenantApi('GET', '/api/admin/superadmin/check?email=admin@example.com')
      expect(res.status).toBe(200)
      const body = await res.json() as { isSuperadmin: boolean }
      expect(body.isSuperadmin).toBe(true)
    })

    it('forwards POST /api/tenants/register through to the route (not 403)', async () => {
      const res = await callTenantApi('POST', '/api/tenants/register', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId: 'ri', apiUrl: 'https://ri.example.com', states: ['RI'] }),
      })
      // The exact status depends on the register route's validation, but it must
      // NOT be the forwarder's 403 — i.e. the request reached the app.
      expect(res.status).not.toBe(403)
    })

    it('injects x-admin-secret so the admin route auth passes (would 401 without it)', async () => {
      // /api/admin/superadmin/check sits behind the x-admin-secret middleware.
      // If the forwarder failed to inject the secret we'd get 401, not 200.
      const res = await callTenantApi('GET', '/api/admin/superadmin/check?email=outsider@example.com')
      expect(res.status).toBe(200)
      const body = await res.json() as { isSuperadmin: boolean }
      expect(body.isSuperadmin).toBe(false)
    })
  })

  it('a tenant-supplied x-admin-secret cannot reach a blocked route', async () => {
    // Even if a compromised tenant attaches the secret itself, the allowlist is
    // checked first, so a blocked path is still 403.
    const res = await callTenantApi('POST', '/api/admin/trigger-sync', {
      headers: { 'x-admin-secret': 'test-secret' },
    })
    expect(res.status).toBe(403)
  })

  it('operator routes blocked over the binding STILL work over public HTTP with x-admin-secret (no regression)', async () => {
    // Same route the binding blocks above. Over central's public HTTP /api/* path,
    // gated only by x-admin-secret, the operator CLI/dashboard must still reach it.
    const blockedViaBinding = await callTenantApi('POST', '/api/admin/reingest-tenant/does-not-exist', {
      headers: { 'x-admin-secret': 'test-secret' },
    })
    expect(blockedViaBinding.status).toBe(403)

    const viaHttp = await app.fetch(
      new Request('http://central/api/admin/reingest-tenant/does-not-exist', {
        method: 'POST',
        headers: { 'x-admin-secret': 'test-secret' },
      }),
      TEST_ENV,
    )
    // Reaches the route (404 = tenant not found), not the forwarder's 403 and not 401.
    expect(viaHttp.status).not.toBe(403)
    expect(viaHttp.status).not.toBe(401)
  })

  it('the public HTTP operator route still rejects a wrong/missing secret (401)', async () => {
    const res = await app.fetch(
      new Request('http://central/api/admin/trigger-sync', { method: 'POST' }),
      TEST_ENV,
    )
    expect(res.status).toBe(401)
  })
})
