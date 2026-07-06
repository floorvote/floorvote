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
      body: JSON.stringify({ billNumber: 'LCO 100', title: 'Pre-filed elections bill', summary: 'Summary', sponsor: 'Rep. Doe', text: 'AN ACT CONCERNING…' }),
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
      body: JSON.stringify({ title: 'Draft for engagement' }),
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
      body: JSON.stringify({ title: 'Listed draft' }),
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
})
