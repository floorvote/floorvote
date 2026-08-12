import { env, SELF } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { app } from '../../src/index'
import { resetDb, applyMigrations, seedUser, seedSession, seedMagicLink } from '../helpers'
import { getDb } from '../../src/db/client'
import { users, authEvents, sessions } from '../../src/db/schema'
import { eq } from 'drizzle-orm'
import { signSuperadminJwt } from '../../../shared/superadminJwt'
import { _resetSuperadminAllowlistCache } from '../../src/lib/superadminCentral'

// Throwaway ES256 test keypair (no production value); its public half is set as
// SUPERADMIN_JWT_PUBLIC_KEY in vitest.config.mts so signed tokens verify in tests.
const TEST_SUPERADMIN_PRIV = '{"key_ops":["sign"],"ext":true,"kty":"EC","x":"jMeKJ1Tf0sgE37Rzg02ARwUKvJ2hF6Zy2gI3mluSjpg","y":"vJ0-S0RvpYh3Z87ti61CrBjprBhpmiA4WujS6_Yb_lQ","crv":"P-256","d":"goMnWG7NT0ErjBM6BH8a_rf1hUjMvLB3o3h4f5sE-aY"}'

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Minimal CENTRAL mock. Tenants now fetch the superadmin allowlist as hashes
// (`/superadmin/emails`, cached locally) instead of an RPC per
// email; the legacy per-email `check` is also served for completeness. The mint
// route is gone — if verify ever calls it (a regression of the H2 fix), this
// mock throws so the test fails loudly.
function centralMockFor(opts: { superadminEmails?: string[] }): { fetch: (req: Request) => Promise<Response> } {
  const allow = (opts.superadminEmails ?? []).map((e) => e.toLowerCase().trim())
  return {
    fetch: async (req: Request) => {
      const url = new URL(req.url)
      if (url.pathname === '/api/admin/superadmin/emails') {
        const hashes = await Promise.all(allow.map(sha256Hex))
        return new Response(JSON.stringify({ hashes }), { status: 200 })
      }
      if (url.pathname === '/api/admin/superadmin/check') {
        const email = (url.searchParams.get('email') ?? '').toLowerCase().trim()
        return new Response(JSON.stringify({ isSuperadmin: allow.includes(email) }), { status: 200 })
      }
      if (url.pathname === '/api/admin/superadmin/mint') {
        throw new Error('tenant called the central mint route — H2 regression: tenants must not mint')
      }
      return new Response('not found', { status: 404 })
    },
  }
}

beforeEach(async () => {
  await resetDb()
  await applyMigrations()
  // In-isolate superadmin allowlist cache (D3) persists across tests in the same
  // isolate — reset it so each test's centralMockFor allowlist is honored.
  _resetSuperadminAllowlistCache()
})

describe('POST /auth/magic-link — body size limit (D5)', () => {
  it('rejects an oversized request body with 413', async () => {
    const huge = JSON.stringify({ email: 'member@example.com', pad: 'x'.repeat(64 * 1024) })
    const res = await app.request(
      '/api/auth/magic-link',
      { method: 'POST', body: huge, headers: { 'Content-Type': 'application/json' } },
      env,
    )
    expect(res.status).toBe(413)
  })

  it('accepts a normal-sized body', async () => {
    await seedUser({ email: 'member@example.com' })
    const res = await app.request(
      '/api/auth/magic-link',
      { method: 'POST', body: JSON.stringify({ email: 'member@example.com' }), headers: { 'Content-Type': 'application/json' } },
      env,
    )
    expect(res.status).toBe(200)
  })
})

