import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { app } from '../../src/index'
import { clearDb } from '../helpers/migrations'
import { createAdminSession, hashToken } from '../../src/lib/adminAuth'
import { verifySuperadminJwt } from '../../src/lib/superadminJwt'

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
  SUPERADMIN_JWT_PRIVATE_KEY: keys.priv,
  SUPERADMIN_JWT_PUBLIC_KEY: keys.pub,
  SUPERADMIN_EMAILS: 'admin@example.com,other@example.com',
  ADMIN_APP_URL: 'https://admin.example.com',
  ADMIN_SECRET: 'admin-secret',
}

const db = () => drizzle(env.DB, { schema })

async function sessionCookie(email: string): Promise<string> {
  const { rawToken } = await createAdminSession(db(), email)
  return `admin_session=${rawToken}`
}

function get(cookie?: string, e = TEST_ENV) {
  return app.fetch(new Request('http://central/admin/dash/profile', { headers: cookie ? { Cookie: cookie } : {} }), e)
}

function put(body: unknown, cookie?: string, e = TEST_ENV) {
  return app.fetch(
    new Request('http://central/admin/dash/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    }),
    e,
  )
}

type Profile = { data: { email: string; name: string; title: string } }

// Sign in the way the dashboard does and return the verified superadmin_jwt
// central set.
async function signInToken(email: string): Promise<Awaited<ReturnType<typeof verifySuperadminJwt>>> {
  const raw = 'z'.repeat(60) + Math.random().toString(16).slice(2, 6)
  await db().insert(schema.magicLinks).values({
    id: crypto.randomUUID(), email, tokenHash: await hashToken(raw), expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  const res = await app.fetch(
    new Request('http://central/admin/dash/auth/callback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: raw }),
    }),
    TEST_ENV,
  )
  const jwt = (res.headers.get('Set-Cookie') ?? '').match(/superadmin_jwt=([^;,]+)/)![1]
  return verifySuperadminJwt(jwt, keys.pub)
}

beforeEach(async () => {
  await clearDb()
})

describe('GET /admin/dash/profile', () => {
  it('requires a sign-in', async () => {
    expect((await get()).status).toBe(401)
  })

  it('returns a blank profile for a superadmin who has not set one', async () => {
    const res = await get(await sessionCookie('admin@example.com'))
    expect(res.status).toBe(200)
    expect(((await res.json()) as Profile).data).toEqual({ email: 'admin@example.com', name: '', title: '' })
  })

  it('is not available to the machine bearer secret, which has no identity', async () => {
    const res = await app.fetch(
      new Request('http://central/admin/dash/profile', { headers: { Authorization: 'Bearer admin-secret' } }),
      TEST_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('refuses a session whose email is no longer on the superadmin list', async () => {
    const res = await get(await sessionCookie('removed@example.com'))
    expect(res.status).toBe(403)
  })
})

describe('PUT /admin/dash/profile', () => {
  it('sets name and title, and later changes them', async () => {
    const cookie = await sessionCookie('admin@example.com')
    const res = await put({ name: '  Ada Lovelace ', title: 'Operator support' }, cookie)
    expect(res.status).toBe(200)
    expect(((await res.json()) as Profile).data).toEqual({ email: 'admin@example.com', name: 'Ada Lovelace', title: 'Operator support' })

    await put({ name: 'Ada King', title: '' }, cookie)
    expect(((await (await get(cookie)).json()) as Profile).data).toEqual({ email: 'admin@example.com', name: 'Ada King', title: '' })
  })

  it('keeps one profile per superadmin', async () => {
    const a = await sessionCookie('admin@example.com')
    const o = await sessionCookie('other@example.com')
    await put({ name: 'Ada', title: 'Support' }, a)
    await put({ name: 'Olive', title: 'Engineer' }, o)
    expect(((await (await get(a)).json()) as Profile).data.name).toBe('Ada')
    expect(((await (await get(o)).json()) as Profile).data.name).toBe('Olive')
  })

  it('rejects a name or title that is not a string, or too long', async () => {
    const cookie = await sessionCookie('admin@example.com')
    expect((await put({ name: 5, title: '' }, cookie)).status).toBe(400)
    expect((await put({ name: 'A', title: null }, cookie)).status).toBe(400)
    expect((await put({ name: 'x'.repeat(101), title: '' }, cookie)).status).toBe(400)
    expect((await put({ name: 'A', title: 'x'.repeat(201) }, cookie)).status).toBe(400)
    expect(((await (await get(cookie)).json()) as Profile).data.name).toBe('')
  })

  it('requires a sign-in, and refuses the bearer secret and a delisted session', async () => {
    expect((await put({ name: 'A', title: 'B' })).status).toBe(401)
    const bearer = await app.fetch(
      new Request('http://central/admin/dash/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer admin-secret' },
        body: JSON.stringify({ name: 'A', title: 'B' }),
      }),
      TEST_ENV,
    )
    expect(bearer.status).toBe(403)
    expect((await put({ name: 'A', title: 'B' }, await sessionCookie('removed@example.com'))).status).toBe(403)
  })

  it('sets no superadmin_jwt cookie, so a dashboard session cannot be turned into a renewable sign-in token', async () => {
    const res = await put({ name: 'Ada', title: 'Operator support' }, await sessionCookie('admin@example.com'))
    expect(res.status).toBe(200)
    expect(res.headers.get('Set-Cookie') ?? '').not.toMatch(/superadmin_jwt=/)
  })
})

describe('the superadmin token issued at sign-in', () => {
  it('carries the saved name and title', async () => {
    await put({ name: 'Ada', title: 'Operator support' }, await sessionCookie('admin@example.com'))
    expect(await signInToken('admin@example.com')).toMatchObject({ name: 'Ada', title: 'Operator support' })
  })

  it('carries a blank title once a profile exists, so instances clear theirs', async () => {
    await put({ name: 'Ada', title: '' }, await sessionCookie('admin@example.com'))
    expect((await signInToken('admin@example.com'))?.title).toBe('')
  })

  it('carries no profile for a superadmin who has not set one', async () => {
    expect((await signInToken('admin@example.com'))?.title).toBeNull()
  })
})

describe('the identity the dashboard sees at /auth/me', () => {
  it('is the signed-in email, without a per-session name', async () => {
    const res = await app.fetch(
      new Request('http://central/admin/dash/auth/me', { headers: { Cookie: await sessionCookie('admin@example.com') } }),
      TEST_ENV,
    )
    expect(((await res.json()) as { data: object }).data).toEqual({ email: 'admin@example.com' })
  })
})
