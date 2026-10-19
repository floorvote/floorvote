import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import type { SQL } from 'drizzle-orm'
import { eq } from 'drizzle-orm'
import { buildSearchCondition, buildBillNumberBoost } from '../../src/routes/billsApi/query'
import { FILTER_ANY } from '../../../shared/billFilter'
import { MAX_SEARCH_TOKENS } from '../../../shared/searchLimits'
import { clearDb, seedUser, seedSession, seedBill, appFetch } from '../helpers'
import { getDb } from '../../src/db/client'
import { app } from '../../src/index'
import { bills, billSubjects, memberVotes, associationConfig, customFieldDefinitions, billCustomFieldValues } from '../../src/db/schema'

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
    await clearDb()
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
    return res.json() as Promise<{ status: Record<string, number>; tag: Record<string, number>; subject: Record<string, number>; unvotedCount: number }>
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
    const res = await listBills({ subject: 'UT:Elections', sessionName: '2025', match: 'any' })
    expect(res.bills.map(b => b.billNumber).sort()).toEqual(['HB0001', 'HB0002'])
  })

  it('keeps search narrowing under match=any', async () => {
    const res = await listBills({ subject: 'UT:Elections', tag: 'Clerk', match: 'any', search: 'election' })
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
  it('reports how many filtered bills the user has not voted on', async () => {
    await recordVote({ billNumber: 'HB0001' })
    const facets = await getFacets({})
    expect(facets.unvotedCount).toBe(1) // HB0002 only; fixture has two bills
  })

  it('scopes unvotedCount to the active filters', async () => {
    const facets = await getFacets({ tag: 'Clerk' }) // HB0002 only, unvoted
    expect(facets.unvotedCount).toBe(1)
  })

  it('keeps active-dimension facet counts consistent with the list under match=any', async () => {
    const q = { subject: 'UT:Elections', tag: 'Clerk', match: 'any' }
    const facets = await getFacets(q)
    const listed = (await listBills(q)).bills.length
    // A facet count under OR is the resulting total: both of these dimensions are
    // already selected, so re-picking their value changes nothing and each must
    // read as the current list size. (Before that change these read 1 — the
    // value's own population. The guard against scoping a facet query down to the
    // OTHER active dimension now lives in the "resulting total" suite below,
    // whose fixture has a Clerk-tagged bill outside the current result and so can
    // still tell the two apart.)
    expect(facets.tag['Clerk']).toBe(listed)
    expect(facets.subject['UT:Elections']).toBe(listed)
  })
})

