import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import { eq, inArray } from 'drizzle-orm'
import { appFetch, clearDb, seedUser, seedSession, seedBill, seedBillText, seedComment, seedCommentMention, seedCalendarEvent } from '../helpers'
import { getDb } from '../../src/db/client'
import {
  bills, billMutes, billTexts, calendarEventBills, commentAttachments, commentReactions, comments, feedEvents,
  memberVotes, notes, notifications, officialPositions, teamEvents,
} from '../../src/db/schema'
import { draftDeleteVerdicts, draftDeleteStatements } from '../../src/lib/draftDelete'
import { nowDb } from '../../src/lib/dbTime'

// Approved change to #907: an admin may delete a draft that has engagement (votes, positions, live
// comments, non-empty notes) once they have seen a warning, which the request says with
// `includeEngaged`. Everything of the draft goes with it, the files on its comments included.
// Without the flag the old guard stands. The preview (`preview: true`) counts what a delete would take.

type Skipped = { id: string; reason: 'not_found' | 'not_draft' | 'engaged' | 'error' }
type BulkDeleteResult = { deleted: string[]; skipped: Skipped[] }
type Preview = {
  draftIds: string[]
  drafts: number
  filed: number
  engagedDrafts: number
  engagement: { votes: number; comments: number; notes: number; positions: number }
}

const db = () => getDb(env.DB)
let adminId: string
let adminToken: string
let member: string

