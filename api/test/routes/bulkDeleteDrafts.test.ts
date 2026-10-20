import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import { eq, inArray, isNotNull } from 'drizzle-orm'
import { clearDb, seedUser, seedSession, seedBill, seedBillText, seedComment, seedCalendarEvent } from '../helpers'
import { getDb } from '../../src/db/client'
import {
  bills, billTexts, calendarEventBills, comments, feedEvents, memberVotes, notes, officialPositions,
} from '../../src/db/schema'

type Skipped = { id: string; reason: 'not_found' | 'not_draft' | 'engaged' | 'error' }
type BulkDeleteResult = { deleted: string[]; skipped: Skipped[] }

describe('POST /bills/bulk-delete', () => {
  let adminToken: string
  let adminId: string
  const db = () => getDb(env.DB)

  const post = (body: unknown, token = adminToken) =>
    SELF.fetch('http://localhost/api/bills/bulk-delete', {
      method: 'POST',
      headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

  const draft = (n: number) => seedBill({ isDraft: true, matchType: 'manual', billNumber: `DRAFT ${n}`, title: `Draft ${n}` })
  const exists = async (id: string) => (await db().select({ id: bills.id }).from(bills).where(eq(bills.id, id)).get()) !== undefined
  const addFeedEvent = (billId: string) =>
    db().insert(feedEvents).values({ id: crypto.randomUUID(), type: 'bill_added', billId, userId: adminId })

  beforeEach(async () => {
    await clearDb()
    adminId = await seedUser({ role: 'admin', email: 'admin@example.com' })
    adminToken = await seedSession(adminId)
  })

  it('deletes every selected draft and reports them', async () => {
    const a = await draft(1)
    const b = await draft(2)
    const keep = await draft(3)

    const res = await post({ ids: [a, b] })

    expect(res.status).toBe(200)
    const body = await res.json() as BulkDeleteResult
    expect([...body.deleted].sort()).toEqual([a, b].sort())
    expect(body.skipped).toEqual([])
    expect(await exists(a)).toBe(false)
    expect(await exists(b)).toBe(false)
    expect(await exists(keep)).toBe(true)
  })

  it('removes what a single delete removes from each draft: feed events, soft-deleted comments, empty notes, texts, and calendar links', async () => {
    const drafts = [await draft(1), await draft(2)]
    const other = await seedBill({ billNumber: 'HB 1', externalId: 'legiscan:1' })
    const member = await seedUser({ role: 'member', email: 'm@example.com' })
    const eventId = await seedCalendarEvent(other)
    for (const id of drafts) {
      await addFeedEvent(id)
      await seedBillText(id, { docId: `doc-${id}` })
      // Rows a clean draft can still hold: a comment its author deleted, and an emptied note.
      const commentId = await seedComment(id, member, '<p>gone</p>')
      await db().update(comments).set({ deletedAt: '2026-06-20 00:00:00' }).where(eq(comments.id, commentId))
      await db().insert(notes).values({ id: crypto.randomUUID(), billId: id, userId: member, content: '' })
      await db().insert(calendarEventBills).values({ eventId, billId: id })
    }
    // Rows of a bill that is not selected must survive.
    await addFeedEvent(other)
    await db().insert(calendarEventBills).values({ eventId, billId: other })

    const res = await post({ ids: drafts })
    expect(res.status).toBe(200)

    const d = db()
    expect(await d.select().from(bills).where(inArray(bills.id, drafts)).all()).toEqual([])
    expect(await d.select().from(feedEvents).where(inArray(feedEvents.billId, drafts)).all()).toEqual([])
    expect(await d.select().from(comments).where(inArray(comments.billId, drafts)).all()).toEqual([])
    expect(await d.select().from(notes).where(inArray(notes.billId, drafts)).all()).toEqual([])
    expect(await d.select().from(billTexts).where(inArray(billTexts.billId, drafts)).all()).toEqual([])
    expect(await d.select().from(calendarEventBills).where(inArray(calendarEventBills.billId, drafts)).all()).toEqual([])
    expect(await d.select().from(feedEvents).where(eq(feedEvents.billId, other)).all()).toHaveLength(1)
    expect(await d.select().from(calendarEventBills).where(eq(calendarEventBills.billId, other)).all()).toHaveLength(1)
  })

  it('deletes only the drafts of a mixed selection and leaves the filed bills and their rows alone', async () => {
    const d1 = await draft(1)
    const d2 = await draft(2)
    const filed = await seedBill({ billNumber: 'HB 7', externalId: 'legiscan:7', isDraft: false, matchType: 'keyword' })
    await addFeedEvent(filed)

    const res = await post({ ids: [d1, filed, d2] })

    expect(res.status).toBe(200)
    const body = await res.json() as BulkDeleteResult
    expect([...body.deleted].sort()).toEqual([d1, d2].sort())
    expect(body.skipped).toEqual([{ id: filed, reason: 'not_draft' }])
    expect(await exists(d1)).toBe(false)
    expect(await exists(d2)).toBe(false)
    expect(await exists(filed)).toBe(true)
    expect(await db().select().from(feedEvents).where(eq(feedEvents.billId, filed)).all()).toHaveLength(1)
  })

  it('refuses a draft that has engagement, as a single delete does, and deletes the others', async () => {
    const voter = await seedUser({ role: 'member', email: 'v@example.com' })
    const withVote = await draft(1)
    const withPosition = await draft(2)
    const withComment = await draft(3)
    const withNote = await draft(4)
    const clean = await draft(5)
    await db().insert(memberVotes).values({ id: crypto.randomUUID(), userId: voter, billId: withVote, position: 'support' })
    await db().insert(officialPositions).values({ id: crypto.randomUUID(), billId: withPosition, position: 'support', setBy: adminId })
    await seedComment(withComment, voter, '<p>live</p>')
    await db().insert(notes).values({ id: crypto.randomUUID(), billId: withNote, userId: voter, content: 'watch this' })
    const engaged = [withVote, withPosition, withComment, withNote]
    for (const id of engaged) await addFeedEvent(id)

    const res = await post({ ids: [...engaged, clean] })

    expect(res.status).toBe(200)
    const body = await res.json() as BulkDeleteResult
    expect(body.deleted).toEqual([clean])
    const byId = (x: Skipped, y: Skipped) => x.id.localeCompare(y.id)
    expect([...body.skipped].sort(byId))
      .toEqual(engaged.map(id => ({ id, reason: 'engaged' as const })).sort(byId))
    for (const id of engaged) expect(await exists(id)).toBe(true)
    expect(await exists(clean)).toBe(false)
    // Nothing of a refused draft was partly removed.
    const d = db()
    expect(await d.select().from(memberVotes).where(eq(memberVotes.billId, withVote)).all()).toHaveLength(1)
    expect(await d.select().from(officialPositions).where(eq(officialPositions.billId, withPosition)).all()).toHaveLength(1)
    expect(await d.select().from(comments).where(eq(comments.billId, withComment)).all()).toHaveLength(1)
    expect(await d.select().from(notes).where(eq(notes.billId, withNote)).all()).toHaveLength(1)
    expect(await d.select().from(feedEvents).where(inArray(feedEvents.billId, engaged)).all()).toHaveLength(engaged.length)
  })

  it('skips a draft another admin already deleted, without failing the rest', async () => {
    const gone = await draft(1)
    const still = await draft(2)
    // The other admin's delete lands first, through the single route.
    const single = await SELF.fetch(`http://localhost/api/bills/${gone}`, { method: 'DELETE', headers: { Cookie: `session=${adminToken}` } })
    expect(single.status).toBe(204)

    const res = await post({ ids: [gone, still] })

    expect(res.status).toBe(200)
    const body = await res.json() as BulkDeleteResult
    expect(body.deleted).toEqual([still])
    expect(body.skipped).toEqual([{ id: gone, reason: 'not_found' }])
    expect(await exists(still)).toBe(false)
  })

  it('answers a repeat of the same request with every draft not_found and changes nothing else', async () => {
    const a = await draft(1)
    const keep = await draft(2)
    expect((await post({ ids: [a] })).status).toBe(200)

    const res = await post({ ids: [a] })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ deleted: [], skipped: [{ id: a, reason: 'not_found' }] })
    expect(await exists(keep)).toBe(true)
  })

  it('counts an id named twice once', async () => {
    const a = await draft(1)

    const res = await post({ ids: [a, a] })

    expect(await res.json()).toEqual({ deleted: [a], skipped: [] })
  })

  it('deletes a selection that crosses the D1 batch boundary (>100 drafts), feed events included', async () => {
    const ids: string[] = []
    for (let i = 0; i < 205; i++) {
      const id = await draft(i)
      await addFeedEvent(id)
      ids.push(id)
    }

    const res = await post({ ids })

    expect(res.status).toBe(200)
    const body = await res.json() as BulkDeleteResult
    expect(body.deleted).toHaveLength(205)
    expect(body.skipped).toEqual([])
    expect(await db().select({ id: bills.id }).from(bills).where(eq(bills.isDraft, true)).all()).toEqual([])
    expect(await db().select().from(feedEvents).where(isNotNull(feedEvents.billId)).all()).toEqual([])
  })

  it('leaves a batch that fails whole and reports its drafts as errors, while the other batches still delete', async () => {
    const ids: string[] = []
    for (let i = 0; i < 95; i++) {
      const id = await draft(i)
      await addFeedEvent(id)
      ids.push(id)
    }
    // A real D1 failure: deleting the first draft aborts, which fails the whole first batch of 90.
    await env.DB.exec(`CREATE TRIGGER fail_one_draft_delete BEFORE DELETE ON bills WHEN OLD.id = '${ids[0]}' BEGIN SELECT RAISE(ABORT, 'boom'); END`)
    try {
      const res = await post({ ids })

      expect(res.status).toBe(200)
      const body = await res.json() as BulkDeleteResult
      expect([...body.deleted].sort()).toEqual(ids.slice(90).sort())
      expect([...body.skipped.map(x => x.id)].sort()).toEqual(ids.slice(0, 90).sort())
      expect(new Set(body.skipped.map(x => x.reason))).toEqual(new Set(['error']))
      // Atomic: nothing of the failed batch was removed, its feed events included.
      expect(await db().select({ id: bills.id }).from(bills).where(inArray(bills.id, ids.slice(0, 90))).all()).toHaveLength(90)
      expect(await db().select().from(feedEvents).where(inArray(feedEvents.billId, ids.slice(0, 90))).all()).toHaveLength(90)
      expect(await db().select({ id: bills.id }).from(bills).where(inArray(bills.id, ids.slice(90))).all()).toEqual([])
    } finally {
      await env.DB.exec('DROP TRIGGER fail_one_draft_delete')
    }
  })

  it('refuses a member and deletes nothing', async () => {
    const member = await seedUser({ role: 'member', email: 'member@example.com' })
    const memberToken = await seedSession(member)
    const a = await draft(1)

    const res = await post({ ids: [a] }, memberToken)

    expect(res.status).toBe(403)
    expect(await exists(a)).toBe(true)
  })

  it('rejects a body without a non-empty ids array of strings', async () => {
    const a = await draft(1)
    for (const body of [{}, { ids: [] }, { ids: 'x' }, { ids: [1] }, { ids: [a, null] }]) {
      const res = await post(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    expect(await exists(a)).toBe(true)
  })

  it('rejects an unparseable body', async () => {
    const res = await SELF.fetch('http://localhost/api/bills/bulk-delete', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })

  it('rejects more than 1,000 ids before deleting anything', async () => {
    const a = await draft(1)
    const ids = [a, ...Array.from({ length: 1000 }, (_, i) => `missing-${i}`)]

    const res = await post({ ids })

    expect(res.status).toBe(400)
    expect(await exists(a)).toBe(true)
  })

  it('leaves the single delete route behaving as before (same guard, same result)', async () => {
    const voter = await seedUser({ role: 'member', email: 'v2@example.com' })
    const engaged = await draft(1)
    const clean = await draft(2)
    await db().insert(memberVotes).values({ id: crypto.randomUUID(), userId: voter, billId: engaged, position: 'support' })

    const refused = await SELF.fetch(`http://localhost/api/bills/${engaged}`, { method: 'DELETE', headers: { Cookie: `session=${adminToken}` } })
    const deleted = await SELF.fetch(`http://localhost/api/bills/${clean}`, { method: 'DELETE', headers: { Cookie: `session=${adminToken}` } })

    expect(refused.status).toBe(409)
    expect(deleted.status).toBe(204)
    expect(await exists(engaged)).toBe(true)
    expect(await exists(clean)).toBe(false)
  })
})
