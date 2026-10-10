import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'

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
    await resetDb()
    await applyMigrations()
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
    expect(filtered.status).toEqual({ 'Passed': 1, 'Official Law': 1 })
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
    await resetDb()
    await applyMigrations()
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
