import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import {
  associationConfig, billCustomFieldValues, billSubjects, bills, customFieldDefinitions, memberVotes, notes, officialPositions,
} from '../../src/db/schema'

// The bills the bill filter tests read, and the filters they apply. Each case is a filter as a query string, with
// the bills it keeps named, so a route that dropped, renamed, or misread one filter fails on its own.

//  HB 1  NJ  Passed      enacted     S26  2026  high    rel 9  Energy        Support  Labor, [x y]  NJ:Elections  voted
//  HB 2  NJ  Introduced  introduced  S26  2026  low     rel 3  Labor         Oppose   Energy        NJ:Energy     noted
//  HB 3  TX  Failed      failed      S25  2025  -       rel 6  -             -        -             TX:Elections
//  HB 4  TX  Passed      enacted     S25  2025  medium  rel 1  Energy, Labor Support  [y]           -             draft
//  HB 5  UT  Introduced  introduced  S26  2026  -       rel 8  -             -        Labor         UT:Elections  voted, noted
//  HB 6  UT  Failed      failed      S26  2026  high    rel 4  -             Oppose   -             -
// The viewer (an admin) has voted on HB 1 and HB 5 and noted HB 2 and HB 5. Every bill is an untriaged keyword match.

export type Case = { name: string; qs: string; expected: string[] }
export const ALL = ['HB 1', 'HB 2', 'HB 3', 'HB 4', 'HB 5', 'HB 6']
export const FIELD_ID = 'f-committee'
export const FIELD_SLUG = 'committee'
export const AREAS_ID = 'f-areas'
export const AREAS_SLUG = 'areas'

export const CASES: Case[] = [
  { name: 'no filter', qs: '', expected: ALL },
  { name: 'status', qs: 'status=Passed', expected: ['HB 1', 'HB 4'] },
  { name: 'two statuses', qs: 'status=Passed&status=Failed', expected: ['HB 1', 'HB 3', 'HB 4', 'HB 6'] },
  { name: 'stage', qs: 'stage=enacted', expected: ['HB 1', 'HB 4'] },
  { name: 'year', qs: 'year=2025', expected: ['HB 3', 'HB 4'] },
  { name: 'session', qs: 'session=S26', expected: ['HB 1', 'HB 2', 'HB 5', 'HB 6'] },
  { name: 'state', qs: 'state=UT', expected: ['HB 5', 'HB 6'] },
  { name: 'two states', qs: 'state=NJ&state=TX', expected: ['HB 1', 'HB 2', 'HB 3', 'HB 4'] },
  { name: 'position', qs: 'position=Support', expected: ['HB 1', 'HB 4'] },
  { name: 'position none', qs: 'position=none', expected: ['HB 3', 'HB 5'] },
  { name: 'position any', qs: 'position=__any__', expected: ['HB 1', 'HB 2', 'HB 4', 'HB 6'] },
  { name: 'priority', qs: 'priority=high', expected: ['HB 1', 'HB 6'] },
  { name: 'priority none', qs: 'priority=none', expected: ['HB 3', 'HB 5'] },
  { name: 'priority any', qs: 'priority=__any__', expected: ['HB 1', 'HB 2', 'HB 4', 'HB 6'] },
  { name: 'tag', qs: 'tag=Energy', expected: ['HB 1', 'HB 4'] },
  { name: 'any tag', qs: 'tag=__any__', expected: ['HB 1', 'HB 2', 'HB 4'] },
  { name: 'subjects', qs: 'subject=NJ:Elections&subject=UT:Elections', expected: ['HB 1', 'HB 5'] },
  { name: 'min relevance', qs: 'minRelevance=6', expected: ['HB 1', 'HB 3', 'HB 5'] },
  { name: 'min relevance of zero', qs: 'minRelevance=0', expected: ALL },
  { name: 'search', qs: 'q=ballot', expected: ['HB 3', 'HB 5'] },
  { name: 'search with two terms', qs: 'q=energy+draft', expected: ['HB 4'] },
  { name: 'search with alternatives', qs: 'q=zoning,voter', expected: ['HB 1', 'HB 6'] },
  { name: 'my bills', qs: 'myBills=1', expected: ['HB 1', 'HB 2', 'HB 5'] },
  { name: 'my bills as true', qs: 'myBills=true', expected: ['HB 1', 'HB 2', 'HB 5'] },
  { name: 'unvoted', qs: 'unvoted=1', expected: ['HB 2', 'HB 3', 'HB 4', 'HB 6'] },
  { name: 'unvoted as true', qs: 'unvoted=true', expected: ['HB 2', 'HB 3', 'HB 4', 'HB 6'] },
  { name: 'new matches', qs: 'newMatches=1', expected: ALL },
  { name: 'drafts', qs: 'drafts=1', expected: ['HB 4'] },
  { name: 'drafts as true', qs: 'drafts=true', expected: ['HB 4'] },
  { name: 'a custom field by slug', qs: `cf_${FIELD_SLUG}=Labor`, expected: ['HB 1', 'HB 5'] },
  { name: 'a custom field by id', qs: `cf_${FIELD_ID}=Labor`, expected: ['HB 1', 'HB 5'] },
  { name: 'a custom field by id and by slug together', qs: `cf_${FIELD_ID}=Labor&cf_${FIELD_SLUG}=Energy`, expected: ['HB 1', 'HB 2', 'HB 5'] },
  { name: 'a custom field with any value', qs: `cf_${FIELD_SLUG}=__any__`, expected: ['HB 1', 'HB 2', 'HB 5'] },
  { name: 'a multi-select custom field', qs: `cf_${AREAS_SLUG}=y`, expected: ['HB 1', 'HB 4'] },
  { name: 'a custom field that names no field', qs: 'cf_no-such-field=x', expected: [] },
  { name: 'two filters', qs: 'state=NJ&priority=high', expected: ['HB 1'] },
  { name: 'two filters under match=any', qs: 'state=UT&priority=low&match=any', expected: ['HB 2', 'HB 5', 'HB 6'] },
  { name: 'match=any with a scope', qs: 'state=UT&priority=low&match=any&unvoted=1', expected: ['HB 2', 'HB 6'] },
  {
    name: 'every filter at once',
    qs: 'status=Passed&stage=enacted&priority=high&position=Support&session=S26&year=2026&state=NJ&tag=Energy&subject=NJ:Elections&q=voter&minRelevance=5'
      + `&myBills=1&unvoted=0&newMatches=1&drafts=0&cf_${FIELD_SLUG}=Labor&cf_${AREAS_ID}=x`,
    expected: ['HB 1'],
  },
]


/** Seeds the six bills above, as an admin who has voted on HB 1 and HB 5 and noted HB 2 and HB 5. */
export async function seedFilterFixture(): Promise<{ token: string; ada: string; numberOf: Map<string, string> }> {
  const numberOf = new Map<string, string>()
  await resetDb()
  await applyMigrations()
  const ada = await seedUser({ role: 'admin', email: 'ada@example.com' })
  const token = await seedSession(ada)
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
  return { token, ada, numberOf }
}
