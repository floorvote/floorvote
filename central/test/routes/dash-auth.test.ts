import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from '../../src/db/schema'
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

// The login route sends its email inside `executionCtx.waitUntil`, as the real Worker
// runtime allows: a test gives it a context that records what was handed over, and
// settles it when the test wants the background work done.
function makeCtx() {
  const pending: Promise<unknown>[] = []
  const ctx = {
    waitUntil: vi.fn((p: Promise<unknown>) => { pending.push(p) }),
    passThroughOnException: () => {},
  } as unknown as ExecutionContext & { waitUntil: ReturnType<typeof vi.fn> }
  return { ctx, settle: () => Promise.all(pending) }
}

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
    const body = await res.json() as { data: { email: string } }
    expect(body.data.email).toBe('admin@example.com')
    expect(res.headers.get('Set-Cookie')).toMatch(/admin_session=/)
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
    const { ctx, settle } = makeCtx()
    const res = await app.fetch(
      new Request('http://central/admin/dash/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@example.com' }),
      }),
      TEST_ENV,
      ctx,
    )
    expect(res.status).toBe(200)
    await settle()
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
    const { ctx, settle } = makeCtx()
    const res = await app.fetch(
      new Request('http://central/admin/dash/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@example.com' }),
      }),
      TEST_ENV,
      ctx,
    )
    expect(res.status).toBe(200)
    await settle()
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

