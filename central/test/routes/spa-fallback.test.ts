import { describe, it, expect } from 'vitest'
import { app } from '../../src/index-legiscan'

// In the test environment, the ASSETS binding is not available (it's a Cloudflare binding).
// The catch-all falls back to c.notFound(), which returns a 404 from Hono's default handler.
// What we're testing here is that an unmatched GET does NOT throw an unhandled error —
// it returns a response (either the SPA shell in prod, or Hono's 404 in test).
const TEST_ENV: any = { ADMIN_SECRET: 'sek' }

describe('SPA catch-all fallback', () => {
  it('returns a response (not an unhandled error) for unknown GET paths', async () => {
    const res = await app.fetch(new Request('http://central/sync'), TEST_ENV)
    // In test env ASSETS is not available → Hono 404 (not an uncaught exception)
    expect([200, 404]).toContain(res.status)
  })

  it('returns a response for /budget deep-link', async () => {
    const res = await app.fetch(new Request('http://central/budget'), TEST_ENV)
    expect([200, 404]).toContain(res.status)
  })

  it('does not 404 an API route that exists', async () => {
    const res = await app.fetch(
      new Request('http://central/admin/dash/overview', { headers: { Authorization: 'Bearer sek' } }),
      TEST_ENV,
    )
    // API route should be found (200 or 401/403 if auth fails for other reasons, but NOT via catch-all 404)
    expect(res.status).not.toBe(404)
  })
})
