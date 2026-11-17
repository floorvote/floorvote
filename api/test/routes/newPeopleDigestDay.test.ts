import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { app } from '../../src/index'
import { clearDb, seedUser, seedSession } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig } from '../../src/db/schema'
import { signSuperadminJwt } from '../../../shared/superadminJwt'
import { _resetSuperadminAllowlistCache } from '../../src/lib/superadminCentral'

// A person added after migration 0127 starts on their instance's old weekly digest day (the digest_weekly_day_for_new_people
// setting), or every morning when the instance never had one. Three places add a person: the bulk invite, the first
// sign-in link for a superadmin, and a superadmin's dashboard sign-in.

const TEST_SUPERADMIN_PRIV = '{"key_ops":["sign"],"ext":true,"kty":"EC","x":"jMeKJ1Tf0sgE37Rzg02ARwUKvJ2hF6Zy2gI3mluSjpg","y":"vJ0-S0RvpYh3Z87ti61CrBjprBhpmiA4WujS6_Yb_lQ","crv":"P-256","d":"goMnWG7NT0ErjBM6BH8a_rf1hUjMvLB3o3h4f5sE-aY"}'
const SUPER = 'super@example.com'

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
const central = {
  fetch: async (req: Request) =>
    new URL(req.url).pathname === '/api/admin/superadmin/emails'
      ? new Response(JSON.stringify({ hashes: [await sha256Hex(SUPER)] }), { status: 200 })
      : new Response('not found', { status: 404 }),
}
const testEnv = { ...env, CENTRAL: central, BILL_QUEUE: { sendBatch: async () => {} } } as unknown as typeof env

const dayOf = async (email: string) =>
  (await env.DB.prepare('SELECT email_digest_weekly_day AS d FROM users WHERE email = ?').bind(email).first<{ d: number | null }>())!.d

describe.each([
  { saved: '5', expected: 5 as number | null, label: 'the saved day' },
  { saved: null, expected: null, label: 'every morning when none is saved' },
])('a person added now starts on $label', ({ saved, expected }) => {
  beforeEach(async () => {
    await clearDb()
    _resetSuperadminAllowlistCache()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    if (saved) await getDb(env.DB).insert(associationConfig).values({ key: 'digest_weekly_day_for_new_people', value: saved })
  })

  afterEach(() => { vi.unstubAllGlobals() })

  it('through the bulk invite', async () => {
    const cookie = `session=${await seedSession(await seedUser({ role: 'admin' }))}`
    const res = await app.request('/api/admin/members/bulk-invite', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ invitees: [{ name: 'A', email: 'a@example.com' }, { name: 'B', email: 'b@example.com' }] }),
    }, testEnv)
    expect(res.status).toBe(200)
    expect(await dayOf('a@example.com')).toBe(expected)
    expect(await dayOf('b@example.com')).toBe(expected)
  })

  it("through a superadmin's first sign-in link", async () => {
    const res = await app.request('/api/auth/magic-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: SUPER }),
    }, testEnv)
    expect(res.status).toBe(200)
    expect(await dayOf(SUPER)).toBe(expected)
  })

  it("through a superadmin's first dashboard sign-in", async () => {
    const jwt = await signSuperadminJwt(SUPER, 'Super Admin', TEST_SUPERADMIN_PRIV)
    const res = await app.request('/api/auth/me', { headers: { Cookie: `superadmin_jwt=${jwt}` } }, testEnv)
    expect(res.status).toBe(200)
    expect(await dayOf(SUPER)).toBe(expected)
  })
})
