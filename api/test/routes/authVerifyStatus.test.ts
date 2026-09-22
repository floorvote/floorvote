import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { app } from '../../src/index'
import { resetDb, applyMigrations, seedUser, seedMagicLink } from '../helpers'
import { getDb } from '../../src/db/client'
import { magicLinks, authEvents } from '../../src/db/schema'

const status = (token?: string) =>
  app.request(`/api/auth/verify/status${token === undefined ? '' : `?token=${encodeURIComponent(token)}`}`, {}, env)

describe('GET /auth/verify/status', () => {
  let userId: string
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    userId = await seedUser({ email: 'owner@example.com' })
  })

  it('reports a live token as valid, and names its owner', async () => {
    const token = await seedMagicLink(userId, { used: false })
    const res = await status(token)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'valid', email: 'owner@example.com' })
  })

  // Whoever holds a LIVE token could learn the address by spending it. That
  // argument dies with the token: a spent one must not be a lookup key.
  it('reports a used token without naming anyone', async () => {
    const token = await seedMagicLink(userId, { used: true })
    expect(await (await status(token)).json()).toEqual({ status: 'used' })
  })

  it('reports an expired token without naming anyone', async () => {
    const token = await seedMagicLink(userId, { expired: true })
    expect(await (await status(token)).json()).toEqual({ status: 'expired' })
  })

  it('reports an unknown token as invalid', async () => {
    expect(await (await status('nope')).json()).toEqual({ status: 'invalid' })
  })

  it('requires a token', async () => {
    expect((await status()).status).toBe(400)
  })

  // The whole point: asking must not cost the user their link.
  it('does not consume the token — a second call still reports valid', async () => {
    const token = await seedMagicLink(userId, { used: false })
    expect(await (await status(token)).json()).toEqual({ status: 'valid', email: 'owner@example.com' })
    expect(await (await status(token)).json()).toEqual({ status: 'valid', email: 'owner@example.com' })
  })

  it('writes nothing at all', async () => {
    const token = await seedMagicLink(userId, { used: false })
    await status(token)
    const db = getDb(env.DB)
    const links = await db.select().from(magicLinks).all()
    expect(links.every(l => l.usedAt === null)).toBe(true)
    expect(await db.select().from(authEvents).all()).toEqual([])
  })
})

describe('GET /auth/verify/status rate limiting', () => {
  beforeEach(async () => { await resetDb(); await applyMigrations() })

  /** Records every key it is asked about, and denies the ones told to. */
  function limiter(deny: (key: string) => boolean) {
    const keys: string[] = []
    return {
      keys,
      binding: { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: !deny(key) } } },
    }
  }

  it('429s when its own bucket is exhausted', async () => {
    const l = limiter(() => true)
    const res = await app.request('/api/auth/verify/status?token=x', {},
      { ...env, LOGIN_RATE_LIMITER: l.binding })
    expect(res.status).toBe(429)
    expect(l.keys).toEqual(['verify-status:unknown'])
  })

  // Sharing magic-link's bucket would let status checks lock someone out of
  // requesting an actual login link.
  it('does not spend the magic-link bucket', async () => {
    const l = limiter(k => k.startsWith('magic-link:'))
    const res = await app.request('/api/auth/verify/status?token=x', {},
      { ...env, LOGIN_RATE_LIMITER: l.binding })
    expect(res.status).not.toBe(429)
    expect(l.keys.some(k => k.startsWith('magic-link:'))).toBe(false)
  })

  // Dev and tests run without the binding; it must not become a hard dependency.
  it('fails open when the binding is absent', async () => {
    const res = await app.request('/api/auth/verify/status?token=x', {},
      { ...env, LOGIN_RATE_LIMITER: undefined })
    expect(res.status).toBe(200)
  })
})
