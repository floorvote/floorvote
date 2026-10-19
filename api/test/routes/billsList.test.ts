import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { billSubjects, associationConfig } from '../../src/db/schema'
import { app } from '../../src/index'
import { SUPPRESSED_SUBJECT_STATES_KEY } from '../../src/lib/billSubjects'
import { clearBillStatesCache, BILL_STATES_TTL_MS } from '../../src/lib/billStates'

// Seeds a bill plus its bill_subjects rows (one per subject, tagged with the bill's state).
// Mirrors seedBill's override shape; `tags` here takes the same string[] shape seedBill uses.
async function seedBillWithSubjects(
  db: ReturnType<typeof getDb>,
  fields: { id: string; state?: string; matchType?: 'keyword' | 'manual' | null; tags?: string[] },
  subjects: string[],
): Promise<void> {
  await seedBill({
    id: fields.id,
    state: fields.state,
    tags: fields.tags,
    ...('matchType' in fields ? { matchType: fields.matchType } : {}),
  })
  if (subjects.length > 0) {
    await db.insert(billSubjects).values(
      subjects.map(name => ({ billId: fields.id, subjectName: name, state: fields.state ?? 'RI' })),
    ).run()
  }
}

type ListBody = {
  bills: Array<{ id: string }>
  total: number
}

type FacetsBody = {
  subject: Record<string, number>
  subjectStates: string[]
  billStates?: string[]
}

