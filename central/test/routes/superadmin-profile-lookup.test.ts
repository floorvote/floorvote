import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { app, TenantApi } from '../../src/index-legiscan'
import { setupLsDb } from '../helpers/setupLsDb'
import { saveSuperadminProfile } from '../../src/lib/superadminProfile'

// The profile lookup an instance makes when a superadmin signs in by emailed link.
// It answers only for a superadmin and only to an authenticated instance, and a
// caller who isn't told learns nothing about who is on the list.

const SUPER = 'admin@example.com'
const SUPER_NO_PROFILE = 'quiet@example.com'
const REMOVED = 'former@example.com'
const MEMBER = 'member@example.com'

const TEST_ENV: any = {
  ...env,
  ADMIN_SECRET: 'admin-secret',
  SUPERADMIN_EMAILS: `${SUPER}, ${SUPER_NO_PROFILE}`,
}

const db = () => drizzle(env.DB, { schema })

function lookup(email: unknown, headers: Record<string, string> = { 'x-admin-secret': 'admin-secret' }, e = TEST_ENV) {
  return app.fetch(
    new Request('http://central/api/admin/superadmin/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ email }),
    }),
    e,
  )
}

// TEST_ENV with every SQL statement central prepares recorded in `sqls`.
function countingEnv(sqls: string[]) {
  return {
    ...TEST_ENV,
    DB: new Proxy(env.DB, {
      get(target, prop) {
        const v = Reflect.get(target, prop)
        if (prop === 'prepare') return (q: string) => { sqls.push(q); return v.call(target, q) }
        return typeof v === 'function' ? v.bind(target) : v
      },
    }),
  }
}

async function answer(res: Response) {
  return { status: res.status, body: await res.text() }
}

beforeEach(async () => {
  await setupLsDb()
  await saveSuperadminProfile(db(), SUPER, { name: 'Ada Lovelace', title: 'Operator support' })
  // Someone who set a profile and was later taken off the list.
  await saveSuperadminProfile(db(), REMOVED, { name: 'Former Staff', title: 'Ex-support' })
})

describe('POST /api/admin/superadmin/profile', () => {
  it('returns the saved name and title for a superadmin', async () => {
    const res = await lookup(SUPER)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ profile: { name: 'Ada Lovelace', title: 'Operator support' } })
  })

  it('matches the address regardless of case and surrounding space', async () => {
    expect(await answer(await lookup('  Admin@Example.COM '))).toEqual({
      status: 200,
      body: JSON.stringify({ profile: { name: 'Ada Lovelace', title: 'Operator support' } }),
    })
  })

  it('answers a non-superadmin exactly as it answers a superadmin with no saved profile', async () => {
    const member = await answer(await lookup(MEMBER))
    const quiet = await answer(await lookup(SUPER_NO_PROFILE))
    expect(member).toEqual({ status: 200, body: JSON.stringify({ profile: null }) })
    expect(quiet).toEqual(member)
  })

  it('does not return the profile of someone no longer on the superadmin list', async () => {
    const removed = await answer(await lookup(REMOVED))
    expect(removed).toEqual({ status: 200, body: JSON.stringify({ profile: null }) })
    expect(removed.body).not.toContain('Former Staff')
  })

  it('treats a missing or malformed email like a non-superadmin', async () => {
    const member = { status: 200, body: JSON.stringify({ profile: null }) }
    expect(await answer(await lookup(undefined))).toEqual(member)
    expect(await answer(await lookup(42))).toEqual(member)
  })

  it('runs the same database work for a superadmin and a non-superadmin, so timing tells nothing', async () => {
    const superQueries: string[] = []
    const memberQueries: string[] = []
    await lookup(SUPER, undefined, countingEnv(superQueries))
    await lookup(MEMBER, undefined, countingEnv(memberQueries))
    expect(superQueries.length).toBeGreaterThan(0)
    expect(memberQueries).toEqual(superQueries)
  })

  describe('an unauthenticated caller', () => {
    it('is refused without the admin secret, identically for a superadmin and anyone else', async () => {
      // The same request with the secret is answered, so the refusal is the auth check.
      expect((await lookup(SUPER)).status).toBe(200)
      const forSuper = await answer(await lookup(SUPER, {}))
      const forMember = await answer(await lookup(MEMBER, {}))
      expect(forSuper.status).toBe(401)
      expect(forSuper).toEqual(forMember)
      expect(forSuper.body).not.toContain('Ada')
    })

    it('is refused with a wrong admin secret, identically for a superadmin and anyone else', async () => {
      expect((await lookup(SUPER)).status).toBe(200)
      const forSuper = await answer(await lookup(SUPER, { 'x-admin-secret': 'wrong' }))
      const forMember = await answer(await lookup(MEMBER, { 'x-admin-secret': 'wrong' }))
      expect(forSuper.status).toBe(401)
      expect(forSuper).toEqual(forMember)
    })

    it('reads nothing from the database before refusing', async () => {
      const authed: string[] = []
      await lookup(SUPER, undefined, countingEnv(authed))
      expect(authed.length).toBeGreaterThan(0)
      const sqls: string[] = []
      await lookup(SUPER, {}, countingEnv(sqls))
      expect(sqls).toEqual([])
    })
  })

  describe('through the instance service binding', () => {
    const ctx: any = { waitUntil: () => {}, passThroughOnException: () => {} }
    const viaBinding = (email: string) =>
      new TenantApi(ctx, TEST_ENV).fetch(
        new Request('https://central/api/admin/superadmin/profile', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email }),
        }),
      )

    it('is reachable by an instance, which the binding authenticates', async () => {
      const res = await viaBinding(SUPER)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ profile: { name: 'Ada Lovelace', title: 'Operator support' } })
    })

    it('answers a non-superadmin with no profile', async () => {
      expect(await (await viaBinding(MEMBER)).json()).toEqual({ profile: null })
    })
  })
})