const post = (body: unknown, token = adminToken) =>
  SELF.fetch('http://localhost/api/bills/bulk-delete', {
    method: 'POST',
    headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
const deleteOne = (id: string, query = '', token = adminToken) =>
  SELF.fetch(`http://localhost/api/bills/${id}${query}`, { method: 'DELETE', headers: { Cookie: `session=${token}` } })

const draft = (n: number, state = 'RI') =>
  seedBill({ isDraft: true, matchType: 'manual', billNumber: `DRAFT ${n}`, title: `Draft ${n}`, state })
const exists = async (id: string) => (await db().select({ id: bills.id }).from(bills).where(eq(bills.id, id)).get()) !== undefined
const stored = async (key: string) => (await env.ATTACHMENTS_BUCKET!.head(key)) !== null

/** A file on a comment, in the bucket and in comment_attachments, as an upload then a post leave it. */
async function attachFile(commentId: string): Promise<string> {
  const key = `${env.TENANT_ID}/${crypto.randomUUID()}`
  await env.ATTACHMENTS_BUCKET!.put(key, 'file bytes')
  const now = nowDb()
  await db().insert(commentAttachments).values({
    id: crypto.randomUUID(), commentId, uploaderId: member, r2Key: key, name: 'memo.pdf',
    contentType: 'application/pdf', size: 10, confirmedAt: now, createdAt: now,
  })
  return key
}

/** Every kind of engagement and team row a bill can hold. Returns its comments' ids and file keys. */
async function engage(billId: string) {
  await db().insert(memberVotes).values({ id: crypto.randomUUID(), userId: member, billId, position: 'support' })
  await db().insert(memberVotes).values({ id: crypto.randomUUID(), userId: adminId, billId, position: 'oppose' })
  await db().insert(officialPositions).values({ id: crypto.randomUUID(), billId, position: 'support', setBy: adminId })
  await db().insert(notes).values({ id: crypto.randomUUID(), billId, userId: member, content: 'watch this' })
  const live = await seedComment(billId, member, '<p>live</p>')
  const withFile = await seedComment(billId, adminId, '<p>see attached</p>')
  const softDeleted = await seedComment(billId, member, '<p>gone</p>')
  await db().update(comments).set({ deletedAt: '2026-06-20 00:00:00' }).where(eq(comments.id, softDeleted))
  await db().insert(commentReactions).values({ id: crypto.randomUUID(), commentId: live, userId: adminId, emoji: '👍' })
  await seedCommentMention(live, adminId)
  await db().insert(feedEvents).values({ id: crypto.randomUUID(), type: 'comment_added', billId, userId: member })
  await db().insert(teamEvents).values({ id: crypto.randomUUID(), billId, type: 'group_formed' })
  await db().insert(billMutes).values({ userId: member, billId })
  await seedBillText(billId, { docId: `doc-${billId}` })
  const keys = [await attachFile(withFile), await attachFile(softDeleted)]
  return { commentIds: [live, withFile, softDeleted], keys }
}

/** The rows of `billId` left in every table a draft's delete must empty. */
async function rowsOf(billId: string, commentIds: string[]) {
  const d = db()
  return {
    bills: await d.select().from(bills).where(eq(bills.id, billId)).all(),
    votes: await d.select().from(memberVotes).where(eq(memberVotes.billId, billId)).all(),
    positions: await d.select().from(officialPositions).where(eq(officialPositions.billId, billId)).all(),
    notes: await d.select().from(notes).where(eq(notes.billId, billId)).all(),
    comments: await d.select().from(comments).where(eq(comments.billId, billId)).all(),
    reactions: await d.select().from(commentReactions).where(inArray(commentReactions.commentId, commentIds)).all(),
    attachments: await d.select().from(commentAttachments).where(inArray(commentAttachments.commentId, commentIds)).all(),
    notifications: await d.select().from(notifications).where(eq(notifications.billId, billId)).all(),
    feedEvents: await d.select().from(feedEvents).where(eq(feedEvents.billId, billId)).all(),
    teamEvents: await d.select().from(teamEvents).where(eq(teamEvents.billId, billId)).all(),
    mutes: await d.select().from(billMutes).where(eq(billMutes.billId, billId)).all(),
    texts: await d.select().from(billTexts).where(eq(billTexts.billId, billId)).all(),
    calendarLinks: await d.select().from(calendarEventBills).where(eq(calendarEventBills.billId, billId)).all(),
  }
}
const NOTHING = {
  bills: [], votes: [], positions: [], notes: [], comments: [], reactions: [], attachments: [], notifications: [],
  feedEvents: [], teamEvents: [], mutes: [], texts: [], calendarLinks: [],
}

beforeEach(async () => {
  await clearDb()
  adminId = await seedUser({ role: 'admin', email: 'admin@example.com' })
  adminToken = await seedSession(adminId)
  member = await seedUser({ role: 'member', email: 'member@example.com' })
})

describe('POST /bills/bulk-delete with includeEngaged', () => {
  it('deletes engaged drafts with every vote, position, note, comment, reaction, notification, feed event, and file on them', async () => {
    const a = await draft(1)
    const b = await draft(2)
    const eventId = await seedCalendarEvent(await seedBill({ billNumber: 'HB 9', externalId: 'legiscan:9' }))
    const ea = await engage(a)
    const eb = await engage(b)
    await db().insert(calendarEventBills).values({ eventId, billId: a })

    const res = await post({ ids: [a, b], includeEngaged: true })

    expect(res.status).toBe(200)
    const body = await res.json() as BulkDeleteResult
    expect([...body.deleted].sort()).toEqual([a, b].sort())
    expect(body.skipped).toEqual([])
    expect(await rowsOf(a, ea.commentIds)).toEqual(NOTHING)
    expect(await rowsOf(b, eb.commentIds)).toEqual(NOTHING)
    for (const key of [...ea.keys, ...eb.keys]) expect(await stored(key), key).toBe(false)
  })

  it("leaves a filed bill's engagement and files alone in the same request", async () => {
    const d = await draft(1)
    const filed = await seedBill({ billNumber: 'HB 7', externalId: 'legiscan:7' })
    await engage(d)
    const kept = await engage(filed)

    const res = await post({ ids: [d, filed], includeEngaged: true })

    const body = await res.json() as BulkDeleteResult
    expect(body.deleted).toEqual([d])
    expect(body.skipped).toEqual([{ id: filed, reason: 'not_draft' }])
    const left = await rowsOf(filed, kept.commentIds)
    expect(left.bills).toHaveLength(1)
    expect(left.votes).toHaveLength(2)
    expect(left.comments).toHaveLength(3)
    expect(left.reactions).toHaveLength(1)
    expect(left.attachments).toHaveLength(2)
    expect(left.notifications).toHaveLength(1)
    for (const key of kept.keys) expect(await stored(key)).toBe(true)
  })

  it('still refuses engaged drafts without includeEngaged, leaving them and their files whole', async () => {
    const d = await draft(1)
    const { commentIds, keys } = await engage(d)

    const res = await post({ ids: [d] })

    expect(await res.json()).toEqual({ deleted: [], skipped: [{ id: d, reason: 'engaged' }] })
    const left = await rowsOf(d, commentIds)
    expect(left.bills).toHaveLength(1)
    expect(left.attachments).toHaveLength(2)
    for (const key of keys) expect(await stored(key)).toBe(true)
  })

  it('treats includeEngaged: false as no flag', async () => {
    const d = await draft(1)
    await engage(d)

    const res = await post({ ids: [d], includeEngaged: false })

    expect(await res.json()).toEqual({ deleted: [], skipped: [{ id: d, reason: 'engaged' }] })
  })

  it('rejects an includeEngaged that is not a boolean', async () => {
    const d = await draft(1)
    await engage(d)
    for (const includeEngaged of ['yes', 1, null]) {
      const res = await post({ ids: [d], includeEngaged })
      expect(res.status, JSON.stringify(includeEngaged)).toBe(400)
    }
    expect(await exists(d)).toBe(true)
  })

  it('deletes the drafts even when no file storage is bound, leaving the file rows for the hourly purge', async () => {
    const d = await draft(1)
    const { commentIds } = await engage(d)

    const res = await appFetch('/api/bills/bulk-delete', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [d], includeEngaged: true }),
    }, { ...env, ATTACHMENTS_BUCKET: undefined })

    expect(await res.json()).toEqual({ deleted: [d], skipped: [] })
    const left = await rowsOf(d, commentIds)
    expect({ ...left, attachments: [] }).toEqual(NOTHING)
    expect(left.attachments).toHaveLength(2)
  })

  it('refuses a member, even with includeEngaged', async () => {
    const d = await draft(1)
    await engage(d)

    const res = await post({ ids: [d], includeEngaged: true }, await seedSession(member))

    expect(res.status).toBe(403)
    expect(await exists(d)).toBe(true)
  })

  it('deletes a draft that gains engagement after the check when includeEngaged is set', async () => {
    const late = await draft(1)
    const verdicts = await draftDeleteVerdicts(db(), [late], { includeEngaged: true })
    expect(verdicts.get(late)).toBe('delete')
    await db().insert(memberVotes).values({ id: crypto.randomUUID(), userId: member, billId: late, position: 'support' })

    await db().batch(draftDeleteStatements(db(), [late], { includeEngaged: true }))

    expect(await exists(late)).toBe(false)
    expect(await db().select().from(memberVotes).where(eq(memberVotes.billId, late)).all()).toEqual([])
  })
})

