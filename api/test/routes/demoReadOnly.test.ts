import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../../src/index'
import { resetDb, applyMigrations, seedUser, seedSession } from '../helpers'
import { DEMO_WRITE_ALLOWLIST } from '../../src/middleware/auth'
import type { RateLimiter } from '../../../shared/rateLimit'

const LOCKED_BODY = { error: 'This action is locked in the demo' }
const THROTTLED_BODY = { error: 'Too many changes from this connection — try again shortly' }

// Same shape as api/src/lib/rateLimit.test.ts — never a real binding.
function fakeLimiter(success: boolean, onKey?: (key: string) => void): RateLimiter {
  return {
    limit: async ({ key }) => {
      onKey?.(key)
      return { success }
    },
  }
}

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
    const res = await app.request('/api/bills/bulk-dismiss', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ billIds: ['some-id'] }),
    }, demoEnv)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual(LOCKED_BODY)
  })

  it('lets a visitor post a comment — the demo working, not vandalism', async () => {
    const res = await app.request('/api/bills/some-id/comments', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '<p>hi</p>' }),
    }, demoEnv)
    expect(res.status).not.toBe(403)
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

  it('rejects a non-modules key on the allowlisted config route', async () => {
    // association_name (not the brief's camelCase associationName, which isn't
    // a real ALLOWED_CONFIG_KEYS entry and would 400 on the unknown-key check
    // before ever reaching the demo lock) is a real allowed key.
    const res = await app.request('/api/admin/config', {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ association_name: 'Hacked' }),
    }, demoEnv)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Configuration is locked in demo mode' })
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

  it('keeps the guard demo-only: a denied route is normal on a real tenant', async () => {
    // 403 on a demo tenant, but on a real tenant this reaches the route's own
    // auth/handler. Anything but the read-only body proves the guard is off.
    const res = await app.request('/api/bills/bulk-dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ billIds: ['some-id'] }),
    }, env)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Not authenticated' })
  })
})

// Demo auto-login hands any caller a valid session with no interaction, so every
// allowed demo write is effectively anonymous. The guard is the single choke
// point they all pass through, so the per-connection limit lives there.
describe('demo write rate limit', () => {
  let cookie: string
  const demoEnv = { ...env, DEMO_MODE: 'true' }
  const allowEnv = { ...demoEnv, DEMO_WRITE_RATE_LIMITER: fakeLimiter(true) }
  const denyEnv = { ...demoEnv, DEMO_WRITE_RATE_LIMITER: fakeLimiter(false) }

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const userId = await seedUser({ role: 'owner' })
    cookie = `session=${await seedSession(userId)}`
  })

  const postComment = (testEnv: unknown, headers: Record<string, string> = {}) =>
    app.request('/api/bills/some-id/comments', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ content: '<p>hi</p>' }),
    }, testEnv as typeof env)

  it('passes an allowed demo write through when the limiter allows', async () => {
    const res = await postComment(allowEnv)
    expect(res.status).not.toBe(429)
  })

  it('refuses the same write with 429 when the limiter denies', async () => {
    const res = await postComment(denyEnv)
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual(THROTTLED_BODY)
  })

  it('carries a body distinct from the lock, so a visitor can tell them apart', async () => {
    const res = await postComment(denyEnv)
    expect((await res.json() as { error: string }).error).not.toBe(LOCKED_BODY.error)
  })

  it('keys per-IP: every visitor shares one demo-user identity, so IP is the only signal', async () => {
    const keys: string[] = []
    const spyEnv = { ...demoEnv, DEMO_WRITE_RATE_LIMITER: fakeLimiter(true, k => keys.push(k)) }
    await postComment(spyEnv, { 'CF-Connecting-IP': '1.2.3.4' })
    expect(keys).toEqual(['demo-write:1.2.3.4'])
  })

  it('never rate-limits a GET, even when the limiter would deny', async () => {
    // Reads are not the abuse surface, and throttling them would break the
    // shared link for everyone behind one NAT.
    const res = await app.request('/api/config', { headers: { Cookie: cookie } }, denyEnv)
    expect(res.status).toBe(200)
  })

  it('leaves HEAD/OPTIONS alone so CORS preflight survives a denying limiter', async () => {
    const res = await app.request('/api/config', { method: 'OPTIONS' }, denyEnv)
    expect(res.status).not.toBe(429)
  })

  it('keeps the lock ahead of the limiter: a denied route is 403, never 429', async () => {
    // A limiter that denies must not turn a locked route into a 429 and tell a
    // visitor to "try again shortly" for something that will never be allowed.
    const res = await app.request('/api/bills/bulk-dismiss', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ billIds: ['some-id'] }),
    }, denyEnv)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual(LOCKED_BODY)
  })

  it('fails open with no binding — demo writes behave exactly as before', async () => {
    const res = await postComment(demoEnv)
    expect(res.status).not.toBe(429)
  })

  it('leaves a real tenant unaffected even when the limiter would deny', async () => {
    const realEnv = { ...env, DEMO_WRITE_RATE_LIMITER: fakeLimiter(false) }
    const res = await postComment(realEnv)
    expect(res.status).not.toBe(429)
  })
})

