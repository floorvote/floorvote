import { describe, it, expect, beforeAll } from 'vitest'
import { env } from 'cloudflare:test'
import { eq, sql } from 'drizzle-orm'
import { resetDb, applyMigrations, appFetch, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import {
  associationConfig, billCustomFieldValues, billSubjects, bills, customFieldDefinitions, memberVotes, notes, officialPositions,
} from '../../src/db/schema'
import { MAX_SUBJECT_FILTERS } from '../../src/lib/billSubjects'

// One bill filter, five routes: the list (GET /bills), the facets (GET /bills/facets), and the three bulk routes
// (POST /bulk, POST /bulk-dismiss, GET /bulk-values). Each reads a filter given as a query string or, for the two
// POSTs, as a JSON body, and all of them select the same bills. Every case below is a filter, spelled both ways,
// with the bills it keeps named, so a route that dropped, renamed, or misread one filter fails on its own.

//  HB 1  NJ  Passed      enacted     S26  2026  high    rel 9  Energy        Support  Labor, [x y]  NJ:Elections  voted
//  HB 2  NJ  Introduced  introduced  S26  2026  low     rel 3  Labor         Oppose   Energy        NJ:Energy     noted
//  HB 3  TX  Failed      failed      S25  2025  -       rel 6  -             -        -             TX:Elections
//  HB 4  TX  Passed      enacted     S25  2025  medium  rel 1  Energy, Labor Support  [y]           -             draft
//  HB 5  UT  Introduced  introduced  S26  2026  -       rel 8  -             -        Labor         UT:Elections  voted, noted
//  HB 6  UT  Failed      failed      S26  2026  high    rel 4  -             Oppose   -             -
// The viewer (an admin) has voted on HB 1 and HB 5 and noted HB 2 and HB 5. Every bill is an untriaged keyword match.

type Case = { name: string; qs: string; body: Record<string, unknown>; expected: string[] }
const ALL = ['HB 1', 'HB 2', 'HB 3', 'HB 4', 'HB 5', 'HB 6']
const FIELD_ID = 'f-committee'
const FIELD_SLUG = 'committee'
const AREAS_ID = 'f-areas'
const AREAS_SLUG = 'areas'

const CASES: Case[] = [
  { name: 'no filter', qs: '', body: {}, expected: ALL },
  { name: 'status', qs: 'status=Passed', body: { status: ['Passed'] }, expected: ['HB 1', 'HB 4'] },
  { name: 'two statuses', qs: 'status=Passed&status=Failed', body: { status: ['Passed', 'Failed'] }, expected: ['HB 1', 'HB 3', 'HB 4', 'HB 6'] },
  { name: 'stage', qs: 'stage=enacted', body: { stage: ['enacted'] }, expected: ['HB 1', 'HB 4'] },
  { name: 'year', qs: 'year=2025', body: { year: ['2025'] }, expected: ['HB 3', 'HB 4'] },
  { name: 'session', qs: 'session=S26', body: { session: ['S26'] }, expected: ['HB 1', 'HB 2', 'HB 5', 'HB 6'] },
  { name: 'state', qs: 'state=UT', body: { state: ['UT'] }, expected: ['HB 5', 'HB 6'] },
  { name: 'two states', qs: 'state=NJ&state=TX', body: { state: ['NJ', 'TX'] }, expected: ['HB 1', 'HB 2', 'HB 3', 'HB 4'] },
  { name: 'position', qs: 'position=Support', body: { position: ['Support'] }, expected: ['HB 1', 'HB 4'] },
  { name: 'position none', qs: 'position=none', body: { position: ['none'] }, expected: ['HB 3', 'HB 5'] },
  { name: 'position any', qs: 'position=__any__', body: { position: ['__any__'] }, expected: ['HB 1', 'HB 2', 'HB 4', 'HB 6'] },
  { name: 'priority', qs: 'priority=high', body: { priority: ['high'] }, expected: ['HB 1', 'HB 6'] },
  { name: 'priority none', qs: 'priority=none', body: { priority: ['none'] }, expected: ['HB 3', 'HB 5'] },
  { name: 'priority any', qs: 'priority=__any__', body: { priority: ['__any__'] }, expected: ['HB 1', 'HB 2', 'HB 4', 'HB 6'] },
  { name: 'tag', qs: 'tag=Energy', body: { tag: ['Energy'] }, expected: ['HB 1', 'HB 4'] },
  { name: 'any tag', qs: 'tag=__any__', body: { tag: ['__any__'] }, expected: ['HB 1', 'HB 2', 'HB 4'] },
  { name: 'subjects', qs: 'subject=NJ:Elections&subject=UT:Elections', body: { subject: ['NJ:Elections', 'UT:Elections'] }, expected: ['HB 1', 'HB 5'] },
  { name: 'min relevance', qs: 'minRelevance=6', body: { minRelevance: '6' }, expected: ['HB 1', 'HB 3', 'HB 5'] },
  { name: 'min relevance of zero', qs: 'minRelevance=0', body: { minRelevance: '0' }, expected: ALL },
  { name: 'search', qs: 'q=ballot', body: { q: 'ballot' }, expected: ['HB 3', 'HB 5'] },
  { name: 'search with two terms', qs: 'q=energy+draft', body: { q: 'energy draft' }, expected: ['HB 4'] },
  { name: 'search with alternatives', qs: 'q=zoning,voter', body: { q: 'zoning,voter' }, expected: ['HB 1', 'HB 6'] },
  { name: 'my bills', qs: 'myBills=1', body: { myBills: '1' }, expected: ['HB 1', 'HB 2', 'HB 5'] },
  { name: 'my bills as true', qs: 'myBills=true', body: { myBills: true }, expected: ['HB 1', 'HB 2', 'HB 5'] },
  { name: 'unvoted', qs: 'unvoted=1', body: { unvoted: '1' }, expected: ['HB 2', 'HB 3', 'HB 4', 'HB 6'] },
  { name: 'unvoted as true', qs: 'unvoted=true', body: { unvoted: true }, expected: ['HB 2', 'HB 3', 'HB 4', 'HB 6'] },
  { name: 'new matches', qs: 'newMatches=1', body: { newMatches: '1' }, expected: ALL },
  { name: 'drafts', qs: 'drafts=1', body: { drafts: '1' }, expected: ['HB 4'] },
  { name: 'drafts as true', qs: 'drafts=true', body: { drafts: true }, expected: ['HB 4'] },
  { name: 'a custom field by slug', qs: `cf_${FIELD_SLUG}=Labor`, body: { cf: { [FIELD_SLUG]: ['Labor'] } }, expected: ['HB 1', 'HB 5'] },
  { name: 'a custom field by id', qs: `cf_${FIELD_ID}=Labor`, body: { cf: { [FIELD_ID]: ['Labor'] } }, expected: ['HB 1', 'HB 5'] },
  { name: 'a custom field by id and by slug together', qs: `cf_${FIELD_ID}=Labor&cf_${FIELD_SLUG}=Energy`, body: { cf: { [FIELD_ID]: ['Labor'], [FIELD_SLUG]: ['Energy'] } }, expected: ['HB 1', 'HB 2', 'HB 5'] },
  { name: 'a custom field with any value', qs: `cf_${FIELD_SLUG}=__any__`, body: { cf: { [FIELD_SLUG]: ['__any__'] } }, expected: ['HB 1', 'HB 2', 'HB 5'] },
  { name: 'a multi-select custom field', qs: `cf_${AREAS_SLUG}=y`, body: { cf: { [AREAS_SLUG]: ['y'] } }, expected: ['HB 1', 'HB 4'] },
  { name: 'a custom field that names no field', qs: 'cf_no-such-field=x', body: { cf: { 'no-such-field': ['x'] } }, expected: [] },
  { name: 'two filters', qs: 'state=NJ&priority=high', body: { state: ['NJ'], priority: ['high'] }, expected: ['HB 1'] },
  { name: 'two filters under match=any', qs: 'state=UT&priority=low&match=any', body: { state: ['UT'], priority: ['low'], match: 'any' }, expected: ['HB 2', 'HB 5', 'HB 6'] },
  { name: 'match=any with a scope', qs: 'state=UT&priority=low&match=any&unvoted=1', body: { state: ['UT'], priority: ['low'], match: 'any', unvoted: '1' }, expected: ['HB 2', 'HB 6'] },
  {
    name: 'every filter at once',
    qs: 'status=Passed&stage=enacted&priority=high&position=Support&session=S26&year=2026&state=NJ&tag=Energy&subject=NJ:Elections&q=voter&minRelevance=5'
      + `&myBills=1&unvoted=0&newMatches=1&drafts=0&cf_${FIELD_SLUG}=Labor&cf_${AREAS_ID}=x`,
    body: {
      status: ['Passed'], stage: ['enacted'], priority: ['high'], position: ['Support'], session: ['S26'], year: ['2026'], state: ['NJ'],
      tag: ['Energy'], subject: ['NJ:Elections'], q: 'voter', minRelevance: '5', myBills: '1', unvoted: '0', newMatches: '1', drafts: '0',
      cf: { [FIELD_SLUG]: ['Labor'], [AREAS_ID]: ['x'] },
    },
    expected: ['HB 1'],
  },
]

describe('every route reads one bill filter the same way', () => {
  let token: string
  let ada: string
  const numberOf = new Map<string, string>()

  const get = (path: string) => appFetch(`http://localhost/api${path}`, { headers: { Cookie: `session=${token}` } })
  const post = (path: string, body: object) => appFetch(`http://localhost/api/bills${path}`, {
    method: 'POST', headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const numbers = (ids: string[]) => ids.map(id => numberOf.get(id)!).sort()

  const onList = async (qs: string): Promise<{ numbers: string[]; total: number }> => {
    const res = await get(`/bills?pageSize=200&${qs}`)
    expect(res.status).toBe(200)
    const body = await res.json() as { bills: Array<{ billNumber: string }>; pagination: { total: number } }
    return { numbers: body.bills.map(b => b.billNumber).sort(), total: body.pagination.total }
  }
  // POST /bulk marks the bills it selects, with a field no filter above reads.
  const onBulk = async (filter: object): Promise<string[]> => {
    const db = getDb(env.DB)
    const res = await post('/bulk', { filter, customFields: [{ fieldId: 'f-mark', value: '1' }] })
    expect(res.status).toBe(200)
    const marked = await db.select().from(billCustomFieldValues).where(eq(billCustomFieldValues.fieldId, 'f-mark')).all()
    await db.delete(billCustomFieldValues).where(eq(billCustomFieldValues.fieldId, 'f-mark'))
    expect(marked.length).toBe(((await res.json()) as { updated: number }).updated)
    return numbers(marked.map(m => m.billId))
  }

  beforeAll(async () => {
    await resetDb()
    await applyMigrations()
    ada = await seedUser({ role: 'admin', email: 'ada@example.com' })
    token = await seedSession(ada)
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'tag_taxonomy', value: JSON.stringify([{ name: 'Energy' }, { name: 'Labor' }]) })
    await db.insert(customFieldDefinitions).values([
      { id: FIELD_ID, name: 'Committee', slug: FIELD_SLUG, type: 'dropdown', options: JSON.stringify(['Energy', 'Labor']), multiple: false },
      { id: AREAS_ID, name: 'Areas', slug: AREAS_SLUG, type: 'dropdown', options: JSON.stringify(['x', 'y', 'z']), multiple: true },
      { id: 'f-mark', name: 'Mark', slug: 'mark', type: 'binary', multiple: false },
    ])
    const T = '2026-01-01 00:00:00'
    const make = async (n: number, o: Parameters<typeof seedBill>[0]) => {
      const id = await seedBill({ billNumber: `HB ${n}`, matchType: 'keyword', newMatchAt: T, ...o })
      numberOf.set(id, `HB ${n}`)
      return id
    }
    const b1 = await make(1, { title: 'Voter ID rules', state: 'NJ', status: 'Passed', statusStage: 'enacted', session: 'S26', yearStart: 2026, priority: 'high', relevanceScore: 9, tags: ['Energy'], aiProcessedAt: T })
    const b2 = await make(2, { title: 'Energy storage', state: 'NJ', status: 'Introduced', statusStage: 'introduced', session: 'S26', yearStart: 2026, priority: 'low', relevanceScore: 3, tags: ['Labor'], aiProcessedAt: T })
    const b3 = await make(3, { title: 'Ballot access', state: 'TX', status: 'Failed', statusStage: 'failed', session: 'S25', yearStart: 2025, relevanceScore: 6 })
    const b4 = await make(4, { title: 'Draft energy bill', state: 'TX', status: 'Passed', statusStage: 'enacted', session: 'S25', yearStart: 2025, priority: 'medium', relevanceScore: 1, tags: ['Energy', 'Labor'], aiProcessedAt: T, isDraft: true })
    const b5 = await make(5, { title: 'Ballot rules', state: 'UT', status: 'Introduced', statusStage: 'introduced', session: 'S26', yearStart: 2026, relevanceScore: 8 })
    const b6 = await make(6, { title: 'Zoning', state: 'UT', status: 'Failed', statusStage: 'failed', session: 'S26', yearStart: 2026, priority: 'high', relevanceScore: 4 })
    for (const id of [b1, b2, b4, b6]) {
      await db.update(bills).set({ prioritySetAt: T }).where(eq(bills.id, id))
    }
    const pos = (id: string, position: string) => db.insert(officialPositions).values({ id: `p-${id}`, billId: id, position, setBy: ada, updatedAt: T })
    await pos(b1, 'Support'); await pos(b2, 'Oppose'); await pos(b4, 'Support'); await pos(b6, 'Oppose')
    const val = (billId: string, fieldId: string, value: string) => db.insert(billCustomFieldValues).values({ billId, fieldId, value, setBy: ada, updatedAt: T })
    await val(b1, FIELD_ID, 'Labor'); await val(b2, FIELD_ID, 'Energy'); await val(b5, FIELD_ID, 'Labor')
    await val(b1, AREAS_ID, JSON.stringify(['x', 'y'])); await val(b4, AREAS_ID, JSON.stringify(['y']))
    await db.insert(billSubjects).values([
      { billId: b1, subjectName: 'Elections', state: 'NJ' }, { billId: b2, subjectName: 'Energy', state: 'NJ' },
      { billId: b3, subjectName: 'Elections', state: 'TX' }, { billId: b5, subjectName: 'Elections', state: 'UT' },
    ])
    await db.insert(memberVotes).values([
      { id: 'v1', userId: ada, billId: b1, position: 'support' }, { id: 'v5', userId: ada, billId: b5, position: 'oppose' },
    ])
    await db.insert(notes).values([
      { id: 'n2', billId: b2, userId: ada, content: 'a note' }, { id: 'n5', billId: b5, userId: ada, content: 'a note' },
    ])
  })

  describe.each(CASES)('$name', ({ qs, body, expected }) => {
    it('keeps the bills it names on the list', async () => {
      const list = await onList(qs)
      expect(list.numbers).toEqual(expected)
      expect(list.total).toBe(expected.length)
    })

    it('counts the same groups on GET /bills/bulk-values, which takes the query string', async () => {
      const res = await get(`/bills/bulk-values?${qs}`)
      expect(res.status).toBe(200)
      expect(((await res.json()) as { count: number }).count).toBe(expected.length)
    })

    it('selects the same bills on POST /bills/bulk, which takes the JSON body', async () => {
      expect(await onBulk(body)).toEqual(expected)
    })

    it('answers the facets with the filter on', async () => {
      const res = await get(`/bills/facets?${qs}`)
      expect(res.status).toBe(200)
    })
  })

  it('selects the same new matches on POST /bills/bulk-dismiss as the list shows, for each case that keeps a new match', async () => {
    const db = getDb(env.DB)
    for (const { name, qs, body, expected } of CASES) {
      const res = await post('/bulk-dismiss', { filter: body })
      expect(res.status, name).toBe(200)
      expect(((await res.json()) as { dismissed: number }).dismissed, name).toBe(expected.length)
      // Put them back as new matches.
      await db.run(sql`UPDATE bills SET triaged_at = NULL, triaged_by = NULL`)
      expect((await onList(qs)).numbers, name).toEqual(expected)
    }
  })

  describe('the same request on every route', () => {
    it('reads a repeated single-valued key as the first, on the list and on bulk-values', async () => {
      for (const prefix of ['/bills?pageSize=200&', '/bills/bulk-values?']) {
        const res = await get(`${prefix}minRelevance=6&minRelevance=1&q=ballot&q=zoning&unvoted=1&unvoted=0`)
        expect(res.status).toBe(200)
      }
      expect((await onList('minRelevance=6&minRelevance=1&q=ballot&q=zoning&unvoted=1&unvoted=0')).numbers).toEqual(['HB 3'])
      const values = await (await get('/bills/bulk-values?minRelevance=6&minRelevance=1&q=ballot&q=zoning&unvoted=1&unvoted=0')).json() as { count: number }
      expect(values.count).toBe(1)
    })

    it('ignores a key that is not a filter, on every route', async () => {
      const extra = 'bogus=1&view=abc&field.x=1&search=zoning&sessionName=S25&cf=1&stat=Passed'
      expect((await onList(`state=UT&${extra}`)).numbers).toEqual(['HB 5', 'HB 6'])
      const values = await (await get(`/bills/bulk-values?state=UT&${extra}`)).json() as { count: number }
      expect(values.count).toBe(2)
      expect((await get(`/bills/facets?state=UT&${extra}`)).status).toBe(200)
      expect(await onBulk({ state: ['UT'], bogus: ['x'], search: 'zoning', cf_team: ['x'] })).toEqual(['HB 5', 'HB 6'])
    })

    it('reads an empty value of a search, min relevance, and toggle as no filter, on the list and bulk-values', async () => {
      const qs = 'q=&minRelevance=&unvoted=&myBills=&drafts=&newMatches=&match='
      expect((await onList(qs)).numbers).toEqual(ALL)
      expect(((await (await get(`/bills/bulk-values?${qs}`)).json()) as { count: number }).count).toBe(6)
      expect(await onBulk({ q: '', minRelevance: '', unvoted: '', myBills: '', drafts: '', newMatches: '', match: '' })).toEqual(ALL)
    })

    it('answers 400 for more than the subject cap on the list, the facets, and the three bulk routes', async () => {
      const over = Array.from({ length: MAX_SUBJECT_FILTERS + 1 }, (_, i) => `UT:Subject ${i + 1}`)
      const qs = over.map(s => `subject=${encodeURIComponent(s)}`).join('&')
      const error = { error: `Too many subject filters. The maximum is ${MAX_SUBJECT_FILTERS}.` }
      for (const path of [`/bills?${qs}`, `/bills/facets?${qs}`, `/bills/bulk-values?${qs}`]) {
        const res = await get(path)
        expect(res.status, path).toBe(400)
        expect(await res.json(), path).toEqual(error)
      }
      for (const [path, extra] of [['/bulk', { priority: 'high' }], ['/bulk-dismiss', {}]] as const) {
        const res = await post(path, { filter: { subject: over }, ...extra })
        expect(res.status, path).toBe(400)
        expect(await res.json(), path).toEqual(error)
      }
    })
  })

  it('keeps the fixture the cases read: six bills', async () => {
    expect((await onList('')).total).toBe(6)
  })
})
