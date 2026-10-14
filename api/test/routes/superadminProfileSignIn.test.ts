import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { app } from '../../src/index'
import { resetDb, applyMigrations, seedUser, seedMagicLink } from '../helpers'
import { getDb } from '../../src/db/client'
import { users } from '../../src/db/schema'
import { _resetSuperadminAllowlistCache } from '../../src/lib/superadminCentral'

// A superadmin who signs in to an instance by emailed link gets the instance's
// copy of their name and title refreshed from central. Central is stubbed here.

const SUPER = 'super@example.com'
const MEMBER = 'member@example.com'

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

type ProfileAnswer = (email: string) => Response | Promise<Response>

// Central's superadmin list (as hashes) and its profile lookup, recording each
// profile lookup the instance makes.
function central(list: string[], profileAnswer: ProfileAnswer) {
  const lookups: { method: string; url: string; email: unknown }[] = []
  const binding = {
    fetch: async (req: Request) => {
      const { pathname } = new URL(req.url)
      if (pathname === '/api/admin/superadmin/emails') {
        return new Response(JSON.stringify({ hashes: await Promise.all(list.map(sha256Hex)) }), { status: 200 })
      }
      if (pathname === '/api/admin/superadmin/profile') {
        const body = await req.json<{ email?: unknown }>().catch(() => ({} as { email?: unknown }))
        lookups.push({ method: req.method, url: req.url, email: body.email })
        return profileAnswer(String(body.email))
      }
      return new Response('not found', { status: 404 })
    },
  }
  return { env: { ...env, CENTRAL: binding } as unknown as typeof env, lookups }
}

const profileOf = (name: string, title: string): ProfileAnswer => () =>
  new Response(JSON.stringify({ profile: { name, title } }), { status: 200 })
const noProfile: ProfileAnswer = () => new Response(JSON.stringify({ profile: null }), { status: 200 })

async function signInByLink(email: string, e: typeof env) {
  const user = await getDb(env.DB).select().from(users).where(eq(users.email, email)).get()
  const token = await seedMagicLink(user!.id)
  const res = await app.request('/api/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  }, e)
  const session = /session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1]
  return { res, session }
}

const userRow = async (email: string) =>
  getDb(env.DB).select().from(users).where(eq(users.email, email)).get()

beforeEach(async () => {
  await resetDb()
  await applyMigrations()
  _resetSuperadminAllowlistCache()
})

describe('emailed-link sign-in by a superadmin', () => {
  it('updates the instance name and title from central', async () => {
    await seedUser({ email: SUPER, role: 'admin', name: '', subtitle: undefined })
    const c = central([SUPER], profileOf('Ada Lovelace', 'Operator support'))
    const { res, session } = await signInByLink(SUPER, c.env)
    expect(res.status).toBe(200)

    const row = await userRow(SUPER)
    expect([row?.name, row?.subtitle]).toEqual(['Ada Lovelace', 'Operator support'])
    const me = await app.request('/api/auth/me', { headers: { Cookie: `session=${session}` } }, c.env)
    const body = (await me.json()) as { name: string; subtitle: string | null }
    expect([body.name, body.subtitle]).toEqual(['Ada Lovelace', 'Operator support'])
  })

  it('overwrites a stale copy, and clears the title when central has a blank one', async () => {
    await seedUser({ email: SUPER, role: 'admin', name: 'Old Name', subtitle: 'Old title' })
    const { res } = await signInByLink(SUPER, central([SUPER], profileOf('Ada King', '')).env)
    expect(res.status).toBe(200)
    const row = await userRow(SUPER)
    expect([row?.name, row?.subtitle]).toEqual(['Ada King', null])
  })

  it('asks central for that one address, in the request body rather than the URL', async () => {
    await seedUser({ email: SUPER, role: 'admin' })
    const c = central([SUPER], profileOf('Ada', 'Support'))
    await signInByLink(SUPER, c.env)
    expect(c.lookups).toHaveLength(1)
    expect(c.lookups[0].method).toBe('POST')
    expect(c.lookups[0].email).toBe(SUPER)
    expect(new URL(c.lookups[0].url).search).toBe('')
    expect(decodeURIComponent(c.lookups[0].url)).not.toContain(SUPER)
  })

  it('keeps the existing name and title when central has no profile for them', async () => {
    await seedUser({ email: SUPER, role: 'admin', name: 'Existing', subtitle: 'Kept' })
    const c = central([SUPER], noProfile)
    const { res } = await signInByLink(SUPER, c.env)
    expect(res.status).toBe(200)
    expect(c.lookups).toHaveLength(1)
    const row = await userRow(SUPER)
    expect([row?.name, row?.subtitle]).toEqual(['Existing', 'Kept'])
  })

  it('keeps the existing values when central answers with something malformed', async () => {
    await seedUser({ email: SUPER, role: 'admin', name: 'Existing', subtitle: 'Kept' })
    const c = central([SUPER], () => new Response(JSON.stringify({ profile: { name: 7 } }), { status: 200 }))
    const { res } = await signInByLink(SUPER, c.env)
    expect(res.status).toBe(200)
    expect(c.lookups).toHaveLength(1)
    const row = await userRow(SUPER)
    expect([row?.name, row?.subtitle]).toEqual(['Existing', 'Kept'])
  })
})