describe('includeEngaged and what must survive it', () => {
  it('never deletes a bill filed after the check, nor its votes or comment files', async () => {
    const wasDraft = await draft(1)
    const { commentIds, keys } = await engage(wasDraft)
    expect((await draftDeleteVerdicts(db(), [wasDraft], { includeEngaged: true })).get(wasDraft)).toBe('delete')
    await db().update(bills).set({ isDraft: false }).where(eq(bills.id, wasDraft))

    await db().batch(draftDeleteStatements(db(), [wasDraft], { includeEngaged: true }))

    const left = await rowsOf(wasDraft, commentIds)
    expect(left.bills).toHaveLength(1)
    expect(left.votes).toHaveLength(2)
    expect(left.comments).toHaveLength(3)
    expect(left.attachments).toHaveLength(2)
    for (const key of keys) expect(await stored(key)).toBe(true)
  })

  it('still answers with the drafts deleted when removing the comment files fails, leaving their rows for the purge', async () => {
    const d = await draft(1)
    const { commentIds, keys } = await engage(d)
    const failing = new Proxy(env.ATTACHMENTS_BUCKET!, {
      get(target, key) {
        if (key === 'delete') return async () => { throw new Error('R2 unavailable') }
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })

    const res = await appFetch('/api/bills/bulk-delete', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [d], includeEngaged: true }),
    }, { ...env, ATTACHMENTS_BUCKET: failing })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ deleted: [d], skipped: [] })
    const left = await rowsOf(d, commentIds)
    expect(left.bills).toEqual([])
    expect(left.attachments).toHaveLength(2)
    for (const key of keys) expect(await stored(key)).toBe(true)
  })
})