describe('GET /bills — subject filtering', () => {
  let token: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const userId = await seedUser()
    token = await seedSession(userId)
  })

  it('filters bills by a state-qualified subject, including untracked ones', async () => {
    const db = getDb(env.DB)
    await seedBillWithSubjects(db, { id: 's1', state: 'UT', matchType: 'keyword' }, ['Election Law'])
    await seedBillWithSubjects(db, { id: 's2', state: 'UT', matchType: null }, ['Election Law'])
    await seedBillWithSubjects(db, { id: 's3', state: 'UT', matchType: 'keyword' }, ['Counties'])

    const res = await app.request('/api/bills?subject=UT%3AElection%20Law', { headers: { Cookie: `session=${token}` } }, env)
    const body = await res.json() as { bills: { id: string }[]; pagination: { total: number } }

    expect(body.pagination.total).toBe(2)
    expect(body.bills.map(b => b.id).sort()).toEqual(['s1', 's2'])
  })

  it('does not match the same subject name in another state', async () => {
    const db = getDb(env.DB)
    await seedBillWithSubjects(db, { id: 's4', state: 'UT' }, ['Education'])
    await seedBillWithSubjects(db, { id: 's5', state: 'NJ' }, ['Education'])

    const res = await app.request('/api/bills?subject=NJ%3AEducation', { headers: { Cookie: `session=${token}` } }, env)
    const body = await res.json() as { bills: { id: string }[] }

    expect(body.bills.map(b => b.id)).toEqual(['s5'])
  })

  it('ORs multiple subject values within the dimension', async () => {
    const db = getDb(env.DB)
    await seedBillWithSubjects(db, { id: 's6', state: 'UT' }, ['Referenda'])
    await seedBillWithSubjects(db, { id: 's7', state: 'UT' }, ['Initiatives'])
    await seedBillWithSubjects(db, { id: 's8', state: 'UT' }, ['Counties'])

    const res = await app.request(
      '/api/bills?subject=UT%3AReferenda&subject=UT%3AInitiatives',
      { headers: { Cookie: `session=${token}` } },
      env,
    )
    const body = await res.json() as { pagination: { total: number } }

    expect(body.pagination.total).toBe(2)
  })

  it('ANDs the subject dimension against the tag dimension', async () => {
    const db = getDb(env.DB)
    await seedBillWithSubjects(db, { id: 's9', state: 'UT', tags: ['Elections'] }, ['Election Law'])
    await seedBillWithSubjects(db, { id: 's10', state: 'UT', tags: [] }, ['Election Law'])

    const res = await app.request(
      '/api/bills?subject=UT%3AElection%20Law&tag=Elections',
      { headers: { Cookie: `session=${token}` } },
      env,
    )
    const body = await res.json() as { bills: { id: string }[] }

    expect(body.bills.map(b => b.id)).toEqual(['s9'])
  })

  it('ignores a malformed subject value rather than returning nothing', async () => {
    const db = getDb(env.DB)
    await seedBillWithSubjects(db, { id: 's11', state: 'UT' }, ['Counties'])

    const res = await app.request('/api/bills?subject=NoColonHere', { headers: { Cookie: `session=${token}` } }, env)
    const body = await res.json() as { pagination: { total: number } }

    expect(body.pagination.total).toBe(1)
  })

  it('serves a different page when only the subject filter differs (cache-key regression guard)', async () => {
    const db = getDb(env.DB)
    await seedBillWithSubjects(db, { id: 's12', state: 'UT' }, ['Referenda'])
    await seedBillWithSubjects(db, { id: 's13', state: 'UT' }, ['Initiatives'])

    const tenantEnv = { ...env, TENANT_ID: `subject-cache-${crypto.randomUUID()}`, LIST_CACHE_TTL: '60' }
    const cookie = { headers: { Cookie: `session=${token}` } }

    const a = await (await app.request('/api/bills?subject=UT%3AReferenda', cookie, tenantEnv)).json() as ListBody
    const b = await (await app.request('/api/bills?subject=UT%3AInitiatives', cookie, tenantEnv)).json() as ListBody

    expect(a.bills.map(x => x.id)).toEqual(['s12'])
    expect(b.bills.map(x => x.id)).toEqual(['s13'])
  })

  it('counts subjects per state in the facets response', async () => {
    const db = getDb(env.DB)
    await seedBillWithSubjects(db, { id: 's14', state: 'UT' }, ['Election Law', 'Referenda'])
    await seedBillWithSubjects(db, { id: 's15', state: 'UT', matchType: null }, ['Election Law'])
    await seedBillWithSubjects(db, { id: 's16', state: 'NJ' }, ['Education'])

    const res = await app.request('/api/bills/facets', { headers: { Cookie: `session=${token}` } }, env)
    const body = await res.json() as FacetsBody

    expect(body.subject['UT:Election Law']).toBe(2)
    expect(body.subject['UT:Referenda']).toBe(1)
    expect(body.subject['NJ:Education']).toBe(1)
  })

  // subjectStates answers "which states have subjects at all", so the web app
  // can tell a state with none from one a filter merely hid. `subjects` above
  // is scoped by every other active filter; this is not.
  it('lists the states that have subjects, whatever filters are active', async () => {
    const db = getDb(env.DB)
    await seedBillWithSubjects(db, { id: 's18', state: 'UT' }, ['Election Law'])
    await seedBillWithSubjects(db, { id: 's19', state: 'NJ' }, ['Education'])
    await seedBillWithSubjects(db, { id: 's20', state: 'OH' }, [])

    const res = await app.request('/api/bills/facets?state=UT', { headers: { Cookie: `session=${token}` } }, env)
    const body = await res.json() as FacetsBody

    expect(body.subject['NJ:Education']).toBeUndefined()
    expect(body.subjectStates).toEqual(['NJ', 'UT'])
  })

  // IMPORTANT 1 regression: subjectMembership binds 2 params per value with no cap,
  // and a shared/bookmarked URL can carry far more than D1's 100-bound-param limit.
  // Without a cap, this would 500 instead of returning a response. It no longer
  // silently truncates past the cap either (see test/routes/searchParams.test.ts
  // "subject filter cap") — over-cap now 400s rather than 500ing or under-selecting.
  it('does not 500 when the URL carries far more subject filters than D1 can bind', async () => {
    const db = getDb(env.DB)
    await seedBillWithSubjects(db, { id: 's17', state: 'UT' }, ['Election Law'])

    const params = new URLSearchParams()
    for (let i = 0; i < 60; i++) params.append('subject', `UT:Subject ${i}`)
    const res = await app.request(`/api/bills?${params}`, { headers: { Cookie: `session=${token}` } }, env)

    expect(res.status).toBe(400)
  })
})

