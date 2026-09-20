import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../../src/index'
import { resetDb, applyMigrations, seedUser, seedSession, seedMagicLink } from '../helpers'
import { getDb } from '../../src/db/client'
import { termsAcceptances } from '../../src/db/schema'
import { eq } from 'drizzle-orm'
import { TERMS_EXEMPT } from '../../src/middleware/auth'
import { signSuperadminJwt } from '../../../shared/superadminJwt'

// The documents' current material version. Any YYYY-MM-DD works for the tests;
// what matters is the ordering between them.
const CURRENT = '2026-09-11'
const NEWER = '2027-03-01'
const OLDER = '2026-08-23'

const armed = { ...env, LEGAL_TERMS_UPDATED: CURRENT }

async function accept(userId: string, termsUpdated: string) {
  await getDb(env.DB).insert(termsAcceptances).values({
    id: crypto.randomUUID(),
    userId,
    termsUpdated,
    acceptedAt: '2026-09-12 00:00:00',
  })
}

describe('the terms gate in requireAuth', () => {
  let userId: string
  let cookie: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    userId = await seedUser({ role: 'member' })
    await seedMagicLink(userId, { used: true })
    cookie = `session=${await seedSession(userId)}`
  })

  it('403s terms_not_accepted when the user has never accepted', async () => {
    const res = await app.request('/api/stats/sidebar', { headers: { Cookie: cookie } }, armed)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Terms not accepted', code: 'terms_not_accepted' })
  })

  it('passes once the newest acceptance covers the current value', async () => {
    await accept(userId, CURRENT)
    const res = await app.request('/api/stats/sidebar', { headers: { Cookie: cookie } }, armed)
    expect(res.status).toBe(200)
  })

  it('passes when the acceptance is newer than the current value', async () => {
    await accept(userId, NEWER)
    const res = await app.request('/api/stats/sidebar', { headers: { Cookie: cookie } }, armed)
    expect(res.status).toBe(200)
  })

  it('403s again after a bump past an existing acceptance', async () => {
    await accept(userId, OLDER)
    const res = await app.request('/api/stats/sidebar', { headers: { Cookie: cookie } }, armed)
    expect(res.status).toBe(403)
    expect((await res.json() as { code?: string }).code).toBe('terms_not_accepted')
  })

  // The disarmed case is the default everywhere except an armed operator tenant:
  // upstream forks and the demo have no legal documents at all.
  it('is disarmed when LEGAL_TERMS_UPDATED is unset', async () => {
    const res = await app.request('/api/stats/sidebar', { headers: { Cookie: cookie } }, env)
    expect(res.status).toBe(200)
  })

  it('is disarmed when LEGAL_TERMS_UPDATED is empty', async () => {
    const res = await app.request('/api/stats/sidebar', { headers: { Cookie: cookie } },
      { ...env, LEGAL_TERMS_UPDATED: '' })
    expect(res.status).toBe(200)
  })

  it('still 401s an unauthenticated request rather than 403ing it', async () => {
    const res = await app.request('/api/stats/sidebar', {}, armed)
    expect(res.status).toBe(401)
  })

  it('compares lexicographically, so a same-day acceptance passes', async () => {
    await accept(userId, CURRENT)
    const res = await app.request('/api/stats/sidebar', { headers: { Cookie: cookie } }, armed)
    expect(res.status).toBe(200)
  })

  it('takes the furthest acceptance, not the last row written', async () => {
    await accept(userId, CURRENT)
    await accept(userId, OLDER) // a stray older row must not un-accept them
    const res = await app.request('/api/stats/sidebar', { headers: { Cookie: cookie } }, armed)
    expect(res.status).toBe(200)
  })

  it('gates a non-exempt route while un-accepted', async () => {
    const res = await app.request('/api/bills', { headers: { Cookie: cookie } }, armed)
    expect(res.status).toBe(403)
    expect((await res.json() as { code?: string }).code).toBe('terms_not_accepted')
  })

  it('exempts exactly one path, and no more', () => {
    expect(TERMS_EXEMPT.size).toBe(1)
    expect([...TERMS_EXEMPT]).toEqual(['POST /api/auth/accept-terms'])
  })
})

