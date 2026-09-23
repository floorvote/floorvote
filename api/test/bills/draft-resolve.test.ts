import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills } from '../../src/db/schema'

describe('draft canonical URLs', () => {
  let adminToken: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const adminId = await seedUser({ email: 'admin@x.com', role: 'admin' })
    adminToken = await seedSession(adminId)
  })

  it('resolves a draft by state, year, and number', async () => {
    const db = getDb(env.DB)
    await db.insert(bills).values({
      id: 'd1', billNumber: 'D1', title: 'Pre-filed', state: 'UT',
      isDraft: true, yearStart: 2027, yearEnd: 2027,
    })
    const res = await SELF.fetch('https://x/api/bills/resolve/UT/2027/D1', {
      headers: { Cookie: `session=${adminToken}` },
    })
    expect(res.status).toBe(200)
    expect(await res.json<{ id: string }>()).toMatchObject({ id: 'd1' })
  })

  it('still resolves a draft by uuid', async () => {
    const db = getDb(env.DB)
    await db.insert(bills).values({
      id: 'd1', billNumber: 'D1', title: 'Pre-filed', state: 'UT',
      isDraft: true, yearStart: 2027, yearEnd: 2027,
    })
    const res = await SELF.fetch('https://x/api/bills/d1', { headers: { Cookie: `session=${adminToken}` } })
    expect(res.status).toBe(200)
  })

  it('reports the draft year as the session slug so billUrl() can build the link', async () => {
    const db = getDb(env.DB)
    await db.insert(bills).values({
      id: 'd1', billNumber: 'D1', title: 'Pre-filed', state: 'UT',
      isDraft: true, yearStart: 2027, yearEnd: 2027,
    })
    const res = await SELF.fetch('https://x/api/bills/d1', { headers: { Cookie: `session=${adminToken}` } })
    expect(await res.json<{ sessionSlug: string }>()).toMatchObject({ sessionSlug: '2027' })
  })

  it('does not let an empty state segment reach a stateless draft', async () => {
    const db = getDb(env.DB)
    // A multi-state tenant draft can legitimately have state = '' (POST /bills/draft
    // falling back to an unset c.env.STATE). Such a draft keeps its /bills/<uuid>
    // URL — it must never be reachable through the state-aware resolve route via
    // an empty or falsy-stringifying state segment.
    await db.insert(bills).values({
      id: 'd2', billNumber: 'D1', title: 'Stateless pre-filed', state: '',
      isDraft: true, yearStart: 2027, yearEnd: 2027,
    })
    const res = await SELF.fetch('https://x/api/bills/resolve//2027/D1', {
      headers: { Cookie: `session=${adminToken}` },
    })
    expect(res.status).toBe(404)
  })
})
