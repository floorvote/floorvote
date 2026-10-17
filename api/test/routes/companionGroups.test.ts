import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { app } from '../../src/index'
import { and, eq } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, bills, calendarEvents, comments, memberVotes, notes, notifications, users } from '../../src/db/schema'
import { syncIdenticalCompanions } from '../../src/lib/companionGroups'
import { centralFetch } from '../../src/lib/centralFetch'

// What the bill routes return for a companion group. Engagement stays on the
// bill where it was made, and reads resolve across the group: comments
// interleave, a member's latest vote on any member counts, and a member's
// private notes from every member show together. Splitting the group restores
// each bill's own.

vi.mock('../../src/lib/centralFetch', () => ({ centralFetch: vi.fn() }))

type Detail = {
  comments: Array<{ id: string; billId: string; billNumber: string; content: string }>
  commentsTotal: number
  groupBills: Array<{ billId: string; billNumber: string; state: string; sessionSlug: string }>
  companionBillIds?: unknown
  groupingEvents: Array<{ type: string; actorName: string | null; with: Array<{ billId: string; billNumber: string }>; createdAt: string }>
  myVote: string | null
  voteCounts: { support: number; oppose: number; neutral: number; total: number }
  memberVotes?: Array<{ userName: string; position: string }>
  myNote: string | null
  myNotes: Array<{ billId: string; billNumber: string; content: string }>
}

