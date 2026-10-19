import { describe, it, expect, beforeAll } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { app } from '../../src/index'
import { inArray } from 'drizzle-orm'
import {
  billSubjects, officialPositions, associationConfig, bills, customFieldDefinitions, billCustomFieldValues, memberVotes, notes,
} from '../../src/db/schema'

// Every filter that is a bill fact, the ones the group operator joins: status, stage, year, session, state, position,
// priority, tag, subject, a custom field, and a minimum relevance. Search, my bills, unvoted, new matches, and drafts are
// scopes (see composeFilter in query.ts): they ALWAYS narrow, so the OR/AND laws would be false for them on purpose.
// Their facet counts, the four counts beside the facets, are checked against the list below ("the toggles").
// A minimum relevance has no facet, so the facet law skips it. Its OR/AND behavior is checked by the pairwise sweep.
type Facets = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const DIMENSIONS: Array<{ key: string; param: string; value: string; promised?: (f: Facets) => number | undefined }> = [
  { key: 'status',    param: 'status',    value: 'Passed',        promised: f => f.status?.Passed },
  { key: 'stage',     param: 'stage',     value: 'passed',        promised: f => f.stage?.passed },
  { key: 'year',      param: 'year',      value: '2026',          promised: f => f.year?.['2026'] },
  { key: 'session',   param: 'sessionName', value: '2026',          promised: f => f.sessionName?.['2026'] },
  { key: 'state',     param: 'state',     value: 'NJ',            promised: f => f.state?.NJ },
  { key: 'priority',  param: 'priority',  value: 'high',          promised: f => f.priority?.high },
  { key: 'tags',      param: 'tag',       value: 'Clerk',         promised: f => f.tag?.Clerk },
  { key: 'subjects',  param: 'subject',   value: 'UT:Elections',  promised: f => f.subject?.['UT:Elections'] },
  { key: 'position',  param: 'position',  value: 'Support',       promised: f => f.position?.Support },
  { key: 'field',     param: 'field.area',   value: 'North',         promised: f => f.field?.['cf-area']?.North },
  { key: 'relevance', param: 'minRelevance', value: '5' },
]

// The four counts beside the facets: each is the list's total with the scope added.
const TOGGLES: Array<{ key: string; param: string; count: string }> = [
  { key: 'myBills',    param: 'myBills',    count: 'myBillsCount' },
  { key: 'unvoted',    param: 'unvoted',    count: 'unvotedCount' },
  { key: 'newMatches', param: 'newMatches', count: 'newMatchesCount' },
  { key: 'drafts',     param: 'drafts',     count: 'draftCount' },
]

type DimKey = typeof DIMENSIONS[number]['key']
const DIM_KEYS = DIMENSIONS.map(d => d.key) as DimKey[]

const ids = (r: { bills: Array<{ id: string }> }) => new Set(r.bills.map(b => b.id))

// Status and stage are ONE bill fact (#677): a bill matches when its status is chosen OR its stage is. So the pair is
// not two facts the group operator joins: picked together they are the union under AND as well as OR, and neither
// one's facet count promises the total after picking the other. Each is checked against every other dimension as usual.
const SAME_FACT = new Set(['status', 'stage'])
const oneFact = (a: { key: string }, b: { key: string }) => SAME_FACT.has(a.key) && SAME_FACT.has(b.key)

