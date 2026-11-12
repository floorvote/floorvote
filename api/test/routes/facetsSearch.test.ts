import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { env } from 'cloudflare:test'
import { seedBill } from '../helpers'
import { searchForm } from '../../src/routes/billsApi/query'
import { ada, db, facets, group, reset, total, type Facets } from './groupFacetsHarness'
import { billSubjects, memberVotes, officialPositions } from '../../src/db/schema'

// The facets under a search count from the matching ids, read once (query.ts `loadSearchIds`), instead of carrying
// the search's LIKEs in every statement. The counts must be the ones the LIKEs give: each test compares the two,
// forcing the LIKE form with `searchForm.idsMax = 0`, which is what a search past the cap falls back to.

type Full = Facets & { committee: Record<string, number>; committeeInfo: Record<string, { name: string; state: string; chamber: string | null }> }

const FIXTURE = [
  { id: 'w1', billNumber: 'A1', title: 'Water rights', status: 'Passed', statusStage: 'passed', state: 'NJ', priority: 'high' as const, tags: ['Energy'] },
  { id: 'w2', billNumber: 'S2', title: 'Water quality', status: 'Introduced', statusStage: 'introduced', state: 'NJ' },
  { id: 'w3', billNumber: 'HB 3', title: 'Clean water act', status: 'Passed', statusStage: 'passed', state: 'TX', priority: 'low' as const },
  { id: 'r1', billNumber: 'HB 4', title: 'Roads', status: 'Passed', statusStage: 'passed', state: 'TX', priority: 'high' as const, tags: ['Energy'] },
  { id: 'r2', billNumber: 'S5', title: 'Bridges', status: 'Introduced', statusStage: 'introduced', state: 'NJ' },
]

describe('facet counts under a search', () => {
  const idsMax = searchForm.idsMax
  beforeEach(async () => {
    await reset()
    for (const b of FIXTURE) await seedBill(b)
    await group('w1', 'r2') // a group with one matching bill counts through it
    await db().insert(memberVotes).values({ id: 'v1', userId: ada, billId: 'w3', position: 'support' })
    await db().insert(officialPositions).values({ id: 'p1', billId: 'w2', position: 'Support', setBy: ada })
    await db().insert(billSubjects).values([
      { billId: 'w1', subjectName: 'Rivers', state: 'NJ' },
      { billId: 'w3', subjectName: 'Rivers', state: 'TX' },
      { billId: 'r1', subjectName: 'Roads', state: 'TX' },
    ])
    await env.DB.batch([
      env.DB.prepare("INSERT INTO bill_committees (bill_id, committee_id, state, name, chamber, is_current) VALUES ('w3', 'c1', 'TX', 'Natural Resources', 'H', 1)"),
      env.DB.prepare("INSERT INTO bill_committees (bill_id, committee_id, state, name, chamber, is_current) VALUES ('r1', 'c2', 'TX', 'Transportation', 'S', 1)"),
    ])
  })
  afterEach(() => { searchForm.idsMax = idsMax })

  const full = (qs: string) => facets(qs) as Promise<Full>
  async function both(qs: string) {
    const fromIds = await full(qs)
    searchForm.idsMax = 0 // the LIKE form
    const fromLikes = await full(qs)
    searchForm.idsMax = idsMax
    return { fromIds, fromLikes }
  }

  it('counts what the LIKEs count, for every facet and the counts beside them', async () => {
    const { fromIds, fromLikes } = await both('search=water')
    expect(fromIds).toEqual(fromLikes)
    expect(fromIds.status).toEqual({ Passed: 2, Introduced: 1 })
    expect(fromIds.state).toEqual({ NJ: 2, TX: 1 })
    expect(fromIds.priority).toEqual({ high: 1, low: 1, none: 1, __any__: 2 })
    expect(fromIds.position).toEqual({ Support: 1, none: 2, __any__: 1 })
    expect(fromIds.subject).toEqual({ 'NJ:Rivers': 1, 'TX:Rivers': 1 })
    expect(fromIds.committee).toEqual({ c1: 1 })
    expect(fromIds.tag).toEqual({ Energy: 1, __any__: 1 })
    expect(fromIds.unvotedCount).toBe(2)
    expect(await total('search=water')).toBe(3)
  })

  it('counts the same under the other filters, in both group operators', async () => {
    for (const qs of [
      'search=water&status=Passed', 'search=water&state=NJ&match=any', 'search=water&status=Passed&tag=Energy&match=any',
      'search=water&unvoted=1', 'search=water&myBills=1', 'search=water&committee=c2', 'search=water&priority=high&position=Support',
    ]) {
      const { fromIds, fromLikes } = await both(qs)
      expect(fromIds, qs).toEqual(fromLikes)
    }
  })

  it('counts nothing when the search matches no bill, and still names a picked committee, as the LIKEs do', async () => {
    const { fromIds, fromLikes } = await both('search=nothing&committee=c2')
    expect(fromIds).toEqual(fromLikes)
    expect(fromIds.status).toEqual({})
    expect(fromIds.committee).toEqual({})
    expect(fromIds.committeeInfo).toEqual({ c2: { name: 'Transportation', state: 'TX', chamber: 'S' } })
    expect(fromIds.unvotedCount).toBe(0)
    expect(await total('search=nothing')).toBe(0)
  })

  it('falls back to the LIKEs, with the same counts, when the search matches more bills than the cap', async () => {
    searchForm.idsMax = 2 // three bills match
    const capped = await full('search=water')
    searchForm.idsMax = idsMax
    expect(capped).toEqual(await full('search=water'))
    expect(capped.status).toEqual({ Passed: 2, Introduced: 1 })
  })
})
