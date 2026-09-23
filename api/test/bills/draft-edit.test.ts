import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills } from '../../src/db/schema'
import { eq } from 'drizzle-orm'

async function createDraft(token: string, fields: {
  title: string; billNumber?: string; sponsor?: string; summary?: string; text?: string
}): Promise<string> {
  // c.env.STATE is unset in the test worker (vitest.config.mts), which the
  // route now rejects with 400 unless a state is supplied — see the empty-state
  // guard in draftRoutes.ts. 'UT' here stands in for a single-state tenant's
  // configured STATE binding; it isn't what these tests are exercising.
  const res = await SELF.fetch('https://x/api/bills/draft', {
    method: 'POST',
    headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'UT', ...fields }),
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

  it('updates the number and year', async () => {
    await seedBill({
      id: 'd1', billNumber: 'D1', title: 'Draft', state: 'UT', isDraft: true, yearStart: 2026, yearEnd: 2026,
    })
    const res = await SELF.fetch('https://x/api/bills/d1/draft', {
      method: 'PATCH',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ billNumber: 'D7', year: 2027 }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ billNumber: 'D7', year: 2027 })
  })

  it("409s on a collision but allows a no-op re-save of the draft's own number", async () => {
    await seedBill({
      id: 'd1', billNumber: 'D1', title: 'Draft', state: 'UT', isDraft: true, yearStart: 2026, yearEnd: 2026,
    })
    await seedBill({
      id: 'f1', billNumber: 'HB0209', title: 'Filed', state: 'UT', yearStart: 2026, yearEnd: 2026,
    })

    const clash = await SELF.fetch('https://x/api/bills/d1/draft', {
      method: 'PATCH',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ billNumber: 'HB0209' }),
    })
    expect(clash.status).toBe(409)

    const noop = await SELF.fetch('https://x/api/bills/d1/draft', {
      method: 'PATCH',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ billNumber: 'D1' }),
    })
    expect(noop.status).toBe(200)
  })

  it('updates only billNumber when year is omitted', async () => {
    await seedBill({
      id: 'd1', billNumber: 'D1', title: 'Draft', state: 'UT', isDraft: true, yearStart: 2026, yearEnd: 2026,
    })
    const res = await SELF.fetch('https://x/api/bills/d1/draft', {
      method: 'PATCH',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ billNumber: 'D9' }),
    })
    expect(res.status).toBe(200)

    const db = getDb(env.DB)
    const row = await db.select().from(bills).where(eq(bills.id, 'd1')).get()
    expect(row?.billNumber).toBe('D9')
    expect(row?.yearStart).toBe(2026)
    expect(row?.yearEnd).toBe(2026)
  })

  it('updates only year when billNumber is omitted', async () => {
    await seedBill({
      id: 'd1', billNumber: 'D1', title: 'Draft', state: 'UT', isDraft: true, yearStart: 2026, yearEnd: 2026,
    })
    const res = await SELF.fetch('https://x/api/bills/d1/draft', {
      method: 'PATCH',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ year: 2028 }),
    })
    expect(res.status).toBe(200)

    const db = getDb(env.DB)
    const row = await db.select().from(bills).where(eq(bills.id, 'd1')).get()
    expect(row?.billNumber).toBe('D1')
    expect(row?.yearStart).toBe(2028)
    expect(row?.yearEnd).toBe(2028)
  })

  it('updates the state, normalizing it, and reports it in the response', async () => {
    await seedBill({
      id: 'd1', billNumber: 'D1', title: 'Draft', state: 'UT', isDraft: true, yearStart: 2026, yearEnd: 2026,
    })
    const res = await SELF.fetch('https://x/api/bills/d1/draft', {
      method: 'PATCH',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: '  tx ' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ state: 'TX' })

    const db = getDb(env.DB)
    const row = await db.select().from(bills).where(eq(bills.id, 'd1')).get()
    expect(row?.state).toBe('TX')
    // The number and year are not part of this edit and must survive it.
    expect(row?.billNumber).toBe('D1')
    expect(row?.yearStart).toBe(2026)
  })

  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
  ])('400s on an %s state and leaves the row unchanged', async (_label, state) => {
    await seedBill({
      id: 'd1', billNumber: 'D1', title: 'Draft', state: 'UT', isDraft: true, yearStart: 2026, yearEnd: 2026,
    })
    const res = await SELF.fetch('https://x/api/bills/d1/draft', {
      method: 'PATCH',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, title: 'Should not be saved' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json<{ error: string }>()).error).toMatch(/canonical URL/)

    const db = getDb(env.DB)
    const row = await db.select().from(bills).where(eq(bills.id, 'd1')).get()
    expect(row?.state).toBe('UT')
    expect(row?.title).toBe('Draft')
  })

  it("leaves a legacy draft's empty state alone when state is omitted", async () => {
    // Migration 0070 deliberately did not guess a state for pre-existing
    // drafts, so '' is a real value on the staging tenant. Editing another
    // field must not trip the new state guard.
    await seedBill({
      id: 'd1', billNumber: 'D1', title: 'Draft', state: '', isDraft: true, yearStart: 2026, yearEnd: 2026,
    })
    const res = await SELF.fetch('https://x/api/bills/d1/draft', {
      method: 'PATCH',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Renamed' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ state: '', title: 'Renamed' })

    const db = getDb(env.DB)
    const row = await db.select().from(bills).where(eq(bills.id, 'd1')).get()
    expect(row?.state).toBe('')
    expect(row?.title).toBe('Renamed')
  })

  it('409s when only the state changes onto a triple another bill already owns', async () => {
    // The number and year are untouched here, so this collision is reachable
    // only because the guard now fires on a state change as well.
    await seedBill({
      id: 'd1', billNumber: 'D1', title: 'Draft', state: 'UT', isDraft: true, yearStart: 2026, yearEnd: 2026,
    })
    await seedBill({
      id: 'f1', billNumber: 'D1', title: 'Filed in TX', state: 'TX', yearStart: 2026, yearEnd: 2026,
    })

    const res = await SELF.fetch('https://x/api/bills/d1/draft', {
      method: 'PATCH',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'TX' }),
    })
    expect(res.status).toBe(409)
    // The message must name the state being moved TO, not the one being left.
    expect((await res.json<{ error: string }>()).error).toBe('D1 is already used by another TX bill in 2026.')

    const db = getDb(env.DB)
    const row = await db.select().from(bills).where(eq(bills.id, 'd1')).get()
    expect(row?.state).toBe('UT')
  })

  it('allows a no-op re-save of the state', async () => {
    await seedBill({
      id: 'd1', billNumber: 'D1', title: 'Draft', state: 'UT', isDraft: true, yearStart: 2026, yearEnd: 2026,
    })
    const res = await SELF.fetch('https://x/api/bills/d1/draft', {
      method: 'PATCH',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'UT' }),
    })
    expect(res.status).toBe(200)
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
