import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { app } from '../../src/index'
import { resetDb, applyMigrations, seedUser, seedSession } from '../helpers'
import { getDb } from '../../src/db/client'
import { users } from '../../src/db/schema'
import { signSuperadminJwt } from '../../../shared/superadminJwt'
import { _resetSuperadminAllowlistCache } from '../../src/lib/superadminCentral'

// Throwaway ES256 test keypair (no production value); its public half is set as
// SUPERADMIN_JWT_PUBLIC_KEY in vitest.config.mts so signed tokens verify in tests.
const TEST_SUPERADMIN_PRIV = '{"key_ops":["sign"],"ext":true,"kty":"EC","x":"jMeKJ1Tf0sgE37Rzg02ARwUKvJ2hF6Zy2gI3mluSjpg","y":"vJ0-S0RvpYh3Z87ti61CrBjprBhpmiA4WujS6_Yb_lQ","crv":"P-256","d":"goMnWG7NT0ErjBM6BH8a_rf1hUjMvLB3o3h4f5sE-aY"}'

const SUPER = 'super@example.com'

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Central's superadmin list, served as hashes.
function centralWith(list: string[]) {
  return {
    fetch: async (req: Request) => {
      if (new URL(req.url).pathname === '/api/admin/superadmin/emails') {
        return new Response(JSON.stringify({ hashes: await Promise.all(list.map(sha256Hex)) }), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    },
  }
}
const asEnv = (list: string[]) => ({ ...env, CENTRAL: centralWith(list) }) as unknown as typeof env

// A superadmin token the way central issues it now: carrying the saved profile.
const tokenWith = (name: string, title: string) => signSuperadminJwt(SUPER, name, TEST_SUPERADMIN_PRIV, undefined, title)

type Me = { id: string; name: string; subtitle: string | null; role: string; isSuperadmin: boolean }

async function dashboardSignIn(jwt: string, e = asEnv([SUPER])) {
  const res = await app.request('/api/auth/me', { headers: { Cookie: `superadmin_jwt=${jwt}` } }, e)
  return { res, body: (await res.json()) as Me }
}

const userRow = async (email: string) =>
  getDb(env.DB).select().from(users).where(eq(users.email, email)).get()

function patchMe(cookie: string, body: unknown, e = asEnv([SUPER])) {
  return app.request('/api/users/me', {
    method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, e)
}

beforeEach(async () => {
  await resetDb()
  await applyMigrations()
  _resetSuperadminAllowlistCache()
})

describe('dashboard sign-in applies the central profile', () => {
  it('creates the instance copy with the token name and title', async () => {
    const { res, body } = await dashboardSignIn(await tokenWith('Ada Lovelace', 'Operator support'))
    expect(res.status).toBe(200)
    expect(body.name).toBe('Ada Lovelace')
    expect(body.subtitle).toBe('Operator support')
    const row = await userRow(SUPER)
    expect(row?.name).toBe('Ada Lovelace')
    expect(row?.subtitle).toBe('Operator support')
  })

  it('overwrites an existing copy on each sign-in', async () => {
    await seedUser({ email: SUPER, role: 'admin', name: 'Old Name', subtitle: 'Old title' })
    await dashboardSignIn(await tokenWith('Ada Lovelace', 'Operator support'))
    const first = await userRow(SUPER)
    expect([first?.name, first?.subtitle]).toEqual(['Ada Lovelace', 'Operator support'])

    // A later change in central reaches the instance on the next sign-in.
    const { body } = await dashboardSignIn(await tokenWith('Ada King', 'Engineer'))
    expect([body.name, body.subtitle]).toEqual(['Ada King', 'Engineer'])
    const second = await userRow(SUPER)
    expect([second?.name, second?.subtitle]).toEqual(['Ada King', 'Engineer'])
  })

  it('clears the title when central has a profile with a blank title', async () => {
    await seedUser({ email: SUPER, role: 'admin', name: 'Old Name', subtitle: 'Old title' })
    const { body } = await dashboardSignIn(await tokenWith('Ada', ''))
    expect(body.name).toBe('Ada')
    expect(body.subtitle).toBeNull()
  })

  it('leaves the existing name and title alone when the token is from before profiles', async () => {
    await seedUser({ email: SUPER, role: 'admin', name: 'Existing Name', subtitle: 'Existing title' })
    // No title claim: the shape central issued before this change.
    const older = await signSuperadminJwt(SUPER, 'Token Name', TEST_SUPERADMIN_PRIV)
    const { body } = await dashboardSignIn(older)
    expect([body.name, body.subtitle]).toEqual(['Existing Name', 'Existing title'])
    const row = await userRow(SUPER)
    expect([row?.name, row?.subtitle]).toEqual(['Existing Name', 'Existing title'])
  })

  it('leaves the signed-in member their admin role', async () => {
    const { body } = await dashboardSignIn(await tokenWith('Ada', 'Operator support'))
    expect(body.role).toBe('admin')
  })
})

describe('/auth/me with a live instance session', () => {
  async function liveSession() {
    const id = await seedUser({ email: SUPER, role: 'admin', name: 'Old Name', subtitle: 'Old title' })
    return `session=${await seedSession(id)}`
  }
  const meWith = async (cookie: string) => {
    const res = await app.request('/api/auth/me', { headers: { Cookie: cookie } }, asEnv([SUPER]))
    return (await res.json()) as Me
  }

  it('refreshes the profile from a token sent alongside the session', async () => {
    const cookie = await liveSession()
    const body = await meWith(`${cookie}; superadmin_jwt=${await tokenWith('Ada King', 'Engineer')}`)
    expect([body.name, body.subtitle]).toEqual(['Ada King', 'Engineer'])
    const row = await userRow(SUPER)
    expect([row?.name, row?.subtitle]).toEqual(['Ada King', 'Engineer'])
  })

  it('leaves the profile alone for a token from before profiles', async () => {
    const cookie = await liveSession()
    const older = await signSuperadminJwt(SUPER, 'Token Name', TEST_SUPERADMIN_PRIV)
    const body = await meWith(`${cookie}; superadmin_jwt=${older}`)
    expect([body.name, body.subtitle]).toEqual(['Old Name', 'Old title'])
  })

  it('ignores a token issued for a different address', async () => {
    const cookie = await liveSession()
    const other = await signSuperadminJwt('someone.else@example.com', 'Else', TEST_SUPERADMIN_PRIV, undefined, 'Other')
    const body = await meWith(`${cookie}; superadmin_jwt=${other}`)
    expect([body.name, body.subtitle]).toEqual(['Old Name', 'Old title'])
  })

  it('does nothing without a token', async () => {
    const body = await meWith(await liveSession())
    expect([body.name, body.subtitle]).toEqual(['Old Name', 'Old title'])
  })
})

describe('the Profile page data for a superadmin', () => {
  it('reports isSuperadmin on /auth/me after a dashboard sign-in', async () => {
    expect((await dashboardSignIn(await tokenWith('Ada', 'Support'))).body.isSuperadmin).toBe(true)
  })

  it('reports isSuperadmin for a superadmin who signed in by emailed link, and not for an ordinary admin', async () => {
    const superId = await seedUser({ email: SUPER, role: 'admin' })
    const adminId = await seedUser({ role: 'admin' })
    const meFor = async (id: string) => {
      const res = await app.request('/api/auth/me', { headers: { Cookie: `session=${await seedSession(id)}` } }, asEnv([SUPER]))
      return (await res.json()) as Me
    }
    expect((await meFor(superId)).isSuperadmin).toBe(true)
    expect((await meFor(adminId)).isSuperadmin).toBe(false)
  })
})

describe('PATCH /users/me for a superadmin', () => {
  async function superCookie() {
    const id = await seedUser({ email: SUPER, role: 'admin', name: 'Ada', subtitle: 'Operator support' })
    return `session=${await seedSession(id)}`
  }

  it('rejects a name edit and leaves the name unchanged', async () => {
    const res = await patchMe(await superCookie(), { name: 'Someone Else' })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toMatch(/admin dashboard/i)
    expect((await userRow(SUPER))?.name).toBe('Ada')
  })

  it('rejects a title edit and leaves the title unchanged', async () => {
    const res = await patchMe(await superCookie(), { subtitle: 'CEO' })
    expect(res.status).toBe(403)
    expect((await userRow(SUPER))?.subtitle).toBe('Operator support')
  })

  it('rejects the whole request, applying none of it, when name or title is mixed with other settings', async () => {
    const res = await patchMe(await superCookie(), { name: 'X', emailDigestEnabled: false })
    expect(res.status).toBe(403)
    expect((await userRow(SUPER))?.emailDigestEnabled).toBe(1)
  })

  it('still lets them change their email settings', async () => {
    const res = await patchMe(await superCookie(), { emailDigestEnabled: false })
    expect(res.status).toBe(200)
    expect((await userRow(SUPER))?.emailDigestEnabled).toBe(0)
  })

  it('recognizes them by a verified token when central cannot be reached', async () => {
    const cookie = await superCookie()
    const jwt = await tokenWith('Ada', 'Operator support')
    const down = { ...env, CENTRAL: { fetch: async () => new Response('boom', { status: 500 }) } } as unknown as typeof env
    const res = await app.request('/api/users/me', {
      method: 'PATCH',
      headers: { Cookie: `${cookie}; superadmin_jwt=${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Someone Else' }),
    }, down)
    expect(res.status).toBe(403)
  })

  it('does not treat another superadmin\'s token as authority over a different member\'s profile', async () => {
    const id = await seedUser({ email: 'member@example.com', role: 'member', name: 'Mem' })
    const jwt = await tokenWith('Ada', 'Operator support')
    const res = await patchMe(`session=${await seedSession(id)}; superadmin_jwt=${jwt}`, { name: 'New Name' }, asEnv([SUPER]))
    expect(res.status).toBe(200)
    expect((await userRow('member@example.com'))?.name).toBe('New Name')
  })

  it('lets an ordinary member and an ordinary admin edit their name and title as before', async () => {
    for (const role of ['member', 'admin'] as const) {
      const id = await seedUser({ role })
      const res = await patchMe(`session=${await seedSession(id)}`, { name: 'Pat', subtitle: 'Clerk' })
      expect(res.status).toBe(200)
    }
  })

  it('lets someone edit again once they are removed from the superadmin list', async () => {
    const cookie = await superCookie()
    expect((await patchMe(cookie, { name: 'X' }, asEnv([SUPER]))).status).toBe(403)
    _resetSuperadminAllowlistCache() // the instance refreshes its cached list from central
    expect((await patchMe(cookie, { name: 'X' }, asEnv([]))).status).toBe(200)
  })
})
