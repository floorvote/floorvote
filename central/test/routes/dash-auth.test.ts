import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from '../../src/db/schema-legiscan'
import { app } from '../../src/index-legiscan'
import { setupLsDb } from '../helpers/setupLsDb'
import { hashToken } from '../../src/lib/adminAuth'
import { signSuperadminJwt, verifySuperadminJwt } from '../../src/lib/superadminJwt'
import { revokeSuperadminJti } from '../../src/lib/superadminRevocation'

async function genKeys(): Promise<{ priv: string; pub: string }> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  return {
    priv: JSON.stringify(await crypto.subtle.exportKey('jwk', (kp as CryptoKeyPair).privateKey)),
    pub: JSON.stringify(await crypto.subtle.exportKey('jwk', (kp as CryptoKeyPair).publicKey)),
  }
}

const keys = await genKeys()

const TEST_ENV: any = {
  ...env,
  SUPERADMIN_JWT_PUBLIC_KEY: keys.pub,
  SUPERADMIN_EMAILS: 'admin@example.com',
  ADMIN_APP_URL: 'https://admin.test',
  RESEND_API_KEY: 'rk_test',
  ADMIN_SECRET: 'admin-secret',
}

beforeEach(async () => {
  await setupLsDb()
  vi.restoreAllMocks()
})

describe('GET /admin/dash/auth/me', () => {
  it('returns 401 with no auth', async () => {
    const res = await app.fetch(new Request('http://central/admin/dash/auth/me'), TEST_ENV)
    expect(res.status).toBe(401)
  })

  it('mints a session and returns identity when superadmin_jwt is valid and email is allowlisted', async () => {
    const jwt = await signSuperadminJwt('admin@example.com', 'Will', keys.priv)
    const res = await app.fetch(
      new Request('http://central/admin/dash/auth/me', { headers: { Cookie: `superadmin_jwt=${jwt}` } }),
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { email: string; name: string } }
    expect(body.data.email).toBe('admin@example.com')
    expect(body.data.name).toBe('Will')
    expect(res.headers.get('Set-Cookie')).toMatch(/admin_session=/)
  })

  it('returns name from session on second call (session cookie reuse)', async () => {
    const db = drizzle(env.DB, { schema })
    // Bootstrap a session with name stored
    const jwt = await signSuperadminJwt('admin@example.com', 'Will', keys.priv)
    const firstRes = await app.fetch(
      new Request('http://central/admin/dash/auth/me', { headers: { Cookie: `superadmin_jwt=${jwt}` } }),
      TEST_ENV,
    )
    expect(firstRes.status).toBe(200)
    const setCookie = firstRes.headers.get('Set-Cookie') ?? ''
    const sessionTokenMatch = setCookie.match(/admin_session=([^;]+)/)
    expect(sessionTokenMatch).not.toBeNull()
    const sessionToken = sessionTokenMatch![1]

    // Second call uses the session cookie — name should come from the session row
    const secondRes = await app.fetch(
      new Request('http://central/admin/dash/auth/me', { headers: { Cookie: `admin_session=${sessionToken}` } }),
      TEST_ENV,
    )
    expect(secondRes.status).toBe(200)
    const body2 = await secondRes.json() as { data: { email: string; name: string } }
    expect(body2.data.name).toBe('Will')
  })

  it('rejects a superadmin_jwt whose jti has been revoked (M3)', async () => {
    const db = drizzle(env.DB, { schema })
    const jwt = await signSuperadminJwt('admin@example.com', 'Will', keys.priv)
    // Sanity: valid before revocation.
    const ok = await app.fetch(
      new Request('http://central/admin/dash/auth/me', { headers: { Cookie: `superadmin_jwt=${jwt}` } }),
      TEST_ENV,
    )
    expect(ok.status).toBe(200)
    // Revoke this token's jti, then a fresh /me with ONLY the same superadmin_jwt
    // (no admin_session) must be rejected.
    const payload = await verifySuperadminJwt(jwt, keys.pub)
    await revokeSuperadminJti(db, payload!.jti, payload!.jti ? 9999999999 : 0)
    const res = await app.fetch(
      new Request('http://central/admin/dash/auth/me', { headers: { Cookie: `superadmin_jwt=${jwt}` } }),
      TEST_ENV,
    )
    expect(res.status).toBe(401)
  })

  it('returns 403 when superadmin_jwt is valid but email is NOT in allowlist', async () => {
    const jwt = await signSuperadminJwt('outsider@example.com', 'Out', keys.priv)
    const res = await app.fetch(
      new Request('http://central/admin/dash/auth/me', { headers: { Cookie: `superadmin_jwt=${jwt}` } }),
      TEST_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('accepts an existing admin_session cookie without re-verifying JWT', async () => {
    const db = drizzle(env.DB, { schema })
    const rawToken = 'a'.repeat(64)
    const tokenHash = await hashToken(rawToken)
    await db.insert(schema.adminSessions).values({
      id: crypto.randomUUID(),
      email: 'admin@example.com',
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const res = await app.fetch(
      new Request('http://central/admin/dash/auth/me', { headers: { Cookie: `admin_session=${rawToken}` } }),
      TEST_ENV,
    )
    expect(res.status).toBe(200)
  })
})

describe('POST /admin/dash/auth/login', () => {
  it('sends a magic link to an allowlisted email and returns 200', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('') } as Response)
    const res = await app.fetch(
      new Request('http://central/admin/dash/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@example.com' }),
      }),
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const db = drizzle(env.DB, { schema })
    const links = await db.select().from(schema.magicLinks).all()
    expect(links.length).toBe(1)
  })

  it('caps active links per address — refuses a 6th without sending or inserting (D4)', async () => {
    const db = drizzle(env.DB, { schema })
    for (let i = 0; i < 5; i++) {
      await db.insert(schema.magicLinks).values({
        id: crypto.randomUUID(),
        email: 'admin@example.com',
        tokenHash: await hashToken(`active-${i}-${'x'.repeat(60)}`),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('') } as Response)
    const res = await app.fetch(
      new Request('http://central/admin/dash/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@example.com' }),
      }),
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    expect(fetchSpy).not.toHaveBeenCalled()
    const links = await db.select().from(schema.magicLinks).all()
    expect(links.length).toBe(5)
  })

  it('does not count expired/used links toward the cap (still sends when none active)', async () => {
    const db = drizzle(env.DB, { schema })
    for (let i = 0; i < 5; i++) {
      await db.insert(schema.magicLinks).values({
        id: crypto.randomUUID(),
        email: 'admin@example.com',
        tokenHash: await hashToken(`expired-${i}-${'y'.repeat(60)}`),
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      })
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('') } as Response)
    const res = await app.fetch(
      new Request('http://central/admin/dash/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@example.com' }),
      }),
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('returns 200 but does NOT send for a non-allowlisted email (no enumeration)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response)
    const res = await app.fetch(
      new Request('http://central/admin/dash/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'outsider@example.com' }),
      }),
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns 429 when the per-IP rate limiter is exceeded', async () => {
    const blockingLimiter = { limit: async () => ({ success: false }) }
    const res = await app.fetch(
      new Request('http://central/admin/dash/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@example.com' }),
      }),
      { ...TEST_ENV, LOGIN_RATE_LIMITER: blockingLimiter },
    )
    expect(res.status).toBe(429)
  })

  it('returns 403 when Turnstile is configured but no token is sent (fail-closed)', async () => {
    const res = await app.fetch(
      new Request('http://central/admin/dash/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@example.com' }),
      }),
      { ...TEST_ENV, TURNSTILE_SECRET_KEY: 'test-secret' },
    )
    expect(res.status).toBe(403)
  })

  it('returns 400 on bad email', async () => {
    const res = await app.fetch(
      new Request('http://central/admin/dash/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'not-an-email' }),
      }),
      TEST_ENV,
    )
    expect(res.status).toBe(400)
  })
})

