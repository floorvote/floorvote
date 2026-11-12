import { describe, it, expect, beforeAll } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { eq, inArray } from 'drizzle-orm'
import { clearDb, seedUser, seedSession, seedBill, seedBillText } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills } from '../../src/db/schema'
import { pickLead } from '../../src/lib/groupLead'

// The list sorted by bill number (#1021): groups are ordered by their lead bill's number within the group's state
// (the smallest state among its bills), in both directions, with the other sort keys breaking ties. The route
// reads only the first states' groups when it can (groupList.ts), so these tests pin the order against an
// independent reference computed from the stored rows, across page sizes that reach the cut and ones that don't.

type Row = { id: string; billNumber: string }
type ListBody = { bills: Row[]; pagination: { total: number; totalPages: number } }

describe('GET /bills?sort=bill', () => {
  let cookie: string
  const db = () => getDb(env.DB)

  async function list(qs: string): Promise<ListBody> {
    const res = await SELF.fetch(`https://x/api/bills?${qs}`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    return await res.json() as ListBody
  }
  async function pages(dir: 'asc' | 'desc', pageSize: number, extra = ''): Promise<string[]> {
    const first = await list(`sort=bill&dir=${dir}&pageSize=${pageSize}&page=1${extra}`)
    const ids = first.bills.map(b => b.id)
    for (let page = 2; page <= first.pagination.totalPages; page++) {
      ids.push(...(await list(`sort=bill&dir=${dir}&pageSize=${pageSize}&page=${page}${extra}`)).bills.map(b => b.id))
    }
    return ids
  }
  const group = async (...ids: string[]) => { await db().update(bills).set({ groupKey: [...ids].sort()[0] }).where(inArray(bills.id, ids)) }
  const idOf = async (billNumber: string) => (await db().select({ id: bills.id }).from(bills).where(eq(bills.billNumber, billNumber)).get())!.id

  // The text before the first digit, and the number from it, as the list's SQL splits a bill number.
  const natural = (n: string) => {
    const d = /\d/.exec(n)
    return d ? { prefix: n.slice(0, d.index), num: Number.parseInt(n.slice(d.index), 10) || 0 } : { prefix: n, num: 0 }
  }
  const cmp = <T>(a: T, b: T) => (a < b ? -1 : a > b ? 1 : 0)
  // nulls last, largest first
  const descNullsLast = <T>(a: T | null, b: T | null) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : cmp(b, a))

  /** The ids of the list's rows in order, from the stored bills alone. A group's row is its lead bill's. */
  async function reference(dir: 'asc' | 'desc'): Promise<string[]> {
    const all = await db().select().from(bills).all()
    const byGroup = new Map<string, typeof all>()
    for (const b of all) byGroup.set(b.groupKey ?? b.id, [...(byGroup.get(b.groupKey ?? b.id) ?? []), b])
    const year = new Date().getUTCFullYear()
    const rows = [...byGroup.entries()].map(([gk, members]) => {
      const lead = pickLead(members.map(m => ({ id: m.id, billNumber: m.billNumber, statusRank: m.statusRank, newestTextDate: null })))!
      const rels = members.map(m => m.relevanceScore).filter((r): r is number => r !== null)
      const lasts = members.map(m => m.lastActionDate).filter((r): r is string => r !== null)
      return {
        gk, id: lead.id, state: members.map(m => m.state).sort()[0], ...natural(lead.billNumber),
        year: Math.max(...members.map(m => Math.min(m.yearEnd ?? 0, year))),
        rel: rels.length ? Math.max(...rels) : null,
        last: lasts.length ? lasts.sort().at(-1)! : null,
      }
    })
    const sign = dir === 'asc' ? 1 : -1
    rows.sort((a, b) => sign * cmp(a.state, b.state) || sign * cmp(a.prefix, b.prefix) || sign * (a.num - b.num)
      || (b.year - a.year) || descNullsLast(a.rel, b.rel) || descNullsLast(a.last, b.last) || cmp(a.gk, b.gk))
    return rows.map(r => r.id)
  }

  beforeAll(async () => {
    await clearDb()
    const userId = await seedUser({ role: 'admin' })
    cookie = `session=${await seedSession(userId)}`
  })

  describe('a fixture with many ties, groups across states, and groups whose lead is not the key bill', () => {
    beforeAll(async () => {
      await clearDb()
      const userId = await seedUser({ role: 'admin' })
      cookie = `session=${await seedSession(userId)}`
      // A small deterministic generator, so the fixture is the same on every run.
      let seed = 20260101
      const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 65536) % n }
      const states = ['CA', 'NJ', 'TX', 'AZ']
      const prefixes = ['HB ', 'SB ', 'AB ', 'HR']
      const made: string[] = []
      for (let i = 0; i < 80; i++) {
        const id = `b${String(i).padStart(3, '0')}`
        made.push(id)
        await seedBill({
          id, billNumber: `${prefixes[rand(4)]}${1 + rand(12)}`, state: states[rand(4)],
          statusRank: [100, 100, 200, 300][rand(4)], yearEnd: [2024, 2025, 2026, 2027][rand(4)],
          ...(rand(3) > 0 ? { relevanceScore: 1 + rand(5) } : {}),
          lastActionDate: `2026-0${1 + rand(9)}-1${rand(9)}`, matchType: null,
        })
      }
      // Twelve groups of two or three, spanning states and status ranks, so a group's state, lead, and key bill differ.
      for (let g = 0; g < 12; g++) {
        const members = new Set<string>()
        while (members.size < 2 + (g % 2)) members.add(made[rand(made.length)])
        if ((await db().select({ g: bills.groupKey }).from(bills).where(inArray(bills.id, [...members])).all()).some(r => r.g !== null)) continue
        await group(...members)
      }
    })

    for (const dir of ['asc', 'desc'] as const) {
      for (const pageSize of [3, 7, 20, 200]) {
        it(`orders every page as the reference does, ${dir}, in pages of ${pageSize}`, async () => {
          expect(await pages(dir, pageSize)).toEqual(await reference(dir))
        })
      }
    }

    it('orders the same under a filter that keeps every bill', async () => {
      // Every seeded bill has the default status, so a filter on it keeps them all and the order is the reference's.
      const [{ status }] = await db().select({ status: bills.status }).from(bills).limit(1).all()
      for (const dir of ['asc', 'desc'] as const) {
        expect(await pages(dir, 7, `&status=${encodeURIComponent(status)}`)).toEqual(await reference(dir))
      }
    })
  })

  describe('hand-built cases', () => {
    const numbers = (body: ListBody) => body.bills.map(b => b.billNumber)

    it('files a group under the smallest state among its bills, at its lead bill\'s number', async () => {
      await clearDb()
      const userId = await seedUser({ role: 'admin' })
      cookie = `session=${await seedSession(userId)}`
      // The group holds an NJ bill and a CA bill. It sits with CA, and its lead (the furthest along) is the NJ bill SB 5.
      await seedBill({ id: 'g1', billNumber: 'HB 9', state: 'CA', statusRank: 100, matchType: null })
      await seedBill({ id: 'g2', billNumber: 'SB 5', state: 'NJ', statusRank: 300, matchType: null })
      await group('g1', 'g2')
      await seedBill({ id: 'a1', billNumber: 'SB 1', state: 'CA', matchType: null })
      await seedBill({ id: 'a2', billNumber: 'SB 7', state: 'CA', matchType: null })
      await seedBill({ id: 'n1', billNumber: 'AB 1', state: 'NJ', matchType: null })
      expect((await list('sort=bill&dir=asc&pageSize=2')).bills.map(b => b.id)).toEqual(['a1', 'g2'])
      expect((await list('sort=bill&dir=asc&pageSize=2&page=2')).bills.map(b => b.id)).toEqual(['a2', 'n1'])
      // Descending runs the states Z to A and the numbers high to low: NJ's AB 1, then CA's SB 7, the group at SB 5, and SB 1.
      expect(numbers(await list('sort=bill&dir=desc'))).toEqual(['AB 1', 'SB 7', 'SB 5', 'SB 1'])
    })

    it('keeps a group whose key bill is in a later state than its first, when the page is cut at the first state', async () => {
      await clearDb()
      const userId = await seedUser({ role: 'admin' })
      cookie = `session=${await seedSession(userId)}`
      // Three bills with no companions in AZ make the first page of three end in AZ. The group's key bill (the smaller
      // id) is in TX, but its AZ bill puts it in AZ, where its lead (the furthest along, HB 2) sorts it between them.
      await seedBill({ id: 'a1', billNumber: 'HB 1', state: 'AZ', matchType: null })
      await seedBill({ id: 'a3', billNumber: 'HB 3', state: 'AZ', matchType: null })
      await seedBill({ id: 'a5', billNumber: 'HB 5', state: 'AZ', matchType: null })
      await seedBill({ id: 'c1', billNumber: 'HB 8', state: 'TX', statusRank: 100, matchType: null })
      await seedBill({ id: 'c2', billNumber: 'HB 2', state: 'AZ', statusRank: 300, matchType: null })
      await group('c1', 'c2')
      expect((await list('sort=bill&dir=asc&pageSize=3')).bills.map(b => b.id)).toEqual(['a1', 'c2', 'a3'])
      expect((await list('sort=bill&dir=asc&pageSize=3&page=2')).bills.map(b => b.id)).toEqual(['a5'])
    })

    it('cuts a descending page at the last state, keeping its groups and leaving out one that reaches an earlier state', async () => {
      await clearDb()
      const userId = await seedUser({ role: 'admin' })
      cookie = `session=${await seedSession(userId)}`
      await seedBill({ id: 'w1', billNumber: 'HB 1', state: 'WY', matchType: null })
      await seedBill({ id: 'w2', billNumber: 'HB 2', state: 'WY', matchType: null })
      await seedBill({ id: 'w3', billNumber: 'HB 4', state: 'WY', matchType: null })
      // A group wholly in WY, led by HB 3.
      await seedBill({ id: 'p1', billNumber: 'HB 3', state: 'WY', statusRank: 300, matchType: null })
      await seedBill({ id: 'p2', billNumber: 'HB 9', state: 'WY', statusRank: 100, matchType: null })
      await group('p1', 'p2')
      // A group with an AZ bill is in AZ, which comes after WY here, whatever the number of its lead.
      await seedBill({ id: 'q1', billNumber: 'HB 1', state: 'AZ', statusRank: 100, matchType: null })
      await seedBill({ id: 'q2', billNumber: 'HB 99', state: 'WY', statusRank: 300, matchType: null })
      await group('q1', 'q2')
      expect((await list('sort=bill&dir=desc&pageSize=3')).bills.map(b => b.id)).toEqual(['w3', 'p1', 'w2'])
      expect((await list('sort=bill&dir=desc&pageSize=3&page=2')).bills.map(b => b.id)).toEqual(['w1', 'q2'])
    })

    it('lists a key bill whose own group key is empty once, though others name it', async () => {
      await clearDb()
      const userId = await seedUser({ role: 'admin' })
      cookie = `session=${await seedSession(userId)}`
      // A broken group written directly: k2 names k1 as its key, but k1 has none. k1 is its own row.
      await seedBill({ id: 'k1', billNumber: 'HB 1', state: 'AZ', matchType: null })
      await seedBill({ id: 'k2', billNumber: 'HB 2', state: 'AZ', matchType: null })
      await db().update(bills).set({ groupKey: 'k1' }).where(eq(bills.id, 'k2'))
      await seedBill({ id: 'k3', billNumber: 'HB 3', state: 'AZ', matchType: null })
      await seedBill({ id: 'k4', billNumber: 'HB 4', state: 'AZ', matchType: null })
      const ids = [...(await list('sort=bill&dir=asc&pageSize=2')).bills, ...(await list('sort=bill&dir=asc&pageSize=2&page=2')).bills].map(b => b.id)
      expect(ids.filter(id => id === 'k1')).toHaveLength(1)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it("orders a group at its lead's newest-text number, not its key bill's", async () => {
      await clearDb()
      const userId = await seedUser({ role: 'admin' })
      cookie = `session=${await seedSession(userId)}`
      await seedBill({ id: 'k1', billNumber: 'HB 50', state: 'TX', statusRank: 100, matchType: null })
      await seedBill({ id: 'k2', billNumber: 'HB 10', state: 'TX', statusRank: 100, matchType: null })
      await seedBillText('k1', { docId: '1', date: '2026-08-01' })
      await seedBillText('k2', { docId: '2', date: '2026-01-01' })
      await group('k1', 'k2')
      await seedBill({ id: 'o1', billNumber: 'HB 20', state: 'TX', matchType: null })
      await seedBill({ id: 'o2', billNumber: 'HB 60', state: 'TX', matchType: null })
      // The newer text is on HB 50, so it leads the group and the group sorts at 50.
      expect((await list('sort=bill&dir=asc')).bills.map(b => b.id)).toEqual(['o1', 'k1', 'o2'])
      expect((await list('sort=bill&dir=desc')).bills.map(b => b.id)).toEqual(['o2', 'k1', 'o1'])
    })

    it('breaks a tie on state and number by the other sort keys, the same in both directions', async () => {
      await clearDb()
      const userId = await seedUser({ role: 'admin' })
      cookie = `session=${await seedSession(userId)}`
      await seedBill({ id: 't1', billNumber: 'HB 1', state: 'TX', yearEnd: 2024, relevanceScore: 9, matchType: null })
      await seedBill({ id: 't2', billNumber: 'HB 1', state: 'TX', yearEnd: 2026, relevanceScore: 1, matchType: null })
      await seedBill({ id: 't3', billNumber: 'HB 1', state: 'TX', yearEnd: 2026, relevanceScore: 5, matchType: null })
      // Newest session first, then the more relevant: the same order whichever way the numbers run.
      expect((await list('sort=bill&dir=asc')).bills.map(b => b.id)).toEqual(['t3', 't2', 't1'])
      expect((await list('sort=bill&dir=desc')).bills.map(b => b.id)).toEqual(['t3', 't2', 't1'])
    })
  })
})