describe('POST /admin/dash/auth/login — sender gate (Cloudflare Email or Resend)', () => {
  type Sent = { to: string | string[]; from: string; subject: string; html?: string; text?: string }

  function fakeBinding(opts: { fail?: boolean } = {}) {
    const sent: Sent[] = []
    return {
      sent,
      binding: {
        send: async (m: Sent) => {
          if (opts.fail) throw Object.assign(new Error('binding exploded: secret-detail-xyz'), { code: 'E_SENDER_NOT_VERIFIED' })
          sent.push(m)
          return {}
        },
      },
    }
  }

  // Env with no sender configured; each test layers on what it needs.
  const BASE_ENV: any = { ...TEST_ENV, RESEND_API_KEY: undefined, EMAIL: undefined, EMAIL_PROVIDER: undefined }

  // The request, with a context the test can settle. `login` waits for the background
  // send too, so a test that asserts on what was sent reads it after the work is done.
  function loginRaw(email: string, envOverride: any, extraHeaders: Record<string, string> = {}) {
    const { ctx, settle } = makeCtx()
    const res = app.fetch(
      new Request('http://central/admin/dash/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
        body: JSON.stringify({ email }),
      }),
      envOverride,
      ctx,
    )
    return { res, ctx, settle }
  }

  async function login(email: string, envOverride: any, extraHeaders: Record<string, string> = {}) {
    const { res, settle } = loginRaw(email, envOverride, extraHeaders)
    const response = await res
    await settle()
    return response
  }

  function stubResendFetch() {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ id: 'resend-1' }), { status: 200 }))
  }

  const okBody = async (res: Response) => {
    const b = await res.json() as { data: { ok: boolean }; meta: { generatedAt: string } }
    return b.data
  }

  it('sends one email through the Cloudflare binding with no RESEND_API_KEY', async () => {
    const { sent, binding } = fakeBinding()
    const fetchSpy = stubResendFetch()
    const res = await login('admin@example.com', { ...BASE_ENV, EMAIL_PROVIDER: 'cloudflare', EMAIL: binding })
    expect(res.status).toBe(200)
    expect(await okBody(res)).toEqual({ ok: true })
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toEqual(['admin@example.com'])
    expect(fetchSpy).not.toHaveBeenCalled()
    const db = drizzle(env.DB, { schema })
    expect((await db.select().from(schema.magicLinks).all()).length).toBe(1)
  })

  it('keeps the magic link and token unchanged when sent through the binding', async () => {
    const { sent, binding } = fakeBinding()
    await login('admin@example.com', { ...BASE_ENV, EMAIL_PROVIDER: 'cloudflare', EMAIL: binding })
    expect(sent).toHaveLength(1)
    const m = (sent[0].text ?? '').match(/https:\/\/admin\.test\/admin\/dash\/auth\/callback\?token=([0-9a-zA-Z%_-]+)/)
    expect(m).not.toBeNull()
    expect(sent[0].html).toContain(`https://admin.test/admin/dash/auth/callback?token=${m![1]}`)
    const rawToken = decodeURIComponent(m![1])
    expect(rawToken.length).toBeGreaterThanOrEqual(32)
    const db = drizzle(env.DB, { schema })
    const link = await db.select().from(schema.magicLinks).where(eq(schema.magicLinks.tokenHash, await hashToken(rawToken))).get()
    expect(link?.email).toBe('admin@example.com')
    expect(link?.usedAt).toBeNull()
    // 30-minute TTL is unchanged.
    const ttl = new Date(link!.expiresAt).getTime() - Date.now()
    expect(ttl).toBeGreaterThan(29 * 60_000)
    expect(ttl).toBeLessThanOrEqual(30 * 60_000)
    expect(sent[0].subject).toMatch(/sign-in link/)
  })

  it('falls back to the existing Resend sender when the binding is absent', async () => {
    const fetchSpy = stubResendFetch()
    const res = await login('admin@example.com', { ...BASE_ENV, RESEND_API_KEY: 'rk_test', EMAIL_PROVIDER: 'cloudflare', EMAIL: undefined })
    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0][0])).toBe('https://api.resend.com/emails')
  })

  it('leaves Resend-only behavior unchanged', async () => {
    const fetchSpy = stubResendFetch()
    const res = await login('admin@example.com', { ...BASE_ENV, RESEND_API_KEY: 'rk_test' })
    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const db = drizzle(env.DB, { schema })
    expect((await db.select().from(schema.magicLinks).all()).length).toBe(1)
  })

  it('uses Resend, not the binding, when EMAIL_PROVIDER=resend even if a binding exists', async () => {
    const { sent, binding } = fakeBinding()
    const fetchSpy = stubResendFetch()
    await login('admin@example.com', { ...BASE_ENV, RESEND_API_KEY: 'rk_test', EMAIL_PROVIDER: 'resend', EMAIL: binding })
    expect(sent).toHaveLength(0)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('sends through the binding when EMAIL_PROVIDER is not cloudflare and no Resend key is set: a bound binding counts as a configured sender', async () => {
    const { sent, binding } = fakeBinding()
    const fetchSpy = stubResendFetch()
    const res = await login('admin@example.com', { ...BASE_ENV, EMAIL_PROVIDER: 'resend', EMAIL: binding })
    expect(res.status).toBe(200)
    expect(sent).toHaveLength(1)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('sends the link through Resend when the binding, tried first, is down', async () => {
    const down = fakeBinding({ fail: true })
    const fetchSpy = stubResendFetch()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await login('admin@example.com', { ...BASE_ENV, RESEND_API_KEY: 'rk_test', EMAIL_PROVIDER: 'cloudflare', EMAIL: down.binding })
    expect(res.status).toBe(200)
    expect(await okBody(res)).toEqual({ ok: true })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body))
    expect(body.to).toEqual(['admin@example.com'])
    expect(body.html).toMatch(/auth\/callback\?token=/)
  })

  it('sends the link through the binding when Resend, tried first, is down', async () => {
    const { sent, binding } = fakeBinding()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('upstream', { status: 503 }))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await login('admin@example.com', { ...BASE_ENV, RESEND_API_KEY: 'rk_test', EMAIL: binding })
    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toEqual(['admin@example.com'])
  })

  it('still answers the plain 200 with the link stored when both providers are down', async () => {
    const down = fakeBinding({ fail: true })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('upstream', { status: 503 }))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await login('admin@example.com', { ...BASE_ENV, RESEND_API_KEY: 'rk_test', EMAIL_PROVIDER: 'cloudflare', EMAIL: down.binding })
    expect(res.status).toBe(200)
    expect(await okBody(res)).toEqual({ ok: true })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const db = drizzle(env.DB, { schema })
    expect((await db.select().from(schema.magicLinks).all()).length).toBe(1)
  })

  it('sends nothing when a blank Resend key is the only thing configured', async () => {
    const fetchSpy = stubResendFetch()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await login('admin@example.com', { ...BASE_ENV, RESEND_API_KEY: '' })
    expect(res.status).toBe(200)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('sends nothing, inserts nothing, and warns naming the sender when no sender is configured', async () => {
    const fetchSpy = stubResendFetch()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await login('admin@example.com', BASE_ENV)
    expect(res.status).toBe(200)
    expect(await okBody(res)).toEqual({ ok: true })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    const msg = String(warn.mock.calls[0][0])
    expect(msg).toContain('RESEND_API_KEY')
    expect(msg).toContain('EMAIL')
    expect(msg).not.toContain('ADMIN_APP_URL')
    const db = drizzle(env.DB, { schema })
    expect((await db.select().from(schema.magicLinks).all()).length).toBe(0)
  })

  it('sends nothing and warns naming ADMIN_APP_URL when it is unset (binding configured)', async () => {
    const { sent, binding } = fakeBinding()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await login('admin@example.com', { ...BASE_ENV, ADMIN_APP_URL: undefined, EMAIL_PROVIDER: 'cloudflare', EMAIL: binding })
    expect(res.status).toBe(200)
    expect(sent).toHaveLength(0)
    expect(warn).toHaveBeenCalledTimes(1)
    const msg = String(warn.mock.calls[0][0])
    expect(msg).toContain('ADMIN_APP_URL')
    expect(msg).not.toContain('RESEND_API_KEY')
  })

  it('names both when neither a sender nor ADMIN_APP_URL is configured', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await login('admin@example.com', { ...BASE_ENV, ADMIN_APP_URL: undefined })
    expect(res.status).toBe(200)
    const msg = String(warn.mock.calls[0][0])
    expect(msg).toContain('ADMIN_APP_URL')
    expect(msg).toContain('RESEND_API_KEY')
  })

  it('sends nothing with Resend configured but ADMIN_APP_URL unset', async () => {
    const fetchSpy = stubResendFetch()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await login('admin@example.com', { ...BASE_ENV, RESEND_API_KEY: 'rk_test', ADMIN_APP_URL: undefined })
    expect(res.status).toBe(200)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(String(warn.mock.calls[0][0])).toContain('ADMIN_APP_URL')
  })

  it('gives an unlisted address the identical response and sends nothing, in every configuration', async () => {
    const { sent, binding } = fakeBinding()
    const fetchSpy = stubResendFetch()
    const configs: any[] = [
      { ...BASE_ENV, EMAIL_PROVIDER: 'cloudflare', EMAIL: binding },
      { ...BASE_ENV, RESEND_API_KEY: 'rk_test' },
      { ...BASE_ENV, RESEND_API_KEY: 'rk_test', EMAIL_PROVIDER: 'cloudflare', EMAIL: binding },
      BASE_ENV,
      { ...BASE_ENV, ADMIN_APP_URL: undefined, EMAIL_PROVIDER: 'cloudflare', EMAIL: binding },
    ]
    for (const cfg of configs) {
      const listed = await login('outsider@example.com', cfg)
      expect(listed.status).toBe(200)
      expect(await okBody(listed)).toEqual({ ok: true })
    }
    expect(sent).toHaveLength(0)
    expect(fetchSpy).not.toHaveBeenCalled()
    const db = drizzle(env.DB, { schema })
    expect((await db.select().from(schema.magicLinks).all()).length).toBe(0)
  })

  it('returns the same status and body shape for an unlisted and a listed address', async () => {
    const { binding } = fakeBinding()
    const cfg = { ...BASE_ENV, EMAIL_PROVIDER: 'cloudflare', EMAIL: binding }
    const a = await login('admin@example.com', cfg)
    const b = await login('outsider@example.com', cfg)
    expect(a.status).toBe(b.status)
    expect(await okBody(a)).toEqual(await okBody(b))
    expect(a.headers.get('Content-Type')).toBe(b.headers.get('Content-Type'))
  })

  it('logs a binding send failure and still returns the plain 200 without leaking it', async () => {
    const { binding } = fakeBinding({ fail: true })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await login('admin@example.com', { ...BASE_ENV, EMAIL_PROVIDER: 'cloudflare', EMAIL: binding })
    expect(res.status).toBe(200)
    const raw = await res.clone().text()
    expect(raw).not.toContain('secret-detail-xyz')
    expect(raw).not.toContain('E_SENDER_NOT_VERIFIED')
    expect(await okBody(res)).toEqual({ ok: true })
    expect(err).toHaveBeenCalled()
    expect(err.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).toContain('secret-detail-xyz')
  })

  it('logs a Resend send failure without leaking it to the response', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('resend-internal-detail', { status: 500 }))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await login('admin@example.com', { ...BASE_ENV, RESEND_API_KEY: 'rk_test' })
    expect(res.status).toBe(200)
    expect(await res.clone().text()).not.toContain('resend-internal-detail')
    expect(err).toHaveBeenCalled()
  })

  it('still applies the per-IP rate limit with the Cloudflare binding (429, no send)', async () => {
    const { sent, binding } = fakeBinding()
    const blockingLimiter = { limit: async () => ({ success: false }) }
    const res = await login('admin@example.com', { ...BASE_ENV, EMAIL_PROVIDER: 'cloudflare', EMAIL: binding, LOGIN_RATE_LIMITER: blockingLimiter })
    expect(res.status).toBe(429)
    expect(sent).toHaveLength(0)
  })

  it('keys the rate limit on the client IP and lets an allowed request through the binding', async () => {
    const { sent, binding } = fakeBinding()
    const keys: string[] = []
    const limiter = { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: true } } }
    const res = await login('admin@example.com', { ...BASE_ENV, EMAIL_PROVIDER: 'cloudflare', EMAIL: binding, LOGIN_RATE_LIMITER: limiter }, { 'CF-Connecting-IP': '203.0.113.9' })
    expect(res.status).toBe(200)
    expect(keys).toEqual(['dash-login:203.0.113.9'])
    expect(sent).toHaveLength(1)
  })

  it('still caps active links per address with the Cloudflare binding (6th request sends nothing)', async () => {
    const { sent, binding } = fakeBinding()
    const cfg = { ...BASE_ENV, EMAIL_PROVIDER: 'cloudflare', EMAIL: binding }
    for (let i = 0; i < 5; i++) {
      const r = await login('admin@example.com', cfg)
      expect(r.status).toBe(200)
    }
    expect(sent).toHaveLength(5)
    const sixth = await login('admin@example.com', cfg)
    expect(sixth.status).toBe(200)
    expect(sent).toHaveLength(5)
    const db = drizzle(env.DB, { schema })
    expect((await db.select().from(schema.magicLinks).all()).length).toBe(5)
  })

  it('treats the allowlist case-insensitively and trims the address before sending via the binding', async () => {
    const { sent, binding } = fakeBinding()
    const res = await login('  Admin@Example.com ', { ...BASE_ENV, EMAIL_PROVIDER: 'cloudflare', EMAIL: binding })
    expect(res.status).toBe(200)
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toEqual(['admin@example.com'])
  })
})

