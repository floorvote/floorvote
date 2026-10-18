import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { resetDb, applyMigrations, appFetch, stubFetch, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills, billSubjects } from '../../src/db/schema'
import { MAX_SUBJECT_FILTERS } from '../../src/lib/billSubjects'

// The bulk routes read the same `subject` filter as GET /bills, which answers
// 400 past the cap. They used to keep the first 40 and drop the rest, which under
// AND widens the set a bulk write reaches. Every fixture below is built so that
// dropping the 41st subject changes what is selected: the bill holds the first
// 40 subjects and lacks the 41st.

const MATCH = '2026-06-20 00:00:00'
const CAP_ERROR = { error: `Too many subject filters. The maximum is ${MAX_SUBJECT_FILTERS}.` }
const subjectNames = (n: number) => Array.from({ length: n }, (_, i) => `Subject ${i + 1}`)
const filterValues = (n: number) => subjectNames(n).map(name => `UT:${name}`)
// A bulk request carries its filter as a query string: one `subject` key for each value.
const subjectQuery = (values: string[]) => values.map(v => `subject=${encodeURIComponent(v)}`).join('&')

describe('bulk routes reject over-cap subject filters', () => {
  let adminToken: string
  let memberToken: string
  let holder: string

  async function giveSubjects(billId: string, names: string[]) {
    const db = getDb(env.DB)
    for (let i = 0; i < names.length; i += 20) {
      await db.insert(billSubjects).values(names.slice(i, i + 20).map(subjectName => ({ billId, subjectName, state: 'UT' })))
    }
  }

  const post = (path: string, token: string, body: object) =>
    appFetch(`http://localhost/api/bills${path}`, {
      method: 'POST',
      headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  const getValues = (token: string, subjects: string[], extra = '') => {
    const qs = new URLSearchParams()
    for (const s of subjects) qs.append('subject', s)
    return appFetch(`http://localhost/api/bills/bulk-values?${qs}${extra}`, { headers: { Cookie: `session=${token}` } })
  }
  const triagedAt = async () => (await getDb(env.DB).select().from(bills).where(eq(bills.id, holder)).get())!.triagedAt
  const priority = async () => (await getDb(env.DB).select().from(bills).where(eq(bills.id, holder)).get())!.priority

  beforeEach(async () => {
    stubFetch()
    await resetDb()
    await applyMigrations()
    adminToken = await seedSession(await seedUser({ role: 'admin', email: 'admin@example.com' }))
    memberToken = await seedSession(await seedUser({ role: 'member', email: 'member@example.com' }))
    // Holds Subject 1 to Subject 40, not Subject 41. A new match, so a dismiss would stamp it.
    holder = await seedBill({ billNumber: 'HB 1', matchType: 'keyword', newMatchAt: MATCH, relevanceScore: 80 })
    await giveSubjects(holder, subjectNames(MAX_SUBJECT_FILTERS))
  })

  describe('POST /bulk', () => {
    it('accepts exactly 40 subjects and edits the bill that holds all of them', async () => {
      const res = await post('/bulk', adminToken, { filter: subjectQuery(filterValues(40)), priority: 'high' })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ updated: 1 })
      expect(await priority()).toBe('high')
    })

    it('rejects 41 subjects with the list route 400 and writes nothing', async () => {
      const res = await post('/bulk', adminToken, { filter: subjectQuery(filterValues(41)), priority: 'high' })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual(CAP_ERROR)
      expect(await priority()).toBeNull()
    })

    it('rejects 41 subjects under match=any as well', async () => {
      const res = await post('/bulk', adminToken, { filter: `${subjectQuery(filterValues(41))}&match=any`, priority: 'high' })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual(CAP_ERROR)
      expect(await priority()).toBeNull()
    })

    it('rejects 41 subjects with a custom-field edit too, before any write', async () => {
      const res = await post('/bulk', adminToken, { filter: subjectQuery(filterValues(41)), position: 'support' })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual(CAP_ERROR)
    })

    it('ignores malformed values, which do not count toward the cap (39 valid and 2 malformed is accepted)', async () => {
      const values = [...filterValues(39), 'NoColon', 'AlsoNoColon']
      expect(values).toHaveLength(41)
      const res = await post('/bulk', adminToken, { filter: subjectQuery(values), priority: 'high' })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ updated: 1 })
    })

    it('accepts 40 valid values with malformed ones beside them', async () => {
      const res = await post('/bulk', adminToken, { filter: subjectQuery([...filterValues(40), 'NoColon', 'NoColon2', 'NoColon3']), priority: 'high' })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ updated: 1 })
    })

    it('answers the same status and body as GET /bills for the same 41 subjects', async () => {
      const qs = new URLSearchParams()
      for (const s of filterValues(41)) qs.append('subject', s)
      const list = await appFetch(`http://localhost/api/bills?${qs}`, { headers: { Cookie: `session=${adminToken}` } })
      const bulk = await post('/bulk', adminToken, { filter: subjectQuery(filterValues(41)), priority: 'high' })
      expect(bulk.status).toBe(list.status)
      expect(await bulk.json()).toEqual(await list.json())
    })

    it('returns 403 to a member, even with 41 subjects', async () => {
      const res = await post('/bulk', memberToken, { filter: subjectQuery(filterValues(41)), priority: 'high' })
      expect(res.status).toBe(403)
      expect(await priority()).toBeNull()
    })
  })

  describe('POST /bulk-dismiss', () => {
    it('accepts exactly 40 subjects and dismisses the bill that holds all of them', async () => {
      const res = await post('/bulk-dismiss', adminToken, { filter: subjectQuery(filterValues(40)) })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ dismissed: 1 })
      expect(await triagedAt()).not.toBeNull()
    })

    it('rejects 41 subjects with the list route 400 and stamps nothing as triaged', async () => {
      const res = await post('/bulk-dismiss', adminToken, { filter: subjectQuery(filterValues(41)) })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual(CAP_ERROR)
      expect(await triagedAt()).toBeNull()
    })

    it('rejects 41 subjects under match=any as well', async () => {
      const res = await post('/bulk-dismiss', adminToken, { filter: `${subjectQuery(filterValues(41))}&match=any` })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual(CAP_ERROR)
      expect(await triagedAt()).toBeNull()
    })

    it('ignores malformed values, which do not count toward the cap (39 valid and 2 malformed is accepted)', async () => {
      const res = await post('/bulk-dismiss', adminToken, { filter: subjectQuery([...filterValues(39), 'NoColon', 'AlsoNoColon']) })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ dismissed: 1 })
    })

    it('returns 403 to a member, even with 41 subjects', async () => {
      const res = await post('/bulk-dismiss', memberToken, { filter: subjectQuery(filterValues(41)) })
      expect(res.status).toBe(403)
      expect(await triagedAt()).toBeNull()
    })
  })

  describe('GET /bulk-values', () => {
    it('accepts exactly 40 subjects and counts the bill that holds all of them', async () => {
      const res = await getValues(adminToken, filterValues(40))
      expect(res.status).toBe(200)
      expect((await res.json() as { count: number }).count).toBe(1)
    })

    it('rejects 41 subjects with the list route 400', async () => {
      const res = await getValues(adminToken, filterValues(41))
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual(CAP_ERROR)
    })

    it('rejects 41 subjects under match=any as well', async () => {
      const res = await getValues(adminToken, filterValues(41), '&match=any')
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual(CAP_ERROR)
    })

    it('ignores malformed values, which do not count toward the cap (39 valid and 2 malformed is accepted)', async () => {
      const res = await getValues(adminToken, [...filterValues(39), 'NoColon', 'AlsoNoColon'])
      expect(res.status).toBe(200)
      expect((await res.json() as { count: number }).count).toBe(1)
    })

    it('does not apply the cap to a request that names bills by id', async () => {
      const qs = new URLSearchParams({ ids: holder })
      const res = await appFetch(`http://localhost/api/bills/bulk-values?${qs}`, { headers: { Cookie: `session=${adminToken}` } })
      expect(res.status).toBe(200)
    })

    it('returns 403 to a member, even with 41 subjects', async () => {
      const res = await getValues(memberToken, filterValues(41))
      expect(res.status).toBe(403)
    })
  })
})
