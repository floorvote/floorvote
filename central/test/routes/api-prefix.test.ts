import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../../src/index-legiscan'

// The machine API is served under /api/* so its prefixes (/api/tenants, /api/bills,
// /api/admin) no longer shadow the dashboard SPA's client routes (/tenants, …).
// A request that reaches a machine router without x-admin-secret 401s at the
// router's own use('*') guard — so "401, not 404-from-catchall" proves the mount.

const TEST_ENV: any = { ...env, ADMIN_SECRET: 'sek' }

function get(path: string) {
  return app.fetch(new Request(`http://central${path}`), TEST_ENV)
}

describe('machine API mounted under /api/*', () => {
  it('gates /api/tenants/* with the admin secret', async () => {
    expect((await get('/api/tenants/anything')).status).toBe(401)
  })
  it('gates /api/bills/*', async () => {
    expect((await get('/api/bills/123')).status).toBe(401)
  })
  it('gates /api/admin/*', async () => {
    expect((await get('/api/admin/anything')).status).toBe(401)
  })
})

describe('legacy bare-path machine API removed (collision fixed)', () => {
  // After cleanup, /tenants etc. are no longer machine routes — they fall through
  // to the asset/catch-all (ASSETS unbound in tests → 404), so a browser hitting
  // admin.example.com/tenants now gets the SPA instead of a machine 401.
  it('legacy /tenants no longer 401s (falls through to the SPA)', async () => {
    expect((await get('/tenants')).status).not.toBe(401)
  })
  it('legacy /bills no longer 401s', async () => {
    expect((await get('/bills/123')).status).not.toBe(401)
  })
})

describe('SPA client routes are not shadowed by the machine API', () => {
  it('a dashboard-only route does not 401', async () => {
    expect((await get('/adoption')).status).not.toBe(401)
  })
})
