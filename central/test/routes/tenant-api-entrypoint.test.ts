import { env, createExecutionContext } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { app as lsApp, TenantApi as LsTenantApi } from '../../src/index-legiscan'
import { app as osApp, TenantApi as OsTenantApi } from '../../src/index'

// An authenticated request to GET /tenants passes the `use('*')` auth
// middleware and then finds no matching route, so the sub-router returns 404.
// Asserting on 404 (not merely "not 401") makes these tests falsifiable: if
// the entrypoint stopped injecting the secret, the middleware would 401 and
// the assertion would fail. (Used by the OpenStates env, whose TenantApi is
// still a generic forwarder.)
const AUTHED_NO_ROUTE = 404

describe('LegiScan TenantApi entrypoint', () => {
  it('rejects a direct app request that omits the secret', async () => {
    const res = await lsApp.request('/api/tenants', {}, env)
    expect(res.status).toBe(401)
  })

  // The LegiScan TenantApi is now DENY-BY-DEFAULT (see lib/tenantSurface). A bare
  // GET /api/tenants is NOT on the allowlist, so the entrypoint returns 403 before
  // touching the app — this is the security contract, not 404. Secret-injection on
  // ALLOWED routes is covered in tenant-api-surface.test.ts.
  it('blocks a non-allowlisted binding-path request with 403 (deny-by-default)', async () => {
    const ctx = createExecutionContext()
    const entry = new LsTenantApi(ctx, env)
    const res = await entry.fetch(new Request('https://central/api/tenants', { method: 'GET' }))
    expect(res.status).toBe(403)
  })

  it('blocks a non-allowlisted path even when a secret header is spoofed', async () => {
    const ctx = createExecutionContext()
    const entry = new LsTenantApi(ctx, env)
    const res = await entry.fetch(
      new Request('https://central/api/tenants', { headers: { 'x-admin-secret': 'wrong' } }),
    )
    expect(res.status).toBe(403)
  })
})

describe('OpenStates TenantApi entrypoint', () => {
  it('rejects a direct app request that omits the secret', async () => {
    const res = await osApp.request('/tenants', {}, env)
    expect(res.status).toBe(401)
  })

  it('injects the admin secret so a binding-path request is authorized without a header', async () => {
    const ctx = createExecutionContext()
    const entry = new OsTenantApi(ctx, env)
    const res = await entry.fetch(new Request('https://central/api/tenants', { method: 'GET' }))
    expect(res.status).toBe(AUTHED_NO_ROUTE)
  })

  it('overrides a spoofed/empty secret header with the real one', async () => {
    const ctx = createExecutionContext()
    const entry = new OsTenantApi(ctx, env)
    const res = await entry.fetch(
      new Request('https://central/api/tenants', { headers: { 'x-admin-secret': 'wrong' } }),
    )
    expect(res.status).toBe(AUTHED_NO_ROUTE)
  })
})