describe('GET /admin/dash/auth/config', () => {
  it('returns an empty sitekey when TURNSTILE_SITE_KEY is unset (fail-open)', async () => {
    const res = await app.fetch(new Request('http://central/admin/dash/auth/config'), { ...TEST_ENV, TURNSTILE_SITE_KEY: undefined })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { turnstileSiteKey: string } }
    expect(body.data.turnstileSiteKey).toBe('')
  })

  it('serves the configured sitekey when set', async () => {
    const res = await app.fetch(new Request('http://central/admin/dash/auth/config'), { ...TEST_ENV, TURNSTILE_SITE_KEY: '0xABC123' })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { turnstileSiteKey: string } }
    expect(body.data.turnstileSiteKey).toBe('0xABC123')
  })
})

describe('GET /admin/dash/auth/callback — two-step redirect (does not consume)', () => {
  it('redirects to the SPA interstitial without consuming the token', async () => {
    const db = drizzle(env.DB, { schema })
    const rawToken = 'b'.repeat(64)
    const tokenHash = await hashToken(rawToken)
    await db.insert(schema.magicLinks).values({
      id: crypto.randomUUID(),
      email: 'admin@example.com',
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const res = await app.fetch(
      new Request(`http://central/admin/dash/auth/callback?token=${rawToken}`, { redirect: 'manual' }),
      TEST_ENV,
    )
    expect(res.status).toBe(302)
    // Redirects to the interstitial (ADMIN_APP_URL is https://admin.test in TEST_ENV).
    expect(res.headers.get('Location')).toBe(`https://admin.test/auth/verify?token=${rawToken}`)
    // GET must NOT set a session or consume the token — that's the POST's job.
    expect(res.headers.get('Set-Cookie')).toBeNull()
    const link = await db.select().from(schema.magicLinks).where(eq(schema.magicLinks.tokenHash, tokenHash)).get()
    expect(link?.usedAt).toBeNull()
  })

  it('returns 400 when no token is present', async () => {
    const res = await app.fetch(
      new Request('http://central/admin/dash/auth/callback', { redirect: 'manual' }),
      TEST_ENV,
    )
    expect(res.status).toBe(400)
  })
})

describe('POST /admin/dash/auth/callback — consume token', () => {
  function postCallback(rawToken: string | undefined, envOverride: any = TEST_ENV) {
    return app.fetch(
      new Request('http://central/admin/dash/auth/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rawToken === undefined ? {} : { token: rawToken }),
      }),
      envOverride,
    )
  }

  it('mints a session and consumes the token when valid', async () => {
    const db = drizzle(env.DB, { schema })
    const rawToken = 'b'.repeat(64)
    const tokenHash = await hashToken(rawToken)
    await db.insert(schema.magicLinks).values({
      id: crypto.randomUUID(),
      email: 'admin@example.com',
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const res = await postCallback(rawToken)
    expect(res.status).toBe(200)
    expect(res.headers.get('Set-Cookie')).toMatch(/admin_session=/)
    const link = await db.select().from(schema.magicLinks).where(eq(schema.magicLinks.tokenHash, tokenHash)).get()
    expect(link?.usedAt).not.toBeNull()
  })

  it('also sets the cross-tenant superadmin_jwt cookie scoped to the parent domain', async () => {
    const db = drizzle(env.DB, { schema })
    const rawToken = 'f'.repeat(64)
    const tokenHash = await hashToken(rawToken)
    await db.insert(schema.magicLinks).values({
      id: crypto.randomUUID(),
      email: 'admin@example.com',
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const localEnv = { ...TEST_ENV, ADMIN_APP_URL: 'https://admin.example.com', SUPERADMIN_JWT_PRIVATE_KEY: keys.priv }
    const res = await postCallback(rawToken, localEnv)
    expect(res.status).toBe(200)
    // Headers.get concatenates multiple Set-Cookie with ", " — assert against the joined value.
    const setCookie = res.headers.get('Set-Cookie') ?? ''
    expect(setCookie).toMatch(/admin_session=/)
    expect(setCookie).toMatch(/superadmin_jwt=/)
    expect(setCookie).toMatch(/Domain=\.example\.com/i)
    expect(setCookie).toMatch(/HttpOnly/i)
    expect(setCookie).toMatch(/Secure/i)
    expect(setCookie).toMatch(/SameSite=Lax/i)

    const jwtMatch = setCookie.match(/superadmin_jwt=([^;,]+)/)
    expect(jwtMatch).not.toBeNull()
    const payload = await verifySuperadminJwt(jwtMatch![1], keys.pub)
    expect(payload?.email).toBe('admin@example.com')
  })

  it('does NOT set superadmin_jwt when no private key is configured (no crash)', async () => {
    const db = drizzle(env.DB, { schema })
    const rawToken = 'g'.repeat(64)
    const tokenHash = await hashToken(rawToken)
    await db.insert(schema.magicLinks).values({
      id: crypto.randomUUID(),
      email: 'admin@example.com',
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const noKeyEnv = { ...TEST_ENV, ADMIN_APP_URL: 'https://admin.example.com', SUPERADMIN_JWT_PRIVATE_KEY: undefined }
    const res = await postCallback(rawToken, noKeyEnv)
    expect(res.status).toBe(200)
    const setCookie = res.headers.get('Set-Cookie') ?? ''
    expect(setCookie).toMatch(/admin_session=/)
    expect(setCookie).not.toMatch(/superadmin_jwt=/)
  })

  it('returns 400 when no token is sent', async () => {
    const res = await postCallback(undefined)
    expect(res.status).toBe(400)
  })

  it('rejects a used token', async () => {
    const db = drizzle(env.DB, { schema })
    const rawToken = 'c'.repeat(64)
    const tokenHash = await hashToken(rawToken)
    await db.insert(schema.magicLinks).values({
      id: crypto.randomUUID(),
      email: 'admin@example.com',
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      usedAt: new Date().toISOString(),
    })
    const res = await postCallback(rawToken)
    expect(res.status).toBe(401)
  })

  it('returns 403 if the email is no longer allowlisted', async () => {
    const db = drizzle(env.DB, { schema })
    const rawToken = 'e'.repeat(64)
    const tokenHash = await hashToken(rawToken)
    await db.insert(schema.magicLinks).values({
      id: crypto.randomUUID(),
      email: 'outsider@example.com',
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const res = await postCallback(rawToken)
    expect(res.status).toBe(403)
  })

  it('rejects an expired token', async () => {
    const db = drizzle(env.DB, { schema })
    const rawToken = 'd'.repeat(64)
    const tokenHash = await hashToken(rawToken)
    await db.insert(schema.magicLinks).values({
      id: crypto.randomUUID(),
      email: 'admin@example.com',
      tokenHash,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    })
    const res = await postCallback(rawToken)
    expect(res.status).toBe(401)
  })
})

describe('POST /admin/dash/auth/logout', () => {
  it('clears the admin_session cookie', async () => {
    const res = await app.fetch(
      new Request('http://central/admin/dash/auth/logout', { method: 'POST' }),
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const sc = res.headers.get('Set-Cookie') ?? ''
    expect(sc).toMatch(/admin_session=;/)
    expect(sc).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/)
  })
})