describe('POST /api/auth/accept-terms', () => {
  let userId: string
  let cookie: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    userId = await seedUser({ role: 'member' })
    await seedMagicLink(userId, { used: true })
    cookie = `session=${await seedSession(userId)}`
  })

  async function rows() {
    return await getDb(env.DB).select().from(termsAcceptances)
      .where(eq(termsAcceptances.userId, userId)).all()
  }

  // The endpoint must not be gated behind the gate it clears.
  it('succeeds while un-accepted, which is the only state it is ever called in', async () => {
    const res = await app.request('/api/auth/accept-terms', { method: 'POST', headers: { Cookie: cookie } }, armed)
    expect(res.status).toBe(204)
  })

  it('inserts exactly one row, stamped with the current value', async () => {
    await app.request('/api/auth/accept-terms', { method: 'POST', headers: { Cookie: cookie } }, armed)
    const r = await rows()
    expect(r).toHaveLength(1)
    expect(r[0].termsUpdated).toBe(CURRENT)
  })

  it('writes accepted_at in the space-separated db shape, never an ISO string', async () => {
    await app.request('/api/auth/accept-terms', { method: 'POST', headers: { Cookie: cookie } }, armed)
    const r = await rows()
    expect(r[0].acceptedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it('no-ops on a double submit — one row, still 204', async () => {
    await app.request('/api/auth/accept-terms', { method: 'POST', headers: { Cookie: cookie } }, armed)
    const second = await app.request('/api/auth/accept-terms', { method: 'POST', headers: { Cookie: cookie } }, armed)
    expect(second.status).toBe(204)
    expect(await rows()).toHaveLength(1)
  })

  it('inserts a second row after a bump, rather than updating the first', async () => {
    await app.request('/api/auth/accept-terms', { method: 'POST', headers: { Cookie: cookie } }, armed)
    const bumped = { ...env, LEGAL_TERMS_UPDATED: NEWER }
    await app.request('/api/auth/accept-terms', { method: 'POST', headers: { Cookie: cookie } }, bumped)
    const r = await rows()
    expect(r).toHaveLength(2)
    expect(r.map(x => x.termsUpdated).sort()).toEqual([CURRENT, NEWER])
  })

  it('clears the gate — a previously 403ing route passes afterwards', async () => {
    expect((await app.request('/api/stats/sidebar', { headers: { Cookie: cookie } }, armed)).status).toBe(403)
    await app.request('/api/auth/accept-terms', { method: 'POST', headers: { Cookie: cookie } }, armed)
    expect((await app.request('/api/stats/sidebar', { headers: { Cookie: cookie } }, armed)).status).toBe(200)
  })

  it('401s without a session', async () => {
    const res = await app.request('/api/auth/accept-terms', { method: 'POST' }, armed)
    expect(res.status).toBe(401)
  })

  it('records nothing when the gate is disarmed, having nothing to record against', async () => {
    const res = await app.request('/api/auth/accept-terms', { method: 'POST', headers: { Cookie: cookie } }, env)
    expect(res.status).toBe(204)
    expect(await rows()).toHaveLength(0)
  })
})

// Mirrors demoReadOnly.test.ts: an exemption that names a route which no longer
// exists silently exempts nothing, which is the failure mode you never notice.
describe('TERMS_EXEMPT against the live route table', () => {
  it('names only routes that exist', () => {
    const live = new Set(
      app.routes
        .filter(r => r.path.startsWith('/api/'))
        .map(r => `${r.method} ${r.path}`),
    )
    expect([...TERMS_EXEMPT].filter(k => !live.has(k))).toEqual([])
  })
})

// The public key lives in vitest.config.mts, so a token signed with this pairs
// with it and the JWT bootstrap branch runs for real.
const TEST_SUPERADMIN_PRIV = '{"key_ops":["sign"],"ext":true,"kty":"EC","x":"jMeKJ1Tf0sgE37Rzg02ARwUKvJ2hF6Zy2gI3mluSjpg","y":"vJ0-S0RvpYh3Z87ti61CrBjprBhpmiA4WujS6_Yb_lQ","crv":"P-256","d":"goMnWG7NT0ErjBM6BH8a_rf1hUjMvLB3o3h4f5sE-aY"}'

describe('GET /auth/me reports acceptance state', () => {
  let userId: string
  let cookie: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    userId = await seedUser({ role: 'member' })
    cookie = `session=${await seedSession(userId)}`
  })

  async function me(envOverride: Record<string, unknown>, jar = cookie) {
    const res = await app.request('/api/auth/me', { headers: { Cookie: jar } }, envOverride)
    return await res.json() as { termsAcceptanceRequired?: boolean; termsAcceptanceKind?: string }
  }

  it('reports required=false when the gate is disarmed', async () => {
    await seedMagicLink(userId, { used: true })
    const body = await me(env)
    expect(body.termsAcceptanceRequired).toBe(false)
  })

  // The off-by-one the spec singles out: the interstitial renders AFTER verify
  // has marked the link used, so a genuine first-timer is already at exactly 1.
  it('calls exactly one used link a first_login', async () => {
    await seedMagicLink(userId, { used: true })
    const body = await me(armed)
    expect(body.termsAcceptanceRequired).toBe(true)
    expect(body.termsAcceptanceKind).toBe('first_login')
  })

  it('calls two used links an existing_member', async () => {
    await seedMagicLink(userId, { used: true })
    await seedMagicLink(userId, { used: true })
    const body = await me(armed)
    expect(body.termsAcceptanceKind).toBe('existing_member')
  })

  it('calls a stale acceptance an update', async () => {
    await seedMagicLink(userId, { used: true })
    await accept(userId, OLDER)
    const body = await me(armed)
    expect(body.termsAcceptanceRequired).toBe(true)
    expect(body.termsAcceptanceKind).toBe('update')
  })

  it('reports required=false once they have accepted the current value', async () => {
    await seedMagicLink(userId, { used: true })
    await accept(userId, CURRENT)
    const body = await me(armed)
    expect(body.termsAcceptanceRequired).toBe(false)
  })

  it('reports both fields on the superadmin JWT branch, and never calls them a first_login', async () => {
    // Zero used magic links — bootstrapped from a JWT, never through a link.
    // A NOT EXISTS predicate would read that as a first-timer.
    const jwt = await signSuperadminJwt('super@example.com', 'Super Admin', TEST_SUPERADMIN_PRIV)
    const body = await me(armed, `superadmin_jwt=${jwt}`)
    expect(body.termsAcceptanceRequired).toBe(true)
    expect(body.termsAcceptanceKind).toBe('existing_member')
  })
})
