import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills } from '../../src/db/schema'

describe('GET /api/bills — drafts filter', () => {
  let adminToken: string
  let memberToken: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const adminId = await seedUser({ email: 'admin@x.com', role: 'admin' })
    adminToken = await seedSession(adminId)
    const memberId = await seedUser({ email: 'member@x.com', role: 'member' })
    memberToken = await seedSession(memberId)
  })

  it('returns only drafts with drafts=1', async () => {
    const db = getDb(env.DB)
    await db.insert(bills).values([
      { id: 'd1', billNumber: 'D1', title: 'Draft', state: 'UT', isDraft: true, yearStart: 2026, yearEnd: 2026 },
      { id: 'f1', billNumber: 'HB1', title: 'Filed', state: 'UT', yearStart: 2026, yearEnd: 2026 },
    ])
    const res = await SELF.fetch('https://x/api/bills?drafts=1', { headers: { Cookie: `session=${adminToken}` } })
    const body = await res.json<{ bills: { id: string }[] }>()
    expect(body.bills.map(b => b.id)).toEqual(['d1'])
  })

  it('reports draftCount in the facets', async () => {
    const db = getDb(env.DB)
    await db.insert(bills).values([
      { id: 'd1', billNumber: 'D1', title: 'Draft', state: 'UT', isDraft: true, yearStart: 2026, yearEnd: 2026 },
      { id: 'f1', billNumber: 'HB1', title: 'Filed', state: 'UT', yearStart: 2026, yearEnd: 2026 },
    ])
    const res = await SELF.fetch('https://x/api/bills/facets', { headers: { Cookie: `session=${adminToken}` } })
    expect(await res.json<{ draftCount: number }>()).toMatchObject({ draftCount: 1 })
  })

  it('reports draftCount to a member too', async () => {
    const db = getDb(env.DB)
    await db.insert(bills).values({ id: 'd1', billNumber: 'D1', title: 'Draft', state: 'UT', isDraft: true, yearStart: 2026, yearEnd: 2026 })
    const res = await SELF.fetch('https://x/api/bills/facets', { headers: { Cookie: `session=${memberToken}` } })
    expect(await res.json<{ draftCount: number }>()).toMatchObject({ draftCount: 1 })
  })
})
