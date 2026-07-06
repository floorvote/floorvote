import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import * as schema from '../../src/db/schema-legiscan'
import { setupLsDb } from '../helpers/setupLsDb'
import {
  isSuperAdmin,
  generateToken,
  hashToken,
  createAdminSession,
  lookupAdminSession,
  deleteAdminSession,
  requireAdmin,
} from '../../src/lib/adminAuth'
import { signSuperadminJwt } from '../../src/lib/superadminJwt'

async function genKeys(): Promise<{ priv: string; pub: string }> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  return {
    priv: JSON.stringify(await crypto.subtle.exportKey('jwk', (kp as CryptoKeyPair).privateKey)),
    pub: JSON.stringify(await crypto.subtle.exportKey('jwk', (kp as CryptoKeyPair).publicKey)),
  }
}

beforeEach(async () => {
  await setupLsDb()
})

describe('isSuperAdmin', () => {
  it('returns true when email is in comma-separated list (case-insensitive)', () => {
    expect(isSuperAdmin('foo@example.com', 'foo@example.com,bar@example.com')).toBe(true)
    expect(isSuperAdmin('FOO@example.com', 'foo@example.com')).toBe(true)
  })
  it('returns false when email not present or list is undefined', () => {
    expect(isSuperAdmin('nope@example.com', 'foo@example.com')).toBe(false)
    expect(isSuperAdmin('foo@example.com', undefined)).toBe(false)
  })
})

describe('generateToken / hashToken', () => {
  it('generates a 64-char hex token', async () => {
    const t = await generateToken()
    expect(t).toMatch(/^[0-9a-f]{64}$/)
  })
  it('hashes the same input to the same hash', async () => {
    const h1 = await hashToken('abc')
    const h2 = await hashToken('abc')
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('admin sessions', () => {
  it('creates a session and looks it up by raw token', async () => {
    const db = drizzle(env.DB, { schema })
    const { rawToken } = await createAdminSession(db, 'foo@example.com', 'Foo Bar')
    const session = await lookupAdminSession(db, rawToken)
    expect(session?.email).toBe('foo@example.com')
    expect(session?.name).toBe('Foo Bar')
  })

  it('stores empty name when none provided', async () => {
    const db = drizzle(env.DB, { schema })
    const { rawToken } = await createAdminSession(db, 'foo@example.com')
    const session = await lookupAdminSession(db, rawToken)
    expect(session?.name).toBe('')
  })

  it('returns null for expired sessions', async () => {
    const db = drizzle(env.DB, { schema })
    const { rawToken } = await createAdminSession(db, 'foo@example.com', { ttlMs: -1000 })
    const session = await lookupAdminSession(db, rawToken)
    expect(session).toBeNull()
  })

  it('returns null for unknown tokens', async () => {
    const db = drizzle(env.DB, { schema })
    const session = await lookupAdminSession(db, 'definitely-not-a-real-token')
    expect(session).toBeNull()
  })

  it('deletes a session', async () => {
    const db = drizzle(env.DB, { schema })
    const { rawToken } = await createAdminSession(db, 'foo@example.com')
    await deleteAdminSession(db, rawToken)
    expect(await lookupAdminSession(db, rawToken)).toBeNull()
  })
})

describe('requireAdmin middleware', () => {
  function makeApp() {
    const app = new Hono<{ Bindings: any }>()
    app.use('*', requireAdmin())
    app.get('/x', (c) => c.json({ ok: true }))
    return app
  }

  let keys: { priv: string; pub: string }
  let TEST_ENV: any

  beforeAll(async () => {
    keys = await genKeys()
    TEST_ENV = {
      ...env,
      SUPERADMIN_JWT_PUBLIC_KEY: keys.pub,
      SUPERADMIN_EMAILS: 'admin@example.com',
      ADMIN_SECRET: 'admin-secret',
    }
  })

  it('401 with no auth', async () => {
    const res = await makeApp().fetch(new Request('http://x/x'), TEST_ENV)
    expect(res.status).toBe(401)
  })

  it('200 with valid admin_session cookie', async () => {
    const db = drizzle(env.DB, { schema })
    const { rawToken } = await createAdminSession(db, 'admin@example.com')
    const res = await makeApp().fetch(
      new Request('http://x/x', { headers: { Cookie: `admin_session=${rawToken}` } }),
      TEST_ENV,
    )
    expect(res.status).toBe(200)
  })

  it('200 with Authorization: Bearer ADMIN_SECRET', async () => {
    const res = await makeApp().fetch(
      new Request('http://x/x', { headers: { Authorization: 'Bearer admin-secret' } }),
      TEST_ENV,
    )
    expect(res.status).toBe(200)
  })

  it('200 with superadmin_jwt cookie (mints session on first call)', async () => {
    const jwt = await signSuperadminJwt('admin@example.com', 'Will', keys.priv)
    const res = await makeApp().fetch(
      new Request('http://x/x', { headers: { Cookie: `superadmin_jwt=${jwt}` } }),
      TEST_ENV,
    )
    expect(res.status).toBe(200)
  })

  it('403 with valid JWT but non-allowlisted email', async () => {
    const jwt = await signSuperadminJwt('outsider@example.com', 'Out', keys.priv)
    const res = await makeApp().fetch(
      new Request('http://x/x', { headers: { Cookie: `superadmin_jwt=${jwt}` } }),
      TEST_ENV,
    )
    expect(res.status).toBe(403)
  })
})
