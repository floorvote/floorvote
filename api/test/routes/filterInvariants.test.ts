import { describe, it, expect, beforeAll } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { app } from '../../src/index'
import { billSubjects, officialPositions, associationConfig } from '../../src/db/schema'

// The six selectable, operator-participating dimensions. myBills/newMatches/unvoted
// are viewer-scope filters that ALWAYS narrow (they AND on top unconditionally — see
// buildBillsWhere in query.ts) and are deliberately excluded: asserting the OR/AND
// laws for them would assert something that is intentionally false. minRelevance is
// a bill fact and does participate in the operator, but it's a threshold rather than
// a discrete value set, which doesn't fit the pairwise union/intersection sweep below
// as cleanly as the other six — its OR/AND behavior is already covered directly in
// searchParams.test.ts ("ANDs minRelevance by default" / "ORs minRelevance like any
// other bill fact"), so it's left out of this sweep rather than forced in.
const DIMENSIONS: Array<{ key: string; param: string; value: string }> = [
  { key: 'status',   param: 'status',   value: 'Passed' },
  { key: 'priority', param: 'priority', value: 'high' },
  { key: 'session',  param: 'session',  value: '2026' },
  { key: 'tags',     param: 'tag',      value: 'Clerk' },
  { key: 'subjects', param: 'subject',  value: 'UT:Elections' },
  { key: 'position', param: 'position', value: 'Support' },
]

type DimKey = typeof DIMENSIONS[number]['key']
const DIM_KEYS = DIMENSIONS.map(d => d.key) as DimKey[]

const ids = (r: { bills: Array<{ id: string }> }) => new Set(r.bills.map(b => b.id))

