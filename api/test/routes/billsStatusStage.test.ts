import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SELF } from 'cloudflare:test'
import { clearDb, seedUser, seedSession, seedBill } from '../helpers'

// Bills from three providers, each with the stage and rank central sent from
// its vocabulary. Rank orders them across providers, where their labels alone
// could not.
async function seedProviderMix() {
  await seedBill({ billNumber: 'HB 1', state: 'RI', status: 'Introduced', statusStage: 'introduced', statusRank: 103 })
  await seedBill({ billNumber: 'HB 2', state: 'RI', status: 'Passed', statusStage: 'enacted', statusRank: 701 })
  await seedBill({ billNumber: 'B26-0400', state: 'DC', status: 'Under Mayoral Review', statusStage: 'passed', statusRank: 401 })
  await seedBill({ billNumber: 'B26-0001', state: 'DC', status: 'Official Law', statusStage: 'enacted', statusRank: 705 })
  await seedBill({ billNumber: 'HB 3', state: 'VA', status: 'Passed the House', statusStage: 'passed_one_chamber', statusRank: 301 })
  await seedBill({ billNumber: 'HB 4', state: 'VA', status: 'Vetoed by the Governor', statusStage: 'vetoed', statusRank: 601 })
  await seedBill({ billNumber: 'D1', state: 'RI', status: '', isDraft: true })
}

