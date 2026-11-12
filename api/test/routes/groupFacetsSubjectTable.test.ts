import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { seedBill, appFetch, seedSession } from '../helpers'
import { eq } from 'drizzle-orm'
import { billSubjects, bills } from '../../src/db/schema'
import { db, facets, group, reset, total, ada } from './groupFacetsHarness'

// The subject facet counts a group once however many of its bills hold the subject: the bills holding it, less the
// grouped bills holding it, plus their groups (#1030). That correction is read from the subjects the groups share
// (group_subjects, migration 0126), not from every grouped bill's subject rows. The correction depends on which bills of
// a group meet the filter, not only on which groups do, so a group with a bill the filter leaves out is counted from
// the rows of the bills it keeps.

const subjects = (rows: Array<[string, string, string]>) =>
  db().insert(billSubjects).values(rows.map(([billId, state, subjectName]) => ({ billId, state, subjectName })))

/** Every statement the request prepares, by its SQL. */
async function statementsOf(qs: string): Promise<string[]> {
  const cookie = `session=${await seedSession(ada)}`
  const seen: string[] = []
  const realPrepare = env.DB.prepare.bind(env.DB)
  const spy = vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) => { seen.push(sql); return realPrepare(sql) })
  const res = await appFetch(`https://x/api/bills/facets?${qs}`, { headers: { Cookie: cookie } })
  spy.mockRestore()
  expect(res.status).toBe(200)
  return seen
}

// The correction as the facet read it before: a statement over every grouped bill's subject rows, grouped by group.
const GROUPED_ROWS = /bill_subjects[\s\S]*GROUP BY[^)]*"m"\."group_key"/