describe('facet counts under match=any are the resulting total', () => {
  // Under OR, a facet count answers "what will the list show if I pick this?",
  // exactly as AND-mode disjunctive faceting has always answered it.
  //
  // Fixture: HB0001 subject UT:Elections, priority high, no tags.
  //          HB0002 tag Clerk, priority high, no subjects.
  //          HB0003 priority high, no subject, no tag  (outside the OR result).
  //          HB0004 tag Clerk, priority low            (in the OR result via its tag).
  //          HB0005 priority low, no subject, no tag   (outside the OR result).
  //
  // A single-value custom field "Track" is layered on top so the custom-field
  // facet path is exercised with NO cf filter active — the fallback branch,
  // which is the one that runs on the overwhelming majority of requests:
  //          Track=A on HB0001, HB0002, HB0003   (inside the result and out)
  //          Track=B on HB0005                   (outside the result only)
  // 'A' therefore has a real delta, and 'B' is carried solely by a bill outside
  // the current result — the value that must still appear in the dropdown.
  let token: string
  let trackFieldId: string

  beforeEach(async () => {
    await clearDb()
    const userId = await seedUser()
    token = await seedSession(userId)

    const hb1Id = await seedBill({ billNumber: 'HB0001', title: 'Election Reform Act', priority: 'high', tags: [] })
    const hb2Id = await seedBill({ billNumber: 'HB0002', title: 'Clerk Staffing Bill', priority: 'high', tags: ['Clerk'] })
    const hb3Id = await seedBill({ billNumber: 'HB0003', title: 'Unrelated Act', priority: 'high', tags: [] })
    await seedBill({ billNumber: 'HB0004', title: 'Clerk Pay Bill', priority: 'low', tags: ['Clerk'] })
    const hb5Id = await seedBill({ billNumber: 'HB0005', title: 'Quiet Act', priority: 'low', tags: [] })

    const db = getDb(env.DB)
    await db.insert(billSubjects).values({ billId: hb1Id, subjectName: 'Elections', state: 'UT' })
    await db.insert(associationConfig).values({
      key: 'tag_taxonomy',
      value: JSON.stringify([{ name: 'Clerk' }]),
    })

    trackFieldId = 'cf-track'
    await db.insert(customFieldDefinitions).values({
      id: trackFieldId, name: 'Track', slug: 'track', type: 'dropdown',
      options: JSON.stringify(['A', 'B']), multiple: false,
    })
    await db.insert(billCustomFieldValues).values([
      { billId: hb1Id, fieldId: trackFieldId, value: 'A', setBy: userId },
      { billId: hb2Id, fieldId: trackFieldId, value: 'A', setBy: userId },
      { billId: hb3Id, fieldId: trackFieldId, value: 'A', setBy: userId },
      { billId: hb5Id, fieldId: trackFieldId, value: 'B', setBy: userId },
    ])
  })

  async function listBills(query: Record<string, string>) {
    const qs = new URLSearchParams(query).toString()
    const res = await app.request(`/api/bills?${qs}`, { headers: { Cookie: `session=${token}` } }, env)
    return res.json() as Promise<{ bills: Array<{ billNumber: string }> }>
  }

  async function getFacets(query: Record<string, string>) {
    const qs = new URLSearchParams(query).toString()
    const res = await app.request(`/api/bills/facets?${qs}`, { headers: { Cookie: `session=${token}` } }, env)
    return res.json() as Promise<{
      status: Record<string, number>
      priority: Record<string, number>
      position: Record<string, number>
      tag: Record<string, number>
      subject: Record<string, number>
      field: Record<string, Record<string, number>>
    }>
  }

  it('a value already fully shown adds nothing and reads as the current total', async () => {
    const before = (await listBills({ subject: 'UT:Elections', tag: 'Clerk', match: 'any' })).bills.length
    const f = await getFacets({ subject: 'UT:Elections', tag: 'Clerk', match: 'any' })
    // Every listed bill but HB0004 is high priority, and one more high bill (HB0003) is not listed.
    expect(f.priority.high).toBe(before + 1)
  })

  it('clicking a value yields exactly the number the dropdown promised', async () => {
    const q = { subject: 'UT:Elections', tag: 'Clerk', match: 'any' }
    const promised = (await getFacets(q)).priority.high
    const actual = (await listBills({ ...q, priority: 'high' })).bills.length
    expect(actual).toBe(promised)
  })

  it('leaves AND mode alone', async () => {
    const f = await getFacets({ subject: 'UT:Elections' })
    const actual = (await listBills({ subject: 'UT:Elections', priority: 'high' })).bills.length
    expect(f.priority.high).toBe(actual)
  })

  it('applies to tags and subjects too, not just scalar columns', async () => {
    const q = { priority: 'high', match: 'any' }
    const f = await getFacets(q)
    // Also the narrowing guard: HB0004 carries Clerk but is not high priority, so
    // a tag facet scoped down to the other active dimension would miss it.
    const promisedTag = f.tag['Clerk']
    expect((await listBills({ ...q, tag: 'Clerk' })).bills.length).toBe(promisedTag)

    const promisedSubject = f.subject['UT:Elections']
    expect((await listBills({ ...q, subject: 'UT:Elections' })).bills.length).toBe(promisedSubject)
  })

  it('shifts the sentinel values that are computed separately', async () => {
    const q = { subject: 'UT:Elections', tag: 'Clerk', match: 'any' }
    const f = await getFacets(q)
    // "Any tag" and "no position" come from their own subqueries, not the GROUP BY.
    expect((await listBills({ ...q, tag: '__any__' })).bills.length).toBe(f.tag['__any__'])
    expect((await listBills({ ...q, position: 'none' })).bills.length).toBe(f.position['none'])
    expect((await listBills({ ...q, priority: '__any__' })).bills.length).toBe(f.priority['__any__'])
    expect((await listBills({ ...q, priority: 'none' })).bills.length).toBe(f.priority['none'])
  })

  // Custom fields are a selectable dimension like any other, but their facet
  // query ran under finalWhere rather than the scope, which makes the
  // conditional aggregate structurally zero: every surviving row satisfies
  // finalWhere, so every option read back as exactly the current total, and an
  // option carried only by bills outside the result produced no row at all.
  it('a custom-field option under match=any equals the list size after selecting it', async () => {
    const q = { subject: 'UT:Elections', tag: 'Clerk', match: 'any' }
    const promised = (await getFacets(q)).field[trackFieldId]['A']
    const actual = (await listBills({ ...q, [`field.${trackFieldId}`]: 'A' })).bills.length
    expect(actual).toBe(promised)
    // HB0003 carries A and is outside the current result, so this is a real
    // widening — not the degenerate "every option equals the current total".
    const currentTotal = (await listBills(q)).bills.length
    expect(promised).toBe(currentTotal + 1)
  })

  it('a custom-field option carried only by bills outside the result still appears', async () => {
    const q = { subject: 'UT:Elections', tag: 'Clerk', match: 'any' }
    const f = await getFacets(q)
    // Only HB0005 has Track=B, and HB0005 is not in the current list.
    expect(f.field[trackFieldId]).toHaveProperty('B')
    const actual = (await listBills({ ...q, [`field.${trackFieldId}`]: 'B' })).bills.length
    expect(f.field[trackFieldId]['B']).toBe(actual)
  })

  it('leaves AND-mode custom-field counts alone', async () => {
    const f = await getFacets({ subject: 'UT:Elections' })
    // Disjunctive faceting under AND: only HB0001 matches the subject, and it
    // carries A. B has no bills in scope, so it is absent as it always was.
    expect(f.field[trackFieldId]['A'])
      .toBe((await listBills({ subject: 'UT:Elections', [`field.${trackFieldId}`]: 'A' })).bills.length)
    expect(f.field[trackFieldId]['B']).toBeUndefined()
  })

  it('does not shift facet counts when no bill-fact filter is active', async () => {
    // With nothing selected, picking a value narrows rather than widens, so the
    // OR identity does not apply and counts stay absolute.
    const f = await getFacets({ match: 'any' })
    expect(f.priority.high).toBe((await listBills({ match: 'any', priority: 'high' })).bills.length)
  })
})

