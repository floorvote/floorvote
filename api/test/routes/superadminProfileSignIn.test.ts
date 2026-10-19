import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { app } from '../../src/index'
import { clearDb, seedUser, seedMagicLink } from '../helpers'
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
// `listAnswer` replaces the list fetch, to stand in for a central that is down.
function central(list: string[], profileAnswer: ProfileAnswer, listAnswer?: () => Response | Promise<Response>) {
  const lookups: { method: string; url: string; email: unknown }[] = []
  const binding = {
    fetch: async (req: Request) => {
      const { pathname } = new URL(req.url)
      if (pathname === '/api/admin/superadmin/emails') {
        if (listAnswer) return listAnswer()
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

// An execution context that collects what is handed to waitUntil, as the
// Workers runtime would hold it past the response. Without one (the default
// here, as in most route tests) c.executionCtx is unavailable.
function collectingCtx() {
  const pending: Promise<unknown>[] = []
  const ctx = {
    waitUntil: (p: Promise<unknown>) => { pending.push(p) },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext
  return { ctx, pending, settled: () => Promise.all(pending.splice(0)) }
}

async function signInByLink(email: string, e: typeof env, ctx?: ExecutionContext) {
  const user = await getDb(env.DB).select().from(users).where(eq(users.email, email)).get()
  const token = await seedMagicLink(user!.id)
  const res = await app.request('/api/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  }, e, ctx)
  const session = /session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1]
  return { res, session }
}

const userRow = async (email: string) =>
  getDb(env.DB).select().from(users).where(eq(users.email, email)).get()

beforeEach(async () => {
  await clearDb()
  _resetSuperadminAllowlistCache()
})

describe('emailed-link sign-in by a superadmin', () => {
  it('updates the instance name and title from central', async () => {
    await seedUser({ email: SUPER, role: 'admin', name: '', title: undefined })
    const c = central([SUPER], profileOf('Ada Lovelace', 'Operator support'))
    const { res, session } = await signInByLink(SUPER, c.env)
    expect(res.status).toBe(200)

    const row = await userRow(SUPER)
    expect([row?.name, row?.title]).toEqual(['Ada Lovelace', 'Operator support'])
    const me = await app.request('/api/auth/me', { headers: { Cookie: `session=${session}` } }, c.env)
    const body = (await me.json()) as { name: string; title: string | null }
    expect([body.name, body.title]).toEqual(['Ada Lovelace', 'Operator support'])
  })

  it('overwrites a stale copy, and clears the title when central has a blank one', async () => {
    await seedUser({ email: SUPER, role: 'admin', name: 'Old Name', title: 'Old title' })
    const { res } = await signInByLink(SUPER, central([SUPER], profileOf('Ada King', '')).env)
    expect(res.status).toBe(200)
    const row = await userRow(SUPER)
    expect([row?.name, row?.title]).toEqual(['Ada King', null])
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
    await seedUser({ email: SUPER, role: 'admin', name: 'Existing', title: 'Kept' })
    const c = central([SUPER], noProfile)
    const { res } = await signInByLink(SUPER, c.env)
    expect(res.status).toBe(200)
    expect(c.lookups).toHaveLength(1)
    const row = await userRow(SUPER)
    expect([row?.name, row?.title]).toEqual(['Existing', 'Kept'])
  })

  it('keeps the existing values when central answers with something malformed', async () => {
    await seedUser({ email: SUPER, role: 'admin', name: 'Existing', title: 'Kept' })
    const c = central([SUPER], () => new Response(JSON.stringify({ profile: { name: 7 } }), { status: 200 }))
    const { res } = await signInByLink(SUPER, c.env)
    expect(res.status).toBe(200)
    expect(c.lookups).toHaveLength(1)
    const row = await userRow(SUPER)
    expect([row?.name, row?.title]).toEqual(['Existing', 'Kept'])
  })
})

describe('emailed-link sign-in when central cannot be reached', () => {
  async function expectSignedInWithValuesKept(c: ReturnType<typeof central>) {
    await seedUser({ email: SUPER, role: 'admin', name: 'Existing', title: 'Kept' })
    const { res, session } = await signInByLink(SUPER, c.env)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true)
    expect(session).toBeTruthy()
    const row = await userRow(SUPER)
    expect([row?.name, row?.title]).toEqual(['Existing', 'Kept'])
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
    await seedUser({ email: SUPER, role: 'admin', name: '', title: undefined })
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
    expect([row?.name, row?.title]).toEqual(['Ada Lovelace', 'Operator support'])
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
      await seedUser({ email, role, name: 'Pat Member', title: 'Clerk' })
      const c = central([SUPER], profileOf('Should Not', 'Apply'))
      const { res, session } = await signInByLink(email, c.env)
      expect(res.status).toBe(200)
      expect(session).toBeTruthy()
      expect(c.lookups).toHaveLength(0)
      const row = await userRow(email)
      expect([row?.name, row?.title]).toEqual(['Pat Member', 'Clerk'])
    }
  })
})

// The member's sign-in must never wait on central, so the superadmin check and
// the profile refresh run off the response path, in waitUntil. The superadmin's
// name and title then update in the background and show on their next page load.
describe('emailed-link sign-in does not wait on central', () => {
  const PROMPT_MS = 1000

  it('returns a member promptly while central never answers the list, and hands the work to waitUntil', async () => {
    await seedUser({ email: MEMBER, role: 'member', name: 'Pat Member', title: 'Clerk' })
    const c = central([SUPER], profileOf('Should Not', 'Apply'), () => new Promise<Response>(() => {}))
    const bg = collectingCtx()
    const started = Date.now()
    const { res, session } = await signInByLink(MEMBER, c.env, bg.ctx)
    expect(Date.now() - started).toBeLessThan(PROMPT_MS)
    expect(res.status).toBe(200)
    expect(session).toBeTruthy()
    expect(bg.pending).toHaveLength(1)

    await bg.settled()
    expect(c.lookups).toHaveLength(0)
    const row = await userRow(MEMBER)
    expect([row?.name, row?.title]).toEqual(['Pat Member', 'Clerk'])
  })

  it('returns a superadmin promptly while central never answers the profile, and hands the work to waitUntil', async () => {
    await seedUser({ email: SUPER, role: 'admin', name: 'Existing', title: 'Kept' })
    const c = central([SUPER], () => new Promise<Response>(() => {}))
    const bg = collectingCtx()
    const started = Date.now()
    const { res, session } = await signInByLink(SUPER, c.env, bg.ctx)
    expect(Date.now() - started).toBeLessThan(PROMPT_MS)
    expect(res.status).toBe(200)
    expect(session).toBeTruthy()
    expect(bg.pending).toHaveLength(1)

    await bg.settled()
    expect(c.lookups).toHaveLength(1)
    const row = await userRow(SUPER)
    expect([row?.name, row?.title]).toEqual(['Existing', 'Kept'])
  })

  it('updates a superadmin in the background when central is up, shown by the next page load', async () => {
    await seedUser({ email: SUPER, role: 'admin', name: '', title: undefined })
    const c = central([SUPER], profileOf('Ada Lovelace', 'Operator support'))
    const bg = collectingCtx()
    const { res, session } = await signInByLink(SUPER, c.env, bg.ctx)
    expect(res.status).toBe(200)
    expect(bg.pending).toHaveLength(1)

    await bg.settled()
    const row = await userRow(SUPER)
    expect([row?.name, row?.title]).toEqual(['Ada Lovelace', 'Operator support'])
    const me = await app.request('/api/auth/me', { headers: { Cookie: `session=${session}` } }, c.env)
    const body = (await me.json()) as { name: string; title: string | null }
    expect([body.name, body.title]).toEqual(['Ada Lovelace', 'Operator support'])
  })

  it('keeps the existing values in the background when central is down', async () => {
    await seedUser({ email: SUPER, role: 'admin', name: 'Existing', title: 'Kept' })
    const c = central([SUPER], () => { throw new Error('network down') })
    const bg = collectingCtx()
    const { res, session } = await signInByLink(SUPER, c.env, bg.ctx)
    expect(res.status).toBe(200)
    expect(session).toBeTruthy()
    expect(bg.pending).toHaveLength(1)

    await expect(bg.settled()).resolves.toBeDefined()
    expect(c.lookups).toHaveLength(1)
    const row = await userRow(SUPER)
    expect([row?.name, row?.title]).toEqual(['Existing', 'Kept'])
  })

  it('keeps the existing values in the background when central has no profile', async () => {
    await seedUser({ email: SUPER, role: 'admin', name: 'Existing', title: 'Kept' })
    const c = central([SUPER], noProfile)
    const bg = collectingCtx()
    const { res } = await signInByLink(SUPER, c.env, bg.ctx)
    expect(res.status).toBe(200)
    expect(bg.pending).toHaveLength(1)

    await bg.settled()
    expect(c.lookups).toHaveLength(1)
    const row = await userRow(SUPER)
    expect([row?.name, row?.title]).toEqual(['Existing', 'Kept'])
  })

  it('never looks a non-superadmin up, even in the background', async () => {
    await seedUser({ email: MEMBER, role: 'member', name: 'Pat Member', title: 'Clerk' })
    const c = central([SUPER], profileOf('Should Not', 'Apply'))
    const bg = collectingCtx()
    const { res } = await signInByLink(MEMBER, c.env, bg.ctx)
    expect(res.status).toBe(200)
    await bg.settled()
    expect(c.lookups).toHaveLength(0)
    const row = await userRow(MEMBER)
    expect([row?.name, row?.title]).toEqual(['Pat Member', 'Clerk'])
  })
})

// Central's list is the instance's only way to recognize a superadmin. When it
// can't be fetched and nothing is cached, nobody is recognized: sign-in still
// succeeds, no lookup is made, and nothing is written.
describe('emailed-link sign-in when central\'s superadmin list cannot be fetched', () => {
  const failures: [string, () => Response | Promise<Response>][] = [
    ['throws', () => { throw new Error('network down') }],
    ['answers 500', () => new Response('boom', { status: 500 })],
    ['never answers', () => new Promise<Response>(() => {})],
  ]

  for (const [label, listAnswer] of failures) {
    it(`signs a superadmin in, looks nothing up, and writes nothing when the list fetch ${label} with nothing cached`, async () => {
      await seedUser({ email: SUPER, role: 'admin', name: 'Existing', title: 'Kept' })
      const c = central([SUPER], profileOf('Should Not', 'Apply'), listAnswer)
      const bg = collectingCtx()
      const { res, session } = await signInByLink(SUPER, c.env, bg.ctx)
      expect(res.status).toBe(200)
      expect(session).toBeTruthy()
      await bg.settled()
      expect(c.lookups).toHaveLength(0)
      const row = await userRow(SUPER)
      expect([row?.name, row?.title]).toEqual(['Existing', 'Kept'])
    })
  }

  it('signs a superadmin in with no waitUntil available, looking nothing up', async () => {
    await seedUser({ email: SUPER, role: 'admin', name: 'Existing', title: 'Kept' })
    const c = central([SUPER], profileOf('Should Not', 'Apply'), () => new Response('boom', { status: 500 }))
    const { res, session } = await signInByLink(SUPER, c.env)
    expect(res.status).toBe(200)
    expect(session).toBeTruthy()
    expect(c.lookups).toHaveLength(0)
    const row = await userRow(SUPER)
    expect([row?.name, row?.title]).toEqual(['Existing', 'Kept'])
  })

  it('signs a member in with nothing looked up and nothing written', async () => {
    await seedUser({ email: MEMBER, role: 'member', name: 'Pat Member', title: 'Clerk' })
    const c = central([SUPER], profileOf('Should Not', 'Apply'), () => new Response('boom', { status: 500 }))
    const bg = collectingCtx()
    const { res, session } = await signInByLink(MEMBER, c.env, bg.ctx)
    expect(res.status).toBe(200)
    expect(session).toBeTruthy()
    await bg.settled()
    expect(c.lookups).toHaveLength(0)
    const row = await userRow(MEMBER)
    expect([row?.name, row?.title]).toEqual(['Pat Member', 'Clerk'])
  })
})

// Central's list holds normalized addresses. A member's stored address, which
// the token is minted for, may differ in case or carry stray whitespace; the
// instance must still recognize them, and central normalizes the lookup.
describe('emailed-link sign-in with a mixed-case or padded stored address', () => {
  const normalizing: (name: string, title: string) => ProfileAnswer = (name, title) => (email) =>
    email.toLowerCase().trim() === SUPER
      ? new Response(JSON.stringify({ profile: { name, title } }), { status: 200 })
      : new Response(JSON.stringify({ profile: null }), { status: 200 })

  const stored = ['Super@Example.COM', '  super@example.com  ', ' Super@Example.com\t']
  for (const address of stored) {
    it(`recognizes a superadmin stored as ${JSON.stringify(address)} and refreshes their profile`, async () => {
      await seedUser({ email: address, role: 'admin', name: 'Old Name', title: 'Old title' })
      const c = central([SUPER], normalizing('Ada Lovelace', 'Operator support'))
      const bg = collectingCtx()
      const { res, session } = await signInByLink(address, c.env, bg.ctx)
      expect(res.status).toBe(200)
      expect(session).toBeTruthy()
      await bg.settled()

      expect(c.lookups).toHaveLength(1)
      expect(String(c.lookups[0].email).toLowerCase().trim()).toBe(SUPER)
      expect(new URL(c.lookups[0].url).search).toBe('')
      const row = await userRow(address)
      expect([row?.name, row?.title]).toEqual(['Ada Lovelace', 'Operator support'])
    })
  }

  it('recognizes a mixed-case superadmin with no waitUntil available', async () => {
    await seedUser({ email: 'Super@Example.COM', role: 'admin', name: 'Old Name', title: 'Old title' })
    const c = central([SUPER], normalizing('Ada Lovelace', 'Operator support'))
    const { res } = await signInByLink('Super@Example.COM', c.env)
    expect(res.status).toBe(200)
    expect(c.lookups).toHaveLength(1)
    const row = await userRow('Super@Example.COM')
    expect([row?.name, row?.title]).toEqual(['Ada Lovelace', 'Operator support'])
  })

  it('does not look up a mixed-case member who is not on the list', async () => {
    await seedUser({ email: 'Pat.Member@Example.COM', role: 'member', name: 'Pat Member', title: 'Clerk' })
    const c = central([SUPER], normalizing('Should Not', 'Apply'))
    const bg = collectingCtx()
    const { res } = await signInByLink('Pat.Member@Example.COM', c.env, bg.ctx)
    expect(res.status).toBe(200)
    await bg.settled()
    expect(c.lookups).toHaveLength(0)
    const row = await userRow('Pat.Member@Example.COM')
    expect([row?.name, row?.title]).toEqual(['Pat Member', 'Clerk'])
  })
})