describe('DELETE /bills/:id?includeEngaged=1', () => {
  it('deletes an engaged draft and everything on it, files included', async () => {
    const d = await draft(1)
    const { commentIds, keys } = await engage(d)

    const res = await deleteOne(d, '?includeEngaged=1')

    expect(res.status).toBe(204)
    expect(await rowsOf(d, commentIds)).toEqual(NOTHING)
    for (const key of keys) expect(await stored(key)).toBe(false)
  })

  it('still answers 409 without the flag', async () => {
    const d = await draft(1)
    await engage(d)

    const refused = await deleteOne(d)
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({
      error: 'This draft has votes, comments, notes, or a position. Link it to its filed bill instead, or delete it with includeEngaged=1.',
    })
    expect((await deleteOne(d, '?includeEngaged=0')).status).toBe(409)
    expect(await exists(d)).toBe(true)
  })

  it('keeps its 403 for a filed bill and 404 for a missing one', async () => {
    const filed = await seedBill({ billNumber: 'HB 3', externalId: 'legiscan:3' })

    expect((await deleteOne(filed, '?includeEngaged=1')).status).toBe(403)
    expect((await deleteOne('no-such-bill', '?includeEngaged=1')).status).toBe(404)
    expect(await exists(filed)).toBe(true)
  })

  it('refuses a member', async () => {
    const d = await draft(1)
    expect((await deleteOne(d, '?includeEngaged=1', await seedSession(member))).status).toBe(403)
    expect(await exists(d)).toBe(true)
  })
})

