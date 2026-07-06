import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills } from '../../src/db/schema'
import { eq } from 'drizzle-orm'

async function createDraft(token: string, fields: {
  title: string; billNumber?: string; sponsor?: string; summary?: string; text?: string
}): Promise<string> {
  const res = await SELF.fetch('https://x/api/bills/draft', {
    method: 'POST',
    headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })
  expect(res.status).toBe(201)
  return (await res.json<{ id: string }>()).id
}

describe('PATCH /api/bills/:id/draft', () => {
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

  it('admin edits all fields and DB reflects the new values', async () => {
    const id = await createDraft(adminToken, {
      title: 'Original Title',
      billNumber: 'LCO 1',
      sponsor: 'Old Sponsor',
      summary: 'Old summary',
      text: 'Old text',
    })

    const res = await SELF.fetch(`https://x/api/bills/${id}/draft`, {
      method: 'PATCH',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New Title', sponsor: 'New Sponsor', summary: 'New summary', text: 'New text' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json<{ id: string; title: string; sponsor: string; summary: string; text: string; isDraft: boolean }>()
    expect(body.id).toBe(id)
    expect(body.title).toBe('New Title')
    expect(body.sponsor).toBe('New Sponsor')
    expect(body.summary).toBe('New summary')
    expect(body.text).toBe('New text')
    expect(body.isDraft).toBe(true)

    const db = getDb(env.DB)
    const row = await db.select().from(bills).where(eq(bills.id, id)).get()
    expect(row?.title).toBe('New Title')
    expect(row?.sponsor).toBe('New Sponsor')
    expect(row?.tenantSummary).toBe('New summary')
    expect(row?.draftText).toBe('New text')
  })

  it('non-admin (member) receives 403', async () => {
    const id = await createDraft(adminToken, { title: 'Draft' })
    const res = await SELF.fetch(`https://x/api/bills/${id}/draft`, {
      method: 'PATCH',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Hacked' }),
    })
    expect(res.status).toBe(403)
  })

  it('editing a non-draft (filed) bill returns 400', async () => {
    const filedId = await seedBill({ billNumber: 'HB 1', externalId: 'legiscan:111' })
    const res = await SELF.fetch(`https://x/api/bills/${filedId}/draft`, {
      method: 'PATCH',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New Title' }),
    })
    expect(res.status).toBe(400)
  })

  it('non-existent bill returns 404', async () => {
    const res = await SELF.fetch('https://x/api/bills/no-such-id/draft', {
      method: 'PATCH',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New Title' }),
    })
    expect(res.status).toBe(404)
  })

  it('partial update: sending only summary updates tenantSummary; title/sponsor/draftText unchanged', async () => {
    const id = await createDraft(adminToken, {
      title: 'Keep This Title',
      sponsor: 'Keep This Sponsor',
      text: 'Keep This Text',
    })

    const res = await SELF.fetch(`https://x/api/bills/${id}/draft`, {
      method: 'PATCH',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: 'Updated summary only' }),
    })
    expect(res.status).toBe(200)

    const db = getDb(env.DB)
    const row = await db.select().from(bills).where(eq(bills.id, id)).get()
    expect(row?.tenantSummary).toBe('Updated summary only')
    expect(row?.title).toBe('Keep This Title')
    expect(row?.sponsor).toBe('Keep This Sponsor')
    expect(row?.draftText).toBe('Keep This Text')
  })

  it('empty string clears optional fields (sponsor/summary/text) to null', async () => {
    const id = await createDraft(adminToken, {
      title: 'Title',
      sponsor: 'Sponsor',
      summary: 'Summary',
      text: 'Text',
    })

    const res = await SELF.fetch(`https://x/api/bills/${id}/draft`, {
      method: 'PATCH',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sponsor: '', summary: '', text: '' }),
    })
    expect(res.status).toBe(200)

    const db = getDb(env.DB)
    const row = await db.select().from(bills).where(eq(bills.id, id)).get()
    expect(row?.sponsor).toBeNull()
    expect(row?.tenantSummary).toBeNull()
    expect(row?.draftText).toBeNull()
    // title unchanged
    expect(row?.title).toBe('Title')
  })
})

describe('GET /api/bills/drafts', () => {
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

  it('returns only draft bills with id/billNumber/title, not filed bills', async () => {
    // Seed one filed bill
    await seedBill({ billNumber: 'HB 10', externalId: 'legiscan:10', title: 'Filed Bill' })

    // Create two drafts
    await createDraft(adminToken, { title: 'Draft One', billNumber: 'LCO 1' })
    await createDraft(adminToken, { title: 'Draft Two', billNumber: 'LCO 2' })

    const res = await SELF.fetch('https://x/api/bills/drafts', {
      headers: { Cookie: `session=${adminToken}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json<{ drafts: Array<{ id: string; billNumber: string; title: string }> }>()
    expect(body.drafts).toHaveLength(2)
    const titles = body.drafts.map(d => d.title)
    expect(titles).toContain('Draft One')
    expect(titles).toContain('Draft Two')
    expect(titles).not.toContain('Filed Bill')
    // Each entry has the required fields
    for (const d of body.drafts) {
      expect(d).toHaveProperty('id')
      expect(d).toHaveProperty('billNumber')
      expect(d).toHaveProperty('title')
    }
  })

  it('non-admin (member) receives 403', async () => {
    const res = await SELF.fetch('https://x/api/bills/drafts', {
      headers: { Cookie: `session=${memberToken}` },
    })
    expect(res.status).toBe(403)
  })

  it('returns empty array when no drafts exist', async () => {
    await seedBill({ billNumber: 'HB 1', externalId: 'legiscan:1' })
    const res = await SELF.fetch('https://x/api/bills/drafts', {
      headers: { Cookie: `session=${adminToken}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json<{ drafts: unknown[] }>()
    expect(body.drafts).toHaveLength(0)
  })
})