// Every non-GET route under /api/ must appear in exactly one of two explicit
// lists. DEMO_WRITE_ALLOWLIST lives in the middleware (it is runtime data);
// DENIED lives here (it is a human classification, not something the server
// needs). A route added in either direction fails this test until somebody
// classifies it, so neither failure mode — a dead additive route, a live
// destructive one — can ship silently.
const DENIED = new Set([
  'DELETE /api/admin/custom-fields/:id',
  'DELETE /api/admin/members/:id',
  'DELETE /api/admin/roles/:id',
  'DELETE /api/bills/:id',
  'DELETE /api/calendar/events/:id',
  'DELETE /api/comments/:id',
  'DELETE /api/users/me',
  'PATCH /api/admin/members/:id',
  'PATCH /api/admin/roles/:id',
  'PATCH /api/bills/:id/draft',
  'PATCH /api/users/me',
  'POST /api/admin/apply-preset/:slug',
  'POST /api/admin/clear-interactions',
  'POST /api/admin/custom-fields',
  'POST /api/admin/keyword-resync',
  'POST /api/admin/keyword-resync-preview',
  'POST /api/admin/members/:id/resend-invite',
  'POST /api/admin/members/:id/resend-login',
  'POST /api/admin/members/bulk-invite',
  'POST /api/admin/promote-bill/:billId',
  'POST /api/admin/refresh-metadata',
  'POST /api/admin/register-with-central',
  'POST /api/admin/reprocess-bill/:externalId',
  'POST /api/admin/reprocess-llm-all',
  'POST /api/admin/roles',
  'POST /api/auth/logout',
  'POST /api/auth/magic-link',
  'POST /api/auth/verify',
  'POST /api/bills/:id/link',
  'POST /api/bills/bulk',
  'POST /api/bills/bulk-dismiss',
  'POST /api/bills/draft',
  'POST /api/calendar/backfill',
  'POST /api/calendar/events',
  'POST /api/calendar/events/:id/restore',
  'POST /api/calendar/import',
  'POST /api/calendar/regenerate-slug',
  'POST /api/feedback',
  'POST /api/users/me/deactivate',
  'PUT /api/admin/custom-fields/:id',
  'PUT /api/admin/custom-fields/reorder',
  'PUT /api/admin/deletion-policy',
  'PUT /api/admin/members/:id/roles',
  'PUT /api/calendar/events/:id',
])

const registered = () => {
  const keys = app.routes
    .filter(r => r.method !== 'GET' && r.method !== 'ALL' && r.path.startsWith('/api/'))
    .map(r => `${r.method} ${r.path}`)
  return [...new Set(keys)].sort()
}

// Substitute a concrete value for every :param so the path can be requested.
const concrete = (path: string) => path.replace(/:[A-Za-z0-9_]+/g, 'x')

describe('demo write categorisation', () => {
  let cookie: string
  const demoEnv = { ...env, DEMO_MODE: 'true' }

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const userId = await seedUser({ role: 'owner' })
    cookie = `session=${await seedSession(userId)}`
  })

  it('classifies every registered non-GET API route exactly once', () => {
    const internal = (k: string) => k.startsWith('POST /api/internal/')
    const uncategorised = registered().filter(
      k => !DEMO_WRITE_ALLOWLIST.has(k) && !DENIED.has(k) && !internal(k),
    )
    expect(uncategorised).toEqual([])

    const overlap = [...DENIED].filter(k => DEMO_WRITE_ALLOWLIST.has(k))
    expect(overlap).toEqual([])
  })

  it('carries no stale entry in either list', () => {
    const live = new Set(registered())
    expect([...DEMO_WRITE_ALLOWLIST].filter(k => !live.has(k))).toEqual([])
    expect([...DENIED].filter(k => !live.has(k))).toEqual([])
  })

  it('pins the size of each category so a silent shift is visible', () => {
    expect(DEMO_WRITE_ALLOWLIST.size).toBe(18)
    expect(DENIED.size).toBe(44)
    expect(registered().length).toBe(68)
  })

  it('refuses every denied route with the read-only message', async () => {
    for (const key of DENIED) {
      const [method, path] = key.split(' ')
      const res = await app.request(concrete(path), {
        method,
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: '{}',
      }, demoEnv)
      expect(res.status, `${key} should be 403`).toBe(403)
      expect(await res.json(), `${key} should carry the read-only body`).toEqual(LOCKED_BODY)
    }
  })

  it('lets every allowed route past the guard', async () => {
    for (const key of DEMO_WRITE_ALLOWLIST) {
      const [method, path] = key.split(' ')
      const res = await app.request(concrete(path), {
        method,
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: '{}',
      }, demoEnv)
      // Assert on the body, not the status: a handler may legitimately 403 for
      // its own reasons (canVote, ownership). What must never appear past the
      // guard is the guard's own message.
      const body = await res.json().catch(() => ({})) as { error?: string }
      expect(body.error, `${key} must not be refused by the demo guard`).not.toBe(LOCKED_BODY.error)
    }
  })
})