describe('POST /bills/bulk-delete with a filter', () => {
  it('previews the drafts the filter matches, naming their ids, and no others', async () => {
    const ri1 = await draft(1)
    const ri2 = await draft(2)
    await draft(3, 'TX')
    await seedBill({ billNumber: 'HB 4', externalId: 'legiscan:4' })

    const res = await post({ filter: 'drafts=true&state=RI', preview: true })

    expect(res.status).toBe(200)
    const body = await res.json() as Preview
    expect(body.draftIds).toEqual([ri1, ri2].sort())
    expect(body.drafts).toBe(2)
  })

  it('refuses to delete by a filter: a delete names the drafts its preview counted', async () => {
    const d = await draft(1)

    for (const body of [{ filter: 'drafts=true' }, { filter: 'drafts=true', includeEngaged: true }]) {
      const res = await post(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    expect(await exists(d)).toBe(true)
  })

  it('leaves a draft created after the preview when deleting the ids the preview named', async () => {
    const counted = await draft(1)
    await engage(counted)
    const preview = await (await post({ filter: 'drafts=true', preview: true })).json() as Preview
    const late = await draft(2)
    await engage(late)

    const res = await post({ ids: preview.draftIds, includeEngaged: true })

    expect(await res.json()).toEqual({ deleted: [counted], skipped: [] })
    expect(await exists(late)).toBe(true)
  })

  it('refuses a filter without the Drafts filter on', async () => {
    const d = await draft(1)

    for (const filter of ['', 'state=RI', 'drafts=false']) {
      const res = await post({ filter, preview: true })
      expect(res.status, filter).toBe(400)
    }
    expect(await exists(d)).toBe(true)
  })

  it('rejects a body with both ids and a filter, or a filter that is not a query string', async () => {
    const d = await draft(1)
    for (const body of [{ ids: [d], filter: 'drafts=true', preview: true }, { filter: { drafts: true }, preview: true }]) {
      const res = await post(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    expect(await exists(d)).toBe(true)
  })

  it('previews nothing when the filter matches no draft', async () => {
    await draft(1)
    const res = await post({ filter: 'drafts=true&state=TX', preview: true })
    expect(await res.json()).toEqual({ draftIds: [], drafts: 0, filed: 0, engagedDrafts: 0, engagement: { votes: 0, comments: 0, notes: 0, positions: 0 } })
  })

  it('names every one of exactly 1,000 drafts the filter matches', async () => {
    await seedManyDrafts(1000)

    const res = await post({ filter: 'drafts=true', preview: true })

    expect(res.status).toBe(200)
    expect(((await res.json()) as Preview).draftIds).toHaveLength(1000)
    expect(await draftCount()).toBe(1000)
  })
})

async function seedManyDrafts(n: number) {
  await env.DB.prepare(`INSERT INTO bills (id, bill_number, title, state, is_draft, match_type, created_at, updated_at)
    WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ?)
    SELECT 'many-' || i, 'DRAFT ' || i, 'Draft', 'RI', 1, 'manual', datetime('now'), datetime('now') FROM k`).bind(n).run()
}
async function draftCount() {
  return (await db().select({ id: bills.id }).from(bills).where(eq(bills.isDraft, true)).all()).length
}

describe('POST /bills/bulk-delete with preview: true', () => {
  /** Two drafts with engagement, one clean draft, and a filed bill with engagement of its own. */
  async function seedSelection() {
    const engaged1 = await draft(1)
    const engaged2 = await draft(2)
    const clean = await draft(3)
    const filed = await seedBill({ billNumber: 'HB 5', externalId: 'legiscan:5' })
    await engage(engaged1) // 2 votes, 1 position, 1 note, 2 live comments (and one deleted)
    await db().insert(memberVotes).values({ id: crypto.randomUUID(), userId: member, billId: engaged2, position: 'neutral' })
    await seedComment(engaged2, member, '<p>one</p>')
    // A clean draft can hold a deleted comment and an empty note: neither counts.
    const gone = await seedComment(clean, member, '<p>gone</p>')
    await db().update(comments).set({ deletedAt: '2026-06-20 00:00:00' }).where(eq(comments.id, gone))
    await db().insert(notes).values({ id: crypto.randomUUID(), billId: clean, userId: member, content: '' })
    await engage(filed)
    return { engaged1, engaged2, clean, filed }
  }

  const EXPECTED = (s: { engaged1: string; engaged2: string; clean: string }): Preview => ({
    draftIds: [s.engaged1, s.engaged2, s.clean].sort(),
    drafts: 3, filed: 1, engagedDrafts: 2,
    engagement: { votes: 3, comments: 3, notes: 1, positions: 1 },
  })

  it('counts the drafts, the filed bills, and the engagement on the drafts of an id selection', async () => {
    const s = await seedSelection()

    const res = await post({ ids: [s.engaged1, s.engaged2, s.clean, s.filed, 'no-such-bill'], preview: true })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(EXPECTED(s))
  })

  it('counts a filter selection the same way', async () => {
    const s = await seedSelection()
    await draft(9, 'TX')

    const res = await post({ filter: 'drafts=true&state=RI', preview: true })

    expect(await res.json()).toEqual({ ...EXPECTED(s), filed: 0 })
  })

  it('writes nothing', async () => {
    const s = await seedSelection()

    await post({ ids: [s.engaged1, s.clean], preview: true, includeEngaged: true })
    await post({ filter: 'drafts=true', preview: true, includeEngaged: true })

    for (const id of [s.engaged1, s.engaged2, s.clean, s.filed]) expect(await exists(id)).toBe(true)
    expect(await db().select().from(memberVotes).all()).toHaveLength(5)
  })

  it('answers zeros for a selection with no drafts', async () => {
    const filed = await seedBill({ billNumber: 'HB 6', externalId: 'legiscan:6' })
    const res = await post({ ids: [filed], preview: true })
    expect(await res.json()).toEqual({ draftIds: [], drafts: 0, filed: 1, engagedDrafts: 0, engagement: { votes: 0, comments: 0, notes: 0, positions: 0 } })
  })

  it('refuses more than 1,000 ids, and a filter matching more than 1,000 drafts', async () => {
    const ids = Array.from({ length: 1001 }, (_, i) => `missing-${i}`)
    expect((await post({ ids, preview: true })).status).toBe(400)

    await seedManyDrafts(1001)
    const res = await post({ filter: 'drafts=true', preview: true })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Too many drafts (1,001). Apply more filters to narrow down to 1,000 or fewer.' })
  })

  it('refuses a filter without the Drafts filter on', async () => {
    await draft(1)
    expect((await post({ filter: 'state=RI', preview: true })).status).toBe(400)
  })

  it('rejects a preview that is not a boolean', async () => {
    const d = await draft(1)
    const res = await post({ ids: [d], preview: 'yes' })
    expect(res.status).toBe(400)
    expect(await exists(d)).toBe(true)
  })

  it('refuses a member', async () => {
    const d = await draft(1)
    const res = await post({ ids: [d], preview: true }, await seedSession(member))
    expect(res.status).toBe(403)
  })

  it('is refused in a demo, as the delete is', async () => {
    const d = await draft(1)
    const res = await appFetch('/api/bills/bulk-delete', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [d], preview: true }),
    }, { ...env, DEMO_MODE: 'true' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'This action is locked in the demo' })
  })
})
