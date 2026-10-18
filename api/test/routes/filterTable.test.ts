import { describe, it, expect, beforeAll } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { app } from '../../src/index'
import { BILL_FILTER_DEFS } from '../../../shared/billFilter'
import { FILTER_TABLE, emptyFacets } from '../../src/routes/billsApi/filterTable'

// The API's table of filters (filterTable.ts): one entry per shared filter name, holding the filter's SQL
// condition and its facet count. The compiler checks that no filter is missing a part (the table is typed against
// the shared names). These tests check what the compiler can't: that the table covers the names the shared module
// really defines at run time, and that the response it builds for an empty list is the one the real route builds.

describe('the table of filters', () => {
  it('has an entry for every filter the shared module names, and no other', () => {
    expect(Object.keys(FILTER_TABLE).sort()).toEqual(BILL_FILTER_DEFS.map(d => d.name).sort())
  })

  it('declares a condition for every filter', () => {
    for (const def of BILL_FILTER_DEFS) {
      expect(typeof (FILTER_TABLE as Record<string, { condition: unknown }>)[def.name]?.condition, `the condition of ${def.name}`).toBe('function')
    }
  })

  it('declares a facet count for every filter, or declares that it has none', () => {
    for (const def of BILL_FILTER_DEFS) {
      const entry = (FILTER_TABLE as Record<string, object>)[def.name]
      expect('facet' in entry, `the facet of ${def.name}`).toBe(true)
    }
  })

  it('gives the filters with no facet count no place in the response', () => {
    // A minimum relevance, search, and the group operator are filters nobody picks a value of from a count.
    const names = BILL_FILTER_DEFS.filter(d => (FILTER_TABLE as Record<string, { facet: unknown }>)[d.name].facet === null).map(d => d.name).sort()
    expect(names).toEqual(['match', 'minRelevance', 'search'])
  })
})

describe('the facets response built for a list with nothing in it', () => {
  let cookie: string

  beforeAll(async () => {
    await resetDb()
    await applyMigrations()
    cookie = `session=${await seedSession(await seedUser({ role: 'admin' }))}`
    await seedBill({ billNumber: 'HB 1', priority: 'high', status: 'Passed', statusStage: 'passed', isDraft: true, yearStart: 2026 })
  })

  async function realFacets(qs = '') {
    const res = await app.request(`/api/bills/facets?${qs}`, { headers: { Cookie: cookie } }, env)
    expect(res.status).toBe(200)
    return await res.json() as Record<string, unknown>
  }

  it('has every key the real response has, and no other', async () => {
    const real = await realFacets()
    const tenant = { subjectStates: real.subjectStates as string[], billStates: real.billStates as string[] | undefined, hasDrafts: real.hasDrafts as boolean }
    expect(Object.keys(JSON.parse(JSON.stringify(emptyFacets(tenant)))).sort()).toEqual(Object.keys(real).sort())
  })

  it('counts nothing, and keeps the tenant-wide values it is given', () => {
    const empty = JSON.parse(JSON.stringify(emptyFacets({ subjectStates: ['NJ'], billStates: ['NJ', 'TX'], hasDrafts: true })))
    expect(empty).toEqual({
      status: {}, stage: {}, priority: { none: 0, __any__: 0 }, year: {}, sessionName: {}, state: {},
      position: { none: 0, __any__: 0 }, tag: { __any__: 0 }, subject: {}, subjectStates: ['NJ'], billStates: ['NJ', 'TX'],
      field: {}, myBillsCount: 0, newMatchesCount: 0, unvotedCount: 0, draftCount: 0, hasDrafts: true,
    })
  })
})
