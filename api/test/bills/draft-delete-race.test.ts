import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { eq, inArray } from 'drizzle-orm'
import { clearDb, seedUser, seedBill, seedComment } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills, comments, feedEvents, memberVotes, notes, officialPositions } from '../../src/db/schema'
import { draftDeleteVerdicts, draftDeleteStatements, deleteCleared } from '../../src/lib/draftDelete'

// The check (draftDeleteVerdicts) and the delete (one db.batch) are two round trips, so a draft can
// gain a vote, position, comment, or note in between. The batch must then leave it whole: its guard
// is part of the statements, not only of the read before them.
describe('draft delete: engagement that arrives between the check and the batch', () => {
  const db = () => getDb(env.DB)
  let adminId: string
  let member: string

  const draft = (n: number) => seedBill({ isDraft: true, matchType: 'manual', billNumber: `DRAFT ${n}`, title: `Draft ${n}` })
  const addFeedEvent = (billId: string) =>
    db().insert(feedEvents).values({ id: crypto.randomUUID(), type: 'bill_added', billId, userId: adminId })
  const exists = async (id: string) => (await db().select({ id: bills.id }).from(bills).where(eq(bills.id, id)).get()) !== undefined

  const lateEngagement: Array<[string, (billId: string) => Promise<unknown>]> = [
    ['a vote', id => db().insert(memberVotes).values({ id: crypto.randomUUID(), userId: member, billId: id, position: 'support' })],
    ['an official position', id => db().insert(officialPositions).values({ id: crypto.randomUUID(), billId: id, position: 'support', setBy: adminId })],
    ['a live comment', id => seedComment(id, member, '<p>late</p>')],
    ['a non-empty note', id => db().insert(notes).values({ id: crypto.randomUUID(), billId: id, userId: member, content: 'late note' })],
  ]

  beforeEach(async () => {
    await clearDb()
    adminId = await seedUser({ role: 'admin', email: 'admin@example.com' })
    member = await seedUser({ role: 'member', email: 'member@example.com' })
  })

  it.each(lateEngagement)('keeps a draft that gains %s after the check, and still deletes the clean drafts of the same batch', async (_name, engage) => {
    const late = await draft(1)
    const clean = await draft(2)
    await addFeedEvent(late)
    await addFeedEvent(clean)
    const verdicts = await draftDeleteVerdicts(db(), [late, clean])
    expect([...verdicts.values()]).toEqual(['delete', 'delete'])

    await engage(late)
    await db().batch(draftDeleteStatements(db(), [late, clean]))

    expect(await exists(late)).toBe(true)
    expect(await exists(clean)).toBe(false)
    // Nothing of the kept draft was removed: not its feed event, and not the engagement itself.
    expect(await db().select().from(feedEvents).where(eq(feedEvents.billId, late)).all()).toHaveLength(1)
    expect(await db().select().from(feedEvents).where(eq(feedEvents.billId, clean)).all()).toEqual([])
    const engagement = [
      await db().select().from(memberVotes).where(eq(memberVotes.billId, late)).all(),
      await db().select().from(officialPositions).where(eq(officialPositions.billId, late)).all(),
      await db().select().from(comments).where(eq(comments.billId, late)).all(),
      await db().select().from(notes).where(eq(notes.billId, late)).all(),
    ]
    expect(engagement.flat()).toHaveLength(1)
  })

  it('never deletes a bill that was filed after the check', async () => {
    const wasDraft = await draft(1)
    await draftDeleteVerdicts(db(), [wasDraft])
    await db().update(bills).set({ isDraft: false }).where(eq(bills.id, wasDraft))

    await db().batch(draftDeleteStatements(db(), [wasDraft]))

    expect(await db().select({ id: bills.id }).from(bills).where(inArray(bills.id, [wasDraft])).all()).toHaveLength(1)
  })

  it('reports a draft that gained engagement after the check as engaged, and the clean ones as deleted', async () => {
    const late = await draft(1)
    const clean = await draft(2)
    await draftDeleteVerdicts(db(), [late, clean])
    await db().insert(memberVotes).values({ id: crypto.randomUUID(), userId: member, billId: late, position: 'support' })

    const result = await deleteCleared(db(), [late, clean])

    expect(result).toEqual({ deleted: [clean], skipped: [{ id: late, reason: 'engaged' }] })
  })

  it('reports a draft filed or deleted after the check under the reason a fresh check gives it', async () => {
    const filed = await draft(1)
    const gone = await draft(2)
    await draftDeleteVerdicts(db(), [filed, gone])
    await db().update(bills).set({ isDraft: false }).where(eq(bills.id, filed))
    await db().delete(bills).where(eq(bills.id, gone))

    const result = await deleteCleared(db(), [filed, gone])

    expect(result.deleted).toEqual([])
    expect([...result.skipped].sort((a, b) => a.reason.localeCompare(b.reason))).toEqual(
      [{ id: gone, reason: 'not_found' }, { id: filed, reason: 'not_draft' }].sort((a, b) => a.reason.localeCompare(b.reason)),
    )
  })

  it('leaves the rows of an orphaned id alone when its bill is kept, and removes them once the bill is gone', async () => {
    const kept = await draft(1)
    const removed = await draft(2)
    await addFeedEvent(kept)
    await addFeedEvent(removed)
    await db().insert(memberVotes).values({ id: crypto.randomUUID(), userId: member, billId: kept, position: 'support' })

    const result = await deleteCleared(db(), [kept, removed])

    expect(result.deleted).toEqual([removed])
    expect(await db().select().from(feedEvents).where(eq(feedEvents.billId, kept)).all()).toHaveLength(1)
    expect(await db().select().from(feedEvents).where(eq(feedEvents.billId, removed)).all()).toEqual([])
  })
})
