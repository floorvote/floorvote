import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../../src/index'
import { resetDb, applyMigrations, seedUser, seedSession } from '../helpers'

const READ_ONLY_BODY = { error: 'This demo is read-only' }

describe('demo read-only guard', () => {
  let cookie: string
  const demoEnv = { ...env, DEMO_MODE: 'true' }

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const userId = await seedUser({ role: 'owner' })
    cookie = `session=${await seedSession(userId)}`
  })

  it('blocks POST with 403 and the read-only message', async () => {
    const res = await app.request('/api/bills/some-id/comments', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '<p>hi</p>' }),
    }, demoEnv)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual(READ_ONLY_BODY)
  })

  it('blocks DELETE', async () => {
    const res = await app.request('/api/comments/some-id', {
      method: 'DELETE', headers: { Cookie: cookie },
    }, demoEnv)
    expect(res.status).toBe(403)
  })

  it('allows GET', async () => {
    const res = await app.request('/api/config', { headers: { Cookie: cookie } }, demoEnv)
    expect(res.status).toBe(200)
  })

  it('allows OPTIONS so CORS preflight still works', async () => {
    const res = await app.request('/api/config', { method: 'OPTIONS' }, demoEnv)
    expect(res.status).not.toBe(403)
  })

  it('allows PUT /api/admin/config so module toggles still work', async () => {
    const res = await app.request('/api/admin/config', {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ modules: { calendar: true } }),
    }, demoEnv)
    expect(res.status).not.toBe(403)
  })

  it('allows the internal operator surface through to its own auth', async () => {
    // Internal routes are secret-gated by internalAuthFail; the guard must not
    // shadow that with a 403, or cron and ops scripts break on the demo tenant.
    const res = await app.request('/api/internal/demo-reset', { method: 'POST' }, demoEnv)
    expect(res.status).toBe(401)
  })

  it('does not block writes when DEMO_MODE is unset', async () => {
    const res = await app.request('/api/bills/some-id/comments', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '<p>hi</p>' }),
    }, env)
    expect(res.status).not.toBe(403)
  })

  it('blocks every registered non-GET API route', async () => {
    // Exhaustive by construction: the guard is mounted on /api/* so it runs
    // before route matching. Any non-GET path under /api/ is refused whether or
    // not a route exists, which is exactly the property we want to assert.
    const exempt = (p: string) =>
      p === '/api/auth/demo-login' || p === '/api/admin/config' || p.startsWith('/api/internal/')
    const targets = app.routes
      .filter(r => r.method !== 'GET' && r.method !== 'ALL' && r.path.startsWith('/api/'))
      .filter(r => !exempt(r.path))
    expect(targets.length).toBeGreaterThan(20)
    for (const r of targets) {
      const res = await app.request(r.path, {
        method: r.method,
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: '{}',
      }, demoEnv)
      expect(res.status, `${r.method} ${r.path} should be 403`).toBe(403)
    }
  })
})