describe('POST /auth/magic-link — rate limit + Turnstile gates', () => {
  const blockingLimiter = { limit: async () => ({ success: false }) }

  it('returns 429 when the per-IP rate limiter is exceeded', async () => {
    await seedUser({ email: 'member@example.com' })
    const res = await app.request(
      '/api/auth/magic-link',
      { method: 'POST', body: JSON.stringify({ email: 'member@example.com' }), headers: { 'Content-Type': 'application/json' } },
      { ...env, LOGIN_RATE_LIMITER: blockingLimiter },
    )
    expect(res.status).toBe(429)
  })

  it('returns 403 when Turnstile is configured but no token is sent (fail-closed)', async () => {
    await seedUser({ email: 'member@example.com' })
    const res = await app.request(
      '/api/auth/magic-link',
      { method: 'POST', body: JSON.stringify({ email: 'member@example.com' }), headers: { 'Content-Type': 'application/json' } },
      { ...env, TURNSTILE_SECRET_KEY: 'test-secret' },
    )
    expect(res.status).toBe(403)
  })

  it('is unaffected when neither gate is configured (fail-open default)', async () => {
    await seedUser({ email: 'member@example.com' })
    const res = await app.request(
      '/api/auth/magic-link',
      { method: 'POST', body: JSON.stringify({ email: 'member@example.com' }), headers: { 'Content-Type': 'application/json' } },
      env,
    )
    expect(res.status).toBe(200)
  })
})

