import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills, feedEvents, memberVotes, officialPositions } from '../../src/db/schema'
import { eq } from 'drizzle-orm'

describe('POST /api/bills/draft', () => {
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

  it('creates a draft bill with is_draft=1, match_type=manual, external_id=null', async () => {
    const res = await SELF.fetch('https://x/api/bills/draft', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ billNumber: 'LCO 100', title: 'Pre-filed elections bill', summary: 'Summary', sponsor: 'Rep. Doe', text: 'AN ACT CONCERNING…', state: 'UT' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json<{ id: string; isDraft: boolean }>()
    expect(body.isDraft).toBe(true)

    const db = getDb(env.DB)
    const row = await db.select().from(bills).where(eq(bills.id, body.id)).get()
    expect(row?.isDraft).toBe(true)
    expect(row?.matchType).toBe('manual')
    expect(row?.externalId).toBeNull()
    expect(row?.draftText).toBe('AN ACT CONCERNING…')

    const feed = await db.select().from(feedEvents).where(eq(feedEvents.billId, body.id)).all()
    expect(feed).toHaveLength(1)
    expect(feed[0].type).toBe('bill_added')
  })

  it('rejects a non-admin with 403', async () => {
    const res = await SELF.fetch('https://x/api/bills/draft', {
      method: 'POST',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Nope' }),
    })
    expect(res.status).toBe(403)
  })

  it('rejects a missing title with 400', async () => {
    const res = await SELF.fetch('https://x/api/bills/draft', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ billNumber: 'X' }),
    })
    expect(res.status).toBe(400)
  })

  it('accepts vote, position on a draft', async () => {
    // Create draft as admin
    const createRes = await SELF.fetch('https://x/api/bills/draft', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Draft for engagement', state: 'UT' }),
    })
    expect(createRes.status).toBe(201)
    const { id } = await createRes.json<{ id: string }>()

    // Vote as member
    const voteRes = await SELF.fetch(`https://x/api/bills/${id}/votes`, {
      method: 'POST',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 'support' }),
    })
    expect(voteRes.status).toBe(200)

    // Official position as admin
    const posRes = await SELF.fetch(`https://x/api/bills/${id}/position`, {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 'Support' }),
    })
    expect(posRes.status).toBe(200)

    const db = getDb(env.DB)
    const votes = await db.select().from(memberVotes).where(eq(memberVotes.billId, id)).all()
    expect(votes).toHaveLength(1)
    const positions = await db.select().from(officialPositions).where(eq(officialPositions.billId, id)).all()
    expect(positions).toHaveLength(1)
  })

  it('returns isDraft on GET /bills list', async () => {
    // Create draft
    const createRes = await SELF.fetch('https://x/api/bills/draft', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Listed draft', state: 'UT' }),
    })
    expect(createRes.status).toBe(201)

    const listRes = await SELF.fetch('https://x/api/bills', {
      headers: { Cookie: `session=${adminToken}` },
    })
    expect(listRes.status).toBe(200)
    const body = await listRes.json<{ bills: Array<{ title: string; isDraft: boolean }> }>()
    const found = body.bills.find(b => b.title === 'Listed draft')
    expect(found).toBeDefined()
    expect(found?.isDraft).toBe(true)
  })

  it('auto-assigns D1 and the default year when neither is supplied', async () => {
    const res = await SELF.fetch('https://x/api/bills/draft', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Pre-filed', state: 'UT' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json<{ id: string; billNumber: string; year: number }>()
    expect(body.billNumber).toBe('D1')
    const db = getDb(env.DB)
    const row = await db.select().from(bills).where(eq(bills.id, body.id)).get()
    expect(row?.yearStart).toBe(body.year)
    expect(row?.yearEnd).toBe(body.year)
  })

  it('honours a supplied number and year', async () => {
    const res = await SELF.fetch('https://x/api/bills/draft', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Pre-filed', billNumber: 'LRB-1234', year: 2027, state: 'UT' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json<{ billNumber: string; year: number }>()
    expect(body.billNumber).toBe('LRB-1234')
    expect(body.year).toBe(2027)
  })

  it('skips an auto-assigned number already taken by a filed bill', async () => {
    // A filed bill can incidentally carry a D-prefixed number. Auto-assignment
    // must consider it too, or the caller gets a 409 for a number they never chose.
    const db = getDb(env.DB)
    await db.insert(bills).values({
      id: 'filed-d3', billNumber: 'D3', title: 'Filed', state: 'UT', yearStart: 2026, yearEnd: 2026,
    })
    const res = await SELF.fetch('https://x/api/bills/draft', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Pre-filed', state: 'UT' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json<{ billNumber: string }>()
    expect(body.billNumber).toBe('D4')
  })

  it('409s when the supplied number collides with a filed bill in the same state and year', async () => {
    // Route falls back to c.env.STATE, which is unset in the test worker, so an
    // explicit `state` in the request body is required to exercise per-state
    // behavior through the HTTP route (rather than seeding 'UT' and having the
    // request land on '' by accident).
    const db = getDb(env.DB)
    await db.insert(bills).values({
      id: 'filed', billNumber: 'HB0209', title: 'Filed', state: 'UT', yearStart: 2026, yearEnd: 2026,
    })
    const res = await SELF.fetch('https://x/api/bills/draft', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Clash', billNumber: 'HB0209', year: 2026, state: 'UT' }),
    })
    expect(res.status).toBe(409)
    const rows = await db.select().from(bills).where(eq(bills.isDraft, true)).all()
    expect(rows).toHaveLength(0)
  })

  it('rejects with 400 and writes no row when the resolved state is empty', async () => {
    // c.env.STATE is unset in the test worker (vitest.config.mts), which
    // stands in for a multi-state tenant. Omitting `state` here reproduces
    // the production bug (bpc-elections drafts with state = '') that made
    // billUrl() impossible to resolve — the route must refuse it outright
    // rather than silently writing a stateless draft.
    const res = await SELF.fetch('https://x/api/bills/draft', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'No state given' }),
    })
    expect(res.status).toBe(400)
    const db = getDb(env.DB)
    const rows = await db.select().from(bills).where(eq(bills.title, 'No state given')).all()
    expect(rows).toHaveLength(0)
  })

  it('accepts an explicit state and creates the draft', async () => {
    const res = await SELF.fetch('https://x/api/bills/draft', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Explicit state', state: 'ut' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json<{ id: string }>()
    const db = getDb(env.DB)
    const row = await db.select().from(bills).where(eq(bills.id, body.id)).get()
    expect(row?.state).toBe('UT')
  })
})
