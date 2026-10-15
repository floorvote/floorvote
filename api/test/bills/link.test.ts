import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, appFetch, stubFetch, seedUser, seedSession, seedBill, seedCalendarEvent } from '../helpers'
import { getDb } from '../../src/db/client'
import {
  bills, memberVotes, officialPositions, comments, notes,
  customFieldDefinitions, billCustomFieldValues, calendarEventBills,
} from '../../src/db/schema'
import { eq } from 'drizzle-orm'

async function createDraft(token: string, title: string): Promise<string> {
  // c.env.STATE is unset in the test worker (vitest.config.mts), which the
  // route now rejects with 400 unless a state is supplied — see the empty-state
  // guard in draftRoutes.ts. 'UT' here stands in for a single-state tenant's
  // configured STATE binding; it isn't what these tests are exercising.
  const res = await appFetch('https://x/api/bills/draft', {
    method: 'POST',
    headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, state: 'UT' }),
  })
  expect(res.status).toBe(201)
  return (await res.json<{ id: string }>()).id
}

describe('POST /api/bills/:id/link', () => {
  let adminToken: string
  let memberToken: string
  let memberId: string
  let adminId: string

  beforeEach(async () => {
    stubFetch() // central lookups and background backfills are answered, never real
    await resetDb()
    await applyMigrations()
    adminId = await seedUser({ email: 'admin@x.com', role: 'admin' })
    adminToken = await seedSession(adminId)
    memberId = await seedUser({ email: 'member@x.com', role: 'member' })
    memberToken = await seedSession(memberId)
  })

  it('re-points draft engagement onto the filed bill and deletes the draft', async () => {
    const filedId = await seedBill({ billNumber: 'HB 1', externalId: 'legiscan:111' })
    const draftId = await createDraft(adminToken, 'Pre-file of HB 1')

    // Member votes on draft
    const voteRes = await appFetch(`https://x/api/bills/${draftId}/votes`, {
      method: 'POST',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 'support' }),
    })
    expect(voteRes.status).toBe(200)

    // Admin sets official position on draft (must use capitalized value)
    const posRes = await appFetch(`https://x/api/bills/${draftId}/position`, {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 'Oppose' }),
    })
    expect(posRes.status).toBe(200)

    // Member posts a comment on draft
    const commentRes = await appFetch(`https://x/api/bills/${draftId}/comments`, {
      method: 'POST',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'a comment' }),
    })
    expect(commentRes.status).toBe(201)

    const res = await appFetch(`https://x/api/bills/${draftId}/link`, {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filedBillId: filedId }),
    })
    expect(res.status).toBe(200)

    const db = getDb(env.DB)
    expect(await db.select().from(bills).where(eq(bills.id, draftId)).get()).toBeUndefined()
    expect((await db.select().from(memberVotes).where(eq(memberVotes.billId, filedId)).all())).toHaveLength(1)
    expect((await db.select().from(officialPositions).where(eq(officialPositions.billId, filedId)).all())).toHaveLength(1)
    expect((await db.select().from(comments).where(eq(comments.billId, filedId)).all())).toHaveLength(1)
    expect((await db.select().from(memberVotes).where(eq(memberVotes.billId, draftId)).all())).toHaveLength(0)
  })

  it('rejects linking a non-draft, a self-link, and a missing target', async () => {
    const filedId = await seedBill({ billNumber: 'HB 2', externalId: 'legiscan:222' })
    const draftId = await createDraft(adminToken, 'Draft 2')

    const selfLink = await appFetch(`https://x/api/bills/${draftId}/link`, {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filedBillId: draftId }),
    })
    expect(selfLink.status).toBe(400)

    const noBody = await appFetch(`https://x/api/bills/${draftId}/link`, {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(noBody.status).toBe(400)

    const draft2 = await createDraft(adminToken, 'Draft 3')
    const intoDraft = await appFetch(`https://x/api/bills/${draftId}/link`, {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filedBillId: draft2 }),
    })
    expect(intoDraft.status).toBe(400)

    const fromFiled = await appFetch(`https://x/api/bills/${filedId}/link`, {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filedBillId: draftId }),
    })
    expect(fromFiled.status).toBe(404)
  })

  it('drops the draft official position when the filed bill already has one', async () => {
    const filedId = await seedBill({ billNumber: 'HB 3', externalId: 'legiscan:333' })
    const draftId = await createDraft(adminToken, 'Draft for HB 3')

    // Set position on filed bill ('Support')
    const filedPosRes = await appFetch(`https://x/api/bills/${filedId}/position`, {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 'Support' }),
    })
    expect(filedPosRes.status).toBe(200)

    // Set position on draft ('Oppose')
    const draftPosRes = await appFetch(`https://x/api/bills/${draftId}/position`, {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 'Oppose' }),
    })
    expect(draftPosRes.status).toBe(200)

    const res = await appFetch(`https://x/api/bills/${draftId}/link`, {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filedBillId: filedId }),
    })
    expect(res.status).toBe(200)

    const db = getDb(env.DB)
    const positions = await db.select().from(officialPositions).where(eq(officialPositions.billId, filedId)).all()
    expect(positions).toHaveLength(1)
    expect(positions[0].position).toBe('Support') // filed's position survived
  })

  it('drops the draft vote when the same user already voted on filed', async () => {
    const filedId = await seedBill({ billNumber: 'HB 4', externalId: 'legiscan:444' })
    const draftId = await createDraft(adminToken, 'Draft for HB 4')

    // Same member votes 'support' on BOTH filed and draft
    await appFetch(`https://x/api/bills/${filedId}/votes`, {
      method: 'POST',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 'support' }),
    })
    await appFetch(`https://x/api/bills/${draftId}/votes`, {
      method: 'POST',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 'support' }),
    })

    const res = await appFetch(`https://x/api/bills/${draftId}/link`, {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filedBillId: filedId }),
    })
    expect(res.status).toBe(200)

    const db = getDb(env.DB)
    const votes = await db.select().from(memberVotes).where(eq(memberVotes.billId, filedId)).all()
    expect(votes).toHaveLength(1)
  })

  it('drops the draft note when the same user already has a note on filed (UNIQUE bill_id,user_id)', async () => {
    const filedId = await seedBill({ billNumber: 'HB 5', externalId: 'legiscan:555' })
    const draftId = await createDraft(adminToken, 'Draft for HB 5')

    // Same member has a note on BOTH filed and draft
    const filedNote = await appFetch(`https://x/api/bills/${filedId}/note`, {
      method: 'PUT',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'filed note (canonical)' }),
    })
    expect(filedNote.status).toBe(200)
    const draftNote = await appFetch(`https://x/api/bills/${draftId}/note`, {
      method: 'PUT',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'draft note (should be dropped)' }),
    })
    expect(draftNote.status).toBe(200)

    const res = await appFetch(`https://x/api/bills/${draftId}/link`, {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filedBillId: filedId }),
    })
    expect(res.status).toBe(200)

    const db = getDb(env.DB)
    const filedNotes = await db.select().from(notes).where(eq(notes.billId, filedId)).all()
    expect(filedNotes).toHaveLength(1)
    expect(filedNotes[0].content).toBe('filed note (canonical)') // filed's note survived
    // no orphaned note left pointing at the dead draft
    expect((await db.select().from(notes).where(eq(notes.billId, draftId)).all())).toHaveLength(0)
  })

  it('rejects a non-admin (member) with 403', async () => {
    const filedId = await seedBill({ billNumber: 'HB 6', externalId: 'legiscan:666' })
    const draftId = await createDraft(adminToken, 'Draft for HB 6')

    const res = await appFetch(`https://x/api/bills/${draftId}/link`, {
      method: 'POST',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filedBillId: filedId }),
    })
    expect(res.status).toBe(403)

    // draft untouched
    const db = getDb(env.DB)
    expect(await db.select().from(bills).where(eq(bills.id, draftId)).get()).toBeDefined()
  })

  async function link(draftId: string, filedId: string) {
    const res = await appFetch(`https://x/api/bills/${draftId}/link`, {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filedBillId: filedId }),
    })
    expect(res.status).toBe(200)
  }

  async function seedField(name: string): Promise<string> {
    const id = crypto.randomUUID()
    await getDb(env.DB).insert(customFieldDefinitions).values({ id, name, type: 'text' })
    return id
  }

  it('moves the draft custom field values onto the filed bill, keeping set_by and updated_at', async () => {
    const filedId = await seedBill({ billNumber: 'HB 7', externalId: 'legiscan:777' })
    const draftId = await createDraft(adminToken, 'Draft for HB 7')
    const fieldId = await seedField('Sponsor outreach')
    const db = getDb(env.DB)
    await db.insert(billCustomFieldValues).values({
      billId: draftId, fieldId, value: 'called office', setBy: memberId, updatedAt: '2026-01-02 03:04:05',
    })

    await link(draftId, filedId)

    const values = await db.select().from(billCustomFieldValues).where(eq(billCustomFieldValues.billId, filedId)).all()
    expect(values).toHaveLength(1)
    expect(values[0]).toMatchObject({
      fieldId, value: 'called office', setBy: memberId, updatedAt: '2026-01-02 03:04:05',
    })
  })

  it('keeps the filed custom field value when both bills have one for the same field', async () => {
    const filedId = await seedBill({ billNumber: 'HB 8', externalId: 'legiscan:888' })
    const draftId = await createDraft(adminToken, 'Draft for HB 8')
    const sharedField = await seedField('Status note')
    const draftOnlyField = await seedField('Draft-only note')
    const db = getDb(env.DB)
    await db.insert(billCustomFieldValues).values([
      { billId: filedId, fieldId: sharedField, value: 'filed value', setBy: adminId },
      { billId: draftId, fieldId: sharedField, value: 'draft value', setBy: memberId },
      { billId: draftId, fieldId: draftOnlyField, value: 'draft only', setBy: memberId },
    ])

    await link(draftId, filedId)

    const values = await db.select().from(billCustomFieldValues).where(eq(billCustomFieldValues.billId, filedId)).all()
    expect(values).toHaveLength(2)
    expect(values.find(v => v.fieldId === sharedField)?.value).toBe('filed value')
    expect(values.find(v => v.fieldId === draftOnlyField)?.value).toBe('draft only')
    expect((await db.select().from(billCustomFieldValues).where(eq(billCustomFieldValues.billId, draftId)).all())).toHaveLength(0)
  })

  it('moves the draft calendar links onto the filed bill', async () => {
    const filedId = await seedBill({ billNumber: 'HB 9', externalId: 'legiscan:999' })
    const draftId = await createDraft(adminToken, 'Draft for HB 9')
    const eventId = await seedCalendarEvent(draftId)
    const db = getDb(env.DB)
    await db.insert(calendarEventBills).values({ eventId, billId: draftId })

    await link(draftId, filedId)

    expect(await db.select().from(calendarEventBills).where(eq(calendarEventBills.billId, filedId)).all())
      .toEqual([{ eventId, billId: filedId }])
    expect((await db.select().from(calendarEventBills).where(eq(calendarEventBills.billId, draftId)).all())).toHaveLength(0)
  })

  it('drops the draft calendar link when the filed bill is already linked to the same event', async () => {
    const filedId = await seedBill({ billNumber: 'HB 10', externalId: 'legiscan:1010' })
    const draftId = await createDraft(adminToken, 'Draft for HB 10')
    const eventId = await seedCalendarEvent(filedId)
    const db = getDb(env.DB)
    await db.insert(calendarEventBills).values([
      { eventId, billId: filedId },
      { eventId, billId: draftId },
    ])

    await link(draftId, filedId)

    expect(await db.select().from(calendarEventBills).where(eq(calendarEventBills.eventId, eventId)).all())
      .toEqual([{ eventId, billId: filedId }])
  })

  it('carries a mention on a draft comment over to the filed bill, still unread', async () => {
    const filedId = await seedBill({ billNumber: 'HB 11', externalId: 'legiscan:1111' })
    const draftId = await createDraft(adminToken, 'Draft for HB 11')
    const commentRes = await SELF.fetch(`https://x/api/bills/${draftId}/comments`, {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `<p><span data-type="mention" data-id="user:${memberId}" data-label="Member">@Member</span></p>` }),
    })
    expect(commentRes.status).toBe(201)

    await link(draftId, filedId)

    const notificationsFor = async () => {
      const res = await SELF.fetch('https://x/api/notifications', { headers: { Cookie: `session=${memberToken}` } })
      return await res.json<{ unreadCount: number; notifications: Array<{ billId: string; billNumber: string; isUnread: boolean }> }>()
    }
    const before = await notificationsFor()
    expect(before.unreadCount).toBe(1)
    expect(before.notifications.map(n => [n.billId, n.billNumber, n.isUnread])).toEqual([[filedId, 'HB 11', true]])

    // Opening the filed bill's page marks it read.
    await SELF.fetch(`https://x/api/notifications/mark-read-by-bill/${filedId}`, { method: 'POST', headers: { Cookie: `session=${memberToken}` } })
    expect((await notificationsFor()).unreadCount).toBe(0)
  })
})
