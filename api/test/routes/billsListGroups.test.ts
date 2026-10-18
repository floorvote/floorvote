import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { eq, inArray } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, billCustomFieldValues, bills, comments, customFieldDefinitions, memberVotes, notes, officialPositions } from '../../src/db/schema'
import { splitFromGroup } from '../../src/lib/companionGroups'

// The bill list shows a companion group as one row (#379). The list's
// filter predicates stay per bill and a group matches through any member, but
// the team's own values (priority, position, custom fields, tags) belong to the
// group, so a filter on them tests only the member holding the group's current
// value. Totals, pages, and sorts count and order groups.

type Member = { id: string; billNumber: string; state: string; status: string; sessionSlug: string; matched?: boolean }
type Row = {
  id: string
  billNumber: string
  status: string
  priority: string | null
  position: string | null
  tags: string[]
  tenantSummary: string | null
  voteCounts: { support: number; oppose: number; neutral: number }
  myVote: string | null
  commentCount: number
  hasNote: boolean
  hasComment: boolean
  customFieldValues: Record<string, string>
  group?: Member[]
}
type ListBody = { bills: Row[]; pagination: { total: number; totalPages: number; page: number } }

describe('bill list: one row per companion group', () => {
  let cookie: string
  let ada: string
  let ben: string
  const db = () => getDb(env.DB)

  async function list(qs = ''): Promise<ListBody> {
    const res = await SELF.fetch(`https://x/api/bills?${qs}`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    return await res.json() as ListBody
  }
  const numbers = (body: ListBody) => body.bills.map(b => b.group ? b.group.map(g => g.billNumber).join('+') : b.billNumber)
  // Groups bills by writing the key the way a recompute does: the smallest member id.
  async function group(...ids: string[]) {
    const key = [...ids].sort()[0]
    await db().update(bills).set({ groupKey: key }).where(inArray(bills.id, ids))
  }
  async function position(billId: string, value: string, updatedAt: string) {
    await db().insert(officialPositions).values({ id: crypto.randomUUID(), billId, position: value, setBy: ada, createdAt: updatedAt, updatedAt })
  }
  async function priority(billId: string, value: 'high' | 'medium' | 'low', setAt: string) {
    await db().update(bills).set({ priority: value, prioritySetAt: setAt }).where(eq(bills.id, billId))
  }

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    ada = await seedUser({ name: 'ada', email: 'ada@example.com', role: 'admin' })
    ben = await seedUser({ name: 'ben', email: 'ben@example.com', role: 'member' })
    cookie = `session=${await seedSession(ada)}`
    await db().insert(associationConfig).values({ key: 'tag_taxonomy', value: JSON.stringify([{ name: 'Energy' }, { name: 'Labor' }]) })
    await db().insert(customFieldDefinitions).values({ id: 'cf1', name: 'Committee', slug: 'committee', type: 'dropdown', options: JSON.stringify(['Energy', 'Labor']) })
  })

  // A190 (Introduced) and S1713 (Passed) are identical companions.
  async function companions() {
    await seedBill({ id: 'a190', billNumber: 'A190', state: 'NJ', status: 'Introduced', statusRank: 100, sessionSlug: '2026' })
    await seedBill({ id: 'b1713', billNumber: 'S1713', state: 'NJ', status: 'Passed', statusRank: 300, sessionSlug: '2026' })
    await group('a190', 'b1713')
  }

  describe('the row', () => {
    it('shows a group as one row, its bills furthest along first', async () => {
      await companions()
      const body = await list()
      expect(body.pagination.total).toBe(1)
      expect(body.bills).toHaveLength(1)
      const [row] = body.bills
      expect(row.billNumber).toBe('S1713')
      expect(row.status).toBe('Passed')
      expect(row.group?.map(g => [g.billNumber, g.status])).toEqual([['S1713', 'Passed'], ['A190', 'Introduced']])
    })

    it("gives each member's id and link parts, so each number can open its own bill", async () => {
      await companions()
      const [row] = (await list()).bills
      expect(row.group?.map(g => [g.id, g.state, g.sessionSlug])).toEqual([['b1713', 'NJ', '2026'], ['a190', 'NJ', '2026']])
    })

    it('breaks a tie in status by bill number, so the order is the same on every load', async () => {
      await seedBill({ id: 'a190', billNumber: 'A190', state: 'NJ', status: 'Introduced', statusRank: 100 })
      await seedBill({ id: 'b1713', billNumber: 'S1713', state: 'NJ', status: 'Introduced', statusRank: 100 })
      await seedBill({ id: 'c9', billNumber: 'A9', state: 'NJ', status: 'Introduced', statusRank: 100 })
      await group('a190', 'b1713', 'c9')
      const [row] = (await list()).bills
      expect(row.group?.map(g => g.billNumber)).toEqual(['A9', 'A190', 'S1713'])
    })

    it('lists every member of a large group', async () => {
      for (let i = 1; i <= 7; i++) await seedBill({ id: `r${i}`, billNumber: `HJR ${i}`, state: 'NJ', status: 'Introduced', statusRank: 100 + i })
      await group('r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7')
      const [row] = (await list()).bills
      expect(row.group).toHaveLength(7)
      expect(row.billNumber).toBe('HJR 7')
    })

    it('leaves an ungrouped bill as it is today: no group on its row', async () => {
      await seedBill({ id: 'solo', billNumber: 'HB 1', state: 'NJ', status: 'Introduced' })
      const [row] = (await list()).bills
      expect(row.billNumber).toBe('HB 1')
      expect('group' in row).toBe(false)
    })
  })

  describe('filters', () => {
    it('matches a group through any one of its bills', async () => {
      await companions()
      for (const status of ['Passed', 'Introduced']) {
        const body = await list(`status=${status}`)
        expect(body.pagination.total).toBe(1)
        expect(body.bills[0].group).toHaveLength(2)
      }
      expect((await list('status=Failed')).pagination.total).toBe(0)
    })

    it('emphasizes the bill that matched, and no other', async () => {
      await companions()
      const [row] = (await list('status=Passed')).bills
      expect(row.group?.map(g => [g.billNumber, g.matched])).toEqual([['S1713', true], ['A190', false]])
    })

    it('marks no bill as matching when nothing is filtered', async () => {
      await companions()
      const [row] = (await list()).bills
      expect(row.group?.every(g => g.matched === undefined)).toBe(true)
    })

    it('tests each bill on its own: one bill must meet every condition under AND', async () => {
      await seedBill({ id: 'a190', billNumber: 'A190', state: 'NJ', status: 'Introduced', statusRank: 100, session: 'Session X' })
      await seedBill({ id: 'b1713', billNumber: 'S1713', state: 'NJ', status: 'Passed', statusRank: 300, session: 'Session Y' })
      await group('a190', 'b1713')
      // S1713 is Passed but in Y, A190 is in X but Introduced. No bill is both.
      expect((await list('status=Passed&session=Session%20X')).pagination.total).toBe(0)
      expect((await list('status=Passed&session=Session%20Y')).pagination.total).toBe(1)
      expect((await list('status=Passed&session=Session%20X&match=any')).pagination.total).toBe(1)
    })

    it('lists the same groups however many status values the filter names', async () => {
      // A short status filter is tested twice in one statement and a long one once (D1 binds at most 100 parameters).
      await companions()
      await seedBill({ id: 'solo', billNumber: 'HB 1', state: 'NJ', status: 'Failed', statusRank: 50 })
      const many = Array.from({ length: 60 }, (_, i) => `status=Status%20${i}`).join('&')
      const short = await list('status=Passed&status=Failed&sort=bill&dir=asc')
      const long = await list(`${many}&status=Passed&status=Failed&sort=bill&dir=asc`)
      expect(long.pagination.total).toBe(2)
      expect(numbers(long)).toEqual(numbers(short))
      expect(numbers(short)).toEqual(['HB 1', 'S1713+A190'])
    })

    it('counts a group once when several of its bills match', async () => {
      await companions()
      const body = await list('state=NJ')
      expect(body.pagination.total).toBe(1)
      expect(body.bills).toHaveLength(1)
      expect(body.bills[0].group?.map(g => g.matched)).toEqual([true, true])
    })

    it('matches a search through either bill', async () => {
      await seedBill({ id: 'a190', billNumber: 'A190', title: 'Ballot access', state: 'NJ', statusRank: 100 })
      await seedBill({ id: 'b1713', billNumber: 'S1713', title: 'Ballot access', state: 'NJ', statusRank: 300 })
      await seedBill({ id: 'o', billNumber: 'HB 5', title: 'Other', state: 'NJ' })
      await group('a190', 'b1713')
      const body = await list('q=S1713')
      expect(body.pagination.total).toBe(1)
      expect(body.bills[0].group?.map(g => [g.billNumber, g.matched])).toEqual([['S1713', true], ['A190', false]])
    })

    it('floats a group whose bill number matches the search to the top', async () => {
      await seedBill({ id: 'z', billNumber: 'HB 5', title: 'Ballot 5 reform', state: 'NJ', priority: 'high', relevanceScore: 9 })
      await seedBill({ id: 'a190', billNumber: 'A190', title: 'Ballot 5 reform', state: 'NJ' })
      await seedBill({ id: 'b1713', billNumber: 'S1713', title: 'Ballot 5 reform', state: 'NJ' })
      await group('a190', 'b1713')
      expect(numbers(await list('q=S1713'))[0]).toBe('A190+S1713')
    })
  })

  describe("filters on the team's values test only the group's current value", () => {
    // A190's priority and position were set earlier, S1713's later, so the group reads S1713's.
    async function staleValues() {
      await companions()
      await priority('a190', 'low', '2026-10-01 09:00:00')
      await priority('b1713', 'high', '2026-10-01 10:00:00')
      await position('a190', 'Support', '2026-10-01 09:00:00')
      await position('b1713', 'Oppose', '2026-10-01 10:00:00')
      await db().insert(billCustomFieldValues).values([
        { billId: 'a190', fieldId: 'cf1', value: 'Energy', setBy: ada, updatedAt: '2026-10-01 09:00:00' },
        { billId: 'b1713', fieldId: 'cf1', value: 'Labor', setBy: ada, updatedAt: '2026-10-01 10:00:00' },
      ])
      await db().update(bills).set({ tags: JSON.stringify(['Energy']), tenantSummary: 'A190 summary', aiProcessedAt: '2026-10-01 09:00:00' }).where(eq(bills.id, 'a190'))
      await db().update(bills).set({ tags: JSON.stringify(['Labor']), tenantSummary: 'S1713 summary', aiProcessedAt: '2026-10-01 10:00:00' }).where(eq(bills.id, 'b1713'))
    }

    it('priority: not through the bill with the value the group replaced', async () => {
      await staleValues()
      expect((await list('priority=low')).pagination.total).toBe(0)
      const high = await list('priority=high')
      expect(high.pagination.total).toBe(1)
      expect(high.bills[0].priority).toBe('high')
      // The value is the group's, so every bill in it meets the filter.
      expect(high.bills[0].group?.map(g => [g.billNumber, g.matched])).toEqual([['S1713', true], ['A190', true]])
    })

    it("priority: a companion with no priority doesn't make the group match 'none'", async () => {
      await companions()
      await priority('b1713', 'high', '2026-10-01 10:00:00')
      expect((await list('priority=none')).pagination.total).toBe(0)
      expect((await list('priority=__any__')).pagination.total).toBe(1)
    })

    it("priority: a group with no priority matches 'none' through every member", async () => {
      await companions()
      const body = await list('priority=none')
      expect(body.pagination.total).toBe(1)
      expect(body.bills[0].group?.map(g => g.matched)).toEqual([true, true])
    })

    it('position: not through the bill with the value the group replaced', async () => {
      await staleValues()
      expect((await list('position=Support')).pagination.total).toBe(0)
      expect((await list('position=Oppose')).pagination.total).toBe(1)
      expect((await list('position=__any__')).pagination.total).toBe(1)
    })

    it("position: a companion with none doesn't make the group match 'none'", async () => {
      await companions()
      await position('a190', 'Support', '2026-10-01 09:00:00')
      expect((await list('position=none')).pagination.total).toBe(0)
    })

    it('custom fields: not through the bill with the value the group replaced', async () => {
      await staleValues()
      expect((await list('cf_committee=Energy')).pagination.total).toBe(0)
      const labor = await list('cf_committee=Labor')
      expect(labor.pagination.total).toBe(1)
      expect(labor.bills[0].group?.map(g => [g.billNumber, g.matched])).toEqual([['S1713', true], ['A190', true]])
      expect((await list('cf_committee=__any__')).pagination.total).toBe(1)
    })

    it('tags: not through the bill whose analysis the group replaced', async () => {
      await staleValues()
      expect((await list('tag=Energy')).pagination.total).toBe(0)
      expect((await list('tag=Labor')).pagination.total).toBe(1)
      expect((await list('tag=__any__')).pagination.total).toBe(1)
    })

    it("reads each value on the row from the bill that holds the group's", async () => {
      await companions() // the row's first bill is S1713, the one furthest along
      await priority('a190', 'high', '2026-10-01 10:00:00')
      await position('a190', 'Support', '2026-10-01 10:00:00')
      await db().insert(billCustomFieldValues).values({ billId: 'a190', fieldId: 'cf1', value: 'Energy', setBy: ada, updatedAt: '2026-10-01 10:00:00' })
      await db().update(bills).set({ tags: JSON.stringify(['Energy']), tenantSummary: 'A190 summary', aiProcessedAt: '2026-10-01 10:00:00' }).where(eq(bills.id, 'a190'))
      const [row] = (await list()).bills
      expect(row).toMatchObject({ billNumber: 'S1713', priority: 'high', position: 'Support', tags: ['Energy'], tenantSummary: 'A190 summary', customFieldValues: { cf1: 'Energy' } })
    })

    it("a value set on one bill is the whole group's, so the group's other bill meets the filter too", async () => {
      await companions()
      await position('a190', 'Support', '2026-10-01 09:00:00')
      const body = await list('position=Support')
      expect(body.pagination.total).toBe(1)
      expect(body.bills[0].position).toBe('Support')
      expect(body.bills[0].group?.map(g => [g.billNumber, g.matched])).toEqual([['S1713', true], ['A190', true]])
    })

    // The team's value is one thing for the whole group, the provider's facts are each bill's own, and filters
    // are ANDed on one bill. So a group meets "Passed and high priority" through S1713 even when A190 is the
    // bill that holds the priority.
    describe('combined with a provider filter on a different bill', () => {
      it('priority: finds the group, and marks only the bill that is Passed', async () => {
        await companions() // A190 Introduced, S1713 Passed
        await priority('a190', 'high', '2026-10-01 10:00:00')
        const body = await list('status=Passed&priority=high')
        expect(body.pagination.total).toBe(1)
        expect(body.bills[0].group?.map(g => [g.billNumber, g.matched])).toEqual([['S1713', true], ['A190', false]])
        expect((await list('status=Passed&priority=low')).pagination.total).toBe(0)
        expect((await list('status=Passed&priority=__any__')).pagination.total).toBe(1)
      })

      it("priority: a group whose bill replaced the other's value is found by the current one only", async () => {
        await companions()
        await priority('a190', 'low', '2026-10-01 09:00:00')
        await priority('b1713', 'high', '2026-10-01 10:00:00')
        expect((await list('status=Introduced&priority=high')).pagination.total).toBe(1)
        expect((await list('status=Introduced&priority=low')).pagination.total).toBe(0)
      })

      it('position: finds the group', async () => {
        await companions()
        await position('a190', 'Support', '2026-10-01 10:00:00')
        const body = await list('status=Passed&position=Support')
        expect(body.pagination.total).toBe(1)
        expect(body.bills[0].group?.map(g => [g.billNumber, g.matched])).toEqual([['S1713', true], ['A190', false]])
        expect((await list('status=Passed&position=Oppose')).pagination.total).toBe(0)
        expect((await list('status=Passed&position=none')).pagination.total).toBe(0)
      })

      it('a custom field: finds the group', async () => {
        await companions()
        await db().insert(billCustomFieldValues).values({ billId: 'a190', fieldId: 'cf1', value: 'Energy', setBy: ada, updatedAt: '2026-10-01 10:00:00' })
        const body = await list('status=Passed&cf_committee=Energy')
        expect(body.pagination.total).toBe(1)
        expect(body.bills[0].group?.map(g => [g.billNumber, g.matched])).toEqual([['S1713', true], ['A190', false]])
        expect((await list('status=Passed&cf_committee=Labor')).pagination.total).toBe(0)
      })

      it('tags: finds the group', async () => {
        await companions()
        await db().update(bills).set({ tags: JSON.stringify(['Energy']), tenantSummary: 'A190 summary', aiProcessedAt: '2026-10-01 10:00:00' }).where(eq(bills.id, 'a190'))
        const body = await list('status=Passed&tag=Energy')
        expect(body.pagination.total).toBe(1)
        expect(body.bills[0].group?.map(g => [g.billNumber, g.matched])).toEqual([['S1713', true], ['A190', false]])
        expect((await list('status=Passed&tag=Labor')).pagination.total).toBe(0)
      })

      it('bulk edits find the group the same way', async () => {
        await companions()
        await priority('a190', 'high', '2026-10-01 10:00:00')
        const res = await SELF.fetch('https://x/api/bills/bulk', {
          method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ filter: 'status=Passed&priority=high', position: 'Support' }),
        })
        expect(await res.json()).toEqual({ updated: 1 })
      })
    })

    it('ungrouped bills filter on their own values, as before', async () => {
      await seedBill({ id: 'p1', billNumber: 'HB 1', priority: 'high' })
      await seedBill({ id: 'p2', billNumber: 'HB 2', priority: 'low' })
      expect((await list('priority=high')).bills.map(b => b.billNumber)).toEqual(['HB 1'])
      expect((await list('priority=none')).pagination.total).toBe(0)
    })
  })

  describe('totals, pages, and sorts', () => {
    it('counts groups in the total, not bills', async () => {
      await companions()
      await seedBill({ id: 'solo', billNumber: 'HB 1', state: 'NJ' })
      const body = await list()
      expect(body.pagination.total).toBe(2)
      expect(body.bills).toHaveLength(2)
    })

    it('makes pages of groups and never splits one across two', async () => {
      for (let i = 1; i <= 5; i++) {
        await seedBill({ id: `g${i}a`, billNumber: `A${i}`, state: 'NJ', status: 'Introduced', statusRank: 100, lastActionDate: `2026-01-0${i}` })
        await seedBill({ id: `g${i}b`, billNumber: `S${i}`, state: 'NJ', status: 'Passed', statusRank: 300, lastActionDate: `2026-01-0${i}` })
        await group(`g${i}a`, `g${i}b`)
      }
      await seedBill({ id: 'solo1', billNumber: 'HB 1', state: 'NJ', lastActionDate: '2025-01-01' })
      await seedBill({ id: 'solo2', billNumber: 'HB 2', state: 'NJ', lastActionDate: '2025-01-02' })
      const seen: string[] = []
      for (const page of [1, 2, 3, 4]) {
        const body = await list(`pageSize=2&page=${page}`)
        expect(body.pagination.total).toBe(7)
        expect(body.pagination.totalPages).toBe(4)
        for (const row of body.bills) {
          seen.push(row.group ? row.group.map(g => g.billNumber).sort().join('+') : row.billNumber)
          if (row.group) expect(row.group).toHaveLength(2)
        }
      }
      expect(seen).toHaveLength(7)
      expect(new Set(seen).size).toBe(7)
    })

    it("orders groups tied on every key by group key, the same on every page", async () => {
      // Three identical pairs and three identical lone bills: every sort key ties.
      const keys: string[] = []
      for (const k of ['c', 'a', 'b']) {
        await seedBill({ id: `${k}1`, billNumber: `X${k}1`, state: 'NJ', status: 'Passed', statusRank: 300 })
        await seedBill({ id: `${k}2`, billNumber: `Y${k}2`, state: 'NJ', status: 'Passed', statusRank: 300 })
        await group(`${k}1`, `${k}2`)
        keys.push(`${k}1`)
      }
      const all = await list()
      expect(all.bills.map(b => b.group?.map(g => g.id).sort()[0])).toEqual(['a1', 'b1', 'c1'])
      const pageOne = await list('pageSize=2&page=1')
      const pageTwo = await list('pageSize=2&page=2')
      expect([...pageOne.bills, ...pageTwo.bills].map(b => b.group?.map(g => g.id).sort()[0])).toEqual(['a1', 'b1', 'c1'])
    })

    it('sorts by status with a group at its furthest-along bill', async () => {
      await companions() // Introduced (100) + Passed (300)
      await seedBill({ id: 'mid', billNumber: 'HB 2', state: 'NJ', status: 'Engrossed', statusRank: 200 })
      await seedBill({ id: 'low', billNumber: 'HB 3', state: 'NJ', status: 'Introduced', statusRank: 100 })
      expect(numbers(await list('sort=status&dir=desc'))).toEqual(['S1713+A190', 'HB 2', 'HB 3'])
      expect(numbers(await list('sort=status&dir=asc'))).toEqual(['HB 3', 'HB 2', 'S1713+A190'])
    })

    it("sorts by priority with a group at the group's priority", async () => {
      await seedBill({ id: 'a190', billNumber: 'A190', state: 'NJ', lastActionDate: '2026-01-01' })
      await seedBill({ id: 'b1713', billNumber: 'S1713', state: 'NJ', lastActionDate: '2026-01-01' })
      await group('a190', 'b1713')
      await priority('b1713', 'high', '2026-10-01 10:00:00')
      await seedBill({ id: 'med', billNumber: 'HB 2', state: 'NJ', priority: 'medium', lastActionDate: '2026-02-01' })
      expect(numbers(await list('sort=priority&dir=desc'))).toEqual(['A190+S1713', 'HB 2'])
      expect(numbers(await list('sort=priority&dir=asc'))).toEqual(['HB 2', 'A190+S1713'])
    })

    it('does not rank a group by a priority its other bill has since replaced', async () => {
      await seedBill({ id: 'a190', billNumber: 'A190', state: 'NJ', lastActionDate: '2026-01-01' })
      await seedBill({ id: 'b1713', billNumber: 'S1713', state: 'NJ', lastActionDate: '2026-01-01' })
      await group('a190', 'b1713')
      await priority('a190', 'high', '2026-10-01 09:00:00')
      await priority('b1713', 'low', '2026-10-01 10:00:00')
      await seedBill({ id: 'med', billNumber: 'HB 2', state: 'NJ', priority: 'medium', lastActionDate: '2026-02-01' })
      expect(numbers(await list('sort=priority&dir=desc'))).toEqual(['HB 2', 'A190+S1713'])
    })

    it("sorts by position with a group at the group's position", async () => {
      await seedBill({ id: 'a190', billNumber: 'A190', state: 'NJ', lastActionDate: '2026-01-01' })
      await seedBill({ id: 'b1713', billNumber: 'S1713', state: 'NJ', lastActionDate: '2026-01-01' })
      await group('a190', 'b1713')
      await position('a190', 'Support', '2026-10-01 10:00:00')
      await seedBill({ id: 'mon', billNumber: 'HB 2', state: 'NJ', lastActionDate: '2026-02-01' })
      await position('mon', 'Monitor', '2026-10-01 10:00:00')
      expect(numbers(await list('sort=position&dir=desc'))).toEqual(['A190+S1713', 'HB 2'])
    })

    it('sorts by last action with a group at its latest', async () => {
      await seedBill({ id: 'a190', billNumber: 'A190', state: 'NJ', lastActionDate: '2026-01-01' })
      await seedBill({ id: 'b1713', billNumber: 'S1713', state: 'NJ', lastActionDate: '2026-03-01' })
      await group('a190', 'b1713')
      await seedBill({ id: 'mid', billNumber: 'HB 2', state: 'NJ', lastActionDate: '2026-02-01' })
      expect(numbers(await list('sort=lastAction&dir=desc'))).toEqual(['A190+S1713', 'HB 2'])
    })

    it('sorts by relevance with a group at its most relevant bill', async () => {
      await seedBill({ id: 'a190', billNumber: 'A190', state: 'NJ', relevanceScore: 3 })
      await seedBill({ id: 'b1713', billNumber: 'S1713', state: 'NJ', relevanceScore: 9 })
      await group('a190', 'b1713')
      await seedBill({ id: 'mid', billNumber: 'HB 2', state: 'NJ', relevanceScore: 5 })
      expect(numbers(await list('sort=relevance&dir=desc'))).toEqual(['A190+S1713', 'HB 2'])
    })

    it("sorts by bill number at the group's first number", async () => {
      await companions() // furthest along: S1713
      await seedBill({ id: 'x', billNumber: 'S100', state: 'NJ', status: 'Introduced', statusRank: 100 })
      await seedBill({ id: 'y', billNumber: 'S2000', state: 'NJ', status: 'Introduced', statusRank: 100 })
      expect(numbers(await list('sort=bill&dir=asc'))).toEqual(['S100', 'S1713+A190', 'S2000'])
    })
  })

  describe('the tracked-first fast path', () => {
    it('counts a group as tracked when any bill in it is', async () => {
      const cy = new Date().getUTCFullYear()
      // Three tracked rows (one a group whose tracked bill isn't the key bill), and stubs after.
      await seedBill({ id: 'a1', billNumber: 'A1', state: 'NJ', matchType: null, yearStart: cy, yearEnd: cy })
      await seedBill({ id: 'b1', billNumber: 'S1', state: 'NJ', matchType: 'keyword', yearStart: cy, yearEnd: cy })
      await group('a1', 'b1')
      await seedBill({ id: 't1', billNumber: 'HB 1', state: 'NJ', matchType: 'keyword', priority: 'high', yearStart: cy, yearEnd: cy })
      await seedBill({ id: 't2', billNumber: 'HB 2', state: 'NJ', matchType: 'manual', priority: 'low', yearStart: cy, yearEnd: cy })
      await seedBill({ id: 's1', billNumber: 'HB 8', state: 'NJ', matchType: null, yearStart: cy, yearEnd: cy })
      await seedBill({ id: 's2', billNumber: 'HB 9', state: 'NJ', matchType: null, yearStart: cy, yearEnd: cy })
      const body = await list('pageSize=3')
      expect(body.pagination.total).toBe(5)
      const shown = body.bills.map(b => b.group ? 'group' : b.billNumber)
      expect(shown).toContain('group')
      expect(shown).not.toContain('HB 8')
      expect(shown).not.toContain('HB 9')
      const second = await list('pageSize=3&page=2')
      expect(second.bills.map(b => b.billNumber).sort()).toEqual(['HB 8', 'HB 9'])
    })

    it("fills a page from the rest of the list when the tracked groups don't reach as far as the tracked bills do", async () => {
      const cy = new Date().getUTCFullYear()
      // Four tracked bills but two tracked groups, a pair and one more, then two stubs.
      for (const id of ['a1', 'b1', 'c1']) await seedBill({ id, billNumber: id.toUpperCase(), state: 'NJ', matchType: 'keyword', relevanceScore: 8, yearStart: cy, yearEnd: cy })
      await group('a1', 'b1', 'c1')
      await seedBill({ id: 't1', billNumber: 'HB 1', state: 'NJ', matchType: 'keyword', relevanceScore: 6, yearStart: cy, yearEnd: cy })
      await seedBill({ id: 's1', billNumber: 'HB 8', state: 'NJ', matchType: null, yearStart: cy, yearEnd: cy })
      await seedBill({ id: 's2', billNumber: 'HB 9', state: 'NJ', matchType: null, yearStart: cy, yearEnd: cy })
      // Three of the four tracked bills would fill a page of three if each were its own group.
      const body = await list('pageSize=3')
      expect(body.pagination.total).toBe(4)
      expect(body.bills).toHaveLength(3)
      expect(body.bills.map(b => b.group ? 'group' : b.billNumber)).toEqual(['group', 'HB 1', expect.stringMatching(/^HB [89]$/)])
    })

    it('lists a group with a tracked bill once, however many of its bills are tracked', async () => {
      for (const id of ['a1', 'b1', 'c1']) await seedBill({ id, billNumber: id.toUpperCase(), state: 'NJ', matchType: 'keyword' })
      await group('a1', 'b1', 'c1')
      await seedBill({ id: 't1', billNumber: 'HB 1', state: 'NJ', matchType: 'keyword' })
      const body = await list('pageSize=2')
      expect(body.pagination.total).toBe(2)
      expect(body.bills).toHaveLength(2)
    })

    it('agrees with the full path on which groups lead the list', async () => {
      const cy = new Date().getUTCFullYear()
      const seed = async (id: string, num: string, over: Parameters<typeof seedBill>[0]) => { await seedBill({ id, billNumber: num, state: 'NJ', yearStart: cy, yearEnd: cy, ...over }) }
      await seed('a1', 'A1', { matchType: 'keyword', relevanceScore: 4, lastActionDate: '2026-01-01' })
      await seed('b1', 'S1', { matchType: null, relevanceScore: 8, lastActionDate: '2026-02-01' })
      await group('a1', 'b1')
      await seed('t1', 'HB 1', { matchType: 'keyword', relevanceScore: 6, lastActionDate: '2026-03-01' })
      await seed('t2', 'HB 2', { matchType: 'keyword', relevanceScore: 2, lastActionDate: '2026-04-01' })
      await seed('s1', 'HB 8', { matchType: null, relevanceScore: 9, lastActionDate: '2026-05-01' })
      // pageSize 4 stays within the four tracked groups, so the default sort takes the fast path.
      const fast = await list('pageSize=4')
      // A search that matches every bill takes the full path, with the same ordering.
      const full = await list('pageSize=4&q=%25')
      const ids = (b: ListBody) => b.bills.map(r => r.group ? r.group.map(g => g.id).sort().join('+') : r.id)
      expect(ids(fast)).toEqual(ids(full))
    })
  })

  describe('engagement on the row', () => {
    it("counts each member's latest vote once for the group, and reads the viewer's vote across it", async () => {
      await companions()
      await db().insert(memberVotes).values([
        { id: 'v1', userId: ada, billId: 'a190', position: 'support', updatedAt: '2026-10-01 09:00:00' },
        { id: 'v2', userId: ada, billId: 'b1713', position: 'oppose', updatedAt: '2026-10-01 10:00:00' },
        { id: 'v3', userId: ben, billId: 'a190', position: 'support', updatedAt: '2026-10-01 09:00:00' },
      ])
      const [row] = (await list()).bills
      expect(row.voteCounts).toEqual({ support: 1, oppose: 1, neutral: 0 })
      expect(row.myVote).toBe('oppose')
    })

    it("counts comments on any member, and shows the viewer's note and comments across the group", async () => {
      await companions()
      await db().insert(comments).values([
        { id: 'c1', billId: 'a190', userId: ben, content: 'x' },
        { id: 'c2', billId: 'b1713', userId: ada, content: 'y' },
      ])
      await db().insert(notes).values({ id: 'n1', billId: 'a190', userId: ada, content: '<p>mine</p>' })
      const [row] = (await list()).bills
      expect(row.commentCount).toBe(2)
      expect(row.hasNote).toBe(true)
      expect(row.hasComment).toBe(true)
    })

    it("lists a group as unvoted only while the viewer has voted on none of its bills", async () => {
      await companions()
      await seedBill({ id: 'solo', billNumber: 'HB 1', state: 'NJ' })
      expect((await list('unvoted=1')).pagination.total).toBe(2)
      await db().insert(memberVotes).values({ id: 'v1', userId: ada, billId: 'a190', position: 'support' })
      const body = await list('unvoted=1')
      expect(body.pagination.total).toBe(1)
      expect(body.bills.map(b => b.billNumber)).toEqual(['HB 1'])
    })

    it('lists a group as one of my bills when I engaged with either bill', async () => {
      await companions()
      await seedBill({ id: 'solo', billNumber: 'HB 1', state: 'NJ' })
      await db().insert(memberVotes).values({ id: 'v1', userId: ada, billId: 'a190', position: 'support' })
      const body = await list('myBills=1')
      expect(body.pagination.total).toBe(1)
      expect(body.bills[0].group).toHaveLength(2)
    })

    describe('my bills is group-wide, as unvoted is (#552)', () => {
      // A190 (Introduced) and S1713 (Passed) are the group {A, B}. A filter below is met by one of them alone.
      const vote = (billId: string, userId = ada) => db().insert(memberVotes).values({ id: crypto.randomUUID(), userId, billId, position: 'support' })
      const groupRow = (body: ListBody) => body.bills.map(b => b.group?.map(g => g.billNumber).sort().join('+') ?? b.billNumber)

      it('lists the group when only A is mine and a filter only B meets is set', async () => {
        await companions()
        await vote('a190')
        const body = await list('myBills=1&status=Passed')
        expect(body.pagination.total).toBe(1)
        expect(groupRow(body)).toEqual(['A190+S1713'])
      })

      it('lists the group when only B is mine and a filter only A meets is set', async () => {
        await companions()
        await vote('b1713')
        expect(groupRow(await list('myBills=1&status=Introduced'))).toEqual(['A190+S1713'])
      })

      it.each([
        ['a vote', (id: string) => vote(id)],
        ['a note', (id: string) => db().insert(notes).values({ id: 'n1', billId: id, userId: ada, content: '<p>mine</p>' })],
        ['a comment', (id: string) => db().insert(comments).values({ id: 'c1', billId: id, userId: ada, content: 'x' })],
      ])('counts %s on one bill as engagement with the group', async (_kind, engage) => {
        await companions()
        await engage('a190')
        expect((await list('myBills=1&status=Passed')).pagination.total).toBe(1)
      })

      it('leaves out a group when no bill in it is mine, whatever the other filters meet', async () => {
        await companions()
        await seedBill({ id: 'solo', billNumber: 'HB 1', state: 'NJ', status: 'Passed' })
        await vote('solo')
        // Another member's engagement with the group is not mine.
        await vote('a190', ben)
        expect(groupRow(await list('myBills=1'))).toEqual(['HB 1'])
        expect(groupRow(await list('myBills=1&status=Passed'))).toEqual(['HB 1'])
        expect(groupRow(await list('myBills=1&state=NJ'))).toEqual(['HB 1'])
      })

      it('does not count an empty note or a deleted comment as engagement', async () => {
        await companions()
        await db().insert(notes).values({ id: 'n1', billId: 'a190', userId: ada, content: '' })
        await db().insert(comments).values({ id: 'c1', billId: 'a190', userId: ada, content: 'x', deletedAt: '2026-10-01 00:00:00' })
        expect((await list('myBills=1')).pagination.total).toBe(0)
        expect((await list('myBills=1&status=Passed')).pagination.total).toBe(0)
      })

      it('leaves a bill in no group as it was: its own engagement, tested on it alone', async () => {
        await companions()
        await seedBill({ id: 'solo', billNumber: 'HB 1', state: 'NJ', status: 'Introduced' })
        await seedBill({ id: 'other', billNumber: 'HB 2', state: 'NJ', status: 'Passed' })
        await vote('solo')
        expect(groupRow(await list('myBills=1'))).toEqual(['HB 1'])
        expect(groupRow(await list('myBills=1&status=Introduced'))).toEqual(['HB 1'])
        expect(groupRow(await list('myBills=1&status=Passed'))).toEqual([])
      })

      it('lists the group under my bills combined with unvoted when I have a note but no vote on it', async () => {
        await companions()
        await db().insert(notes).values({ id: 'n1', billId: 'a190', userId: ada, content: '<p>mine</p>' })
        expect(groupRow(await list('myBills=1&unvoted=1&status=Passed'))).toEqual(['A190+S1713'])
        expect(groupRow(await list('myBills=1&unvoted=1'))).toEqual(['A190+S1713'])
      })

      it('leaves the group out of my bills combined with unvoted once I vote on any of its bills', async () => {
        await companions()
        await vote('a190')
        expect((await list('myBills=1&status=Passed')).pagination.total).toBe(1)
        expect((await list('unvoted=1&status=Passed')).pagination.total).toBe(0)
        expect((await list('myBills=1&unvoted=1&status=Passed')).pagination.total).toBe(0)
        expect((await list('myBills=1&unvoted=1')).pagination.total).toBe(0)
      })

      it('combines with a search, a team field filter, and the match-any operator', async () => {
        await companions()
        await seedBill({ id: 'solo', billNumber: 'HB 1', state: 'NJ', status: 'Introduced' })
        await vote('a190')
        await priority('b1713', 'high', '2026-10-01 10:00:00')
        expect(groupRow(await list('myBills=1&q=S1713'))).toEqual(['A190+S1713'])
        expect(groupRow(await list('myBills=1&q=HB'))).toEqual([])
        expect(groupRow(await list('myBills=1&priority=high'))).toEqual(['A190+S1713'])
        expect(groupRow(await list('myBills=1&priority=low'))).toEqual([])
        // The scope narrows whatever the operator joins: only the group is mine.
        expect(groupRow(await list('myBills=1&match=any&status=Passed&state=TX'))).toEqual(['A190+S1713'])
        expect(groupRow(await list('myBills=1&match=any&status=Introduced&state=NJ'))).toEqual(['A190+S1713'])
      })

      it('totals and pages the group once however many of its bills are mine', async () => {
        await companions()
        await vote('a190')
        await vote('b1713')
        const body = await list('myBills=1&pageSize=1')
        expect(body.pagination.total).toBe(1)
        expect(body.bills).toHaveLength(1)
      })

      it('returns each bill to per-bill behavior when the group splits', async () => {
        await companions()
        await vote('a190')
        expect((await list('myBills=1&status=Passed')).pagination.total).toBe(1)
        expect(await splitFromGroup(db(), 'a190', ada)).toBe(true)
        // S1713 is no longer in the group of the bill I voted on, so it leaves My bills.
        expect(groupRow(await list('myBills=1&status=Passed'))).toEqual([])
        expect(groupRow(await list('myBills=1'))).toEqual(['A190'])
        expect(groupRow(await list('myBills=1&status=Introduced'))).toEqual(['A190'])
      })
    })

    it('lists a group once among the new matches when either bill is one, and drops it once triaged', async () => {
      await seedBill({ id: 'a190', billNumber: 'A190', state: 'NJ', matchType: 'keyword', newMatchAt: '2026-10-01 10:00:00' })
      await seedBill({ id: 'b1713', billNumber: 'S1713', state: 'NJ', matchType: 'keyword', newMatchAt: '2026-10-01 10:00:00' })
      await group('a190', 'b1713')
      const open = await list('newMatches=1')
      expect(open.pagination.total).toBe(1)
      expect(open.bills[0].group).toHaveLength(2)
      await db().update(bills).set({ triagedAt: '2026-10-02 10:00:00' }).where(eq(bills.id, 'a190'))
      expect((await list('newMatches=1')).pagination.total).toBe(0)
    })
  })

  describe('a page of many groups', () => {
    it("reads every member of every group on the page within D1's 100-parameter limit", async () => {
      // 120 groups of three, so a page of 100 holds 300 bills.
      await env.DB.batch([
        env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 360)
          INSERT INTO bills (id, bill_number, title, state, status, status_rank, session, tags, match_type, group_key)
          SELECT 'bill' || printf('%04d', i), 'HB ' || i, 't', 'NJ', 'Introduced', 100 + (i % 3), 's', '[]', 'keyword', 'bill' || printf('%04d', ((i - 1) / 3) * 3 + 1) FROM n`),
        env.DB.prepare(`INSERT INTO comments (id, bill_id, user_id, content) SELECT 'c' || id, id, '${ben}', 'x' FROM bills`),
      ])
      const body = await list('pageSize=100')
      expect(body.pagination.total).toBe(120)
      expect(body.bills).toHaveLength(100)
      expect(body.bills.every(b => b.group?.length === 3)).toBe(true)
      expect(body.bills.every(b => b.commentCount === 3)).toBe(true)
      const second = await list('pageSize=100&page=2')
      expect(second.bills).toHaveLength(20)
    })

    it('stays within the parameter limit with the heaviest search the list accepts', async () => {
      await companions()
      const q = Array.from({ length: 12 }, (_, i) => `term${i}`).join(', ')
      const res = await SELF.fetch(`https://x/api/bills?q=${encodeURIComponent(q)}`, { headers: { Cookie: cookie } })
      expect(res.status).toBe(200)
    })
  })
})
