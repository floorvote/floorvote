import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { inArray } from 'drizzle-orm'
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

// CRITICAL regression: filter-mode bulk actions previously dropped `drafts` from
// the filter -> buildBillsWhere -> chain, so "select all matching filters" with
// Drafts on quietly wrote to every bill, not just the drafts the admin saw. This
// asserts both directions: the drafts get the write, and the filed bills it must
// NOT touch stay untouched.
describe('POST /api/bills/bulk — drafts filter must scope the write', () => {
  let adminToken: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const adminId = await seedUser({ email: 'admin@x.com', role: 'admin' })
    adminToken = await seedSession(adminId)
  })

  it('a bulk priority edit with filter.drafts="1" touches only the draft rows', async () => {
    const db = getDb(env.DB)
    await db.insert(bills).values([
      { id: 'd1', billNumber: 'D1', title: 'Draft 1', state: 'UT', isDraft: true, yearStart: 2026, yearEnd: 2026 },
      { id: 'd2', billNumber: 'D2', title: 'Draft 2', state: 'UT', isDraft: true, yearStart: 2026, yearEnd: 2026 },
      { id: 'f1', billNumber: 'HB1', title: 'Filed 1', state: 'UT', yearStart: 2026, yearEnd: 2026 },
      { id: 'f2', billNumber: 'HB2', title: 'Filed 2', state: 'UT', yearStart: 2026, yearEnd: 2026 },
    ])

    const res = await SELF.fetch('https://x/api/bills/bulk', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter: { drafts: '1' }, priority: 'high' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json<{ updated: number }>()
    expect(body.updated).toBe(2)

    const draftRows = await db.select({ id: bills.id, priority: bills.priority })
      .from(bills).where(inArray(bills.id, ['d1', 'd2'])).all()
    expect(draftRows.every(r => r.priority === 'high')).toBe(true)

    const filedRows = await db.select({ id: bills.id, priority: bills.priority })
      .from(bills).where(inArray(bills.id, ['f1', 'f2'])).all()
    expect(filedRows.every(r => r.priority === null)).toBe(true)
  })
})