// Run once on single bills, then again with every bill given an identical companion (#380): the two share
// their provider facts and the team's values are stored on the original only, so the group reads them
// through it. A group is then in a filter's result exactly when its original bill is, and the laws, and the
// facets' counts of groups, must hold for groups as they do for bills.
for (const grouped of [false, true]) describe(`filter algebra${grouped ? ' on companion groups' : ''}`, () => {
  let token: string

  // Seed a fixture with deliberate cross-dimension overlap, then assert the laws
  // hold for EVERY pair of the dimensions above.
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
  // 11 + 55 = 66 bills. For any pair (A, B): the A-singleton bill is in A-not-B
  // (it carries nothing else), the B-singleton bill is in B-not-A, and the (A,B)
  // pairwise bill is in A-and-B. Every pair is covered by construction, and the
  // singleton/pairwise bills for OTHER dimensions add real background noise (a
  // pairwise bill for (A, C) also carries A, so it's part of A's population for
  // the (A, B) comparison too) rather than an artificially clean 3-bill world.
  //
  // Data is seeded once for the whole suite (beforeAll, not beforeEach): every
  // test below only reads (list/facets), so there's nothing to isolate between
  // them, and reseeding 66 bills per test would multiply run time for no benefit.
  let seeded = 0
  async function seedDimBill(billNumber: string, on: Set<DimKey>, userId: string): Promise<string> {
    const n = seeded++
    // The toggles' fixture: each is on for a share of the bills, spread so that the counts beside the facets are not
    // zero under the anchor the presentational law uses.
    const provider = {
      status: on.has('status') ? 'Passed' : 'Introduced',
      statusStage: on.has('stage') ? 'passed' : 'introduced',
      state: on.has('state') ? 'NJ' : 'TX',
      session: on.has('session') ? '2026' : '2025',
      yearStart: on.has('year') ? 2026 : 2025,
      relevanceScore: on.has('relevance') ? 8 : 1,
    }
    const id = await seedBill({
      billNumber,
      title: `Fixture bill ${billNumber}`,
      ...provider,
      priority: on.has('priority') ? 'high' : 'low',
      tags: on.has('tags') ? ['Clerk'] : [],
      isDraft: n % 4 === 1,
      newMatchAt: n % 5 === 0 ? null : '2026-01-01 00:00:00',
    })
    const db = getDb(env.DB)
    await db.insert(billCustomFieldValues).values({ billId: id, fieldId: 'cf-area', value: on.has('field') ? 'North' : 'South', setBy: userId })
    if (n % 3 === 0) await db.insert(memberVotes).values({ id: `v${n}`, userId, billId: id, position: 'support' })
    if (n % 7 === 0) await db.insert(notes).values({ id: `n${n}`, billId: id, userId, content: 'note' })
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
    if (grouped) {
      const twin = await seedBill({
        billNumber: `${billNumber}-twin`,
        title: `Fixture companion ${billNumber}`,
        ...provider,
      })
      if (on.has('subjects')) await db.insert(billSubjects).values({ billId: twin, subjectName: 'Elections', state: 'UT' })
      await db.update(bills).set({ groupKey: [id, twin].sort()[0] }).where(inArray(bills.id, [id, twin]))
    }
    return id
  }

  beforeAll(async () => {
    await resetDb()
    await applyMigrations()
    const userId = await seedUser({ role: 'admin' })
    token = await seedSession(userId)

    const db = getDb(env.DB)
    await db.insert(customFieldDefinitions).values({
      id: 'cf-area', name: 'Area', slug: 'area', type: 'dropdown', options: JSON.stringify(['North', 'South']), multiple: false,
    })
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
    const qs = new URLSearchParams({ pageSize: '200', ...query }).toString()
    const res = await app.request(`/api/bills?${qs}`, { headers: { Cookie: `session=${token}` } }, env)
    return res.json() as Promise<{ bills: Array<{ id: string; billNumber: string }>; pagination: { total: number } }>
  }

  async function getFacets(query: Record<string, string>) {
    const qs = new URLSearchParams(query).toString()
    const res = await app.request(`/api/bills/facets?${qs}`, { headers: { Cookie: `session=${token}` } }, env)
    return res.json() as Promise<Facets>
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

      if (oneFact(a, b)) {
        it(`${a.key} AND ${b.key} is the union, since they are one fact`, async () => {
          const A = ids(await listBills({ [a.param]: a.value }))
          const B = ids(await listBills({ [b.param]: b.value }))
          const both = ids(await listBills({ [a.param]: a.value, [b.param]: b.value }))
          expect([...both].sort()).toEqual([...new Set([...A, ...B])].sort())
          // The union is wider than either, or the fixture proves nothing about OR.
          expect(both.size).toBeGreaterThan(Math.max(A.size, B.size))
        })
        continue
      }

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
      if (!d.promised) continue
      it(`a ${d.key} facet count equals the total after picking it (${'match' in mode ? 'OR' : 'AND'})`, async () => {
        // Stage is part of the status fact, so beside a status its count is not the total after picking it: another anchor.
        const anchor = d.key === 'stage' ? { year: '2026', ...mode } : { status: 'Passed', ...mode }
        const promised = d.promised!(await getFacets(anchor))
        // Must be present: the fixture guarantees every dimension's anchor
        // value overlaps with `status=Passed` (see the fixture-overlap test
        // above), so this facet key existing is not optional. Swallowing an
        // `undefined` here would silently pass over exactly the failure mode
        // this suite exists to catch — a facet WHERE that wrongly retains its
        // own dimension's filter makes the *other* values disappear from the
        // map, which shows up as this key going missing.
        expect(promised, `expected a facet count for ${d.key}=${d.value}`).toBeDefined()
        const actual = (await listBills({ ...anchor, [d.param]: d.value })).pagination.total
        expect(actual).toBe(promised)
      })

      // The same law with another dimension as the active filter, so each facet is counted beside every other filter.
      for (const other of DIMENSIONS) {
        if (other.key === d.key || oneFact(d, other)) continue
        it(`a ${d.key} facet count equals the total after picking it, beside ${other.key} (${'match' in mode ? 'OR' : 'AND'})`, async () => {
          const anchor = { [other.param]: other.value, ...mode }
          const promised = d.promised!(await getFacets(anchor))
          expect(promised, `expected a facet count for ${d.key}=${d.value}`).toBeDefined()
          const actual = (await listBills({ ...anchor, [d.param]: d.value })).pagination.total
          expect(actual).toBe(promised)
        })
      }
    }

    // The toggles' counts are of the current result, within the filter the list shows, not of a value picked.
    for (const t of TOGGLES) {
      it(`the ${t.key} count equals the total with it on (${'match' in mode ? 'OR' : 'AND'})`, async () => {
        const anchor = { status: 'Passed', ...mode }
        const promised = (await getFacets(anchor))[t.count]
        expect(promised, `expected a ${t.count}`).toBeGreaterThan(0)
        const actual = (await listBills({ ...anchor, [t.param]: '1' })).pagination.total
        expect(actual).toBe(promised)
      })
    }
  }

  // Choosing one of the pair leaves the other's own counts alone: the fact is left out of both counts.
  for (const [chosen, other] of [['status', 'stage'], ['stage', 'status']] as const) {
    it(`choosing a ${chosen} leaves the ${other} counts as they were with nothing chosen`, async () => {
      const d = (k: string) => DIMENSIONS.find(x => x.key === k)!
      const before = await getFacets({})
      const after = await getFacets({ [d(chosen).param]: d(chosen).value })
      expect(after[other]).toEqual(before[other])
      expect(after[chosen]).toEqual(before[chosen])
    })
  }

  it('lists every status with bills in statusGroups, with the stage the bills of the label carry', async () => {
    const f = await getFacets({})
    // The fixture's Passed bills sit in both stages, so the label takes whichever holds more of them.
    expect(['passed', 'introduced']).toContain(f.statusGroups?.Passed?.stage)
    expect(f.statusGroups?.Passed?.rank).toEqual(expect.any(Number))
    expect(Object.keys(f.statusGroups ?? {}).sort()).toEqual(Object.keys(f.status).sort())
  })
})