describe('the subject facet: the groups that share a subject (#1030)', () => {
  beforeEach(reset)

  describe('counts', () => {
    beforeEach(async () => {
      // g1: both bills hold S, and the two bills differ in stage. g2: both Passed, both hold S and T. g3: one bill holds S.
      // Two bills in no group hold S and U. One group of three: two hold S, one holds U.
      await seedBill({ id: 'a1', billNumber: 'A1', state: 'NJ', status: 'Introduced', statusStage: 'introduced', statusRank: 100 })
      await seedBill({ id: 'a2', billNumber: 'A2', state: 'NJ', status: 'Passed', statusStage: 'passed', statusRank: 300 })
      await seedBill({ id: 'b1', billNumber: 'B1', state: 'NJ', status: 'Passed', statusStage: 'passed', statusRank: 300 })
      await seedBill({ id: 'b2', billNumber: 'B2', state: 'NJ', status: 'Passed', statusStage: 'passed', statusRank: 300 })
      await seedBill({ id: 'c1', billNumber: 'C1', state: 'NJ', status: 'Introduced', statusStage: 'introduced', statusRank: 100 })
      await seedBill({ id: 'c2', billNumber: 'C2', state: 'NJ', status: 'Passed', statusStage: 'passed', statusRank: 300 })
      await seedBill({ id: 'x1', billNumber: 'X1', state: 'NJ', status: 'Passed', statusStage: 'passed', statusRank: 300 })
      await seedBill({ id: 'x2', billNumber: 'X2', state: 'NJ', status: 'Introduced', statusStage: 'introduced', statusRank: 100 })
      await seedBill({ id: 'd1', billNumber: 'D1', state: 'NJ', status: 'Introduced', statusStage: 'introduced', statusRank: 100 })
      await seedBill({ id: 'd2', billNumber: 'D2', state: 'NJ', status: 'Passed', statusStage: 'passed', statusRank: 300 })
      await seedBill({ id: 'd3', billNumber: 'D3', state: 'NJ', status: 'Passed', statusStage: 'passed', statusRank: 300 })
      await group('a1', 'a2')
      await group('b1', 'b2')
      await group('c1', 'c2')
      await group('d1', 'd2', 'd3')
      await subjects([
        ['a1', 'NJ', 'S'], ['a2', 'NJ', 'S'],
        ['b1', 'NJ', 'S'], ['b2', 'NJ', 'S'], ['b1', 'NJ', 'T'], ['b2', 'NJ', 'T'],
        ['c1', 'NJ', 'S'],
        ['x1', 'NJ', 'S'], ['x1', 'NJ', 'U'], ['x2', 'NJ', 'S'],
        ['d1', 'NJ', 'S'], ['d2', 'NJ', 'S'], ['d3', 'NJ', 'U'],
      ])
    })

    it('counts each group once under a subject two of its bills hold', async () => {
      // S: groups a, b, c, d, and the two ungrouped bills. T: group b. U: x1, and group d.
      expect((await facets()).subject).toEqual({ 'NJ:S': 6, 'NJ:T': 1, 'NJ:U': 2 })
    })

    it('counts a group from the bills its filter keeps when it keeps one of two bills that hold a subject', async () => {
      // Under Passed, a keeps a2, d keeps d2 and d3, c keeps c2 (which holds nothing), and b keeps both. a1 and c1 drop out.
      expect((await facets('status=Passed')).subject).toEqual({ 'NJ:S': 4, 'NJ:T': 1, 'NJ:U': 2 })
      // Under Introduced, only a1, c1, x2, and d1 are kept: nothing is shared by two bills kept.
      expect((await facets('status=Introduced')).subject).toEqual({ 'NJ:S': 4 })
    })

    it('counts what the list totals when a subject is picked, under a filter that splits groups', async () => {
      for (const qs of ['', 'status=Passed', 'status=Introduced', 'stage=passed', 'status=Passed&stage=introduced&match=any']) {
        const counted = (await facets(qs)).subject
        for (const [value, n] of Object.entries(counted)) {
          expect(await total(`${qs}${qs ? '&' : ''}subject=${encodeURIComponent(value)}`), `${qs} ${value}`).toBe(n)
        }
      }
    })

    it('counts the same under the filters that keep a group whole', async () => {
      await db().update(bills).set({ priority: 'high', prioritySetAt: '2026-01-01 00:00:00' }).where(eq(bills.id, 'b1'))
      for (const qs of ['priority=high', 'priority=none']) {
        const counted = (await facets(qs)).subject
        for (const [value, n] of Object.entries(counted)) {
          expect(await total(`${qs}&subject=${encodeURIComponent(value)}`), `${qs} ${value}`).toBe(n)
        }
      }
    })
  })

  describe('statements', () => {
    it('reads no grouped correction when no two bills of a group hold a subject', async () => {
      await seedBill({ id: 'a1', billNumber: 'A1', state: 'NJ', status: 'Introduced', statusStage: 'introduced' })
      await seedBill({ id: 'a2', billNumber: 'A2', state: 'NJ', status: 'Passed', statusStage: 'passed' })
      await seedBill({ id: 'z1', billNumber: 'Z1', state: 'NJ' })
      await group('a1', 'a2')
      await subjects([['a1', 'NJ', 'S'], ['a2', 'NJ', 'T'], ['z1', 'NJ', 'S']])
      for (const qs of ['only=subject', 'priority=none&only=subject', 'status=Passed&only=subject', 'status=Passed&match=any&state=NJ&only=subject']) {
        const seen = await statementsOf(qs)
        expect(seen.filter(s => GROUPED_ROWS.test(s)), qs).toEqual([])
        expect(seen.filter(s => /group_subjects/.test(s) && /bill_subjects/.test(s)), qs).toEqual([])
      }
      // And the counts are the whole counts: S in a group and the lone bill, T in a group.
      expect((await facets()).subject).toEqual({ 'NJ:S': 2, 'NJ:T': 1 })
    })

    it('reads the correction from the shared subjects, and never from every grouped bill, once a group shares one', async () => {
      await seedBill({ id: 'a1', billNumber: 'A1', state: 'NJ', status: 'Introduced', statusStage: 'introduced' })
      await seedBill({ id: 'a2', billNumber: 'A2', state: 'NJ', status: 'Passed', statusStage: 'passed' })
      await group('a1', 'a2')
      await subjects([['a1', 'NJ', 'S'], ['a2', 'NJ', 'S']])
      // A filter on a bill's own columns can split a group, and keeps the statement over the bills' rows (billsFacetsPlan.test.ts).
      for (const qs of ['only=subject', 'priority=none&only=subject', 'position=none&only=subject']) {
        const seen = await statementsOf(qs)
        expect(seen.filter(s => GROUPED_ROWS.test(s)), qs).toEqual([])
        expect(seen.filter(s => /group_subjects/.test(s)).length, qs).toBeGreaterThan(0)
      }
    })
  })
})