describe('subject filter cap', () => {
  let token: string

  beforeEach(async () => {
    await clearDb()
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

describe('custom-field facets with another CF field left unfiltered', () => {
  // Bug: when the `else` branch of the CF facet block runs (at least one CF
  // field has an active filter), it only ever queried the fields present in
  // cfSqlMap — i.e. the filtered ones. Any custom field with NO active filter
  // of its own vanished from `customFields` entirely, and an unresolvable
  // `field.` key (naming no real field) made cfFieldIds non-empty while matching
  // nothing, blanking every field's counts.
  //
  // Fixture: two single-value custom fields, Stage and Track.
  //   HB0001: stage=Introduced, track=A
  //   HB0002: stage=Passed,     track=A
  //   HB0003: stage=Introduced, track=B
  let token: string
  let stageFieldId: string
  let trackFieldId: string

  beforeEach(async () => {
    await clearDb()
    const userId = await seedUser()
    token = await seedSession(userId)

    const hb1Id = await seedBill({ billNumber: 'HB0001', title: 'Election Reform Act' })
    const hb2Id = await seedBill({ billNumber: 'HB0002', title: 'Clerk Staffing Bill' })
    const hb3Id = await seedBill({ billNumber: 'HB0003', title: 'Unrelated Act' })

    const db = getDb(env.DB)
    stageFieldId = 'cf-stage'
    trackFieldId = 'cf-track'
    await db.insert(customFieldDefinitions).values([
      { id: stageFieldId, name: 'Stage', slug: 'stage', type: 'dropdown', options: JSON.stringify(['Introduced', 'Passed']), multiple: false },
      { id: trackFieldId, name: 'Track', slug: 'track', type: 'dropdown', options: JSON.stringify(['A', 'B']), multiple: false },
    ])
    await db.insert(billCustomFieldValues).values([
      { billId: hb1Id, fieldId: stageFieldId, value: 'Introduced', setBy: userId },
      { billId: hb2Id, fieldId: stageFieldId, value: 'Passed', setBy: userId },
      { billId: hb3Id, fieldId: stageFieldId, value: 'Introduced', setBy: userId },
      { billId: hb1Id, fieldId: trackFieldId, value: 'A', setBy: userId },
      { billId: hb2Id, fieldId: trackFieldId, value: 'A', setBy: userId },
      { billId: hb3Id, fieldId: trackFieldId, value: 'B', setBy: userId },
    ])
  })

  async function listBills(query: Record<string, string>) {
    const qs = new URLSearchParams(query).toString()
    const res = await app.request(`/api/bills?${qs}`, { headers: { Cookie: `session=${token}` } }, env)
    return res.json() as Promise<{ bills: Array<{ billNumber: string }> }>
  }

  async function getFacets(query: Record<string, string>) {
    const qs = new URLSearchParams(query).toString()
    const res = await app.request(`/api/bills/facets?${qs}`, { headers: { Cookie: `session=${token}` } }, env)
    return res.json() as Promise<{ field: Record<string, Record<string, number>> }>
  }

  it('a different (unfiltered) custom field still appears with correct counts in AND mode', async () => {
    const f = await getFacets({ [`field.${stageFieldId}`]: 'Introduced' })
    expect(f.field[trackFieldId]).toBeDefined()
    // Under the stage=Introduced filter, HB0001 and HB0003 are in scope: track A on
    // HB0001, track B on HB0003.
    expect(f.field[trackFieldId]['A']).toBe(1)
    expect(f.field[trackFieldId]['B']).toBe(1)
  })

  it('the unfiltered field reads as the resulting total under match=any', async () => {
    // Under OR with stage=Passed selected, the current result is just HB0002.
    // Track=A also covers HB0001 (outside the result) — picking Track=A should
    // widen the list to HB0001+HB0002, i.e. currentTotal + 1.
    const q = { [`field.${stageFieldId}`]: 'Passed', match: 'any' }
    const currentTotal = (await listBills(q)).bills.length
    const f = await getFacets(q)
    const promised = f.field[trackFieldId]['A']
    const actual = (await listBills({ ...q, [`field.${trackFieldId}`]: 'A' })).bills.length
    expect(promised).toBe(actual)
    expect(promised).toBe(currentTotal + 1)
  })

  it('the filtered field keeps its own disjunctive counts unchanged', async () => {
    const q = { [`field.${stageFieldId}`]: 'Introduced' }
    const f = await getFacets(q)
    // Regression guard for the merge-order hazard: the extra unfiltered-fields
    // query must not clobber stage's own disjunctive (own-filter-excluded) counts.
    expect(f.field[stageFieldId]['Introduced'])
      .toBe((await listBills({ [`field.${stageFieldId}`]: 'Introduced' })).bills.length)
    expect(f.field[stageFieldId]['Passed'])
      .toBe((await listBills({ [`field.${stageFieldId}`]: 'Passed' })).bills.length)
  })

  it('an unresolvable field. key no longer blanks every field', async () => {
    // Real field id is 'cf-stage' and its slug is 'stage'. 'deleted_field' matches neither, and lands
    // under query.ts's sentinel id, making cfFieldIds non-empty but matching
    // no real bill_custom_field_values row.
    const f = await getFacets({ 'field.deleted_field': 'Introduced' })
    expect(f.field[stageFieldId]).toBeDefined()
    expect(f.field[trackFieldId]).toBeDefined()
    expect(f.field[stageFieldId]['Introduced']).toBe(2)
    expect(f.field[stageFieldId]['Passed']).toBe(1)
    expect(f.field[trackFieldId]['A']).toBe(2)
    expect(f.field[trackFieldId]['B']).toBe(1)
  })

  it('a real CF filter and an unresolvable field. key active together still produce correct disjunctive counts', async () => {
    // Combination the reported bug did not cover: stage=Introduced is a real,
    // active filter (cfFieldIds includes stage's real id) AND `field.deleted_field` (a
    // key naming neither an id nor a slug — resolves to no def, as the list query does) is simultaneously present as a second, bogus
    // `field.` key. This is the shape a saved view naming a since-deleted custom
    // field produces when combined with a still-valid filter. Both stage's own
    // disjunctive counts and track's (the other, unfiltered field) counts must
    // come out exactly as they do with only the real filter active (see 'a
    // different (unfiltered) custom field...' and 'the filtered field keeps
    // its own disjunctive counts unchanged' above) — the bogus key must not
    // zero out either.
    const f = await getFacets({ [`field.${stageFieldId}`]: 'Introduced', 'field.deleted_field': 'Bogus' })
    expect(f.field[stageFieldId]['Introduced']).toBe(2)
    expect(f.field[stageFieldId]['Passed']).toBe(1)
    expect(f.field[trackFieldId]['A']).toBe(1)
    expect(f.field[trackFieldId]['B']).toBe(1)
  })

  it('the __any__ option is populated for the filtered field\'s own disjunctive count', async () => {
    // Own filter excluded, so __any__ counts every bill with a stage value at all.
    const f = await getFacets({ [`field.${stageFieldId}`]: 'Introduced' })
    expect(f.field[stageFieldId][FILTER_ANY]).toBe(3)
  })

  it('the __any__ option is populated for the unfiltered field', async () => {
    // Under stage=Introduced, only HB0001 and HB0003 are in scope, and both
    // carry a track value, so __any__ for the unfiltered track field is 2.
    const f = await getFacets({ [`field.${stageFieldId}`]: 'Introduced' })
    expect(f.field[trackFieldId][FILTER_ANY]).toBe(2)
  })
})

// One name per filter (#699): `search`, `field.<slug>`, and `sessionName` are the keys of the search, a custom
// field, and a session's name, in a URL, a saved view, and every bills route. The old keys (`q`, `cf_<slug>`,
// `session`) have no aliases, so each is ignored like any unknown parameter.
describe('one name per filter', () => {
  // HB0001: "Water Rights Act", 2025-2026 session, tag Energy, subject UT:Elections, team Ada
  // HB0002: "Clerk Staffing Bill", 2027 session, team Bo
  // HB0003: "Unrelated Act", 2025-2026 session
  const TEAM_ID = 'field-team-id'
  const OLDER = '2025-2026 Regular Session'
  const NEWER = '2027 Regular Session'
  let token: string

  beforeEach(async () => {
    await clearDb()
    const userId = await seedUser({ role: 'admin' })
    token = await seedSession(userId)
    const hb1 = await seedBill({ billNumber: 'HB0001', title: 'Water Rights Act', session: OLDER, status: 'Introduced', tags: ['Energy'] })
    const hb2 = await seedBill({ billNumber: 'HB0002', title: 'Clerk Staffing Bill', session: NEWER, status: 'Introduced', tags: [] })
    await seedBill({ billNumber: 'HB0003', title: 'Unrelated Act', session: OLDER, status: 'Introduced', tags: [] })
    const db = getDb(env.DB)
    await db.insert(billSubjects).values({ billId: hb1, subjectName: 'Elections', state: 'UT' })
    await db.insert(associationConfig).values({ key: 'tag_taxonomy', value: JSON.stringify([{ name: 'Energy' }]) })
    await db.insert(customFieldDefinitions).values(
      { id: TEAM_ID, name: 'Team', slug: 'team', type: 'dropdown', options: JSON.stringify(['Ada', 'Bo']), multiple: false },
    )
    await db.insert(billCustomFieldValues).values([
      { billId: hb1, fieldId: TEAM_ID, value: 'Ada', setBy: userId },
      { billId: hb2, fieldId: TEAM_ID, value: 'Bo', setBy: userId },
    ])
  })

  const get = (path: string, qs: string) =>
    app.request(`/api/bills${path}?${qs}`, { headers: { Cookie: `session=${token}` } }, env)
  const listed = async (qs: string) => {
    const res = await get('', qs)
    expect(res.status).toBe(200)
    const body = await res.json() as { bills: Array<{ billNumber: string }> }
    return body.bills.map(b => b.billNumber).sort()
  }
  const facets = async (qs: string) => (await get('/facets', qs)).json() as Promise<Record<string, unknown> & {
    status: Record<string, number>
    tag: Record<string, number>
    subject: Record<string, number>
    sessionName: Record<string, number>
    field: Record<string, Record<string, number>>
  }>
  const facetTotal = async (qs: string) => Object.values((await facets(qs)).status).reduce((a, b) => a + b, 0)
  const bulkValuesCount = async (qs: string) => ((await (await get('/bulk-values', qs)).json()) as { count: number }).count
  const bulkPriority = async (filter: string) => {
    const res = await appFetch('http://localhost/api/bills/bulk', {
      method: 'POST',
      headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter, priority: 'high' }),
    })
    expect(res.status).toBe(200)
    return ((await res.json()) as { updated: number }).updated
  }
  const ALL = ['HB0001', 'HB0002', 'HB0003']
  const sessionQs = (key: string, value: string) => new URLSearchParams([[key, value]]).toString()

  describe('search', () => {
    it('filters the list as q did', async () => {
      expect(await listed('search=water')).toEqual(['HB0001'])
    })
    it('ignores q', async () => {
      expect(await listed('q=water')).toEqual(ALL)
    })
    it('narrows the facets, and q does not', async () => {
      expect(await facetTotal('search=water')).toBe(1)
      expect(await facetTotal('q=water')).toBe(3)
    })
    it('narrows the bulk routes, and q does not', async () => {
      expect(await bulkValuesCount('search=water')).toBe(1)
      expect(await bulkValuesCount('q=water')).toBe(3)
      expect(await bulkPriority('q=water')).toBe(3)
      expect(await bulkPriority('search=water')).toBe(1)
    })
  })

  describe('field.<slug>', () => {
    it('filters the list as cf_<slug> did, by slug and by id', async () => {
      expect(await listed('field.team=Ada')).toEqual(['HB0001'])
      expect(await listed(`field.${TEAM_ID}=Bo`)).toEqual(['HB0002'])
      expect(await listed('field.team=__any__')).toEqual(['HB0001', 'HB0002'])
    })
    it('ignores cf_<slug> and cf_<id>', async () => {
      expect(await listed('cf_team=Ada')).toEqual(ALL)
      expect(await listed(`cf_${TEAM_ID}=Ada`)).toEqual(ALL)
    })
    it('narrows the facets, and cf_ does not', async () => {
      expect(await facetTotal('field.team=Ada')).toBe(1)
      expect(await facetTotal('cf_team=Ada')).toBe(3)
    })
    it('narrows the bulk routes, and cf_ does not', async () => {
      expect(await bulkValuesCount('field.team=Ada')).toBe(1)
      expect(await bulkValuesCount('cf_team=Ada')).toBe(3)
      expect(await bulkPriority('cf_team=Ada')).toBe(3)
      expect(await bulkPriority('field.team=Ada')).toBe(1)
    })
  })

  describe('sessionName', () => {
    it('filters the list as session did', async () => {
      expect(await listed(sessionQs('sessionName', NEWER))).toEqual(['HB0002'])
      expect(await listed(sessionQs('sessionName', OLDER))).toEqual(['HB0001', 'HB0003'])
    })
    it('ignores session', async () => {
      expect(await listed(sessionQs('session', NEWER))).toEqual(ALL)
    })
    it('narrows the facets, and session does not', async () => {
      expect(await facetTotal(sessionQs('sessionName', NEWER))).toBe(1)
      expect(await facetTotal(sessionQs('session', NEWER))).toBe(3)
    })
    it('narrows the bulk routes, and session does not', async () => {
      expect(await bulkValuesCount(sessionQs('sessionName', NEWER))).toBe(1)
      expect(await bulkValuesCount(sessionQs('session', NEWER))).toBe(3)
      expect(await bulkPriority(sessionQs('session', NEWER))).toBe(3)
      expect(await bulkPriority(sessionQs('sessionName', NEWER))).toBe(1)
    })
  })

  describe('the facets response', () => {
    it('keys each filter\'s counts by the filter\'s one name', async () => {
      const f = await facets('')
      expect(f.tag).toEqual(expect.objectContaining({ Energy: 1 }))
      expect(f.subject).toEqual({ 'UT:Elections': 1 })
      expect(f.sessionName).toEqual({ [OLDER]: 2, [NEWER]: 1 })
      expect(f.field[TEAM_ID]).toEqual(expect.objectContaining({ Ada: 1, Bo: 1 }))
    })
    it('has none of the old keys', async () => {
      const f = await facets('')
      for (const old of ['tags', 'subjects', 'session', 'customFields']) expect(f, old).not.toHaveProperty(old)
    })
    it('leaves a filter\'s own pick out of its counts under the new names', async () => {
      const f = await facets(`field.team=Ada&${sessionQs('sessionName', NEWER)}&tag=Energy`)
      // Each facet counts with every filter but its own: the team facet sees the session and tag filters (no bill
      // is in both), and the session facet sees the team and tag filters (HB0001 only).
      expect(f.sessionName).toEqual({ [OLDER]: 1 })
      expect(Object.values(f.field[TEAM_ID] ?? {}).filter(n => n > 0)).toEqual([])
    })
  })
})
