import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { billSubjects, associationConfig } from '../../src/db/schema'
import { app } from '../../src/index'
import { SUPPRESSED_SUBJECT_STATES_KEY } from '../../src/lib/billSubjects'

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
  subjects: Record<string, number>
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

    expect(body.subjects['UT:Election Law']).toBe(2)
    expect(body.subjects['UT:Referenda']).toBe(1)
    expect(body.subjects['NJ:Education']).toBe(1)
  })

  // IMPORTANT 1 regression: subjectMembership binds 2 params per value with no cap,
  // and a shared/bookmarked URL can carry far more than D1's 100-bound-param limit.
  // Without a cap, this 500s instead of returning a page.
  it('does not 500 when the URL carries far more subject filters than D1 can bind', async () => {
    const db = getDb(env.DB)
    await seedBillWithSubjects(db, { id: 's17', state: 'UT' }, ['Election Law'])

    const params = new URLSearchParams()
    for (let i = 0; i < 60; i++) params.append('subject', `UT:Subject ${i}`)
    const res = await app.request(`/api/bills?${params}`, { headers: { Cookie: `session=${token}` } }, env)

    expect(res.status).toBe(200)
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

    expect(body.subjects['NJ:State and Local Government']).toBeUndefined()
    expect(body.subjects['UT:Election Administration']).toBe(1)
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
