import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../../src/index'
import { resetDb, applyMigrations, seedUser, seedSession, seedMagicLink } from '../helpers'
import { getDb } from '../../src/db/client'
import { termsAcceptances } from '../../src/db/schema'
import { TERMS_EXEMPT } from '../../src/middleware/auth'

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