describe('filter algebra', () => {
  let token: string

  // Seed a fixture with deliberate cross-dimension overlap, then assert the laws
  // hold for EVERY pair of the six dimensions above.
  //
  // Requirement this fixture MUST satisfy: for every unordered pair (A, B) of
  // dimensions, there is at least one bill in A-not-B, one in B-not-A, and one in
  // A-and-B. Without that, union and intersection collapse onto the same set for
  // that pair (disjoint dimensions) and the law tests pass vacuously — they'd bite
  // on nothing. This is asserted directly below ("fixture actually overlaps...").
  //
  // Construction: for each dimension we seed one "singleton" bill carrying ONLY
  // that dimension's anchor value, and for each unordered PAIR of dimensions we
  // seed one "pairwise" bill carrying BOTH anchor values and no others. That's
  // 6 + 15 = 21 bills. For any pair (A, B): the A-singleton bill is in A-not-B
  // (it carries nothing else), the B-singleton bill is in B-not-A, and the (A,B)
  // pairwise bill is in A-and-B. Every pair is covered by construction, and the
  // singleton/pairwise bills for OTHER dimensions add real background noise (a
  // pairwise bill for (A, C) also carries A, so it's part of A's population for
  // the (A, B) comparison too) rather than an artificially clean 3-bill world.
  //
  // Data is seeded once for the whole suite (beforeAll, not beforeEach): every
  // test below only reads (list/facets), so there's nothing to isolate between
  // them, and reseeding 21 bills per test would multiply run time for no benefit.
  async function seedDimBill(billNumber: string, on: Set<DimKey>, userId: string): Promise<string> {
    const id = await seedBill({
      billNumber,
      title: `Fixture bill ${billNumber}`,
      status: on.has('status') ? 'Passed' : 'Introduced',
      priority: on.has('priority') ? 'high' : 'low',
      session: on.has('session') ? '2026' : '2025',
      tags: on.has('tags') ? ['Clerk'] : [],
    })
    const db = getDb(env.DB)
    if (on.has('subjects')) {
      await db.insert(billSubjects).values({ billId: id, subjectName: 'Elections', state: 'UT' })
    }
    if (on.has('position')) {
      await db.insert(officialPositions).values({
        id: crypto.randomUUID(),
        billId: id,
        position: 'Support',
        setBy: userId,
      })
    }
    return id
  }

  beforeAll(async () => {
    await resetDb()
    await applyMigrations()
    const userId = await seedUser()
    token = await seedSession(userId)

    const db = getDb(env.DB)
    // The tags facet only reports taxonomy members (see loadTaxonomyTagNameSet),
    // so "Clerk" must be registered for the tag dimension to be visible at all.
    await db.insert(associationConfig).values({
      key: 'tag_taxonomy',
      value: JSON.stringify([{ name: 'Clerk' }]),
    })

    for (const k of DIM_KEYS) {
      await seedDimBill(`S-${k}`, new Set([k]), userId)
    }
    for (let i = 0; i < DIM_KEYS.length; i++) {
      for (let j = i + 1; j < DIM_KEYS.length; j++) {
        await seedDimBill(`P-${DIM_KEYS[i]}-${DIM_KEYS[j]}`, new Set([DIM_KEYS[i], DIM_KEYS[j]]), userId)
      }
    }
  })

  async function listBills(query: Record<string, string>) {
    const qs = new URLSearchParams(query).toString()
    const res = await app.request(`/api/bills?${qs}`, { headers: { Cookie: `session=${token}` } }, env)
    return res.json() as Promise<{ bills: Array<{ id: string; billNumber: string }> }>
  }

  async function getFacets(query: Record<string, string>) {
    const qs = new URLSearchParams(query).toString()
    const res = await app.request(`/api/bills/facets?${qs}`, { headers: { Cookie: `session=${token}` } }, env)
    return res.json() as Promise<Record<string, Record<string, number>>>
  }

  // Guards the fixture's own load-bearing shape: if a future edit collapses any
  // pair's overlap (e.g. by making two dimensions' anchor values mutually
  // exclusive), the union/intersection laws for that pair would pass vacuously
  // instead of actually testing anything. This test fails loudly instead.
  it('fixture actually overlaps: every pair has an A-only, a B-only, and a both bill', async () => {
    for (const a of DIMENSIONS) {
      for (const b of DIMENSIONS) {
        if (a.key >= b.key) continue
        const A = ids(await listBills({ [a.param]: a.value }))
        const B = ids(await listBills({ [b.param]: b.value }))
        const aOnly = [...A].filter(x => !B.has(x))
        const bOnly = [...B].filter(x => !A.has(x))
        const both = [...A].filter(x => B.has(x))
        expect(aOnly.length, `expected a bill in ${a.key}-not-${b.key}`).toBeGreaterThan(0)
        expect(bOnly.length, `expected a bill in ${b.key}-not-${a.key}`).toBeGreaterThan(0)
        expect(both.length, `expected a bill in ${a.key}-and-${b.key}`).toBeGreaterThan(0)
      }
    }
  })

  for (const a of DIMENSIONS) {
    for (const b of DIMENSIONS) {
      if (a.key >= b.key) continue

      it(`${a.key} OR ${b.key} is the union`, async () => {
        const A = ids(await listBills({ [a.param]: a.value }))
        const B = ids(await listBills({ [b.param]: b.value }))
        const both = ids(await listBills({ [a.param]: a.value, [b.param]: b.value, match: 'any' }))
        expect([...both].sort()).toEqual([...new Set([...A, ...B])].sort())
      })

      it(`${a.key} AND ${b.key} is the intersection`, async () => {
        const A = ids(await listBills({ [a.param]: a.value }))
        const B = ids(await listBills({ [b.param]: b.value }))
        const both = ids(await listBills({ [a.param]: a.value, [b.param]: b.value }))
        expect([...both].sort()).toEqual([...A].filter(x => B.has(x)).sort())
      })
    }
  }

  // The presentational law — this is what a user actually checks by clicking.
  for (const mode of [{}, { match: 'any' }] as const) {
    for (const d of DIMENSIONS) {
      it(`a ${d.key} facet count equals the total after picking it (${'match' in mode ? 'OR' : 'AND'})`, async () => {
        const anchor = { status: 'Passed', ...mode }
        const promised = (await getFacets(anchor))[d.key]?.[d.value]
        // Must be present: the fixture guarantees every dimension's anchor
        // value overlaps with `status=Passed` (see the fixture-overlap test
        // above), so this facet key existing is not optional. Swallowing an
        // `undefined` here would silently pass over exactly the failure mode
        // this suite exists to catch — a facet WHERE that wrongly retains its
        // own dimension's filter makes the *other* values disappear from the
        // map, which shows up as this key going missing.
        expect(promised, `expected a facet count for ${d.key}=${d.value}`).toBeDefined()
        const actual = (await listBills({ ...anchor, [d.param]: d.value })).bills.length
        expect(actual).toBe(promised)
      })
    }
  }
})
