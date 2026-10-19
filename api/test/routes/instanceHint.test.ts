import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { app } from '../../src/index'
import { clearDb, seedUser, seedSession, seedMagicLink, stubFetch } from '../helpers'
import { parseInstanceHints, serializeInstanceHints } from '../../../shared/instanceHint'

// Central's superadmin allowlist is fetched in the background on a first
// authenticated request; answer it so the network guard stays quiet.
beforeEach(() => { stubFetch() })

const hosted = { ...env, APP_URL: 'https://wi.floor.vote', APP_DOMAINS: 'floor.vote', ASSOCIATION_NAME: 'Wisconsin Clerks' }

function hintCookie(res: Response): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith('fv_instances='))
}
function hintValue(setCookie: string): string {
  return decodeURIComponent(setCookie.split(';')[0].slice('fv_instances='.length))
}
const enc = (list: Parameters<typeof serializeInstanceHints>[0]) => encodeURIComponent(serializeInstanceHints(list))

describe('fv_instances reminder cookie', () => {
  beforeEach(async () => { await clearDb() })

  it('is set on the parent domain after a successful verify', async () => {
    const uid = await seedUser({ email: 'a@b.com' })
    const raw = await seedMagicLink(uid)
    const res = await app.request('/api/auth/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: raw }),
    }, hosted)
    expect(res.status).toBe(200)
    const sc = hintCookie(res)!
    expect(sc).toMatch(/Domain=\.floor\.vote/i)
    expect(sc).toMatch(/Max-Age=31536000/)
    expect(sc).toMatch(/HttpOnly/)
    expect(sc).toMatch(/Secure/)
    expect(parseInstanceHints(hintValue(sc))).toEqual([{ host: 'wi.floor.vote', name: 'Wisconsin Clerks', email: 'a@b.com' }])
  })

  it('keeps other instances and moves this one to the front on /auth/me', async () => {
    const uid = await seedUser({ email: 'a@b.com' })
    const token = await seedSession(uid)
    const existing = enc([{ host: 'mi.floor.vote', name: 'Michigan' }])
    const res = await app.request('/api/auth/me', {
      headers: { Cookie: `session=${token}; fv_instances=${existing}` },
    }, hosted)
    expect(res.status).toBe(200)
    expect(parseInstanceHints(hintValue(hintCookie(res)!))).toEqual([
      { host: 'wi.floor.vote', name: 'Wisconsin Clerks', email: 'a@b.com' }, { host: 'mi.floor.vote', name: 'Michigan' },
    ])
  })

  it('removes only this instance on logout', async () => {
    const uid = await seedUser({ email: 'a@b.com' })
    const token = await seedSession(uid)
    const existing = enc([
      { host: 'wi.floor.vote', name: 'Wisconsin Clerks' }, { host: 'mi.floor.vote', name: 'Michigan' },
    ])
    const res = await app.request('/api/auth/logout', {
      method: 'POST', headers: { Cookie: `session=${token}; fv_instances=${existing}` },
    }, hosted)
    expect(res.status).toBe(200)
    expect(parseInstanceHints(hintValue(hintCookie(res)!))).toEqual([{ host: 'mi.floor.vote', name: 'Michigan' }])
  })

  it('expires the cookie on logout when this was the last instance', async () => {
    const uid = await seedUser({ email: 'a@b.com' })
    const token = await seedSession(uid)
    const existing = enc([{ host: 'wi.floor.vote', name: 'Wisconsin Clerks' }])
    const res = await app.request('/api/auth/logout', {
      method: 'POST', headers: { Cookie: `session=${token}; fv_instances=${existing}` },
    }, hosted)
    const sc = hintCookie(res)!
    expect(sc).toMatch(/Max-Age=0/)
    expect(sc).toMatch(/Domain=\.floor\.vote/i)
  })

  it('is not set when APP_DOMAINS is unset (no parent domain to scope to)', async () => {
    const uid = await seedUser({ email: 'a@b.com' })
    const token = await seedSession(uid)
    const res = await app.request('/api/auth/me', { headers: { Cookie: `session=${token}` } },
      { ...hosted, APP_DOMAINS: '' })
    expect(res.status).toBe(200)
    expect(hintCookie(res)).toBeUndefined()
  })

  it('is not set when the tenant runs on the apex itself', async () => {
    const uid = await seedUser({ email: 'a@b.com' })
    const token = await seedSession(uid)
    const res = await app.request('/api/auth/me', { headers: { Cookie: `session=${token}` } },
      { ...hosted, APP_URL: 'https://floor.vote' })
    expect(hintCookie(res)).toBeUndefined()
  })

  it('stores the signed-in email with the entry', async () => {
    const uid = await seedUser({ email: 'clerk@wi.gov' })
    const token = await seedSession(uid)
    const res = await app.request('/api/auth/me', { headers: { Cookie: `session=${token}` } }, hosted)
    expect(parseInstanceHints(hintValue(hintCookie(res)!))).toEqual([
      { host: 'wi.floor.vote', name: 'Wisconsin Clerks', email: 'clerk@wi.gov' },
    ])
  })

  it('stores the email after verify too', async () => {
    const uid = await seedUser({ email: 'v@wi.gov' })
    const raw = await seedMagicLink(uid)
    const res = await app.request('/api/auth/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: raw }),
    }, hosted)
    expect(parseInstanceHints(hintValue(hintCookie(res)!))[0].email).toBe('v@wi.gov')
  })

  it('a demo tenant removes itself instead of being remembered', async () => {
    const uid = await seedUser({ email: 'a@b.com' })
    const token = await seedSession(uid)
    const existing = enc([
      { host: 'wi.floor.vote', name: 'Wisconsin Clerks' }, { host: 'mi.floor.vote', name: 'Michigan' },
    ])
    const res = await app.request('/api/auth/me', {
      headers: { Cookie: `session=${token}; fv_instances=${existing}` },
    }, { ...hosted, DEMO_MODE: 'true' })
    expect(parseInstanceHints(hintValue(hintCookie(res)!))).toEqual([{ host: 'mi.floor.vote', name: 'Michigan' }])
  })
})