describe('GET /bills — subject suppression', () => {
  let token: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const userId = await seedUser()
    token = await seedSession(userId)
  })

  it('facet counts omit a suppressed state entirely', async () => {
    const db = getDb(env.DB)
    await seedBillWithSubjects(db, { id: 'sup1', state: 'NJ' }, ['State and Local Government'])
    await seedBillWithSubjects(db, { id: 'sup2', state: 'UT' }, ['Election Administration'])
    await db.insert(associationConfig).values({
      key: SUPPRESSED_SUBJECT_STATES_KEY, value: JSON.stringify(['NJ']),
    }).run()

    const res = await app.request('/api/bills/facets', { headers: { Cookie: `session=${token}` } }, env)
    const body = await res.json() as FacetsBody

    expect(body.subject['NJ:State and Local Government']).toBeUndefined()
    expect(body.subject['UT:Election Administration']).toBe(1)
  })

  it('subjectStates leaves out a suppressed state', async () => {
    const db = getDb(env.DB)
    await seedBillWithSubjects(db, { id: 'sup4', state: 'NJ' }, ['State and Local Government'])
    await seedBillWithSubjects(db, { id: 'sup5', state: 'UT' }, ['Election Administration'])
    await db.insert(associationConfig).values({
      key: SUPPRESSED_SUBJECT_STATES_KEY, value: JSON.stringify(['NJ']),
    }).run()

    const res = await app.request('/api/bills/facets', { headers: { Cookie: `session=${token}` } }, env)
    const body = await res.json() as FacetsBody

    expect(body.subjectStates).toEqual(['UT'])
  })

  it('a subject filter naming a suppressed state is ignored, not treated as matching nothing', async () => {
    const db = getDb(env.DB)
    // s1 carries the suppressed NJ subject AND an unsuppressed UT one, so we can
    // tell "the NJ value was dropped from the filter" apart from "it matched
    // nothing": if dropped, s1 still shows up via nothing else filtering it out.
    await seedBillWithSubjects(db, { id: 'sup3', state: 'NJ' }, ['State and Local Government'])
    await db.insert(associationConfig).values({
      key: SUPPRESSED_SUBJECT_STATES_KEY, value: JSON.stringify(['NJ']),
    }).run()

    const res = await app.request(
      '/api/bills?subject=NJ%3AState%20and%20Local%20Government',
      { headers: { Cookie: `session=${token}` } },
      env,
    )
    const body = await res.json() as ListBody

    // Ignored (not "match nothing"): with no other filter active, the suppressed
    // subject param has no narrowing effect, so the bill still comes back — it is
    // NOT excluded as if the filter had matched zero bills.
    expect(body.bills.map(b => b.id)).toEqual(['sup3'])
  })

  it('a suppressed-state subject filter does not leak other suppressed bills in via OR', async () => {
    const db = getDb(env.DB)
    await seedBillWithSubjects(db, { id: 'sup4', state: 'NJ' }, ['State and Local Government'])
    await seedBillWithSubjects(db, { id: 'sup5', state: 'UT' }, ['Election Administration'])
    await db.insert(associationConfig).values({
      key: SUPPRESSED_SUBJECT_STATES_KEY, value: JSON.stringify(['NJ']),
    }).run()

    // Only the (allowed) UT value should have any filtering effect; the NJ value
    // is dropped, so this must behave exactly like `?subject=UT:...` alone.
    const res = await app.request(
      '/api/bills?subject=NJ%3AState%20and%20Local%20Government&subject=UT%3AElection%20Administration',
      { headers: { Cookie: `session=${token}` } },
      env,
    )
    const body = await res.json() as ListBody

    expect(body.bills.map(b => b.id)).toEqual(['sup5'])
  })
})