describe('POST /admin/dash/auth/login — the send is off the response path (#674)', () => {
  type Sent = { to: string | string[]; subject: string; html?: string; text?: string }

  // A binding whose send waits until the test lets it go, so a test can look at the
  // state while the provider round-trip is still in flight.
  function gatedBinding(opts: { fail?: boolean; never?: boolean } = {}) {
    const sent: Sent[] = []
    let started = false
    let release: () => void = () => {}
    const gate = opts.never ? new Promise<void>(() => {}) : new Promise<void>((resolve) => { release = resolve })
    return {
      sent,
      didStart: () => started,
      release: () => release(),
      binding: {
        send: async (m: Sent) => {
          started = true
          await gate
          if (opts.fail) throw Object.assign(new Error('binding exploded: secret-detail-xyz'), { code: 'E_SENDER_NOT_VERIFIED' })
          sent.push(m)
          return {}
        },
      },
    }
  }

  const CF = (binding: unknown): any => ({
    ...TEST_ENV, RESEND_API_KEY: undefined, EMAIL: binding, EMAIL_PROVIDER: 'cloudflare',
  })

  function post(email: string, envOverride: any) {
    const { ctx, settle } = makeCtx()
    const res = app.fetch(
      new Request('http://central/admin/dash/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      }),
      envOverride,
      ctx,
    )
    return { res, ctx, settle }
  }

  /** Resolves 'response' if the response arrives, 'timeout' if it is still waiting after `ms`. */
  const arrives = (res: Promise<Response>, ms = 1500) =>
    Promise.race([res.then(() => 'response' as const), new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))])

  /** The response, failing on an assertion (not a test timeout) when it waits on the send. */
  async function answered(res: Promise<Response>): Promise<Response> {
    expect(await arrives(res), 'the response should not wait for the email send').toBe('response')
    return res
  }

  it('answers while the provider call is still in flight, and the email goes out once it finishes', async () => {
    const g = gatedBinding()
    const { res, settle } = post('admin@example.com', CF(g.binding))
    expect(await arrives(res)).toBe('response')
    expect(g.sent).toHaveLength(0)
    g.release()
    await settle()
    expect(g.sent).toHaveLength(1)
    expect(g.sent[0].to).toEqual(['admin@example.com'])
  })

  it('answers even when the provider call never finishes', async () => {
    const g = gatedBinding({ never: true })
    const { res } = post('admin@example.com', CF(g.binding))
    expect(await arrives(res)).toBe('response')
    const response = await answered(res)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ data: { ok: true } })
  })

  it('hands the send to waitUntil exactly once for a listed address', async () => {
    const g = gatedBinding()
    const { res, ctx, settle } = post('admin@example.com', CF(g.binding))
    await answered(res)
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1)
    g.release()
    await settle()
    expect(g.sent).toHaveLength(1)
  })

  it('hands nothing to waitUntil for an unlisted address, a capped one, or an unconfigured sender', async () => {
    const g = gatedBinding()
    g.release()
    const outsider = post('outsider@example.com', CF(g.binding))
    await outsider.res
    expect(outsider.ctx.waitUntil).not.toHaveBeenCalled()

    const db = drizzle(env.DB, { schema })
    for (let i = 0; i < 5; i++) {
      await db.insert(schema.magicLinks).values({
        id: crypto.randomUUID(), email: 'admin@example.com', tokenHash: await hashToken(`cap-${i}-${'z'.repeat(60)}`),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
    }
    const capped = post('admin@example.com', CF(g.binding))
    await capped.res
    expect(capped.ctx.waitUntil).not.toHaveBeenCalled()

    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bare = post('admin@example.com', { ...TEST_ENV, RESEND_API_KEY: undefined, EMAIL: undefined, EMAIL_PROVIDER: undefined })
    await bare.res
    expect(bare.ctx.waitUntil).not.toHaveBeenCalled()
    expect(g.sent).toHaveLength(0)
  })

  it('has stored the link before it answers, and the emailed token is that link', async () => {
    const g = gatedBinding()
    const { res, settle } = post('admin@example.com', CF(g.binding))
    await answered(res)
    const db = drizzle(env.DB, { schema })
    expect((await db.select().from(schema.magicLinks).all()).length).toBe(1)
    g.release()
    await settle()
    const m = (g.sent[0].text ?? '').match(/auth\/callback\?token=([0-9a-zA-Z%_-]+)/)
    expect(m).not.toBeNull()
    const link = await db.select().from(schema.magicLinks).where(eq(schema.magicLinks.tokenHash, await hashToken(decodeURIComponent(m![1])))).get()
    expect(link?.email).toBe('admin@example.com')
  })

  it('logs a failed send from the background, returns the plain 200, and never rejects the waitUntil promise', async () => {
    const g = gatedBinding({ fail: true })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { res, settle } = post('admin@example.com', CF(g.binding))
    const response = await answered(res)
    expect(response.status).toBe(200)
    const raw = await response.clone().text()
    expect(raw).not.toContain('secret-detail-xyz')
    expect(raw).not.toContain('E_SENDER_NOT_VERIFIED')
    expect(err).not.toHaveBeenCalled() // nothing has failed yet: the send hasn't finished
    g.release()
    await expect(settle()).resolves.toBeDefined()
    expect(err.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).toContain('secret-detail-xyz')
  })

  it('logs a Resend failure from the background the same way', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('resend-internal-detail', { status: 500 }))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { res, settle } = post('admin@example.com', { ...TEST_ENV, RESEND_API_KEY: 'rk_test', EMAIL: undefined, EMAIL_PROVIDER: undefined })
    const response = await res
    expect(response.status).toBe(200)
    expect(await response.clone().text()).not.toContain('resend-internal-detail')
    await expect(settle()).resolves.toBeDefined()
    expect(err).toHaveBeenCalled()
  })

  it('logs a send that throws synchronously, instead of rejecting', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const throwing = { send: () => { throw new Error('sync-throw-detail') } }
    const { res, settle } = post('admin@example.com', CF(throwing))
    expect((await res).status).toBe(200)
    await expect(settle()).resolves.toBeDefined()
    expect(err.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).toContain('sync-throw-detail')
  })

  it('gives listed and unlisted addresses the same status, body, and headers', async () => {
    const g = gatedBinding()
    g.release()
    const cfg = CF(g.binding)
    const listed = post('admin@example.com', cfg)
    const unlisted = post('outsider@example.com', cfg)
    const [a, b] = [await listed.res, await unlisted.res]
    await listed.settle()
    expect(a.status).toBe(b.status)
    expect(a.status).toBe(200)
    const bodyOf = async (r: Response) => { const j = await r.json() as { data: unknown; meta: { generatedAt: string } }; return j.data }
    expect(await bodyOf(a)).toEqual(await bodyOf(b))
    expect([...a.headers.entries()].sort()).toEqual([...b.headers.entries()].sort())
  })

  it('gives a listed address the same response whether the send succeeds, fails, or hangs', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const bodies: string[] = []
    const heads: string[] = []
    for (const opts of [{}, { fail: true }, { never: true }] as const) {
      const g = gatedBinding(opts)
      g.release()
      const { res } = post('admin@example.com', CF(g.binding))
      const response = await answered(res)
      expect(response.status).toBe(200)
      const text = await response.text()
      bodies.push(JSON.stringify((JSON.parse(text) as { data: unknown }).data))
      heads.push(JSON.stringify([...response.headers.entries()].sort()))
    }
    expect(new Set(bodies).size).toBe(1)
    expect(new Set(heads).size).toBe(1)
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
