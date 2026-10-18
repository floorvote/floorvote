import { describe, it, expect, beforeAll } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { eq, inArray } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { clearBillStatesCache } from '../../src/lib/billStates'
import {
  associationConfig, billCustomFieldValues, billSubjects, bills, customFieldDefinitions, memberVotes, notes, officialPositions,
} from '../../src/db/schema'

// The harness of the group-aware facet tests (#380): requests against the list and the facets, and the
// random-fixture suite that checks every facet count against the list. Each random fixture runs in a file of
// its own, since the Workers test pool slows with the number of requests a file has made.

export type Counts = Record<string, number>
export type Facets = {
  status: Counts; stage: Counts; session: Counts; year: Counts; state: Counts
  priority: Counts; position: Counts; tags: Counts; subjects: Counts
  customFields: Record<string, Counts>
  myBillsCount: number; newMatchesCount: number; unvotedCount: number; draftCount: number
  // Unfiltered, per bill (#528): the states with subjects, and on * coverage the states with bills.
  subjectStates: string[]; billStates?: string[]
  // Whether the tenant has any draft, unfiltered.
  hasDrafts: boolean
}

let cookie: string
export let ada: string
export const db = () => getDb(env.DB)

export async function facets(qs = ''): Promise<Facets> {
  const res = await SELF.fetch(`https://x/api/bills/facets?${qs}`, { headers: { Cookie: cookie } })
  expect(res.status).toBe(200)
  return await res.json() as Facets
}
export async function total(qs = ''): Promise<number> {
  const res = await SELF.fetch(`https://x/api/bills?pageSize=200&${qs}`, { headers: { Cookie: cookie } })
  expect(res.status).toBe(200)
  return ((await res.json()) as { pagination: { total: number } }).pagination.total
}
// Groups bills by writing the key the way a recompute does: the smallest member id.
export async function group(...ids: string[]) {
  await db().update(bills).set({ groupKey: [...ids].sort()[0] }).where(inArray(bills.id, ids))
}
export async function reset() {
  await resetDb()
  // The states-with-bills list is cached per tenant across requests; the database it read is gone.
  clearBillStatesCache()
  await applyMigrations()
  ada = await seedUser({ name: 'ada', email: 'ada@example.com', role: 'admin' })
  cookie = `session=${await seedSession(ada)}`
  await db().insert(associationConfig).values({ key: 'tag_taxonomy', value: JSON.stringify([{ name: 'Energy' }, { name: 'Labor' }]) })
}

const STATUSES = [['Introduced', 'introduced', 100], ['Passed', 'passed', 300], ['Failed', 'failed', 200]] as const
const TIMES = ['2026-01-01 00:00:00', '2026-01-02 00:00:00', '2026-01-03 00:00:00', '2026-01-04 00:00:00']
const GROUPS = [[0, 1], [2, 3], [4, 5, 6], [7, 8], [9, 10], [11, 12, 13], [14, 15], [16, 17], [18, 19], [20, 21]]
const COUNT = 34

// [the anchor's query, the dimensions it filters, whose own counts it narrows under AND]
const AND_ANCHORS: Array<[string, string[]]> = [
  ['', []], ['status=Passed', ['status']], ['priority=high', ['priority']], ['tag=Energy', ['tag']], ['position=Support', ['position']],
  ['cf_cf2=x', ['cf_cf2']], ['subject=NJ:Elections', ['subject']], ['minRelevance=4', []],
  ['unvoted=1', []], ['newMatches=1', []], ['myBills=1', []],
  ['priority=none', ['priority']], ['position=none', ['position']], ['priority=__any__&status=Introduced', ['priority', 'status']],
]
// The same, for the provider facts that were never the active filter (state, stage, year, session) and for drafts: each is
// a dimension with a facet of its own, so each must leave itself out of its own count and no other's. Drafts is a scope,
// which narrows every count. They run in files of their own (groupFacetsRandom4, 5): a file slows with the number of
// requests it has made, and these anchors would carry the others' past their time limit on a busy machine.
const PROVIDER_AND_ANCHORS: Array<[string, string[]]> = [
  ['state=NJ', ['state']], ['stage=passed', ['stage']], ['year=2026', ['year']], ['session=2025', ['session']], ['drafts=1', []],
  ['year=2026&session=2025', ['year', 'session']], ['state=TX&stage=introduced', ['state', 'stage']], ['drafts=1&status=Passed', ['status']],
]
const PROVIDER_OR_ANCHORS = [
  'state=NJ', 'stage=passed', 'year=2026', 'session=2025', 'drafts=1', 'year=2025&session=2026', 'state=TX&stage=introduced&year=2026',
  'drafts=1&priority=high', 'session=2025&status=Passed',
]
const OR_ANCHORS = [
  'status=Passed', 'priority=high', 'tag=Energy', 'position=Support', 'cf_cf1=Labor', 'subject=NJ:Elections',
  'status=Passed&priority=high', 'status=Introduced&tag=Labor&position=Oppose', 'priority=none&state=TX',
  'status=Passed&unvoted=1', 'priority=high&newMatches=1', 'tag=Energy&myBills=1', 'position=none&cf_cf1=__any__',
]

/**
 * Every count, of every dimension, is the list total after picking it. The fixture is random groups of two
 * to three bills among solos, with every team field set on random bills at random times, so groups hold
 * stale values, ties, and a value on one bill that the group's others never had. It is built once for the
 * tests, which only read.
 */
