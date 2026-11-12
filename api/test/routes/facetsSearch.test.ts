import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { seedBill } from '../helpers'
import { searchForm } from '../../src/routes/billsApi/query'
import { ada, db, facets, group, reset, total } from './groupFacetsHarness'
import { memberVotes } from '../../src/db/schema'

// The facets under a search count from the matching ids, read once (query.ts `loadSearchIds`), instead of carrying
// the search's LIKEs in every statement. The counts must be the ones the LIKEs give: the harness compares the two,
// forcing the LIKE form through the cap (`searchForm.idsMax`), which is what a search past the cap falls back to.

const FIXTURE = [
  { id: 'w1', billNumber: 'A1', title: 'Water rights', status: 'Passed', statusStage: 'passed', state: 'NJ' },
  { id: 'w2', billNumber: 'S2', title: 'Water quality', status: 'Introduced', statusStage: 'introduced', state: 'NJ' },
  { id: 'w3', billNumber: 'HB 3', title: 'Clean water act', status: 'Passed', statusStage: 'passed', state: 'TX' },
  { id: 'r1', billNumber: 'HB 4', title: 'Roads', status: 'Passed', statusStage: 'passed', state: 'TX' },
  { id: 'r2', billNumber: 'S5', title: 'Bridges', status: 'Introduced', statusStage: 'introduced', state: 'NJ' },
]

describe('facet counts under a search', () => {
  const idsMax = searchForm.idsMax
  beforeEach(async () => {
    await reset()
    for (const b of FIXTURE) await seedBill(b)
    await group('w1', 'r2') // a group with one matching bill counts through it
    await db().insert(memberVotes).values({ id: 'v1', userId: ada, billId: 'w3', position: 'support' })
  })
  afterEach(() => { searchForm.idsMax = idsMax })

  async function both(qs: string) {
    const fromIds = await facets(qs)
    searchForm.idsMax = 0 // every search is past the cap: the LIKE form
    const fromLikes = await facets(qs)
    return { fromIds, fromLikes }
  }

  it('counts what the LIKEs count, for every facet and the counts beside them', async () => {
    const { fromIds, fromLikes } = await both('search=water')
    expect(fromIds).toEqual(fromLikes)
    expect(fromIds.status).toEqual({ Passed: 2, Introduced: 1 })
    expect(fromIds.state).toEqual({ NJ: 2, TX: 1 })
    expect(fromIds.unvotedCount).toBe(2)
    expect(await total('search=water')).toBe(3)
  })

  it('counts the same under the other filters, in both group operators', async () => {
    for (const qs of ['search=water&status=Passed', 'search=water&state=NJ&match=any', 'search=water&unvoted=1', 'search=water&myBills=1']) {
      const { fromIds, fromLikes } = await both(qs)
      expect(fromIds, qs).toEqual(fromLikes)
    }
  })

  it('counts nothing, and the list shows nothing, when the search matches no bill', async () => {
    const { fromIds, fromLikes } = await both('search=nothing')
    expect(fromIds).toEqual(fromLikes)
    expect(fromIds.status).toEqual({})
    expect(fromIds.unvotedCount).toBe(0)
    expect(await total('search=nothing')).toBe(0)
  })

  it('falls back to the LIKEs, with the same counts, when the search matches more bills than the cap', async () => {
    searchForm.idsMax = 2 // three bills match
    const capped = await facets('search=water')
    searchForm.idsMax = idsMax
    expect(capped).toEqual(await facets('search=water'))
  })
})
