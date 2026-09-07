import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import type { SQL } from 'drizzle-orm'
import { eq } from 'drizzle-orm'
import { buildSearchCondition, buildBillNumberBoost } from '../../src/routes/billsApi/query'
import { MAX_SEARCH_TOKENS } from '../../../shared/searchLimits'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { app } from '../../src/index'
import { bills, billSubjects, memberVotes, associationConfig } from '../../src/db/schema'

const dialect = new SQLiteSyncDialect()
const paramCount = (s: SQL) => dialect.sqlToQuery(s).params.length

// Worst case: N single-token comma segments.
const commaBomb = Array.from({ length: 25 }, (_, i) => `term${i}`).join(', ')

describe('search param budget', () => {
  it('caps the token budget at 12', () => {
    expect(MAX_SEARCH_TOKENS).toBe(12)
  })

  it('WHERE-clause params stay within 5 × MAX_SEARCH_TOKENS', () => {
    const cond = buildSearchCondition(commaBomb)!
    expect(paramCount(cond)).toBeLessThanOrEqual(5 * MAX_SEARCH_TOKENS)
  })

  it('ORDER BY boost params stay within 1 × MAX_SEARCH_TOKENS', () => {
    const boost = buildBillNumberBoost(commaBomb)!
    expect(paramCount(boost)).toBeLessThanOrEqual(MAX_SEARCH_TOKENS)
  })

  it('total search-attributable params stay under the D1 100-param ceiling', () => {
    const cond = buildSearchCondition(commaBomb)!
    const boost = buildBillNumberBoost(commaBomb)!
    expect(paramCount(cond) + paramCount(boost)).toBeLessThanOrEqual(6 * MAX_SEARCH_TOKENS)
    expect(paramCount(cond) + paramCount(boost)).toBeLessThan(100)
  })

  it('buildBillNumberBoost is undefined for empty/degenerate queries', () => {
    expect(buildBillNumberBoost(undefined)).toBeUndefined()
    expect(buildBillNumberBoost(',,')).toBeUndefined()
  })
})

