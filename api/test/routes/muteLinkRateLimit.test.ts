import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../../src/index'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { isBillMuted, muteLinkTokens } from '../../src/lib/billMutes'

// Rate limit on POST /api/mute-link (#531). The route is unauthenticated and
// checks an HMAC before it does anything else, so it can be hammered to burn
// Worker CPU. It shares the LOGIN_RATE_LIMITER binding with the auth routes,
// under its own `mute-link:<ip>` key, and a refused request is a 429 before the
// token is read.
//
// The key is the client IP alone, not IP plus token. A token in the key would
// let a flooder vary the token on every request and never hit the cap, which is
// the exact traffic the limit exists for. Per-IP also leaves a member's link
// untouched by someone on another address.
describe('POST /api/mute-link rate limiting', () => {
  let ben: string
  let billId: string
  let validToken: string

  /** A stand-in for the Workers Rate Limiting binding. Records each key it is
   *  asked about and denies the ones `deny` names. */
  function limiter(deny: (key: string) => boolean = () => false) {
    const keys: string[] = []
    return {
      keys,
      binding: { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: !deny(key) } } },
    }
  }

  /** The way the binding really behaves: `max` calls per window, then refusals
   *  until the window rolls over. `rollWindow` is the clock reaching that point. */
  function windowedLimiter(max: number) {
    const counts = new Map<string, number>()
    return {
      rollWindow: () => counts.clear(),
      binding: {
        limit: async ({ key }: { key: string }) => {
          const n = (counts.get(key) ?? 0) + 1
          counts.set(key, n)
          return { success: n <= max }
        },
      },
    }
  }

  type Binding = { limit(opts: { key: string }): Promise<{ success: boolean }> }
  const post = (
    path: string,
    opts: { limiter?: Binding; ip?: string; body?: unknown; raw?: { body: string; contentType: string } } = {},
  ) => {
    const headers: Record<string, string> = { 'Content-Type': opts.raw?.contentType ?? 'application/json' }
    if (opts.ip) headers['CF-Connecting-IP'] = opts.ip
    return app.request(path, {
      method: 'POST',
      headers,
      body: opts.raw ? opts.raw.body : opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }, { ...env, LOGIN_RATE_LIMITER: opts.limiter })
  }
  const postToken = (token: string, opts: { limiter?: Binding; ip?: string } = {}) =>
    post('/api/mute-link', { ...opts, body: { token } })

  const forgedToken = () => `${btoa(JSON.stringify([ben, billId]))}.${'A'.repeat(43)}`
  const muted = () => isBillMuted(getDb(env.DB), ben, billId)

  beforeEach(async () => {
    await resetDb(); await applyMigrations()
    ben = await seedUser({ name: 'Ben', email: 'ben@example.com' })
    billId = await seedBill({ billNumber: 'HB 1' })
    validToken = await (await muteLinkTokens(getDb(env.DB)))(ben, billId)
  })

  describe('when the limiter refuses', () => {
    it('answers 429 and mutes nothing, even with a valid token in the body', async () => {
      const res = await postToken(validToken, { limiter: limiter(() => true).binding })
      expect(res.status).toBe(429)
      expect(await muted()).toBe(false)
    })

    it('answers 429 and mutes nothing, even with a valid token in the query', async () => {
      const res = await post(`/api/mute-link?token=${encodeURIComponent(validToken)}`, { limiter: limiter(() => true).binding })
      expect(res.status).toBe(429)
      expect(await muted()).toBe(false)
    })

    it('limits the mail client\'s one-click form post (RFC 8058) the same way', async () => {
      const res = await post(`/api/mute-link?token=${encodeURIComponent(validToken)}`, {
        limiter: limiter(() => true).binding,
        raw: { body: 'List-Unsubscribe=One-Click', contentType: 'application/x-www-form-urlencoded' },
      })
      expect(res.status).toBe(429)
      expect(await muted()).toBe(false)
    })

    // The 429 comes before the token is read, so it can't tell a flooder which
    // tokens are real: a valid token, a forged one, a garbled one, and none at
    // all get the same status, the same body, and the same headers that matter.
    it('answers a valid, forged, garbled, and missing token identically', async () => {
      const refuse = limiter(() => true).binding
      const responses = await Promise.all([
        postToken(validToken, { limiter: refuse }),
        postToken(forgedToken(), { limiter: refuse }),
        postToken('not-a-token', { limiter: refuse }),
        post('/api/mute-link', { limiter: refuse, body: {} }),
        post('/api/mute-link', { limiter: refuse }),
      ])
      const bodies = await Promise.all(responses.map(r => r.text()))
      for (const r of responses) expect(r.status).toBe(429)
      for (const b of bodies) expect(b).toBe(bodies[0])
      for (const r of responses) {
        expect(r.headers.get('content-type')).toBe(responses[0].headers.get('content-type'))
      }
      expect(Object.keys(JSON.parse(bodies[0]))).toEqual(['error'])
      // And the body is the limiter's, not the route's "not valid" 404 text.
      expect(bodies[0]).not.toContain('not valid')
    })

    it('limits before the body-size check, so an oversized flood is limited too', async () => {
      const res = await post('/api/mute-link', {
        limiter: limiter(() => true).binding,
        raw: { body: JSON.stringify({ token: 'x'.repeat(8 * 1024) }), contentType: 'application/json' },
      })
      expect(res.status).toBe(429)
    })
  })

  describe('when the limiter allows', () => {
    it('mutes with a valid token, as before', async () => {
      const res = await postToken(validToken, { limiter: limiter().binding })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ billNumber: 'HB 1' })
      expect(await muted()).toBe(true)
    })

    it('mutes from the query token and the one-click form body, as before', async () => {
      const res = await post(`/api/mute-link?token=${encodeURIComponent(validToken)}`, {
        limiter: limiter().binding,
        raw: { body: 'List-Unsubscribe=One-Click', contentType: 'application/x-www-form-urlencoded' },
      })
      expect(res.status).toBe(200)
      expect(await muted()).toBe(true)
    })

    it('answers a forged token with the same 404 and body as without a limiter', async () => {
      const withLimiter = await postToken(forgedToken(), { limiter: limiter().binding })
      const without = await postToken(forgedToken(), { limiter: undefined })
      expect(withLimiter.status).toBe(404)
      expect(without.status).toBe(404)
      expect(await withLimiter.text()).toBe(await without.text())
      expect(await muted()).toBe(false)
    })

    it('answers a garbled and a missing token with the same 404', async () => {
      const ok = limiter().binding
      expect((await postToken('not-a-token', { limiter: ok })).status).toBe(404)
      expect((await post('/api/mute-link', { limiter: ok, body: {} })).status).toBe(404)
    })
  })

  describe('the limiter key', () => {
    it('is the CF-Connecting-IP, namespaced to this route', async () => {
      const l = limiter()
      await postToken(validToken, { limiter: l.binding, ip: '203.0.113.7' })
      expect(l.keys).toEqual(['mute-link:203.0.113.7'])
    })

    it('falls back to a shared "unknown" bucket with no CF-Connecting-IP, like the auth routes', async () => {
      const l = limiter()
      await postToken(validToken, { limiter: l.binding })
      expect(l.keys).toEqual(['mute-link:unknown'])
    })

    it('does not include the token, so varying the token cannot dodge the limit', async () => {
      const l = limiter()
      await postToken(validToken, { limiter: l.binding, ip: '203.0.113.7' })
      await postToken(forgedToken(), { limiter: l.binding, ip: '203.0.113.7' })
      await postToken('another-garbled-one', { limiter: l.binding, ip: '203.0.113.7' })
      expect(new Set(l.keys)).toEqual(new Set(['mute-link:203.0.113.7']))
    })

    it('asks the limiter exactly once per request', async () => {
      const l = limiter()
      await postToken(validToken, { limiter: l.binding, ip: '203.0.113.7' })
      expect(l.keys).toHaveLength(1)
    })

    // One address flooding the route must not stop a member on another address
    // from using their link.
    it('lets a member on another IP mute while an attacker\'s IP is limited', async () => {
      const l = limiter(k => k === 'mute-link:198.51.100.9')
      const attacker = await postToken(forgedToken(), { limiter: l.binding, ip: '198.51.100.9' })
      const member = await postToken(validToken, { limiter: l.binding, ip: '203.0.113.7' })
      expect(attacker.status).toBe(429)
      expect(member.status).toBe(200)
      expect(await muted()).toBe(true)
    })

    // Sharing the login bucket would let a burst of mute clicks (or a flood at
    // this route) lock someone out of requesting a login link.
    it('does not spend the magic-link or verify-status buckets', async () => {
      const l = limiter(k => !k.startsWith('mute-link:'))
      const res = await postToken(validToken, { limiter: l.binding, ip: '203.0.113.7' })
      // Only the mute-link key was asked about, so denying every other key changes nothing.
      expect(l.keys).toHaveLength(1)
      expect(l.keys.every(k => k.startsWith('mute-link:'))).toBe(true)
      expect(res.status).toBe(200)
    })

    it('is not refused by a limiter that has only exhausted other routes\' buckets', async () => {
      const l = limiter(k => k.startsWith('magic-link:') || k.startsWith('verify-status:'))
      const res = await postToken(validToken, { limiter: l.binding, ip: '203.0.113.7' })
      expect(res.status).toBe(200)
      expect(await muted()).toBe(true)
    })
  })

  describe('over a window', () => {
    it('refuses once the cap is spent, then mutes again after the window rolls over', async () => {
      const w = windowedLimiter(2)
      const ip = '203.0.113.7'
      // Two forged clicks spend the cap...
      expect((await postToken(forgedToken(), { limiter: w.binding, ip })).status).toBe(404)
      expect((await postToken(forgedToken(), { limiter: w.binding, ip })).status).toBe(404)
      // ...so a valid click inside the window is refused and mutes nothing...
      expect((await postToken(validToken, { limiter: w.binding, ip })).status).toBe(429)
      expect(await muted()).toBe(false)
      // ...and once the window rolls, the same valid link works. The route holds
      // no state of its own, so a refusal is never remembered.
      w.rollWindow()
      const res = await postToken(validToken, { limiter: w.binding, ip })
      expect(res.status).toBe(200)
      expect(await muted()).toBe(true)
    })

    it('a valid click under the cap still mutes', async () => {
      const w = windowedLimiter(2)
      const res = await postToken(validToken, { limiter: w.binding, ip: '203.0.113.7' })
      expect(res.status).toBe(200)
      expect(await muted()).toBe(true)
    })
  })

  describe('without a working limiter', () => {
    it('fails open when the binding is absent, and mutes as it does today', async () => {
      const res = await postToken(validToken, { limiter: undefined })
      expect(res.status).toBe(200)
      expect(await muted()).toBe(true)
    })

    it('fails open when the limiter throws', async () => {
      const throwing = { limit: async () => { throw new Error('limiter unavailable') } }
      const res = await postToken(validToken, { limiter: throwing })
      expect(res.status).toBe(200)
      expect(await muted()).toBe(true)
    })

    it('still answers a forged token with 404 when the binding is absent', async () => {
      expect((await postToken(forgedToken(), { limiter: undefined })).status).toBe(404)
    })
  })

  describe('other requests', () => {
    // RFC 8058: only the POST mutes. GET and HEAD, which mail scanners use, are
    // not routed here, so they neither mute nor spend the limiter.
    it('does not mute or consult the limiter for GET or HEAD', async () => {
      const l = limiter()
      const path = `/api/mute-link?token=${encodeURIComponent(validToken)}`
      for (const method of ['GET', 'HEAD']) {
        await app.request(path, { method }, { ...env, LOGIN_RATE_LIMITER: l.binding })
      }
      expect(l.keys).toEqual([])
      expect(await muted()).toBe(false)
    })

    it('leaves the authenticated mute untouched, and does not consult the limiter', async () => {
      const cookie = `session=${await seedSession(ben)}`
      const l = limiter(() => true)
      const res = await app.request(`/api/bills/${billId}/mute`, { method: 'PUT', headers: { Cookie: cookie } },
        { ...env, LOGIN_RATE_LIMITER: l.binding })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ muted: true })
      expect(l.keys).toEqual([])
      expect(await muted()).toBe(true)

      const del = await app.request(`/api/bills/${billId}/mute`, { method: 'DELETE', headers: { Cookie: cookie } },
        { ...env, LOGIN_RATE_LIMITER: l.binding })
      expect(del.status).toBe(200)
      expect(await muted()).toBe(false)
      expect(l.keys).toEqual([])
    })
  })
})
