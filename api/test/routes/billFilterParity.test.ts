import { describe, it, expect, beforeAll } from 'vitest'
import { env } from 'cloudflare:test'
import { eq, sql } from 'drizzle-orm'
import { appFetch } from '../helpers'
import { getDb } from '../../src/db/client'
import { billCustomFieldValues } from '../../src/db/schema'
import { MAX_SUBJECT_FILTERS } from '../../src/lib/billSubjects'
import { ALL, CASES, seedFilterFixture } from './billFilterFixture'

// One bill filter, five routes: the list (GET /bills), the facets (GET /bills/facets), and the three bulk routes
// (POST /bulk, POST /bulk-dismiss, GET /bulk-values). Each reads the filter as a query string: the two POSTs carry
// it as a string in their JSON body, and all of them select the same bills. Every case (billFilterFixture.ts) is
// a filter with the bills it keeps named, so a route that dropped, renamed, or misread one filter fails on its own.

describe('every route reads one bill filter the same way', () => {
  let token: string
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
  const onBulk = async (filter: string): Promise<string[]> => {
    const db = getDb(env.DB)
    const res = await post('/bulk', { filter, customFields: [{ fieldId: 'f-mark', value: '1' }] })
    expect(res.status).toBe(200)
    const marked = await db.select().from(billCustomFieldValues).where(eq(billCustomFieldValues.fieldId, 'f-mark')).all()
    await db.delete(billCustomFieldValues).where(eq(billCustomFieldValues.fieldId, 'f-mark'))
    expect(marked.length).toBe(((await res.json()) as { updated: number }).updated)
    return numbers(marked.map(m => m.billId))
  }

  beforeAll(async () => {
    const seeded = await seedFilterFixture()
    token = seeded.token
    for (const [id, number] of seeded.numberOf) numberOf.set(id, number)
  })

  describe.each(CASES)('$name', ({ qs, expected }) => {
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

    it('selects the same bills on POST /bills/bulk, which takes the query string in its body', async () => {
      expect(await onBulk(qs)).toEqual(expected)
    })

    it('answers the facets with the filter on', async () => {
      const res = await get(`/bills/facets?${qs}`)
      expect(res.status).toBe(200)
    })
  })

  it('selects the same new matches on POST /bills/bulk-dismiss as the list shows, for each case that keeps a new match', async () => {
    const db = getDb(env.DB)
    for (const { name, qs, expected } of CASES) {
      const res = await post('/bulk-dismiss', { filter: qs })
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
        const res = await get(`${prefix}minRelevance=6&minRelevance=1&search=ballot&search=zoning&unvoted=1&unvoted=0`)
        expect(res.status).toBe(200)
      }
      expect((await onList('minRelevance=6&minRelevance=1&search=ballot&search=zoning&unvoted=1&unvoted=0')).numbers).toEqual(['HB 3'])
      const values = await (await get('/bills/bulk-values?minRelevance=6&minRelevance=1&search=ballot&search=zoning&unvoted=1&unvoted=0')).json() as { count: number }
      expect(values.count).toBe(1)
    })

    it('ignores a key that is not a filter, on every route', async () => {
      const extra = 'bogus=1&view=abc&field.x=1&search=zoning&sessionName=S25&cf=1&stat=Passed'
      expect((await onList(`state=UT&${extra}`)).numbers).toEqual(['HB 5', 'HB 6'])
      const values = await (await get(`/bills/bulk-values?state=UT&${extra}`)).json() as { count: number }
      expect(values.count).toBe(2)
      expect((await get(`/bills/facets?state=UT&${extra}`)).status).toBe(200)
      expect(await onBulk(`state=UT&${extra}`)).toEqual(['HB 5', 'HB 6'])
    })

    it('reads an empty value of a search, min relevance, and toggle as no filter, on every route', async () => {
      const qs = 'search=&minRelevance=&unvoted=&myBills=&drafts=&newMatches=&match='
      expect((await onList(qs)).numbers).toEqual(ALL)
      expect(((await (await get(`/bills/bulk-values?${qs}`)).json()) as { count: number }).count).toBe(6)
      expect(await onBulk(qs)).toEqual(ALL)
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
        const res = await post(path, { filter: qs, ...extra })
        expect(res.status, path).toBe(400)
        expect(await res.json(), path).toEqual(error)
      }
    })
  })

  describe('the bulk routes take the filter as a query string and nothing else', () => {
    it.each([
      ['an object of lists, as the bulk body used to spell it', { status: ['Passed'] }],
      ['an empty object', {}],
      ['an array', ['status=Passed']],
      ['a number', 1],
      ['a boolean', true],
    ])('answers 400 to %s on POST /bulk, and writes nothing', async (_name, filter) => {
      const db = getDb(env.DB)
      const res = await post('/bulk', { filter, customFields: [{ fieldId: 'f-mark', value: '1' }] })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toMatch(/query string/)
      expect(await db.select().from(billCustomFieldValues).where(eq(billCustomFieldValues.fieldId, 'f-mark')).all()).toEqual([])
    })

    it.each([
      ['an object of lists', { newMatches: '1' }],
      ['an empty object', {}],
    ])('answers 400 to %s on POST /bulk-dismiss, and dismisses nothing', async (_name, filter) => {
      const res = await post('/bulk-dismiss', { filter })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toMatch(/query string/)
      expect((await onList('newMatches=1')).total).toBe(6)
    })

    it('reads an empty string as the filter that keeps every bill', async () => {
      expect(await onBulk('')).toEqual(ALL)
    })

    it('still takes ids or a filter, not both and not neither', async () => {
      expect((await post('/bulk', { ids: ['x'], filter: 'status=Passed', priority: 'high' })).status).toBe(400)
      expect((await post('/bulk', { priority: 'high' })).status).toBe(400)
    })
  })

  it('keeps the fixture the cases read: six bills', async () => {
    expect((await onList('')).total).toBe(6)
  })
})