describe('status stage and rank in the bill list', () => {
  let cookie: string

  beforeEach(async () => {
    await clearDb()
    cookie = `session=${await seedSession(await seedUser())}`
    await seedProviderMix()
  })

  async function list(query: string) {
    const res = await SELF.fetch(`http://localhost/api/bills?${query}`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    return (await res.json() as { bills: Array<{ billNumber: string }> }).bills.map(b => b.billNumber)
  }

  it('sorts by status rank across providers', async () => {
    expect(await list('sort=status&dir=desc')).toEqual(['B26-0001', 'HB 2', 'HB 4', 'B26-0400', 'HB 3', 'HB 1', 'D1'])
    expect(await list('sort=status&dir=asc')).toEqual(['D1', 'HB 1', 'HB 3', 'B26-0400', 'HB 4', 'HB 2', 'B26-0001'])
  })

  it('filters by stage', async () => {
    expect((await list('stage=enacted')).sort()).toEqual(['B26-0001', 'HB 2'])
    expect((await list('stage=enacted&stage=vetoed')).sort()).toEqual(['B26-0001', 'HB 2', 'HB 4'])
  })

  it('combines the stage filter with the others like any bill fact', async () => {
    expect(await list('stage=enacted&state=DC')).toEqual(['B26-0001'])
    expect((await list('stage=enacted&state=VA&match=any')).sort()).toEqual(['B26-0001', 'HB 2', 'HB 3', 'HB 4'])
  })

  it('matches a word status from a saved view or link that names its old bare code', async () => {
    await seedBill({ billNumber: 'HB 5', state: 'RI', status: 'Override', statusStage: 'enacted', statusRank: 702 })
    expect(await list('status=7')).toEqual(['HB 5'])
    expect(await list('status=Override')).toEqual(['HB 5'])
    const res = await SELF.fetch('http://localhost/api/bills/facets?status=7', { headers: { Cookie: cookie } })
    // The code narrows the other facets like the word does: the one bill is in RI.
    expect((await res.json() as { state: Record<string, number> }).state).toEqual({ RI: 1 })
  })

  it('counts each stage, leaving the stage filter out of its own counts', async () => {
    const facets = async (query: string) => {
      const res = await SELF.fetch(`http://localhost/api/bills/facets?${query}`, { headers: { Cookie: cookie } })
      expect(res.status).toBe(200)
      return res.json() as Promise<{ stage: Record<string, number>; status: Record<string, number> }>
    }
    expect((await facets('')).stage).toEqual({ introduced: 1, passed_one_chamber: 1, passed: 1, vetoed: 1, enacted: 2 })
    const filtered = await facets('stage=enacted')
    expect(filtered.stage.enacted).toBe(2)
    expect(filtered.stage.introduced).toBe(1)
    // The stage is part of the Status fact, so a chosen stage leaves its own statuses' counts alone (#677).
    expect(filtered.status).toEqual((await facets('')).status)
  })
})

// Status and stage are one bill fact (#677): a bill matches when its status is a chosen status OR its stage is a
// chosen stage. Before, a link that set both matched the overlap of the two.
describe('status and stage as one fact', () => {
  let cookie: string
  type Facets = {
    status: Record<string, number>; stage: Record<string, number>
    statusGroups?: Record<string, { stage: string | null; rank: number }>
  }

  beforeEach(async () => {
    await clearDb()
    cookie = `session=${await seedSession(await seedUser({ role: 'admin' }))}`
    await seedProviderMix()
  })

  async function get(path: string) {
    const res = await SELF.fetch(`http://localhost/api${path}`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    return res.json() as Promise<any> // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  const list = async (qs: string) => ((await get(`/bills?pageSize=50&${qs}`)).bills as Array<{ billNumber: string }>).map(b => b.billNumber).sort()
  const total = async (qs: string) => (await get(`/bills?pageSize=50&${qs}`)).pagination.total as number
  const facets = (qs = '') => get(`/bills/facets?${qs}`) as Promise<Facets>
  async function post(path: string, body: object) {
    const res = await SELF.fetch(`http://localhost/api${path}`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    return { status: res.status, body: await res.json() as Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  describe('the list and its total', () => {
    it('matches a status in the chosen statuses OR a stage in the chosen stages', async () => {
      // Passed is HB 2 (enacted), and the vetoed stage is HB 4. The overlap of the two is empty.
      expect(await list('status=Passed&stage=vetoed')).toEqual(['HB 2', 'HB 4'])
      expect(await total('status=Passed&stage=vetoed')).toBe(2)
    })

    it('reads a status alone, a stage alone, and neither, as before', async () => {
      expect(await list('status=Passed')).toEqual(['HB 2'])
      expect(await list('stage=vetoed')).toEqual(['HB 4'])
      expect((await list('')).length).toBe(7) // the draft too
    })

    it('takes a whole stage group, or a single status within it, the same way', async () => {
      expect(await list('stage=enacted')).toEqual(['B26-0001', 'HB 2'])
      expect(await list('status=Official Law')).toEqual(['B26-0001'])
      // A stage and one of its own statuses add nothing to each other.
      expect(await list('stage=enacted&status=Official Law')).toEqual(['B26-0001', 'HB 2'])
    })

    it('counts a bill in both the status and the stage once', async () => {
      expect(await list('status=Passed&stage=enacted')).toEqual(['B26-0001', 'HB 2'])
      expect(await total('status=Passed&stage=enacted')).toBe(2)
    })

    it('joins several statuses and several stages in the one union', async () => {
      expect(await list('status=Introduced&status=Official Law&stage=vetoed&stage=passed')).toEqual(['B26-0001', 'B26-0400', 'HB 1', 'HB 4'])
    })

    it('narrows by the other filters like any bill fact (AND), and joins them under match=any', async () => {
      expect(await list('status=Introduced&stage=enacted&state=RI')).toEqual(['HB 1', 'HB 2'])
      expect(await list('status=Passed&stage=vetoed&state=DC&match=any')).toEqual(['B26-0001', 'B26-0400', 'HB 2', 'HB 4'])
    })

    it('still reads the old bare code of a status as that status inside the union', async () => {
      await seedBill({ billNumber: 'HB 5', state: 'RI', status: 'Override', statusStage: 'enacted', statusRank: 702 })
      expect(await list('status=7&stage=vetoed')).toEqual(['HB 4', 'HB 5'])
    })

    it('answers a different list for each combination when the list cache is on', async () => {
      // The cache key is the serialized bill filter, so a stage added to a status filter is another key.
      const a = await list('status=Passed')
      const b = await list('status=Passed&stage=vetoed')
      expect([a, b]).toEqual([['HB 2'], ['HB 2', 'HB 4']])
      expect(await list('status=Passed')).toEqual(a)
      expect(await list('status=Passed&stage=vetoed')).toEqual(b)
    })
  })

  describe('the facet counts', () => {
    const ALL_STATUSES = {
      'Introduced': 1, 'Passed': 1, 'Under Mayoral Review': 1, 'Official Law': 1, 'Passed the House': 1, 'Vetoed by the Governor': 1,
    }
    const ALL_STAGES = { introduced: 1, passed_one_chamber: 1, passed: 1, vetoed: 1, enacted: 2 }

    it('leaves the whole fact out of both counts, so a chosen stage does not zero its own statuses', async () => {
      const f = await facets('stage=enacted')
      expect(f.status).toEqual(ALL_STATUSES)
      expect(f.stage).toEqual(ALL_STAGES)
    })

    it('leaves the stage counts alone when a status is chosen', async () => {
      const f = await facets('status=Passed')
      expect(f.stage).toEqual(ALL_STAGES)
      expect(f.status).toEqual(ALL_STATUSES)
    })

    it('leaves both counts alone when a status and a stage are both chosen', async () => {
      const f = await facets('status=Passed&stage=vetoed')
      expect(f.status).toEqual(ALL_STATUSES)
      expect(f.stage).toEqual(ALL_STAGES)
    })

    it('narrows every count by the other filters', async () => {
      const f = await facets('state=DC&stage=enacted')
      expect(f.status).toEqual({ 'Under Mayoral Review': 1, 'Official Law': 1 })
      expect(f.stage).toEqual({ passed: 1, enacted: 1 })
    })

    it('counts the other facets under the union', async () => {
      const f = await facets('status=Passed&stage=vetoed') as unknown as { state: Record<string, number> }
      expect(f.state).toEqual({ RI: 1, VA: 1 })
    })

    it('counts a label the providers share once, with the counts merged', async () => {
      await seedBill({ billNumber: 'HB 20', state: 'RI', status: 'Withdrawn', statusStage: 'failed', statusRank: 501 })
      await seedBill({ billNumber: 'B26-0020', state: 'DC', status: 'Withdrawn', statusStage: 'failed', statusRank: 502 })
      await seedBill({ billNumber: 'HB 21', state: 'VA', status: 'Withdrawn', statusStage: 'failed', statusRank: 500 })
      const f = await facets('')
      expect(f.status.Withdrawn).toBe(3)
      expect(Object.keys(f.statusGroups!).filter(k => k === 'Withdrawn')).toEqual(['Withdrawn'])
    })

    it('agrees with the list under a status and a stage in OR mode', async () => {
      // Under match=any each count is the total after picking it.
      const f = await facets('status=Passed&match=any')
      expect(f.stage.vetoed).toBe(await total('status=Passed&stage=vetoed&match=any'))
    })
  })

  describe('statusGroups', () => {
    it('gives each status label with bills its stage and rank', async () => {
      expect((await facets('')).statusGroups).toEqual({
        'Introduced': { stage: 'introduced', rank: 103 },
        'Passed': { stage: 'enacted', rank: 701 },
        'Under Mayoral Review': { stage: 'passed', rank: 401 },
        'Official Law': { stage: 'enacted', rank: 705 },
        'Passed the House': { stage: 'passed_one_chamber', rank: 301 },
        'Vetoed by the Governor': { stage: 'vetoed', rank: 601 },
      })
    })

    it('takes the stage with the most bills for a label in more than one, and the highest rank among its bills', async () => {
      await seedBill({ billNumber: 'M1', state: 'RI', status: 'Mixed', statusStage: 'passed', statusRank: 401 })
      await seedBill({ billNumber: 'M2', state: 'RI', status: 'Mixed', statusStage: 'passed', statusRank: 402 })
      await seedBill({ billNumber: 'M3', state: 'RI', status: 'Mixed', statusStage: 'enacted', statusRank: 705 })
      expect((await facets('')).statusGroups!.Mixed).toEqual({ stage: 'passed', rank: 705 })
    })

    it('breaks a tie between two stages for the later stage', async () => {
      await seedBill({ billNumber: 'T1', state: 'RI', status: 'Tied', statusStage: 'passed', statusRank: 401 })
      await seedBill({ billNumber: 'T2', state: 'RI', status: 'Tied', statusStage: 'vetoed', statusRank: 601 })
      expect((await facets('')).statusGroups!.Tied).toEqual({ stage: 'vetoed', rank: 601 })
    })

    it('is null for a label with no staged bills, and takes the staged bills over unstaged ones', async () => {
      await seedBill({ billNumber: 'U1', state: 'RI', status: 'Unstaged', statusStage: null, statusRank: 0 })
      await seedBill({ billNumber: 'H1', state: 'RI', status: 'Half', statusStage: null, statusRank: 0 })
      await seedBill({ billNumber: 'H2', state: 'RI', status: 'Half', statusStage: 'passed', statusRank: 401 })
      const g = (await facets('')).statusGroups!
      expect(g.Unstaged).toEqual({ stage: null, rank: 0 })
      expect(g.Half).toEqual({ stage: 'passed', rank: 401 })
    })

    it('is built from the rows of the status counts: other filters narrow it, the fact itself does not', async () => {
      const f = await facets('state=DC&stage=enacted')
      expect(Object.keys(f.statusGroups!).sort()).toEqual(Object.keys(f.status).sort())
      expect(Object.keys((await facets('state=DC')).statusGroups!).sort()).toEqual(['Official Law', 'Under Mayoral Review'])
    })

    it('is empty for a list with nothing in it', async () => {
      expect((await facets('state=XX')).statusGroups).toEqual({})
    })
  })

  describe('the bulk actions select the bills the list shows', () => {
    it('edits the union, the bills the same query string lists', async () => {
      const qs = 'status=Passed&stage=vetoed'
      const listed = await list(qs)
      const res = await post('/bills/bulk', { filter: qs, priority: 'high' })
      expect(res.status).toBe(200)
      expect(res.body.updated).toBe(listed.length)
      expect(await list('priority=high')).toEqual(listed)
    })

    it('does not touch a bill in only the overlap of the two', async () => {
      // Intersection would have edited nothing for these two, and the union edits exactly the two bills below.
      await post('/bills/bulk', { filter: 'status=Introduced&stage=enacted', priority: 'low' })
      expect(await list('priority=low')).toEqual(['B26-0001', 'HB 1', 'HB 2'])
    })

    it('reads the pre-fill values from the same union', async () => {
      await post('/bills/bulk', { filter: 'stage=vetoed', priority: 'high' })
      const res = await get('/bills/bulk-values?status=Passed&stage=vetoed')
      // HB 4 (the vetoed stage) holds the priority just set, and HB 2 (the status) has none.
      expect(res.count).toBe(2)
      expect(res.priorities).toEqual({ high: 1, null: 1 })
    })
  })
})

describe('GET /bills/labels', () => {
  let cookie: string
  const labels = {
    state: 'DC',
    statuses: [{ label: 'Under Mayoral Review', stage: 'passed', rank: 401, explainer: 'Sent to the Mayor.' }],
    billTypes: [], eventTypes: [], calendarName: 'DC Council calendar', hasEvents: false,
  }

  beforeEach(async () => {
    await clearDb()
    cookie = `session=${await seedSession(await seedUser())}`
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('serves central\'s explainers for the state', async () => {
    // A plain object: a Response made here can't be read from the worker's request.
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => labels })
    vi.stubGlobal('fetch', fetchMock)
    const res = await SELF.fetch('http://localhost/api/bills/labels?state=dc', { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(labels)
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/bills\/labels\?state=DC$/)
  })

  it('requires a two-letter state', async () => {
    const res = await SELF.fetch('http://localhost/api/bills/labels', { headers: { Cookie: cookie } })
    expect(res.status).toBe(400)
  })

  it('answers 502 when central has none', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }))
    const res = await SELF.fetch('http://localhost/api/bills/labels?state=DC', { headers: { Cookie: cookie } })
    expect(res.status).toBe(502)
  })

  it('requires a session', async () => {
    expect((await SELF.fetch('http://localhost/api/bills/labels?state=DC')).status).toBe(401)
  })
})