describe('match=any', () => {
  // Fixtures: HB0001 has subject Elections, no tags, session 2026.
  //           HB0002 has tag Clerk, no subjects, session 2025.
  let token: string
  let userId: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    userId = await seedUser()
    token = await seedSession(userId)

    const hb1Id = await seedBill({
      billNumber: 'HB0001',
      title: 'Election Reform Act',
      session: '2026',
      status: 'Introduced',
      tags: [],
    })
    await seedBill({
      billNumber: 'HB0002',
      title: 'Clerk Staffing Bill',
      session: '2025',
      status: 'Introduced',
      tags: ['Clerk'],
    })

    const db = getDb(env.DB)
    await db.insert(billSubjects).values({ billId: hb1Id, subjectName: 'Elections', state: 'UT' })
    // The tags facet only reports tags present in the tenant's taxonomy (see
    // loadTaxonomyTagNameSet), so "Clerk" needs to be a taxonomy member for the
    // facet-count assertions below to see it at all.
    await db.insert(associationConfig).values({
      key: 'tag_taxonomy',
      value: JSON.stringify([{ name: 'Clerk' }]),
    })
  })

  async function listBills(query: Record<string, string>) {
    const qs = new URLSearchParams(query).toString()
    const res = await app.request(`/api/bills?${qs}`, { headers: { Cookie: `session=${token}` } }, env)
    return res.json() as Promise<{ bills: Array<{ billNumber: string }> }>
  }

  async function getFacets(query: Record<string, string>) {
    const qs = new URLSearchParams(query).toString()
    const res = await app.request(`/api/bills/facets?${qs}`, { headers: { Cookie: `session=${token}` } }, env)
    return res.json() as Promise<{ status: Record<string, number>; tags: Record<string, number>; subjects: Record<string, number> }>
  }

  async function setRelevance(scores: Record<string, number>) {
    const db = getDb(env.DB)
    for (const [billNumber, score] of Object.entries(scores)) {
      await db.update(bills).set({ relevanceScore: score }).where(eq(bills.billNumber, billNumber)).run()
    }
  }

  async function recordVote({ billNumber }: { billNumber: string }) {
    const db = getDb(env.DB)
    const bill = await db.select({ id: bills.id }).from(bills).where(eq(bills.billNumber, billNumber)).get()
    await db.insert(memberVotes).values({
      id: crypto.randomUUID(),
      billId: bill!.id,
      userId,
      position: 'support',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  }

  it('ANDs groups by default, matching current behaviour', async () => {
    const res = await listBills({ subject: 'UT:Elections', tag: 'Clerk' })
    expect(res.bills).toEqual([])
  })

  it('ORs bill-fact groups when set', async () => {
    const res = await listBills({ subject: 'UT:Elections', tag: 'Clerk', match: 'any' })
    expect(res.bills.map(b => b.billNumber).sort()).toEqual(['HB0001', 'HB0002'])
  })

  it('ORs a session group like any other bill fact', async () => {
    const res = await listBills({ subject: 'UT:Elections', session: '2025', match: 'any' })
    expect(res.bills.map(b => b.billNumber).sort()).toEqual(['HB0001', 'HB0002'])
  })

  it('keeps search narrowing under match=any', async () => {
    const res = await listBills({ subject: 'UT:Elections', tag: 'Clerk', match: 'any', q: 'election' })
    expect(res.bills.map(b => b.billNumber)).toEqual(['HB0001'])
  })

  it('keeps unvoted narrowing under match=any', async () => {
    await recordVote({ billNumber: 'HB0002' })
    const res = await listBills({ subject: 'UT:Elections', tag: 'Clerk', match: 'any', unvoted: '1' })
    expect(res.bills.map(b => b.billNumber)).toEqual(['HB0001'])
  })

  it('ANDs minRelevance by default', async () => {
    // Relevance is a 0-10 scale (the slider's range, index.tsx:807-808).
    await setRelevance({ HB0001: 2, HB0002: 8 })
    const res = await listBills({ subject: 'UT:Elections', minRelevance: '5' })
    expect(res.bills).toEqual([])
  })

  it('ORs minRelevance like any other bill fact', async () => {
    // It renders a "Relevance 5+" chip, so it participates in the operator.
    await setRelevance({ HB0001: 2, HB0002: 8 })
    const res = await listBills({ subject: 'UT:Elections', match: 'any', minRelevance: '5' })
    // HB0001 qualifies via its subject, HB0002 via its relevance score.
    expect(res.bills.map(b => b.billNumber).sort()).toEqual(['HB0001', 'HB0002'])
  })

  it('is inert with a single group', async () => {
    const withFlag = await listBills({ tag: 'Clerk', match: 'any' })
    const without = await listBills({ tag: 'Clerk' })
    expect(withFlag.bills.map(b => b.billNumber)).toEqual(without.bills.map(b => b.billNumber))
  })

  it('applies to facet counts too', async () => {
    const q = { subject: 'UT:Elections', tag: 'Clerk', match: 'any' }
    const list = await listBills(q)
    const facets = await getFacets(q)
    const total = Object.values(facets.status).reduce((a, b) => a + b, 0)
    expect(total).toBe(list.bills.length)
  })

  // Regression test for a whole-branch review finding: the above "applies to
  // facet counts too" test only exercised the status facet, whose dimension
  // is not active in this scenario, so it passed even though the tag and
  // subject facets (which ARE active) disagreed with the list. Under OR,
  // omitting a value's own dimension from its facet count narrows the set
  // (the opposite of disjunctive faceting under AND), so each facet query
  // must drop ALL bill-fact filters, not just its own dimension's.
  it('keeps active-dimension facet counts consistent with the list under match=any', async () => {
    const q = { subject: 'UT:Elections', tag: 'Clerk', match: 'any' }
    const facets = await getFacets(q)
    // HB0002 is in the list solely because of its Clerk tag, and HB0001 has no
    // tags at all — so if the Tags facet still excludes the tag filter's own
    // dimension (leaving only the subject filter), "Clerk" wrongly shows 0.
    expect(facets.tags['Clerk']).toBe(1)
    // Symmetrically, HB0001 is in the list solely via its Elections subject,
    // and HB0002 has no subjects — so a facet query scoped to tag-matching
    // bills only would wrongly show "Elections" as 0.
    expect(facets.subjects['UT:Elections']).toBe(1)
  })
})

describe('subject filter cap', () => {
  let token: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const userId = await seedUser()
    token = await seedSession(userId)
  })

  // Unlike listBills/getFacets above, these need the raw Response (status +
  // body), not just the parsed JSON, and repeated `subject` values — hence
  // building the query string by hand instead of `new URLSearchParams(obj)`,
  // which can only hold one value per key.
  function rawRequest(path: string, query: { subject: string[] }) {
    const qs = new URLSearchParams()
    for (const s of query.subject) qs.append('subject', s)
    return app.request(`${path}?${qs.toString()}`, { headers: { Cookie: `session=${token}` } }, env)
  }

  const rawListBills = (query: { subject: string[] }) => rawRequest('/api/bills', query)
  const rawFacets = (query: { subject: string[] }) => rawRequest('/api/bills/facets', query)

  it('returns 400 rather than a truncated list', async () => {
    const subject = Array.from({ length: 41 }, (_, i) => `UT:S${i}`)
    const res = await rawListBills({ subject })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/too many subject filters/i)
  })

  it('returns 400 on the facets route too', async () => {
    const subject = Array.from({ length: 41 }, (_, i) => `UT:S${i}`)
    expect((await rawFacets({ subject })).status).toBe(400)
  })

  it('accepts exactly the cap', async () => {
    const subject = Array.from({ length: 40 }, (_, i) => `UT:S${i}`)
    expect((await rawListBills({ subject })).status).toBe(200)
  })
})