// billStates is what `*` coverage means to the web app: every state the
// instance has bills in. Only a `*` instance needs it, and it costs a scan of
// bills, so it is computed only then and kept per tenant for a while.
describe('GET /bills/facets — billStates', () => {
  let token: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    clearBillStatesCache()
    token = await seedSession(await seedUser())
  })

  async function setCoverage(states: string[]) {
    await getDb(env.DB).insert(associationConfig).values({ key: 'state_coverage', value: JSON.stringify(states) }).run()
  }

  // An env whose DB counts the statements that read the distinct states of
  // bills, so a test can tell a cache hit (or a skipped query) from a re-read.
  function countingEnv(extra: Record<string, unknown> = {}) {
    const state = { stateReads: 0 }
    const DB = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (query: string) => {
            if (query.includes('distinct "state" from "bills"')) state.stateReads++
            return target.prepare(query)
          }
        }
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    return { state, env: { ...env, ...extra, DB } as typeof env }
  }

  async function facets(e: typeof env, query = '') {
    const res = await app.request(`/api/bills/facets${query}`, { headers: { Cookie: `session=${token}` } }, e)
    expect(res.status).toBe(200)
    return await res.json() as FacetsBody
  }

  it('lists every state with bills on * coverage, whatever filters are active', async () => {
    await setCoverage(['*'])
    const db = getDb(env.DB)
    await seedBillWithSubjects(db, { id: 'b1', state: 'UT' }, ['Election Law'])
    await seedBillWithSubjects(db, { id: 'b2', state: 'NJ' }, [])
    await seedBillWithSubjects(db, { id: 'b3', state: 'OH' }, [])

    const body = await facets(env, '?state=UT')

    expect(body.billStates).toEqual(['NJ', 'OH', 'UT'])
  })

  it('lists no bill states on * coverage when there are no bills', async () => {
    await setCoverage(['*'])
    expect((await facets(env)).billStates).toEqual([])
  })

  it('still lists every state when My Bills narrows the result to none', async () => {
    await setCoverage(['*'])
    const db = getDb(env.DB)
    await seedBillWithSubjects(db, { id: 'b4', state: 'UT' }, ['Election Law'])
    await seedBillWithSubjects(db, { id: 'b5', state: 'OH' }, [])

    const body = await facets(env, '?myBills=true')

    expect(body.billStates).toEqual(['OH', 'UT'])
  })

  it('counts a suppressed state, whose subjects are hidden but whose bills exist', async () => {
    await setCoverage(['*'])
    const db = getDb(env.DB)
    await seedBillWithSubjects(db, { id: 'b6', state: 'NJ' }, ['State and Local Government'])
    await seedBillWithSubjects(db, { id: 'b7', state: 'UT' }, ['Election Administration'])
    await db.insert(associationConfig).values({ key: SUPPRESSED_SUBJECT_STATES_KEY, value: JSON.stringify(['NJ']) }).run()

    const body = await facets(env)

    expect(body.billStates).toEqual(['NJ', 'UT'])
    expect(body.subjectStates).toEqual(['UT'])
  })

  describe('with an explicit list of states', () => {
    it('leaves the field out and never reads the states of bills', async () => {
      await setCoverage(['NJ', 'UT'])
      await seedBillWithSubjects(getDb(env.DB), { id: 'b8', state: 'UT' }, ['Election Law'])
      const { state, env: counted } = countingEnv()

      const body = await facets(counted)

      expect(body.billStates).toBeUndefined()
      expect(state.stateReads).toBe(0)
    })

    it('leaves it out for one listed state too', async () => {
      await setCoverage(['UT'])
      const { state, env: counted } = countingEnv()
      expect((await facets(counted)).billStates).toBeUndefined()
      expect(state.stateReads).toBe(0)
    })

    it('leaves it out on a STATE-scoped instance, even if the saved coverage says *', async () => {
      await setCoverage(['*'])
      const { state, env: counted } = countingEnv({ STATE: 'UT' })
      expect((await facets(counted)).billStates).toBeUndefined()
      expect(state.stateReads).toBe(0)
    })

    it('leaves it out when there is no saved coverage (config reports no states then)', async () => {
      const { state, env: counted } = countingEnv()
      expect((await facets(counted)).billStates).toBeUndefined()
      expect(state.stateReads).toBe(0)
    })

    it('leaves it out when the saved coverage cannot be parsed', async () => {
      await getDb(env.DB).insert(associationConfig).values({ key: 'state_coverage', value: 'not json' }).run()
      const { state, env: counted } = countingEnv()
      expect((await facets(counted)).billStates).toBeUndefined()
      expect(state.stateReads).toBe(0)
    })
  })

  describe('on * coverage, the cache', () => {
    beforeEach(async () => {
      await setCoverage(['*'])
      await seedBillWithSubjects(getDb(env.DB), { id: 'c1', state: 'UT' }, [])
    })

    it('reads the states once for requests within the TTL, even as filters change', async () => {
      const { state, env: counted } = countingEnv()
      expect((await facets(counted)).billStates).toEqual(['UT'])
      expect((await facets(counted, '?state=UT')).billStates).toEqual(['UT'])
      expect((await facets(counted, '?search=anything')).billStates).toEqual(['UT'])
      expect(state.stateReads).toBe(1)
    })

    it('does not see a new state until the TTL has passed, then reads again', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        const { state, env: counted } = countingEnv()
        await facets(counted)
        await seedBillWithSubjects(getDb(env.DB), { id: 'c2', state: 'NJ' }, [])

        vi.setSystemTime(Date.now() + BILL_STATES_TTL_MS - 1000)
        expect((await facets(counted)).billStates).toEqual(['UT'])
        expect(state.stateReads).toBe(1)

        vi.setSystemTime(Date.now() + 2000)
        expect((await facets(counted)).billStates).toEqual(['NJ', 'UT'])
        expect(state.stateReads).toBe(2)
      } finally {
        vi.useRealTimers()
      }
    })

    it('shares one read between requests that arrive while it runs', async () => {
      const { state, env: counted } = countingEnv()
      const bodies = await Promise.all([facets(counted), facets(counted), facets(counted)])
      expect(bodies.map(b => b.billStates)).toEqual([['UT'], ['UT'], ['UT']])
      expect(state.stateReads).toBe(1)
    })

    it('keeps a separate entry per tenant', async () => {
      const first = countingEnv({ TENANT_ID: 'tenant-a' })
      const second = countingEnv({ TENANT_ID: 'tenant-b' })
      await facets(first.env)
      await facets(second.env)
      await facets(first.env)
      expect(first.state.stateReads).toBe(1)
      expect(second.state.stateReads).toBe(1)
    })

    it('does not cache a failed read, so the next request tries again', async () => {
      let fail = true
      const state = { stateReads: 0 }
      const DB = new Proxy(env.DB, {
        get(target, prop) {
          if (prop === 'prepare') {
            return (query: string) => {
              if (query.includes('distinct "state" from "bills"')) {
                state.stateReads++
                if (fail) throw new Error('boom')
              }
              return target.prepare(query)
            }
          }
          const value = Reflect.get(target, prop, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      const flaky = { ...env, DB } as typeof env
      const failed = await app.request('/api/bills/facets', { headers: { Cookie: `session=${token}` } }, flaky)
      expect(failed.status).toBe(500)
      fail = false
      expect((await facets(flaky)).billStates).toEqual(['UT'])
      expect(state.stateReads).toBe(2)
    })
  })
})
