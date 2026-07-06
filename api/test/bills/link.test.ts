import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills, memberVotes, officialPositions, comments, notes } from '../../src/db/schema'
import { eq } from 'drizzle-orm'

async function createDraft(token: string, title: string): Promise<string> {
  const res = await SELF.fetch('https://x/api/bills/draft', {
    method: 'POST',
    headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  expect(res.status).toBe(201)
  return (await res.json<{ id: string }>()).id
}

describe('POST /api/bills/:id/link', () => {
  let adminToken: string
  let memberToken: string
  let memberId: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const adminId = await seedUser({ email: 'admin@x.com', role: 'admin' })
    adminToken = await seedSession(adminId)
    memberId = await seedUser({ email: 'member@x.com', role: 'member' })
    memberToken = await seedSession(memberId)
  })

  it('re-points draft engagement onto the filed bill and deletes the draft', async () => {
    const filedId = await seedBill({ billNumber: 'HB 1', externalId: 'legiscan:111' })
    const draftId = await createDraft(adminToken, 'Pre-file of HB 1')

    // Member votes on draft
    const voteRes = await SELF.fetch(`https://x/api/bills/${draftId}/votes`, {
      method: 'POST',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 'support' }),
    })
    expect(voteRes.status).toBe(200)

    // Admin sets official position on draft (must use capitalized value)
    const posRes = await SELF.fetch(`https://x/api/bills/${draftId}/position`, {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 'Oppose' }),
    })
    expect(posRes.status).toBe(200)

    // Member posts a comment on draft
    const commentRes = await SELF.fetch(`https://x/api/bills/${draftId}/comments`, {
      method: 'POST',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'a comment' }),
    })
    expect(commentRes.status).toBe(201)

    const res = await SELF.fetch(`https://x/api/bills/${draftId}/link`, {
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

    const selfLink = await SELF.fetch(`https://x/api/bills/${draftId}/link`, {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filedBillId: draftId }),
    })
    expect(selfLink.status).toBe(400)

    const noBody = await SELF.fetch(`https://x/api/bills/${draftId}/link`, {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(noBody.status).toBe(400)

    const draft2 = await createDraft(adminToken, 'Draft 3')
    const intoDraft = await SELF.fetch(`https://x/api/bills/${draftId}/link`, {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filedBillId: draft2 }),
    })
    expect(intoDraft.status).toBe(400)

    const fromFiled = await SELF.fetch(`https://x/api/bills/${filedId}/link`, {
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
    const filedPosRes = await SELF.fetch(`https://x/api/bills/${filedId}/position`, {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 'Support' }),
    })
    expect(filedPosRes.status).toBe(200)

    // Set position on draft ('Oppose')
    const draftPosRes = await SELF.fetch(`https://x/api/bills/${draftId}/position`, {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 'Oppose' }),
    })
    expect(draftPosRes.status).toBe(200)

    const res = await SELF.fetch(`https://x/api/bills/${draftId}/link`, {
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
    await SELF.fetch(`https://x/api/bills/${filedId}/votes`, {
      method: 'POST',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 'support' }),
    })
    await SELF.fetch(`https://x/api/bills/${draftId}/votes`, {
      method: 'POST',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 'support' }),
    })

    const res = await SELF.fetch(`https://x/api/bills/${draftId}/link`, {
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
    const filedNote = await SELF.fetch(`https://x/api/bills/${filedId}/note`, {
      method: 'PUT',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'filed note (canonical)' }),
    })
    expect(filedNote.status).toBe(200)
    const draftNote = await SELF.fetch(`https://x/api/bills/${draftId}/note`, {
      method: 'PUT',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'draft note (should be dropped)' }),
    })
    expect(draftNote.status).toBe(200)

    const res = await SELF.fetch(`https://x/api/bills/${draftId}/link`, {
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

    const res = await SELF.fetch(`https://x/api/bills/${draftId}/link`, {
      method: 'POST',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filedBillId: filedId }),
    })
    expect(res.status).toBe(403)

    // draft untouched
    const db = getDb(env.DB)
    expect(await db.select().from(bills).where(eq(bills.id, draftId)).get()).toBeDefined()
  })
})