describe('bill routes across a companion group', () => {
  const cookie: Record<string, string> = {}
  const user: Record<string, string> = {}
  const db = () => getDb(env.DB)

  async function as(name: string, path: string, init: RequestInit = {}) {
    return SELF.fetch(`https://x/api${path}`, {
      ...init,
      headers: { Cookie: cookie[name], 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    })
  }
  async function detail(name: string, billId: string): Promise<Detail> {
    const res = await as(name, `/bills/${billId}`)
    expect(res.status).toBe(200)
    return await res.json() as Detail
  }

  const group = () => syncIdenticalCompanions(db(), 'legiscan:1713', [{ sastBillId: 190, kind: 'identical' }])
  const split = () => syncIdenticalCompanions(db(), 'legiscan:1713', [])

  async function comment(id: string, billId: string, userId: string, createdAt: string) {
    await db().insert(comments).values({ id, billId, userId, content: `<p>${id}</p>`, createdAt })
  }
  async function vote(billId: string, userId: string, position: 'support' | 'oppose' | 'neutral', updatedAt: string) {
    await db().insert(memberVotes).values({ id: crypto.randomUUID(), billId, userId, position, createdAt: updatedAt, updatedAt })
  }
  async function note(billId: string, userId: string, content: string, updatedAt = '2026-10-01 00:00:00') {
    await db().insert(notes).values({ id: crypto.randomUUID(), billId, userId, content, createdAt: updatedAt, updatedAt })
  }

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    vi.mocked(centralFetch).mockReset()
    vi.mocked(centralFetch).mockRejectedValue(new Error('central unreachable'))
    for (const [name, role] of [['ann', 'member'], ['ben', 'member'], ['ada', 'admin']] as const) {
      user[name] = await seedUser({ name, email: `${name}@example.com`, role })
      cookie[name] = `session=${await seedSession(user[name])}`
    }
    await seedBill({ id: 'a190', billNumber: 'A190', state: 'NJ', externalId: 'legiscan:190' })
    await seedBill({ id: 'b1713', billNumber: 'S1713', state: 'NJ', externalId: 'legiscan:1713' })
  })

  describe('comments', () => {
    beforeEach(async () => {
      await comment('c1', 'a190', user.ann, '2026-10-01 09:00:00')
      await comment('c2', 'b1713', user.ben, '2026-10-01 10:00:00')
      await comment('c3', 'a190', user.ben, '2026-10-01 11:00:00')
    })

    it("interleave the whole group's comments by time on each member's page, each with its bill", async () => {
      await group()
      for (const billId of ['a190', 'b1713']) {
        const d = await detail('ann', billId)
        expect(d.comments.map(c => [c.id, c.billNumber])).toEqual([['c1', 'A190'], ['c2', 'S1713'], ['c3', 'A190']])
        expect(d.comments[1].billId).toBe('b1713')
        expect(d.commentsTotal).toBe(3)
      }
    })

    it('interleave on the comments route too', async () => {
      await group()
      const res = await as('ann', '/bills/b1713/comments')
      const list = await res.json() as Array<{ id: string; billNumber: string }>
      expect(list.map(c => [c.id, c.billNumber])).toEqual([['c1', 'A190'], ['c2', 'S1713'], ['c3', 'A190']])
    })

    it('stay on their own bill when it is not grouped', async () => {
      const d = await detail('ann', 'a190')
      expect(d.comments.map(c => [c.id, c.billNumber])).toEqual([['c1', 'A190'], ['c3', 'A190']])
      expect(d.commentsTotal).toBe(2)
    })

    it("return to their own bill's page when the group splits", async () => {
      await group()
      expect((await detail('ann', 'a190')).comments.map(c => c.id)).toEqual(['c1', 'c2', 'c3'])
      await split()
      expect((await detail('ann', 'a190')).comments.map(c => c.id)).toEqual(['c1', 'c3'])
      expect((await detail('ann', 'b1713')).comments.map(c => c.id)).toEqual(['c2'])
    })

    it("notify a companion's commenters of a new comment, since it is one conversation", async () => {
      await group()
      // Ben commented on both bills, Ann only on A190, so Ann is the one who
      // would miss a reply on S1713 if participants stayed per bill.
      await db().delete(comments).where(eq(comments.id, 'c3'))
      // In-app only, so no reply email is still sending when the next test resets the database.
      await db().update(users).set({ emailRepliesEnabled: 0 }).where(eq(users.id, user.ann))
      const res = await as('ben', '/bills/b1713/comments', { method: 'POST', body: JSON.stringify({ content: '<p>reply</p>' }) })
      expect(res.status).toBe(201)
      const rows = await db().select().from(notifications).where(and(eq(notifications.recipientId, user.ann), eq(notifications.kind, 'reply'))).all()
      expect(rows).toHaveLength(1)
    })
  })

  describe('the group bills', () => {
    beforeEach(async () => {
      await db().update(bills).set({ sessionSlug: '2026' }).where(eq(bills.id, 'a190'))
      await db().update(bills).set({ sessionSlug: '2025-2026' }).where(eq(bills.id, 'b1713'))
    })

    it('carry each bill\'s state and session slug with its id and number, the page\'s bill first, for a group of two', async () => {
      await group()
      expect((await detail('ann', 'a190')).groupBills).toEqual([
        { billId: 'a190', billNumber: 'A190', state: 'NJ', sessionSlug: '2026' },
        { billId: 'b1713', billNumber: 'S1713', state: 'NJ', sessionSlug: '2025-2026' },
      ])
      expect((await detail('ann', 'b1713')).groupBills).toEqual([
        { billId: 'b1713', billNumber: 'S1713', state: 'NJ', sessionSlug: '2025-2026' },
        { billId: 'a190', billNumber: 'A190', state: 'NJ', sessionSlug: '2026' },
      ])
    })

    it('list every bill of a group of three, the page\'s bill first and the rest by number', async () => {
      await seedBill({ id: 'c2000', billNumber: 'H2000', state: 'NJ', sessionSlug: '2024', externalId: 'legiscan:2000' })
      await syncIdenticalCompanions(db(), 'legiscan:1713', [{ sastBillId: 190, kind: 'identical' }, { sastBillId: 2000, kind: 'identical' }])
      const d = await detail('ann', 'b1713')
      expect(d.groupBills.map(b => b.billNumber)).toEqual(['S1713', 'A190', 'H2000'])
      expect(d.groupBills.map(b => b.sessionSlug)).toEqual(['2025-2026', '2026', '2024'])
    })

    it('carry a bill from another state with that state, since a hand-made group can cross states', async () => {
      await seedBill({ id: 'g5000', billNumber: 'TX5000', state: 'TX', session: '2027', sessionSlug: '2027', externalId: 'legiscan:5000' })
      expect((await as('ada', '/bills/a190/group', { method: 'POST', body: JSON.stringify({ withBillId: 'g5000' }) })).status).toBe(200)
      expect((await detail('ann', 'a190')).groupBills.map(b => [b.billNumber, b.state, b.sessionSlug])).toEqual([['A190', 'NJ', '2026'], ['TX5000', 'TX', '2027']])
    })

    it('are the page\'s bill alone for a bill in no group', async () => {
      expect((await detail('ann', 'a190')).groupBills).toEqual([{ billId: 'a190', billNumber: 'A190', state: 'NJ', sessionSlug: '2026' }])
    })

    it('are the page\'s bill alone again once the group splits', async () => {
      await group()
      await split()
      expect((await detail('ann', 'a190')).groupBills.map(b => b.billNumber)).toEqual(['A190'])
    })

    it('no longer serve companionBillIds, even for a bill that has the legacy column set', async () => {
      await db().update(bills).set({ companionBillIds: JSON.stringify(['legacy-1']) }).where(eq(bills.id, 'a190'))
      const d = await detail('ann', 'a190')
      expect('companionBillIds' in d).toBe(false)
      expect(JSON.stringify(d)).not.toContain('legacy-1')
    })
  })

  describe('the grouping line', () => {
    it("is on each member's page once the group forms, naming the other bill", async () => {
      await group()
      const events = (await detail('ann', 'a190')).groupingEvents
      expect(events).toEqual([expect.objectContaining({ type: 'grouped', actorName: null, with: [{ billId: 'b1713', billNumber: 'S1713' }] })])
      expect((await detail('ann', 'b1713')).groupingEvents).toEqual([
        expect.objectContaining({ type: 'grouped', with: [{ billId: 'a190', billNumber: 'A190' }] }),
      ])
    })

    it('is followed by a split line when the group splits', async () => {
      await group()
      await split()
      expect((await detail('ann', 'a190')).groupingEvents?.map(e => e.type)).toEqual(['grouped', 'split'])
    })

    it('is absent from a bill that was never grouped', async () => {
      expect((await detail('ann', 'a190')).groupingEvents).toEqual([])
    })
  })

  describe('votes', () => {
    it("count a member's latest vote on any member, once per group", async () => {
      await vote('b1713', user.ann, 'oppose', '2026-10-01 09:00:00')
      await vote('a190', user.ann, 'support', '2026-10-02 09:00:00')
      await vote('b1713', user.ben, 'neutral', '2026-10-01 09:00:00')
      await group()
      for (const billId of ['a190', 'b1713']) {
        const d = await detail('ann', billId)
        expect(d.myVote).toBe('support')
        expect(d.voteCounts).toEqual({ support: 1, oppose: 0, neutral: 1, total: 2 })
      }
    })

    it("list each member's group vote once for admins", async () => {
      await vote('b1713', user.ann, 'oppose', '2026-10-01 09:00:00')
      await vote('a190', user.ann, 'support', '2026-10-02 09:00:00')
      await group()
      const d = await detail('ada', 'b1713')
      expect(d.memberVotes!.map(v => [v.userName, v.position])).toEqual([['ann', 'support']])
    })

    it('follow a vote cast on either page', async () => {
      await group()
      expect((await as('ann', '/bills/a190/votes', { method: 'POST', body: JSON.stringify({ position: 'support' }) })).status).toBe(200)
      expect((await as('ann', '/bills/b1713/votes', { method: 'POST', body: JSON.stringify({ position: 'oppose' }) })).status).toBe(200)
      const d = await detail('ann', 'a190')
      expect(d.myVote).toBe('oppose')
      expect(d.voteCounts.total).toBe(1)
    })

    it('follow the last vote cast when votes on both bills land in the same second', async () => {
      await group()
      // Votes are stored to the second, so these three tie on time. The last
      // one changes A190's existing vote, which predates S1713's.
      for (const [billId, position] of [['a190', 'support'], ['b1713', 'oppose'], ['a190', 'neutral']]) {
        expect((await as('ann', `/bills/${billId}/votes`, { method: 'POST', body: JSON.stringify({ position }) })).status).toBe(200)
      }
      expect((await detail('ann', 'b1713')).myVote).toBe('neutral')
    })

    it('retract for the whole group, so an older vote on a companion does not come back', async () => {
      await vote('b1713', user.ann, 'oppose', '2026-10-01 09:00:00')
      await vote('a190', user.ann, 'support', '2026-10-02 09:00:00')
      await group()
      expect((await as('ann', '/bills/a190/votes', { method: 'DELETE' })).status).toBe(204)
      expect((await detail('ann', 'b1713')).myVote).toBeNull()
      expect((await detail('ann', 'a190')).voteCounts.total).toBe(0)
    })

    it("resolve per bill again once the group splits", async () => {
      await vote('b1713', user.ann, 'oppose', '2026-10-01 09:00:00')
      await vote('a190', user.ann, 'support', '2026-10-02 09:00:00')
      await group()
      expect((await detail('ann', 'b1713')).myVote).toBe('support')
      await split()
      expect((await detail('ann', 'a190')).myVote).toBe('support')
      expect((await detail('ann', 'b1713')).myVote).toBe('oppose')
      expect((await detail('ann', 'b1713')).voteCounts).toEqual({ support: 0, oppose: 1, neutral: 0, total: 1 })
    })
  })

  describe('the dashboard', () => {
    type Sidebar = { unvotedPriorityCount: number; priorityBills: Array<{ id: string; myVote: string | null }> }
    async function sidebar(): Promise<Sidebar> {
      const res = await as('ann', '/stats/sidebar')
      expect(res.status).toBe(200)
      return await res.json() as Sidebar
    }

    it("counts a priority bill as voted on when the member voted on its companion", async () => {
      await db().update(bills).set({ priority: 'high' }).where(eq(bills.id, 'b1713'))
      await vote('a190', user.ann, 'support', '2026-10-02 09:00:00')
      await group()
      const s = await sidebar()
      expect(s.unvotedPriorityCount).toBe(0)
      expect(s.priorityBills.map(b => [b.id, b.myVote])).toEqual([['b1713', 'support']])
    })

    it("shows the member's group vote on a priority bill's upcoming hearing", async () => {
      await db().update(bills).set({ priority: 'high' }).where(eq(bills.id, 'b1713'))
      await db().insert(associationConfig).values({ key: 'modules', value: JSON.stringify({ 'upcoming-hearings': { enabled: true } }) })
      await db().insert(calendarEvents).values({
        id: 'h1', uid: 'h1@test', billId: 'b1713', source: 'hearing', sequence: 0,
        date: new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10), time: '10:00:00', location: 'Room 11', description: 'Committee hearing',
        status: 'confirmed', eventHash: 'eh1',
      })
      await vote('a190', user.ann, 'oppose', '2026-10-02 09:00:00')
      await group()
      const res = await app.request('/api/stats/sidebar', { headers: { Cookie: cookie.ann } }, { ...env, DEMO_MODE: 'true' })
      const body = await res.json() as { upcomingHearings: Array<{ bills: Array<{ billNumber: string; myVote: string | null }> }> }
      expect(body.upcomingHearings[0].bills.map(b => [b.billNumber, b.myVote])).toEqual([['S1713', 'oppose']])
    })
  })

  describe('private notes', () => {
    beforeEach(async () => {
      await note('a190', user.ann, '<p>Ann on A190</p>')
      await note('b1713', user.ann, '<p>Ann on S1713</p>')
      await note('b1713', user.ben, '<p>Ben on S1713</p>')
    })

    it("show a member's notes from every bill in the group, the viewed bill's first, and nobody else's", async () => {
      await group()
      const d = await detail('ann', 'b1713')
      expect(d.myNotes?.map(n => [n.billNumber, n.content])).toEqual([['S1713', '<p>Ann on S1713</p>'], ['A190', '<p>Ann on A190</p>']])
      // The note to edit holds both, each under its bill number.
      expect(d.myNote).toContain('S1713')
      expect(d.myNote).toContain('<p>Ann on S1713</p>')
      expect(d.myNote).toContain('A190')
      expect(d.myNote).toContain('<p>Ann on A190</p>')
      expect(d.myNote).not.toContain('Ben')
    })

    it('show on the note route the same way', async () => {
      await group()
      const res = await as('ann', '/bills/a190/note')
      const body = await res.json() as { content: string; notes: Array<{ billNumber: string }> }
      expect(body.notes?.map(n => n.billNumber)).toEqual(['A190', 'S1713'])
      expect(body.content).toContain('<p>Ann on S1713</p>')
    })

    it("become one note, on the viewed bill, on the member's next edit", async () => {
      await group()
      // The page showed both notes stacked, so it names the companion's as merged.
      const res = await as('ann', '/bills/a190/note', { method: 'PUT', body: JSON.stringify({ content: '<p>merged</p>', merges: ['b1713'] }) })
      expect(res.status).toBe(200)
      for (const billId of ['a190', 'b1713']) {
        const d = await detail('ann', billId)
        expect(d.myNotes?.map(n => [n.billId, n.content])).toEqual([['a190', '<p>merged</p>']])
        expect(d.myNote).toBe('<p>merged</p>')
      }
      // Another member's note on the companion is untouched.
      expect((await detail('ben', 'a190')).myNotes?.map(n => n.content)).toEqual(['<p>Ben on S1713</p>'])
    })

    it('merge a lone companion note the page showed into the edit', async () => {
      await db().delete(notes).where(and(eq(notes.billId, 'a190'), eq(notes.userId, user.ann)))
      await group()
      expect((await detail('ann', 'a190')).myNotes?.map(n => n.billId)).toEqual(['b1713'])
      await as('ann', '/bills/a190/note', { method: 'PUT', body: JSON.stringify({ content: '<p>edited</p>', merges: ['b1713'] }) })
      expect((await detail('ann', 'b1713')).myNotes?.map(n => [n.billId, n.content])).toEqual([['a190', '<p>edited</p>']])
    })

    it('keep a companion note the page never showed, when a page from before the grouping saves', async () => {
      await group()
      // A tab opened before the bills were grouped saves with no merged notes.
      const res = await as('ann', '/bills/a190/note', { method: 'PUT', body: JSON.stringify({ content: '<p>edited</p>' }) })
      expect(res.status).toBe(200)
      expect((await detail('ann', 'b1713')).myNotes?.map(n => [n.billNumber, n.content])).toEqual([
        ['S1713', '<p>Ann on S1713</p>'], ['A190', '<p>edited</p>'],
      ])
    })

    it('merge away only notes from the same group', async () => {
      await seedBill({ id: 'z9', billNumber: 'Z9', state: 'NJ', externalId: 'legiscan:9' })
      await note('z9', user.ann, '<p>Ann on Z9</p>')
      await group()
      await as('ann', '/bills/a190/note', { method: 'PUT', body: JSON.stringify({ content: '<p>merged</p>', merges: ['b1713', 'z9'] }) })
      expect((await detail('ann', 'z9')).myNote).toBe('<p>Ann on Z9</p>')
    })

    it("stay per bill when the bill isn't grouped", async () => {
      const d = await detail('ann', 'a190')
      expect(d.myNote).toBe('<p>Ann on A190</p>')
      expect(d.myNotes?.map(n => n.billNumber)).toEqual(['A190'])
    })

    it('separate again when the group splits before an edit', async () => {
      await group()
      expect((await detail('ann', 'a190')).myNotes).toHaveLength(2)
      await split()
      expect((await detail('ann', 'a190')).myNote).toBe('<p>Ann on A190</p>')
      expect((await detail('ann', 'b1713')).myNote).toBe('<p>Ann on S1713</p>')
    })
  })
})
