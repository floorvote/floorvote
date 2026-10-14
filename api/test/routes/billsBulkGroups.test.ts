import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { eq, inArray } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills, officialPositions } from '../../src/db/schema'
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
    await resetDb()
    await applyMigrations()
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
    const res = await bulk({ filter: { state: ['NJ'] }, priority: 'high' })
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
    const res = await bulk({ filter: { state: ['NJ'] }, priority: 'low' })
    expect(res.status).toBe(200)
    expect(res.body.updated).toBe(600)
  })

  it('refuses a selection of more than 1,000 groups, naming how many', async () => {
    await pairs(1001)
    const res = await bulk({ filter: { state: ['NJ'] }, priority: 'low' })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('Too many bills (1001)')
  })

  it("selects a group through any bill that matches the filter", async () => {
    await seedBill({ id: 'a190', billNumber: 'A190', state: 'NJ', status: 'Introduced' })
    await seedBill({ id: 'b1713', billNumber: 'S1713', state: 'NJ', status: 'Passed' })
    await group('a190', 'b1713')
    const res = await bulk({ filter: { status: ['Passed'] }, priority: 'medium' })
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
    const res = await bulk({ filter: { priority: ['low'] }, position: 'Support' })
    expect(res.status).toBe(200)
    expect(res.body.updated).toBe(0)
    expect((await db().select().from(officialPositions).all())).toHaveLength(0)
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
    async function dismissFilter(filter: object) {
      const res = await api('/bills/bulk-dismiss', { method: 'POST', body: JSON.stringify({ filter }) })
      return await res.json() as { dismissed: number }
    }

    it('dismisses a group as one, and both bills leave the new matches', async () => {
      await seedBill({ id: 'a190', billNumber: 'A190', state: 'NJ', newMatchAt: '2026-10-01 10:00:00' })
      await seedBill({ id: 'b1713', billNumber: 'S1713', state: 'NJ', newMatchAt: '2026-10-01 10:00:00' })
      await group('a190', 'b1713')
      expect((await list('newMatches=1')).pagination.total).toBe(1)
      expect((await dismissFilter({ newMatches: '1' })).dismissed).toBe(1)
      expect((await list('newMatches=1')).pagination.total).toBe(0)
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
      const res = await dismissFilter({ state: ['NJ'] })
      spy.mockRestore()
      expect(res.dismissed).toBe(600)
      expect((await list('newMatches=1')).pagination.total).toBe(0)
      expect(Math.max(...sizes)).toBeLessThan(2000)
    })

    it("dismisses a group that meets the filter through one bill and is a new match through another", async () => {
      await seedBill({ id: 'a190', billNumber: 'A190', state: 'NJ', status: 'Introduced', matchType: null })
      await seedBill({ id: 'b1713', billNumber: 'S1713', state: 'NJ', status: 'Passed', matchType: 'keyword', newMatchAt: '2026-10-01 10:00:00' })
      await group('a190', 'b1713')
      expect((await dismissFilter({ status: ['Introduced'] })).dismissed).toBe(1)
      expect((await list('newMatches=1')).pagination.total).toBe(0)
    })
  })
})
