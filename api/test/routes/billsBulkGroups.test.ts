import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { eq, inArray } from 'drizzle-orm'
import { clearDb, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills, memberVotes, notes, officialPositions } from '../../src/db/schema'
import { centralFetch } from '../../src/lib/centralFetch'

// "Select all matching" and bulk edits treat a companion group as one item
// (#379): the selection counts groups, the 1,000 cap counts groups, and a bulk
// edit of a group's bill is the group's edit.

vi.mock('../../src/lib/centralFetch', () => ({ centralFetch: vi.fn() }))

type Row = { id: string; billNumber: string; priority: string | null; position: string | null; group?: Array<{ id: string }> }

describe('bulk actions on companion groups', () => {
  let cookie: string
  let ada: string
  const db = () => getDb(env.DB)

  async function api(path: string, init: RequestInit = {}) {
    return SELF.fetch(`https://x/api${path}`, { ...init, headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(init.headers ?? {}) } })
  }
  async function bulk(body: object) {
    const res = await api('/bills/bulk', { method: 'POST', body: JSON.stringify(body) })
    return { status: res.status, body: await res.json() as { updated?: number; error?: string } }
  }
  async function list(qs = '') {
    return await (await api(`/bills?${qs}`)).json() as { bills: Row[]; pagination: { total: number } }
  }
  async function group(...ids: string[]) {
    await db().update(bills).set({ groupKey: [...ids].sort()[0] }).where(inArray(bills.id, ids))
  }
  // n pairs of identical companions, in one statement.
  async function pairs(n: number) {
    await env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${n * 2})
      INSERT INTO bills (id, bill_number, title, state, status, status_rank, session, tags, match_type, group_key)
      SELECT 'bill' || printf('%05d', i), 'HB ' || i, 't', 'NJ', 'Introduced', 100, 's', '[]', 'keyword', 'bill' || printf('%05d', ((i - 1) / 2) * 2 + 1) FROM n`).run()
  }

  beforeEach(async () => {
    await clearDb()
    vi.mocked(centralFetch).mockReset()
    vi.mocked(centralFetch).mockRejectedValue(new Error('central unreachable'))
    ada = await seedUser({ name: 'ada', email: 'ada@example.com', role: 'admin' })
    cookie = `session=${await seedSession(ada)}`
  })

  it('applies a filter-wide edit once per group, and the whole group reads it', async () => {
    await seedBill({ id: 'a190', billNumber: 'A190', state: 'NJ' })
    await seedBill({ id: 'b1713', billNumber: 'S1713', state: 'NJ' })
    await group('a190', 'b1713')
    await seedBill({ id: 'solo', billNumber: 'HB 1', state: 'NJ' })
    const res = await bulk({ filter: 'state=NJ', priority: 'high' })
    expect(res.status).toBe(200)
    expect(res.body.updated).toBe(2)
    const rows = (await list()).bills
    expect(rows.map(r => r.priority)).toEqual(['high', 'high'])
  })

  it('applies an edit by id to the group of the bill selected', async () => {
    await seedBill({ id: 'a190', billNumber: 'A190', state: 'NJ' })
    await seedBill({ id: 'b1713', billNumber: 'S1713', state: 'NJ' })
    await group('a190', 'b1713')
    const res = await bulk({ ids: ['b1713'], position: 'Support' })
    expect(res.status).toBe(200)
    const [row] = (await list()).bills
    expect(row.position).toBe('Support')
    expect(row.group).toHaveLength(2)
  })

  it('counts groups against the 1,000 cap, so 600 pairs are one selection', async () => {
    await pairs(600)
    const res = await bulk({ filter: 'state=NJ', priority: 'low' })
    expect(res.status).toBe(200)
    expect(res.body.updated).toBe(600)
  })

  it('refuses a selection of more than 1,000 groups, naming how many', async () => {
    await pairs(1001)
    const res = await bulk({ filter: 'state=NJ', priority: 'low' })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('Too many bills (1001)')
  })

  it("selects a group through any bill that matches the filter", async () => {
    await seedBill({ id: 'a190', billNumber: 'A190', state: 'NJ', status: 'Introduced' })
    await seedBill({ id: 'b1713', billNumber: 'S1713', state: 'NJ', status: 'Passed' })
    await group('a190', 'b1713')
    const res = await bulk({ filter: 'status=Passed', priority: 'medium' })
    expect(res.body.updated).toBe(1)
    const rows = (await list()).bills
    expect(rows).toHaveLength(1)
    expect(rows[0].priority).toBe('medium')
  })

  it("selects with the group's current values, not a bill's replaced one", async () => {
    await seedBill({ id: 'a190', billNumber: 'A190', state: 'NJ' })
    await seedBill({ id: 'b1713', billNumber: 'S1713', state: 'NJ' })
    await group('a190', 'b1713')
    await db().update(bills).set({ priority: 'low', prioritySetAt: '2026-10-01 09:00:00' }).where(eq(bills.id, 'a190'))
    await db().update(bills).set({ priority: 'high', prioritySetAt: '2026-10-01 10:00:00' }).where(eq(bills.id, 'b1713'))
    const res = await bulk({ filter: 'priority=low', position: 'Support' })
    expect(res.status).toBe(200)
    expect(res.body.updated).toBe(0)
    expect((await db().select().from(officialPositions).all())).toHaveLength(0)
  })

  describe('under my bills, which is group-wide (#552)', () => {
    // A190 (Introduced) and S1713 (Passed) are a group; HB 1 and HB 2 are in none.
    async function seed() {
      await seedBill({ id: 'a190', billNumber: 'A190', state: 'NJ', status: 'Introduced' })
      await seedBill({ id: 'b1713', billNumber: 'S1713', state: 'NJ', status: 'Passed' })
      await seedBill({ id: 'solo', billNumber: 'HB 1', state: 'TX', status: 'Passed' })
      await seedBill({ id: 'other', billNumber: 'HB 2', state: 'TX', status: 'Passed' })
      await group('a190', 'b1713')
    }
    const vote = (billId: string) => db().insert(memberVotes).values({ id: crypto.randomUUID(), billId, userId: ada, position: 'support' })
    const priorities = async (qs = '') => Object.fromEntries((await list(qs)).bills.map(r => [r.billNumber, r.priority]))
    async function values(qs: string) {
      const res = await api(`/bills/bulk-values?${qs}`)
      return await res.json() as { count: number }
    }

    it('selects the same groups the list shows, a group through the bill that is not mine', async () => {
      await seed()
      await vote('a190')
      const shown = await list('myBills=1&status=Passed')
      expect(shown.pagination.total).toBe(1)
      const res = await bulk({ filter: 'myBills=1&status=Passed', priority: 'high' })
      expect(res.status).toBe(200)
      expect(res.body.updated).toBe(1)
      const rows = (await list()).bills
      expect(rows.filter(r => r.priority === 'high').map(r => r.group?.length ?? 1)).toEqual([2])
      expect(rows.filter(r => r.priority === null).map(r => r.billNumber).sort()).toEqual(['HB 1', 'HB 2'])
    })

    it('leaves out a group with none of my bills and counts a bill in no group on its own', async () => {
      await seed()
      await vote('solo')
      const res = await bulk({ filter: 'myBills=1&status=Passed', priority: 'low' })
      expect(res.body.updated).toBe(1)
      expect(await priorities('myBills=1')).toEqual({ 'HB 1': 'low' })
      expect((await list()).bills.filter(r => r.priority === null)).toHaveLength(2)
    })

    it('selects as many groups as the list totals, with my bills and unvoted together', async () => {
      await seed()
      await db().insert(notes).values({ id: 'n1', billId: 'a190', userId: ada, content: '<p>mine</p>' })
      await vote('solo')
      // The group is mine (a note) and unvoted; HB 1 is mine and voted.
      for (const [qs, groups] of [
        ['myBills=1&unvoted=1&status=Passed', 1],
        ['myBills=1&unvoted=1', 1],
        ['myBills=1', 2],
      ] as const) {
        expect([qs, 'list', (await list(qs)).pagination.total]).toEqual([qs, 'list', groups])
        expect([qs, 'form', (await values(qs)).count]).toEqual([qs, 'form', groups])
        // The edit is applied once to each of the groups the list shows, and writes nothing else.
        expect([qs, 'edit', (await bulk({ filter: qs, priority: 'medium' })).body.updated]).toEqual([qs, 'edit', groups])
      }
    })

    it('selects the bills of a split group one by one', async () => {
      await seed()
      await vote('a190')
      await db().update(bills).set({ groupKey: null }).where(inArray(bills.id, ['a190', 'b1713']))
      const res = await bulk({ filter: 'myBills=1&status=Passed', priority: 'high' })
      expect(res.body.updated).toBe(0)
      expect((await bulk({ filter: 'myBills=1', priority: 'high' })).body.updated).toBe(1)
      expect(await priorities()).toEqual({ A190: 'high', 'S1713': null, 'HB 1': null, 'HB 2': null })
    })
  })

  describe('bulk values for the form', () => {
    async function values(qs: string) {
      const res = await api(`/bills/bulk-values?${qs}`)
      return await res.json() as { count: number; priorities: Record<string, number>; positions: Record<string, number> }
    }

    it("counts a group once, with the group's priority and position", async () => {
      await seedBill({ id: 'a190', billNumber: 'A190', state: 'NJ' })
      await seedBill({ id: 'b1713', billNumber: 'S1713', state: 'NJ' })
      await group('a190', 'b1713')
      await db().update(bills).set({ priority: 'high', prioritySetAt: '2026-10-01 10:00:00' }).where(eq(bills.id, 'b1713'))
      await db().insert(officialPositions).values({ id: 'p1', billId: 'b1713', position: 'Oppose', setBy: ada, updatedAt: '2026-10-01 10:00:00' })
      const v = await values('state=NJ')
      expect(v.count).toBe(1)
      expect(v.priorities).toEqual({ high: 1 })
      expect(v.positions).toEqual({ Oppose: 1 })
    })
  })

  describe('dismissing new matches', () => {
    async function dismissFilter(filter: string) {
      const res = await api('/bills/bulk-dismiss', { method: 'POST', body: JSON.stringify({ filter }) })
      return await res.json() as { dismissed: number }
    }

    it('dismisses a group as one, and both bills leave the new matches', async () => {
      await seedBill({ id: 'a190', billNumber: 'A190', state: 'NJ', newMatchAt: '2026-10-01 10:00:00' })
      await seedBill({ id: 'b1713', billNumber: 'S1713', state: 'NJ', newMatchAt: '2026-10-01 10:00:00' })
      await group('a190', 'b1713')
      expect((await list('newMatches=1')).pagination.total).toBe(1)
      expect((await dismissFilter('newMatches=1')).dismissed).toBe(1)
      expect((await list('newMatches=1')).pagination.total).toBe(0)
    })

    it("dismisses the groups the list shows under my bills, a group reached through the bill that isn't mine", async () => {
      const match = { matchType: 'keyword', newMatchAt: '2026-10-01 10:00:00' } as const
      // {A, B}: I voted on A, and only B is a new match that meets the status filter.
      await seedBill({ id: 'a190', billNumber: 'A190', state: 'NJ', status: 'Introduced' })
      await seedBill({ id: 'b1713', billNumber: 'S1713', state: 'NJ', status: 'Passed', ...match })
      await group('a190', 'b1713')
      // A group with none of my bills, a new match too.
      await seedBill({ id: 'c1', billNumber: 'HB 3', state: 'NJ', status: 'Passed', ...match })
      await seedBill({ id: 'd1', billNumber: 'HB 4', state: 'NJ', status: 'Passed', ...match })
      await group('c1', 'd1')
      // A bill in no group, a new match I noted.
      await seedBill({ id: 'solo', billNumber: 'HB 1', state: 'NJ', status: 'Passed', ...match })
      await db().insert(memberVotes).values({ id: 'v1', userId: ada, billId: 'a190', position: 'support' })
      await db().insert(notes).values({ id: 'n1', billId: 'solo', userId: ada, content: '<p>mine</p>' })
      const qs = 'myBills=1&newMatches=1&status=Passed'
      expect((await list(qs)).pagination.total).toBe(2)
      expect((await dismissFilter(qs)).dismissed).toBe(2)
      expect((await list(qs)).pagination.total).toBe(0)
      // Only the group with none of my bills is still a new match.
      const left = (await list('newMatches=1')).bills
      expect(left.map(r => r.group?.map(g => g.id).sort().join('+'))).toEqual(['c1+d1'])
    })

    it('dismisses through a broad filter without sending the matching groups in one parameter', async () => {
      // 600 new-match pairs under one broad filter: a list of their keys would be about 25 KB, and on the
      // default list of a large instance several MB, over D1's 2 MB limit for one string.
      await env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200)
        INSERT INTO bills (id, bill_number, title, state, status, status_rank, session, tags, match_type, new_match_at, group_key)
        SELECT 'bill' || printf('%05d', i), 'HB ' || i, 't', 'NJ', 'Introduced', 100, 's', '[]', 'keyword', '2026-10-01 10:00:00',
          'bill' || printf('%05d', ((i - 1) / 2) * 2 + 1) FROM n`).run()
      const sizes: number[] = []
      const realPrepare = env.DB.prepare.bind(env.DB)
      const spy = vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) => {
        const stmt = realPrepare(sql)
        const realBind = stmt.bind.bind(stmt)
        stmt.bind = ((...args: unknown[]) => { sizes.push(...args.map(a => (typeof a === 'string' ? a.length : 0))); return realBind(...args) }) as typeof stmt.bind
        return stmt
      })
      const res = await dismissFilter('state=NJ')
      spy.mockRestore()
      expect(res.dismissed).toBe(600)
      expect((await list('newMatches=1')).pagination.total).toBe(0)
      expect(Math.max(...sizes)).toBeLessThan(2000)
    })

    it("dismisses a group that meets the filter through one bill and is a new match through another", async () => {
      await seedBill({ id: 'a190', billNumber: 'A190', state: 'NJ', status: 'Introduced', matchType: null })
      await seedBill({ id: 'b1713', billNumber: 'S1713', state: 'NJ', status: 'Passed', matchType: 'keyword', newMatchAt: '2026-10-01 10:00:00' })
      await group('a190', 'b1713')
      expect((await dismissFilter('status=Introduced')).dismissed).toBe(1)
      expect((await list('newMatches=1')).pagination.total).toBe(0)
    })
  })
})