describe('emailed-link sign-in when central cannot be reached', () => {
  async function expectSignedInWithValuesKept(c: ReturnType<typeof central>) {
    await seedUser({ email: SUPER, role: 'admin', name: 'Existing', subtitle: 'Kept' })
    const { res, session } = await signInByLink(SUPER, c.env)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true)
    expect(session).toBeTruthy()
    const row = await userRow(SUPER)
    expect([row?.name, row?.subtitle]).toEqual(['Existing', 'Kept'])
  }

  it('signs in and keeps the values when the profile lookup errors', async () => {
    const c = central([SUPER], () => new Response('boom', { status: 500 }))
    await expectSignedInWithValuesKept(c)
    expect(c.lookups).toHaveLength(1)
  })

  it('signs in and keeps the values when the profile lookup throws', async () => {
    const c = central([SUPER], () => { throw new Error('network down') })
    await expectSignedInWithValuesKept(c)
    expect(c.lookups).toHaveLength(1)
  })

  it('signs in and keeps the values when central does not know the lookup yet', async () => {
    // A central deployed before this change: the service binding refuses the path.
    const c = central([SUPER], () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }))
    await expectSignedInWithValuesKept(c)
    expect(c.lookups).toHaveLength(1)
  })

  it('signs in without waiting on a lookup that never answers', async () => {
    const c = central([SUPER], () => new Promise<Response>(() => {}))
    const started = Date.now()
    await expectSignedInWithValuesKept(c)
    expect(c.lookups).toHaveLength(1)
    expect(Date.now() - started).toBeLessThan(4000)
  })

  it('signs in and keeps the last values when central goes down after an earlier sign-in', async () => {
    await seedUser({ email: SUPER, role: 'admin', name: '', subtitle: undefined })
    let down = false
    const c = central([SUPER], profileOf('Ada Lovelace', 'Operator support'))
    const flaky = { ...c.env, CENTRAL: { fetch: (req: Request) => {
      if (down) throw new Error('unreachable')
      return (c.env as unknown as { CENTRAL: { fetch: (r: Request) => Promise<Response> } }).CENTRAL.fetch(req)
    } } } as unknown as typeof env
    await signInByLink(SUPER, flaky)
    expect((await userRow(SUPER))?.name).toBe('Ada Lovelace')

    down = true
    const { res, session } = await signInByLink(SUPER, flaky)
    expect(res.status).toBe(200)
    expect(session).toBeTruthy()
    const row = await userRow(SUPER)
    expect([row?.name, row?.subtitle]).toEqual(['Ada Lovelace', 'Operator support'])
  })
})

describe('emailed-link sign-in by an ordinary member', () => {
  it('signs in as before, never asks central for a profile, and leaves name and title alone', async () => {
    // The same stub does answer a superadmin's sign-in, so the silence below is the instance's choice.
    await seedUser({ email: SUPER, role: 'admin' })
    const live = central([SUPER], profileOf('Ada', 'Support'))
    await signInByLink(SUPER, live.env)
    expect(live.lookups).toHaveLength(1)

    for (const role of ['member', 'admin', 'owner'] as const) {
      const email = `${role}-${MEMBER}`
      await seedUser({ email, role, name: 'Pat Member', subtitle: 'Clerk' })
      const c = central([SUPER], profileOf('Should Not', 'Apply'))
      const { res, session } = await signInByLink(email, c.env)
      expect(res.status).toBe(200)
      expect(session).toBeTruthy()
      expect(c.lookups).toHaveLength(0)
      const row = await userRow(email)
      expect([row?.name, row?.subtitle]).toEqual(['Pat Member', 'Clerk'])
    }
  })
})