describe('POST /auth/magic-link', () => {
  it('returns 200 for a known email', async () => {
    await seedUser({ email: 'member@example.com' })

    const res = await app.request(
      '/api/auth/magic-link',
      {
        method: 'POST',
        body: JSON.stringify({ email: 'member@example.com' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env,
    )
    expect(res.status).toBe(200)
    const json = await res.json() as { message: string }
    expect(json.message).toBe('Check your email for a sign-in link.')
  })

  it('returns 200 for an unknown email (no account disclosure)', async () => {
    const testEnv = { ...env, CENTRAL: centralMockFor({ superadminEmails: [] }) } as unknown as typeof env
    const res = await app.request(
      '/api/auth/magic-link',
      {
        method: 'POST',
        body: JSON.stringify({ email: 'nobody@example.com' }),
        headers: { 'Content-Type': 'application/json' },
      },
      testEnv,
    )
    expect(res.status).toBe(200)
    const json = await res.json() as { message: string }
    expect(json.message).toBe('Check your email for a sign-in link.')
  })

  it('records a link_requested_unknown auth event for unregistered emails', async () => {
    const testEnv = { ...env, CENTRAL: centralMockFor({ superadminEmails: [] }) } as unknown as typeof env
    await app.request(
      '/api/auth/magic-link',
      {
        method: 'POST',
        body: JSON.stringify({ email: 'stranger@example.com' }),
        headers: { 'Content-Type': 'application/json' },
      },
      testEnv,
    )
    const db = getDb(env.DB)
    const events = await db.select().from(authEvents).where(eq(authEvents.event, 'link_requested_unknown')).all()
    expect(events).toHaveLength(1)
    expect(events[0].email).toBe('stranger@example.com')
    expect(events[0].userId).toBeNull()
    expect(events[0].linkType).toBe('login')
  })

  it('returns 400 for a missing email', async () => {
    const res = await app.request(
      '/api/auth/magic-link',
      {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'Content-Type': 'application/json' },
      },
      env,
    )
    expect(res.status).toBe(400)
  })
})

describe('GET /auth/verify', () => {
  it('redirects to /auth/verify?token=<token> for any non-empty token', async () => {
    const userId = await seedUser({ email: 'getverify@example.com' })
    const rawToken = await seedMagicLink(userId)

    const res = await app.request(`/api/auth/verify?token=${encodeURIComponent(rawToken)}`, {}, env)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`http://localhost:5173/auth/verify?token=${encodeURIComponent(rawToken)}`)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('redirects to /auth/verify?token=<token> even for an expired token (no DB check)', async () => {
    const userId = await seedUser({ email: 'getexpired@example.com' })
    const rawToken = await seedMagicLink(userId, { expired: true })

    const res = await app.request(`/api/auth/verify?token=${encodeURIComponent(rawToken)}`, {}, env)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`http://localhost:5173/auth/verify?token=${encodeURIComponent(rawToken)}`)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('returns 400 when token param is missing', async () => {
    const res = await app.request('/api/auth/verify', {}, env)
    expect(res.status).toBe(400)
  })
})

describe('GET /auth/me', () => {
  it('returns the current user for a valid session', async () => {
    const userId = await seedUser({ email: 'me@example.com', name: 'Test User' })
    const rawToken = await seedSession(userId)

    const res = await app.request(
      '/api/auth/me',
      { headers: { Cookie: `session=${rawToken}` } },
      env,
    )
    expect(res.status).toBe(200)
    const json = await res.json() as { id: string; email: string; role: string }
    expect(json.email).toBe('me@example.com')
    expect(json.id).toBe(userId)
  })

  it('returns 401 with no cookie', async () => {
    const res = await app.request('/api/auth/me', {}, env)
    expect(res.status).toBe(401)
  })

  it('returns 401 for an expired session', async () => {
    const userId = await seedUser({ email: 'expired-session@example.com' })
    const db = (await import('../../src/db/client')).getDb(env.DB)
    const { generateToken, hashToken } = await import('../../src/lib/crypto')
    const { sessions } = await import('../../src/db/schema')

    const rawToken = await generateToken()
    const tokenHash = await hashToken(rawToken)
    const expiresAt = new Date(Date.now() - 1000).toISOString()
    await db.insert(sessions).values({
      id: crypto.randomUUID(),
      userId,
      tokenHash,
      expiresAt,
    })

    const res = await app.request(
      '/api/auth/me',
      { headers: { Cookie: `session=${rawToken}` } },
      env,
    )
    expect(res.status).toBe(401)
  })

  it('includes lastSeenFeed (null when never visited Pulse)', async () => {
    const memberId = await seedUser({ name: 'Eve' })
    const token = await seedSession(memberId)
    const res = await SELF.fetch('http://localhost/api/auth/me', {
      headers: { Cookie: `session=${token}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect('lastSeenFeed' in body).toBe(true)
    expect(body.lastSeenFeed).toBeNull()
  })

  it('updates users.lastActive on each call', async () => {
    const db = getDb(env.DB)
    const userId = await seedUser({ email: 'lastactive@example.com' })
    const rawToken = await seedSession(userId)

    // Force lastActive to a known old value so we can detect the update
    const oldDate = '2020-01-01T00:00:00.000Z'
    await db.update(users).set({ lastActive: oldDate }).where(eq(users.id, userId))

    await app.request('/api/auth/me', { headers: { Cookie: `session=${rawToken}` } }, env)

    const row = await db.select({ lastActive: users.lastActive }).from(users).where(eq(users.id, userId)).get()
    expect(row!.lastActive).not.toBe(oldDate)
  })

  it('returns isLastOwner: true for the sole active owner', async () => {
    const userId = await seedUser({ email: 'sole-owner@example.com', role: 'owner' })
    const rawToken = await seedSession(userId)

    const res = await app.request('/api/auth/me', { headers: { Cookie: `session=${rawToken}` } }, env)
    expect(res.status).toBe(200)
    const json = await res.json() as { isLastOwner: boolean }
    expect(json.isLastOwner).toBe(true)
  })

  it('returns isLastOwner: false for an owner when a second active owner exists', async () => {
    const userId = await seedUser({ email: 'owner-1@example.com', role: 'owner' })
    await seedUser({ email: 'owner-2@example.com', role: 'owner' })
    const rawToken = await seedSession(userId)

    const res = await app.request('/api/auth/me', { headers: { Cookie: `session=${rawToken}` } }, env)
    expect(res.status).toBe(200)
    const json = await res.json() as { isLastOwner: boolean }
    expect(json.isLastOwner).toBe(false)
  })

  it('returns isLastOwner: false for an admin', async () => {
    const userId = await seedUser({ email: 'admin@example.com', role: 'admin' })
    const rawToken = await seedSession(userId)

    const res = await app.request('/api/auth/me', { headers: { Cookie: `session=${rawToken}` } }, env)
    expect(res.status).toBe(200)
    const json = await res.json() as { isLastOwner: boolean }
    expect(json.isLastOwner).toBe(false)
  })
})

describe('POST /auth/verify', () => {
  it('returns 200 and sets session cookie for a valid token', async () => {
    const userId = await seedUser({ email: 'postverify@example.com' })
    const rawToken = await seedMagicLink(userId)

    const res = await app.request(
      '/api/auth/verify',
      {
        method: 'POST',
        body: JSON.stringify({ token: rawToken }),
        headers: { 'Content-Type': 'application/json' },
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
    const setCookie = res.headers.get('set-cookie')
    expect(setCookie).toContain('session=')
    expect(setCookie).toContain('HttpOnly')
  })

  it('returns 400 with error: token is required when token is missing', async () => {
    const res = await app.request(
      '/api/auth/verify',
      {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'Content-Type': 'application/json' },
      },
      env,
    )
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('token is required')
  })

  it('returns 400 with error: invalid for an unknown token', async () => {
    const res = await app.request(
      '/api/auth/verify',
      {
        method: 'POST',
        body: JSON.stringify({ token: 'totally-fake-token-abc123' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env,
    )
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('invalid')
  })

  it('returns 400 with error: used for an already-used token', async () => {
    const userId = await seedUser({ email: 'postused@example.com' })
    const rawToken = await seedMagicLink(userId, { used: true })

    const res = await app.request(
      '/api/auth/verify',
      {
        method: 'POST',
        body: JSON.stringify({ token: rawToken }),
        headers: { 'Content-Type': 'application/json' },
      },
      env,
    )
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('used')
  })

  it('returns 400 with error: expired for an expired token', async () => {
    const userId = await seedUser({ email: 'postexpired@example.com' })
    const rawToken = await seedMagicLink(userId, { expired: true })

    const res = await app.request(
      '/api/auth/verify',
      {
        method: 'POST',
        body: JSON.stringify({ token: rawToken }),
        headers: { 'Content-Type': 'application/json' },
      },
      env,
    )
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('expired')
  })

  it('accepts a valid token whose expires_at is stored in space format', async () => {
    const userId = await seedUser({ email: 'spaceformat@example.com' })
    const { generateToken, hashToken } = await import('../../src/lib/crypto')
    const { magicLinks } = await import('../../src/db/schema')
    const db = getDb(env.DB)
    const rawToken = await generateToken()
    // Space-format expiry ~10 min in the future, SAME calendar day as `now`.
    // A raw string compare against an ISO `now` ("YYYY-MM-DDTHH...Z") shares the
    // date prefix, so it decides at the date/time separator where " " (0x20) <
    // "T" (0x54) — wrongly ordering this future expiry BELOW now → reject.
    const future = new Date(Date.now() + 10 * 60 * 1000)
      .toISOString().slice(0, 19).replace('T', ' ')
    await db.insert(magicLinks).values({
      id: crypto.randomUUID(),
      userId,
      tokenHash: await hashToken(rawToken),
      expiresAt: future,
    })
    const res = await app.request(
      '/api/auth/verify',
      { method: 'POST', body: JSON.stringify({ token: rawToken }), headers: { 'Content-Type': 'application/json' } },
      env,
    )
    expect(res.status).toBe(200)
    expect((await res.json() as { ok: boolean }).ok).toBe(true)
  })

  it('rejects an expired token whose expires_at is stored in space format', async () => {
    const userId = await seedUser({ email: 'spaceexpired@example.com' })
    const { generateToken, hashToken } = await import('../../src/lib/crypto')
    const { magicLinks } = await import('../../src/db/schema')
    const db = getDb(env.DB)
    const rawToken = await generateToken()
    await db.insert(magicLinks).values({
      id: crypto.randomUUID(),
      userId,
      tokenHash: await hashToken(rawToken),
      expiresAt: '2000-01-01 00:00:00',
    })
    const res = await app.request(
      '/api/auth/verify',
      { method: 'POST', body: JSON.stringify({ token: rawToken }), headers: { 'Content-Type': 'application/json' } },
      env,
    )
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toBe('expired')
  })
})

describe('POST /auth/magic-link — superadmin auto-provisioning', () => {
  it('auto-creates an admin user row for a superadmin email with no existing account', async () => {
    const db = getDb(env.DB)
    expect(await db.select().from(users).where(eq(users.email, 'super@example.com')).get()).toBeUndefined()

    const testEnv = { ...env, CENTRAL: centralMockFor({ superadminEmails: ['super@example.com'] }) } as unknown as typeof env
    const res = await app.request(
      '/api/auth/magic-link',
      {
        method: 'POST',
        body: JSON.stringify({ email: 'super@example.com' }),
        headers: { 'Content-Type': 'application/json' },
      },
      testEnv,
    )
    expect(res.status).toBe(200)
    expect((await res.json() as { message: string }).message).toBe('Check your email for a sign-in link.')

    const created = await db.select().from(users).where(eq(users.email, 'super@example.com')).get()
    expect(created).toBeDefined()
    expect(created!.role).toBe('admin')
  })

  it('does NOT create a user row for an unknown non-superadmin email', async () => {
    const db = getDb(env.DB)
    const testEnv = { ...env, CENTRAL: centralMockFor({ superadminEmails: [] }) } as unknown as typeof env
    await app.request(
      '/api/auth/magic-link',
      {
        method: 'POST',
        body: JSON.stringify({ email: 'stranger@example.com' }),
        headers: { 'Content-Type': 'application/json' },
      },
      testEnv,
    )
    expect(await db.select().from(users).where(eq(users.email, 'stranger@example.com')).get()).toBeUndefined()
  })
})

describe('POST /auth/logout', () => {
  it('clears the session cookie and returns 200', async () => {
    const userId = await seedUser({ email: 'logout@example.com' })
    const rawToken = await seedSession(userId)

    const res = await app.request(
      '/api/auth/logout',
      {
        method: 'POST',
        headers: { Cookie: `session=${rawToken}` },
      },
      env,
    )
    expect(res.status).toBe(200)
    const setCookie = res.headers.get('set-cookie')
    expect(setCookie).toContain('session=;')
  })
})

describe('POST /auth/verify — tenant no longer mints superadmin_jwt (H2 fix)', () => {
  // Central is the SOLE issuer of the cross-tenant superadmin cookie; it sets it
  // on dashboard login. Tenants must NOT mint or set it on their own verify, even
  // for a superadmin email — that's exactly the escalation H2 closes.
  it('does NOT set a superadmin_jwt cookie even for a superadmin user', async () => {
    const userId = await seedUser({ email: 'super@example.com', role: 'admin' })
    const rawToken = await seedMagicLink(userId)
    // isSuperadmin:true so the (gone) mint path would have fired; the mock throws
    // if verify calls mint at all.
    const testEnv = { ...env, CENTRAL: centralMockFor({ superadminEmails: ['super@example.com'] }) } as unknown as typeof env

    const res = await app.request(
      '/api/auth/verify',
      {
        method: 'POST',
        body: JSON.stringify({ token: rawToken }),
        headers: { 'Content-Type': 'application/json' },
      },
      testEnv,
    )
    expect(res.status).toBe(200)
    // A normal local session is still issued...
    expect(res.headers.get('set-cookie') ?? '').toContain('session=')
    // ...but never the cross-tenant superadmin cookie.
    expect(res.headers.get('set-cookie') ?? '').not.toContain('superadmin_jwt=')
  })

  it('does NOT set a superadmin_jwt cookie for a regular user', async () => {
    const userId = await seedUser({ email: 'regular@example.com' })
    const rawToken = await seedMagicLink(userId)
    const testEnv = { ...env, CENTRAL: centralMockFor({ superadminEmails: [] }) } as unknown as typeof env

    const res = await app.request(
      '/api/auth/verify',
      {
        method: 'POST',
        body: JSON.stringify({ token: rawToken }),
        headers: { 'Content-Type': 'application/json' },
      },
      testEnv,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie') ?? '').not.toContain('superadmin_jwt=')
  })
})

describe('POST /auth/logout — superadmin JWT cookie cleared', () => {
  it('clears the superadmin_jwt cookie', async () => {
    const userId = await seedUser({ email: 'logout-super@example.com' })
    const rawToken = await seedSession(userId)

    const res = await app.request(
      '/api/auth/logout',
      { method: 'POST', headers: { Cookie: `session=${rawToken}` } },
      env,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie') ?? '').toContain('superadmin_jwt=;')
  })
})

describe('GET /auth/me — superadmin JWT fallback', () => {
  it('authenticates via JWT cookie with no session cookie, auto-provisioning user in local D1', async () => {
    const jwtToken = await signSuperadminJwt('super@example.com', 'Super Admin', TEST_SUPERADMIN_PRIV)

    const res = await app.request(
      '/api/auth/me',
      { headers: { Cookie: `superadmin_jwt=${jwtToken}` } },
      env,
    )
    expect(res.status).toBe(200)
    const json = await res.json() as { email: string; role: string }
    expect(json.email).toBe('super@example.com')
    expect(json.role).toBe('admin')
    expect(res.headers.get('set-cookie')).toContain('session=')
  })

  it('returns 401 for an invalid JWT', async () => {
    const res = await app.request(
      '/api/auth/me',
      { headers: { Cookie: 'superadmin_jwt=invalid.jwt.token' } },
      env,
    )
    expect(res.status).toBe(401)
  })

  it('reuses an existing user row if the superadmin was already provisioned in this tenant', async () => {
    const userId = await seedUser({ email: 'super@example.com', role: 'admin', name: 'Existing Name' })
    const jwtToken = await signSuperadminJwt('super@example.com', 'JWT Name', TEST_SUPERADMIN_PRIV)

    const res = await app.request(
      '/api/auth/me',
      { headers: { Cookie: `superadmin_jwt=${jwtToken}` } },
      env,
    )
    expect(res.status).toBe(200)
    const json = await res.json() as { id: string; name: string }
    expect(json.id).toBe(userId)
    expect(json.name).toBe('Existing Name')
  })
})

describe('auth event logging — verify', () => {
  beforeEach(async () => { await resetDb(); await applyMigrations() })

  it('records verify_success', async () => {
    const db = getDb(env.DB)
    const uid = await seedUser({ email: 'v@b.com' })
    const raw = await seedMagicLink(uid, { used: false })
    const res = await SELF.fetch('http://localhost/api/auth/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: raw }),
    })
    expect(res.status).toBe(200)
    const rows = await db.select().from(authEvents).all()
    expect(rows.some(r => r.event === 'verify_success' && r.userId === uid)).toBe(true)
  })

  it('records verify_failed with reason=expired', async () => {
    const db = getDb(env.DB)
    const uid = await seedUser({ email: 'exp@b.com' })
    const raw = await seedMagicLink(uid, { expired: true })
    const res = await SELF.fetch('http://localhost/api/auth/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: raw }),
    })
    expect(res.status).toBe(400)
    const rows = await db.select().from(authEvents).all()
    expect(rows.some(r => r.event === 'verify_failed' && r.reason === 'expired')).toBe(true)
  })

  it('records verify_failed with reason=used', async () => {
    const db = getDb(env.DB)
    const uid = await seedUser({ email: 'used@b.com' })
    const raw = await seedMagicLink(uid, { used: true })
    const res = await SELF.fetch('http://localhost/api/auth/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: raw }),
    })
    expect(res.status).toBe(400)
    const rows = await db.select().from(authEvents).all()
    expect(rows.some(r => r.event === 'verify_failed' && r.reason === 'used')).toBe(true)
  })
})

describe('auth event logging — magic-link request', () => {
  beforeEach(async () => { await resetDb(); await applyMigrations() })

  it('records link_requested for a known user', async () => {
    const db = getDb(env.DB)
    const uid = await seedUser({ email: 'known@b.com' })
    const res = await SELF.fetch('http://localhost/api/auth/magic-link', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'known@b.com' }),
    })
    expect(res.status).toBe(200)
    const rows = await db.select().from(authEvents).all()
    const requested = rows.find(r => r.event === 'link_requested')
    expect(requested?.email).toBe('known@b.com')
    expect(requested?.userId).toBe(uid)
    expect(requested?.linkType).toBe('login')
  })

  it('records rate_limited when the active-link cap is hit', async () => {
    const db = getDb(env.DB)
    const uid = await seedUser({ email: 'spammy@b.com' })
    for (let i = 0; i < 6; i++) {
      await SELF.fetch('http://localhost/api/auth/magic-link', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'spammy@b.com' }),
      })
    }
    const rows = await db.select().from(authEvents).where(eq(authEvents.userId, uid)).all()
    expect(rows.some(r => r.event === 'rate_limited')).toBe(true)
  })
})

describe('auth event logging — logout', () => {
  beforeEach(async () => { await resetDb(); await applyMigrations() })

  it('records logout for the session owner', async () => {
    const db = getDb(env.DB)
    const uid = await seedUser({ email: 'out@b.com' })
    const token = await seedSession(uid)
    const res = await SELF.fetch('http://localhost/api/auth/logout', {
      method: 'POST', headers: { Cookie: `session=${token}` },
    })
    expect(res.status).toBe(200)
    const rows = await db.select().from(authEvents).all()
    expect(rows.some(r => r.event === 'logout' && r.userId === uid)).toBe(true)
  })
})

describe('GET /auth/demo-mode — login bootstrap (Turnstile sitekey)', () => {
  it('returns an empty sitekey when TURNSTILE_SITE_KEY is unset (fail-open)', async () => {
    const res = await app.request('/api/auth/demo-mode', {}, env)
    expect(res.status).toBe(200)
    const body = await res.json<{ demoMode: boolean; turnstileSiteKey: string }>()
    expect(body.turnstileSiteKey).toBe('')
  })

  it('serves the configured sitekey when TURNSTILE_SITE_KEY is set', async () => {
    const res = await app.request('/api/auth/demo-mode', {}, { ...env, TURNSTILE_SITE_KEY: '0xABC123' })
    expect(res.status).toBe(200)
    const body = await res.json<{ demoMode: boolean; turnstileSiteKey: string }>()
    expect(body.turnstileSiteKey).toBe('0xABC123')
  })
})

describe('POST /auth/demo-login', () => {
  const demoEnv = { ...env, DEMO_MODE: 'true' }

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    // seedUser can't set the id, and the route looks up the fixed 'demo-user'.
    await getDb(env.DB).insert(users).values({
      id: 'demo-user',
      email: 'demo@example.com',
      name: 'Demo User',
      role: 'member',
      canVote: 1,
      emailDigestEnabled: 1,
    })
  })

  const tokenFrom = (res: Response) =>
    /session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1]

  const demoLogin = () => app.request('/api/auth/demo-login', { method: 'POST' }, demoEnv)

  it('reuses the one shared demo session instead of minting a row per call', async () => {
    // This endpoint is on the visitor entry path (web/src/pages/Login.tsx
    // auto-posts it), so a row per call is unbounded growth from bot traffic —
    // the same amplification ensureDemoSession was written to stop.
    const first = await demoLogin()
    const second = await demoLogin()
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)

    const t1 = tokenFrom(first)
    expect(t1).toBeTruthy()
    expect(tokenFrom(second)).toBe(t1)

    const rows = await getDb(env.DB).select().from(sessions).where(eq(sessions.userId, 'demo-user')).all()
    expect(rows).toHaveLength(1)
  })

  it('hands out a cookie that actually authenticates', async () => {
    const res = await demoLogin()
    const authed = await app.request('/api/config', {
      headers: { Cookie: `session=${tokenFrom(res)}` },
    }, demoEnv)
    expect(authed.status).toBe(200)
  })

  it('stays 404 when DEMO_MODE is unset', async () => {
    const res = await app.request('/api/auth/demo-login', { method: 'POST' }, env)
    expect(res.status).toBe(404)
  })
})