export function randomFixtureSuite(seed: number, modes: Array<'AND' | 'OR'> = ['AND', 'OR'], anchors: 'core' | 'provider' = 'core') {
  const andAnchors = anchors === 'core' ? AND_ANCHORS : PROVIDER_AND_ANCHORS
  const orAnchors = anchors === 'core' ? OR_ANCHORS : PROVIDER_OR_ANCHORS
  describe(`every count matches the list on a random fixture (seed ${seed})`, () => {
    beforeAll(async () => {
      await reset()
      let s = seed * 7919
      const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296 }
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]
      await db().insert(customFieldDefinitions).values([
        { id: 'cf1', name: 'Committee', slug: 'committee', type: 'dropdown', options: JSON.stringify(['Energy', 'Labor']), multiple: false },
        { id: 'cf2', name: 'Areas', slug: 'areas', type: 'dropdown', options: JSON.stringify(['x', 'y', 'z']), multiple: true },
      ])
      const id = (i: number) => `b${String(i).padStart(2, '0')}`
      for (let i = 0; i < COUNT; i++) {
        const [status, stage, rank] = pick(STATUSES)
        const tags = ['Energy', 'Labor'].filter(() => rnd() < 0.4)
        const state = pick(['NJ', 'TX'])
        await seedBill({
          id: id(i), billNumber: `HB ${i + 1}`, status, statusStage: stage, statusRank: rank, state,
          session: pick(['2025', '2026']), yearStart: pick([2025, 2026]),
          priority: rnd() < 0.5 ? pick(['high', 'medium', 'low'] as const) : null,
          tags, aiProcessedAt: tags.length > 0 || rnd() < 0.2 ? pick(TIMES) : undefined,
          relevanceScore: Math.floor(rnd() * 10),
          newMatchAt: rnd() < 0.4 ? pick(TIMES) : null,
          triagedAt: rnd() < 0.1 ? pick(TIMES) : null,
          isDraft: rnd() < 0.1,
        })
        const set = await db().select({ p: bills.priority }).from(bills).where(eq(bills.id, id(i)))
        if (set[0].p) await db().update(bills).set({ prioritySetAt: rnd() < 0.15 ? null : pick(TIMES) }).where(eq(bills.id, id(i)))
        if (rnd() < 0.4) await db().insert(officialPositions).values({ id: `p${i}`, billId: id(i), position: pick(['Support', 'Oppose']), setBy: ada, updatedAt: pick(TIMES) })
        if (rnd() < 0.4) await db().insert(billCustomFieldValues).values({ billId: id(i), fieldId: 'cf1', value: pick(['Energy', 'Labor']), setBy: ada, updatedAt: pick(TIMES) })
        if (rnd() < 0.4) await db().insert(billCustomFieldValues).values({ billId: id(i), fieldId: 'cf2', value: JSON.stringify(['x', 'y', 'z'].filter(() => rnd() < 0.5)), setBy: ada, updatedAt: pick(TIMES) })
        for (const name of ['Elections', 'Energy']) if (rnd() < 0.3) await db().insert(billSubjects).values({ billId: id(i), subjectName: name, state })
        if (rnd() < 0.2) await db().insert(memberVotes).values({ id: `v${i}`, userId: ada, billId: id(i), position: 'support' })
        if (rnd() < 0.15) await db().insert(notes).values({ id: `n${i}`, billId: id(i), userId: ada, content: 'note' })
      }
      for (const g of GROUPS) await group(...g.map(id))
    })

    // The facet values (as the list takes them in its URL) of every dimension but `skip`, and each one's promised count.
    function promises(f: Facets, skip: string[]): Array<[string, string, number]> {
      const out: Array<[string, string, number]> = []
      const add = (param: string, counts: Counts) => { for (const [v, n] of Object.entries(counts)) out.push([param, v, n]) }
      if (!skip.includes('status')) add('status', f.status)
      if (!skip.includes('stage')) add('stage', f.stage)
      if (!skip.includes('year')) add('year', f.year)
      if (!skip.includes('session')) add('session', f.session)
      if (!skip.includes('state')) add('state', f.state)
      if (!skip.includes('priority')) add('priority', f.priority)
      if (!skip.includes('position')) add('position', f.position)
      if (!skip.includes('tag')) add('tag', f.tags)
      if (!skip.includes('subject')) add('subject', f.subjects)
      for (const [fieldId, counts] of Object.entries(f.customFields)) if (!skip.includes(`cf_${fieldId}`)) add(`cf_${fieldId}`, counts)
      return out
    }

    // The facet counts of a query against the list total, for every value of the dimensions `skip` leaves
    // out, and the four counts beside them against the list with each scope added.
    async function expectCountsMatch(qs: string, skip: string[]) {
      const f = await facets(qs)
      const sep = qs ? '&' : ''
      const checks: Array<[string, string, number]> = [
        ...promises(f, skip).map(([param, value, n]): [string, string, number] => [`${qs} then ${param}=${value}`, `${param}=${encodeURIComponent(value)}`, n]),
        [`${qs} my bills`, 'myBills=1', f.myBillsCount],
        [`${qs} unvoted`, 'unvoted=1', f.unvotedCount],
        [`${qs} new matches`, 'newMatches=1', f.newMatchesCount],
        [`${qs} drafts`, 'drafts=1', f.draftCount],
      ]
      const actual = await Promise.all(checks.map(([, add]) => total(`${qs}${sep}${add}`)))
      checks.forEach(([label, , promised], i) => expect(actual[i], label).toBe(promised))
    }

    for (const [qs, skip] of modes.includes('AND') ? andAnchors : []) {
      it(`AND: ${qs || 'no filter'}`, async () => { await expectCountsMatch(qs, skip) })
    }
    for (const qs of modes.includes('OR') ? orAnchors : []) {
      it(`OR: ${qs}`, async () => { await expectCountsMatch(`${qs}&match=any`, []) })
    }
  })
}
